import { withManualFixtureScores } from '../fixtures/manual-scores.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runNormalMode as runNormalModeActual } from '../../job-pull/normal-mode.mjs';
import { NORMAL_SOURCE_LANES } from '../../job-pull/normal-sources.mjs';

test('ready, unresolved, undated, and stale fixtures keep separate operator queues without invented evidence', async () => {
  const now = '2026-10-02T12:00:00Z';
  const base = { company: 'Fixture', title: 'AI Engineer', location: 'Pune', description: 'Build Python services. Freshers welcome.',
    postedAt: now, employment: { type: 'full-time', paid: true }, experience: { minYears: 0, maxYears: 1 },
    liveness: { status: 'Active', checkedAt: now, evidence: 'fixture' }, scoreOrigin: 'explicit-scored-input', responseLikelihood: 15, matchScore: 85 };
  const rows = [
    { ...base, company: 'Ready fixture', url: 'https://jobs.lever.co/fixture/ready', sourceKind: 'ats-direct' },
    { ...base, company: 'Undated fixture', url: 'https://jobs.lever.co/fixture/undated', sourceKind: 'ats-direct', postedAt: null, salary: null },
    { ...base, company: 'Unresolved fixture', url: 'https://www.linkedin.com/jobs/view/fixture-unresolved', sourceKind: 'aggregator', liveness: { status: 'Not Verified' }, experience: null },
    { ...base, company: 'Stale fixture', url: 'https://jobs.lever.co/fixture/stale', sourceKind: 'ats-direct', postedAt: '2026-08-24T00:00:00Z' },
  ];
  const result = await runNormalMode({ runId: 'visibility-fixture', clock: () => now, enrichmentBudget: 0,
    ledgerRows: [], opportunityLedgerRows: [], commitSurfaced: false,
    sourceFunctions: Object.fromEntries(NORMAL_SOURCE_LANES.map((lane) => [lane.id, () => ({ records: lane.id === 'tracked-ats' ? rows : [] })])),
  });
  assert.deepEqual(result.shortlist.map((x) => x.company), ['Ready fixture']);
  assert.deepEqual(result.verificationQueue.map((x) => x.company).sort(), ['Undated fixture', 'Unresolved fixture']);
  const unresolved = result.verificationQueue.find((x) => x.company === 'Unresolved fixture');
  assert.equal(unresolved.evidence.experience.minYears, null);
  assert.equal(unresolved.liveness.status, 'Not Verified');
  assert.equal(result.counts.selected, 1);
  assert.equal(result.counts.verificationQueue, 2);
});

// Preserve visibility assertions with independent explicit fixture scores.
function runNormalMode(options) { return runNormalModeActual(withManualFixtureScores(options)); }
