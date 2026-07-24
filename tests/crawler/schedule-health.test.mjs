import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCrawlerStore, startCrawlRun, finishCrawlRun } from '../../crawler/run.mjs';
import { dailyRunIdentity } from '../../crawler/scheduler.mjs';
import { buildScheduleHealthReport } from '../../crawler/schedule-health.mjs';

function tempDbPath(prefix) {
  return path.join(mkdtempSync(path.join(os.tmpdir(), prefix)), 'crawler.sqlite');
}

test('reports no run history without requiring a database file to exist', () => {
  const databasePath = tempDbPath('launchpad-schedule-health-missing-');
  const report = buildScheduleHealthReport({ databasePath, now: new Date('2026-07-24T05:00:00.000Z') });

  assert.equal(report.schemaVersion, 'LaunchpadScheduleHealthReportV1');
  assert.equal(report.hasDatabase, false);
  assert.equal(report.schedules.morning.hasRunHistory, false);
  assert.equal(report.schedules.morning.lastRun, null);
  assert.equal(report.schedules.morning.classification.status, 'fresh');
  assert.equal(report.schedules.midday.hasRunHistory, false);
  assert.equal(report.noAutoApply, true);
  assert.equal(report.noAutoSend, true);
});

test('reads durable counts, duration, source failures, and classification for a completed morning run', () => {
  const databasePath = tempDbPath('launchpad-schedule-health-completed-');
  const store = openCrawlerStore(databasePath);
  const now = '2026-07-24T05:00:00.000Z';
  const runId = dailyRunIdentity({ schedule: 'morning', at: now });

  startCrawlRun(store, { runId, schedule: 'morning', clock: { now: () => '2026-07-24T00:30:00.000Z' } });
  store.prepare(`INSERT INTO sources(source_id, lane, trust_class, capabilities_json, rate_policy_json, updated_at)
    VALUES ('ats-warm', 'ats-warm', 'direct', '{}', '{}', ?)`).run('2026-07-24T00:30:00.000Z');
  store.prepare(`INSERT INTO source_failures(run_id, source_id, stage, attempt, retry_class, host, status_code, message, created_at)
    VALUES (?, 'ats-warm', 'fetch', 1, 'terminal', 'example.test', 500, 'boom', ?)`).run(runId, '2026-07-24T00:31:00.000Z');
  finishCrawlRun(store, runId, {
    status: 'completed',
    counts: { ready: 5, verification: 3, rejected: 7, fetched: 40 },
    telemetry: { workflow: { verificationQueue: [1, 2, 3], sourceYield: { totals: { applicationReady: 5 } } } },
    clock: { now: () => '2026-07-24T01:35:00.000Z' },
  });
  store.close();

  const report = buildScheduleHealthReport({ databasePath, now: new Date(now) });
  const morning = report.schedules.morning;

  assert.equal(report.hasDatabase, true);
  assert.equal(morning.hasRunHistory, true);
  assert.equal(morning.lastRun.runId, runId);
  assert.equal(morning.lastRun.status, 'completed');
  assert.equal(morning.lastSuccessfulRun.runId, runId);
  assert.equal(morning.durationMs, Date.parse('2026-07-24T01:35:00.000Z') - Date.parse('2026-07-24T00:30:00.000Z'));
  assert.equal(morning.sourceFailures, 1);
  assert.deepEqual(morning.counts, { ready: 5, verification: 3, rejected: 7 });
  assert.equal(morning.classification.status, 'fresh');
  assert.equal(morning.classification.reason, 'current daily run is complete or ready');

  // midday has no rows yet: an empty table is truthfully reported, not fabricated.
  assert.equal(report.schedules.midday.hasRunHistory, false);
});

test('classifies an incomplete same-identity run as resumed and leaves lastSuccessfulRun null', () => {
  const databasePath = tempDbPath('launchpad-schedule-health-resumed-');
  const store = openCrawlerStore(databasePath);
  const now = '2026-07-24T05:00:00.000Z';
  const runId = dailyRunIdentity({ schedule: 'midday', at: now });

  startCrawlRun(store, { runId, schedule: 'midday', clock: { now: () => '2026-07-24T07:00:00.000Z' } });
  store.close();

  const report = buildScheduleHealthReport({ databasePath, now: new Date(now) });
  const midday = report.schedules.midday;

  assert.equal(midday.lastRun.runId, runId);
  assert.equal(midday.lastRun.status, 'running');
  assert.equal(midday.classification.status, 'resumed');
  assert.equal(midday.lastSuccessfulRun, null);
});

test('falls back to sourceYield totals for ready count when durable counts omit it', () => {
  const databasePath = tempDbPath('launchpad-schedule-health-fallback-');
  const store = openCrawlerStore(databasePath);
  const now = '2026-07-24T05:00:00.000Z';
  const runId = dailyRunIdentity({ schedule: 'morning', at: now });

  startCrawlRun(store, { runId, schedule: 'morning', clock: { now: () => '2026-07-24T00:30:00.000Z' } });
  finishCrawlRun(store, runId, {
    status: 'completed',
    counts: { fetched: 10 },
    telemetry: { workflow: { verificationQueue: [1], sourceYield: { totals: { applicationReady: 2 } } } },
    clock: { now: () => '2026-07-24T00:45:00.000Z' },
  });
  store.close();

  const report = buildScheduleHealthReport({ databasePath, now: new Date(now) });
  assert.equal(report.schedules.morning.counts.ready, 2);
  assert.equal(report.schedules.morning.counts.verification, 1);
  assert.equal(report.schedules.morning.counts.rejected, 0);
});
