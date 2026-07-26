import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commitDailyDelivery,
  crawlerLaneFixtures,
  runDailyNormal,
} from '../../crawler/daily-runner.mjs';
import { commitDailyReport } from '../../crawler/daily-report.mjs';
import { openCrawlerStore, readCrawlerRunData } from '../../crawler/run.mjs';
import { crawlWorkflow } from '../../crawler/workflow.mjs';
import { NORMAL_SOURCE_LANES } from '../../job-pull/normal-sources.mjs';

const NOW = '2026-07-24T06:30:00.000Z';

function greenhouseJob(id, companySlug, overrides = {}) {
  return {
    id,
    title: 'AI Engineer',
    absolute_url: `https://job-boards.greenhouse.io/${companySlug}/jobs/${id}`,
    location: { name: 'Pune, India' },
    content: 'Full-time AI Engineer role for 0-1 years building Python systems.',
    first_published: NOW,
    employment_type: 'Full-Time',
    ...overrides,
  };
}

function rawPortalJob(id, overrides = {}) {
  return {
    url: `https://naukri.example.test/job/${id}`,
    company: `Portal Company ${id}`,
    title: 'AI Engineer',
    location: 'Pune, India',
    description: 'Full-time AI Engineer role for 0-1 years building Python systems.',
    postedAt: NOW,
    employment: { type: 'full-time', evidence: 'full-time' },
    experience: { minYears: 0, maxYears: 1, evidence: '0-1 years' },
    liveness: { status: 'Active', checkedAt: NOW, evidence: 'employer page checked' },
    originalApplicationUrl: `https://company-${id}.example.test/careers/${id}`,
    originalApplicationEvidence: 'resolved employer careers posting',
    matchScore: 80,
    ...overrides,
  };
}

function writeWarmSet(root, boards = {}) {
  const file = path.join(root, 'reverse-warm-set.json');
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    updatedAt: NOW,
    boards: {
      greenhouse: boards.greenhouse ?? [],
      lever: boards.lever ?? [],
      ashby: boards.ashby ?? [],
      workday: boards.workday ?? [],
    },
  }));
  return file;
}

function testConfig({ warmBoards = [], trackedBoards = [] } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-daily-runner-'));
  const reverseWarmSetPath = writeWarmSet(root, { greenhouse: trackedBoards });
  return {
    root,
    config: {
      schemaVersion: 'LaunchpadCrawlerConfigV1',
      databasePath: path.join(root, 'crawler.sqlite'),
      reverseWarmSetPath,
      sources: {
        atsWarm: {
          boards: warmBoards.map(({ slug, company }) => ({
            provider: 'greenhouse',
            slug,
            company,
            indiaFirst: true,
          })),
          maxBoards: 20,
          maxJobsPerBoard: 100,
        },
      },
    },
  };
}

function fakeTransport(jobsBySlug, calls = []) {
  return async (url) => {
    calls.push(url);
    const match = String(url).match(/\/boards\/([^/]+)\/jobs/);
    const slug = match ? decodeURIComponent(match[1]) : null;
    if (!slug || !Object.hasOwn(jobsBySlug, slug)) throw new Error(`unexpected transport call: ${url}`);
    return { status: 200, body: JSON.stringify({ jobs: jobsBySlug[slug] }) };
  };
}

function runOptions(config, transport, overrides = {}) {
  return {
    config,
    transport,
    clock: { now: () => NOW, sleep: async () => {} },
    runId: `daily-${path.basename(path.dirname(config.databasePath))}`,
    ledgerRows: [],
    opportunityLedgerRows: [],
    ...overrides,
  };
}

function emptyLegacyFixtures() {
  return Object.fromEntries(NORMAL_SOURCE_LANES.filter((lane) => lane.kind !== 'india-portal-search').map((lane) => [lane.id, { candidates: [], manifest: { status: 'empty' } }]));
}

test('crawler-v2 atsWarm observations feed reverse-ats-warm into the real Normal pipeline', async () => {
  const { config } = testConfig({
    warmBoards: [{ slug: 'crawler-board', company: 'Crawler Company' }],
  });
  const result = await runDailyNormal(runOptions(
    config,
    fakeTransport({ 'crawler-board': [greenhouseJob(101, 'crawler-board')] }),
  ));

  // Real crawler-sourced candidates carry no Match Score, so they correctly
  // land in the scoring queue rather than the shortlist (ticket 06).
  assert.deepEqual(result.scoringQueue.map((candidate) => candidate.company), ['Crawler Company']);
  assert.equal(result.scoringQueue[0].normalLaneId, 'reverse-ats-warm');
  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'reverse-ats-warm');
  assert.equal(manifest.fetched, 1);
  assert.equal(manifest.required, true);
  assert.equal(manifest.optional, false);
});

test('tracked warm-set observations feed tracked-ats into the real Normal pipeline', async () => {
  const { config } = testConfig({ trackedBoards: ['tracked-board'] });
  const result = await runDailyNormal(runOptions(
    config,
    fakeTransport({ 'tracked-board': [greenhouseJob(201, 'tracked-board')] }),
  ));

  // Real crawler-sourced candidates carry no Match Score, so they correctly
  // land in the scoring queue rather than the shortlist (ticket 06).
  assert.deepEqual(result.scoringQueue.map((candidate) => candidate.company), ['tracked-board']);
  assert.equal(result.scoringQueue[0].normalLaneId, 'tracked-ats');
  assert.equal(result.sourceManifests.find(({ sourceId }) => sourceId === 'tracked-ats').fetched, 1);
});

test('one board is never fetched twice when crawler warm and tracked inputs overlap', async () => {
  const { config } = testConfig({
    warmBoards: [{ slug: 'shared-board', company: 'Shared Company' }],
    trackedBoards: ['shared-board'],
  });
  const calls = [];
  const result = await runDailyNormal(runOptions(
    config,
    fakeTransport({ 'shared-board': [greenhouseJob(202, 'shared-board')] }, calls),
  ));
  assert.equal(calls.length, 1);
  assert.equal(result.scoringQueue.filter((candidate) => candidate.company === 'Shared Company').length, 1);
  const tracked = result.sourceManifests.find(({ sourceId }) => sourceId === 'tracked-ats');
  assert.equal(tracked.boardsOmitted, 1);
  assert.equal(tracked.omissions[0].reason, 'covered-by-crawler-source-plan');
});

test('caller-supplied fixtures for other Normal lanes are preserved', async () => {
  const { config } = testConfig();
  const portalJob = rawPortalJob(301);
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      'portal-naukri': {
        candidates: [portalJob],
        manifest: { status: 'ok', fixture: 'caller-owned' },
      },
    },
  }));

  assert.deepEqual(result.shortlist.map((candidate) => candidate.company), ['Portal Company 301']);
  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'portal-naukri');
  assert.equal(manifest.fixture, 'caller-owned');
  assert.equal(manifest.fetched, 1);
});

test('crawlerV2Telemetry is diagnostic-only and leaves the shortlist unchanged', async () => {
  const firstSetup = testConfig({
    warmBoards: [{ slug: 'telemetry-board', company: 'Telemetry Company' }],
  });
  const first = await runDailyNormal(runOptions(
    firstSetup.config,
    fakeTransport({ 'telemetry-board': [greenhouseJob(401, 'telemetry-board')] }),
  ));
  const beforeInspection = first.shortlist.map(({ canonicalUrl, normalLaneId }) => ({ canonicalUrl, normalLaneId }));

  assert.ok(first.crawlerV2Telemetry['ats-warm']);
  JSON.stringify(first.crawlerV2Telemetry);
  assert.deepEqual(
    first.shortlist.map(({ canonicalUrl, normalLaneId }) => ({ canonicalUrl, normalLaneId })),
    beforeInspection,
  );
});

test('historicalV4Rows suppress crawler-fed duplicates before Normal shortlist planning', async () => {
  const { config } = testConfig({
    warmBoards: [{ slug: 'historical-board', company: 'Historical Company' }],
  });
  const result = await runDailyNormal(runOptions(
    config,
    fakeTransport({ 'historical-board': [greenhouseJob(501, 'historical-board')] }),
    {
      historicalV4Rows: [{
        company: 'Historical Company',
        title: 'AI Engineer',
        location: 'Pune, India',
        state: 'applied',
      }],
    },
  ));

  assert.equal(result.shortlist.length, 0);
  assert.equal(result.plannedNotionOperations.length, 0);
  assert.equal(result.historicalSuppressions.length, 1);
  assert.equal(result.counts.historicalSuppressed, 1);
});

test('lanes outside crawler-v2 and tracked ATS stay truthfully unavailable', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({})));
  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'portal-foundit');

  assert.equal(manifest.status, 'unavailable');
  assert.equal(manifest.attempted, false);
  assert.equal(manifest.reasonCode, 'PORTAL_REQUIRES_LIVE_INJECTION');
  assert.equal(result.shortfall.failedLanes.includes('portal-foundit'), false);
});

test('an empty tracked warm set produces an attempted empty lane without transport calls', async () => {
  const { config } = testConfig();
  const calls = [];
  const result = await runDailyNormal(runOptions(config, fakeTransport({}, calls)));
  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'tracked-ats');

  assert.equal(calls.length, 0);
  assert.equal(manifest.attempted, true);
  assert.equal(manifest.status, 'empty');
  assert.equal(manifest.fetched, 0);
});

test('unified daily mode exposes every new optional lane in the scored pool', async () => {
  const { config } = testConfig();
  const laneIds = ['expanded-ats', 'structured-career-pages', 'web-discovery', 'connector-inbox'];
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: Object.fromEntries(laneIds.map((laneId, index) => [laneId, {
      candidates: [rawPortalJob(700 + index, { company: `${laneId} company` })],
      manifest: { status: 'ok', source: 'unified-fixture' },
    }])),
  }));

  assert.equal(result.counts.scored, laneIds.length);
  for (const laneId of laneIds) {
    const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === laneId);
    assert.equal(manifest.fetched, 1);
    assert.equal(manifest.optional, true);
    assert.ok(result.shortlist.some((candidate) => candidate.normalLaneId === laneId));
  }
});

test('unconfigured unified crawler lanes remain optional without degrading an otherwise empty run', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: emptyLegacyFixtures(),
  }));

  assert.equal(result.outcome.status, 'ok');
  for (const laneId of ['expanded-ats', 'structured-career-pages', 'web-discovery', 'connector-inbox']) {
    const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === laneId);
    assert.equal(manifest.status, 'unavailable');
    assert.equal(manifest.optional, true);
    assert.equal(result.shortfall.failedLanes.includes(laneId), false);
  }
});

test('a failing optional crawler lane reports its failure while another lane still delivers', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'structured-career-pages': {
        candidates: [rawPortalJob(801, { company: 'Career Page Company' })],
        manifest: { status: 'ok' },
      },
    },
    sourceFunctions: {
      'expanded-ats': () => { throw new Error('expanded ATS fixture failed'); },
    },
  }));

  const failed = result.sourceManifests.find(({ sourceId }) => sourceId === 'expanded-ats');
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.errors, ['expanded ATS fixture failed']);
  assert.ok(result.shortfall.failedLanes.includes('expanded-ats'));
  assert.deepEqual(result.shortlist.map((candidate) => candidate.company), ['Career Page Company']);
});

test('a degraded material optional lane degrades the run, and a failed optional lane does too', async () => {
  const { config } = testConfig();
  const partial = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'structured-career-pages': {
        candidates: [rawPortalJob(802, { company: 'Partial Career Page Company' })],
        manifest: { status: 'degraded', errors: ['one source failed'] },
      },
    },
  }));
  assert.equal(partial.outcome.status, 'degraded');
  assert.ok(partial.shortfall.degradedLanes.includes('structured-career-pages'));
  assert.equal(partial.shortfall.failedLanes.includes('structured-career-pages'), false);
  assert.deepEqual(partial.sourceManifests.find(({ sourceId }) => sourceId === 'structured-career-pages').errors, ['one source failed']);

  const failed = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'structured-career-pages': {
        candidates: [],
        manifest: { status: 'failed', errors: ['all sources failed'] },
      },
    },
  }));
  assert.equal(failed.outcome.status, 'degraded');
  assert.ok(failed.shortfall.failedLanes.includes('structured-career-pages'));
});

test('warm-ATS failure messages retain provider, board, and code provenance', async () => {
  const { config } = testConfig({ trackedBoards: ['warm-failure-board'] });
  const result = await runDailyNormal(runOptions(config, async () => {
    throw new Error('warm transport failed');
  }));

  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'tracked-ats');
  assert.deepEqual(manifest.errors, ['greenhouse: warm-failure-board: TRANSPORT_ERROR: warm transport failed']);
  assert.equal(manifest.status, 'failed');
  assert.equal(result.outcome.status, 'degraded');
});

test('unmapped crawler source ids feed web-discovery and remain visible without stopping the run', async () => {
  const crawlerFixture = crawlerLaneFixtures({
    observations: [rawPortalJob(803, { company: 'Unmapped Source Company', sourceId: 'future-source' })],
    failures: [{ sourceId: 'future-source', message: 'future source failed' }],
    sourceTelemetry: { 'future-source': { attempts: 1, fetched: 1 } },
  })['web-discovery'];
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'web-discovery': crawlerFixture,
    },
  }));

  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'web-discovery');
  assert.deepEqual(manifest.unmappedSourceIds, ['future-source']);
  assert.equal(manifest.fetched, 1);
  assert.equal(result.outcome.status, 'degraded');
});

test('re-running the unified run id against the same durable store is idempotent', async () => {
  const { config } = testConfig({
    warmBoards: [{ slug: 'idempotent-board', company: 'Idempotent Company' }],
  });
  const store = openCrawlerStore(config.databasePath);
  const calls = [];
  try {
    const options = runOptions(config, fakeTransport({ 'idempotent-board': [greenhouseJob(901, 'idempotent-board')] }, calls), {
      store,
      runId: 'daily-idempotent',
    });
    await runDailyNormal(options);
    await runDailyNormal(options);
    const observationCount = store.prepare('SELECT COUNT(*) AS count FROM job_observations WHERE run_id = ?').get('daily-idempotent-crawler-v2').count;
    assert.equal(observationCount, 1);
    assert.equal(calls.length, 1);
  } finally {
    store.close();
  }
});

test('an unscored eligible candidate fails the unified run before shortlist delivery', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      'portal-naukri': {
        candidates: [rawPortalJob(1001, { matchScore: undefined })],
        manifest: { status: 'ok' },
      },
    },
  }));

  assert.equal(result.outcome.status, 'fatal');
  assert.deepEqual(result.shortlist, []);
  assert.equal(result.scoringQueue[0].scoringStatus, 'unscored');
  assert.match(result.outcome.errors[0].message, /unscored=1/);
});

test('a scoring failure fails the unified run and surfaces its cause', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      'portal-naukri': {
        candidates: [rawPortalJob(1002, { scoringFailed: true, scoringError: 'rubric service unavailable' })],
        manifest: { status: 'ok' },
      },
    },
  }));

  assert.equal(result.outcome.status, 'fatal');
  assert.deepEqual(result.shortlist, []);
  assert.equal(result.scoringQueue[0].scoringStatus, 'scoring-failed');
  assert.equal(result.scoringQueue[0].scoringFailureReason, 'rubric service unavailable');
  assert.match(result.outcome.errors[0].message, /rubric service unavailable/);
});

test('the run maximum is applied after all candidates receive Match Score', async () => {
  const { config } = testConfig();
  const candidates = Array.from({ length: 21 }, (_, index) => rawPortalJob(1100 + index, {
    company: `Cap Company ${index}`,
    matchScore: index === 20 ? 99 : 70,
  }));
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      'portal-naukri': { candidates, manifest: { status: 'ok' } },
    },
  }));

  assert.equal(result.counts.eligible, 21);
  assert.equal(result.counts.scored, 21);
  assert.equal(result.counts.selected, 20);
  assert.ok(result.shortlist.some((candidate) => candidate.company === 'Cap Company 20' && candidate.matchScore === 99));
  assert.ok(result.shortlist.every((candidate) => Number.isFinite(candidate.matchScore) && Number.isFinite(candidate.conversionScore)));
});

test('reconciliation reports eligible, scored, ready, and selected counts with named causes', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      'portal-naukri': {
        candidates: [
          rawPortalJob(1201, { company: 'Reconciliation Scored' }),
          rawPortalJob(1202, { company: 'Reconciliation Unscored', matchScore: undefined }),
        ],
        manifest: { status: 'ok' },
      },
    },
  }));

  assert.deepEqual(
    {
      eligible: result.reconciliation.eligible,
      scored: result.reconciliation.scored,
      ready: result.reconciliation.ready,
      selected: result.reconciliation.selected,
    },
    { eligible: 2, scored: 1, ready: 2, selected: 0 },
  );
  assert.match(result.reconciliation.line, /eligible=2; scored=1; ready=2; selected=0/);
  assert.match(result.reconciliation.line, /readyToScored:UNSCORED=1/);
});

test('the unified run reads the v4 snapshot by default and suppresses matching roles', async () => {
  const { root, config } = testConfig({
    warmBoards: [{ slug: 'snapshot-board', company: 'Snapshot Company' }],
  });
  const snapshotPath = path.join(root, 'v4-history-snapshot.json');
  writeFileSync(snapshotPath, JSON.stringify({
    generatedAt: NOW,
    rows: [{ company: 'Snapshot Company', title: 'AI Engineer', location: 'Pune, India', state: 'applied' }],
  }));
  config.v4HistorySnapshotPath = snapshotPath;

  const result = await runDailyNormal(runOptions(
    config,
    fakeTransport({ 'snapshot-board': [greenhouseJob(1301, 'snapshot-board')] }),
  ));

  assert.equal(result.v4HistorySnapshot.status, 'loaded');
  assert.equal(result.shortlist.length, 0);
  assert.equal(result.historicalSuppressions.length, 1);
  assert.equal(result.counts.historicalSuppressed, 1);
});

test('valid snapshot status is surfaced in daily telemetry for loaded and stale files', async () => {
  const outcomes = [
    ['loaded', { generatedAt: NOW, rows: [] }],
    ['stale', { generatedAt: '2026-01-01T00:00:00.000Z', rows: [] }],
  ];

  for (const [status, payload] of outcomes) {
    const { root, config } = testConfig();
    const snapshotPath = path.join(root, `${status}.json`);
    if (payload) writeFileSync(snapshotPath, JSON.stringify(payload));
    config.v4HistorySnapshotPath = snapshotPath;
    const result = await runDailyNormal(runOptions(config, fakeTransport({})));
    assert.equal(result.telemetry.v4HistorySnapshot.status, status);
  }
});

test('a stale snapshot warns and still supplies historical rows', async () => {
  const { root, config } = testConfig({
    warmBoards: [{ slug: 'stale-board', company: 'Stale Company' }],
  });
  const snapshotPath = path.join(root, 'stale.json');
  writeFileSync(snapshotPath, JSON.stringify({
    generatedAt: '2026-01-01T00:00:00.000Z',
    rows: [{ company: 'Stale Company', title: 'AI Engineer', location: 'Pune, India', state: 'rejected' }],
  }));
  config.v4HistorySnapshotPath = snapshotPath;

  const result = await runDailyNormal(runOptions(
    config,
    fakeTransport({ 'stale-board': [greenhouseJob(1302, 'stale-board')] }),
  ));

  assert.equal(result.v4HistorySnapshot.status, 'stale');
  assert.match(result.v4HistorySnapshot.warning, /stale/);
  assert.equal(result.historicalSuppressions.length, 1);
  assert.equal(result.outcome.fatal, false);
});

test('missing or malformed snapshots fail the daily preflight loudly', async () => {
  for (const payload of [null, '{not json']) {
    const { root, config } = testConfig();
    const snapshotPath = path.join(root, 'bad-snapshot.json');
    if (payload === null) {
      config.v4HistorySnapshotPath = snapshotPath;
    } else {
      writeFileSync(snapshotPath, payload);
      config.v4HistorySnapshotPath = snapshotPath;
    }

    await assert.rejects(
      runDailyNormal(runOptions(config, fakeTransport({}))),
      (error) => error.code === (payload === null
        ? 'V4_HISTORY_SNAPSHOT_MISSING'
        : 'V4_HISTORY_SNAPSHOT_MALFORMED'),
    );
  }
});

test('unified daily run reports SearXNG health per query in the web-discovery lane', async () => {
  const { config } = testConfig();
  config.sources.searxng = {
    enabled: true,
    endpoint: 'http://127.0.0.1:8080',
    dailyBudget: 2,
    perQueryResultCap: 10,
    queries: ['healthy query', 'blocked query'],
  };
  const result = await runDailyNormal(runOptions(config, async (url) => {
    const query = new URL(url).searchParams.get('q');
    return query === 'blocked query'
      ? { status: 206, body: JSON.stringify({ results: [], unresponsive_engines: [['brave', 'timeout']] }) }
      : { status: 200, body: JSON.stringify({ results: [], unresponsive_engines: [] }) };
  }));

  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'web-discovery');
  assert.deepEqual(manifest.telemetry.queryDiagnostics.map(({ query, responseStatus, status, engineHealth, unresponsiveEngines }) => ({
    query, responseStatus, status, engineHealth, unresponsiveEngines,
  })), [
    { query: 'healthy query', responseStatus: 200, status: 'success', engineHealth: 'healthy-empty', unresponsiveEngines: [] },
    { query: 'blocked query', responseStatus: 206, status: 'degraded', engineHealth: 'degraded', unresponsiveEngines: [['brave', 'timeout']] },
  ]);
});

test('a capped enterprise source remains visibly truncated in the unified run', async () => {
  const { config } = testConfig();
  config.sources.enterprise = {
    boards: [{ provider: 'workday', company: 'Capped Enterprise', url: 'https://capped.wd1.myworkdayjobs.com/jobs' }],
    maxPages: 1,
    maxJobsPerBoard: 1,
  };
  const result = await runDailyNormal(runOptions(config, async (url, options) => {
    assert.equal(options.method, 'POST');
    return { status: 200, headers: {}, body: JSON.stringify({ total: 2, jobPostings: [
      { title: 'AI Engineer', externalPath: '/job/1', locations: ['Pune, India'], postedOn: NOW, jobReqId: 'WD-1' },
      { title: 'Backend Engineer', externalPath: '/job/2', locations: ['Pune, India'], postedOn: NOW, jobReqId: 'WD-2' },
    ] }) };
  }));

  const telemetry = result.crawlerV2Telemetry['ats-enterprise'];
  assert.equal(telemetry.status, 'degraded');
  assert.equal(telemetry.truncated, true);
  assert.equal(telemetry.naturalTerminal, false);
  assert.equal(telemetry.capHit, 'maxJobsPerBoard');
  assert.equal(telemetry.recordsNotExamined, 1);
});

test('Indian portal lanes are optional and explain that live injection is required', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: emptyLegacyFixtures(),
  }));
  for (const laneId of ['portal-naukri', 'portal-foundit', 'portal-hirist', 'portal-cutshort', 'portal-instahyre', 'portal-peerlist', 'portal-linkedin-jobs']) {
    const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === laneId);
    assert.equal(manifest.optional, true);
    assert.equal(manifest.required, false);
    assert.equal(manifest.reasonCode, 'PORTAL_REQUIRES_LIVE_INJECTION');
  }
});

test('unified daily result surfaces the Normal pipeline funnel report', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: emptyLegacyFixtures(),
  }));
  assert.ok(result.funnel);
  assert.equal(result.funnel.reconciliation.ok, true);
});

test('no portal injection is healthy and does not create portal shortfall reasons', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: emptyLegacyFixtures(),
  }));
  assert.equal(result.outcome.status, 'ok');
  assert.equal(result.outcome.degraded, false);
  assert.equal(result.shortfall.failedLanes.some((laneId) => laneId.startsWith('portal-')), false);
  assert.equal(result.shortfall.emptyLanes.some((laneId) => laneId.startsWith('portal-')), false);
  assert.equal(result.shortfall.reasons.some((reason) => /portal-/i.test(reason)), false);
});

test('live-injected portal candidates retain their portal manifest and verification handling', async () => {
  const { config } = testConfig();
  const unresolved = rawPortalJob(1301, {
    originalApplicationUrl: null,
    originalApplicationEvidence: null,
    applicationResolution: { status: 'Unresolved', evidence: null },
    sourceKind: 'aggregator',
  });
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-naukri': { candidates: [unresolved], manifest: { status: 'ok', fixture: 'live-injected' } },
    },
  }));
  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'portal-naukri');
  assert.equal(manifest.fixture, 'live-injected');
  assert.equal(manifest.fetched, 1);
  assert.equal(manifest.optional, true);
  assert.equal(result.verificationQueue[0].provider, 'naukri');
  assert.equal(result.shortlist.length, 0);
});

test('a resolved portal lead is scored in web-discovery with its surfacing provider retained', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-naukri': {
        candidates: [rawPortalJob(1302, {
          provider: 'greenhouse',
          sourceKind: 'ats-direct',
          originalApplicationUrl: 'https://boards.greenhouse.io/acme/jobs/1302',
          originalApplicationEvidence: 'resolved employer ATS listing',
          applicationResolution: { status: 'Resolved Original', evidence: 'resolved employer ATS listing' },
        })],
        manifest: { status: 'ok' },
      },
    },
  }));
  assert.equal(result.counts.scored, 1);
  assert.equal(result.shortlist.length, 1);
  assert.equal(result.shortlist[0].normalLaneId, 'web-discovery');
  assert.equal(result.shortlist[0].provider, 'naukri');
  assert.equal(result.shortlist[0].discoveryProvider, 'naukri');
  assert.equal(result.plannedNotionOperations[0].payload.provider, 'naukri');
  assert.equal(result.sourceManifests.find(({ sourceId }) => sourceId === 'web-discovery').fetched, 1);
});

test('an unresolved portal lead stays in verification and cannot be selected', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-foundit': {
        candidates: [rawPortalJob(1303, {
          originalApplicationUrl: null,
          originalApplicationEvidence: null,
          applicationResolution: { status: 'Unresolved', evidence: null },
          sourceKind: 'aggregator',
        })],
        manifest: { status: 'ok' },
      },
    },
  }));
  assert.equal(result.shortlist.length, 0);
  assert.equal(result.verificationQueue.length, 1);
  assert.equal(result.verificationQueue[0].provider, 'foundit');
  assert.equal(result.verificationQueue[0].applicationResolution.status, 'Unresolved');
});

test('the unified result invokes the canary recorder at the daily-run seam', async () => {
  const { config } = testConfig();
  const records = [];
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    canaryStore: {
      readRuns: () => records,
      append: (record) => records.push(record),
    },
    sourceFixtures: {
      'portal-naukri': { candidates: [rawPortalJob(1401)], manifest: { status: 'ok' } },
    },
  }));

  assert.deepEqual(result.deliveryCanary.counts, {
    eligible: result.counts.eligible,
    scoredPool: result.counts.scored,
    ready: result.counts.ready,
    shortlist: result.counts.selected,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].runId, result.runId);
  assert.deepEqual(records[0].sourceFailureHistogram, result.sourceFailureHistogram);
  assert.deepEqual(result.deliveryCanary.sourceFailureHistogram, result.sourceFailureHistogram);
  assert.equal(result.telemetry.dco.funnel.deliveryCommitStatus, 'committed');
  assert.equal(result.telemetry.dco.operations.unresolvedReconciliationCount, 0);
  assert.equal(JSON.parse(readFileSync(result.delivery.jsonPath, 'utf8')).telemetry.funnel.reconciliation.ok, true);
});

test('scores supplied to the unified daily run merge before the scoring gate', async () => {
  const { config } = testConfig();
  const role = rawPortalJob(1501, { matchScore: undefined });
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-naukri': { candidates: [role], manifest: { status: 'ok' } },
    },
    scores: { scores: [{ canonicalUrl: role.url, matchScore: 80, responseLikelihood: 14 }] },
  }));

  assert.equal(result.outcome.status, 'ok');
  assert.equal(result.scoringQueue.length, 0);
  assert.equal(result.shortlist[0].canonicalUrl, role.url);
  assert.equal(result.shortlist[0].matchScore, 80);
});

test('a score for a canonical URL outside the unified pool is a no-op', async () => {
  const { config } = testConfig();
  const role = rawPortalJob(1502);
  const withoutScores = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-naukri': { candidates: [role], manifest: { status: 'ok' } },
    },
  }));
  const withUnmatchedScore = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-naukri': { candidates: [role], manifest: { status: 'ok' } },
    },
    scores: { scores: [{ canonicalUrl: 'https://not-in-the-pool.example.test/jobs/1', matchScore: 1 }] },
  }));

  assert.equal(withUnmatchedScore.outcome.status, 'ok');
  assert.deepEqual(withUnmatchedScore.shortlist, withoutScores.shortlist);
  assert.deepEqual(withUnmatchedScore.scoringQueue, withoutScores.scoringQueue);
});

test('omitting scores preserves the unified scoring gate', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      'portal-naukri': { candidates: [rawPortalJob(1503, { matchScore: undefined })], manifest: { status: 'ok' } },
    },
  }));

  assert.equal(result.outcome.status, 'fatal');
  assert.equal(result.scoringQueue[0].scoringStatus, 'unscored');
  assert.match(result.outcome.errors[0].message, /unscored=1/);
});

test('daily delivery commits both reports before marking a selected crawler job surfaced', async () => {
  const { config, root } = testConfig();
  const store = openCrawlerStore(config.databasePath);
  const role = rawPortalJob(1601, {
    canonicalUrl: 'https://company-1601.example.test/careers/1601',
    provider: 'fixture',
    providerJobId: 'delivery-1601',
    classification: 'direct',
    sourceKind: 'ats-direct',
    applicationReady: true,
  });
  const crawlerResult = await crawlWorkflow({
    store,
    runId: 'delivery-crawler',
    sourcePlans: [{
      id: 'delivery-fixture',
      lane: 'fixture',
      trustClass: 'direct',
      fetch: async () => ({ observations: [role] }),
    }],
    prepareEntry: (candidate) => ({
      candidate,
      eligibility: { eligible: true, strict: true },
      freshness: { eligible: true, window: 'Hot', ageHours: 1 },
    }),
  });
  const run = {
    runId: 'delivery-run',
    runAt: NOW,
    outcome: { status: 'ok', fatal: false },
    shortlist: [{ ...role, canonicalUrl: role.canonicalUrl, originalApplicationUrl: role.originalApplicationUrl }],
    stretchShortage: [],
    verificationQueue: [],
    sourceManifests: [],
    shortfall: { minimum: 10, selected: 1, missing: 9, reasons: ['APPLICATION_READY_MINIMUM_SHORTFALL'] },
  };
  let observedBeforeCommit = null;
  const result = commitDailyDelivery({
    run,
    crawlerResult,
    databasePath: config.databasePath,
    store,
    reportDirectory: path.join(root, 'daily'),
    reportWriter(options) {
      observedBeforeCommit = readCrawlerRunData(store, 'delivery-crawler').jobs[0].lifecycle;
      return commitDailyReport(options);
    },
  });

  assert.equal(observedBeforeCommit, 'application-ready');
  assert.equal(existsSync(result.reportCommit.markdownPath), true);
  assert.equal(existsSync(result.reportCommit.jsonPath), true);
  assert.equal(readCrawlerRunData(store, 'delivery-crawler').jobs[0].lifecycle, 'surfaced');
  store.close();
});

test('a failed daily report write consumes no crawler jobs', async () => {
  const { config } = testConfig();
  const store = openCrawlerStore(config.databasePath);
  const role = rawPortalJob(1602, {
    canonicalUrl: 'https://company-1602.example.test/careers/1602',
    provider: 'fixture',
    providerJobId: 'delivery-1602',
    classification: 'direct',
    sourceKind: 'ats-direct',
    applicationReady: true,
  });
  const crawlerResult = await crawlWorkflow({
    store,
    runId: 'failed-delivery-crawler',
    sourcePlans: [{
      id: 'failed-delivery-fixture',
      lane: 'fixture',
      trustClass: 'direct',
      fetch: async () => ({ observations: [role] }),
    }],
    prepareEntry: (candidate) => ({
      candidate,
      eligibility: { eligible: true, strict: true },
      freshness: { eligible: true, window: 'Hot', ageHours: 1 },
    }),
  });
  assert.throws(() => commitDailyDelivery({
    run: {
      runId: 'failed-delivery-run',
      runAt: NOW,
      shortlist: [role],
    },
    crawlerResult,
    databasePath: config.databasePath,
    store,
    reportWriter() {
      throw new Error('injected report failure');
    },
  }), /injected report failure/);

  const jobs = readCrawlerRunData(store, 'failed-delivery-crawler').jobs;
  assert.equal(jobs[0].lifecycle, 'application-ready');
  assert.equal(jobs[0].surfaced, false);
  store.close();
});
