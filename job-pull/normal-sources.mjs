import { CANDIDATE_SCHEMA_VERSION, assertCandidate, candidateDedupKey, canonicalizeUrl, normalizeCandidate } from './candidate.mjs';
import { recordsFromResult, sourceManifest } from './adapters/common.mjs';

export const NORMAL_SOURCE_LANES = Object.freeze([
  { id: 'tracked-ats', kind: 'tracked-ats', category: 'direct-ats', required: true },
  { id: 'reverse-ats-warm', kind: 'reverse-ats-warm', category: 'direct-ats', required: true },
  { id: 'portal-naukri', kind: 'india-portal-search', category: 'aggregator', provider: 'naukri', required: true },
  { id: 'portal-foundit', kind: 'india-portal-search', category: 'aggregator', provider: 'foundit', required: true },
  { id: 'portal-hirist', kind: 'india-portal-search', category: 'aggregator', provider: 'hirist', required: true },
  { id: 'portal-cutshort', kind: 'india-portal-search', category: 'aggregator', provider: 'cutshort', required: true },
  { id: 'portal-instahyre', kind: 'india-portal-search', category: 'aggregator', provider: 'instahyre', required: true },
  { id: 'portal-peerlist', kind: 'india-portal-search', category: 'aggregator', provider: 'peerlist', required: true },
  { id: 'portal-linkedin-jobs', kind: 'india-portal-search', category: 'aggregator', provider: 'linkedin-jobs', required: true },
  { id: 'indeed', kind: 'indeed-connector', category: 'aggregator', provider: 'indeed', optional: true },
  { id: 'native-remote-feeds', kind: 'native-public-feed', category: 'broad-remote', required: true },
  { id: 'startup-company-careers', kind: 'startup-career-search', category: 'direct-company', required: true },
]);

function errorMessage(error) { return error?.message || String(error); }

function manifestFor(lane, patch = {}) {
  return sourceManifest(lane.id, lane.kind, {
    lane: lane.id,
    sourceCategory: lane.category,
    provider: lane.provider || null,
    required: lane.required === true,
    optional: lane.optional === true,
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
  const enriched = {
    ...base,
    source: raw?.source || base.source || lane.id,
    provider: raw?.provider || base.provider || lane.provider || null,
    sourceCategory: raw?.sourceCategory || base.sourceCategory || lane.category,
    discoveryUrl,
    discoverySource,
    discoveryCategory,
    verifiedAt: raw?.verifiedAt ?? raw?.liveness?.checkedAt ?? base.liveness?.checkedAt ?? null,
    originalApplicationEvidence: originalEvidence,
    feeBondEvidence: raw?.feeBondEvidence ?? raw?.feesBonds ?? raw?.feeBond ?? base.evidence?.feesBonds ?? null,
    citizenshipEvidence: raw?.citizenshipEvidence ?? raw?.remoteEligibilityEvidence ?? base.remoteEligibility?.evidence ?? null,
    requirementsEvidence: raw?.requirementsEvidence ?? raw?.evidence?.requirements ?? base.experience?.evidence ?? null,
    normalLaneId: lane.id,
    runId,
    dedupKey: candidateDedupKey(base),
    evidence: {
      ...(base.evidence || {}),
      discovery: { url: discoveryUrl, source: discoverySource, category: discoveryCategory, provider: enrichedProvider(raw, base, lane) },
      originalApplication: originalEvidence,
      verifiedAt: raw?.verifiedAt ?? raw?.liveness?.checkedAt ?? base.liveness?.checkedAt ?? null,
    },
  };
  return assertCandidate(enriched);
}

function enrichedProvider(raw, base, lane) { return raw?.provider || base.provider || lane.provider || null; }

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
export async function runNormalSourcePlan({ sourceFunctions = {}, sourceFixtures = {}, laneInputs = {}, runAt, runId } = {}) {
  const results = [];
  for (const lane of NORMAL_SOURCE_LANES) {
    const suppliedFunction = lookupFunction(sourceFunctions, lane);
    const hasFixture = Object.prototype.hasOwnProperty.call(sourceFixtures, lane.id);
    const sourceFunction = suppliedFunction || (hasFixture ? () => sourceFixtures[lane.id] : null);
    if (!sourceFunction) {
      results.push({ candidates: [], manifest: manifestFor(lane, {
        attempted: false,
        status: 'unavailable',
        reasonCode: lane.optional ? 'OPTIONAL_SOURCE_UNAVAILABLE' : 'SOURCE_FUNCTION_UNAVAILABLE',
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
  return results;
}
