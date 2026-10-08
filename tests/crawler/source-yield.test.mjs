import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceYieldReport, buildAvenueTrialReport } from '../../crawler/source-yield.mjs';
import { runCrawlerOperator } from '../../crawler/operator.mjs';
import { main } from '../../crawler/cli.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('reports the requested per-board quality funnel without auto-pausing', () => {
  const record = {
    provider: 'ashby',
    company: 'Example India',
    evidence: { board: 'example' },
    _crawlerReserveEntry: {
      candidate: { provider: 'ashby', company: 'Example India', evidence: { board: 'example' }, applicationReady: true },
      eligibility: { geo: { pass: true }, title: { pass: true }, experience: { pass: true } },
      freshness: { eligible: true, ageHours: 24 },
    },
  };
  const report = buildSourceYieldReport([record], {
    'ats-warm': {
      detail: { sources: [{ provider: 'ashby', board: 'example', company: 'Example India', fetched: 101, foreignDiscardedAtSource: 44 }] },
    },
  });

  assert.deepEqual(report.totals, {
    fetched: 101,
    indiaBased: 1,
    targetTitle: 1,
    freshWithinSevenDays: 1,
    experienceCompatible: 1,
    applicationReady: 1,
    foreignDiscardedAtSource: 44,
  });
  assert.equal(report.sources[0].applicationReadyYield, 1 / 101);
  assert.equal(report.sources[0].pauseRecommendation.eligible, false);
});

test('manual-review experience does not count as compatible or ready', () => {
  const report = buildSourceYieldReport([{
    provider: 'ashby',
    company: 'Example',
    evidence: { board: 'example' },
    _crawlerReserveEntry: {
      candidate: { provider: 'ashby', company: 'Example', evidence: { board: 'example' }, applicationReady: false },
      eligibility: { geo: { pass: true }, title: { pass: true }, experience: { pass: true, manualReview: true } },
      freshness: { eligible: true, ageHours: 200 },
    },
  }]);
  assert.equal(report.sources[0].experienceCompatible, 0);
  assert.equal(report.sources[0].applicationReady, 0);
  assert.equal(report.sources[0].freshWithinSevenDays, 0);
});

test('one-week HN and YC yield uses distinct IST days and leaves missing or failed evidence incomplete', () => {
  const runs = Array.from({ length: 7 }, (_, index) => ({
    runId: `morning-${index}`, runAt: `2026-10-${String(index + 7).padStart(2, '0')}T18:30:00.000Z`,
    sourceTelemetry: {
      'hn-discovery': { status: 'ok', detail: { naturalTerminal: true, telemetry: { requests: 12, fetched: 10, extracted: 2, unresolved: 2 } } },
      'yc-discovery': { status: 'ok', detail: { naturalTerminal: true, telemetry: { requests: 1, resultCount: 4, extracted: 3, unresolved: 1 } } },
    },
    sourceYield: { sources: [
      { provider: 'hn-discovery', applicationReady: 0 },
      { provider: 'yc-discovery', applicationReady: 1 },
    ] },
  }));
  const report = buildAvenueTrialReport([...runs, runs[0], { ...runs[0], runId: 'before', runAt: '2026-10-07T18:29:59.000Z' }], { trialStartDate: '2026-10-08' });
  assert.equal(report.sources[0].sourceId, 'hn-discovery');
  assert.equal(report.sources[0].daysObserved, 7);
  assert.equal(report.sources[0].fetched, 70);
  assert.equal(report.sources[0].requests, 84);
  assert.equal(report.sources[0].applicationReady, 0);
  assert.equal(report.sources[0].decision, 'drop');
  assert.equal(report.sources[1].applicationReadyPerRequest, 1);
  assert.equal(report.sources[1].decision, 'keep');
  const partial = buildAvenueTrialReport(runs.map((run) => ({ ...run, sourceTelemetry: {
    ...run.sourceTelemetry, 'yc-discovery': { status: 'failed', detail: { telemetry: { requests: 1 } } },
  } })), { trialStartDate: '2026-10-08' });
  assert.equal(partial.sources[1].daysObserved, 0);
  assert.equal(partial.sources[1].decision, 'insufficient-evidence');
  assert.equal(buildAvenueTrialReport(Array(7).fill(runs[0]), { trialStartDate: '2026-10-08' }).sources[0].decision, 'insufficient-evidence');
  assert.throws(() => buildAvenueTrialReport([], { trialStartDate: '2026-02-30' }), /valid trialStartDate/);
});

test('trial yield credits the discovery source after YC resolves to an ATS provider', () => {
  const report = buildSourceYieldReport([{
    sourceId: 'yc-discovery',
    _crawlerReserveEntry: { candidate: { provider: 'ashby', company: 'Orbit', applicationReady: true } },
  }]);
  assert.equal(report.sources[0].provider, 'yc-discovery');
  assert.equal(report.sources[0].applicationReady, 1);
});

test('local trial report command reads retained public crawler output without live requests or writes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hn-yc-yield-'));
  const run = await runCrawlerOperator({
    config: { schemaVersion: 'LaunchpadCrawlerConfigV1', databasePath: path.join(root, 'crawler.sqlite'), sources: {
      hn: { enabled: true, trialStartDate: '2026-10-08' },
      yc: { enabled: true, trialStartDate: '2026-10-08' },
      searxng: { enabled: true, endpoint: 'https://search.test', queries: [] },
    } },
    runId: 'trial-day-one', schedule: 'morning',
    clock: { now: () => '2026-10-08T08:00:00.000Z', sleep: async () => {} },
    transport: async (url) => {
      if (url.includes('search_by_date')) return { status: 200, body: { hits: [] } };
      return { status: 200, body: { results: [] } };
    },
  });
  const file = path.join(root, 'reports.json');
  writeFileSync(file, JSON.stringify([run]));
  const outputs = [];
  assert.equal(await main(['trial-yield', '--trial-start', '2026-10-08', '--runs', file], { emit: (result) => outputs.push(result) }), 0);
  assert.deepEqual(outputs[0].sources.map(({ sourceId, daysObserved, requests, decision }) => ({ sourceId, daysObserved, requests, decision })), [
    { sourceId: 'hn-discovery', daysObserved: 1, requests: 1, decision: 'insufficient-evidence' },
    { sourceId: 'yc-discovery', daysObserved: 1, requests: 1, decision: 'insufficient-evidence' },
  ]);
});
