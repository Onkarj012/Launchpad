import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceYieldReport, buildAvenueTrialReport, buildSourceEndStates, buildUsefulSourceYield } from '../../crawler/source-yield.mjs';
import { runCrawlerOperator } from '../../crawler/operator.mjs';
import { main } from '../../crawler/cli.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('nonzero fetched counts never turn source failures or incomplete scans into healthy outcomes', () => {
  const states = buildSourceEndStates({
    failed: { status: 'failed', fetched: 3, error: 'HTTP 503' },
    nestedFailed: { status: 'succeeded', fetched: 3, detail: { status: 'failed', errors: ['board failed'] } },
    interrupted: { status: 'interrupted', fetched: 3 },
    truncated: { status: 'succeeded', fetched: 3, detail: { telemetry: { truncated: true } } },
    partial: { status: 'succeeded', fetched: 3, detail: { naturalTerminal: false } },
    degraded: { status: 'degraded', fetched: 3 },
    boardFailed: { status: 'succeeded', fetched: 3, detail: { sources: [{ status: 'failed', fetched: 1 }] } },
    portal: { status: 'succeeded', fetched: 3, detail: { telemetry: { lanes: [{ sourceId: 'portal-failed', status: 'failed', fetched: 3, reasonCode: 'PORTAL_FAILED' }] } } },
    healthy: { status: 'succeeded', fetched: 3, detail: { status: 'ok', naturalTerminal: true } },
    empty: { status: 'succeeded', fetched: 0 },
  });
  assert.deepEqual(states.failed, { state: 'failed', reason: 'HTTP 503' });
  assert.deepEqual(states.nestedFailed, { state: 'failed', reason: 'board failed' });
  assert.equal(states.interrupted.state, 'interrupted');
  assert.equal(states.truncated.state, 'truncated');
  assert.equal(states.partial.state, 'truncated');
  assert.equal(states.degraded.state, 'degraded');
  assert.equal(states.boardFailed.state, 'failed');
  assert.equal(states.portal.state, 'failed');
  assert.deepEqual(states['portal-failed'], { state: 'failed', reason: 'PORTAL_FAILED' });
  assert.deepEqual(states.healthy, { state: 'ok' });
  assert.deepEqual(states.empty, { state: 'empty', reason: 'no-records-returned' });
});

test('succeeded, failed, truncated, interrupted, and not-started sources stay distinct in end states', () => {
  const states = buildSourceEndStates({
    succeeded: { status: 'succeeded', fetched: 2 },
    failed: { status: 'failed', fetched: 0, error: 'HTTP 503' },
    truncated: { status: 'truncated', fetched: 1 },
    interrupted: { status: 'interrupted', fetched: 0 },
    'ats-warm': { status: 'not_started', fetched: 0 },
    x: { status: 'pending', fetched: 0 },
    notStarted: { status: 'notStarted', fetched: 0 },
    unattempted: { status: 'unattempted', fetched: 0 },
    omitted: { status: 'omitted_by_runtime', fetched: 0, detail: { reason: 'runtime-allowance-unavailable' } },
    'lane-parent': { status: 'pending', fetched: 0, detail: { telemetry: { lanes: [
      { sourceId: 'lane-failed', status: 'failed', fetched: 0, error: 'HTTP 429' },
      { sourceId: 'lane-pending', status: 'pending', fetched: 0 },
    ] } } },
  });
  assert.deepEqual(states.succeeded, { state: 'ok' });
  assert.deepEqual(states.failed, { state: 'failed', reason: 'HTTP 503' });
  assert.deepEqual(states.truncated, { state: 'truncated', reason: 'source-truncated' });
  assert.deepEqual(states.interrupted, { state: 'interrupted', reason: 'source-interrupted' });
  assert.deepEqual(states['ats-warm'], { state: 'not_started', reason: 'source-not-started' });
  assert.equal(states.x.state, 'not_started');
  assert.equal(states.notStarted.state, 'not_started');
  assert.equal(states.unattempted.state, 'not_started');
  assert.deepEqual(states.omitted, { state: 'not_started', reason: 'runtime-allowance-unavailable' });
  assert.equal(states['lane-failed'].state, 'failed');
  assert.equal(states['lane-pending'].state, 'not_started');
  assert.equal(states['lane-parent'].state, 'failed', 'a failed child outranks a pending sibling in the parent state');
});

test('every planned source gets a terminal state even when it has no telemetry', () => {
  const states = buildSourceEndStates({}, { atsWarm: { enabled: true }, careerSites: [{ url: 'https://careers.example.test' }] });
  assert.equal(states['ats-warm'].state, 'not_started');
  assert.equal(states['ats-warm'].reason, 'source-not-planned');
  assert.equal(states['career-sites'].state, 'not_started');
});

test('seven-day trial evidence excludes nested failure and truncation despite successful outer status', () => {
  for (const detail of [
    { status: 'failed' },
    { telemetry: { truncated: true } },
    { interrupted: true },
  ]) {
    const runs = Array.from({ length: 7 }, (_, index) => ({
      runId: `run-${index}`, runAt: `2026-10-${String(index + 8).padStart(2, '0')}T06:00:00.000Z`,
      sourceTelemetry: { 'hn-discovery': { status: 'ok', fetched: 2, detail: {
        naturalTerminal: true, ...detail, telemetry: { requests: 2, fetched: 2, ...detail.telemetry },
      } } }, sourceYield: { sources: [{ provider: 'hn-discovery', applicationReady: 1 }] },
    }));
    const report = buildAvenueTrialReport(runs, { trialStartDate: '2026-10-08' });
    assert.equal(report.sources[0].daysObserved, 0);
    assert.equal(report.sources[0].decision, 'insufficient-evidence');
  }
});

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

// Build a retained identity row with the fields the daily receipt keeps per requisition.
function identityRow(identityHash, overrides = {}) {
  return {
    identityHash, stage: 'eligible', reason: 'Not Verified', selected: false, historicalSuppressed: false,
    jdHash: 'sha256:jd', score: 80, scoreComponents: { skillMatch: 30 }, provenance: [], ...overrides,
  };
}

test('per-source and per-query rows count JD, eligibility, scoring, suppression and selection', () => {
  const report = buildUsefulSourceYield({
    identityRows: [
      identityRow('sha256:selected', { stage: 'finalSelection', selected: true, provenance: [{ sourceId: 'theirstack', queryId: 'q-ai' }] }),
      identityRow('sha256:hard', { stage: 'hardRejection', jdHash: null, score: null, scoreComponents: null, provenance: [{ sourceId: 'theirstack', queryId: 'q-ai' }] }),
      identityRow('sha256:suppressed', { stage: 'historySuppression', historicalSuppressed: true, provenance: [{ sourceId: 'theirstack', queryId: 'q-ai' }] }),
      identityRow('sha256:scored-out', { stage: 'scoringFailure', score: null, scoreComponents: null, provenance: [{ sourceId: 'ats-warm' }] }),
      identityRow('sha256:held', { stage: 'verification', provenance: [{ sourceId: 'ats-warm' }] }),
    ],
    sourceTelemetry: {},
    sourceEndStates: { theirstack: { state: 'ok' }, 'ats-warm': { state: 'truncated', reason: 'source-truncated' } },
  });
  const theirstack = report.sources.find(({ sourceId, queryId }) => sourceId === 'theirstack' && queryId === 'q-ai');
  assert.equal(theirstack.kind, 'discovery');
  assert.equal(theirstack.uniqueRequisitions, 3);
  assert.deepEqual(theirstack.stages, { jdPresent: 2, hardEligibilityPassed: 2, validScore: 1, scoringFailed: 0, historySuppressed: 1, verification: 0, selected: 1 });
  assert.equal(theirstack.endState, 'ok');
  const warm = report.sources.find(({ sourceId }) => sourceId === 'ats-warm');
  assert.equal(warm.queryId, 'Not Verified');
  assert.deepEqual(warm.stages, { jdPresent: 2, hardEligibilityPassed: 2, validScore: 0, scoringFailed: 1, historySuppressed: 0, verification: 1, selected: 0 });
  assert.equal(warm.endState, 'truncated');
  assert.equal(warm.endReason, 'source-truncated');
  assert.equal(report.schemaVersion, 'LaunchpadUsefulSourceYieldV1');
  assert.equal(report.scope, 'final-selection');
  assert.equal(buildSourceYieldReport([]).schemaVersion, 'LaunchpadSourceYieldV1', 'the discovery-only report keeps its label');
});

test('a requisition found by discovery and by recovery appears in both groups but counts once', () => {
  const report = buildUsefulSourceYield({
    identityRows: [
      identityRow('sha256:shared', { stage: 'finalSelection', selected: true, provenance: [
        { sourceId: 'theirstack', queryId: 'q-ai' },
        { sourceId: 'portal-discovery', recovery: true },
      ] }),
      identityRow('sha256:recovery-only', { provenance: [{ sourceId: 'held-lead-recovery' }] }),
    ],
    sourceTelemetry: {},
    sourceEndStates: {},
  });
  assert.equal(report.identityCount, 2);
  const discovery = report.sources.find(({ sourceId }) => sourceId === 'theirstack');
  const recovery = report.sources.find(({ sourceId }) => sourceId === 'portal-discovery');
  assert.equal(discovery.kind, 'discovery');
  assert.equal(recovery.kind, 'recovery');
  assert.equal(discovery.uniqueRequisitions, 1);
  assert.equal(recovery.uniqueRequisitions, 1);
  assert.equal(report.sources.find(({ sourceId }) => sourceId === 'held-lead-recovery').kind, 'recovery');
});

test('request, duration, truncation and failure cost accompany each row, and shared-query cost stays Not Verified', () => {
  const sourceTelemetry = {
    theirstack: { requests: 4, durationMs: 1200, truncated: true, failures: ['HTTP 429'] },
    'ats-warm': { detail: { telemetry: { requests: 2 } }, durationMs: 300 },
  };
  const shared = buildUsefulSourceYield({
    identityRows: [
      identityRow('sha256:a', { provenance: [{ sourceId: 'theirstack', queryId: 'q-ai' }] }),
      identityRow('sha256:b', { provenance: [{ sourceId: 'theirstack', queryId: 'q-ml' }] }),
      identityRow('sha256:c', { provenance: [{ sourceId: 'ats-warm' }] }),
    ],
    sourceTelemetry,
    sourceEndStates: {},
  });
  assert.deepEqual(shared.sources.find(({ sourceId }) => sourceId === 'ats-warm').cost, { requests: 2, durationMs: 300, failures: 'Not Verified', truncated: 'Not Verified' });
  for (const row of shared.sources.filter(({ sourceId }) => sourceId === 'theirstack')) {
    assert.deepEqual(row.cost, { requests: 'Not Verified', durationMs: 'Not Verified', failures: 'Not Verified', truncated: 'Not Verified' });
  }
  const single = buildUsefulSourceYield({
    identityRows: [identityRow('sha256:a', { provenance: [{ sourceId: 'theirstack', queryId: 'q-ai' }] })],
    sourceTelemetry,
    sourceEndStates: {},
  });
  assert.deepEqual(single.sources.find(({ sourceId }) => sourceId === 'theirstack').cost, { requests: 4, durationMs: 1200, failures: 1, truncated: true });
  const recovery = buildUsefulSourceYield({
    identityRows: [identityRow('sha256:r', { provenance: [{ sourceId: 'portal-discovery', recovery: true }] })],
    sourceTelemetry,
    sourceEndStates: {},
    heldLeadRecovery: { outcomes: [{ requests: 2 }, { requests: 1 }] },
  });
  const recoveryRow = recovery.sources.find(({ sourceId }) => sourceId === 'portal-discovery');
  assert.equal(recoveryRow.kind, 'recovery');
  assert.equal(recoveryRow.cost.requests, 3, 'recovery requests come from held-lead outcomes, not the shared portal source');
});

test('a source with no useful rows keeps its row, end state and cost in the output', () => {
  const report = buildUsefulSourceYield({
    identityRows: [identityRow('sha256:a', { provenance: [{ sourceId: 'ats-warm' }] })],
    sourceTelemetry: { 'ats-batch-1': { status: 'succeeded', fetched: 0, requests: 3, durationMs: 900 } },
    sourceEndStates: { 'ats-batch-1': { state: 'empty', reason: 'no-records-returned' }, 'career-sites': { state: 'not_started', reason: 'source-not-planned' } },
  });
  const batch = report.sources.find(({ sourceId }) => sourceId === 'ats-batch-1');
  assert.deepEqual([batch.referenceCount, batch.uniqueRequisitions, batch.endState, batch.endReason, batch.cost.requests], [0, 0, 'empty', 'no-records-returned', 3]);
  const careers = report.sources.find(({ sourceId }) => sourceId === 'career-sites');
  assert.deepEqual([careers.uniqueRequisitions, careers.endState, careers.cost.requests], [0, 'not_started', 'Not Verified']);
  assert.equal(report.identityCount, 1);
});

test('the crawler-v2 budget split stays at its twenty-minute contract', () => {
  const { execution } = JSON.parse(readFileSync(new URL('../../config/crawler-v2.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    [execution.wholeRunDeadlineMs, execution.discoveryBudgetMs, execution.downstreamReserveMs, execution.handoffReserveMs],
    [1200000, 720000, 300000, 180000],
  );
});
