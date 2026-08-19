import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCrawlerStore } from '../../crawler/run.mjs';
import { rebuildProductionDb } from '../../crawler/rebuild-production-db.mjs';

const SCRIPT_PATH = path.resolve('crawler/rebuild-production-db.mjs');

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'launchpad-rebuild-'));
  const sourcePath = path.join(directory, 'source.sqlite');
  const destinationPath = path.join(directory, 'destination.sqlite');
  const db = openCrawlerStore(sourcePath);

  for (const source of [
    ['source-trusted', 'ats', 'direct'],
    ['source-noisy', 'search', 'lead'],
    ['source-other', 'ats', 'direct'],
  ]) {
    db.prepare(`INSERT INTO sources(source_id, lane, trust_class, capabilities_json, rate_policy_json, updated_at)
      VALUES (?, ?, ?, '{}', '{}', ?)`).run(...source, '2026-07-24T08:00:00.000Z');
  }
  for (const company of [
    ['company-shared', 'Shared Co'],
    ['company-trusted', 'Trusted Co'],
    ['company-noisy', 'Noisy Co'],
    ['company-other', 'Other Co'],
  ]) {
    db.prepare(`INSERT INTO companies(company_key, name, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?)`).run(...company, '2026-07-24T08:00:00.000Z', '2026-07-24T08:00:00.000Z');
  }
  for (const board of [
    ['board-shared', 'company-shared', 'source-trusted'],
    ['board-trusted', 'company-trusted', 'source-trusted'],
    ['board-noisy', 'company-noisy', 'source-noisy'],
    ['board-other', 'company-other', 'source-other'],
  ]) {
    db.prepare(`INSERT INTO company_boards(board_key, company_key, source_id, provider, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, 'fixture', ?, ?)`).run(...board, '2026-07-24T08:00:00.000Z', '2026-07-24T08:00:00.000Z');
  }
  for (const run of [
    ['trusted-run', 'morning'],
    ['noisy-run', 'manual'],
    ['other-run', 'manual'],
  ]) {
    db.prepare(`INSERT INTO crawl_runs(run_id, schedule, status, stage, started_at, counts_json, telemetry_json, config_json)
      VALUES (?, ?, 'completed', 'complete', ?, '{}', '{}', '{}')`).run(...run, `2026-07-24T0${run[0] === 'trusted-run' ? '1' : run[0] === 'noisy-run' ? '2' : '3'}:00:00.000Z`);
  }
  for (const stage of [
    ['trusted-run', 'fetch', 'committed'],
    ['trusted-run', 'commit', 'committed'],
    ['noisy-run', 'fetch', 'committed'],
    ['noisy-run', 'commit', 'committed'],
    ['other-run', 'fetch', 'committed'],
    ['other-run', 'commit', 'committed'],
  ]) {
    db.prepare(`INSERT INTO crawl_run_stages(run_id, stage, status, started_at, finished_at)
      VALUES (?, ?, ?, '2026-07-24T08:00:00.000Z', '2026-07-24T08:01:00.000Z')`).run(...stage);
  }
  for (const job of [
    ['job-shared', 'company-shared', 'Shared Role'],
    ['job-trusted', 'company-trusted', 'Trusted Role'],
    ['job-noisy', 'company-noisy', 'Noisy Role'],
    ['job-other', 'company-other', 'Other Role'],
  ]) {
    db.prepare(`INSERT INTO jobs(job_key, company_key, provider, provider_job_id, company, title, location, first_seen_at, last_seen_at)
      VALUES (?, ?, 'fixture', ?, ?, ?, 'Pune', ?, ?)`).run(
      job[0], job[1], job[0], job[1].replace('company-', ''), job[2],
      '2026-07-24T08:00:00.000Z', '2026-07-24T08:00:00.000Z',
    );
  }
  for (const observation of [
    ['obs-trusted-shared', 'job-shared', 'source-trusted', 'trusted-run', '2026-07-24T01:10:00.000Z'],
    ['obs-trusted-only', 'job-trusted', 'source-trusted', 'trusted-run', '2026-07-24T01:11:00.000Z'],
    ['obs-noisy-shared', 'job-shared', 'source-noisy', 'noisy-run', '2026-07-24T02:10:00.000Z'],
    ['obs-noisy-only', 'job-noisy', 'source-noisy', 'noisy-run', '2026-07-24T02:11:00.000Z'],
    ['obs-other-only', 'job-other', 'source-other', 'other-run', '2026-07-24T03:10:00.000Z'],
  ]) {
    db.prepare(`INSERT INTO job_observations(observation_key, job_key, source_id, run_id, source_record_key, observed_at, classification, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, 'direct', '{}')`).run(observation[0], observation[1], observation[2], observation[3], observation[0], observation[4]);
  }
  db.prepare(`INSERT INTO source_failures(run_id, source_id, stage, attempt, retry_class, message, created_at)
    VALUES ('trusted-run', 'source-trusted', 'fetch', 1, 'transient', 'trusted failure', '2026-07-24T01:12:00.000Z')`).run();
  db.prepare(`INSERT INTO source_failures(run_id, source_id, stage, attempt, retry_class, message, created_at)
    VALUES ('noisy-run', 'source-noisy', 'fetch', 1, 'transient', 'noisy failure', '2026-07-24T02:12:00.000Z')`).run();
  db.close();
  return { directory, sourcePath, destinationPath };
}

function withFixture(callback) {
  const paths = fixture();
  try { return callback(paths); }
  finally { fs.rmSync(paths.directory, { recursive: true, force: true }); }
}

function digest(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('copies only trusted observations and their reachable jobs, companies, and boards', () => withFixture(({ sourcePath, destinationPath }) => {
  const report = rebuildProductionDb({ sourcePath, destinationPath, trustedRunIds: ['trusted-run'] });
  assert.deepEqual(report.includedCounts, { jobs: 2, observations: 2, companies: 2, companyBoards: 2, crawlRuns: 1 });

  const db = new DatabaseSync(destinationPath, { readOnly: true });
  assert.deepEqual(db.prepare('SELECT job_key FROM jobs ORDER BY job_key').all().map((row) => row.job_key), ['job-shared', 'job-trusted']);
  assert.deepEqual(db.prepare('SELECT run_id FROM job_observations ORDER BY observation_key').all().map((row) => row.run_id), ['trusted-run', 'trusted-run']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM crawl_runs WHERE run_id = ?').get('noisy-run').count, 0);
  db.close();
}));

test('reports every excluded run with accurate observation counts and firstSeenAt, sorted by count', () => withFixture(({ sourcePath, destinationPath }) => {
  const report = rebuildProductionDb({ sourcePath, destinationPath, trustedRunIds: ['trusted-run'] });
  assert.deepEqual(report.excludedRunIds, [
    { runId: 'noisy-run', observationCount: 2, firstSeenAt: '2026-07-24T02:10:00.000Z' },
    { runId: 'other-run', observationCount: 1, firstSeenAt: '2026-07-24T03:10:00.000Z' },
  ]);
}));

test('opens the source read-only and leaves its checksum and row counts unchanged', () => withFixture(({ sourcePath, destinationPath }) => {
  const beforeDigest = digest(sourcePath);
  const beforeDb = new DatabaseSync(sourcePath, { readOnly: true });
  const counts = beforeDb.prepare(`SELECT
    (SELECT COUNT(*) FROM crawl_runs) AS runs,
    (SELECT COUNT(*) FROM jobs) AS jobs,
    (SELECT COUNT(*) FROM job_observations) AS observations`).get();
  beforeDb.close();

  rebuildProductionDb({ sourcePath, destinationPath, trustedRunIds: ['trusted-run'] });

  const afterDb = new DatabaseSync(sourcePath, { readOnly: true });
  assert.deepEqual(afterDb.prepare(`SELECT
    (SELECT COUNT(*) FROM crawl_runs) AS runs,
    (SELECT COUNT(*) FROM jobs) AS jobs,
    (SELECT COUNT(*) FROM job_observations) AS observations`).get(), counts);
  afterDb.close();
  assert.equal(digest(sourcePath), beforeDigest);
}));

test('includes a job observed by both trusted and excluded runs', () => withFixture(({ sourcePath, destinationPath }) => {
  rebuildProductionDb({ sourcePath, destinationPath, trustedRunIds: ['trusted-run'] });
  const db = new DatabaseSync(destinationPath, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE job_key = ?').get('job-shared').count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM job_observations WHERE job_key = ?').get('job-shared').count, 1);
  db.close();
}));

test('copies stages and source failures for trusted runs only', () => withFixture(({ sourcePath, destinationPath }) => {
  rebuildProductionDb({ sourcePath, destinationPath, trustedRunIds: ['trusted-run'] });
  const db = new DatabaseSync(destinationPath, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM crawl_run_stages WHERE run_id = ?').get('trusted-run').count, 2);
  assert.equal(db.prepare('SELECT message FROM source_failures WHERE run_id = ?').get('trusted-run').message, 'trusted failure');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM source_failures WHERE run_id = ?').get('noisy-run').count, 0);
  db.close();
}));

test('CLI rejects a missing trusted run id', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--source', '/tmp/source.sqlite', '--dest', '/tmp/destination.sqlite'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /at least one --trusted-run-id is required/);
});

test('CLI rejects missing source and destination paths', () => {
  const missingSource = spawnSync(process.execPath, [SCRIPT_PATH, '--dest', '/tmp/destination.sqlite', '--trusted-run-id', 'trusted-run'], { encoding: 'utf8' });
  const missingDestination = spawnSync(process.execPath, [SCRIPT_PATH, '--source', '/tmp/source.sqlite', '--trusted-run-id', 'trusted-run'], { encoding: 'utf8' });
  assert.notEqual(missingSource.status, 0);
  assert.match(missingSource.stderr, /--source is required/);
  assert.notEqual(missingDestination.status, 0);
  assert.match(missingDestination.stderr, /--dest is required/);
});
