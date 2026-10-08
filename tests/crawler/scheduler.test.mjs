import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScheduleHealth,
  classifyScheduleRun,
  dailyRunIdentity,
  mergeSourceYieldDetails,
} from '../../crawler/scheduler.mjs';

const morning = '2026-07-24T00:30:00.000Z';

test('daily identities are deterministic and use the IST calendar date', () => {
  assert.equal(dailyRunIdentity({ schedule: 'morning', at: morning }), 'daily-morning-normal-india-2026-07-24');
  assert.equal(dailyRunIdentity({ schedule: 'morning', at: morning }), dailyRunIdentity({ schedule: 'morning', at: morning }));
  assert.notEqual(dailyRunIdentity({ schedule: 'midday', at: morning }), dailyRunIdentity({ schedule: 'morning', at: morning }));
});

test('classifies fresh, resumed, skipped, and explicitly caught-up runs', () => {
  const current = dailyRunIdentity({ schedule: 'morning', at: morning });
  assert.equal(classifyScheduleRun({ schedule: 'morning', now: morning }).status, 'fresh');
  assert.equal(classifyScheduleRun({ schedule: 'morning', now: morning, lastRun: { runId: current, status: 'running' } }).status, 'resumed');
  assert.equal(classifyScheduleRun({ schedule: 'morning', now: morning, lastRun: { runId: current, status: 'skipped' } }).status, 'skipped');
  assert.equal(classifyScheduleRun({ schedule: 'morning', now: morning, lastRun: { runId: 'morning-2026-07-23', status: 'failed' }, state: { recoverMissed: true } }).status, 'caught-up');
});

test('merges source counters and retains earlier resumed segments', () => {
  const merged = mergeSourceYieldDetails(
    { sources: [{ sourceId: 'searxng', fetched: 4, discarded: 2, segments: [{ runId: 'r1', fetched: 4 }] }] },
    { sources: [{ sourceId: 'searxng', fetched: 3, resolved: 1, segments: [{ runId: 'r2', fetched: 3 }] }, { sourceId: 'ats', fetched: 5 }] },
  );

  const search = merged.sources.find((source) => source.sourceId === 'searxng');
  assert.equal(search.fetched, 7);
  assert.equal(search.discarded, 2);
  assert.equal(search.resolved, 1);
  assert.deepEqual(search.segments.map((segment) => segment.runId), ['r1', 'r2']);
  assert.equal(merged.totals.fetched, 12);
});

test('builds health with operational counts and safety boundaries', () => {
  const health = buildScheduleHealth({
    lastRun: { runId: 'midday-2026-07-24', schedule: 'midday', status: 'completed' },
    durationMs: 1250,
    sourceFailures: [{ sourceId: 'workday' }],
    counts: { applicationReady: 3, verificationQueue: 4, rejected: 8 },
    state: { now: morning },
  });

  assert.equal(health.status, 'fresh');
  assert.deepEqual(health.counts, { ready: 3, verification: 4, rejected: 8 });
  assert.equal(health.sourceFailures, 1);
  assert.equal(health.noAutoApply, true);
  assert.equal(health.noAutoSend, true);
  assert.equal(health.noResumeGeneration, true);
});
