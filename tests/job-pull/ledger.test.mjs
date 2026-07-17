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
  commitRun({ path: ledgerPath, runId: 'run-1', now: '2026-07-14T09:01:00.000Z', pageUrls: { 'example|ai engineer|pune': 'https://notion.test/page' } });
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
