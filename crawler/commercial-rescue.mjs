/**
 * Bounded, optional commercial inventory rescue.
 *
 * The source is deliberately injected. This module owns the invocation gate,
 * window order, policy filters, caps, and honest telemetry; it does not know
 * how a paid provider or actor is called and it never applies to a job.
 */

const DEFAULTS = Object.freeze({
  targetReserve: 12,
  maxRecords: 50,
  maxCostUsd: 5,
  windows: [24, 168],
});

const asNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

function reserveCount(value) {
  if (Number.isFinite(Number(value))) return Math.max(0, Number(value));
  if (Number.isFinite(Number(value?.verifiedReserve))) return Math.max(0, Number(value.verifiedReserve));
  if (Number.isFinite(Number(value?.counts?.reserve))) return Math.max(0, Number(value.counts.reserve));
  if (Array.isArray(value?.reserve)) return value.reserve.length;
  return 0;
}

function postedAgeHours(record, now) {
  if (Number.isFinite(Number(record?.ageHours))) return Number(record.ageHours);
  const posted = Date.parse(String(record?.postedAt ?? ''));
  const current = Date.parse(String(now));
  if (Number.isNaN(posted) || Number.isNaN(current)) return null;
  return (current - posted) / 3_600_000;
}

function locationText(record) {
  const value = record?.location ?? record?.locations ?? record?.jobLocation ?? '';
  return Array.isArray(value) ? value.join(', ').toLowerCase() : String(value).toLowerCase();
}

function matchesIndiaPune(record, filters) {
  const location = locationText(record);
  const country = String(filters.country ?? 'India').toLowerCase();
  const city = String(filters.city ?? 'Pune').toLowerCase();
  // India-wide roles are valid for the India/Pune lane; a city outside India
  // is not. Pune is retained as an explicit query filter for source adapters.
  return location.includes(country) || location.includes(city);
}

function isAgency(record) {
  return record?.isAgency === true
    || record?.agency === true
    || /staffing|recruit(?:ment|er)|placement|consult(?:ing|ancy)|manpower|outsourc/i.test(
      `${record?.company ?? ''} ${record?.sourceCategory ?? ''}`,
    );
}

function sourceParts(source) {
  if (typeof source === 'function') return { fetch: source, actorId: null, supportsAgencyExclusion: false };
  if (!source || typeof source.fetch !== 'function') return null;
  return {
    fetch: source.fetch.bind(source),
    actorId: source.actorId ?? source.id ?? null,
    supportsAgencyExclusion: source.supportsAgencyExclusion === true
      || source.capabilities?.agencyExclusion === true,
  };
}

function resultRecords(result) {
  return Array.isArray(result) ? result : Array.isArray(result?.records) ? result.records
    : Array.isArray(result?.observations) ? result.observations : [];
}

function failureFor(error, windowHours, actorId) {
  return {
    windowHours,
    actorId,
    code: error?.code || (error?.name === 'AbortError' ? 'timeout' : 'source-failure'),
    message: error?.message || String(error),
  };
}

export function shouldInvokeCommercialRescue({ enabled = false, freeLanesComplete = false, verifiedReserve = 0, targetReserve = DEFAULTS.targetReserve } = {}) {
  return enabled === true && freeLanesComplete === true && reserveCount(verifiedReserve) < asNumber(targetReserve, DEFAULTS.targetReserve);
}

/**
 * Execute the commercial rescue only after the free inventory is complete and
 * its verified reserve is below target. `source.fetch` receives a bounded,
 * provider-neutral request and may return records or { records, costUsd }.
 */
export async function runCommercialRescue({
  enabled = false,
  freeLanesComplete = false,
  verifiedReserve = 0,
  source,
  now = new Date().toISOString(),
  targetReserve = DEFAULTS.targetReserve,
  maxRecords = DEFAULTS.maxRecords,
  maxCostUsd = DEFAULTS.maxCostUsd,
  filters = {},
  windows = DEFAULTS.windows,
} = {}) {
  const target = Math.max(0, asNumber(targetReserve, DEFAULTS.targetReserve));
  const before = Math.max(0, target - reserveCount(verifiedReserve));
  const base = {
    schemaVersion: 'LaunchpadV5CommercialRescueV1',
    invoked: false,
    status: !enabled ? 'disabled' : !freeLanesComplete ? 'free-lanes-incomplete' : 'not-invoked',
    records: [],
    failures: [],
    shortfall: { before, after: before },
    noAutoApply: true,
    telemetry: {
      actorId: null, actors: [], recordsFetched: 0, recordsAccepted: 0,
      costUsd: 0, costCapUsd: Math.max(0, asNumber(maxCostUsd, DEFAULTS.maxCostUsd)),
      recordCap: Math.max(0, asNumber(maxRecords, DEFAULTS.maxRecords)),
      costCapReached: false, recordCapReached: false,
    },
  };
  if (!shouldInvokeCommercialRescue({ enabled, freeLanesComplete, verifiedReserve, targetReserve })) return base;

  const adapter = sourceParts(source);
  if (!adapter) return { ...base, invoked: true, status: 'degraded', failures: [{ code: 'missing-source', message: 'commercial rescue source was not injected' }] };

  const recordCap = Math.max(0, asNumber(maxRecords, DEFAULTS.maxRecords));
  const costCap = Math.max(0, asNumber(maxCostUsd, DEFAULTS.maxCostUsd));
  const accepted = [];
  const seen = new Set();
  const actorTelemetry = [];
  const failures = [];
  const requestedWindows = [...windows].map((window) => Math.max(1, asNumber(window))).filter(Boolean);
  let costUsd = 0;

  for (const windowHours of requestedWindows) {
    if (accepted.length >= Math.min(recordCap, before) || costUsd >= costCap) break;
    const request = {
      windowHours,
      filters: { country: 'India', city: 'Pune', ...filters },
      maxRecords: Math.max(0, Math.min(recordCap - accepted.length, before - accepted.length)),
      maxCostUsd: Math.max(0, costCap - costUsd),
      ...(adapter.supportsAgencyExclusion ? { excludeAgencies: true } : {}),
      noAutoApply: true,
    };
    let response;
    const started = Date.now();
    try {
      response = await adapter.fetch(request);
      const fetched = resultRecords(response);
      const actorId = response?.actorId ?? adapter.actorId;
      const charged = Math.max(0, asNumber(response?.costUsd ?? response?.cost, 0));
      costUsd = Math.min(costCap, costUsd + charged);
      base.telemetry.recordsFetched += fetched.length;
      const actorAcceptedBefore = accepted.length;
      for (const record of fetched) {
        if (accepted.length >= recordCap || accepted.length >= before) break;
        const age = postedAgeHours(record, now);
        const key = record?.canonicalUrl || record?.url || `${record?.company ?? ''}|${record?.title ?? ''}`;
        if (!key || seen.has(key) || age == null || age < 0 || age > windowHours || !matchesIndiaPune(record, request.filters)) continue;
        if (adapter.supportsAgencyExclusion && isAgency(record)) continue;
        seen.add(key); accepted.push(record);
      }
      actorTelemetry.push({ actorId, windowHours, status: 'succeeded', fetched: fetched.length, accepted: accepted.length - actorAcceptedBefore, costUsd: charged, latencyMs: Date.now() - started });
    } catch (error) {
      const failure = failureFor(error, windowHours, adapter.actorId);
      failures.push(failure);
      actorTelemetry.push({ actorId: adapter.actorId, windowHours, status: 'failed', fetched: 0, accepted: 0, costUsd: 0, latencyMs: Date.now() - started, failureReason: failure.code });
    }
  }

  const telemetry = {
    ...base.telemetry,
    actorId: adapter.actorId,
    actors: actorTelemetry,
    recordsAccepted: accepted.length,
    costUsd,
    costCapReached: costUsd >= costCap,
    recordCapReached: accepted.length >= recordCap,
  };
  return {
    ...base,
    invoked: true,
    status: failures.length ? 'degraded' : 'completed',
    records: accepted,
    failures,
    shortfall: { before, after: Math.max(0, before - accepted.length) },
    telemetry,
  };
}

export const executeCommercialRescue = runCommercialRescue;
export const commercialRescue = runCommercialRescue;
export default runCommercialRescue;
