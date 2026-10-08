import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateLedger, validateLedger, reserveCandidates, commitRun, abortRun, pendingLedgerRows, withLedgerLock } from '../../job-pull/ledger.mjs';

function tempLedger() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'job-pull-ledger-'));
  return path.join(directory, 'notion-written.tsv');
}

function candidate(url = 'https://example.test/1', overrides = {}) {
  return { canonicalUrl: url, jobId: 'job-1', company: 'Example', title: 'AI Engineer', location: 'Pune', provider: 'greenhouse', ...overrides };
}

test('legacy six-column ledger migration is dry-run and idempotent', () => {
  const ledgerPath = tempLedger();
  const legacy = 'dedup_key\tjob_id\tcompany\trole\tnotion_page_url\tdate_pulled\nexample|ai engineer|pune\t1\tExample\tAI Engineer\thttps://notion.test/1\t2026-07-14\n';
  writeFileSync(ledgerPath, legacy);
  const dry = migrateLedger({ path: ledgerPath, dryRun: true });
  assert.equal(dry.changed, true);
  assert.equal(readFileSync(ledgerPath, 'utf8'), legacy);
  const applied = migrateLedger({ path: ledgerPath });
  assert.equal(applied.written, true);
  assert.equal(validateLedger(ledgerPath).legacy, false);
  assert.equal(migrateLedger({ path: ledgerPath, dryRun: true }).changed, false);
});

test('ledger pending, commit, abort, lock, and recovery states are durable', () => {
  const ledgerPath = tempLedger();
  const reservation = reserveCandidates([candidate()], { path: ledgerPath, runId: 'run-1', now: '2026-07-14T09:00:00.000Z' });
  assert.equal(reservation.reservations[0].state, 'pending');
  assert.equal(pendingLedgerRows(ledgerPath).length, 1);
  commitRun({ path: ledgerPath, runId: 'run-1', now: '2026-07-14T09:01:00.000Z', pageUrls: { [reservation.reservations[0].dedup_key]: 'https://notion.test/page' } });
  assert.equal(pendingLedgerRows(ledgerPath).length, 0);

  const second = reserveCandidates([candidate('https://example.test/2', { company: 'Other', jobId: 'job-2' })], { path: ledgerPath, runId: 'run-2', now: '2026-07-14T09:02:00.000Z' });
  assert.equal(second.reservations.length, 1);
  abortRun({ path: ledgerPath, runId: 'run-2', now: '2026-07-14T09:03:00.000Z', error: 'simulated failure' });
  const validation = validateLedger(ledgerPath);
  assert.equal(validation.valid, true);
  assert.equal(validation.pendingCount, 0);
  assert.equal(readFileSync(ledgerPath, 'utf8').includes('aborted'), true);

  const lockPath = `${ledgerPath}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, 'other\n');
  assert.throws(() => withLedgerLock(ledgerPath, () => {}), /ledger is locked/);
  // The test-owned lock is removed here; production code never clears another process's lock.
  unlinkSync(lockPath);
  assert.equal(existsSync(lockPath), false);
});

test('reservation ledger matches candidate aliases against stored portal and legacy Workday identities', () => {
  const ledgerPath = tempLedger();
  reserveCandidates([candidate('https://portal.example.test/9', { provider: 'naukri', jobId: 'portal-9' })], { path: ledgerPath });
  assert.throws(() => reserveCandidates([candidate('https://ats.example.test/123', { jobId: '123', identityAliases: ['naukri|portal 9'] })], { path: ledgerPath }), /existing ledger candidate/);
  const oldPath = tempLedger();
  reserveCandidates([candidate('https://ats.example.test/legacy', { provider: 'workday', jobId: 'Engineer_R-12345' })], { path: oldPath });
  assert.throws(() => reserveCandidates([candidate('https://ats.example.test/new', { provider: 'workday', jobId: 'R-12345' })], { path: oldPath }), /existing ledger candidate/);
});

test('old reservation headers still suppress normalized Workday requisitions', () => {
  const ledgerPath = tempLedger();
  writeFileSync(ledgerPath, 'dedup_key\tjob_id\tcompany\trole\tnotion_page_url\tdate_pulled\tstate\trun_id\tcreated_at\tupdated_at\terror\tcanonical_url\tprovider\nworkday|engineer jr284401\tEngineer_JR284401\tExample\tAI Engineer\thttps://notion.test/1\t2026-07-14\tcommitted\told\t\t\t\thttps://old.example.test/1\tworkday\n');
  assert.equal(validateLedger(ledgerPath).valid, true);
  assert.throws(() => reserveCandidates([candidate('https://new.example.test/1', { provider: 'workday', jobId: 'JR284401' })], { path: ledgerPath }), /existing ledger candidate/);
});

test('reservation writes the exact pre-alias ledger header', () => {
  const ledgerPath = tempLedger();
  reserveCandidates([candidate('https://ats.example.test/123', { identityAliases: ['naukri|portal 9'] })], { path: ledgerPath });
  const content = readFileSync(ledgerPath, 'utf8');
  assert.equal(content.split('\n')[0], 'dedup_key\tjob_id\tcompany\trole\tnotion_page_url\tdate_pulled\tstate\trun_id\tcreated_at\tupdated_at\terror\tcanonical_url\tprovider');
  assert.equal(content.includes('identity_aliases'), false);
  assert.equal(content.includes('naukri|portal 9'), false);
});

test('reservation ID fallback permits different companies', () => {
  const ledgerPath = tempLedger();
  reserveCandidates([candidate('https://ats.example.test/acme', { company: 'Acme', jobId: '123' })], { path: ledgerPath });
  const result = reserveCandidates([candidate('https://ats.example.test/globex', { company: 'Globex', jobId: '123' })], { path: ledgerPath });
  assert.equal(result.reservations.length, 1);
});
