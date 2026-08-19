import { CANDIDATE_SCHEMA_VERSION, assertCandidate, canonicalizeUrl, normalizeCandidate } from './candidate.mjs';
import { deriveProvider, recordsFromResult, sourceManifest } from './adapters/common.mjs';

const ATS_PROVIDERS = new Set(['greenhouse', 'lever', 'ashby', 'workday', 'workable', 'smartrecruiters', 'breezy', 'recruitee']);

export const STARTUP_SOURCE_LANES = Object.freeze([
  { id: 'startup-employer-boards', kind: 'startup-employer-board', category: 'direct-company', priority: 100 },
  { id: 'vc-portfolio-boards', kind: 'vc-portfolio', category: 'vc-portfolio', priority: 95 },
  { id: 'yc', kind: 'yc-startup-board', category: 'startup-board', priority: 90 },
  { id: 'wellfound', kind: 'wellfound', category: 'startup-board', priority: 80 },
  { id: 'india-startup-directories', kind: 'india-startup-directory', category: 'india-niche', priority: 75 },
  { id: 'startup-watchlist', kind: 'startup-watchlist', category: 'direct-company', priority: 88 },
  { id: 'funding-hiring-signals', kind: 'funding-hiring-signal', category: 'company-signal', priority: 70 },
]);

function errorMessage(error) { return error?.message || String(error); }

function manifestFor(lane, patch = {}) {
  return sourceManifest(lane.id, lane.kind, {
    lane: lane.id,
    sourceCategory: lane.category,
    priority: lane.priority,
    startupLane: true,
    required: false,
    optional: true,
    companyRecords: 0,
    fundingSignals: 0,
    hiringSignals: 0,
    ...patch,
  });
}

function jobRecords(result, lane) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.records)) return result.records;
  if (Array.isArray(result?.candidates) || Array.isArray(result?.jobs) || Array.isArray(result?.offers)) {
    return recordsFromResult(lane.id, result);
  }
  // Signal-only lanes are allowed to return companyRecords/signals without
  // pretending those records are job postings.
  if (result && typeof result === 'object' && (
    Array.isArray(result.companyRecords) || Array.isArray(result.companies)
    || Array.isArray(result.signals) || Array.isArray(result.fundingSignals)
    || Array.isArray(result.hiringSignals)
  )) return [];
  if (result == null) return [];
  return recordsFromResult(lane.id, result);
}

function metadataRecords(result, keys) {
  for (const key of keys) if (Array.isArray(result?.[key])) return result[key];
  return [];
}

function normalizeLaneCandidate(raw, lane, { runAt, runId }) {
  const provider = deriveProvider(raw, raw?.provider || null);
  const sourceKind = raw?.sourceKind || (lane.category === 'direct-company' && ATS_PROVIDERS.has(provider) ? 'ats-direct' : 'aggregator');
  const input = raw?.company && typeof raw.company === 'object'
    ? { ...raw, company: raw.company.name || raw.company.companyName }
    : raw;
  const base = input?.schemaVersion === CANDIDATE_SCHEMA_VERSION
    ? assertCandidate(input)
    : normalizeCandidate(input, {
      source: lane.id,
      provider,
      sourceKind,
      sourceCategory: lane.category,
      runAt,
    });
  const discoveryUrl = canonicalizeUrl(raw?.discoveryUrl ?? raw?.discoveryURL ?? raw?.url ?? base.canonicalUrl);
  const discoverySource = raw?.discoverySource ?? raw?.source ?? lane.id;
  const discoveryCategory = raw?.discoveryCategory ?? raw?.sourceCategory ?? lane.category;
  const originalEvidence = raw?.originalApplicationEvidence
    ?? raw?.applicationResolution?.evidence
    ?? base.applicationResolution?.evidence
    ?? null;
  const verifiedAt = raw?.verifiedAt ?? raw?.liveness?.checkedAt ?? base.liveness?.checkedAt ?? null;
  const applicationResolution = base.sourceKind === 'ats-direct' && base.applicationResolution?.status === 'Resolved Original' && !originalEvidence
    ? { ...base.applicationResolution, status: 'Direct ATS' }
    : base.applicationResolution;
  return assertCandidate({
    ...base,
    source: raw?.source || base.source || lane.id,
    provider: raw?.provider || base.provider || provider || null,
    sourceCategory: raw?.sourceCategory || base.sourceCategory || lane.category,
    discoveryUrl,
    discoverySource,
    discoveryCategory,
    verifiedAt,
    originalApplicationEvidence: originalEvidence,
    applicationResolution,
    startupLaneId: lane.id,
    startupSourcePriority: lane.priority,
    evidence: {
      ...(base.evidence || {}),
      discovery: { url: discoveryUrl, source: discoverySource, category: discoveryCategory, provider: raw?.provider || base.provider || provider || null },
      originalApplication: originalEvidence,
      verifiedAt,
    },
    runId,
  });
}

function normalizeLaneOutput(lane, result, { runAt, runId }) {
  const records = jobRecords(result, lane);
  const candidates = [];
  const errors = [];
  for (const [index, raw] of records.entries()) {
    try { candidates.push(normalizeLaneCandidate(raw, lane, { runAt, runId })); }
    catch (error) { errors.push(`record ${index + 1}: ${errorMessage(error)}`); }
  }
  const companyRecords = metadataRecords(result, ['companyRecords', 'companies']);
  const fundingSignals = metadataRecords(result, ['fundingSignals', 'signals']);
  const hiringSignals = metadataRecords(result, ['hiringSignals']);
  const supplied = result?.manifest || {};
  const hasMetadata = companyRecords.length || fundingSignals.length || hiringSignals.length;
  const status = supplied.status === 'unavailable'
    ? 'unavailable'
    : supplied.status
    ? supplied.status
    : errors.length ? (candidates.length || hasMetadata ? 'degraded' : 'failed') : candidates.length || hasMetadata ? 'ok' : 'empty';
  return {
    candidates,
    companyRecords,
    fundingSignals,
    hiringSignals,
    manifest: manifestFor(lane, {
      ...supplied,
      sourceId: lane.id,
      kind: lane.kind,
      status,
      attempted: true,
      fetched: candidates.length,
      failed: Number(supplied.failed || 0) + errors.length,
      companyRecords: companyRecords.length,
      fundingSignals: fundingSignals.length,
      hiringSignals: hiringSignals.length,
      errors: [...(Array.isArray(supplied.errors) ? supplied.errors : []), ...errors],
    }),
  };
}

function lookupFunction(functions, lane) {
  if (!functions || typeof functions !== 'object') return null;
  return functions[lane.id] || functions[lane.kind] || null;
}

/** Run all Startup lanes using only injected functions or deterministic fixtures. */
export async function runStartupSourcePlan({ sourceFunctions = {}, sourceFixtures = {}, laneInputs = {}, runAt, runId } = {}) {
  const results = [];
  for (const lane of STARTUP_SOURCE_LANES) {
    const suppliedFunction = lookupFunction(sourceFunctions, lane);
    const hasFixture = Object.prototype.hasOwnProperty.call(sourceFixtures, lane.id);
    const sourceFunction = suppliedFunction || (hasFixture ? () => sourceFixtures[lane.id] : null);
    if (!sourceFunction) {
      results.push({ candidates: [], companyRecords: [], fundingSignals: [], hiringSignals: [], manifest: manifestFor(lane, {
        attempted: false,
        status: 'unavailable',
        reasonCode: 'STARTUP_SOURCE_UNAVAILABLE',
        errors: ['No injected source function or fixture supplied'],
      }) });
      continue;
    }
    try {
      const output = await sourceFunction({ lane, input: laneInputs[lane.id] ?? laneInputs[lane.kind], runAt, runId });
      results.push(normalizeLaneOutput(lane, output, { runAt, runId }));
    } catch (error) {
      results.push({ candidates: [], companyRecords: [], fundingSignals: [], hiringSignals: [], manifest: manifestFor(lane, {
        attempted: true,
        status: 'failed',
        failed: 1,
        errors: [errorMessage(error)],
      }) });
    }
  }
  return results;
}
