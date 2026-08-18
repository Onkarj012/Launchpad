import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../job-pull/config.mjs';
import { normalizeCandidate, candidateDedupKey } from '../../job-pull/candidate.mjs';
import { runPipeline } from '../../job-pull/run.mjs';
import {
  markAction,
  readOpportunityLedger,
  recordSurfaced,
  suppressionFor,
} from '../../job-pull/opportunity-ledger.mjs';
import { collectHistory, surfacedCandidates } from '../../job-pull/seed-opportunity-history.mjs';

const NOW = '2026-07-18T12:00:00.000Z';

function tempLedger() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'job-pull-opportunity-'));
  return path.join(directory, 'opportunity-ledger.tsv');
}

function candidate(url = 'https://example.test/1', overrides = {}) {
  return normalizeCandidate({
    url, source: 'greenhouse-full', sourceKind: 'ats-direct', provider: 'greenhouse', id: 'job-1',
    company: 'Example', title: 'AI Engineer', location: 'Pune', postedAt: NOW,
    employment: { type: 'full-time' }, experience: { minYears: 0, maxYears: 1 }, matchScore: 80,
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
