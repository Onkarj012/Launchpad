#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openCrawlerStore } from './run.mjs';

const TABLE_COLUMNS = Object.freeze({
  sources: ['source_id', 'lane', 'trust_class', 'capabilities_json', 'rate_policy_json', 'cursor_json', 'updated_at'],
  crawl_runs: ['run_id', 'schedule', 'status', 'stage', 'started_at', 'finished_at', 'error', 'counts_json', 'telemetry_json', 'config_json'],
  crawl_run_stages: ['run_id', 'stage', 'status', 'started_at', 'finished_at', 'error'],
  source_failures: ['failure_id', 'run_id', 'source_id', 'stage', 'attempt', 'retry_class', 'host', 'status_code', 'message', 'created_at'],
  companies: ['company_key', 'name', 'domain', 'first_seen_at', 'last_seen_at'],
  company_boards: ['board_key', 'company_key', 'source_id', 'provider', 'board_url', 'board_identity', 'first_seen_at', 'last_seen_at'],
  jobs: ['job_key', 'company_key', 'provider', 'provider_job_id', 'canonical_url', 'company', 'title', 'location', 'first_seen_at', 'last_seen_at', 'original_posted_at', 'latest_updated_at', 'inferred_repost_at', 'closed_at', 'latest_fingerprint'],
  job_observations: ['observation_key', 'job_key', 'source_id', 'run_id', 'source_record_key', 'canonical_url', 'posted_at', 'updated_at', 'observed_at', 'fingerprint', 'classification', 'raw_json'],
});

function validateTrustedRunIds(trustedRunIds) {
  if (!Array.isArray(trustedRunIds)) throw new TypeError('trustedRunIds must be an array');
  if (trustedRunIds.some((runId) => typeof runId !== 'string' || !runId.trim())) {
    throw new TypeError('trustedRunIds must contain non-empty strings');
  }
  return [...new Set(trustedRunIds)];
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function selectByIds(db, table, column, ids) {
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM ${table} WHERE ${column} IN (${placeholders(ids)})`).all(...ids);
}

function insertRows(db, table, rows) {
  if (!rows.length) return;
  const columns = TABLE_COLUMNS[table];
  const statement = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders(columns)})`);
  for (const row of rows) statement.run(...columns.map((column) => row[column]));
}

function excludedRuns(source, runs, trustedRunIds) {
  const trusted = new Set(trustedRunIds);
  return runs
    .filter((run) => !trusted.has(run.run_id))
    .map((run) => {
      const summary = source.prepare(`SELECT COUNT(*) AS observation_count, MIN(observed_at) AS first_seen_at
        FROM job_observations WHERE run_id = ?`).get(run.run_id);
      return {
        runId: run.run_id,
        observationCount: Number(summary.observation_count),
        firstSeenAt: summary.first_seen_at ?? run.started_at,
      };
    })
    .sort((left, right) => right.observationCount - left.observationCount || left.runId.localeCompare(right.runId));
}

function freshDestination(destinationPath, sourcePath) {
  const resolvedDestination = path.resolve(destinationPath);
  const resolvedSource = path.resolve(sourcePath);
  if (resolvedDestination === resolvedSource) throw new Error('destination must differ from source');
  if (fs.existsSync(resolvedDestination)) throw new Error(`destination already exists: ${resolvedDestination}`);
  fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true });
  return resolvedDestination;
}

/** Copy trusted crawler state into a new database without modifying the source. */
export function rebuildProductionDb({ sourcePath, destinationPath, trustedRunIds } = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new TypeError('sourcePath is required');
  if (typeof destinationPath !== 'string' || !destinationPath.trim()) throw new TypeError('destinationPath is required');
  const trustedIds = validateTrustedRunIds(trustedRunIds);
  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource)) throw new Error(`source database does not exist: ${resolvedSource}`);
  const resolvedDestination = freshDestination(destinationPath, resolvedSource);

  const source = new DatabaseSync(resolvedSource, { readOnly: true });
  let destination;
  try {
    const allRuns = source.prepare('SELECT * FROM crawl_runs ORDER BY run_id').all();
    const runs = selectByIds(source, 'crawl_runs', 'run_id', trustedIds);
    const observations = selectByIds(source, 'job_observations', 'run_id', trustedIds);
    const stages = selectByIds(source, 'crawl_run_stages', 'run_id', trustedIds);
    const failures = selectByIds(source, 'source_failures', 'run_id', trustedIds);
    const jobKeys = [...new Set(observations.map((row) => row.job_key))];
    const jobs = selectByIds(source, 'jobs', 'job_key', jobKeys);
    const companyKeys = [...new Set(jobs.map((row) => row.company_key).filter(Boolean))];
    const companies = selectByIds(source, 'companies', 'company_key', companyKeys);
    const trustedSourceIds = [...new Set([
      ...observations.map((row) => row.source_id),
      ...failures.map((row) => row.source_id),
      ...selectByIds(source, 'source_telemetry', 'run_id', trustedIds).map((row) => row.source_id),
    ])];
    const companyBoards = companyKeys.length && trustedSourceIds.length
      ? source.prepare(`SELECT * FROM company_boards
        WHERE company_key IN (${placeholders(companyKeys)})
        AND source_id IN (${placeholders(trustedSourceIds)})`).all(...companyKeys, ...trustedSourceIds)
      : [];
    const sourceIds = [...new Set([...trustedSourceIds, ...companyBoards.map((row) => row.source_id)])];
    const sources = selectByIds(source, 'sources', 'source_id', sourceIds);

    destination = openCrawlerStore(resolvedDestination);
    destination.exec('BEGIN');
    try {
      insertRows(destination, 'sources', sources);
      insertRows(destination, 'crawl_runs', runs);
      insertRows(destination, 'companies', companies);
      insertRows(destination, 'company_boards', companyBoards);
      insertRows(destination, 'jobs', jobs);
      insertRows(destination, 'crawl_run_stages', stages);
      insertRows(destination, 'source_failures', failures);
      insertRows(destination, 'job_observations', observations);
      destination.exec('COMMIT');
    } catch (error) {
      destination.exec('ROLLBACK');
      throw error;
    }

    return {
      trustedRunIds: trustedIds,
      includedCounts: {
        jobs: jobs.length,
        observations: observations.length,
        companies: companies.length,
        companyBoards: companyBoards.length,
        crawlRuns: runs.length,
      },
      excludedRunIds: excludedRuns(source, allRuns, trustedIds),
    };
  } finally {
    destination?.close();
    source.close();
  }
}

function requiredOptionValue(args, index, name) {
  const optionValue = args[index + 1];
  if (!optionValue || optionValue.startsWith('--')) throw new Error(`${name} requires a value`);
  return optionValue;
}

export function parseRebuildArgs(args = []) {
  const parsed = { sourcePath: null, destinationPath: null, trustedRunIds: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--source') {
      parsed.sourcePath = requiredOptionValue(args, index, '--source');
      index += 1;
    } else if (argument === '--dest') {
      parsed.destinationPath = requiredOptionValue(args, index, '--dest');
      index += 1;
    } else if (argument === '--trusted-run-id') {
      parsed.trustedRunIds.push(requiredOptionValue(args, index, '--trusted-run-id'));
      index += 1;
    }
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!parsed.sourcePath) throw new Error('--source is required');
  if (!parsed.destinationPath) throw new Error('--dest is required');
  if (!parsed.trustedRunIds.length) throw new Error('at least one --trusted-run-id is required');
  return parsed;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseRebuildArgs(argv);
  const report = rebuildProductionDb(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
