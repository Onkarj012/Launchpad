import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applicationReadiness } from '../../job-pull/normal-readiness.mjs';
import { classifyCandidate } from '../../job-pull/eligibility.mjs';
import { loadConfig as loadJobPullPolicy } from '../../job-pull/config.mjs';
import {
  cloneJsonSafe, cloneJsonCollection, cloneJsonEnvelope, FUNNEL_COLLECTION_BOUNDARIES,
  openCrawlerStore, crawlRun, readCrawlerRunData, finishCrawlRun, persistDailyReceipt,
} from '../../crawler/run.mjs';
import { crawlWorkflow } from '../../crawler/workflow.mjs';
import { buildDailyReceipt } from '../../crawler/daily-receipt.mjs';
import { renderLocalLeadReport } from '../../crawler/local-lead-report.mjs';

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
  assert.equal(cloneJsonCollection(Array(11).fill('x'.repeat(1_900_000)), 'big source', { maxBytes: 80_000_000 }).length, 11);
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

test('workflow telemetry and yield survive aggregate source size and replay after reopening the store', async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), 'workflow-telemetry-')), 'crawler.sqlite');
  const sources = Array.from({ length: 4 }, (_, lane) => ({
    id: `source-${lane}`, lane: 'ats',
    fetch: async () => ({ observations: [], manifest: { sources: Array.from({ length: 650 }, (_, board) => ({
      provider: 'fixture', board: `${lane}-${board}`, fetched: 0, status: 'ok',
    })) } }),
  }));
  let store = openCrawlerStore(database);
  try {
    const result = await crawlWorkflow({ store, runId: 'large-telemetry', sourcePlans: sources });
    assert.equal(result.run.status, 'completed');
    assert.equal(result.sourceYield.sources.length, 2600);
    assert.throws(() => cloneJsonSafe(result.sourceTelemetry), /JSON size limit/);
    assert.throws(() => cloneJsonSafe(result.sourceYield), /JSON size limit/);
    for (const telemetry of Object.values(result.sourceTelemetry)) assert.doesNotThrow(() => cloneJsonSafe(telemetry.detail));
    const persisted = JSON.parse(store.prepare('SELECT telemetry_json FROM crawl_runs WHERE run_id = ?').get('large-telemetry').telemetry_json);
    assert.deepEqual(persisted.workflow.sourceYield, result.sourceYield);
    store.close();
    store = openCrawlerStore(database);
    const replay = await crawlWorkflow({ store, runId: 'large-telemetry', sourcePlans: [{
      id: 'never-fetch', fetch: () => { throw new Error('replay must not fetch'); },
    }] });
    assert.equal(replay.idempotent, true);
    assert.deepEqual(replay.sourceTelemetry, result.sourceTelemetry);
    assert.deepEqual(replay.sourceYield, result.sourceYield);
    assert.throws(() => finishCrawlRun(store, 'large-telemetry', { telemetry: {
      workflow: { sourceTelemetry: { bad: { detail: { invalid: undefined } } } },
    } }), /unsupported undefined/);
    assert.throws(() => finishCrawlRun(store, 'large-telemetry', { telemetry: {
      workflow: { sourceTelemetry: { bad: { detail: { nodes: Array(10_001).fill(0) } } } },
    } }), /JSON size limit/);
    const candidates = Array.from({ length: 3_400 }, (_, index) => ({
      provider: 'fixture-provider', jobId: `receipt-${index}`, providerJobId: `receipt-${index}`,
      canonicalUrl: `https://fixture.example.test/jobs/receipt-${index}`,
      url: `https://fixture.example.test/jobs/receipt-${index}`,
      company: `Receipt Company ${index}`, title: 'AI Engineer', location: 'Remote India', source: 'daily-discovery',
    }));
    const receiptDatabase = path.join(mkdtempSync(path.join(tmpdir(), 'workflow-receipt-')), 'crawler.sqlite');
    let receiptStore = openCrawlerStore(receiptDatabase);
    const daily = await crawlWorkflow({ store: receiptStore, runId: 'large-daily-receipt', sourcePlans: [{
      id: 'daily-discovery', lane: 'fixture', fetch: async () => ({
        observations: candidates.slice(0, 30),
        verificationQueue: candidates.slice(0, 30).map((candidate) => ({
          ...candidate, discoveryUrl: candidate.canonicalUrl, dedupKey: `${candidate.provider}|${candidate.jobId}`,
          reasons: ['FRESHNESS_NOT_VERIFIED'],
        })),
        manifest: { fetched: candidates.length, status: 'ok' },
      }),
    }] });
    assert.equal(daily.funnel.identityRows.length, enriched.length);
    assert.equal(daily.verificationQueue.length, 30);
    const largeFunnel = {
      ...daily.funnel,
      identityRows: candidates.map((candidate, index) => ({
        ...daily.funnel.identityRows[index % daily.funnel.identityRows.length],
        identity: `sha256:${createHash('sha256').update(`fixture-provider|receipt-${index}`).digest('hex')}`,
        provider: 'fixture-provider', source: 'daily-discovery',
        provenance: [{ provider: 'fixture-provider', source: `source-${index}`, sourceId: `source-${index}` }],
      })),
      receiptLedgerSuppressions: Array.from({ length: 1_000 }, (_, index) => ({
        identity: `sha256:ledger-${index}`,
        code: 'DEDUP_EXISTING_LEDGER',
        evidence: `fixture-provider|receipt-${index}`,
        provider: 'fixture-provider',
        source: 'daily-discovery',
        provenance: [{ provider: 'fixture-provider', source: 'daily-discovery', sourceId: 'daily-discovery', observedAt: null, postedAt: null }],
      })),
    };
    const largeVerificationQueue = Array.from({ length: candidates.length }, (_, index) => ({
      provider: 'fixture-provider', jobId: `receipt-${index}`, dedupKey: `fixture-provider|receipt-${index}`,
      canonicalUrl: `https://fixture.example.test/jobs/receipt-${index}`,
      discoveryUrl: `https://fixture.example.test/jobs/receipt-${index}`,
      company: `Receipt Company ${index}`, title: 'AI Engineer', reasons: ['FRESHNESS_NOT_VERIFIED'],
    }));
    assert.equal(cloneJsonEnvelope(largeFunnel, 'workflow funnel', FUNNEL_COLLECTION_BOUNDARIES).identityRows.length, candidates.length);
    const boundedFunnel = cloneJsonEnvelope(largeFunnel, 'workflow funnel', FUNNEL_COLLECTION_BOUNDARIES);
    assert.equal(boundedFunnel.receiptLedgerSuppressions.length, 1_000);
    assert.throws(() => cloneJsonEnvelope({ ...largeFunnel, receiptLedgerSuppressions: Array(10_001).fill(largeFunnel.receiptLedgerSuppressions[0]) }, 'workflow funnel', FUNNEL_COLLECTION_BOUNDARIES), /record count limit/);
    assert.throws(() => cloneJsonEnvelope({ ...largeFunnel, receiptLedgerSuppressions: [{ ...largeFunnel.receiptLedgerSuppressions[0], invalid: undefined }] }, 'workflow funnel', FUNNEL_COLLECTION_BOUNDARIES), /unsupported undefined/);
    const receipt = buildDailyReceipt({
      runId: 'large-daily-receipt', runAt: '2026-10-20T00:00:00.000Z', funnel: largeFunnel,
      observations: candidates, verificationQueue: largeVerificationQueue,
      historicalSuppressions: daily.historicalSuppressions, terminalEnvelope: daily.terminalEnvelope,
    });
    assert.equal(receipt.scopes.uniqueRequisitions.count, candidates.length + 1_000);
    const hardGateBuckets = new Set(['geo', 'title', 'experience', 'employment', 'salary', 'liveness', 'freshnessRejected']);
    const expectedHardRejections = largeFunnel.identityRows.filter((row) =>
      hardGateBuckets.has(row.bucket) && !row.verificationRequiredGates?.includes(row.bucket));
    const expectedVerification = largeFunnel.identityRows.length - expectedHardRejections.length;
    assert.equal(receipt.scopes.hardRejection.count, expectedHardRejections.length);
    assert.equal(receipt.scopes.verification.count, expectedVerification);
    assert.equal(receipt.scopes.hardRejection.count + receipt.scopes.verification.count, candidates.length);
    const receiptRowsByIdentity = new Map(receipt.retained.identityRows.map((row) => [row.identityHash, row]));
    for (const funnelRow of largeFunnel.identityRows) {
      const receiptRow = receiptRowsByIdentity.get(funnelRow.identity);
      assert.ok(receiptRow);
      if (expectedHardRejections.includes(funnelRow)) {
        assert.equal(receiptRow.stage, 'hardRejection');
        assert.equal(receiptRow.reason, funnelRow.reason);
        assert.equal(receiptRow.upstreamStage, funnelRow.bucket);
        assert.equal(receiptRow.upstreamReason, funnelRow.reason);
        assert.deepEqual(receiptRow.alsoFailed, funnelRow.alsoFailed);
      } else {
        assert.equal(receiptRow.stage, 'verification');
        assert.equal(receiptRow.reason, '[FRESHNESS_NOT_VERIFIED]');
      }
    }
    const existingTelemetry = JSON.parse(receiptStore.prepare('SELECT telemetry_json FROM crawl_runs WHERE run_id = ?').get('large-daily-receipt').telemetry_json);
    existingTelemetry.workflow.funnel = largeFunnel;
    existingTelemetry.workflow.verificationQueue = largeVerificationQueue;
    existingTelemetry.sources['daily-discovery'].attemptHistory = Array.from({ length: 300 }, (_, index) => ({ attempt: index, status: 'ok' }));
    existingTelemetry.workflow.historicalSuppressions = Array.from({ length: 300 }, (_, index) => ({ code: 'SUPPRESSED_HISTORICAL', row: index }));
    existingTelemetry.workflow.sourceYield.sources = Array.from({ length: 300 }, (_, index) => ({ source: `source-${index}`, fetched: 0 }));
    existingTelemetry.workflow.funnel.sourceHealth['daily-discovery'].boards = Array.from({ length: 300 }, (_, index) => ({ board: `board-${index}`, status: 'ok' }));
    finishCrawlRun(receiptStore, 'large-daily-receipt', { telemetry: existingTelemetry });
    assert.equal(persistDailyReceipt(receiptStore, 'large-daily-receipt', receipt), true);
    receiptStore.close();
    receiptStore = openCrawlerStore(receiptDatabase);
    const retained = JSON.parse(receiptStore.prepare('SELECT telemetry_json FROM crawl_runs WHERE run_id = ?').get('large-daily-receipt').telemetry_json);
    assert.equal(retained.workflow.funnel.identityRows.length, candidates.length);
    assert.equal(retained.workflow.funnel.receiptLedgerSuppressions.length, 1_000);
    assert.deepEqual(retained.workflow.funnel.receiptLedgerSuppressions, largeFunnel.receiptLedgerSuppressions);
    assert.equal(retained.workflow.verificationQueue.length, candidates.length);
    assert.equal(retained.sources['daily-discovery'].attemptHistory.length, 300);
    assert.equal(retained.workflow.historicalSuppressions.length, 300);
    assert.equal(retained.workflow.sourceYield.sources.length, 300);
    assert.equal(retained.workflow.funnel.sourceHealth['daily-discovery'].boards.length, 300);
    assert.equal(retained.workflow.dailyReceipt.retained.identityRows.length, candidates.length + 1_000);
    assert.equal(retained.workflow.dailyReceipt.scopes.historySuppression.count, 1_000);
    assert.match(renderLocalLeadReport({ dailyReceipt: retained.workflow.dailyReceipt }, { now: '2026-10-20T00:00:00.000Z' }), /Unique requisitions: 4400/);
    const receiptReplay = await crawlWorkflow({ store: receiptStore, runId: 'large-daily-receipt', sourcePlans: [{
      id: 'never-fetch', fetch: () => { throw new Error('receipt replay must not fetch'); },
    }] });
    assert.equal(receiptReplay.idempotent, true);
    assert.equal(persistDailyReceipt(receiptStore, 'large-daily-receipt', receipt), true);
    assert.throws(() => persistDailyReceipt(receiptStore, 'large-daily-receipt', { retained: {
      identityRows: [{ evidence: 'x'.repeat(2_000_001) }],
    } }), /record byte limit/);
    assert.throws(() => persistDailyReceipt(receiptStore, 'large-daily-receipt', { retained: {
      identityRows: Array(10_001).fill({ identityHash: 'large' }),
    } }), /record count limit/);
    assert.throws(() => persistDailyReceipt(receiptStore, 'large-daily-receipt', { retained: {
      identityRows: Array(5_001).fill({ identityHash: 'large' }),
      observations: Array(5_000).fill({ identityHash: 'large' }),
    } }), /total record count limit/);
    const oversizedReceipt = { retained: {
      identityRows: Array.from({ length: 5_000 }, () => ({ evidence: 'x'.repeat(2_100) })),
      observations: Array.from({ length: 5_000 }, () => ({ evidence: 'x'.repeat(2_100) })),
    } };
    assert.throws(() => persistDailyReceipt(receiptStore, 'large-daily-receipt', oversizedReceipt), /total byte limit/);
    receiptStore.close();
  } finally { store.close(); }
});
