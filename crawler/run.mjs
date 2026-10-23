import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { candidateRequisitionKey } from '../job-pull/candidate.mjs';
import {
  ACTIONED_STATES,
  LIFECYCLE_STATES,
  lifecycleFromObservation,
  mergeLifecycleState,
  SURFACED_SUPPRESSION_STATES,
} from './identity.mjs';

// Keep the public schema version stable; recovery tables are additive and old
// stores must continue to report their historical version to existing callers.
const SCHEMA_VERSION = 4;
const TERMINAL_RUN_STATES = new Set(['completed', 'completed_with_failures', 'failed']);
const RESUMABLE_RUN_STATES = new Set(['running', 'partial', 'resumed']);
import {
  createSourceDeadline,
  deadlineError,
  isDeadlineCancellation,
  isSourceBudgetCancellation,
  planSourceBudgets,
  remainingDeadlineMs,
  sourceBudgetError,
} from './deadline.mjs';
const SOURCE_TERMINAL_STATES = new Set(['succeeded', 'truncated', 'interrupted', 'failed', 'omitted_by_planner', 'omitted_by_runtime']);
const STAGES = ['fetch', 'commit'];

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS crawler_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crawler_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  lane TEXT NOT NULL,
  trust_class TEXT NOT NULL DEFAULT 'unknown',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  rate_policy_json TEXT NOT NULL DEFAULT '{}',
  cursor_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crawl_runs (
  run_id TEXT PRIMARY KEY,
  schedule TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  counts_json TEXT NOT NULL DEFAULT '{}',
  telemetry_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS crawl_run_attempts (
  run_id TEXT NOT NULL REFERENCES crawl_runs(run_id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  PRIMARY KEY (run_id, attempt)
);

CREATE TABLE IF NOT EXISTS crawl_run_stages (
  run_id TEXT NOT NULL REFERENCES crawl_runs(run_id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  PRIMARY KEY (run_id, stage)
);

CREATE TABLE IF NOT EXISTS source_failures (
  failure_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES crawl_runs(run_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  retry_class TEXT NOT NULL,
  host TEXT,
  status_code INTEGER,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  company_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_boards (
  board_key TEXT PRIMARY KEY,
  company_key TEXT NOT NULL REFERENCES companies(company_key),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  provider TEXT,
  board_url TEXT,
  board_identity TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(source_id, company_key, board_identity)
);

CREATE TABLE IF NOT EXISTS jobs (
  job_key TEXT PRIMARY KEY,
  company_key TEXT REFERENCES companies(company_key),
  provider TEXT,
  provider_job_id TEXT,
  canonical_url TEXT,
  company TEXT,
  title TEXT,
  location TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  original_posted_at TEXT,
  latest_updated_at TEXT,
  inferred_repost_at TEXT,
  closed_at TEXT,
  latest_fingerprint TEXT
);

CREATE TABLE IF NOT EXISTS job_descriptions (
  fingerprint TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_observations (
  observation_key TEXT PRIMARY KEY,
  job_key TEXT NOT NULL REFERENCES jobs(job_key),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  run_id TEXT NOT NULL REFERENCES crawl_runs(run_id),
  source_record_key TEXT,
  canonical_url TEXT,
  posted_at TEXT,
  updated_at TEXT,
  observed_at TEXT NOT NULL,
  fingerprint TEXT,
  classification TEXT NOT NULL DEFAULT 'lead',
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_telemetry (
  run_id TEXT NOT NULL REFERENCES crawl_runs(run_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  fetched INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0,
  observations INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  PRIMARY KEY (run_id, source_id)
);

CREATE TABLE IF NOT EXISTS source_attempts (
  run_id TEXT NOT NULL REFERENCES crawl_runs(run_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  starting_cursor_json TEXT,
  continuation_cursor_json TEXT,
  error TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, source_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_job_observations_run ON job_observations(run_id);
CREATE INDEX IF NOT EXISTS idx_job_observations_job_dated_latest
  ON job_observations(job_key, observed_at DESC, posted_at)
  WHERE posted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_source_failures_run ON source_failures(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_provider_id ON jobs(provider, provider_job_id) WHERE provider_job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_canonical_url ON jobs(canonical_url) WHERE canonical_url IS NOT NULL;
`;

function ensureColumn(db, table, name, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

export function openCrawlerStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  ensureColumn(db, 'jobs', 'company_key', 'TEXT REFERENCES companies(company_key)');
  ensureColumn(db, 'jobs', 'original_posted_at', 'TEXT');
  ensureColumn(db, 'jobs', 'latest_updated_at', 'TEXT');
  ensureColumn(db, 'jobs', 'inferred_repost_at', 'TEXT');
  ensureColumn(db, 'jobs', 'closed_at', 'TEXT');
  ensureColumn(db, 'jobs', 'lifecycle_state', 'TEXT');
  ensureColumn(db, 'jobs', 'lifecycle_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'source_telemetry', 'details_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'crawl_runs', 'attempt_count', 'INTEGER NOT NULL DEFAULT 1');
  db.prepare(`INSERT INTO crawler_meta(key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = CASE
      WHEN CAST(crawler_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER) THEN excluded.value
      ELSE crawler_meta.value
    END`).run(String(SCHEMA_VERSION));
  for (let version = 1; version <= SCHEMA_VERSION; version += 1) {
    db.prepare('INSERT OR IGNORE INTO crawler_migrations(version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
  }
  return db;
}

const json = (value, fallback) => {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;

function defineJsonProperty(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

/** Clone only the bounded plain-JSON subset that can be durably persisted. */
export function cloneJsonSafe(value, label = 'value', state = { seen: new WeakSet(), nodes: 0 }, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw new TypeError(`${label} exceeds JSON depth limit`);
  if (++state.nodes > MAX_JSON_NODES) throw new TypeError(`${label} exceeds JSON size limit`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value === 'undefined' || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`${label} contains an unsupported ${typeof value}`);
  }
  if (typeof value !== 'object') throw new TypeError(`${label} contains an unsupported value`);
  let prototype;
  try { prototype = Object.getPrototypeOf(value); } catch { throw new TypeError(`${label} is not JSON-safe`); }
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new TypeError(`${label} contains a non-plain object`);
  }
  if (state.seen.has(value)) throw new TypeError(`${label} contains a cycle`);
  state.seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`${label} contains symbol keys`);
    if (Array.isArray(value)) {
      const clone = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError(`${label} contains a sparse array`);
        clone.push(cloneJsonSafe(value[index], `${label}[${index}]`, state, depth + 1));
      }
      return clone;
    }
    const clone = {};
    for (const key of Object.keys(value)) defineJsonProperty(clone, key, cloneJsonSafe(value[key], `${label}.${key}`, state, depth + 1));
    return clone;
  } finally {
    state.seen.delete(value);
  }
}

function jsonStringifySafe(value, label) {
  return JSON.stringify(cloneJsonSafe(value, label));
}

const MAX_JSON_RECORDS = 10_000;
const MAX_JSON_RECORD_BYTES = 2_000_000;
const MAX_JSON_ENVELOPE_BYTES = 20_000_000;
// One source can return thousands of hydrated JDs (Workday, enterprise ATS), so its observation batch gets more room.
const MAX_SOURCE_OBSERVATION_BYTES = 80_000_000;

/** Collections have count/byte bounds; each record keeps the ordinary node/depth guard. */
export function cloneJsonCollection(value, label = 'collection', { maxBytes = MAX_JSON_ENVELOPE_BYTES } = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > MAX_JSON_RECORDS) throw new TypeError(`${label} exceeds record count limit`);
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`${label} contains symbol keys`);
  let bytes = 2;
  return Array.from({ length: value.length }, (_, index) => {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${label} contains a sparse array`);
    const record = cloneJsonSafe(value[index], `${label}[${index}]`);
    const size = Buffer.byteLength(JSON.stringify(record));
    if (size > MAX_JSON_RECORD_BYTES) throw new TypeError(`${label}[${index}] exceeds record byte limit`);
    bytes += size + (index ? 1 : 0);
    if (bytes > maxBytes) throw new TypeError(`${label} exceeds total byte limit`);
    return record;
  });
}

/** Only declared envelope boundaries split the per-record node budget. */
export function cloneJsonEnvelope(value, label, boundaries) {
  const collections = { count: 0 };
  const visit = (input, name, paths) => {
    if (!paths.length) return cloneJsonSafe(input, name);
    if (paths.some((path) => path.length === 0)) {
      if (name.endsWith('.workflow.dailyReceipt.retained.identityRows') && input === 'Not Verified') return input;
      const result = cloneJsonCollection(input, name);
      collections.count += result.length;
      if (collections.count > MAX_JSON_RECORDS) throw new TypeError(`${label} exceeds total record count limit`);
      return result;
    }
    if (!isRecord(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError(`${name} must be a plain object`);
    if (Object.getOwnPropertySymbols(input).length) throw new TypeError(`${name} contains symbol keys`);
    const result = {};
    if (Object.keys(input).length > MAX_JSON_RECORDS) throw new TypeError(`${name} exceeds field count limit`);
    for (const key of Object.keys(input)) {
      const nested = paths.filter((path) => path[0] === key || path[0] === '*').map((path) => path.slice(1));
      defineJsonProperty(result, key, visit(input[key], `${name}.${key}`, nested));
    }
    return result;
  };
  const result = visit(value, label, boundaries);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_JSON_ENVELOPE_BYTES) throw new TypeError(`${label} exceeds total byte limit`);
  return result;
}

export const WORKFLOW_COLLECTIONS = ['verificationQueue', 'unresolvedLeads', 'historicalSuppressions', 'historicalAmbiguous'];
export const TERMINAL_COLLECTIONS = ['verificationQueue', 'backfill', 'scoredReady', 'scorePendingReady'];
export const FUNNEL_COLLECTION_BOUNDARIES = [['sourceHealth', '*', 'boards'], ['identityRows'], ['receiptLedgerSuppressions']];
export const DAILY_RECEIPT_COLLECTIONS = [
  ['workflow', 'dailyReceipt', 'retained', 'identityRows'],
  ['workflow', 'dailyReceipt', 'retained', 'observations'],
];
export const WORKFLOW_TELEMETRY_BOUNDARIES = [
  ['sources', '*', 'attemptHistory'],
  ['workflow', 'sourceTelemetry', '*', 'attemptHistory'],
  ['workflow', 'sourceYield', 'sources'],
  ['workflow', 'funnel', 'sourceHealth', '*', 'boards'],
  ...FUNNEL_COLLECTION_BOUNDARIES.map((path) => ['workflow', 'funnel', ...path]),
  ...WORKFLOW_COLLECTIONS.map((key) => ['workflow', key]),
  ...TERMINAL_COLLECTIONS.map((key) => ['workflow', 'terminalEnvelope', key]),
  ...DAILY_RECEIPT_COLLECTIONS,
];

// Validate retained telemetry and its additive receipt under independent record budgets.
function cloneWorkflowTelemetry(value, label) {
  const workflow = value?.workflow;
  const hasDailyReceipt = isRecord(workflow) && Object.hasOwn(workflow, 'dailyReceipt');
  const { dailyReceipt, ...workflowTelemetry } = isRecord(workflow) ? workflow : {};
  const core = cloneJsonEnvelope({ ...value, ...(isRecord(workflow) ? { workflow: workflowTelemetry } : {}) }, label, WORKFLOW_TELEMETRY_BOUNDARIES);
  if (!hasDailyReceipt) return core;
  const receipt = cloneJsonEnvelope({ workflow: { dailyReceipt } }, `${label} daily receipt`, DAILY_RECEIPT_COLLECTIONS).workflow.dailyReceipt;
  const result = { ...core, workflow: { ...(core.workflow ?? {}), dailyReceipt: receipt } };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_JSON_ENVELOPE_BYTES) throw new TypeError(`${label} exceeds total byte limit`);
  return result;
}

const text = (value) => value == null ? null : String(value);
const nowFrom = (clock) => {
  const value = typeof clock?.now === 'function' ? clock.now() : new Date();
  return value instanceof Date ? value.toISOString() : String(value);
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const normalized = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function clockSleep(clock, milliseconds) {
  if (typeof clock?.sleep === 'function') return clock.sleep(milliseconds);
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function monotonicNow(clock) {
  const value = typeof clock?.monotonicNow === 'function' ? Number(clock.monotonicNow()) : performance.now();
  return Number.isFinite(value) ? value : performance.now();
}

function sleepWithSignal(clock, milliseconds, signal) {
  if (!signal) return clockSleep(clock, milliseconds);
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('source aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('source aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sourceHost(url) {
  try { return new URL(url).host; } catch { return null; }
}

function runRow(db, runId) {
  const row = db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get(runId);
  if (!row) return null;
  return {
    runId: row.run_id,
    schedule: row.schedule,
    status: row.status,
    stage: row.stage,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    attemptCount: Number(row.attempt_count ?? 1),
    error: row.error,
    counts: json(row.counts_json, {}),
    telemetry: json(row.telemetry_json, {}),
    config: json(row.config_json, {}),
  };
}

function stagesFor(db, runId) {
  return Object.fromEntries(db.prepare('SELECT * FROM crawl_run_stages WHERE run_id = ? ORDER BY rowid').all(runId).map((row) => [row.stage, {
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  }]));
}

function telemetryFor(db, runId) {
  return Object.fromEntries(db.prepare('SELECT * FROM source_telemetry WHERE run_id = ? ORDER BY source_id').all(runId).map((row) => {
    const details = Object.fromEntries(Object.entries(json(row.details_json, {})));
    const attempts = db.prepare('SELECT * FROM source_attempts WHERE run_id = ? AND source_id = ? ORDER BY attempt').all(runId, row.source_id);
    return [row.source_id, {
      status: row.status,
      attempts: row.attempts,
      observations: row.observations,
      changed: row.changed,
      duplicates: row.duplicates,
      ...(row.fetched == null ? {} : { fetched: row.fetched }),
      ...details,
      ...(attempts.length > 1 ? {
        attemptHistory: attempts.map((attempt) => ({
          attempt: attempt.attempt, status: attempt.status, startedAt: attempt.started_at, finishedAt: attempt.finished_at,
          startingCursor: json(attempt.starting_cursor_json, null), continuationCursor: json(attempt.continuation_cursor_json, null), error: attempt.error,
          ...json(attempt.details_json, {}),
        })),
      } : {}),
      ...(row.error ? { error: row.error } : {}),
    }];
  }));
}

function sourceState(value, fallback = null) {
  const parsed = typeof value === 'string' ? json(value, null) : value;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.scanStatus === 'string') {
    return { cursor: ['interrupted', 'truncated', 'checkpointed'].includes(parsed.scanStatus) ? parsed.cursor ?? null : null, state: parsed };
  }
  return { cursor: fallback ?? parsed ?? null, state: { scanStatus: 'legacy' } };
}

function encodedSourceState(cursor, state) {
  return JSON.stringify(cloneJsonSafe({ version: 1, cursor: cursor ?? null, ...state }, 'source state'));
}

function newestPostingAt(observations, manifest) {
  const values = observations.map((observation) => observation.postedAt).filter(Boolean).sort();
  return manifest?.newestPostingAt ?? values.at(-1) ?? null;
}

// Read one durable run and its source attempts without resuming any work.
export function readCrawlerRunSnapshot(db, runId) {
  const run = runRow(db, runId);
  if (!run) return null;
  return {
    run,
    stages: stagesFor(db, runId),
    attempts: db.prepare('SELECT * FROM crawl_run_attempts WHERE run_id = ? ORDER BY attempt').all(runId).map((row) => ({
      attempt: row.attempt, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, error: row.error,
    })),
    telemetry: { ...run.telemetry, sources: telemetryFor(db, runId) },
    sourceAttempts: db.prepare('SELECT * FROM source_attempts WHERE run_id = ? ORDER BY source_id, attempt').all(runId).map((row) => ({
      sourceId: row.source_id, attempt: row.attempt, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at,
      startingCursor: json(row.starting_cursor_json, null), continuationCursor: json(row.continuation_cursor_json, null), error: row.error,
    })),
    failures: db.prepare('SELECT * FROM source_failures WHERE run_id = ? ORDER BY failure_id').all(runId).map((row) => ({ sourceId: row.source_id, stage: row.stage, attempt: row.attempt, retryClass: row.retry_class, message: row.message })),
  };
}

function beginStage(db, runId, stage, at) {
  db.prepare(`INSERT INTO crawl_run_stages(run_id, stage, status, started_at) VALUES (?, ?, 'running', ?)
    ON CONFLICT(run_id, stage) DO UPDATE SET status = CASE WHEN crawl_run_stages.status = 'committed' THEN 'committed' ELSE 'running' END,
    started_at = COALESCE(crawl_run_stages.started_at, excluded.started_at)`).run(runId, stage, at);
  db.prepare('UPDATE crawl_runs SET stage = ? WHERE run_id = ?').run(stage, runId);
}

function finishStage(db, runId, stage, status, at, error = null) {
  db.prepare('UPDATE crawl_run_stages SET status = ?, finished_at = ?, error = ? WHERE run_id = ? AND stage = ?').run(status, at, error, runId, stage);
}

/** Persist the effective lane configuration without duplicating the registry.
 * Registry identity covers every normalized board, including disabled boards.
 * Each board still passes the ordinary JSON guard; the collection has its own
 * count and byte bounds. The effective sources.*.boards remain in the snapshot.
 */
export function persistedCrawlerConfig(config) {
  if (!config.boardRegistry) return cloneJsonSafe(config, 'run config');
  const { boards, ...identity } = config.boardRegistry;
  if (!Array.isArray(boards) || boards.length > 1000) throw new TypeError('run registry exceeds board count limit');
  const safeIdentity = cloneJsonSafe(identity, 'run registry identity');
  const hash = createHash('sha256');
  let bytes = 0;
  const append = (value) => {
    const encoded = JSON.stringify(value);
    bytes += Buffer.byteLength(encoded);
    if (bytes > 2_000_000) throw new TypeError('run registry exceeds byte limit');
    hash.update(encoded).update('\n');
  };
  append(safeIdentity);
  for (const [index, board] of boards.entries()) append(cloneJsonSafe(board, `run registry board[${index}]`));
  return cloneJsonSafe({
    ...config,
    boardRegistry: {
      identity: safeIdentity,
      boardCount: boards.length,
      fingerprint: `sha256:${hash.digest('hex')}`,
      fingerprintFormat: 'registry-identity-and-ordered-boards-json-lines-v1',
    },
  }, 'run config');
}

export function startCrawlRun(store, { runId, schedule = 'manual', config = {}, clock } = {}) {
  const at = nowFrom(clock);
  const safeConfig = persistedCrawlerConfig(config);
  const existing = runRow(store, runId);
  if (existing) {
    if (TERMINAL_RUN_STATES.has(existing.status)) return { run: existing, idempotent: true };
    const previousFingerprint = existing.config?.boardRegistry?.fingerprint;
    if (previousFingerprint && previousFingerprint !== safeConfig.boardRegistry?.fingerprint) {
      throw new Error('run registry fingerprint changed; resume requires the original registry');
    }
    const attempt = Number(existing.config?.attemptCount ?? existing.attemptCount ?? store.prepare('SELECT COUNT(*) AS n FROM crawl_run_attempts WHERE run_id = ?').get(runId)?.n ?? 0) + 1;
    store.prepare('UPDATE crawl_runs SET status = ?, stage = ?, finished_at = NULL, error = NULL, attempt_count = ? WHERE run_id = ?')
      .run('running', 'fetch', attempt, runId);
    store.prepare('INSERT INTO crawl_run_attempts(run_id, attempt, status, started_at) VALUES (?, ?, ?, ?)')
      .run(runId, attempt, 'running', at);
    return { run: runRow(store, runId), idempotent: false, resumed: true, attempt };
  }
  store.exec('BEGIN');
  try {
    store.prepare(`INSERT INTO crawl_runs(run_id, schedule, status, stage, started_at, counts_json, telemetry_json, config_json, attempt_count)
      VALUES (?, ?, 'running', 'fetch', ?, '{}', '{}', ?, 1)`).run(runId, schedule, at, JSON.stringify(safeConfig));
    for (const stage of STAGES) store.prepare('INSERT INTO crawl_run_stages(run_id, stage, status) VALUES (?, ?, ?)' ).run(runId, stage, stage === 'fetch' ? 'running' : 'pending');
    store.prepare('INSERT INTO crawl_run_attempts(run_id, attempt, status, started_at) VALUES (?, 1, ?, ?)').run(runId, 'running', at);
    store.exec('COMMIT');
  } catch (error) {
    store.exec('ROLLBACK');
    throw error;
  }
  return { run: runRow(store, runId), idempotent: false, resumed: false, attempt: 1 };
}

function sourcePlanRow(source) {
  return {
    lane: source.lane ?? 'unknown',
    trustClass: source.trustClass ?? 'unknown',
    capabilities: source.capabilities ?? {},
    ratePolicy: source.ratePolicy ?? {},
  };
}

function notStartedBugError(sourceIds) {
  const error = new Error(`not_started_bug: ${sourceIds.join(', ')}`);
  error.code = 'NOT_STARTED_BUG';
  return error;
}

function sourceAbortContext(parentSignal, parentDeadline, maxDurationMs, parentNow = Date.now(), clock = {}) {
  const controller = new AbortController();
  const nowMs = parentDeadline?.wallClock === true || typeof clock?.now !== 'function'
    ? Date.now
    : () => {
      const value = clock.now();
      const current = value instanceof Date ? value.getTime() : new Date(value).getTime();
      return Number.isFinite(current) ? current : Date.now();
    };
  const startedAt = Number.isFinite(Number(parentNow)) ? Number(parentNow) : nowMs();
  const sourceDeadline = createSourceDeadline(parentDeadline, maxDurationMs, startedAt, nowMs);
  let timer = null;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener?.('abort', abortFromParent, { once: true });
  const remaining = sourceDeadline.remainingMs();
  if (remaining !== Infinity) {
    const maxDuration = Math.max(1, Number(maxDurationMs) || 1);
    const parentRemaining = remainingDeadlineMs(parentDeadline, nowMs());
    const reason = parentRemaining <= maxDuration ? deadlineError() : sourceBudgetError();
    timer = typeof clock.setTimeout === 'function'
      ? clock.setTimeout(() => controller.abort(reason), Math.max(1, remaining))
      : setTimeout(() => controller.abort(reason), Math.max(1, remaining));
  }
  return {
    signal: controller.signal,
    deadline: sourceDeadline,
    budgetCancellationFired: () => controller.signal.reason?.code === 'SOURCE_MAX_DURATION_EXCEEDED',
    cleanup() {
      if (timer) {
        if (typeof clock.clearTimeout === 'function') clock.clearTimeout(timer);
        else clearTimeout(timer);
      }
      parentSignal?.removeEventListener?.('abort', abortFromParent);
    },
  };
}

/** Register the complete source plan before the first adapter can run. */
export function registerSourcePlans(store, runId, sourcePlans = [], { clock, at: suppliedAt = null } = {}) {
  const at = suppliedAt ?? nowFrom(clock);
  for (const source of sourcePlans) {
    if (!source?.id || typeof source.fetch !== 'function') throw new TypeError('each source plan requires id and fetch');
    const row = sourcePlanRow(source);
    const safeCapabilities = cloneJsonSafe(row.capabilities, `source ${source.id} capabilities`);
    const safeRatePolicy = cloneJsonSafe(row.ratePolicy, `source ${source.id} rate policy`);
    store.prepare(`INSERT INTO sources(source_id, lane, trust_class, capabilities_json, rate_policy_json, cursor_json, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(source_id) DO UPDATE SET lane = excluded.lane, trust_class = excluded.trust_class,
      capabilities_json = excluded.capabilities_json, rate_policy_json = excluded.rate_policy_json, updated_at = excluded.updated_at`)
      .run(source.id, row.lane, row.trustClass, JSON.stringify(safeCapabilities), JSON.stringify(safeRatePolicy), at);
    const plannedStatus = source.budget?.status === 'omitted_by_planner' ? 'omitted_by_planner' : 'pending';
    const plannedDetails = {
      plannedAt: at,
      lane: row.lane,
      provider: source.provider ?? null,
      budget: source.budget ?? null,
      ...(plannedStatus === 'omitted_by_planner' ? {
        initialPlannedAllocationMs: 0,
        runtimeAllowanceMs: 0,
        actualDurationMs: 0,
        unusedMs: 0,
        recycledMs: 0,
        laterSourceReserveMs: 0,
        capHit: null,
      } : {}),
      ...(plannedStatus === 'omitted_by_planner' ? { reason: source.budget.reason } : {}),
    };
    store.prepare(`INSERT INTO source_telemetry(run_id, source_id, status, attempts, fetched, changed, observations, duplicates, details_json)
      VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?)
      ON CONFLICT(run_id, source_id) DO NOTHING`)
    .run(runId, source.id, plannedStatus, JSON.stringify(cloneJsonSafe(plannedDetails, `source ${source.id} plan telemetry`)));
  }
  return telemetryFor(store, runId);
}

function updateSourceStatus(store, runId, sourceId, status, { clock, error = null, details = {} } = {}) {
  const at = nowFrom(clock);
  const current = store.prepare('SELECT details_json FROM source_telemetry WHERE run_id = ? AND source_id = ?').get(runId, sourceId);
  const mergedDetails = cloneJsonSafe({ ...json(current?.details_json, {}), ...details }, `source ${sourceId} telemetry`);
  store.prepare('UPDATE source_telemetry SET status = ?, error = COALESCE(?, error), details_json = ? WHERE run_id = ? AND source_id = ?')
    .run(status, error, jsonStringifySafe(mergedDetails, `source ${sourceId} telemetry`), runId, sourceId);
  return at;
}

function requeueRuntimeOmissions(store, runId, sourcePlans, { clock } = {}) {
  const plannedSourceIds = new Set(sourcePlans
    .filter((source) => source?.budget?.status !== 'omitted_by_planner')
    .map((source) => source.id));
  const omitted = store.prepare("SELECT source_id FROM source_telemetry WHERE run_id = ? AND status = 'omitted_by_runtime'").all(runId);
  for (const { source_id: sourceId } of omitted) {
    if (plannedSourceIds.has(sourceId)) updateSourceStatus(store, runId, sourceId, 'pending', { clock });
  }
}

function markUnstartedSources(store, runId, sourceIds, { clock } = {}) {
  for (const sourceId of sourceIds) {
    const row = store.prepare('SELECT status FROM source_telemetry WHERE run_id = ? AND source_id = ?').get(runId, sourceId);
    if (row?.status === 'pending') updateSourceStatus(store, runId, sourceId, 'interrupted', { clock, details: { reason: 'deadline-before-source' } });
  }
}

function markNotStartedBugSources(store, runId, sourceIds, { clock } = {}) {
  for (const sourceId of sourceIds) {
    const row = store.prepare('SELECT status FROM source_telemetry WHERE run_id = ? AND source_id = ?').get(runId, sourceId);
    if (row?.status === 'pending' || row?.status === 'not_started') {
      updateSourceStatus(store, runId, sourceId, 'failed', { clock, error: 'not_started_bug', details: { reason: 'not_started_bug' } });
    }
  }
}

function markRunAttempt(store, runId, attempt, status, { clock, error = null } = {}) {
  store.prepare('UPDATE crawl_run_attempts SET status = ?, finished_at = ?, error = ? WHERE run_id = ? AND attempt = ?')
    .run(status, nowFrom(clock), error, runId, attempt);
}

function runtimeSourceBudget(sourcePlans, sourceIndex, store, runId, remainingDiscoveryMs, minimumStartMs, configuredCapMs) {
  const laterSourceReserveMs = sourcePlans.slice(sourceIndex + 1).reduce((reserve, candidate) => {
    if (candidate?.budget?.status !== 'planned') return reserve;
    const row = store.prepare('SELECT status FROM source_telemetry WHERE run_id = ? AND source_id = ?').get(runId, candidate.id);
    if (!['pending', 'not_started'].includes(row?.status)) return reserve;
    const candidateCap = Number(candidate.budget?.maxDurationMs ?? candidate.maxDurationMs ?? configuredCapMs);
    const positiveCap = Number.isFinite(candidateCap) && candidateCap > 0 ? Math.floor(candidateCap) : minimumStartMs;
    return reserve + Math.min(minimumStartMs, positiveCap);
  }, 0);
  const safeRemainingMs = Math.max(0, finiteCount(remainingDiscoveryMs, 0));
  const runtimeAllowanceMs = Math.min(configuredCapMs, Math.max(0, safeRemainingMs - laterSourceReserveMs));
  return {
    runtimeAllowanceMs: finiteCount(runtimeAllowanceMs),
    laterSourceReserveMs: finiteCount(laterSourceReserveMs),
  };
}

export function transitionStage(store, runId, stage, status, { clock, error = null } = {}) {
  const at = nowFrom(clock);
  if (status === 'running') beginStage(store, runId, stage, at);
  else finishStage(store, runId, stage, status, at, error);
  return stagesFor(store, runId)[stage];
}

export function finishCrawlRun(store, runId, { status = 'completed', counts = {}, telemetry = {}, clock, error = null } = {}) {
  const at = nowFrom(clock);
  const safeCounts = cloneJsonSafe(counts, 'run counts');
  const safeTelemetry = cloneWorkflowTelemetry(telemetry, 'run telemetry');
  store.prepare('UPDATE crawl_runs SET status = ?, stage = ?, finished_at = ?, error = ?, counts_json = ?, telemetry_json = ? WHERE run_id = ?').run(status, status === 'partial' ? 'fetch' : 'complete', at, error, JSON.stringify(safeCounts), JSON.stringify(safeTelemetry), runId);
  return runRow(store, runId);
}

// Attach the final daily receipt to the existing run envelope without changing its outcome.
export function persistDailyReceipt(store, runId, receipt) {
  const row = runRow(store, runId);
  if (!row) return false;
  const telemetry = cloneWorkflowTelemetry({
    ...row.telemetry,
    workflow: { ...(row.telemetry.workflow ?? {}), dailyReceipt: receipt },
  }, 'daily receipt telemetry');
  store.prepare('UPDATE crawl_runs SET telemetry_json = ? WHERE run_id = ?').run(JSON.stringify(telemetry), runId);
  return true;
}

export function failCrawlRun(store, runId, error, { clock } = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const current = runRow(store, runId);
  if (current?.stage && current.stage !== 'complete') finishStage(store, runId, current.stage, 'failed', nowFrom(clock), message);
  return finishCrawlRun(store, runId, { status: 'failed', counts: {}, clock, error: message });
}

function sourceRecordKey(observation) {
  return text(observation.sourceRecordKey ?? observation.providerJobId ?? observation.canonicalUrl) ?? hash(jsonStringifySafe(observation, 'observation'));
}

function fingerprint(observation) {
  return text(observation.fingerprint) ?? hash(normalized(observation.description));
}

function findJob(db, source, observation) {
  const matchedKey = observation._crawlerIdentity?.identity?.jobKey;
  if (matchedKey && db.prepare('SELECT job_key FROM jobs WHERE job_key = ?').get(matchedKey)) return matchedKey;
  const provider = observation.provider ?? source.provider ?? source.id;
  const providerJobId = observation.providerJobId ?? observation.jobId;
  if (providerJobId) {
    const row = db.prepare('SELECT job_key FROM jobs WHERE provider = ? AND provider_job_id = ?').get(provider, String(providerJobId));
    if (row) return row.job_key;
  }
  if (observation.canonicalUrl) {
    const row = db.prepare('SELECT job_key FROM jobs WHERE canonical_url = ?').get(observation.canonicalUrl);
    if (row) return row.job_key;
  }
  const row = db.prepare('SELECT job_key FROM jobs WHERE company = ? AND title = ? AND location = ?').get(normalized(observation.company), normalized(observation.title), normalized(observation.location));
  return row?.job_key ?? null;
}

function readJobLifecycle(store, jobKey) {
  const row = store.prepare('SELECT lifecycle_state, lifecycle_json FROM jobs WHERE job_key = ?').get(jobKey);
  if (!row) return { state: null, json: {} };
  return { state: row.lifecycle_state || null, json: json(row.lifecycle_json, {}) };
}

/** Monotonic lifecycle write. Raw observation never writes 'surfaced' — selection does. */
export function updateJobLifecycle(store, jobKey, nextState, { at = new Date().toISOString(), patch = {} } = {}) {
  if (!jobKey || !nextState) return null;
  const current = readJobLifecycle(store, jobKey);
  const merged = mergeLifecycleState(current.state, nextState);
  if (!merged) return current.state;
  const nextJson = {
    ...current.json,
    ...patch,
    state: merged,
    updatedAt: at,
  };
  if (merged === LIFECYCLE_STATES.SURFACED || SURFACED_SUPPRESSION_STATES.has(merged)) {
    nextJson.surfacedAt = current.json.surfacedAt || at;
    nextJson.lastSurfacedAt = at;
    nextJson.timesSurfaced = Number(current.json.timesSurfaced || 0) + (nextState === LIFECYCLE_STATES.SURFACED && current.state !== LIFECYCLE_STATES.SURFACED ? 1 : 0);
  }
  if (ACTIONED_STATES.has(merged)) {
    nextJson.actionState = merged;
    nextJson.actionAt = at;
  }
    store.prepare('UPDATE jobs SET lifecycle_state = ?, lifecycle_json = ? WHERE job_key = ?')
    .run(merged, jsonStringifySafe(nextJson, 'job lifecycle'), jobKey);
  return merged;
}

export function markJobsSurfaced(store, jobKeys, { at = new Date().toISOString() } = {}) {
  const keys = [...new Set((Array.isArray(jobKeys) ? jobKeys : []).filter(Boolean))];
  for (const jobKey of keys) updateJobLifecycle(store, jobKey, LIFECYCLE_STATES.SURFACED, { at });
  return keys.length;
}

function persistObservation(store, source, runId, observation, observedAt, { replaceCheckpoint = false } = {}) {
  const sourceKey = sourceRecordKey(observation);
  const observationKey = hash(`${runId}|${source.id}|${sourceKey}`);
  const existingObservation = store.prepare(`SELECT observation_key FROM job_observations
    WHERE observation_key = ? OR (run_id = ? AND source_id = ? AND source_record_key = ?)
    LIMIT 1`).get(observationKey, runId, source.id, sourceKey);
  if (existingObservation && !replaceCheckpoint) return { duplicate: true, jobKey: null };
  const providerJobId = observation.providerJobId ?? observation.jobId;
  const provider = observation.provider ?? source.provider ?? source.id;
  const jobKey = findJob(store, source, observation) ?? hash(`${provider}|${providerJobId ?? ''}|${observation.canonicalUrl ?? ''}|${normalized(observation.company)}|${normalized(observation.title)}|${normalized(observation.location)}`);
  const fp = fingerprint(observation);
  const companyName = normalized(observation.company) || 'unknown company';
  const companyDomain = text(observation.companyDomain ?? observation.company_domain);
  const companyKey = hash(`${companyName}|${normalized(companyDomain)}`);
  store.prepare(`INSERT INTO companies(company_key, name, domain, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(company_key) DO UPDATE SET last_seen_at = excluded.last_seen_at,
      domain = COALESCE(companies.domain, excluded.domain)`).run(companyKey, companyName, companyDomain, observedAt, observedAt);
  const boardIdentity = text(source.boardId ?? source.board ?? observation.boardId ?? observation.board_id ?? source.id);
  const boardUrl = text(source.boardUrl ?? source.url ?? observation.boardUrl ?? observation.board_url);
  const boardKey = hash(`${source.id}|${companyKey}|${boardIdentity ?? ''}`);
  store.prepare(`INSERT INTO company_boards(board_key, company_key, source_id, provider, board_url, board_identity, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(board_key) DO UPDATE SET last_seen_at = excluded.last_seen_at,
      board_url = COALESCE(company_boards.board_url, excluded.board_url)`).run(boardKey, companyKey, source.id, provider, boardUrl, boardIdentity, observedAt, observedAt);
  const closedAt = ['closed', 'inactive', 'expired', 'removed', 'filled'].includes(normalized(observation.status ?? observation.liveness?.status)) ? observedAt : null;
  // Observation may advance lifecycle up to application-ready only — never starts cooldown/surfaced.
  const observationLifecycle = lifecycleFromObservation(observation);
  const priorLifecycle = readJobLifecycle(store, jobKey);
  const nextLifecycle = mergeLifecycleState(priorLifecycle.state, observationLifecycle) || observationLifecycle;
  const lifecycleJson = {
    ...priorLifecycle.json,
    identityAliases: [...new Set([...(priorLifecycle.json.identityAliases || []), ...(observation.identityAliases || [])])],
    state: nextLifecycle,
    lastObservedAt: observedAt,
    applicationReady: observation.applicationReady === true
      || priorLifecycle.json.applicationReady === true
      || nextLifecycle === LIFECYCLE_STATES.APPLICATION_READY
      || nextLifecycle === LIFECYCLE_STATES.SURFACED
      || ACTIONED_STATES.has(nextLifecycle),
  };
  store.prepare(`INSERT INTO jobs(job_key, company_key, provider, provider_job_id, canonical_url, company, title, location, first_seen_at, last_seen_at, original_posted_at, latest_updated_at, inferred_repost_at, closed_at, latest_fingerprint, lifecycle_state, lifecycle_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_key) DO UPDATE SET last_seen_at = excluded.last_seen_at,
      latest_updated_at = COALESCE(excluded.latest_updated_at, jobs.latest_updated_at),
      original_posted_at = COALESCE(jobs.original_posted_at, excluded.original_posted_at),
      inferred_repost_at = COALESCE(excluded.inferred_repost_at, jobs.inferred_repost_at),
      closed_at = COALESCE(excluded.closed_at, jobs.closed_at),
      latest_fingerprint = excluded.latest_fingerprint,
      lifecycle_state = excluded.lifecycle_state,
      lifecycle_json = excluded.lifecycle_json`).run(jobKey, companyKey, provider, text(providerJobId), text(observation.canonicalUrl), companyName, normalized(observation.title), normalized(observation.location), observedAt, observedAt, text(observation.postedAt), text(observation.updatedAt), text(observation.inferredRepostAt), closedAt, fp, nextLifecycle, JSON.stringify(lifecycleJson));
  if (observation.description != null) store.prepare('INSERT OR IGNORE INTO job_descriptions(fingerprint, description, first_seen_at) VALUES (?, ?, ?)').run(fp, String(observation.description), observedAt);
  const rowKey = existingObservation?.observation_key ?? observationKey;
  if (existingObservation) {
    store.prepare(`UPDATE job_observations SET job_key = ?, source_record_key = ?, canonical_url = ?, posted_at = ?, updated_at = ?, observed_at = ?, fingerprint = ?, classification = ?, raw_json = ?
      WHERE observation_key = ?`).run(jobKey, sourceKey, text(observation.canonicalUrl), text(observation.postedAt), text(observation.updatedAt), observedAt, fp,
      observation.classification === 'direct' ? 'direct' : 'lead', JSON.stringify(observation), rowKey);
  } else {
    store.prepare(`INSERT INTO job_observations(observation_key, job_key, source_id, run_id, source_record_key, canonical_url, posted_at, updated_at, observed_at, fingerprint, classification, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(rowKey, jobKey, source.id, runId, sourceKey, text(observation.canonicalUrl), text(observation.postedAt), text(observation.updatedAt), observedAt, fp, observation.classification === 'direct' ? 'direct' : 'lead', JSON.stringify(observation));
  }
  return { duplicate: false, replaced: Boolean(existingObservation), jobKey, lifecycle: nextLifecycle };
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value) {
  const safeValue = cloneJsonSafe(value, 'stable JSON value');
  if (Array.isArray(safeValue)) return `[${safeValue.map(stableJson).join(',')}]`;
  if (isRecord(safeValue)) return `{${Object.keys(safeValue).sort().map((key) => `${JSON.stringify(key)}:${stableJson(safeValue[key])}`).join(',')}}`;
  return JSON.stringify(safeValue);
}

function mergeManifestValues(current, delta) {
  if (!isRecord(current) || !isRecord(delta)) return delta;
  const merged = { ...current };
  for (const key of Object.keys(delta).sort()) {
    defineJsonProperty(merged, key, isRecord(current[key]) && isRecord(delta[key])
      ? mergeManifestValues(current[key], delta[key])
      : delta[key]);
  }
  return merged;
}

function finiteCount(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function safeContinuationCursor(value, fallback = null) {
  if (value === undefined) return fallback;
  try { return cloneJsonSafe(value, 'continuation cursor'); } catch { return fallback; }
}

function durableSourceProgress(store, runId, sourceId) {
  const row = store.prepare('SELECT observations, duplicates, fetched, changed, details_json FROM source_telemetry WHERE run_id = ? AND source_id = ?')
    .get(runId, sourceId);
  if (!row) return { observations: 0, duplicates: 0, fetched: 0, changed: 0, details: {} };
  return {
    observations: finiteCount(row.observations), duplicates: finiteCount(row.duplicates),
    fetched: finiteCount(row.fetched), changed: finiteCount(row.changed), details: json(row.details_json, {}),
    manifest: json(row.details_json, {}).__manifest ?? json(row.details_json, {}).manifest ?? {},
    checkpointed: json(row.details_json, {}).__checkpointed === true,
  };
}

/** Persist an incremental or final source result through one durable path. */
function persistSourceProgress(store, source, runId, {
  observations = [], cursor, replaceObservations = false,
  manifestDelta = null, observedAt, checkpointed = false,
} = {}) {
  const progress = durableSourceProgress(store, runId, source.id);
  const safeObservations = cloneJsonCollection(observations, 'source observations', { maxBytes: MAX_SOURCE_OBSERVATION_BYTES });
  const safeCursor = cursor === undefined ? undefined : cloneJsonSafe(cursor, 'source cursor');
  const delta = manifestDelta == null ? null : cloneJsonSafe(manifestDelta, 'source manifest');
  if (delta != null && !isRecord(delta)) throw new TypeError('source manifest must be a plain object');
  const deltaKey = delta ? hash(stableJson(delta)) : null;
  const manifestKeys = Array.isArray(progress.details.__manifestDeltaKeys)
    ? progress.details.__manifestDeltaKeys.map(String)
    : [];
  const shouldMergeManifest = delta && !manifestKeys.includes(deltaKey);
  const mergedManifest = shouldMergeManifest
    ? mergeManifestValues(progress.details.__manifest ?? {}, delta)
    : progress.details.__manifest ?? {};
  const nextManifestKeys = shouldMergeManifest ? [...manifestKeys, deltaKey].sort() : manifestKeys;
  let retained = 0;
  let duplicates = 0;

  store.exec('BEGIN');
  try {
    for (const observation of safeObservations) {
      const persisted = persistObservation(store, source, runId, observation, observedAt, { replaceCheckpoint: replaceObservations });
      if (persisted.duplicate) duplicates += 1;
      else if (!persisted.replaced) retained += 1;
    }
    const nextObservations = progress.observations + retained;
    const nextDuplicates = progress.duplicates + duplicates;
    const manifestFetched = finiteCount(delta?.fetched, 0);
    const manifestChanged = finiteCount(delta?.changed, 0);
    const nextFetched = Math.max(progress.fetched, manifestFetched, nextObservations);
    const nextChanged = Math.max(progress.changed, manifestChanged, nextObservations);
    const details = {
      ...progress.details,
      ...(delta && (checkpointed || progress.details.__checkpointed || progress.details.manifest) ? { manifest: mergedManifest } : {}),
      ...(delta ? { __manifest: mergedManifest, __manifestDeltaKeys: nextManifestKeys } : {}),
      ...(checkpointed ? { __checkpointed: true } : {}),
    };
    store.prepare('UPDATE source_telemetry SET fetched = ?, changed = ?, observations = ?, duplicates = ?, details_json = ? WHERE run_id = ? AND source_id = ?')
      .run(nextFetched, nextChanged, nextObservations, nextDuplicates, jsonStringifySafe(details, `source ${source.id} progress`), runId, source.id);
    if (safeCursor !== undefined) {
      const sourceRow = store.prepare('SELECT cursor_json FROM sources WHERE source_id = ?').get(source.id);
      const prior = sourceState(sourceRow?.cursor_json, null);
      store.prepare('UPDATE sources SET cursor_json = ?, updated_at = ? WHERE source_id = ?')
        .run(encodedSourceState(safeCursor, {
          ...(prior.state && prior.state.scanStatus !== 'legacy' ? prior.state : {}),
          scanStatus: 'checkpointed', naturalTerminal: false, truncated: false, checkpointed: true,
        }), observedAt, source.id);
    }
    store.exec('COMMIT');
  } catch (error) {
    store.exec('ROLLBACK');
    throw error;
  }
  return { observations: progress.observations + retained, duplicates: progress.duplicates + duplicates,
    fetched: Math.max(progress.fetched, finiteCount(delta?.fetched, 0), progress.observations + retained),
    changed: Math.max(progress.changed, finiteCount(delta?.changed, 0), progress.observations + retained),
    manifest: mergedManifest, checkpointed: checkpointed || progress.checkpointed };
}

async function abortableSourceFetch(sourcePromise, signal) {
  if (!signal) return sourcePromise;
  if (signal.aborted) {
    const error = signal.reason instanceof Error ? signal.reason : new Error('source aborted');
    error.code ??= 'RUN_ABORTED';
    throw error;
  }
  let timer = null;
  let onAbort = null;
  const finalGuard = new Promise((_, reject) => {
    onAbort = () => {
      // Cooperative adapters get one turn to checkpoint their cursor and
      // telemetry. This race remains only the safety guard for a source that
      // ignores the parent signal entirely.
      timer = setTimeout(() => {
        const reason = signal.reason instanceof Error ? signal.reason.message : 'source aborted';
        const error = new Error(reason);
        error.code = 'RUN_ABORTED';
        reject(error);
      }, 0);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([sourcePromise, finalGuard]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

async function fetchSource(store, source, runId, priorState, config, clock, {
  signal = null, deadline = null, budgetCancellationFired = () => false,
} = {}) {
  const retry = { maxAttempts: 1, baseDelayMs: 250, ...(config.retry ?? {}) };
  const sourceRow = store.prepare('SELECT * FROM sources WHERE source_id = ?').get(source.id);
  const persisted = sourceState(sourceRow?.cursor_json, priorState?.sources?.[source.id]?.cursor ?? null);
  const sourceCapabilities = source.capabilities ?? {};
  const previousState = persisted.state;
  const cursor = sourceCapabilities.newestFirst && !['interrupted', 'truncated', 'checkpointed'].includes(previousState.scanStatus)
    ? null
    : persisted.cursor;
  const telemetry = {
    status: 'running', attempts: 0, fetched: 0, changed: 0, observations: 0,
    startingCursor: cursor,
    continuationCursor: null,
    cursorReset: Boolean(sourceCapabilities.newestFirst && !['interrupted', 'truncated', 'checkpointed'].includes(previousState.scanStatus) && (previousState.scanStatus !== 'legacy' || persisted.cursor != null)),
    cursorContinued: Boolean(cursor != null && ['interrupted', 'truncated', 'checkpointed'].includes(previousState.scanStatus)),
    naturalTerminal: false, interrupted: false, truncated: false, newestPostingAt: null,
    consecutiveZeroNewRuns: 0, capHit: null, recordsNotExamined: null,
  };
  let checkpointTail = Promise.resolve();
  let checkpointOpen = true;
  let checkpointFailure = null;
  const checkpoint = (payload = {}) => {
    if (!checkpointOpen) return Promise.resolve({ ignored: true });
    const { observations = [], cursor, manifestDelta = null, replaceObservations = false } = payload ?? {};
    const operation = checkpointTail.then(() => persistSourceProgress(store, source, runId, {
      observations, cursor, manifestDelta, replaceObservations, observedAt: nowFrom(clock), checkpointed: true,
    }));
    checkpointTail = operation.catch((error) => {
      checkpointFailure ??= error;
    });
    operation.catch(() => {});
    return operation;
  };
  const closeCheckpoints = async () => {
    checkpointOpen = false;
    await checkpointTail;
    if (checkpointFailure) throw checkpointFailure;
  };
  let lastError;
  let validatingOutput = false;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    telemetry.attempts = attempt;
    try {
      const sourcePromise = Promise.resolve().then(() => {
        if (signal?.aborted) {
          const error = signal?.reason instanceof Error ? signal.reason : new Error('crawler source deadline exceeded');
          error.code ??= 'DAILY_DEADLINE_EXCEEDED';
          throw error;
        }
        return source.fetch({ source, runId, cursor, sourceState: previousState, priorState, attempt, config, clock, signal, deadline, checkpoint });
      });
      const result = await abortableSourceFetch(sourcePromise, signal);
      await closeCheckpoints();
      validatingOutput = true;
      if (result?.observations !== undefined && !Array.isArray(result.observations)) throw new TypeError('source result observations must be an array');
      if (result?.manifest !== undefined && result.manifest == null) throw new TypeError('source result manifest must be a plain object');
      const observations = cloneJsonCollection(result?.observations ?? [], 'source result observations', { maxBytes: MAX_SOURCE_OBSERVATION_BYTES });
      const resultCursor = result?.cursor === undefined ? undefined : cloneJsonSafe(result.cursor, 'source result cursor');
      const manifest = cloneJsonSafe(result?.manifest ?? {}, 'source result manifest');
      if (!isRecord(manifest)) throw new TypeError('source result manifest must be a plain object');
      const sourcePlanState = result?.sourcePlanState == null ? null : cloneJsonSafe(result.sourcePlanState, 'source plan state');
      const sourceBudgetExceeded = budgetCancellationFired() || isSourceBudgetCancellation(null, signal)
        || result?.budgetCancellationFired === true || result?.budgetCancelled === true;
      const interrupted = Boolean(result?.interrupted || manifest.interrupted) && !sourceBudgetExceeded;
      const truncated = Boolean(manifest.truncated || sourceBudgetExceeded);
      await checkpointTail;
      const progress = persistSourceProgress(store, source, runId, {
        observations,
        cursor: interrupted || truncated ? resultCursor : undefined,
        manifestDelta: manifest,
        observedAt: nowFrom(clock),
      });
      if (manifest.telemetry && typeof manifest.telemetry === 'object' && !Array.isArray(manifest.telemetry)) {
        telemetry.detail = { telemetry: manifest.telemetry };
      }
      const naturalTerminal = manifest.naturalTerminal ?? (!interrupted && !truncated);
      telemetry.status = sourceBudgetExceeded ? 'truncated' : interrupted ? 'interrupted' : truncated ? 'truncated' : manifest.status === 'failed' ? 'failed' : 'succeeded';
      if (telemetry.status === 'failed') {
        telemetry.error = (manifest.errors || []).join('; ') || 'source reported failed';
        store.prepare(`INSERT INTO source_failures(run_id, source_id, stage, attempt, retry_class, host, status_code, message, created_at)
          VALUES (?, ?, 'fetch', ?, 'terminal', ?, NULL, ?, ?)`).run(runId, source.id, telemetry.attempts, sourceHost(source.url), telemetry.error, nowFrom(clock));
      }
      telemetry.observations = progress.observations;
      telemetry.duplicates = progress.duplicates;
      telemetry.fetched = progress.fetched;
      telemetry.changed = progress.changed;
      if (progress.checkpointed) telemetry.manifest = progress.manifest;
      telemetry.naturalTerminal = Boolean(naturalTerminal);
      telemetry.interrupted = interrupted;
      telemetry.truncated = truncated;
      telemetry.capHit = sourceBudgetExceeded ? 'maxDuration' : manifest.capHit ?? null;
      telemetry.recordsNotExamined = manifest.recordsNotExamined ?? null;
      telemetry.newestPostingAt = newestPostingAt(observations, manifest);
      telemetry.boardPlan = manifest.boardPlan ?? null;
      telemetry.sourcePlanState = sourcePlanState;
      if (sourceBudgetExceeded) telemetry.budgetCancellationFired = true;
      telemetry.consecutiveZeroNewRuns = telemetry.changed === 0 ? Number(previousState.consecutiveZeroNewRuns ?? 0) + 1 : 0;
      const savedCursor = sourceState(store.prepare('SELECT cursor_json FROM sources WHERE source_id = ?').get(source.id)?.cursor_json, cursor).cursor;
      const nextCursor = telemetry.interrupted || telemetry.truncated ? resultCursor ?? savedCursor ?? cursor : null;
      telemetry.continuationCursor = nextCursor;
      store.prepare('UPDATE sources SET cursor_json = ?, updated_at = ? WHERE source_id = ?').run(encodedSourceState(nextCursor, {
        scanStatus: telemetry.interrupted ? 'interrupted' : telemetry.truncated ? 'truncated' : 'completed',
        naturalTerminal: Boolean(naturalTerminal),
        truncated: telemetry.truncated,
        newestPostingAt: telemetry.newestPostingAt,
        consecutiveZeroNewRuns: telemetry.consecutiveZeroNewRuns,
        cursorReset: telemetry.cursorReset,
        cursorContinued: telemetry.cursorContinued,
        ...(sourcePlanState ? { sourcePlanState } : previousState.sourcePlanState ? { sourcePlanState: previousState.sourcePlanState } : {}),
      }), nowFrom(clock), source.id);
      telemetry.checkpointed = progress.checkpointed;
      validatingOutput = false;
      return { telemetry, duplicates: progress.duplicates };
    } catch (error) {
      const finalAttempt = !error?.retryable || attempt >= retry.maxAttempts
        || isSourceBudgetCancellation(error, signal) || isDeadlineCancellation(error, signal, deadline);
      if (finalAttempt) {
        try { await closeCheckpoints(); } catch (checkpointError) { error = checkpointError; }
      } else {
        await checkpointTail;
      }
      lastError = error;
      if (checkpointFailure) lastError = checkpointFailure;
      const invalidDurableOutput = Boolean(checkpointFailure || validatingOutput);
      if (error?.code === 'RUN_ABORTED' && !isSourceBudgetCancellation(error, signal)
        && !isDeadlineCancellation(error, signal, deadline)) {
        const progress = durableSourceProgress(store, runId, source.id);
        telemetry.status = 'failed';
        telemetry.error = error?.message || 'source aborted';
        telemetry.interrupted = true;
        telemetry.naturalTerminal = false;
        telemetry.observations = progress.observations;
        telemetry.duplicates = progress.duplicates;
        telemetry.fetched = progress.fetched;
        telemetry.changed = progress.changed;
        if (progress.checkpointed) telemetry.manifest = progress.manifest;
        telemetry.checkpointed = progress.checkpointed;
        telemetry.continuationCursor = safeContinuationCursor(error?.cursor,
          sourceState(store.prepare('SELECT cursor_json FROM sources WHERE source_id = ?').get(source.id)?.cursor_json, cursor).cursor ?? cursor);
        return { telemetry, duplicates: 0, fatalError: error };
      }
      if (!invalidDurableOutput && isSourceBudgetCancellation(error, signal)) {
        const progress = durableSourceProgress(store, runId, source.id);
        telemetry.status = 'truncated';
        telemetry.error = error?.message || 'source maximum duration exceeded';
        telemetry.truncated = true;
        telemetry.naturalTerminal = false;
        telemetry.capHit = 'maxDuration';
        telemetry.budgetCancellationFired = true;
        telemetry.observations = progress.observations;
        telemetry.duplicates = progress.duplicates;
        telemetry.fetched = progress.fetched;
        telemetry.changed = progress.changed;
        if (progress.checkpointed) telemetry.manifest = progress.manifest;
        telemetry.checkpointed = progress.checkpointed;
        telemetry.continuationCursor = safeContinuationCursor(error?.cursor,
          sourceState(store.prepare('SELECT cursor_json FROM sources WHERE source_id = ?').get(source.id)?.cursor_json, cursor).cursor ?? cursor);
        store.prepare('UPDATE sources SET cursor_json = ?, updated_at = ? WHERE source_id = ?').run(encodedSourceState(telemetry.continuationCursor, {
          scanStatus: 'truncated', naturalTerminal: false, truncated: true, capHit: 'maxDuration',
          ...(previousState.sourcePlanState ? { sourcePlanState: previousState.sourcePlanState } : {}),
        }), nowFrom(clock), source.id);
        return { telemetry, duplicates: 0 };
      }
      if (!invalidDurableOutput && isDeadlineCancellation(error, signal, deadline)) {
        const progress = durableSourceProgress(store, runId, source.id);
        telemetry.status = 'interrupted';
        telemetry.error = error?.message || 'source interrupted';
        telemetry.interrupted = true;
        telemetry.naturalTerminal = false;
        telemetry.observations = progress.observations;
        telemetry.duplicates = progress.duplicates;
        telemetry.fetched = progress.fetched;
        telemetry.changed = progress.changed;
        if (progress.checkpointed) telemetry.manifest = progress.manifest;
        telemetry.checkpointed = progress.checkpointed;
        telemetry.continuationCursor = safeContinuationCursor(error?.cursor,
          sourceState(store.prepare('SELECT cursor_json FROM sources WHERE source_id = ?').get(source.id)?.cursor_json, cursor).cursor ?? cursor);
        store.prepare('UPDATE sources SET cursor_json = ?, updated_at = ? WHERE source_id = ?').run(encodedSourceState(telemetry.continuationCursor, {
          scanStatus: 'interrupted', naturalTerminal: false, interrupted: true,
          ...(previousState.sourcePlanState ? { sourcePlanState: previousState.sourcePlanState } : {}),
        }), nowFrom(clock), source.id);
        return { telemetry, duplicates: 0 };
      }
      if (!error?.retryable || attempt >= retry.maxAttempts) break;
      try {
        await sleepWithSignal(clock, retry.baseDelayMs * (2 ** (attempt - 1)), signal);
      } catch (sleepError) {
        try { await closeCheckpoints(); } catch (checkpointError) { throw checkpointError; }
        throw sleepError;
      }
    }
  }
  const retryClass = lastError?.retryable ? 'retryable_exhausted' : 'terminal';
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  store.prepare(`INSERT INTO source_failures(run_id, source_id, stage, attempt, retry_class, host, status_code, message, created_at)
    VALUES (?, ?, 'fetch', ?, ?, ?, ?, ?, ?)`).run(runId, source.id, telemetry.attempts, retryClass, sourceHost(source.url), lastError?.statusCode ?? null, message, nowFrom(clock));
  telemetry.status = 'failed';
  telemetry.error = message;
  telemetry.interrupted = true;
  telemetry.naturalTerminal = false;
  telemetry.newestPostingAt = null;
  const progress = durableSourceProgress(store, runId, source.id);
  telemetry.observations = progress.observations;
  telemetry.duplicates = progress.duplicates;
  telemetry.fetched = progress.fetched;
  telemetry.changed = progress.changed;
  if (progress.checkpointed) telemetry.manifest = progress.manifest;
  telemetry.checkpointed = progress.checkpointed;
  telemetry.consecutiveZeroNewRuns = Number(previousState.consecutiveZeroNewRuns ?? 0) + 1;
  const failureCursor = safeContinuationCursor(lastError?.cursor, cursor);
  store.prepare('UPDATE sources SET cursor_json = ?, updated_at = ? WHERE source_id = ?').run(encodedSourceState(failureCursor, {
    scanStatus: 'interrupted', naturalTerminal: false, newestPostingAt: null,
    consecutiveZeroNewRuns: telemetry.consecutiveZeroNewRuns,
    ...(previousState.sourcePlanState ? { sourcePlanState: previousState.sourcePlanState } : {}),
  }), nowFrom(clock), source.id);
  return { telemetry, duplicates: 0 };
}

export async function crawlRun({ store, sourcePlans = [], priorState = {}, config = {}, clock = {} , runId, schedule = 'manual', signal = null, deadline = null } = {}) {
  if (!store) throw new TypeError('crawlRun requires an open crawler store');
  if (!runId) throw new TypeError('crawlRun requires runId for durable idempotency');
  const started = startCrawlRun(store, { runId, schedule, config, clock });
  if (started.idempotent) return { ...readCrawlerRunSnapshot(store, runId), idempotent: true, newlyDated: 0 };
  try {
    const at = nowFrom(clock);
    const undatedBefore = Number(store.prepare('SELECT COUNT(*) AS count FROM jobs WHERE original_posted_at IS NULL').get().count);
    backfillOriginalPostedAt(store);
    const planned = config.execution
      ? planSourceBudgets(sourcePlans, config.execution)
      : { plans: sourcePlans, telemetry: null };
    sourcePlans = planned.plans;
    registerSourcePlans(store, runId, sourcePlans, { clock, at });
    if (started.resumed) requeueRuntimeOmissions(store, runId, sourcePlans, { clock });
    const sourceDurations = {};
    const runtimeBudget = config.execution ? planned.budget : null;
    const discoveryStartedAt = monotonicNow(clock);
    let interruptedByDeadline = false;
    let activeSourceId = null;
    const plannedSourceIds = sourcePlans.map((source) => source.id);
    for (const [sourceIndex, source] of sourcePlans.entries()) {
      if (!source?.id || typeof source.fetch !== 'function') throw new TypeError('each source plan requires id and fetch');
      const currentTime = deadline?.wallClock
        ? Date.now()
        : typeof clock?.now === 'function' ? new Date(clock.now()).getTime() : Date.now();
      if (signal?.aborted) {
        const error = signal?.reason instanceof Error ? signal.reason : new Error('crawler source deadline exceeded');
        const preflightAbort = !store.prepare("SELECT 1 FROM source_telemetry WHERE run_id = ? AND status NOT IN ('pending', 'not_started') LIMIT 1").get(runId);
        if (!error.code && /deadline|aborted/i.test(error.message)) error.code = 'DAILY_DEADLINE_EXCEEDED';
        if (preflightAbort && signal.reason) {
          markUnstartedSources(store, runId, plannedSourceIds, { clock });
          throw error;
        }
        if (error.code === 'DAILY_DEADLINE_EXCEEDED') {
          interruptedByDeadline = true;
          break;
        }
        markUnstartedSources(store, runId, plannedSourceIds, { clock });
        throw error;
      }
      const existingSource = store.prepare('SELECT status, attempts FROM source_telemetry WHERE run_id = ? AND source_id = ?').get(runId, source.id);
      if (['succeeded', 'failed', 'truncated', 'omitted_by_runtime'].includes(existingSource?.status)) continue;
      if (existingSource?.status === 'omitted_by_planner') continue;
      if (remainingDeadlineMs(deadline, currentTime) <= 0) {
        interruptedByDeadline = true;
        break;
      }
      const configuredCapMs = source.budget?.maxDurationMs
        ?? (runtimeBudget ? runtimeBudget.perSourceMaxDurationMs : Number(source.maxDurationMs));
      const hasRuntimeCap = Number.isFinite(configuredCapMs) && configuredCapMs > 0;
      const remainingDiscoveryMs = runtimeBudget
        ? Math.min(
          Math.max(0, runtimeBudget.discoveryBudgetMs - (monotonicNow(clock) - discoveryStartedAt)),
          remainingDeadlineMs(deadline, currentTime),
        )
        : null;
      const runtime = runtimeBudget
        ? runtimeSourceBudget(sourcePlans, sourceIndex, store, runId, remainingDiscoveryMs, runtimeBudget.minimumSourceStartAllocationMs, Math.floor(configuredCapMs))
        : null;
      if (runtime && runtime.runtimeAllowanceMs <= 0) {
        updateSourceStatus(store, runId, source.id, 'omitted_by_runtime', {
          clock,
          details: {
            reason: 'runtime-allowance-unavailable',
            initialPlannedAllocationMs: finiteCount(source.budget?.startAllocationMs),
            runtimeAllowanceMs: runtime.runtimeAllowanceMs,
            actualDurationMs: 0,
            unusedMs: 0,
            recycledMs: finiteCount(Math.max(0, runtime.runtimeAllowanceMs - finiteCount(source.budget?.startAllocationMs)), 0),
            laterSourceReserveMs: runtime.laterSourceReserveMs,
            capHit: null,
          },
        });
        continue;
      }
      activeSourceId = source.id;
      const sourceAttempt = Number(existingSource?.attempts ?? 0) + 1;
      const sourceStartedAt = monotonicNow(clock);
      const persistedCursor = sourceState(store.prepare('SELECT cursor_json FROM sources WHERE source_id = ?').get(source.id)?.cursor_json, priorState.sources?.[source.id]?.cursor ?? null).cursor;
      store.prepare('INSERT INTO source_attempts(run_id, source_id, attempt, status, started_at, starting_cursor_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(runId, source.id, sourceAttempt, 'running', at, persistedCursor == null ? null : jsonStringifySafe(persistedCursor, `source ${source.id} starting cursor`));
      updateSourceStatus(store, runId, source.id, 'running', { clock, details: { attempt: sourceAttempt, startingCursor: persistedCursor } });
      store.prepare('UPDATE source_telemetry SET attempts = ? WHERE run_id = ? AND source_id = ?').run(sourceAttempt, runId, source.id);
      const sourceContext = sourceAbortContext(signal, deadline, runtime?.runtimeAllowanceMs ?? (hasRuntimeCap ? Math.floor(configuredCapMs) : Infinity), currentTime, clock);
      let result;
      try {
        result = await fetchSource(store, source, runId, priorState, config, clock, sourceContext);
      } catch (error) {
        sourceDurations[source.id] = Math.max(0, Math.round(monotonicNow(clock) - sourceStartedAt));
        const progress = durableSourceProgress(store, runId, source.id);
        const continuationCursor = safeContinuationCursor(error?.cursor,
          sourceState(store.prepare('SELECT cursor_json FROM sources WHERE source_id = ?').get(source.id)?.cursor_json, persistedCursor).cursor ?? persistedCursor);
        const status = isDeadlineCancellation(error, sourceContext.signal, deadline) ? 'interrupted' : 'failed';
        const failureRuntime = runtime ? {
          initialPlannedAllocationMs: finiteCount(source.budget?.startAllocationMs),
          runtimeAllowanceMs: runtime.runtimeAllowanceMs,
          actualDurationMs: sourceDurations[source.id],
          unusedMs: finiteCount(Math.max(0, runtime.runtimeAllowanceMs - sourceDurations[source.id])),
          recycledMs: finiteCount(Math.max(0, runtime.runtimeAllowanceMs - finiteCount(source.budget?.startAllocationMs))),
          laterSourceReserveMs: runtime.laterSourceReserveMs,
        } : {};
        const details = cloneJsonSafe({
          durationMs: sourceDurations[source.id],
          budget: source.budget ?? null,
          ...failureRuntime,
          startingCursor: persistedCursor,
          continuationCursor,
          fetched: progress.fetched,
          changed: progress.changed,
          observations: progress.observations,
          duplicates: progress.duplicates,
          error: error?.message || String(error),
        }, `source ${source.id} failure telemetry`);
        store.prepare(`UPDATE source_telemetry SET status = ?, fetched = ?, changed = ?, observations = ?, duplicates = ?, details_json = ?, error = ?
          WHERE run_id = ? AND source_id = ?`).run(status, progress.fetched, progress.changed, progress.observations, progress.duplicates,
          JSON.stringify(details), error?.message || String(error), runId, source.id);
        store.prepare('UPDATE source_attempts SET status = ?, finished_at = ?, continuation_cursor_json = ?, error = ?, details_json = ? WHERE run_id = ? AND source_id = ? AND attempt = ?')
          .run(status, nowFrom(clock), continuationCursor == null ? null : jsonStringifySafe(continuationCursor, `source ${source.id} continuation cursor`), error?.message || String(error),
            jsonStringifySafe({ durationMs: sourceDurations[source.id], fetched: progress.fetched, changed: progress.changed, ...failureRuntime }, `source ${source.id} attempt details`), runId, source.id, sourceAttempt);
        activeSourceId = null;
        if (status === 'interrupted') {
          interruptedByDeadline = true;
          break;
        }
        throw error;
      } finally {
        sourceContext.cleanup();
      }
      sourceDurations[source.id] = Math.max(0, Math.round(monotonicNow(clock) - sourceStartedAt));
      const t = result.telemetry;
      if (runtime) {
        const actualDurationMs = finiteCount(sourceDurations[source.id]);
        const unusedMs = finiteCount(Math.max(0, runtime.runtimeAllowanceMs - actualDurationMs));
        t.initialPlannedAllocationMs = finiteCount(source.budget?.startAllocationMs);
        t.runtimeAllowanceMs = runtime.runtimeAllowanceMs;
        t.actualDurationMs = actualDurationMs;
        t.unusedMs = unusedMs;
        t.recycledMs = finiteCount(Math.max(0, runtime.runtimeAllowanceMs - t.initialPlannedAllocationMs));
        t.laterSourceReserveMs = runtime.laterSourceReserveMs;
        if (t.budgetCancellationFired === true && runtime.runtimeAllowanceMs < configuredCapMs) t.capHit = 'runtimeAllowance';
      }
      const recoveryDetails = sourceAttempt > 1 || t.attempts > 1
        ? { attempt: sourceAttempt, retryAttempts: t.attempts }
        : {};
      const durationTelemetry = source.budget ? {
        durationMs: sourceDurations[source.id], budget: source.budget,
        ...(runtime ? {
          initialPlannedAllocationMs: t.initialPlannedAllocationMs,
          runtimeAllowanceMs: t.runtimeAllowanceMs,
          actualDurationMs: t.actualDurationMs,
          unusedMs: t.unusedMs,
          recycledMs: t.recycledMs,
          laterSourceReserveMs: t.laterSourceReserveMs,
        } : {}),
      } : {};
      const sourceDetails = cloneJsonSafe(Object.fromEntries(Object.entries({ ...recoveryDetails, ...durationTelemetry, startingCursor: t.startingCursor, continuationCursor: t.continuationCursor, naturalTerminal: t.naturalTerminal, interrupted: t.interrupted, truncated: t.truncated, newestPostingAt: t.newestPostingAt, cursorReset: t.cursorReset, cursorContinued: t.cursorContinued, consecutiveZeroNewRuns: t.consecutiveZeroNewRuns, capHit: t.capHit, recordsNotExamined: t.recordsNotExamined, boardPlan: t.boardPlan, sourcePlanState: t.sourcePlanState, budgetCancellationFired: t.budgetCancellationFired, ...(t.checkpointed ? { manifest: t.manifest } : {}), detail: t.detail }).filter(([, value]) => value !== undefined)), `source ${source.id} telemetry`);
      store.prepare(`UPDATE source_telemetry SET status = ?, fetched = ?, changed = ?, observations = ?, duplicates = ?, details_json = ?, error = ?
        WHERE run_id = ? AND source_id = ?`).run(t.status, t.fetched, t.changed, t.observations, t.duplicates ?? 0, JSON.stringify(sourceDetails), t.error ?? null, runId, source.id);
      store.prepare('UPDATE source_telemetry SET attempts = ? WHERE run_id = ? AND source_id = ?').run(t.attempts, runId, source.id);
      store.prepare('UPDATE source_attempts SET status = ?, finished_at = ?, continuation_cursor_json = ?, error = ?, details_json = ? WHERE run_id = ? AND source_id = ? AND attempt = ?')
        .run(t.status, nowFrom(clock), t.continuationCursor == null ? null : jsonStringifySafe(t.continuationCursor, `source ${source.id} continuation cursor`), t.error ?? null, jsonStringifySafe({ durationMs: sourceDurations[source.id], fetched: t.fetched, changed: t.changed, ...(runtime ? {
          initialPlannedAllocationMs: t.initialPlannedAllocationMs,
          runtimeAllowanceMs: t.runtimeAllowanceMs,
          actualDurationMs: t.actualDurationMs,
          unusedMs: t.unusedMs,
          recycledMs: t.recycledMs,
          laterSourceReserveMs: t.laterSourceReserveMs,
        } : {}) }, `source ${source.id} attempt details`), runId, source.id, sourceAttempt);
      activeSourceId = null;
      if (result.fatalError) throw result.fatalError;
      if (t.status === 'interrupted') {
        interruptedByDeadline = true;
        break;
      }
    }
    if (interruptedByDeadline) {
      if (activeSourceId) updateSourceStatus(store, runId, activeSourceId, 'interrupted', { clock, details: { reason: 'deadline' } });
      markUnstartedSources(store, runId, plannedSourceIds, { clock });
    }
    const incomplete = store.prepare("SELECT source_id, status FROM source_telemetry WHERE run_id = ? AND status NOT IN ('succeeded', 'truncated', 'interrupted', 'failed', 'omitted_by_planner', 'omitted_by_runtime') ORDER BY source_id").all(runId);
    if (!interruptedByDeadline && incomplete.length) {
      markNotStartedBugSources(store, runId, incomplete.map((row) => row.source_id), { clock });
      throw notStartedBugError(incomplete.map((row) => row.source_id));
    }
    const undatedAfter = Number(store.prepare('SELECT COUNT(*) AS count FROM jobs WHERE original_posted_at IS NULL').get().count);
    const newlyDated = Math.max(0, undatedBefore - undatedAfter);
    const telemetry = telemetryFor(store, runId);
    const counts = Object.values(telemetry).reduce((total, source) => ({
      fetched: total.fetched + source.fetched,
      changed: total.changed + source.changed,
      observations: total.observations + source.observations,
      duplicates: total.duplicates + source.duplicates,
      failed: total.failed + (source.status === 'failed' || source.status === 'interrupted' || source.status === 'truncated' ? 1 : 0),
    }), { fetched: 0, changed: 0, observations: 0, duplicates: 0, failed: 0 });
    const hasRuntimeOmissions = Object.values(telemetry).some((source) => source.status === 'omitted_by_runtime');
    const partial = interruptedByDeadline || hasRuntimeOmissions;
    const status = partial ? 'partial' : counts.failed ? 'completed_with_failures' : 'completed';
    if (partial) {
      finishStage(store, runId, 'fetch', 'interrupted', nowFrom(clock), interruptedByDeadline
        ? 'daily execution deadline exceeded' : 'planned source omitted by runtime');
      markRunAttempt(store, runId, started.attempt, 'partial', { clock });
    } else {
      transitionStage(store, runId, 'fetch', 'committed', { clock });
      transitionStage(store, runId, 'commit', 'running', { clock });
      finishStage(store, runId, 'commit', 'committed', nowFrom(clock));
      markRunAttempt(store, runId, started.attempt, status, { clock });
    }
    finishCrawlRun(store, runId, {
      status,
      counts,
      telemetry: {
        sources: telemetry,
        sourceDurations,
        sourceBudget: planned.telemetry,
        resumable: partial,
        attempt: started.attempt,
      },
      clock,
    });
    return { ...readCrawlerRunSnapshot(store, runId), idempotent: false, resumed: started.resumed, newlyDated };
  } catch (error) {
    const failedRun = failCrawlRun(store, runId, error, { clock });
    error.lastDurableSourceState = readCrawlerRunSnapshot(store, runId);
    error.failedRun = failedRun;
    throw error;
  }
}

// Fill undated jobs from their latest durable dated observation and return the number filled.
export function backfillOriginalPostedAt(store) {
  const result = store.prepare(`UPDATE jobs
    SET original_posted_at = (
      SELECT posted_at FROM job_observations
      WHERE job_observations.job_key = jobs.job_key AND posted_at IS NOT NULL
      ORDER BY observed_at DESC
      LIMIT 1
    )
    WHERE original_posted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM job_observations
        WHERE job_observations.job_key = jobs.job_key AND posted_at IS NOT NULL
      )`).run();
  return Number(result.changes);
}

export function readCrawlerState(store) {
  return {
    schemaVersion: Number(store.prepare("SELECT value FROM crawler_meta WHERE key = 'schema_version'").get()?.value ?? 0),
    sources: store.prepare('SELECT * FROM sources ORDER BY source_id').all().map((row) => { const state = sourceState(row.cursor_json); return { sourceId: row.source_id, lane: row.lane, trustClass: row.trust_class, cursor: state.cursor, scan: state.state }; }),
    companies: store.prepare('SELECT * FROM companies ORDER BY company_key').all().map((row) => ({ companyKey: row.company_key, name: row.name, domain: row.domain })),
    companyBoards: store.prepare('SELECT * FROM company_boards ORDER BY board_key').all().map((row) => ({ boardKey: row.board_key, companyKey: row.company_key, sourceId: row.source_id, provider: row.provider, boardUrl: row.board_url, boardIdentity: row.board_identity })),
    jobs: store.prepare('SELECT * FROM jobs ORDER BY job_key').all().map((row) => ({ jobKey: row.job_key, provider: row.provider, providerJobId: row.provider_job_id, canonicalUrl: row.canonical_url })),
    observations: store.prepare('SELECT * FROM job_observations ORDER BY observation_key').all().map((row) => ({ observationKey: row.observation_key, jobKey: row.job_key, sourceId: row.source_id, runId: row.run_id, classification: row.classification })),
    failures: store.prepare('SELECT * FROM source_failures ORDER BY failure_id').all().map((row) => ({ sourceId: row.source_id, runId: row.run_id, message: row.message })),
  };
}

/** Read the durable detail needed to reconstruct a serialization-safe workflow result. */
function mapJobRow(row) {
  const lifecycleJson = json(row.lifecycle_json, {});
  const lifecycle = row.lifecycle_state || lifecycleJson.state || null;
  return {
    jobKey: row.job_key,
    provider: row.provider,
    providerJobId: row.provider_job_id,
    canonicalUrl: row.canonical_url,
    company: row.company,
    title: row.title,
    location: row.location,
    identityAliases: lifecycleJson.identityAliases || [],
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    fingerprint: row.latest_fingerprint,
    lifecycle,
    lifecycle_state: lifecycle,
    lifecycleJson,
    applicationReady: lifecycleJson.applicationReady === true || lifecycle === LIFECYCLE_STATES.APPLICATION_READY
      || lifecycle === LIFECYCLE_STATES.SURFACED || ACTIONED_STATES.has(lifecycle),
    surfaced: lifecycle === LIFECYCLE_STATES.SURFACED || Boolean(lifecycleJson.surfacedAt),
    surfacedAt: lifecycleJson.surfacedAt || null,
  };
}

export function readCrawlerRunData(store, runId) {
  return {
    jobs: store.prepare('SELECT * FROM jobs ORDER BY job_key').all().map(mapJobRow),
    observations: store.prepare(`SELECT * FROM job_observations
      WHERE run_id = ? ORDER BY observation_key`).all(runId).map((row) => ({
      observationKey: row.observation_key,
      jobKey: row.job_key,
      sourceId: row.source_id,
      runId: row.run_id,
      sourceRecordKey: row.source_record_key,
      canonicalUrl: row.canonical_url,
      postedAt: row.posted_at,
      updatedAt: row.updated_at,
      observedAt: row.observed_at,
      fingerprint: row.fingerprint,
      classification: row.classification,
      raw: json(row.raw_json, {}),
    })),
  };
}

// Preserve the stored recovery identity before considering newly resolved requisition IDs.
export function heldLeadRecoveryIdentity(candidate) {
  const recovery = candidate.evidence?.recovery;
  if (recovery?.identityUrl?.startsWith('url:') || recovery?.identityUrl?.startsWith('requisition:')) return recovery.identityUrl;
  try {
    const identityUrl = new URL(recovery?.identityUrl);
    if (identityUrl.protocol === 'https:') {
      identityUrl.hash = '';
      return `url:${identityUrl.toString()}`;
    }
  } catch {}
  const requisition = recovery?.providerRequisitionKey ?? candidateRequisitionKey(candidate);
  if (requisition) return `requisition:${requisition}`;
  for (const value of [recovery?.originalDiscoveryUrl, candidate.discoveryUrl, candidate.canonicalUrl, candidate.url]) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:') {
        url.hash = '';
        return `url:${url.toString()}`;
      }
    } catch {}
  }
  return null;
}

// Return only canonical HTTPS URLs that can prove a held lead's original identity.
function recoveryUrlKeys(candidate, { includeApplicationUrl = false } = {}) {
  const recovery = candidate.evidence?.recovery;
  const values = [recovery?.originalDiscoveryUrl, candidate.discoveryUrl, candidate.canonicalUrl];
  if (typeof recovery?.identityUrl === 'string' && recovery.identityUrl.startsWith('url:')) {
    values.push(recovery.identityUrl.slice(4));
  }
  if (includeApplicationUrl) values.push(candidate.originalApplicationUrl);
  return [...new Set(values.flatMap((value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') return [];
      url.hash = '';
      return [`url:${url.toString()}`];
    } catch {
      return [];
    }
  }))];
}

// Rebuild due held leads from the existing observation log after a store reopen.
export function readHeldLeadRecoveryState(store, { now = new Date().toISOString() } = {}) {
  // Held rows, and ordinary rows that carry a failed held attempt under evidence.heldAttempt.
  const rows = store.prepare(`SELECT raw_json, observed_at FROM job_observations
    WHERE json_extract(raw_json, '$.evidence.recovery.kind') = 'held-lead-recovery'
      OR json_extract(raw_json, '$.evidence.heldAttempt.kind') = 'held-lead-recovery'
    ORDER BY observed_at DESC, observation_key DESC`).all();
  // Only rows shaped like a resolved ordinary success can retire a held lead. Identity
  // matching stays in JS: requisition keys are normalized there, so raw-column IN lists would miss some matches.
  const successRows = store.prepare(`SELECT raw_json, observed_at FROM job_observations
    WHERE classification = 'direct'
      AND json_extract(raw_json, '$.applicationResolution.status') = 'Resolved Original'
      AND json_extract(raw_json, '$.evidence.fieldSources.company') = 'original-employer-detail'
      AND json_extract(raw_json, '$.evidence.recovery.kind') IS NOT 'held-lead-recovery'
    ORDER BY observed_at DESC, observation_key DESC`).all();
  const ordinarySuccesses = new Map();
  const ordinaryUrlSuccesses = new Map();
  for (const row of successRows) {
    const candidate = json(row.raw_json, null);
    if (!candidate) continue;
    const resolved = candidate.classification === 'direct' && candidate.originalApplicationUrl
      && candidate.applicationResolution?.status === 'Resolved Original'
      && candidate.evidence?.fieldSources?.company === 'original-employer-detail';
    if (!resolved) continue;
    const keys = [candidateRequisitionKey(candidate), ...(candidate.identityAliases ?? [])]
      .filter((key) => typeof key === 'string' && key.includes('|'))
      .map((key) => {
        const separator = key.indexOf('|');
        return candidateRequisitionKey({ provider: key.slice(0, separator), jobId: key.slice(separator + 1) });
      }).filter(Boolean);
    for (const key of keys) {
      if (!ordinarySuccesses.has(key)) ordinarySuccesses.set(key, row.observed_at);
    }
    for (const key of recoveryUrlKeys(candidate, { includeApplicationUrl: true })) {
      if (!ordinaryUrlSuccesses.has(key)) ordinaryUrlSuccesses.set(key, row.observed_at);
    }
  }
  const latest = new Map();
  for (const row of rows) {
    const stored = json(row.raw_json, null);
    if (!stored) continue;
    const candidate = stored.evidence?.recovery?.kind === 'held-lead-recovery' ? stored
      : { ...stored, evidence: { ...stored.evidence, recovery: stored.evidence.heldAttempt } };
    const recovery = candidate.evidence.recovery;
    const identity = heldLeadRecoveryIdentity(candidate);
    if (!identity) continue;
    const previous = latest.get(identity);
    const latestEvaluation = String(recovery.evaluatedAt ?? recovery.attemptedAt ?? row.observed_at);
    const previousEvaluation = previous && String(previous.recovery.evaluatedAt ?? previous.recovery.attemptedAt ?? previous.observedAt);
    if (previous && previousEvaluation >= latestEvaluation) continue;
    latest.set(identity, { candidate, recovery, observedAt: row.observed_at });
  }
  const records = [...latest.entries()].map(([identity, value]) => ({ identity, ...value }));
  const isSuccessful = ({ candidate, recovery }) => recovery.outcome === 'recovered'
    || (!recovery.outcome && candidate.classification === 'direct' && candidate.originalApplicationUrl
      && candidate.applicationResolution?.status === 'Resolved Original'
      && candidate.evidence?.fieldSources?.company === 'original-employer-detail');
  const completedByOrdinaryDiscovery = (record) => {
    const identity = heldLeadRecoveryIdentity(record.candidate);
    // A URL-identity lead can still carry a known requisition; ordinary discovery of either completes it.
    const requisitionKey = identity?.startsWith('requisition:') ? identity.slice('requisition:'.length)
      : record.recovery.providerRequisitionKey ?? candidateRequisitionKey(record.candidate);
    const successTimes = [
      ...(requisitionKey ? [ordinarySuccesses.get(requisitionKey)] : []),
      ...(identity?.startsWith('url:') || !requisitionKey ? recoveryUrlKeys(record.candidate).map((key) => ordinaryUrlSuccesses.get(key)) : []),
    ];
    const latestSuccessAt = successTimes.map((value) => Date.parse(value))
      .filter(Number.isFinite).reduce((latestAt, value) => Math.max(latestAt, value), Number.NEGATIVE_INFINITY);
    const evaluatedAt = String(record.recovery.evaluatedAt ?? record.recovery.attemptedAt ?? record.observedAt);
    const evaluatedTime = Date.parse(evaluatedAt);
    return Number.isFinite(latestSuccessAt) && Number.isFinite(evaluatedTime) && latestSuccessAt > evaluatedTime;
  };
  const eligible = records.filter((record) => {
    if (completedByOrdinaryDiscovery(record)) return false;
    if (isSuccessful(record) || (record.recovery.outcome && record.recovery.outcome !== 'pending')) return false;
    const nextEligibleAt = record.recovery.nextEligibleAt;
    return !nextEligibleAt || !Number.isFinite(Date.parse(nextEligibleAt)) || Date.parse(nextEligibleAt) <= Date.parse(now);
  }).sort((left, right) => Number(left.recovery.attemptCount ?? 0) - Number(right.recovery.attemptCount ?? 0)
    || String(left.recovery.attemptedAt ?? left.observedAt).localeCompare(String(right.recovery.attemptedAt ?? right.observedAt))
    || left.identity.localeCompare(right.identity));
  return {
    eligible: eligible.map(({ candidate }) => candidate),
    waitingCandidates: records.filter((record) => !completedByOrdinaryDiscovery(record) && record.recovery.outcome === 'pending'
      && record.recovery.nextEligibleAt && Date.parse(record.recovery.nextEligibleAt) > Date.parse(now))
      .map(({ candidate }) => candidate),
    identities: records.map(({ identity }) => identity),
    terminalIdentities: records.filter((record) => completedByOrdinaryDiscovery(record) || isSuccessful(record)
      || Boolean(record.recovery.outcome && record.recovery.outcome !== 'pending')).map(({ identity }) => identity),
    waiting: records.filter((record) => !completedByOrdinaryDiscovery(record) && record.recovery.outcome === 'pending'
      && record.recovery.nextEligibleAt && Date.parse(record.recovery.nextEligibleAt) > Date.parse(now)).length,
  };
}
