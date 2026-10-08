import { scoredFixture } from '../fixtures/manual-scores.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../job-pull/config.mjs';
import { normalizeCandidate, candidateDedupKey } from '../../job-pull/candidate.mjs';
import { runPipeline } from '../../job-pull/run.mjs';
import {
  markAction,
  readOpportunityLedger,
  recordSurfaced,
  repairMissingSurfaced,
  suppressionFor,
} from '../../job-pull/opportunity-ledger.mjs';
import { collectHistory, surfacedCandidates } from '../../job-pull/seed-opportunity-history.mjs';

const NOW = '2026-07-18T12:00:00.000Z';

function tempLedger() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'job-pull-opportunity-'));
  return path.join(directory, 'opportunity-ledger.tsv');
}

function candidate(url = 'https://example.test/1', overrides = {}) {
  return scoredFixture({
    description: 'Build Python AI services.',
    url, source: 'greenhouse-full', sourceKind: 'ats-direct', provider: 'greenhouse', id: 'job-1',
    company: 'Example', title: 'AI Engineer', location: 'Pune', postedAt: NOW,
    employment: { type: 'full-time' }, experience: { minYears: 0, maxYears: 1 }, scoreOrigin: 'explicit-scored-input', responseLikelihood: 15, matchScore: 80,
    liveness: { status: 'Active', evidence: 'fixture' }, ...overrides,
  });
}

test('missing ledger is treated as empty', () => {
  const ledgerPath = tempLedger();
  const result = readOpportunityLedger(ledgerPath);
  assert.equal(result.missing, true);
  assert.deepEqual(result.rows, []);
});

test('recordSurfaced round-trips a new row with the canonical dedup key', () => {
  const ledgerPath = tempLedger();
  const item = candidate();
  recordSurfaced([item], { path: ledgerPath, now: NOW });
  const row = readOpportunityLedger(ledgerPath).rows[0];
  assert.equal(row.dedup_key, candidateDedupKey(item));
  assert.equal(row.company, 'Example');
  assert.equal(row.role, 'AI Engineer');
  assert.equal(row.canonical_url, item.canonicalUrl);
  assert.equal(row.first_surfaced_at, NOW);
  assert.equal(row.last_surfaced_at, NOW);
  assert.equal(row.times_surfaced, '1');
  assert.equal(row.action_state, 'none');
  assert.equal(row.action_at, null);
});

test('recordSurfaced upserts by dedup key and bumps the last time only', () => {
  const ledgerPath = tempLedger();
  const item = candidate();
  recordSurfaced([item], { path: ledgerPath, now: NOW });
  recordSurfaced([candidate('https://example.test/refresh')], { path: ledgerPath, now: '2026-07-19T12:00:00.000Z' });
  const rows = readOpportunityLedger(ledgerPath).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].first_surfaced_at, NOW);
  assert.equal(rows[0].last_surfaced_at, '2026-07-19T12:00:00.000Z');
  assert.equal(rows[0].times_surfaced, '2');
});

test('recordSurfaced keeps distinct provider requisitions separate despite shared URL and desk', () => {
  const ledgerPath = tempLedger();
  recordSurfaced([
    candidate('https://example.test/shared', { provider: 'workday', id: null, jobId: 'REQ-1' }),
    candidate('https://example.test/shared', { provider: 'workday', id: null, jobId: 'REQ-2' }),
  ], { path: ledgerPath, now: NOW });
  const rows = readOpportunityLedger(ledgerPath).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.dedup_key), ['workday|req 1', 'workday|req 2']);
});

test('repairMissingSurfaced inserts only absent replay keys at original commit time', () => {
  const ledgerPath = tempLedger();
  const existing = candidate('https://example.test/existing');
  const missing = candidate('https://example.test/missing', { id: 'job-2' });
  recordSurfaced([existing], { path: ledgerPath, now: NOW });

  const commitTime = '2026-07-17T08:00:00.000Z';
  const repaired = repairMissingSurfaced([existing, missing], {
    path: ledgerPath,
    committedAtForKey: (key) => key === candidateDedupKey(missing) ? commitTime : null,
  });

  assert.deepEqual(repaired.rows.map((row) => row.dedup_key), [candidateDedupKey(missing)]);
  const rows = readOpportunityLedger(ledgerPath).rows;
  const existingRow = rows.find((row) => row.dedup_key === candidateDedupKey(existing));
  const repairedRow = rows.find((row) => row.dedup_key === candidateDedupKey(missing));
  assert.equal(existingRow.last_surfaced_at, NOW);
  assert.equal(existingRow.times_surfaced, '1');
  assert.equal(repairedRow.first_surfaced_at, commitTime);
  assert.equal(repairedRow.last_surfaced_at, commitTime);
  assert.equal(repairedRow.times_surfaced, '1');
});

test('repairMissingSurfaced fails closed when original replay commit time is missing', () => {
  const ledgerPath = tempLedger();
  const missing = candidate('https://example.test/missing-time');
  assert.throws(() => repairMissingSurfaced([missing], {
    path: ledgerPath,
    committedAtForKey: () => null,
  }), /missing original commit time/);
  assert.deepEqual(readOpportunityLedger(ledgerPath).rows, []);
});

test('historical run collection extracts only surfaced selections and deduplicates them', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'job-pull-history-'));
  const item = candidate();
  writeFileSync(path.join(directory, 'run.json'), JSON.stringify({
    shortlist: [item, item],
    verificationQueue: [candidate('https://example.test/verify', { company: 'Verify' })],
  }));
  assert.equal(surfacedCandidates({ shortlist: [item, item] }).length, 1);
  const result = collectHistory([directory]);
  assert.equal(result.parsedFiles, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].canonicalUrl, item.canonicalUrl);
});

test('actioned and rejected rows are suppressed forever', () => {
  assert.deepEqual(suppressionFor({ action_state: 'applied' }, NOW), { suppressed: true, code: 'SUPPRESSED_ACTIONED' });
  assert.deepEqual(suppressionFor({ action_state: 'contacted' }, NOW), { suppressed: true, code: 'SUPPRESSED_ACTIONED' });
  assert.deepEqual(suppressionFor({ action_state: 'interviewing' }, NOW), { suppressed: true, code: 'SUPPRESSED_ACTIONED' });
  assert.deepEqual(suppressionFor({ action_state: 'rejected' }, NOW), { suppressed: true, code: 'SUPPRESSED_REJECTED' });
});

test('none rows within seven days are on cooldown', () => {
  assert.deepEqual(suppressionFor({ action_state: 'none', last_surfaced_at: '2026-07-12T12:00:00.000Z' }, NOW), {
    suppressed: true, code: 'SUPPRESSED_COOLDOWN_7D',
  });
});

test('none rows older than seven days may resurface', () => {
  assert.deepEqual(suppressionFor({ action_state: 'none', last_surfaced_at: '2026-07-10T12:00:00.000Z' }, NOW), {
    suppressed: false, code: '',
  });
});

test('backfill candidates with any prior row are suppressed as already seen', () => {
  const item = candidate('https://example.test/backfill', { postedAt: '2026-07-08T12:00:00.000Z' });
  const result = runPipeline({
    config: loadConfig(), now: NOW, runId: 'backfill-run', opportunityLedgerRows: [{
      dedup_key: candidateDedupKey(item), action_state: 'none', last_surfaced_at: '2026-07-01T12:00:00.000Z',
    }], sources: [{ candidates: [item], manifest: { sourceId: 'reverse-ats', errors: [] } }],
  });
  assert.equal(result.counts.selected, 0);
  assert.equal(result.counts.suppressed, 1);
  assert.equal(result.counts.suppressedByCode.SUPPRESSED_BACKFILL_ALREADY_SEEN, 1);
  assert.equal(result.exclusionAudit.selection.length, 0);
});

test('non-dry pipeline records the final selected candidates', () => {
  const ledgerPath = tempLedger();
  const item = candidate('https://example.test/selected');
  runPipeline({
    config: loadConfig(), now: NOW, runId: 'surface-run', opportunityLedgerPath: ledgerPath, dryRun: false,
    sources: [{ candidates: [item], manifest: { sourceId: 'reverse-ats', errors: [] } }],
  });
  assert.equal(readOpportunityLedger(ledgerPath).rows[0].dedup_key, candidateDedupKey(item));
});

test('markAction updates a row by key and preserves the row identity', () => {
  const ledgerPath = tempLedger();
  const item = candidate();
  recordSurfaced([item], { path: ledgerPath, now: NOW });
  const result = markAction({ path: ledgerPath, key: candidateDedupKey(item), state: 'applied', now: '2026-07-18T13:00:00.000Z' });
  assert.equal(result.row.action_state, 'applied');
  assert.equal(readOpportunityLedger(ledgerPath).rows[0].action_at, '2026-07-18T13:00:00.000Z');
});

test('markAction updates a row by canonical URL', () => {
  const ledgerPath = tempLedger();
  const item = candidate();
  recordSurfaced([item], { path: ledgerPath, now: NOW });
  markAction({ path: ledgerPath, url: item.canonicalUrl, state: 'contacted', now: NOW });
  assert.equal(readOpportunityLedger(ledgerPath).rows[0].action_state, 'contacted');
});

test('markAction rejects invalid states and missing rows', () => {
  const ledgerPath = tempLedger();
  assert.throws(() => markAction({ path: ledgerPath, key: 'missing', state: 'bogus', now: NOW }), /invalid action state/);
  assert.throws(() => markAction({ path: ledgerPath, key: 'missing', state: 'applied', now: NOW }), /no matching opportunity/);
});


test('raw observation without recordSurfaced does not start cooldown', () => {
  const ledgerPath = tempLedger();
  // Simulates crawler/job-pull observing a role without shortlist inclusion.
  const observed = candidate('https://example.test/observed-only');
  assert.equal(readOpportunityLedger(ledgerPath).rows.length, 0);
  assert.deepEqual(suppressionFor(null, NOW), { suppressed: false, code: '' });
  assert.deepEqual(
    suppressionFor({ action_state: 'none', last_surfaced_at: null }, NOW),
    { suppressed: false, code: '' },
  );
  // No ledger write occurs until recordSurfaced (shortlist/selection path).
  assert.equal(readOpportunityLedger(ledgerPath).missing, true);
  void observed;
});

test('recordSurfaced starts the seven-day cooldown only after shortlist inclusion', () => {
  const ledgerPath = tempLedger();
  const item = candidate('https://example.test/shortlisted');
  recordSurfaced([item], { path: ledgerPath, now: NOW });
  const row = readOpportunityLedger(ledgerPath).rows[0];
  assert.equal(row.last_surfaced_at, NOW);
  assert.deepEqual(suppressionFor(row, NOW), { suppressed: true, code: 'SUPPRESSED_COOLDOWN_7D' });
  assert.deepEqual(suppressionFor(row, '2026-07-25T12:00:00.000Z'), { suppressed: true, code: 'SUPPRESSED_COOLDOWN_7D' });
  assert.deepEqual(suppressionFor(row, '2026-07-25T12:00:01.000Z'), { suppressed: false, code: '' });
});

test('legacy Workday rows and portal aliases retain suppression and surface counts', () => {
  for (const overrides of [
    { provider: 'workday', jobId: 'JR284401' },
    { provider: 'greenhouse', jobId: '123', identityAliases: ['naukri|portal 9'] },
  ]) {
    const ledgerPath = tempLedger();
    const item = candidate('https://ats.example.test/new', { ...overrides, evidence: { freshness: { kind: 'workday-startDate' } } });
    const old = candidate('https://portal.example.test/old', overrides.provider === 'workday'
      ? { provider: 'workday', jobId: 'Engineer_JR284401' }
      : { provider: 'naukri', jobId: 'portal-9' });
    recordSurfaced([old], { path: ledgerPath, now: NOW });
    markAction({ key: candidateDedupKey(old), state: 'applied', path: ledgerPath, now: NOW });
    const pipeline = runPipeline({ config: loadConfig(), now: NOW, runId: 'alias-check', opportunityLedgerPath: ledgerPath, sources: [{ candidates: [item], manifest: { sourceId: item.source } }] });
    assert.equal(pipeline.suppression.byCode.SUPPRESSED_ACTIONED, 1);
    recordSurfaced([item], { path: ledgerPath, now: NOW });
    const rows = readOpportunityLedger(ledgerPath).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].times_surfaced, '2');
    const replay = repairMissingSurfaced([item], { path: ledgerPath, committedAtForKey: () => { throw new Error('must not create another row'); } });
    assert.equal(replay.rows.length, 0);
  }
});

test('candidate aliases match old ledger first-surfaced dates and reject undated jobs', () => {
  const ledgerPath = tempLedger();
  recordSurfaced([candidate('https://portal.example.test/9', { provider: 'naukri', jobId: 'portal-9' })], { path: ledgerPath, now: '2026-06-01T12:00:00.000Z' });
  const item = candidate('https://ats.example.test/123', { provider: 'greenhouse', jobId: '123', identityAliases: ['naukri|portal 9'], postedAt: null });
  const result = runPipeline({ config: loadConfig(), now: NOW, runId: 'first-seen-check', opportunityLedgerPath: ledgerPath, sources: [{ candidates: [item], manifest: { sourceId: item.source } }] });
  assert.equal(result.exclusionAudit.gate[0].code, 'FRESHNESS_OLDER_THAN_14D');
  assert.equal(result.exclusionAudit.gate[0].evidence, '2026-06-01T12:00:00.000Z');
  assert.equal(result.verifyQueue.length, 0);
  assert.equal(item.postedAt, null);
});

test('old opportunity headers remain readable and normalized keys can receive explicit actions', () => {
  const ledgerPath = tempLedger();
  writeFileSync(ledgerPath, 'dedup_key\tcompany\trole\tcanonical_url\tprovider\tfirst_surfaced_at\tlast_surfaced_at\ttimes_surfaced\taction_state\taction_at\nworkday|engineer r 12345\tExample\tAI Engineer\thttps://old.example.test/1\tworkday\t2026-07-01T12:00:00.000Z\t2026-07-01T12:00:00.000Z\t1\tnone\t\n');
  const item = candidate('https://new.example.test/1', { provider: 'workday', jobId: 'R-12345', identityAliases: ['naukri|portal 9'] });
  recordSurfaced([item], { path: ledgerPath, now: NOW });
  markAction({ key: 'workday|r 12345', state: 'applied', path: ledgerPath, now: NOW });
  const rows = readOpportunityLedger(ledgerPath).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dedup_key, 'workday|engineer r 12345');
  assert.equal(rows[0].first_surfaced_at, '2026-07-01T12:00:00.000Z');
  assert.equal(rows[0].action_state, 'applied');
});

test('surfacing writes the exact pre-alias opportunity header', () => {
  const ledgerPath = tempLedger();
  const item = candidate('https://ats.example.test/123', { identityAliases: ['naukri|portal 9'] });
  recordSurfaced([item], { path: ledgerPath, now: NOW });
  recordSurfaced([item], { path: ledgerPath, now: NOW });
  const content = readFileSync(ledgerPath, 'utf8');
  assert.equal(content.split('\n')[0], 'dedup_key\tcompany\trole\tcanonical_url\tprovider\tfirst_surfaced_at\tlast_surfaced_at\ttimes_surfaced\taction_state\taction_at');
  assert.equal(content.includes('identity_aliases'), false);
  assert.equal(content.includes('naukri|portal 9'), false);
});

test('fresh undated roles do not inherit old dates from another company ID or alias', () => {
  for (const dedupKey of ['greenhouse|123', 'naukri|portal 9']) {
    const item = candidate('https://ats.example.test/fresh', {
      company: 'Acme', provider: 'greenhouse', jobId: '123', postedAt: null,
      firstSeenAt: NOW, identityAliases: ['naukri|portal 9'],
    });
    const result = runPipeline({
      config: loadConfig(), now: NOW, runId: 'company-first-seen-check',
      opportunityLedgerRows: [{
        dedup_key: dedupKey, company: 'Globex', first_surfaced_at: '2026-06-01T12:00:00.000Z',
        last_surfaced_at: '2026-06-01T12:00:00.000Z', action_state: 'none',
      }],
      sources: [{ candidates: [item], manifest: { sourceId: item.source } }],
    });
    assert.equal(result.exclusionAudit.gate.some((entry) => entry.code === 'FRESHNESS_OLDER_THAN_14D'), false);
    assert.equal(result.verifyQueue.length, 1);
    assert.equal(result.verifyQueue[0].company, 'Acme');
    assert.equal(result.counts.suppressed, 0);
  }
});
