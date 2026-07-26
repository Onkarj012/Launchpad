import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCrawlerStore } from '../../crawler/run.mjs';
import { crawlWorkflow } from '../../crawler/workflow.mjs';

function fixedClock() {
  let current = Date.parse('2026-07-23T10:00:00.000Z');
  return {
    now: () => new Date(current).toISOString(),
    async sleep(milliseconds) { current += milliseconds; },
  };
}

function observation(overrides = {}) {
  return {
    provider: 'fixture',
    providerJobId: 'iso-job-1',
    canonicalUrl: 'https://jobs.example.test/env-isolation-1',
    company: 'Isolation Co',
    title: 'AI Engineer',
    location: 'Pune',
    description: 'Build AI systems for isolation tests.',
    postedAt: '2026-07-23T08:00:00.000Z',
    classification: 'direct',
    sourceKind: 'ats-direct',
    applicationReady: true,
    applicationResolution: { status: 'Resolved Original', evidence: 'fixture' },
    liveness: { status: 'Active', evidence: 'fixture' },
    ...overrides,
  };
}

function prepareEntry(candidate) {
  return {
    candidate,
    eligibility: { eligible: true, strict: true },
    freshness: { eligible: true, ageHours: 2 },
  };
}

async function runOnStore(store, runId, obs = observation()) {
  return crawlWorkflow({
    store,
    runId,
    clock: fixedClock(),
    sourcePlans: [{
      id: `fixture-${runId}`,
      lane: 'fixture',
      trustClass: 'direct',
      fetch: async () => ({ observations: [obs] }),
    }],
    prepareEntry,
    v4Snapshot: {
      status: 'missing',
      path: path.join(os.tmpdir(), `v4-missing-${runId}.json`),
      generatedAt: null,
      rowCount: 0,
      rows: [],
    },
  });
}

test('dev-env and production-env databases do not share novelty observations', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-env-iso-'));
  const job = observation();

  const devStore = openCrawlerStore(path.join(root, 'dev.sqlite'));
  const devFirst = await runOnStore(devStore, 'dev-run-1', job);
  assert.equal(devFirst.observations[0]._crawlerIdentity.code, 'NEW_TO_ME');
  const devSecond = await runOnStore(devStore, 'dev-run-2', job);
  assert.notEqual(devSecond.observations[0]._crawlerIdentity.code, 'NEW_TO_ME');
  assert.equal(devSecond.observations[0]._crawlerNovelty.newToMe, false);
  devStore.close();

  const prodStore = openCrawlerStore(path.join(root, 'crawler.sqlite'));
  const prodFirst = await runOnStore(prodStore, 'prod-run-1', job);
  assert.equal(prodFirst.observations[0]._crawlerIdentity.code, 'NEW_TO_ME');
  assert.equal(prodFirst.observations[0]._crawlerNovelty.newToMe, true);
  assert.equal(prodFirst.v4Snapshot.status, 'missing');
  assert.equal(prodFirst.v4Snapshot.rowCount, 0);
  prodStore.close();
});

test('repeated local test runs against an in-memory store do not make production see the role as previously-seen', async () => {
  const job = observation({
    providerJobId: 'iso-job-memory',
    canonicalUrl: 'https://jobs.example.test/env-isolation-memory',
  });

  const memory = openCrawlerStore(':memory:');
  await runOnStore(memory, 'mem-1', job);
  await runOnStore(memory, 'mem-2', job);
  await runOnStore(memory, 'mem-3', job);
  memory.close();

  const prodRoot = mkdtempSync(path.join(os.tmpdir(), 'launchpad-env-iso-prod-'));
  const prodStore = openCrawlerStore(path.join(prodRoot, 'crawler.sqlite'));
  const prod = await runOnStore(prodStore, 'prod-after-memory', job);
  assert.equal(prod.observations[0]._crawlerIdentity.code, 'NEW_TO_ME');
  assert.equal(prod.observations[0]._crawlerNovelty.newToMe, true);
  prodStore.close();
});

test('workflow surfaces missing V4 snapshot telemetry with zero historical suppressions', async () => {
  const store = openCrawlerStore(':memory:');
  const result = await crawlWorkflow({
    store,
    runId: 'v4-missing-telemetry',
    clock: fixedClock(),
    sourcePlans: [{
      id: 'fixture-v4-missing',
      lane: 'fixture',
      trustClass: 'direct',
      fetch: async () => ({ observations: [observation({ providerJobId: 'v4-miss-1', canonicalUrl: 'https://jobs.example.test/v4-miss-1' })] }),
    }],
    prepareEntry,
    historicalRows: [],
    v4Snapshot: { status: 'missing', path: '/tmp/does-not-exist.json', generatedAt: null, rowCount: 0, rows: [] },
  });
  store.close();

  assert.equal(result.v4Snapshot.status, 'missing');
  assert.equal(result.v4Snapshot.rowCount, 0);
  assert.equal(result.historicalSuppressions.length, 0);
  assert.equal(result.counts.historicalSuppressed, 0);
});

test('workflow routes ambiguous historical matches to verification, not shortlist or suppression', async () => {
  const store = openCrawlerStore(':memory:');
  const obs = observation({
    provider: 'lever',
    providerJobId: 'same',
    canonicalUrl: 'https://jobs.example.test/hist-ambiguous',
    company: 'Ambiguous Hist Co',
  });
  const result = await crawlWorkflow({
    store,
    runId: 'hist-ambiguous',
    clock: fixedClock(),
    sourcePlans: [{
      id: 'fixture-hist-ambiguous',
      lane: 'fixture',
      trustClass: 'direct',
      fetch: async () => ({ observations: [obs] }),
    }],
    prepareEntry,
    historicalRows: [
      { provider: 'lever', providerJobId: 'same', company: 'One', title: 'Engineer', location: 'Pune', state: 'applied' },
      { provider: 'lever', providerJobId: 'same', company: 'Two', title: 'Engineer', location: 'Pune', state: 'rejected' },
    ],
    v4Snapshot: { status: 'loaded', path: 'fixture', generatedAt: '2026-07-20T00:00:00Z', rowCount: 2, rows: [] },
  });
  store.close();

  assert.equal(result.historicalSuppressions.length, 0);
  assert.equal(result.shortlist.length, 0);
  assert.equal(result.reserve.length, 0);
  assert.equal(result.counts.historicalAmbiguous, 1);
  assert.ok(result.verificationQueue.some((item) => item.reasons?.includes('AMBIGUOUS_HISTORICAL_COLLISION')));
  assert.equal(result.v4Snapshot.status, 'loaded');
  assert.equal(result.v4Snapshot.rowCount, 2);
});

test('novelty breakdown separates production observation, history, and newly-actionable counts', async () => {
  const store = openCrawlerStore(':memory:');
  const first = observation({
    providerJobId: 'novelty-prod-1',
    canonicalUrl: 'https://jobs.example.test/novelty-prod-1',
    company: 'Novelty Prod Co',
  });
  await runOnStore(store, 'novelty-seed', first);

  const historical = observation({
    providerJobId: 'novelty-hist-1',
    canonicalUrl: 'https://jobs.example.test/novelty-hist-1',
    company: 'Novelty Hist Co',
    title: 'ML Engineer',
  });
  const result = await crawlWorkflow({
    store,
    runId: 'novelty-breakdown',
    clock: fixedClock(),
    sourcePlans: [{
      id: 'fixture-novelty',
      lane: 'fixture',
      trustClass: 'direct',
      fetch: async () => ({ observations: [first, historical] }),
    }],
    prepareEntry,
    historicalRows: [{
      company: historical.company,
      title: historical.title,
      location: historical.location,
      state: 'applied',
      canonical_url: historical.canonicalUrl,
    }],
    v4Snapshot: { status: 'loaded', path: 'fixture', generatedAt: '2026-07-20T00:00:00Z', rowCount: 1 },
  });
  store.close();

  assert.ok(result.novelty.productionObservation >= 1);
  assert.equal(result.novelty.actionedHistory, 1);
  assert.equal(result.counts.novelty.actionedHistory, 1);
  assert.equal(typeof result.novelty.surfacedHistory, 'number');
  assert.equal(typeof result.novelty.newlyActionable, 'number');
});
