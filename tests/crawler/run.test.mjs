import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  cloneJsonSafe,
  openCrawlerStore,
  crawlRun,
  backfillOriginalPostedAt,
  readCrawlerState,
  readLastSuccessfulSourceRuns,
} from '../../crawler/run.mjs';
import { discoverEnterpriseAts } from '../../crawler/ats-enterprise.mjs';
import { crawlWorkflow } from '../../crawler/workflow.mjs';

function tempDatabase() {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'launchpad-crawler-')), 'crawler.sqlite');
}

function fixedClock() {
  let tick = 0;
  return {
    now() {
      return new Date(Date.UTC(2026, 6, 23, 1, tick++)).toISOString();
    },
    async sleep() {},
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const enterpriseRunAt = '2026-07-23T10:00:00.000Z';

test('a crawl run persists schema, source state, observations, stages, and funnel telemetry', async () => {
  const store = openCrawlerStore(tempDatabase());
  const result = await crawlRun({
    store,
    runId: 'run-001',
    schedule: 'morning',
    priorState: { sources: { greenhouse: { cursor: { page: 3 } } } },
    config: { retry: { maxAttempts: 1 } },
    clock: fixedClock(),
    sourcePlans: [{
      id: 'greenhouse',
      lane: 'ats',
      trustClass: 'direct',
      fetch: async ({ cursor }) => ({
        observations: [
          {
            providerJobId: 'gh-1',
            canonicalUrl: 'https://jobs.example.test/gh-1',
            title: 'AI Engineer',
            company: 'Example',
            location: 'Pune',
            description: 'Build useful systems.',
            postedAt: '2026-07-22T10:00:00.000Z',
            classification: 'direct',
          },
        ],
        cursor: { page: cursor.page + 1 },
        manifest: { fetched: 1, changed: 1 },
      }),
    }],
  });

  assert.equal(result.run.status, 'completed');
  assert.deepEqual(result.run.counts, {
    fetched: 1,
    changed: 1,
    observations: 1,
    duplicates: 0,
    failed: 0,
  });
  assert.deepEqual(result.telemetry.sources.greenhouse, {
    status: 'succeeded', attempts: 1, fetched: 1, observations: 1, changed: 1, duplicates: 0,
    startingCursor: { page: 3 }, continuationCursor: null, naturalTerminal: true, interrupted: false, truncated: false,
    newestPostingAt: '2026-07-22T10:00:00.000Z', boardPlan: null, sourcePlanState: null,
    cursorReset: false, cursorContinued: false,
    consecutiveZeroNewRuns: 0, capHit: null, recordsNotExamined: null,
  });
  assert.equal(result.stages.fetch.status, 'committed');
  assert.equal(result.stages.commit.status, 'committed');

  const state = readCrawlerState(store);
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.sources.length, 1);
  assert.equal(state.sources[0].cursor, null);
  assert.equal(state.sources[0].scan.scanStatus, 'completed');
  assert.equal(state.companies.length, 1);
  assert.equal(state.companies[0].name, 'example');
  assert.equal(state.companyBoards.length, 1);
  assert.equal(state.companyBoards[0].provider, 'greenhouse');
  assert.equal(state.jobs.length, 1);
  assert.equal(state.observations.length, 1);
  assert.equal(state.failures.length, 0);
  store.close();
});

test('a source manifest telemetry block survives crawlRun SQLite persistence', async () => {
  const databasePath = tempDatabase();
  const store = openCrawlerStore(databasePath);
  const workdayDetail = { attempted: 2, succeeded: 1 };
  const sourcePlans = [{
    id: 'ats-enterprise',
    lane: 'ats-expanded',
    fetch: async () => ({
      observations: [],
      manifest: { fetched: 0, changed: 0, telemetry: { workdayDetail } },
    }),
  }];

  const result = await crawlRun({ store, runId: 'telemetry-persistence', sourcePlans, clock: fixedClock() });
  assert.deepEqual(result.telemetry.sources['ats-enterprise'].detail.telemetry.workdayDetail, workdayDetail);
  store.close();

  const reopened = openCrawlerStore(databasePath);
  const persisted = await crawlRun({ store: reopened, runId: 'telemetry-persistence', sourcePlans, clock: fixedClock() });
  assert.deepEqual(persisted.telemetry.sources['ats-enterprise'].detail.telemetry.workdayDetail, workdayDetail);
  assert.deepEqual(
    JSON.parse(reopened.prepare('SELECT details_json FROM source_telemetry WHERE run_id = ? AND source_id = ?').get('telemetry-persistence', 'ats-enterprise').details_json).detail.telemetry.workdayDetail,
    workdayDetail,
  );
  reopened.close();
});

test('snapshot history is fail-closed for missing times and contradictory stored success evidence after reopen', async (t) => {
  for (const scenario of [
    { name: 'missing attempt time', sql: 'UPDATE source_attempts SET finished_at = NULL' },
    { name: 'invalid attempt time', sql: "UPDATE source_attempts SET finished_at = 'unknown'" },
    { name: 'missing attempt', sql: 'DELETE FROM source_attempts' },
    { name: 'latest failed attempt', sql: "UPDATE source_attempts SET status = 'failed'" },
    { name: 'attempt error', sql: "UPDATE source_attempts SET error = 'transport failed'" },
    { name: 'source error', sql: "UPDATE source_telemetry SET error = 'transport failed'" },
    { name: 'nested errors', details: { detail: { errors: ['transport failed'] } } },
    { name: 'nested failed count', details: { detail: { telemetry: { failed: 1 } } } },
    { name: 'interrupted details', details: { interrupted: true } },
    { name: 'unfinished scan', details: { naturalTerminal: false } },
  ]) await t.test(scenario.name, async () => {
    const databasePath = tempDatabase();
    let store = openCrawlerStore(databasePath);
    try {
      for (const [runId, at] of [
        ['history-first', '2026-07-23T06:00:00.000Z'],
        ['history-second', '2026-07-23T08:00:00.000Z'],
        ['history-third', '2026-07-23T10:00:00.000Z'],
      ]) await crawlRun({ store, runId, clock: { now: () => at },
        sourcePlans: [{ id: 'snapshot-source', fetch: async () => ({ observations: [] }) }],
      });
      if (scenario.sql) store.exec(scenario.sql);
      else store.prepare('UPDATE source_telemetry SET details_json = ?').run(JSON.stringify(scenario.details));
      store.close();
      store = openCrawlerStore(databasePath);
      assert.deepEqual(readLastSuccessfulSourceRuns(store, { excludeRunId: 'history-third' }), {});
    } finally { store.close(); }
  });
});

test('checkpoint persistence is idempotent, merges manifests, and final replay is not retained twice', async () => {
  const store = openCrawlerStore(':memory:');
  const observation = {
    providerJobId: 'checkpoint-1', canonicalUrl: 'https://jobs.example.test/checkpoint-1',
    title: 'AI Engineer', company: 'Example', location: 'Pune',
  };
  try {
    const result = await crawlRun({
      store,
      runId: 'checkpoint-idempotent',
      sourcePlans: [{
        id: 'checkpoint-source', lane: 'test',
        fetch: async ({ checkpoint }) => {
          const first = checkpoint({ observations: [observation], cursor: { page: 1 }, manifestDelta: { telemetry: { first: 1 } } });
          const second = checkpoint({ observations: [observation], cursor: { page: 1 }, manifestDelta: { telemetry: { second: 2 } } });
          await Promise.all([first, second]);
          return { observations: [observation], cursor: { page: 1 }, manifest: { truncated: true, telemetry: { second: 2 } } };
        },
      }],
    });
    const source = result.telemetry.sources['checkpoint-source'];
    assert.equal(source.status, 'truncated');
    assert.equal(source.observations, 1);
    assert.equal(source.duplicates, 2);
    assert.deepEqual(source.continuationCursor, { page: 1 });
    assert.deepEqual(source.manifest.telemetry, { first: 1, second: 2 });
    assert.equal(readCrawlerState(store).observations.length, 1);
    assert.deepEqual(JSON.parse(store.prepare('SELECT cursor_json FROM sources WHERE source_id = ?').get('checkpoint-source').cursor_json).cursor, { page: 1 });
  } finally {
    store.close();
  }
});

test('portal resolution checkpoint replaces the candidate observation without row growth', async () => {
  const store = openCrawlerStore(':memory:');
  const sourceRecordKey = 'portal-candidate-1';
  const initial = {
    sourceRecordKey, canonicalUrl: 'https://www.indeed.com/viewjob?jk=portal-1',
    title: 'AI Engineer', company: 'Example', location: 'Pune', description: 'portal snippet', classification: 'lead',
  };
  const resolved = {
    ...initial, description: 'verified employer description', classification: 'direct',
    originalApplicationUrl: 'https://boards.greenhouse.io/example/jobs/1',
  };
  try {
    const result = await crawlRun({
      store, runId: 'portal-checkpoint-replacement', sourcePlans: [{
        id: 'portal-source', lane: 'portal',
        fetch: async ({ checkpoint }) => {
          await checkpoint({ observations: [initial], cursor: { nextIndex: 0 }, manifestDelta: { fetched: 1, changed: 1 } });
          await checkpoint({ observations: [resolved], cursor: { nextIndex: 1 }, replaceObservations: true, manifestDelta: { telemetry: { resolved: 1 } } });
          return { observations: [resolved], cursor: { nextIndex: 1 }, manifest: { fetched: 1, changed: 1, naturalTerminal: true } };
        },
      }],
    });
    const row = store.prepare('SELECT source_record_key, classification, raw_json FROM job_observations WHERE run_id = ?').get('portal-checkpoint-replacement');
    const source = result.telemetry.sources['portal-source'];
    assert.equal(store.prepare('SELECT COUNT(*) AS count FROM job_observations WHERE run_id = ?').get('portal-checkpoint-replacement').count, 1);
    assert.equal(row.source_record_key, sourceRecordKey);
    assert.equal(row.classification, 'direct');
    assert.equal(JSON.parse(row.raw_json).description, resolved.description);
    assert.equal(source.observations, 1);
    assert.equal(source.fetched, 1);

    const replay = await crawlRun({ store, runId: 'portal-checkpoint-replacement', sourcePlans: [] });
    assert.equal(replay.idempotent, true);
    assert.equal(store.prepare('SELECT COUNT(*) AS count FROM job_observations WHERE run_id = ?').get('portal-checkpoint-replacement').count, 1);
  } finally {
    store.close();
  }
});

test('cancellation after a checkpoint keeps the cursor and the next run replays from it', async () => {
  const store = openCrawlerStore(':memory:');
  const controller = new AbortController();
  const sourceStarted = deferred();
  const sourceCompletion = deferred();
  const observation = {
    providerJobId: 'checkpoint-cancelled', canonicalUrl: 'https://jobs.example.test/checkpoint-cancelled',
    title: 'AI Engineer', company: 'Example', location: 'Pune',
  };
  let lateCheckpoint;
  let nextCursor = null;
  try {
    const cancelled = crawlRun({
      store,
      runId: 'checkpoint-cancelled',
      signal: controller.signal,
      sourcePlans: [{
        id: 'checkpoint-cancel-source', lane: 'test',
        fetch: async ({ checkpoint }) => {
          lateCheckpoint = checkpoint;
          await checkpoint({ observations: [observation], cursor: { page: 4 }, manifestDelta: { fetched: 1 } });
          sourceStarted.resolve();
          return sourceCompletion.promise;
        },
      }],
    });
    await sourceStarted.promise;
    controller.abort(new Error('operator cancelled'));
    await assert.rejects(cancelled, (error) => error.code === 'RUN_ABORTED');
    assert.equal(readCrawlerState(store).observations.length, 1);
    assert.deepEqual(JSON.parse(store.prepare('SELECT cursor_json FROM sources WHERE source_id = ?').get('checkpoint-cancel-source').cursor_json).cursor, { page: 4 });
    await lateCheckpoint({ observations: [{ providerJobId: 'late', canonicalUrl: 'https://jobs.example.test/late' }], cursor: { page: 99 }, manifestDelta: { late: true } });
    assert.equal(readCrawlerState(store).observations.length, 1);
    assert.deepEqual(JSON.parse(store.prepare('SELECT cursor_json FROM sources WHERE source_id = ?').get('checkpoint-cancel-source').cursor_json).cursor, { page: 4 });
    sourceCompletion.resolve({ observations: [], manifest: {} });

    const resumed = await crawlRun({
      store,
      runId: 'checkpoint-resumed',
      sourcePlans: [{
        id: 'checkpoint-cancel-source', lane: 'test',
        fetch: async ({ cursor }) => {
          nextCursor = cursor;
          return { observations: [], manifest: {} };
        },
      }],
    });
    assert.equal(resumed.run.status, 'completed');
    assert.deepEqual(nextCursor, { page: 4 });
    assert.equal(readCrawlerState(store).observations.length, 1);
  } finally {
    store.close();
  }
});

test('adapter truncation preserves its capHit when runtime budget did not abort it', async () => {
  const store = openCrawlerStore(':memory:');
  try {
    const result = await crawlRun({
      store,
      runId: 'adapter-cap-hit',
      config: { execution: {
        wholeRunDeadlineMs: 100, discoveryBudgetMs: 50, downstreamReserveMs: 25,
        handoffReserveMs: 25, scorerFloorMs: 25, perSourceMaxDurationMs: 50,
        minimumSourceStartAllocationMs: 10,
      } },
      sourcePlans: [{
        id: 'page-capped', lane: 'test',
        fetch: async () => ({ observations: [], cursor: { page: 2 }, manifest: { truncated: true, capHit: 'maxPages' } }),
      }],
    });
    assert.equal(result.telemetry.sources['page-capped'].status, 'truncated');
    assert.equal(result.telemetry.sources['page-capped'].capHit, 'maxPages');
    assert.equal(result.telemetry.sources['page-capped'].budgetCancellationFired, undefined);
  } finally {
    store.close();
  }
});

test('invalid cursor or manifest output fails source and attempt terminally', async () => {
  for (const [name, output] of [
    ['cyclic-cursor', (() => { const cursor = {}; cursor.self = cursor; return { observations: [], cursor, manifest: {} }; })()],
    ['bigint-manifest', { observations: [], manifest: { fetched: 1n } }],
  ]) {
    const store = openCrawlerStore(':memory:');
    try {
      const result = await crawlRun({
        store, runId: `invalid-${name}`,
        sourcePlans: [{ id: name, lane: 'test', fetch: async () => output }],
      });
      assert.equal(result.telemetry.sources[name].status, 'failed');
      assert.equal(result.sourceAttempts.find((attempt) => attempt.sourceId === name).status, 'failed');
      assert.equal(store.prepare('SELECT status FROM source_attempts WHERE run_id = ? AND source_id = ?').get(`invalid-${name}`, name).status, 'failed');
    } finally {
      store.close();
    }
  }
});

test('runtime omissions are partial, resumable, and visible in workflow coverage', async () => {
  const store = openCrawlerStore(':memory:');
  let monotonic = 0;
  const clock = {
    now: () => '2026-07-23T10:00:00.000Z',
    monotonicNow: () => monotonic,
  };
  try {
    const result = await crawlWorkflow({
      store,
      runId: 'workflow-runtime-omission',
      clock,
      config: { execution: {
        wholeRunDeadlineMs: 100, discoveryBudgetMs: 20, downstreamReserveMs: 40,
        handoffReserveMs: 40, scorerFloorMs: 40, perSourceMaxDurationMs: 50,
        minimumSourceStartAllocationMs: 10,
      } },
      sourcePlans: [
        { id: 'first-source', lane: 'test', fetch: async () => { monotonic += 20; return {}; } },
        { id: 'omitted-source', lane: 'test', fetch: async () => { throw new Error('must not start'); } },
      ],
    });
    assert.equal(result.run.status, 'partial');
    assert.equal(result.terminalEnvelope.status, 'partial');
    assert.equal(result.terminalEnvelope.sourceCoverage.not_started.includes('omitted-source'), true);
    assert.equal(result.terminalEnvelope.lastDurableSourceState.not_started.includes('omitted-source'), true);
  } finally {
    store.close();
  }
});

test('a resumed run requeues runtime omissions and completes the planned sources', async () => {
  const store = openCrawlerStore(':memory:');
  const config = { execution: {
    wholeRunDeadlineMs: 100,
    discoveryBudgetMs: 40,
    downstreamReserveMs: 30,
    handoffReserveMs: 30,
    scorerFloorMs: 30,
    perSourceMaxDurationMs: 100,
    minimumSourceStartAllocationMs: 10,
  } };
  const makeClock = () => {
    let current = 0;
    return {
      now: () => new Date(Date.UTC(2026, 6, 23, 1, 0, 0, current)).toISOString(),
      monotonicNow: () => current,
      advance: (milliseconds) => { current += milliseconds; },
    };
  };

  try {
    const firstClock = makeClock();
    const first = await crawlRun({
      store,
      runId: 'runtime-omission-resume',
      clock: firstClock,
      config,
      sourcePlans: [
        { id: 'first-source', lane: 'test', fetch: async () => { firstClock.advance(40); return {}; } },
        { id: 'omitted-source', lane: 'test', fetch: async () => ({}) },
      ],
    });

    assert.equal(first.run.status, 'partial');
    assert.equal(first.telemetry.sources['omitted-source'].status, 'omitted_by_runtime');
    assert.deepEqual(first.attempts.map((attempt) => attempt.status), ['partial']);

    const second = await crawlRun({
      store,
      runId: 'runtime-omission-resume',
      clock: makeClock(),
      config,
      sourcePlans: [
        { id: 'first-source', lane: 'test', fetch: async () => { throw new Error('succeeded source must not rerun'); } },
        { id: 'omitted-source', lane: 'test', fetch: async () => ({}) },
      ],
    });

    assert.equal(second.run.status, 'completed');
    assert.equal(second.run.telemetry.resumable, false);
    assert.equal(second.telemetry.sources['omitted-source'].status, 'succeeded');
    assert.deepEqual(second.attempts.map((attempt) => attempt.status), ['partial', 'completed']);
  } finally {
    store.close();
  }
});

test('JSON cursor and manifest keys round-trip without changing Object.prototype', async () => {
  const store = openCrawlerStore(':memory:');
  const cursor = JSON.parse('{"__proto__":{"cursor":true},"constructor":"cursor-constructor","prototype":{"cursor":1}}');
  const manifest = JSON.parse('{"__proto__":{"manifest":true},"constructor":"manifest-constructor","prototype":{"manifest":1}}');
  const finalManifest = { ...manifest, truncated: true };
  const objectPrototypeKeys = Object.getOwnPropertyNames(Object.prototype);

  try {
    const result = await crawlRun({
      store,
      runId: 'json-dangerous-keys',
      sourcePlans: [{
        id: 'json-source',
        lane: 'test',
        fetch: async ({ checkpoint }) => {
          await checkpoint({ cursor, manifestDelta: manifest });
          return { cursor, manifest: finalManifest };
        },
      }],
    });
    const sourceRow = store.prepare('SELECT cursor_json FROM sources WHERE source_id = ?').get('json-source');
    const telemetryRow = store.prepare('SELECT details_json FROM source_telemetry WHERE run_id = ? AND source_id = ?').get('json-dangerous-keys', 'json-source');
    const storedCursor = JSON.parse(sourceRow.cursor_json).cursor;
    const storedDetails = JSON.parse(telemetryRow.details_json);

    assert.deepEqual(storedCursor, cursor);
    assert.deepEqual(storedDetails.manifest, finalManifest);
    assert.deepEqual(result.telemetry.sources['json-source'].manifest, finalManifest);
    assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), objectPrototypeKeys);
    assert.equal(Object.prototype.cursor, undefined);
    assert.equal(Object.prototype.manifest, undefined);
    assert.deepEqual(cloneJsonSafe(cursor), cursor);
  } finally {
    store.close();
  }
});

test('a crawl run stops before starting a source after its absolute deadline', async () => {
  const store = openCrawlerStore(tempDatabase());
  let calls = 0;
  try {
    const result = await crawlRun({
      store,
      runId: 'run-absolute-deadline',
      clock: fixedClock(),
      // fixedClock ticks a minute per call: startCrawlRun takes 01:00 and
      // crawlRun's own nowFrom takes 01:01, so the first source is checked at
      // 01:02. Sit the deadline just past that so source one runs and source
      // two is skipped.
      deadline: { deadlineMs: Date.parse('2026-07-23T01:02:00.500Z'), remainingMs: 60_000 },
      sourcePlans: [{
        id: 'completed-source',
        lane: 'ats',
        fetch: async () => ({ observations: [], manifest: { fetched: 0, changed: 0 } }),
      }, {
        id: 'deadline-source',
        lane: 'ats',
        fetch: async () => {
          calls += 1;
          return { observations: [], manifest: { fetched: 0, changed: 0 } };
        },
      }],
    });
    assert.equal(calls, 0);
    assert.equal(result.telemetry.sources['completed-source'].status, 'succeeded');
  } finally {
    store.close();
  }
});

test('an aborted crawl run still fails with the daily deadline error', async () => {
  const store = openCrawlerStore(tempDatabase());
  const controller = new AbortController();
  controller.abort(new Error('crawler source deadline exceeded'));
  try {
    await assert.rejects(() => crawlRun({
      store,
      runId: 'run-aborted',
      clock: fixedClock(),
      signal: controller.signal,
      sourcePlans: [{
        id: 'aborted-source',
        lane: 'ats',
        fetch: async () => ({ observations: [], manifest: { fetched: 0, changed: 0 } }),
      }],
    }), (error) => error.code === 'DAILY_DEADLINE_EXCEEDED');
  } finally {
    store.close();
  }
});

test('retryable source failures retry deterministically and remain observable without failing the run', async () => {
  const store = openCrawlerStore(tempDatabase());
  const attempts = [];
  const result = await crawlRun({
    store,
    runId: 'run-retry',
    sourcePlans: [{
      id: 'flaky',
      lane: 'board',
      fetch: async ({ attempt }) => {
        attempts.push(attempt);
        if (attempt < 3) {
          const error = new Error('temporary upstream outage');
          error.retryable = true;
          throw error;
        }
        return { observations: [], manifest: { fetched: 0, changed: 0 } };
      },
    }],
    config: { retry: { maxAttempts: 3, baseDelayMs: 10 } },
    clock: fixedClock(),
  });

  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(result.run.status, 'completed');
  assert.equal(result.telemetry.sources.flaky.attempts, 3);
  assert.equal(readCrawlerState(store).failures.length, 0);
  store.close();
});

test('terminal source failures are recorded and rerunning the same idempotency key does not fetch again', async () => {
  const store = openCrawlerStore(tempDatabase());
  let calls = 0;
  const sourcePlans = [{
    id: 'broken',
    lane: 'ats',
    fetch: async () => {
      calls += 1;
      const error = new Error('invalid board');
      error.retryable = false;
      throw error;
    },
  }];

  const first = await crawlRun({
    store,
    runId: 'run-idempotent',
    sourcePlans,
    config: { retry: { maxAttempts: 4 } },
    clock: fixedClock(),
  });
  const second = await crawlRun({
    store,
    runId: 'run-idempotent',
    sourcePlans,
    config: { retry: { maxAttempts: 4 } },
    clock: fixedClock(),
  });

  assert.equal(first.run.status, 'completed_with_failures');
  assert.equal(second.idempotent, true);
  assert.equal(calls, 1);
  assert.equal(readCrawlerState(store).failures.length, 1);
  store.close();
});

test('opens and expands a version-1 jobs table without losing existing rows', () => {
  const databasePath = tempDatabase();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE jobs (
      job_key TEXT PRIMARY KEY,
      provider TEXT,
      provider_job_id TEXT,
      canonical_url TEXT,
      company TEXT,
      title TEXT,
      location TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      latest_fingerprint TEXT
    );
    INSERT INTO jobs VALUES (
      'legacy-job', 'greenhouse', 'legacy-1', 'https://jobs.example.test/legacy-1',
      'legacy co', 'ai engineer', 'pune', '2026-07-20T00:00:00Z',
      '2026-07-20T00:00:00Z', 'fingerprint'
    );
  `);
  legacy.close();

  const store = openCrawlerStore(databasePath);
  const state = readCrawlerState(store);
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].jobKey, 'legacy-job');
  const columns = new Set(store.prepare('PRAGMA table_info(jobs)').all().map((row) => row.name));
  for (const name of ['company_key', 'original_posted_at', 'latest_updated_at', 'inferred_repost_at', 'closed_at']) assert.ok(columns.has(name));
  const indexes = store.prepare('PRAGMA index_list(job_observations)').all().map((row) => row.name);
  assert.ok(indexes.includes('idx_job_observations_job_dated_latest'));
  const plan = store.prepare(`EXPLAIN QUERY PLAN
    UPDATE jobs
    SET original_posted_at = (
      SELECT posted_at FROM job_observations
      WHERE job_observations.job_key = jobs.job_key AND posted_at IS NOT NULL
      ORDER BY observed_at DESC LIMIT 1
    )
    WHERE original_posted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM job_observations
        WHERE job_observations.job_key = jobs.job_key AND posted_at IS NOT NULL
      )`).all();
  assert.ok(plan.some((row) => String(row.detail).includes('USING COVERING INDEX idx_job_observations_job_dated_latest')));
  store.close();
});

test('a later dated observation fills a job that was first observed undated', async () => {
  const store = openCrawlerStore(tempDatabase());
  let postedAt = null;
  const sourcePlans = [{
    id: 'freshness-fill', lane: 'ats',
    fetch: async () => ({ observations: [{ providerJobId: 'late-date', canonicalUrl: 'https://jobs.example.test/late-date', title: 'AI Engineer', company: 'Example', location: 'Pune', postedAt }], manifest: { fetched: 1, changed: 1 } }),
  }];

  await crawlRun({ store, runId: 'undated-1', sourcePlans, clock: fixedClock() });
  postedAt = '2026-07-22T08:00:00Z';
  await crawlRun({ store, runId: 'undated-2', sourcePlans, clock: fixedClock() });

  assert.equal(store.prepare('SELECT original_posted_at FROM jobs WHERE provider_job_id = ?').get('late-date').original_posted_at, postedAt);
  store.close();
});

test('crawlRun receipt reports jobs newly dated by backfill', async () => {
  const store = openCrawlerStore(tempDatabase());
  const sourcePlans = [{
    id: 'receipt-freshness-fill', lane: 'ats',
    fetch: async () => ({ observations: [{ providerJobId: 'receipt-late-date', canonicalUrl: 'https://jobs.example.test/receipt-late-date', title: 'AI Engineer', company: 'Example', location: 'Pune', postedAt: null }], manifest: { fetched: 1, changed: 1 } }),
  }];

  const first = await crawlRun({ store, runId: 'receipt-undated-1', sourcePlans, clock: fixedClock() });
  store.prepare('UPDATE job_observations SET posted_at = ?, observed_at = ? WHERE job_key = (SELECT job_key FROM jobs WHERE provider_job_id = ?)').run('2026-07-22T08:00:00Z', '2026-07-23T02:00:00Z', 'receipt-late-date');
  const second = await crawlRun({ store, runId: 'receipt-undated-2', sourcePlans: [], clock: fixedClock() });

  assert.equal(first.newlyDated, 0);
  assert.equal(second.newlyDated, 1);
  store.close();
});

test('crawlRun receipt reports jobs dated by an observation persisted during the run', async () => {
  const store = openCrawlerStore(tempDatabase());
  let postedAt = null;
  const sourcePlans = [{
    id: 'receipt-in-run-fill', lane: 'ats',
    fetch: async () => ({ observations: [{ providerJobId: 'receipt-in-run-date', canonicalUrl: 'https://jobs.example.test/receipt-in-run-date', title: 'AI Engineer', company: 'Example', location: 'Pune', postedAt }], manifest: { fetched: 1, changed: 1 } }),
  }];

  await crawlRun({ store, runId: 'receipt-in-run-1', sourcePlans, clock: fixedClock() });
  postedAt = '2026-07-22T08:00:00Z';
  const second = await crawlRun({ store, runId: 'receipt-in-run-2', sourcePlans, clock: fixedClock() });

  assert.equal(second.newlyDated, 1);
  assert.equal(store.prepare('SELECT original_posted_at FROM jobs WHERE provider_job_id = ?').get('receipt-in-run-date').original_posted_at, postedAt);
  store.close();
});

test('a truncated board source health reports its persisted continuation cursor', async () => {
  const store = openCrawlerStore(tempDatabase());
  const continuationCursor = { __cursor: { Acme: { endpointUrl: 'https://jobs.example.test/acme', page: 2 } } };
  const result = await crawlWorkflow({
    store,
    runId: 'source-health-continuation',
    clock: fixedClock(),
    sourcePlans: [{
      id: 'ats-enterprise',
      lane: 'ats-expanded',
      fetch: async () => ({
        observations: [],
        cursor: continuationCursor,
        manifest: {
          fetched: 1,
          changed: 1,
          naturalTerminal: false,
          truncated: true,
          capHit: 'maxPages',
          recordsNotExamined: 2,
          sources: [{
            board: 'Acme',
            provider: 'workday',
            status: 'ok',
            startingCursor: null,
            naturalTerminal: false,
            truncated: true,
            capHit: 'maxPages',
            recordsNotExamined: 2,
          }],
        },
      }),
    }],
  });

  assert.deepEqual(result.funnel.sourceHealth['ats-enterprise'].cursor, continuationCursor);
  assert.deepEqual(result.funnel.sourceHealth['ats-enterprise'].boards[0].cursor, continuationCursor.__cursor.Acme);
  assert.equal(result.funnel.sourceHealth['ats-enterprise'].boards[0].naturalTerminal, false);
  assert.equal(result.funnel.sourceHealth['ats-enterprise'].boards[0].truncated, true);
  assert.deepEqual(JSON.parse(store.prepare('SELECT cursor_json FROM sources WHERE source_id = ?').get('ats-enterprise').cursor_json).cursor, continuationCursor);
  store.close();
});

test('a recorded original posted date is immutable across later observations', async () => {
  const store = openCrawlerStore(tempDatabase());
  let postedAt = '2026-07-20T08:00:00Z';
  const sourcePlans = [{
    id: 'freshness-immutable', lane: 'ats',
    fetch: async () => ({ observations: [{ providerJobId: 'immutable-date', canonicalUrl: 'https://jobs.example.test/immutable-date', title: 'AI Engineer', company: 'Example', location: 'Pune', postedAt }], manifest: { fetched: 1, changed: 1 } }),
  }];

  await crawlRun({ store, runId: 'immutable-1', sourcePlans, clock: fixedClock() });
  postedAt = '2026-07-23T08:00:00Z';
  await crawlRun({ store, runId: 'immutable-2', sourcePlans, clock: fixedClock() });

  assert.equal(store.prepare('SELECT original_posted_at FROM jobs WHERE provider_job_id = ?').get('immutable-date').original_posted_at, '2026-07-20T08:00:00Z');
  store.close();
});

test('backfill fills only null dates and is idempotent across consecutive invocations', async () => {
  const store = openCrawlerStore(tempDatabase());
  const sourcePlans = [{
    id: 'backfill-source', lane: 'ats',
    fetch: async () => ({ observations: [
      { providerJobId: 'backfill-null', canonicalUrl: 'https://jobs.example.test/backfill-null', title: 'AI Engineer', company: 'Example', location: 'Pune', postedAt: null },
      { providerJobId: 'backfill-recorded', canonicalUrl: 'https://jobs.example.test/backfill-recorded', title: 'Backend Engineer', company: 'Example', location: 'Pune', postedAt: '2026-07-20T08:00:00Z' },
    ], manifest: { fetched: 2, changed: 2 } }),
  }];
  await crawlRun({ store, runId: 'backfill-seed', sourcePlans, clock: fixedClock() });
  store.prepare('UPDATE job_observations SET posted_at = ?, observed_at = ? WHERE job_key = (SELECT job_key FROM jobs WHERE provider_job_id = ?)').run('2026-07-22T08:00:00Z', '2026-07-23T02:00:00Z', 'backfill-null');

  assert.equal(backfillOriginalPostedAt(store), 1);
  const rows = store.prepare('SELECT provider_job_id, original_posted_at FROM jobs ORDER BY provider_job_id').all();
  assert.deepEqual(rows.map((row) => [row.provider_job_id, row.original_posted_at]), [
    ['backfill-null', '2026-07-22T08:00:00Z'],
    ['backfill-recorded', '2026-07-20T08:00:00Z'],
  ]);
  assert.equal(backfillOriginalPostedAt(store), 0);
  store.close();
});

test('a per-board job cap persists a Workday cursor and the next run resumes with different jobs', async () => {
  const listUrl = 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs';
  const postings = Array.from({ length: 4 }, (_, index) => ({ jobReqId: `WD-${index + 1}`, title: `AI Engineer ${index + 1}`, externalPath: `/job/ai-${index + 1}`, postedOn: '2026-07-22' }));
  const offsets = [];
  const transport = async (url, options) => {
    const { offset } = JSON.parse(options.body);
    offsets.push(offset);
    return { status: 200, headers: {}, body: JSON.stringify({ total: postings.length, jobPostings: postings.slice(offset, offset + 2) }) };
  };

  const first = await discoverEnterpriseAts({ boards: [{ provider: 'workday', company: 'Acme', url: listUrl }], transport, maxPages: 2, maxJobsPerBoard: 1, runAt: enterpriseRunAt });
  const second = await discoverEnterpriseAts({ boards: [{ provider: 'workday', company: 'Acme', url: listUrl }], transport, conditionalState: first.conditionalState, maxPages: 2, maxJobsPerBoard: 1, runAt: enterpriseRunAt });

  assert.deepEqual(offsets, [0, 2]);
  assert.deepEqual(first.conditionalState.__cursor.Acme, { endpointUrl: listUrl, page: 1, workdayReceived: 2 });
  assert.notEqual(first.observations[0].providerJobId, second.observations[0].providerJobId);
});

test('a page-capped Workday board persists its continuation cursor', async () => {
  const listUrl = 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs';
  const result = await discoverEnterpriseAts({
    boards: [{ provider: 'workday', company: 'Acme', url: listUrl }],
    transport: async () => ({ status: 200, headers: {}, body: JSON.stringify({ total: 4, jobPostings: [
      { jobReqId: 'WD-1', title: 'AI Engineer 1', externalPath: '/job/ai-1', postedOn: '2026-07-22' },
      { jobReqId: 'WD-2', title: 'AI Engineer 2', externalPath: '/job/ai-2', postedOn: '2026-07-22' },
    ] }) }),
    maxPages: 1, maxJobsPerBoard: 100, runAt: enterpriseRunAt,
  });

  assert.equal(result.manifests[0].capHit, 'maxPages');
  assert.deepEqual(result.conditionalState.__cursor.Acme, { endpointUrl: listUrl, page: 1, workdayReceived: 2 });
});

test('completed newest-first scans reset their next scheduled run to the front', async () => {
  const store = openCrawlerStore(tempDatabase());
  const cursors = [];
  const sourcePlans = [{
    id: 'newest-first', lane: 'ats', capabilities: { newestFirst: true },
    fetch: async ({ cursor }) => {
      cursors.push(cursor);
      const front = cursor == null;
      return {
        observations: [{ providerJobId: front ? 'front-2' : 'old-1', canonicalUrl: `https://jobs.example.test/${front ? 'front-2' : 'old-1'}`, title: front ? 'New AI Engineer' : 'Old AI Engineer', company: 'Example', location: 'Pune', postedAt: front ? '2026-07-24T08:00:00Z' : '2026-07-20T08:00:00Z' }],
        cursor: { page: front ? 1 : 40 },
        manifest: { fetched: 1, changed: 1, naturalTerminal: true, newestPostingAt: front ? '2026-07-24T08:00:00Z' : '2026-07-20T08:00:00Z' },
      };
    },
  }];

  await crawlRun({ store, runId: 'scheduled-1', schedule: 'morning', sourcePlans, clock: fixedClock() });
  const second = await crawlRun({ store, runId: 'scheduled-2', schedule: 'morning', sourcePlans, clock: fixedClock() });

  assert.deepEqual(cursors, [null, null]);
  assert.equal(second.telemetry.sources['newest-first'].cursorReset, true);
  assert.equal(second.telemetry.sources['newest-first'].newestPostingAt, '2026-07-24T08:00:00Z');
  assert.equal(readCrawlerState(store).observations.length, 2);
  store.close();
});

test('interrupted newest-first scans continue from their saved cursor without replaying completed pages', async () => {
  const store = openCrawlerStore(tempDatabase());
  const cursors = [];
  let invocation = 0;
  const sourcePlans = [{
    id: 'interrupted-source', lane: 'ats', capabilities: { newestFirst: true },
    fetch: async ({ cursor }) => {
      invocation += 1; cursors.push(cursor);
      if (invocation === 1) return {
        observations: [{ providerJobId: 'page-0', canonicalUrl: 'https://jobs.example.test/page-0', title: 'Page Zero', company: 'Example', location: 'Pune' }],
        cursor: { page: 1 }, manifest: { fetched: 1, changed: 1, interrupted: true, naturalTerminal: false },
      };
      assert.deepEqual(cursor, { page: 1 });
      return {
        observations: [{ providerJobId: 'page-1', canonicalUrl: 'https://jobs.example.test/page-1', title: 'Page One', company: 'Example', location: 'Pune' }],
        cursor: { page: 2 }, manifest: { fetched: 1, changed: 1, naturalTerminal: true },
      };
    },
  }];

  const first = await crawlRun({ store, runId: 'interrupted-1', sourcePlans, clock: fixedClock() });
  const second = await crawlRun({ store, runId: 'interrupted-2', sourcePlans, clock: fixedClock() });

  assert.equal(first.telemetry.sources['interrupted-source'].status, 'interrupted');
  assert.equal(second.telemetry.sources['interrupted-source'].cursorContinued, true);
  assert.deepEqual(cursors, [null, { page: 1 }]);
  assert.equal(readCrawlerState(store).observations.length, 2);
  store.close();
});

test('a naturally exhausted Workday board is terminal and clears its cursor', async () => {
  const listUrl = 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs';
  const result = await discoverEnterpriseAts({
    boards: [{ provider: 'workday', company: 'Acme', url: listUrl }],
    conditionalState: { __cursor: { Acme: { endpointUrl: listUrl, page: 1, workdayReceived: 0 } } },
    transport: async () => ({ status: 200, headers: {}, body: JSON.stringify({ total: 1, jobPostings: [{ jobReqId: 'WD-1', title: 'AI Engineer', externalPath: '/job/ai-1', postedOn: '2026-07-22' }] }) }),
    maxPages: 2, maxJobsPerBoard: 100, runAt: enterpriseRunAt,
  });

  assert.equal(result.manifests[0].naturalTerminal, true);
  assert.equal(result.manifest.naturalTerminal, true);
  assert.equal(result.conditionalState.__cursor?.Acme, undefined);
});
