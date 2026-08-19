import { CANDIDATE_SCHEMA_VERSION, assertCandidate, candidateDedupKey, canonicalizeUrl, normalizeCandidate } from './candidate.mjs';
import { recordsFromResult, sourceManifest } from './adapters/common.mjs';

const LEGACY_NORMAL_SOURCE_LANES = [
  { id: 'tracked-ats', kind: 'tracked-ats', category: 'direct-ats', required: true },
  { id: 'reverse-ats-warm', kind: 'reverse-ats-warm', category: 'direct-ats', required: true },
  { id: 'portal-naukri', kind: 'india-portal-search', category: 'aggregator', provider: 'naukri', optional: true, reasonCode: 'PORTAL_REQUIRES_LIVE_INJECTION' },
  { id: 'portal-foundit', kind: 'india-portal-search', category: 'aggregator', provider: 'foundit', optional: true, reasonCode: 'PORTAL_REQUIRES_LIVE_INJECTION' },
  { id: 'portal-hirist', kind: 'india-portal-search', category: 'aggregator', provider: 'hirist', optional: true, reasonCode: 'PORTAL_REQUIRES_LIVE_INJECTION' },
  { id: 'portal-cutshort', kind: 'india-portal-search', category: 'aggregator', provider: 'cutshort', optional: true, reasonCode: 'PORTAL_REQUIRES_LIVE_INJECTION' },
  { id: 'portal-instahyre', kind: 'india-portal-search', category: 'aggregator', provider: 'instahyre', optional: true, reasonCode: 'PORTAL_REQUIRES_LIVE_INJECTION' },
  { id: 'portal-peerlist', kind: 'india-portal-search', category: 'aggregator', provider: 'peerlist', optional: true, reasonCode: 'PORTAL_REQUIRES_LIVE_INJECTION' },
  { id: 'portal-linkedin-jobs', kind: 'india-portal-search', category: 'aggregator', provider: 'linkedin-jobs', optional: true, reasonCode: 'PORTAL_REQUIRES_LIVE_INJECTION' },
  { id: 'indeed', kind: 'indeed-connector', category: 'aggregator', provider: 'indeed', optional: true },
  { id: 'native-remote-feeds', kind: 'native-public-feed', category: 'broad-remote', required: true },
  { id: 'startup-company-careers', kind: 'startup-career-search', category: 'direct-company', required: true },
];

export const CRAWLER_NORMAL_SOURCE_LANES = Object.freeze([
  { id: 'expanded-ats', kind: 'expanded-ats', category: 'direct-ats', optional: true },
  { id: 'structured-career-pages', kind: 'structured-career-pages', category: 'direct-company', optional: true },
  { id: 'web-discovery', kind: 'web-discovery', category: 'aggregator', optional: true },
  { id: 'connector-inbox', kind: 'connector-inbox', category: 'aggregator', optional: true },
]);

// Keep the direct Normal-mode contract stable for callers that do not run the
// crawler bridge. The unified daily run opts into the complete lane registry.
export const NORMAL_SOURCE_LANES = Object.freeze(LEGACY_NORMAL_SOURCE_LANES);
export const UNIFIED_NORMAL_SOURCE_LANES = Object.freeze([
  ...LEGACY_NORMAL_SOURCE_LANES,
  ...CRAWLER_NORMAL_SOURCE_LANES,
]);

function errorMessage(error) { return error?.message || String(error); }

function manifestFor(lane, patch = {}) {
  return sourceManifest(lane.id, lane.kind, {
    lane: lane.id,
    sourceCategory: lane.category,
    provider: lane.provider || null,
    required: lane.required === true,
    optional: lane.optional === true,
    reasonCode: patch.reasonCode ?? null,
    ...patch,
  });
}

function rawRecords(result, lane) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.records)) return result.records;
  if (result?.candidates && Array.isArray(result.candidates)) return result.candidates;
  return recordsFromResult(lane.id, result);
}

function normalizeLaneCandidate(raw, lane, { runAt, runId }) {
  const base = raw?.schemaVersion === CANDIDATE_SCHEMA_VERSION
    ? assertCandidate(raw)
    : normalizeCandidate(raw, {
      source: lane.id,
      provider: lane.provider,
      sourceKind: lane.category === 'direct-ats' ? 'ats-direct' : lane.category === 'broad-remote' ? 'niche-public' : 'aggregator',
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
  const resolvedPortalLead = lane.kind === 'india-portal-search'
    && ['Direct ATS', 'Resolved Original'].includes(base.applicationResolution?.status)
    && Boolean(base.originalApplicationUrl);
  const provider = lane.kind === 'india-portal-search'
    ? raw?.discoveryProvider ?? raw?.portalProvider ?? lane.provider
    : raw?.provider || base.provider || lane.provider || null;
  const source = resolvedPortalLead ? 'web-discovery' : raw?.source || base.source || lane.id;
  const sourceCategory = resolvedPortalLead ? 'aggregator' : raw?.sourceCategory || base.sourceCategory || lane.category;
  const enriched = {
    ...base,
    source,
    provider,
    discoveryProvider: provider,
    sourceCategory,
    discoveryUrl,
    discoverySource,
    discoveryCategory,
    verifiedAt: raw?.verifiedAt ?? raw?.liveness?.checkedAt ?? base.liveness?.checkedAt ?? null,
    originalApplicationEvidence: originalEvidence,
    feeBondEvidence: raw?.feeBondEvidence ?? raw?.feesBonds ?? raw?.feeBond ?? base.evidence?.feesBonds ?? null,
    citizenshipEvidence: raw?.citizenshipEvidence ?? raw?.remoteEligibilityEvidence ?? base.remoteEligibility?.evidence ?? null,
    requirementsEvidence: raw?.requirementsEvidence ?? raw?.evidence?.requirements ?? base.experience?.evidence ?? null,
    normalLaneId: resolvedPortalLead ? 'web-discovery' : lane.id,
    runId,
    dedupKey: candidateDedupKey(base),
    ...(raw?.scoringFailed === true ? { scoringFailed: true } : {}),
    ...(raw?.scoringStatus ? { scoringStatus: raw.scoringStatus } : {}),
    ...(raw?.scoringError || raw?.scoringFailureReason
      ? { scoringError: raw.scoringError || raw.scoringFailureReason }
      : {}),
    evidence: {
      ...(base.evidence || {}),
      discovery: { url: discoveryUrl, source: discoverySource, category: discoveryCategory, provider },
      originalApplication: originalEvidence,
      verifiedAt: raw?.verifiedAt ?? raw?.liveness?.checkedAt ?? base.liveness?.checkedAt ?? null,
    },
  };
  return assertCandidate(enriched);
}

function isResolvedPortalCandidate(candidate) {
  return candidate.normalLaneId === 'web-discovery' && candidate.source === 'web-discovery';
}

function routeResolvedPortalCandidates(results) {
  const webDiscovery = results.find((result) => result.manifest.sourceId === 'web-discovery');
  if (!webDiscovery) return results;
  for (const result of results) {
    if (result.manifest.kind !== 'india-portal-search') continue;
    const routed = result.candidates.filter(isResolvedPortalCandidate);
    if (!routed.length) continue;
    result.candidates = result.candidates.filter((candidate) => !isResolvedPortalCandidate(candidate));
    result.manifest.routedTo = 'web-discovery';
    result.manifest.routed = routed.length;
    webDiscovery.candidates.push(...routed);
    webDiscovery.manifest.fetched += routed.length;
    webDiscovery.manifest.attempted = true;
    webDiscovery.manifest.status = webDiscovery.manifest.errors.length ? 'degraded' : 'ok';
  }
  return results;
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
      failed: Number(supplied.failed || 0) + errors.length,
      errors: [...(Array.isArray(supplied.errors) ? supplied.errors : []), ...errors],
    }),
  };
}

function lookupFunction(functions, lane) {
  if (!functions || typeof functions !== 'object') return null;
  return functions[lane.id] || functions[lane.provider] || null;
}

/** Run every Normal lane independently. No network primitive is used here. */
export async function runNormalSourcePlan({ sourceFunctions = {}, sourceFixtures = {}, laneInputs = {}, runAt, runId, includeCrawlerLanes = false } = {}) {
  const results = [];
  const lanes = includeCrawlerLanes ? UNIFIED_NORMAL_SOURCE_LANES : NORMAL_SOURCE_LANES;
  for (const lane of lanes) {
    const suppliedFunction = lookupFunction(sourceFunctions, lane);
    const hasFixture = Object.prototype.hasOwnProperty.call(sourceFixtures, lane.id);
    const sourceFunction = suppliedFunction || (hasFixture ? () => sourceFixtures[lane.id] : null);
    if (!sourceFunction) {
      results.push({ candidates: [], manifest: manifestFor(lane, {
        attempted: false,
        status: 'unavailable',
        reasonCode: lane.reasonCode || (lane.optional ? 'OPTIONAL_SOURCE_UNAVAILABLE' : 'SOURCE_FUNCTION_UNAVAILABLE'),
        errors: lane.optional ? [] : ['No injected source function or fixture supplied'],
      }) });
      continue;
    }
    try {
      const output = await sourceFunction({ lane, input: laneInputs[lane.id] ?? laneInputs[lane.provider], runAt, runId });
      results.push(normalizeLaneOutput(lane, output, { runAt, runId }));
    } catch (error) {
      results.push({ candidates: [], manifest: manifestFor(lane, {
        attempted: true,
        status: 'failed',
        failed: 1,
        errors: [errorMessage(error)],
      }) });
    }
  }
  return routeResolvedPortalCandidates(results);
}
