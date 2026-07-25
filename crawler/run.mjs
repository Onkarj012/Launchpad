import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import {
  ACTIONED_STATES,
  LIFECYCLE_STATES,
  lifecycleFromObservation,
  mergeLifecycleState,
  SURFACED_SUPPRESSION_STATES,
} from './identity.mjs';

const SCHEMA_VERSION = 2;
const TERMINAL_RUN_STATES = new Set(['completed', 'completed_with_failures', 'failed']);
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

CREATE INDEX IF NOT EXISTS idx_job_observations_run ON job_observations(run_id);
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
  db.prepare(`INSERT INTO crawler_meta(key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
  for (let version = 1; version <= SCHEMA_VERSION; version += 1) {
    db.prepare('INSERT OR IGNORE INTO crawler_migrations(version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
  }
  return db;
}

const json = (value, fallback) => {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

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
  return Object.fromEntries(db.prepare('SELECT * FROM source_telemetry WHERE run_id = ? ORDER BY source_id').all(runId).map((row) => [row.source_id, {
    status: row.status,
    attempts: row.attempts,
    observations: row.observations,
    changed: row.changed,
    duplicates: row.duplicates,
    ...(row.fetched == null ? {} : { fetched: row.fetched }),
    ...json(row.details_json, {}),
    ...(row.error ? { error: row.error } : {}),
  }]));
}

function sourceState(value, fallback = null) {
  const parsed = typeof value === 'string' ? json(value, null) : value;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.scanStatus === 'string') {
    return { cursor: ['interrupted', 'truncated'].includes(parsed.scanStatus) ? parsed.cursor ?? null : null, state: parsed };
  }
  return { cursor: fallback ?? parsed ?? null, state: { scanStatus: 'legacy' } };
}

function encodedSourceState(cursor, state) {
  return JSON.stringify({ version: 1, cursor: cursor ?? null, ...state });
}

function newestPostingAt(observations, manifest) {
  const values = observations.map((observation) => observation.postedAt).filter(Boolean).sort();
  return manifest?.newestPostingAt ?? values.at(-1) ?? null;
}

function snapshot(db, runId) {
  const run = runRow(db, runId);
  return { run, stages: stagesFor(db, runId), telemetry: { sources: telemetryFor(db, runId) }, failures: db.prepare('SELECT * FROM source_failures WHERE run_id = ? ORDER BY failure_id').all(runId).map((row) => ({ sourceId: row.source_id, stage: row.stage, attempt: row.attempt, retryClass: row.retry_class, message: row.message })) };
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

export function startCrawlRun(store, { runId, schedule = 'manual', config = {}, clock } = {}) {
  const at = nowFrom(clock);
  const existing = runRow(store, runId);
  if (existing) return { run: existing, idempotent: TERMINAL_RUN_STATES.has(existing.status) };
  store.exec('BEGIN');
  try {
    store.prepare(`INSERT INTO crawl_runs(run_id, schedule, status, stage, started_at, counts_json, telemetry_json, config_json)
      VALUES (?, ?, 'running', 'fetch', ?, '{}', '{}', ?)`).run(runId, schedule, at, JSON.stringify(config));
    for (const stage of STAGES) store.prepare('INSERT INTO crawl_run_stages(run_id, stage, status) VALUES (?, ?, ?)' ).run(runId, stage, stage === 'fetch' ? 'running' : 'pending');
    store.exec('COMMIT');
  } catch (error) {
    store.exec('ROLLBACK');
    throw error;
  }
  return { run: runRow(store, runId), idempotent: false };
}

export function transitionStage(store, runId, stage, status, { clock, error = null } = {}) {
  const at = nowFrom(clock);
  if (status === 'running') beginStage(store, runId, stage, at);
  else finishStage(store, runId, stage, status, at, error);
  return stagesFor(store, runId)[stage];
}

export function finishCrawlRun(store, runId, { status = 'completed', counts = {}, telemetry = {}, clock, error = null } = {}) {
  const at = nowFrom(clock);
  store.prepare('UPDATE crawl_runs SET status = ?, stage = ?, finished_at = ?, error = ?, counts_json = ?, telemetry_json = ? WHERE run_id = ?').run(status, 'complete', at, error, JSON.stringify(counts), JSON.stringify(telemetry), runId);
  return runRow(store, runId);
}

export function failCrawlRun(store, runId, error, { clock } = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const current = runRow(store, runId);
  if (current?.stage && current.stage !== 'complete') finishStage(store, runId, current.stage, 'failed', nowFrom(clock), message);
  return finishCrawlRun(store, runId, { status: 'failed', counts: {}, clock, error: message });
}

function sourceRecordKey(observation) {
  return text(observation.sourceRecordKey ?? observation.providerJobId ?? observation.canonicalUrl) ?? hash(JSON.stringify(observation));
}

function fingerprint(observation) {
  return text(observation.fingerprint) ?? hash(normalized(observation.description));
}

function findJob(db, source, observation) {
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
    .run(merged, JSON.stringify(nextJson), jobKey);
  return merged;
}

export function markJobsSurfaced(store, jobKeys, { at = new Date().toISOString() } = {}) {
  const keys = [...new Set((Array.isArray(jobKeys) ? jobKeys : []).filter(Boolean))];
  for (const jobKey of keys) updateJobLifecycle(store, jobKey, LIFECYCLE_STATES.SURFACED, { at });
  return keys.length;
}

function persistObservation(store, source, runId, observation, observedAt) {
  const sourceKey = sourceRecordKey(observation);
  const observationKey = hash(`${runId}|${source.id}|${sourceKey}`);
  const existingObservation = store.prepare('SELECT observation_key FROM job_observations WHERE observation_key = ?').get(observationKey);
  if (existingObservation) return { duplicate: true, jobKey: null };
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
  store.prepare(`INSERT INTO job_observations(observation_key, job_key, source_id, run_id, source_record_key, canonical_url, posted_at, updated_at, observed_at, fingerprint, classification, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(observationKey, jobKey, source.id, runId, sourceKey, text(observation.canonicalUrl), text(observation.postedAt), text(observation.updatedAt), observedAt, fp, observation.classification === 'direct' ? 'direct' : 'lead', JSON.stringify(observation));
  return { duplicate: false, jobKey, lifecycle: nextLifecycle };
}

async function fetchSource(store, source, runId, priorState, config, clock) {
  const retry = { maxAttempts: 1, baseDelayMs: 250, ...(config.retry ?? {}) };
  const sourceRow = store.prepare('SELECT * FROM sources WHERE source_id = ?').get(source.id);
  const persisted = sourceState(sourceRow?.cursor_json, priorState?.sources?.[source.id]?.cursor ?? null);
  const sourceCapabilities = source.capabilities ?? {};
  const previousState = persisted.state;
  const cursor = sourceCapabilities.newestFirst && !['interrupted', 'truncated'].includes(previousState.scanStatus)
    ? null
    : persisted.cursor;
  const telemetry = {
    status: 'running', attempts: 0, fetched: 0, changed: 0, observations: 0,
    startingCursor: cursor,
    continuationCursor: null,
    cursorReset: Boolean(sourceCapabilities.newestFirst && !['interrupted', 'truncated'].includes(previousState.scanStatus) && (previousState.scanStatus !== 'legacy' || persisted.cursor != null)),
    cursorContinued: Boolean(cursor != null && ['interrupted', 'truncated'].includes(previousState.scanStatus)),
    naturalTerminal: false, interrupted: false, truncated: false, newestPostingAt: null,
    consecutiveZeroNewRuns: 0, capHit: null, recordsNotExamined: null,
  };
  let lastError;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    telemetry.attempts = attempt;
    try {
      const result = await source.fetch({ source, runId, cursor, priorState, attempt, config, clock });
      const observations = Array.isArray(result?.observations) ? result.observations : [];
      let duplicates = 0;
      for (const observation of observations) if (persistObservation(store, source, runId, observation, nowFrom(clock)).duplicate) duplicates += 1;
      const manifest = result?.manifest ?? {};
      const interrupted = Boolean(result?.interrupted || manifest.interrupted);
      const naturalTerminal = manifest.naturalTerminal ?? (!interrupted && !manifest.truncated);
      telemetry.status = interrupted ? 'interrupted' : manifest.truncated ? 'truncated' : 'succeeded';
      telemetry.observations = observations.length;
      telemetry.duplicates = duplicates;
      telemetry.fetched = Number(manifest.fetched ?? observations.length);
      telemetry.changed = Number(manifest.changed ?? observations.length - duplicates);
      telemetry.naturalTerminal = Boolean(naturalTerminal);
      telemetry.interrupted = interrupted;
      telemetry.truncated = Boolean(manifest.truncated);
      telemetry.capHit = manifest.capHit ?? null;
      telemetry.recordsNotExamined = manifest.recordsNotExamined ?? null;
      telemetry.newestPostingAt = newestPostingAt(observations, manifest);
      telemetry.consecutiveZeroNewRuns = telemetry.changed === 0 ? Number(previousState.consecutiveZeroNewRuns ?? 0) + 1 : 0;
      const nextCursor = interrupted || manifest.truncated ? result?.cursor ?? cursor : null;
      telemetry.continuationCursor = nextCursor;
      store.prepare('UPDATE sources SET cursor_json = ?, updated_at = ? WHERE source_id = ?').run(encodedSourceState(nextCursor, {
        scanStatus: interrupted ? 'interrupted' : manifest.truncated ? 'truncated' : 'completed',
        naturalTerminal: Boolean(naturalTerminal),
        truncated: Boolean(manifest.truncated),
        newestPostingAt: telemetry.newestPostingAt,
        consecutiveZeroNewRuns: telemetry.consecutiveZeroNewRuns,
        cursorReset: telemetry.cursorReset,
        cursorContinued: telemetry.cursorContinued,
      }), nowFrom(clock), source.id);
      return { telemetry, duplicates };
    } catch (error) {
      lastError = error;
      if (!error?.retryable || attempt >= retry.maxAttempts) break;
      await clockSleep(clock, retry.baseDelayMs * (2 ** (attempt - 1)));
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
  telemetry.consecutiveZeroNewRuns = Number(previousState.consecutiveZeroNewRuns ?? 0) + 1;
  store.prepare('UPDATE sources SET cursor_json = ?, updated_at = ? WHERE source_id = ?').run(encodedSourceState(lastError?.cursor ?? cursor, {
    scanStatus: 'interrupted', naturalTerminal: false, newestPostingAt: null,
    consecutiveZeroNewRuns: telemetry.consecutiveZeroNewRuns,
  }), nowFrom(clock), source.id);
  return { telemetry, duplicates: 0 };
}

export async function crawlRun({ store, sourcePlans = [], priorState = {}, config = {}, clock = {} , runId, schedule = 'manual' } = {}) {
  if (!store) throw new TypeError('crawlRun requires an open crawler store');
  if (!runId) throw new TypeError('crawlRun requires runId for durable idempotency');
  const started = startCrawlRun(store, { runId, schedule, config, clock });
  if (started.idempotent) return { ...snapshot(store, runId), idempotent: true, newlyDated: 0 };
  try {
    const at = nowFrom(clock);
    const undatedBefore = Number(store.prepare('SELECT COUNT(*) AS count FROM jobs WHERE original_posted_at IS NULL').get().count);
    backfillOriginalPostedAt(store);
    const sourceDurations = {};
    for (const source of sourcePlans) {
      if (!source?.id || typeof source.fetch !== 'function') throw new TypeError('each source plan requires id and fetch');
      const initialCursor = priorState.sources?.[source.id]?.cursor;
      store.prepare(`INSERT INTO sources(source_id, lane, trust_class, capabilities_json, rate_policy_json, cursor_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET lane = excluded.lane, trust_class = excluded.trust_class, capabilities_json = excluded.capabilities_json, rate_policy_json = excluded.rate_policy_json, updated_at = excluded.updated_at`).run(source.id, source.lane ?? 'unknown', source.trustClass ?? 'unknown', JSON.stringify(source.capabilities ?? {}), JSON.stringify(source.ratePolicy ?? {}), initialCursor == null ? null : JSON.stringify(initialCursor), at);
      if (!store.prepare('SELECT 1 FROM source_telemetry WHERE run_id = ? AND source_id = ? AND status = ?').get(runId, source.id, 'succeeded')) {
        const sourceStartedAt = performance.now();
        const result = await fetchSource(store, source, runId, priorState, config, clock);
        sourceDurations[source.id] = Math.max(0, Math.round(performance.now() - sourceStartedAt));
        const t = result.telemetry;
        store.prepare(`INSERT INTO source_telemetry(run_id, source_id, status, attempts, fetched, changed, observations, duplicates, details_json, error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, source_id) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, fetched = excluded.fetched, changed = excluded.changed, observations = excluded.observations, duplicates = excluded.duplicates, details_json = excluded.details_json, error = excluded.error`).run(runId, source.id, t.status, t.attempts, t.fetched, t.changed, t.observations, t.duplicates ?? 0, JSON.stringify({ startingCursor: t.startingCursor, continuationCursor: t.continuationCursor, naturalTerminal: t.naturalTerminal, interrupted: t.interrupted, truncated: t.truncated, newestPostingAt: t.newestPostingAt, cursorReset: t.cursorReset, cursorContinued: t.cursorContinued, consecutiveZeroNewRuns: t.consecutiveZeroNewRuns, capHit: t.capHit, recordsNotExamined: t.recordsNotExamined }), t.error ?? null);
      }
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
    transitionStage(store, runId, 'fetch', 'committed', { clock });
    transitionStage(store, runId, 'commit', 'running', { clock });
    finishStage(store, runId, 'commit', 'committed', nowFrom(clock));
    finishCrawlRun(store, runId, { status: counts.failed ? 'completed_with_failures' : 'completed', counts, telemetry: { sources: telemetry, sourceDurations }, clock });
    return { ...snapshot(store, runId), idempotent: false, newlyDated };
  } catch (error) {
    failCrawlRun(store, runId, error, { clock });
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
