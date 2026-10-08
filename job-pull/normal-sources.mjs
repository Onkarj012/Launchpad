import { discoveryCandidate, CANDIDATE_SCHEMA_VERSION, assertCandidate, candidateDedupKey, canonicalizeUrl, normalizeCandidate } from './candidate.mjs';
import { recordsFromResult, sourceManifest } from './adapters/common.mjs';
import { fetchLinkedIn } from './portal-adapters/linkedin.mjs';
import { fetchGlassdoor, fetchInstahyre, fetchWellfound } from './portal-adapters/browser-portals.mjs';

/**
 * Portal providers that own a real fetcher. A lane is only promoted to
 * `required` once it appears here — a required lane with no adapter just
 * produces a noisy failure instead of jobs.
 *
 * linkedin-jobs runs over plain HTTP. The other three need a rendered page and
 * receive a browser-backed transport; see crawler/browser-transport.mjs.
 */
const PORTAL_ADAPTERS = Object.freeze({
  'linkedin-jobs': fetchLinkedIn,
  glassdoor: fetchGlassdoor,
  instahyre: fetchInstahyre,
  wellfound: fetchWellfound,
});

export const PORTAL_PROVIDERS = Object.freeze(Object.keys(PORTAL_ADAPTERS));

const LEGACY_NORMAL_SOURCE_LANES = [
  { id: 'tracked-ats', kind: 'tracked-ats', category: 'direct-ats', required: true },
  { id: 'reverse-ats-warm', kind: 'reverse-ats-warm', category: 'direct-ats', required: true },
  // Naukri hard-blocks unauthenticated access: the HTML page is a JS shell and
  // jobapi/v3/search answers 406 {"message":"recaptcha required"}. A real
  // headless Chromium context is served 403 with a captcha wall (probed
  // 2026-08-22). It stays optional and belongs to the Apify rescue path.
  { id: 'portal-naukri', kind: 'india-portal-search', category: 'aggregator', provider: 'naukri', optional: true, reasonCode: 'PORTAL_BLOCKED_REQUIRES_RESCUE' },
  { id: 'portal-foundit', kind: 'india-portal-search', category: 'aggregator', provider: 'foundit', optional: true, reasonCode: 'PORTAL_REQUIRES_LIVE_INJECTION' },
  { id: 'portal-hirist', kind: 'india-portal-search', category: 'aggregator', provider: 'hirist', optional: true, reasonCode: 'PORTAL_REQUIRES_LIVE_INJECTION' },
  { id: 'portal-cutshort', kind: 'india-portal-search', category: 'aggregator', provider: 'cutshort', optional: true, reasonCode: 'PORTAL_REQUIRES_LIVE_INJECTION' },
  { id: 'portal-peerlist', kind: 'india-portal-search', category: 'aggregator', provider: 'peerlist', optional: true, reasonCode: 'PORTAL_REQUIRES_LIVE_INJECTION' },
  // Owns a working fetcher over the public guest endpoint, and is the only
  // portal that supplies an exact employer post date.
  //
  // Deliberately `optional`: a lane flag decides whether *absence* degrades a
  // run, and absence is not the signal that matters here. Short yield is, and
  // the shortfall report already names this lane under SOURCE_FAILED /
  // SOURCE_EMPTY when it comes up empty. Marking it required only forced every
  // fixture-driven run without an injected portal to report degraded.
  { id: 'portal-linkedin-jobs', kind: 'india-portal-search', category: 'aggregator', provider: 'linkedin-jobs', optional: true },
  // Browser-backed portals. Each covers inventory the ATS lanes do not reach:
  // Glassdoor breadth, Instahyre curated India roles, Wellfound startups.
  { id: 'portal-glassdoor', kind: 'india-portal-search', category: 'aggregator', provider: 'glassdoor', optional: true },
  { id: 'portal-instahyre', kind: 'india-portal-search', category: 'aggregator', provider: 'instahyre', optional: true },
  { id: 'portal-wellfound', kind: 'india-portal-search', category: 'startup-board', provider: 'wellfound', optional: true },
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
    ? discoveryCandidate(raw)
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
    companyStage: raw?.companyStage ?? null,
    companyStageEvidence: raw?.companyStageEvidence ?? null,
    startupStageEvidenceRef: raw?.startupStageEvidenceRef ?? null,
    companyRecord: raw?.companyRecord ?? null,
    startupLaneId: raw?.startupLaneId ?? null,
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
  const adapterErrors = Array.isArray(result?.telemetry?.errors) ? result.telemetry.errors : [];
  const allErrors = [...new Set([...(Array.isArray(supplied.errors) ? supplied.errors : []), ...adapterErrors, ...errors])];
  const status = supplied.status === 'unavailable'
    ? 'unavailable'
    : allErrors.length ? (candidates.length ? 'degraded' : 'failed')
    : supplied.status || (candidates.length ? 'ok' : 'empty');
  return {
    candidates,
    manifest: manifestFor(lane, {
      ...supplied,
      sourceId: lane.id,
      kind: lane.kind,
      status,
      attempted: true,
      fetched: candidates.length,
      failed: Math.max(Number(supplied.failed || 0), new Set([...(Array.isArray(supplied.errors) ? supplied.errors : []), ...adapterErrors]).size) + errors.length,
      errors: allErrors,
      ...(result?.telemetry ? { telemetry: result.telemetry } : {}),
    }),
  };
}

function lookupFunction(functions, lane) {
  if (!functions || typeof functions !== 'object') return null;
  return functions[lane.id] || functions[lane.provider] || null;
}

/**
 * Run every Normal lane independently. No network primitive is created here:
 * `providerFetchers` supplies the caller-owned transport (host spacing, retry,
 * byte caps, browser rendering) that a portal adapter runs on.
 */
export async function runNormalSourcePlan({ sourceFunctions = {}, sourceFixtures = {}, laneInputs = {}, providerFetchers = {}, runAt, runId, includeCrawlerLanes = false, signal = null } = {}) {
  const results = [];
  const lanes = includeCrawlerLanes ? UNIFIED_NORMAL_SOURCE_LANES : NORMAL_SOURCE_LANES;
  for (const lane of lanes) {
    const suppliedFunction = lookupFunction(sourceFunctions, lane);
    const hasFixture = Object.prototype.hasOwnProperty.call(sourceFixtures, lane.id);
    const portalTransport = lane.provider ? providerFetchers[lane.provider] : null;
    const portalAdapter = lane.provider ? PORTAL_ADAPTERS[lane.provider] : null;
    const sourceFunction = suppliedFunction
      || (hasFixture ? () => sourceFixtures[lane.id] : null)
      || (portalTransport && portalAdapter
        ? ({ input, signal: laneSignal }) => portalAdapter({ ...portalTransport, ...(input || {}), signal: laneSignal ?? signal })
        : null);
    if (!sourceFunction) {
      results.push({ candidates: [], manifest: manifestFor(lane, {
        attempted: false,
        status: 'unavailable',
        reasonCode: lane.reasonCode || (lane.optional ? 'OPTIONAL_SOURCE_UNAVAILABLE' : 'SOURCE_FUNCTION_UNAVAILABLE'),
        errors: lane.optional ? [] : ['No injected source function, fixture, or portal transport supplied'],
      }) });
      continue;
    }
    try {
      const output = await sourceFunction({ lane, input: laneInputs[lane.id] ?? laneInputs[lane.provider], runAt, runId, signal });
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

/** Lanes owned by the portal discovery layer, in the order they are attempted. */
export const PORTAL_SOURCE_LANES = Object.freeze(
  UNIFIED_NORMAL_SOURCE_LANES.filter((lane) => lane.provider && PORTAL_ADAPTERS[lane.provider]),
);

/**
 * Run only the portal lanes. The operator drives this the same way it drives
 * runRemoteSourcePlan: it owns the transports, this owns adapter dispatch and
 * per-lane manifests. A lane without a transport reports unavailable instead of
 * throwing, so losing the browser never takes LinkedIn down with it.
 */
export async function runPortalSourcePlan({
  providerFetchers = {}, laneInputs = {}, runAt, runId, signal = null, maxRecordsPerProvider = null,
} = {}) {
  const results = [];
  for (const lane of PORTAL_SOURCE_LANES) {
    const transport = providerFetchers[lane.provider];
    const adapter = PORTAL_ADAPTERS[lane.provider];
    if (!transport) {
      results.push({ candidates: [], manifest: manifestFor(lane, {
        attempted: false,
        status: 'unavailable',
        reasonCode: lane.reasonCode || (lane.optional ? 'OPTIONAL_SOURCE_UNAVAILABLE' : 'PORTAL_TRANSPORT_UNAVAILABLE'),
        errors: lane.optional ? [] : [`No transport supplied for ${lane.provider}`],
      }) });
      continue;
    }
    try {
      const input = laneInputs[lane.id] ?? laneInputs[lane.provider] ?? {};
      const output = await adapter({
        ...transport,
        ...input,
        signal,
        ...(maxRecordsPerProvider ? { maxRecords: maxRecordsPerProvider } : {}),
      });
      results.push(normalizeLaneOutput(lane, output, { runAt, runId }));
    } catch (error) {
      results.push({ candidates: [], manifest: manifestFor(lane, {
        attempted: true, status: 'failed', failed: 1, errors: [errorMessage(error)],
      }) });
    }
  }
  return results;
}
