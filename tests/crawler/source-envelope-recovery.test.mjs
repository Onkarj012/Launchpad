import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applicationReadiness } from '../../job-pull/normal-readiness.mjs';
import { classifyCandidate } from '../../job-pull/eligibility.mjs';
import { loadConfig as loadJobPullPolicy } from '../../job-pull/config.mjs';
import {
  cloneJsonSafe, cloneJsonCollection, cloneJsonEnvelope,
  openCrawlerStore, crawlRun, readCrawlerRunData, finishCrawlRun,
} from '../../crawler/run.mjs';

const captured = JSON.parse(readFileSync(new URL('../fixtures/portals/linkedin-details/live-trial-observations-2026-10-03.json', import.meta.url)));
const policy = loadJobPullPolicy();
const enriched = captured.map((candidate) => ({ ...candidate, readiness: applicationReadiness(candidate, classifyCandidate(candidate, policy)), applicationReady: false }));

test('the exact captured 30 enriched records finalize after checkpoints and survive store reopen', async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), 'source-envelope-')), 'crawler.sqlite');
  let store = openCrawlerStore(database);
  try {
    const result = await crawlRun({ store, runId: 'captured-30', sourcePlans: [{
      id: 'portal-discovery', lane: 'portals', fetch: async ({ checkpoint }) => {
        for (const observation of captured) await checkpoint({ observations: [observation] });
        return { observations: enriched, manifest: { fetched: 30, changed: 30 } };
      },
    }] });
    assert.equal(result.run.status, 'completed');
    assert.equal(result.run.counts.failed, 0);
    assert.equal(result.run.counts.observations, 30);
    assert.equal(result.telemetry.sources['portal-discovery'].status, 'succeeded');
    assert.deepEqual(result.failures, []);
    store.close();
    store = openCrawlerStore(database);
    const retained = readCrawlerRunData(store, 'captured-30');
    assert.equal(retained.observations.length, 30);
    for (const row of captured.filter((row) => row.description)) {
      assert.equal(retained.observations.find((item) => item.raw.jobId === row.jobId).raw.description, row.description);
    }
  } finally { store.close(); }
});

test('a legitimate bounded source batch exceeds the aggregate node limit and persists every record', async () => {
  const batch = Array.from({ length: 120 }, (_, index) => ({
    ...enriched[index % enriched.length],
    jobId: `batch-${index}`,
    sourceRecordKey: `batch-${index}`,
    canonicalUrl: `https://www.linkedin.com/jobs/view/batch-${index}`,
  }));
  assert.throws(() => cloneJsonSafe(batch), /JSON size limit/);
  const store = openCrawlerStore(':memory:');
  try {
    const result = await crawlRun({ store, runId: 'bounded-batch', sourcePlans: [{
      id: 'portal-discovery', lane: 'portals', fetch: async () => ({ observations: batch }),
    }] });
    assert.equal(result.run.status, 'completed');
    assert.deepEqual(result.failures, []);
    assert.equal(readCrawlerRunData(store, 'bounded-batch').observations.length, batch.length);
  } finally { store.close(); }
});

test('invalid individual records and excessive collection count/bytes fail before any batch rows persist', async () => {
  const cycle = {}; cycle.self = cycle;
  const deep = {}; let nested = deep;
  for (let level = 0; level < 34; level++) { nested.next = {}; nested = nested.next; }
  for (const bad of [cycle, deep, { invalid: undefined }, { invalid: Infinity }, { invalid: 1n }, new Map(),
    { [Symbol('invalid')]: true }, { nodes: Array(10_001).fill(0) }, { text: 'x'.repeat(2_000_001) }]) {
    const store = openCrawlerStore(':memory:');
    try {
      const result = await crawlRun({ store, runId: 'bad', sourcePlans: [{
        id: 'bad-source', lane: 'test', fetch: async () => ({ observations: [captured[0], bad] }),
      }] });
      assert.equal(result.run.status, 'completed_with_failures');
      assert.equal(result.run.counts.failed, 1);
      assert.equal(readCrawlerRunData(store, 'bad').observations.length, 0);
    } finally { store.close(); }
  }
  assert.throws(() => cloneJsonCollection(Array(10_001).fill(null)), /record count limit/);
  assert.throws(() => cloneJsonCollection(Array(11).fill('x'.repeat(1_900_000))), /total byte limit/);
  assert.throws(() => cloneJsonCollection([,]), /sparse array/);
});

test('run telemetry validates bounded source and workflow envelopes without a cumulative record node limit', async () => {
  const store = openCrawlerStore(':memory:');
  try {
    await crawlRun({ store, runId: 'envelope', sourcePlans: [] });
    const run = finishCrawlRun(store, 'envelope', { counts: { observations: 30 }, telemetry: {
      sources: { portal: { status: 'succeeded' } },
      workflow: { verificationQueue: enriched, unresolvedLeads: enriched, terminalEnvelope: { verificationQueue: enriched } },
    } });
    assert.equal(run.telemetry.workflow.verificationQueue.length, 30);
    assert.equal(run.counts.observations, 30);
    const reopened = await crawlRun({ store, runId: 'envelope', sourcePlans: [{
      id: 'never-fetch', fetch: () => { throw new Error('completed run must not fetch'); },
    }] });
    assert.equal(reopened.idempotent, true);
    assert.deepEqual(reopened.telemetry.workflow, run.telemetry.workflow);
    const bad = { workflow: { verificationQueue: [{ value: undefined }] } };
    assert.throws(() => finishCrawlRun(store, 'envelope', { telemetry: bad }), /unsupported undefined/);
    assert.throws(() => cloneJsonEnvelope({ rows: Array(10_001).fill(null) }, 'envelope', [['rows']]), /record count limit/);
  } finally { store.close(); }
});
