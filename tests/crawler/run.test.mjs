import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  openCrawlerStore,
  crawlRun,
  readCrawlerState,
} from '../../crawler/run.mjs';

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
    status: 'succeeded',
    attempts: 1,
    fetched: 1,
    observations: 1,
    changed: 1,
    duplicates: 0,
  });
  assert.equal(result.stages.fetch.status, 'committed');
  assert.equal(result.stages.commit.status, 'committed');

  const state = readCrawlerState(store);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.sources.length, 1);
  assert.deepEqual(state.sources[0].cursor, { page: 4 });
  assert.equal(state.companies.length, 1);
  assert.equal(state.companies[0].name, 'example');
  assert.equal(state.companyBoards.length, 1);
  assert.equal(state.companyBoards[0].provider, 'greenhouse');
  assert.equal(state.jobs.length, 1);
  assert.equal(state.observations.length, 1);
  assert.equal(state.failures.length, 0);
  store.close();
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
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].jobKey, 'legacy-job');
  const columns = new Set(store.prepare('PRAGMA table_info(jobs)').all().map((row) => row.name));
  for (const name of ['company_key', 'original_posted_at', 'latest_updated_at', 'inferred_repost_at', 'closed_at']) assert.ok(columns.has(name));
  store.close();
});
