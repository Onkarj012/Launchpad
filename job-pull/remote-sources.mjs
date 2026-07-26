import { CANDIDATE_SCHEMA_VERSION, assertCandidate, candidateDedupKey, canonicalizeUrl, normalizeCandidate } from './candidate.mjs';
import { deriveProvider, recordsFromResult, sourceManifest } from './adapters/common.mjs';
import { fetchHimalayas } from './remote-adapters/himalayas.mjs';
import { fetchJobicy } from './remote-adapters/jobicy.mjs';
import { fetchWeWorkRemotely } from './remote-adapters/weworkremotely.mjs';
import { fetchRemotive } from './remote-adapters/remotive.mjs';
import { fetchRemoteOk } from './remote-adapters/remoteok.mjs';

/** Himalayas is the primary native remote feed; the rest are bounded secondaries. */
export const PRIMARY_REMOTE_PROVIDERS = Object.freeze(['himalayas']);
export const SECONDARY_REMOTE_PROVIDERS = Object.freeze(['jobicy', 'weworkremotely', 'remotive', 'remoteok']);
export const NATIVE_REMOTE_PROVIDERS = Object.freeze([...PRIMARY_REMOTE_PROVIDERS, ...SECONDARY_REMOTE_PROVIDERS]);

export const REMOTE_SOURCE_LANES = Object.freeze([
  { id: 'remote-ats', kind: 'remote-ats', category: 'direct-ats', required: true },
  { id: 'yc', kind: 'yc-startup-board', category: 'startup-board', provider: 'yc', optional: true },
  { id: 'wellfound', kind: 'wellfound', category: 'startup-board', provider: 'wellfound', optional: true },
  { id: 'bounded-remote-search', kind: 'bounded-remote-search', category: 'search', optional: true },
  { id: 'himalayas', kind: 'native-public-feed', category: 'broad-remote', provider: 'himalayas', required: true, role: 'primary' },
  { id: 'jobicy', kind: 'native-public-feed', category: 'broad-remote', provider: 'jobicy', required: true, role: 'secondary' },
  { id: 'weworkremotely', kind: 'native-public-feed', category: 'broad-remote', provider: 'weworkremotely', required: true, role: 'secondary' },
  { id: 'remotive', kind: 'native-public-feed', category: 'broad-remote', provider: 'remotive', required: true, role: 'secondary' },
  { id: 'remoteok', kind: 'native-public-feed', category: 'broad-remote', provider: 'remoteok', required: true, role: 'secondary' },
]);

const NATIVE_ADAPTERS = Object.freeze({
  himalayas: fetchHimalayas,
  jobicy: fetchJobicy,
  weworkremotely: fetchWeWorkRemotely,
  remotive: fetchRemotive,
  remoteok: fetchRemoteOk,
});

/**
 * Select which native remote providers run for a given schedule tick.
 * Himalayas (primary) always runs; secondaries respect secondaryCadenceDays
 * (default 2 = every other UTC day) unless forceAll (explicit --mode remote).
 */
export function selectRemoteProviders({ remoteConfig = {}, runAt, forceAll = false } = {}) {
  const primary = Array.isArray(remoteConfig.primaryProviders) && remoteConfig.primaryProviders.length
    ? remoteConfig.primaryProviders
    : [...PRIMARY_REMOTE_PROVIDERS];
  const secondary = Array.isArray(remoteConfig.secondaryProviders) && remoteConfig.secondaryProviders.length
    ? remoteConfig.secondaryProviders
    : [...SECONDARY_REMOTE_PROVIDERS];
  if (forceAll) return [...new Set([...primary, ...secondary])];
  const cadence = Math.max(1, Number(remoteConfig.secondaryCadenceDays ?? 2));
  const dayIndex = Math.floor(Date.parse(runAt || 0) / 86_400_000);
  const includeSecondary = !Number.isFinite(dayIndex) || dayIndex % cadence === 0;
  return includeSecondary ? [...new Set([...primary, ...secondary])] : [...primary];
}

function errorMessage(error) { return error?.message || String(error); }

function manifestFor(lane, patch = {}) {
  return sourceManifest(lane.id, lane.kind, {
    lane: lane.id,
    sourceCategory: lane.category,
    provider: lane.provider || null,
    remoteLane: true,
    required: lane.required === true,
    optional: lane.optional === true,
    dateField: null,
    dateEvidence: [],
    requestPlan: null,
    pages: [],
    first24hEligible: lane.provider === 'remotive' ? false : true,
    ...patch,
  });
}

function rawRecords(result, lane) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.records)) return result.records;
  if (Array.isArray(result?.candidates)) return result.candidates;
  return recordsFromResult(lane.id, result);
}

function providerEvidence(raw, base, lane) {
  return {
    provider: raw?.provider || base.provider || lane.provider || null,
    dateField: raw?.providerDateField || null,
    dateValue: base.postedAt || null,
    dateEvidence: raw?.providerDateEvidence || null,
    sourceRecord: raw?.providerRecordId || raw?.jobId || raw?.id || null,
  };
}

function normalizeLaneCandidate(raw, lane, { runAt, runId }) {
  const provider = deriveProvider(raw, lane.provider || null);
  const sourceKind = raw?.sourceKind || (lane.category === 'direct-ats' ? 'ats-direct' : 'niche-public');
  const base = raw?.schemaVersion === CANDIDATE_SCHEMA_VERSION
    ? assertCandidate(raw)
    : normalizeCandidate(raw, { source: lane.id, provider, sourceKind, sourceCategory: lane.category, runAt });
  const discoveryUrl = canonicalizeUrl(raw?.discoveryUrl ?? raw?.discoveryURL ?? raw?.url ?? base.canonicalUrl);
  const discoverySource = raw?.discoverySource ?? raw?.source ?? lane.id;
  const discoveryCategory = raw?.discoveryCategory ?? raw?.sourceCategory ?? lane.category;
  const originalEvidence = raw?.originalApplicationEvidence ?? raw?.applicationResolution?.evidence ?? base.applicationResolution?.evidence ?? null;
  const remoteEvidence = {
    scope: raw?.remoteScopeEvidence ?? raw?.remoteEligibilityEvidence ?? base.remoteEligibility?.evidence ?? null,
    citizenship: raw?.citizenshipEvidence ?? raw?.citizenship ?? null,
    country: raw?.countryRestrictionEvidence ?? raw?.countryEvidence ?? null,
    workAuthorization: raw?.workAuthorizationEvidence ?? raw?.authorizationEvidence ?? null,
    payroll: raw?.payrollEvidence ?? raw?.payroll ?? null,
    employment: raw?.employmentStabilityEvidence ?? raw?.contractStabilityEvidence ?? base.employment?.evidence ?? null,
    timezone: raw?.timezoneEvidence ?? raw?.timezoneOverlapEvidence ?? null,
  };
  const feedPublishedAt = raw?.feedPublishedAt ?? base.evidence?.feedPublishedAt ?? null;
  const enriched = {
    ...base,
    source: raw?.source || base.source || lane.id,
    provider: raw?.provider || base.provider || provider || null,
    sourceCategory: raw?.sourceCategory || base.sourceCategory || lane.category,
    discoveryUrl,
    discoverySource,
    discoveryCategory,
    verifiedAt: raw?.verifiedAt ?? raw?.liveness?.checkedAt ?? base.liveness?.checkedAt ?? null,
    originalApplicationEvidence: originalEvidence,
    requirementsEvidence: raw?.requirementsEvidence ?? raw?.evidence?.requirements ?? base.experience?.evidence ?? null,
    remoteLaneId: lane.id,
    remoteProviderPolicy: raw?.remoteProviderPolicy || (lane.provider === 'remotive' ? { first24hEligible: false, reason: 'Remotive inventory is delayed' } : null),
    providerDateEvidence: providerEvidence(raw, base, lane),
    feedPublishedAt,
    remoteEvidence,
    dedupKey: candidateDedupKey(base),
    evidence: {
      ...(base.evidence || {}),
      discovery: { url: discoveryUrl, source: discoverySource, category: discoveryCategory, provider: raw?.provider || base.provider || provider || null },
      originalApplication: originalEvidence,
      providerDate: providerEvidence(raw, base, lane),
      ...(feedPublishedAt ? { feedPublishedAt } : {}),
      remote: remoteEvidence,
      verifiedAt: raw?.verifiedAt ?? raw?.liveness?.checkedAt ?? base.liveness?.checkedAt ?? null,
    },
    runId,
  };
  return assertCandidate(enriched);
}

function normalizeLaneOutput(lane, result, { runAt, runId }) {
  const records = rawRecords(result, lane);
  const candidates = [];
  const errors = [];
  for (const [index, raw] of records.entries()) {
    try { candidates.push(normalizeLaneCandidate(raw, lane, { runAt, runId })); }
    catch (error) { errors.push(`record ${index + 1}: ${errorMessage(error)}`); }
  }
  const supplied = result?.manifest || {};
  const telemetry = result?.telemetry || {};
  const dateEvidence = candidates.map((candidate) => candidate.providerDateEvidence).filter((item) => item?.dateEvidence);
  const status = supplied.status === 'unavailable'
    ? 'unavailable'
    : supplied.status
    ? supplied.status
    : errors.length ? (candidates.length ? 'degraded' : 'failed') : candidates.length ? 'ok' : 'empty';
  return {
    candidates,
    manifest: manifestFor(lane, {
      ...supplied,
      sourceId: lane.id,
      kind: lane.kind,
      status,
      attempted: true,
      fetched: candidates.length,
      dated: candidates.filter((candidate) => candidate.postedAt != null).length,
      failed: Number(supplied.failed || 0) + errors.length,
      dateField: telemetry.dateField || dateEvidence[0]?.dateField || null,
      dateEvidence,
      requestPlan: telemetry.requestPlan || null,
      pages: telemetry.pages || [],
      first24hEligible: telemetry.first24hEligible !== false && lane.provider !== 'remotive',
      errors: [...(Array.isArray(supplied.errors) ? supplied.errors : []), ...errors],
    }),
  };
}

function lookupFunction(functions, lane) {
  if (!functions || typeof functions !== 'object') return null;
  return functions[lane.id] || functions[lane.provider] || null;
}

/** Run every Remote lane using only injected functions, fixtures, or injected native transports. */
export async function runRemoteSourcePlan({ sourceFunctions = {}, sourceFixtures = {}, laneInputs = {}, providerFetchers = {}, runAt, runId } = {}) {
  const results = [];
  for (const lane of REMOTE_SOURCE_LANES) {
    const suppliedFunction = lookupFunction(sourceFunctions, lane);
    const hasFixture = Object.prototype.hasOwnProperty.call(sourceFixtures, lane.id);
    const nativeTransport = lane.provider && providerFetchers[lane.provider];
    const sourceFunction = suppliedFunction
      || (hasFixture ? () => sourceFixtures[lane.id] : null)
      || (nativeTransport && NATIVE_ADAPTERS[lane.provider] ? () => NATIVE_ADAPTERS[lane.provider](nativeTransport) : null);
    if (!sourceFunction) {
      results.push({ candidates: [], manifest: manifestFor(lane, {
        attempted: false,
        status: 'unavailable',
        reasonCode: lane.optional ? 'OPTIONAL_SOURCE_UNAVAILABLE' : 'REMOTE_SOURCE_UNAVAILABLE',
        errors: lane.optional ? [] : ['No injected source function, fixture, or native transport supplied'],
      }) });
      continue;
    }
    try {
      const output = await sourceFunction({ lane, input: laneInputs[lane.id] ?? laneInputs[lane.provider], runAt, runId });
      results.push(normalizeLaneOutput(lane, output, { runAt, runId }));
    } catch (error) {
      results.push({ candidates: [], manifest: manifestFor(lane, { attempted: true, status: 'failed', failed: 1, errors: [errorMessage(error)] }) });
    }
  }
  return results;
}
