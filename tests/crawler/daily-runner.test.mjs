import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDailyNormal } from '../../crawler/daily-runner.mjs';

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
  assert.equal(result.sourceManifests.find(({ sourceId }) => sourceId === 'reverse-ats-warm').fetched, 1);
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
  assert.equal(manifest.reasonCode, 'SOURCE_FUNCTION_UNAVAILABLE');
  assert.ok(result.shortfall.failedLanes.includes('portal-foundit'));
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
