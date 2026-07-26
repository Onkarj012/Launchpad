const TIMEZONE = 'Asia/Kolkata';
const SCHEDULES = new Set(['morning', 'midday']);
const RUN_STATES = new Set(['running', 'partial', 'resumed', 'failed', 'completed', 'skipped']);

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value) => value == null ? '' : String(value);

function dateInIndia(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('date must be a valid Date or ISO timestamp');
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function normalizeSchedule(schedule) {
  const value = text(schedule).trim().toLowerCase();
  if (!SCHEDULES.has(value)) throw new RangeError(`Unsupported schedule: ${text(schedule)}`);
  return value;
}

/** Return the stable daily identity used by both local schedule windows. */
export function dailyRunIdentity({ schedule, at = new Date() } = {}) {
  return `${normalizeSchedule(schedule)}-${dateInIndia(at)}`;
}

export const deterministicDailyRunId = dailyRunIdentity;

function runDate(run) {
  if (!run) return null;
  if (run.runDate) return text(run.runDate).slice(0, 10);
  if (run.date) return text(run.date).slice(0, 10);
  const match = text(run.runId).match(/(?:morning|midday)[-.](\d{4}-\d{2}-\d{2})$/i);
  return match?.[1] || (run.startedAt ? dateInIndia(run.startedAt) : null);
}

/**
 * Classify a scheduled invocation without looking at the network or installing a timer.
 * A completed current-day run is fresh; an incomplete current-day run is resumed.
 * An explicitly skipped run is skipped. A missed prior-day run is caught-up when the
 * caller asks to recover it, otherwise it is skipped once a newer daily identity exists.
 */
export function classifyScheduleRun({ schedule, now = new Date(), lastRun = null, state = {} } = {}) {
  const normalizedSchedule = normalizeSchedule(schedule);
  const today = dateInIndia(now);
  const identity = dailyRunIdentity({ schedule: normalizedSchedule, at: now });
  const prior = lastRun && typeof lastRun === 'object' ? lastRun : {};
  const priorDate = runDate(prior);
  const priorStatus = text(prior.status).toLowerCase();
  const requestedRecovery = state.recoverMissed === true || state.catchUp === true;

  if (prior.runId === identity && ['running', 'partial', 'resumed', 'failed'].includes(priorStatus)) {
    return { status: 'resumed', schedule: normalizedSchedule, runId: identity, runDate: today, reason: 'incomplete current daily run' };
  }
  if (prior.runId === identity && priorStatus === 'skipped') {
    return { status: 'skipped', schedule: normalizedSchedule, runId: identity, runDate: today, reason: 'current daily run was explicitly skipped' };
  }
  if (prior.runId === identity || (priorDate === today && priorStatus === 'completed')) {
    return { status: 'fresh', schedule: normalizedSchedule, runId: identity, runDate: today, reason: 'current daily run is complete or ready' };
  }
  if (priorDate && priorDate < today) {
    const status = requestedRecovery ? 'caught-up' : 'skipped';
    return { status, schedule: normalizedSchedule, runId: identity, runDate: today, missedRunId: prior.runId || null, reason: requestedRecovery ? 'recovering a missed daily run' : 'missed daily run requires explicit recovery' };
  }
  return { status: 'fresh', schedule: normalizedSchedule, runId: identity, runDate: today, reason: 'no current daily run exists' };
}

export const classifyMissedRun = classifyScheduleRun;

const COUNTER_FIELDS = new Set([
  'rawFetched', 'fetched', 'discarded', 'resolved', 'resolution', 'gated',
  'ready', 'verification', 'rejected', 'selected', 'duplicates', 'requests',
  'foreignDiscardedAtSource', 'targetTitle', 'experienceCompatible', 'active',
]);

function sourceKey(detail, fallback = 'unknown') {
  return text(detail?.sourceId || detail?.source || detail?.board || detail?.provider || fallback).trim() || fallback;
}

function addCounters(target, value) {
  if (!value || typeof value !== 'object') return target;
  for (const [key, item] of Object.entries(value)) {
    if (COUNTER_FIELDS.has(key) && Number.isFinite(Number(item))) target[key] = number(target[key]) + Number(item);
  }
  return target;
}

function detailsFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.entries(value).map(([sourceId, detail]) => ({ sourceId, ...(detail || {}) }));
  return [];
}

/** Merge additive source telemetry while retaining every resumed segment. */
export function mergeSourceYieldDetails(previous = {}, current = {}) {
  const priorDetails = detailsFrom(previous.sources || previous.details || previous);
  const nextDetails = detailsFrom(current.sources || current.details || current);
  const rows = new Map();
  for (const detail of [...priorDetails, ...nextDetails]) {
    const key = sourceKey(detail);
    const row = rows.get(key) || { sourceId: key, segments: [] };
    const nestedSegments = Array.isArray(detail?.segments) ? detail.segments : [];
    const segment = { ...detail };
    delete segment.segments;
    if (nestedSegments.length) row.segments.push(...nestedSegments.map((item) => ({ ...item })));
    else row.segments.push({ ...segment });
    addCounters(row, detail);
    for (const [field, value] of Object.entries(detail || {})) {
      if (!COUNTER_FIELDS.has(field) && field !== 'sourceId' && field !== 'source' && field !== 'segments' && row[field] == null) row[field] = value;
    }
    rows.set(key, row);
  }
  const totals = {};
  addCounters(totals, previous.totals);
  addCounters(totals, current.totals);
  if (!Object.keys(totals).length) for (const row of rows.values()) addCounters(totals, row);
  return {
    schemaVersion: current.schemaVersion || previous.schemaVersion || 'LaunchpadSourceYieldV1',
    sources: [...rows.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    totals,
    segments: [...rows.values()].flatMap((row) => row.segments),
  };
}

export function buildScheduleHealth({ lastRun = null, durationMs = 0, sourceFailures = [], counts = {}, state = {} } = {}) {
  const schedule = lastRun?.schedule || state.schedule || 'morning';
  const classification = classifyScheduleRun({ schedule, now: state.now || new Date(), lastRun, state });
  const normalizedCounts = {
    ready: number(counts.ready ?? counts.applicationReady),
    verification: number(counts.verification ?? counts.verificationQueue),
    rejected: number(counts.rejected),
  };
  return {
    schemaVersion: 'LaunchpadScheduleHealthV1',
    schedule,
    runId: lastRun?.runId || classification.runId,
    status: classification.status,
    state: classification.status,
    durationMs: number(durationMs),
    sourceFailures: Array.isArray(sourceFailures) ? sourceFailures.length : number(sourceFailures),
    counts: normalizedCounts,
    noAutoApply: true,
    noAutoSend: true,
    noResumeGeneration: true,
  };
}

export { TIMEZONE };
