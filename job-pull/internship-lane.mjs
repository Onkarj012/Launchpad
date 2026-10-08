import { parseStipend } from './stipend.mjs';
import { isDeepStrictEqual } from 'node:util';
import { candidateDedupKey, normalizeCandidate } from './candidate.mjs';
import { classifyEmployment } from './eligibility.mjs';
import { classifyCandidateEvidence, resolveOriginalEmployer } from './normal-readiness.mjs';
import { createNoWriteNotionGateway } from './workflow.mjs';
import { propertyContract } from '../notion-v5/schema.mjs';

export const INTERNSHIP_LANE_ID = 'internship';

export const INTERNSHIP_SCHEMA_FIELDS = Object.freeze([
  'Employment Category',
  'Stipend Amount',
  'Stipend Currency',
  'Stipend Period',
  'Stipend Monthly Amount',
  'Stipend Raw',
  'Stipend Evidence',
  'Stipend Tier',
  'Freshness',
  'Readiness',
]);

const PUNE_METRO = /\b(?:pune|pimpri[ -]?chinchwad|pcmc|hinjawadi|hinjewadi)\b/i;
const REMOTE = /\b(?:remote|work[ -]?from[ -]?home|distributed|anywhere|worldwide|global)\b/i;
const HYBRID = /\bhybrid\b/i;
const ONSITE = /\b(?:on[ -]?site|in[ -]?office|office[ -]?based|office-based)\b/i;
const FOREIGN_RESTRICTION = /\b(?:u\.?s\.?|united states|u\.?k\.?|united kingdom|eu|european union|canada|australia)\s+(?:only|work authorization|work authorisation)|(?:must be located|must reside|authorized to work|authorised to work)\s+in\s+(?:the\s+)?(?:u\.?s\.?|united states|u\.?k\.?|united kingdom|eu|canada|australia)\b/i;
const INTERNSHIP = /\b(?:intern|internship|trainee)\b/i;

export class InternshipLaneError extends Error {
  constructor(message, stage = 'internship-lane') {
    super(message);
    this.name = 'InternshipLaneError';
    this.stage = stage;
  }
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function countReasons(values) {
  const counts = {};
  for (const value of values) {
    if (value) counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function copy(value) {
  if (value == null) return value;
  return structuredClone(value);
}

function remoteEligibility(raw, candidate, combined) {
  const supplied = raw?.remoteEligibility;
  const structured = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? supplied : {};
  const status = text(structured.status ?? (typeof supplied === 'string' ? supplied : null) ?? raw?.remoteEligible) || candidate.remoteEligibility?.status || 'Not Verified';
  const evidence = text(structured.evidence ?? raw?.remoteEligibilityEvidence ?? raw?.citizenshipEvidence ?? candidate.remoteEligibility?.evidence);
  const restriction = raw?.citizenshipRestriction;
  const restrictionObject = restriction && typeof restriction === 'object' && !Array.isArray(restriction) ? restriction : {};
  const restrictionStatus = text(restrictionObject.status ?? (typeof restriction === 'string' ? restriction : null));
  const restrictionEvidence = text(restrictionObject.evidence ?? raw?.citizenshipRestrictionEvidence);
  const noRestriction = restriction === false || /^(?:none|no|not restricted|no restriction)$/i.test(restrictionStatus || '')
    ? restrictionEvidence
    : null;
  const positiveIndia = /^(?:india eligible|eligible|yes|allowed)$/i.test(status) && Boolean(evidence);
  const explicitIneligible = /^(?:not eligible|ineligible|no|denied)$/i.test(status);
  if (explicitIneligible || FOREIGN_RESTRICTION.test(combined) || /(?:excluding|not available to)\s+india/i.test(combined)) {
    return { status: 'Not Eligible', pass: false, verification: false, evidence: evidence || combined, reason: 'REMOTE_NOT_ELIGIBLE_FOR_INDIA' };
  }
  if (positiveIndia || noRestriction) {
    return { status: 'India Eligible', pass: true, verification: false, evidence: evidence || noRestriction, reason: null };
  }
  return { status: 'Not Verified', pass: false, verification: true, evidence: evidence || null, reason: 'REMOTE_INDIA_ELIGIBILITY_NOT_VERIFIED' };
}

function classifyGeography(raw, candidate) {
  const location = text(raw?.location ?? candidate.location) || '';
  const modeText = text(raw?.workMode ?? raw?.work_mode) || '';
  const combined = [location, modeText, candidate.description].filter(Boolean).join(' ');
  const mode = REMOTE.test(modeText) || (modeText === '' && REMOTE.test(location)) || candidate.workMode === 'remote' ? 'remote'
    : HYBRID.test(modeText) || candidate.workMode === 'hybrid' ? 'hybrid'
      : ONSITE.test(modeText) || candidate.workMode === 'onsite' ? 'onsite'
        : null;
  if (mode === 'remote') return { mode, location, ...remoteEligibility(raw, candidate, combined) };
  if (mode === 'onsite' || mode === 'hybrid') {
    if (PUNE_METRO.test(location)) return { mode, location, pass: true, verification: false, evidence: location, reason: null, status: 'Pune Metro' };
    if (!location) return { mode, location: null, pass: false, verification: true, evidence: null, reason: 'ONSITE_HYBRID_LOCATION_NOT_VERIFIED', status: 'Not Verified' };
    return { mode, location, pass: false, verification: false, evidence: location, reason: 'ONSITE_HYBRID_NOT_PUNE_METRO', status: 'Not Eligible' };
  }
  if (PUNE_METRO.test(location)) return { mode: 'unknown', location, pass: false, verification: true, evidence: location, reason: 'WORK_MODE_NOT_VERIFIED', status: 'Not Verified' };
  return { mode: 'unknown', location: location || null, pass: false, verification: true, evidence: location || null, reason: 'GEOGRAPHY_NOT_VERIFIED', status: 'Not Verified' };
}

function classifyFreshness(postedAt, runAt) {
  if (!postedAt) return { eligible: false, status: 'Needs Verification', tier: null, ageHours: null, reason: 'FRESHNESS_NOT_VERIFIED', evidence: null };
  const ageHours = (Date.parse(runAt) - Date.parse(postedAt)) / 3600000;
  if (!Number.isFinite(ageHours) || ageHours < 0) return { eligible: false, status: 'Needs Verification', tier: null, ageHours: null, reason: 'FRESHNESS_NOT_VERIFIED', evidence: postedAt };
  if (ageHours <= 24) return { eligible: true, status: 'Fresh', tier: 'strict-0-24h', ageHours, reason: null, evidence: postedAt };
  if (ageHours <= 72) return { eligible: true, status: 'Fresh', tier: 'strict-24-72h', ageHours, reason: null, evidence: postedAt };
  if (ageHours <= 168) return { eligible: true, status: 'Active', tier: 'strict-3-7d', ageHours, reason: null, evidence: postedAt };
  if (ageHours <= 336) return { eligible: true, status: 'Backfill', tier: 'backfill-8-14d', ageHours, reason: null, evidence: postedAt };
  return { eligible: false, status: 'Rejected', tier: null, ageHours, reason: 'FRESHNESS_EXPIRED', evidence: postedAt };
}

function isInternship(raw, candidate) {
  const type = candidate.employment?.type;
  const rawType = typeof raw?.employment === 'string' ? raw.employment : raw?.employment?.type;
  if (type === 'full-time' || /full[ -]?time|permanent/i.test(String(rawType || ''))) return false;
  return type === 'internship' || /internship|intern|trainee/i.test(String(rawType || '')) || INTERNSHIP.test(candidate.title || '') || INTERNSHIP.test(candidate.description || '');
}

function feeEvidence(raw, candidate) {
  const value = raw?.feeBondEvidence ?? raw?.feesBonds ?? raw?.feeBond ?? raw?.evidence?.feesBonds ?? candidate.evidence?.feesBonds ?? null;
  if (typeof value === 'string' && /^(?:none|no|none observed|not observed)$/i.test(value.trim())) return null;
  return value;
}

function classifyRecord(raw, { runAt }) {
  const candidate = normalizeCandidate(raw, {
    runAt,
    source: raw?.source ?? 'internship-fixture',
    provider: raw?.provider ?? null,
    sourceKind: raw?.sourceKind ?? 'aggregator',
    sourceCategory: raw?.sourceCategory ?? 'aggregator',
  });
  const stipend = parseStipend(raw);
  const structuredPaidEvidence = stipend.amount != null && stipend.currency === 'INR' && stipend.periodUnit != null && stipend.verified;
  const enriched = {
    ...candidate,
    employment: {
      ...candidate.employment,
      paid: candidate.employment?.paid ?? (structuredPaidEvidence ? true : null),
      evidence: candidate.employment?.evidence ?? stipend.evidence ?? null,
    },
    feeBondEvidence: feeEvidence(raw, candidate),
    originalApplicationEvidence: raw?.originalApplicationEvidence ?? candidate.applicationResolution?.evidence ?? null,
  };
  const geography = classifyGeography(raw, candidate);
  const freshness = classifyFreshness(candidate.postedAt, runAt);
  const internship = isInternship(raw, candidate);
  const employmentGate = classifyEmployment(enriched, {
    employment: { allowedTypes: ['full-time', 'internship'], internshipRequiresExplicitPaid: true, rejectUnpaid: true },
  });
  const resolution = resolveOriginalEmployer(enriched);
  const policyReasons = [];
  if (!internship) policyReasons.push('EMPLOYMENT_CATEGORY_NOT_INTERNSHIP');
  if (!employmentGate.pass) policyReasons.push(employmentGate.code);
  if (stipend.status === 'Rejected') policyReasons.push(stipend.reason);
  if (stipend.status === 'Needs Verification') policyReasons.push(stipend.reason);
  if (geography.reason) policyReasons.push(geography.reason);
  const shared = classifyCandidateEvidence(enriched, {
    eligible: policyReasons.length === 0,
    reasons: policyReasons,
    geo: geography,
  });
  if (!resolution.ready) policyReasons.push(...resolution.reasons);
  if (candidate.liveness.status === 'Expired') policyReasons.push('LIVENESS_EXPIRED');
  else if (candidate.liveness.status !== 'Active') policyReasons.push('LIVENESS_NOT_VERIFIED');
  if (enriched.feeBondEvidence) policyReasons.push('FEES_OR_BOND_CONCERN');
  if (freshness.reason) policyReasons.push(freshness.reason);
  const reasons = unique(policyReasons);
  const rejectReasons = reasons.filter((reason) => (!employmentGate.pass && reason === employmentGate.code)
    || (stipend.status !== 'Verified' && reason === stipend.reason) || [
    'EMPLOYMENT_CATEGORY_NOT_INTERNSHIP', 'ONSITE_HYBRID_NOT_PUNE_METRO',
    'EMPLOYMENT_UNPAID', 'EMPLOYMENT_TRAINING_FEE_OR_BOND', 'REMOTE_NOT_ELIGIBLE_FOR_INDIA',
    'LIVENESS_EXPIRED', 'FEES_OR_BOND_CONCERN', 'FRESHNESS_EXPIRED',
  ].includes(reason));
  const verificationReasons = reasons.filter((reason) => !rejectReasons.includes(reason));
  const status = rejectReasons.length ? 'Rejected' : verificationReasons.length ? 'Needs Verification' : 'Ready';
  const readiness = {
    ready: status === 'Ready',
    status,
    reasons,
    evidence: {
      ...shared,
      resolution,
      geography,
      stipend,
      freshness,
    },
  };
  return {
    candidate: {
      ...enriched,
      applicationReady: readiness.ready,
      applicationReadiness: readiness.status,
      employmentCategory: internship ? 'Internship' : candidate.employment?.type === 'full-time' ? 'Full-time' : 'Unknown',
    },
    employmentCategory: internship ? 'Internship' : candidate.employment?.type === 'full-time' ? 'Full-time' : 'Unknown',
    stipend,
    geography,
    freshness,
    readiness,
    status,
    bucket: status === 'Rejected' ? 'rejected' : status === 'Needs Verification' ? 'needsVerification' : 'ready',
    rejectionReasons: rejectReasons,
    verificationReasons,
  };
}

function schemaGap(schemaFields) {
  if (!Array.isArray(schemaFields)) return { schemaFieldsVerified: false, schemaIntegrationRequired: true, missingFields: [...INTERNSHIP_SCHEMA_FIELDS] };
  const available = new Set(schemaFields);
  const missingFields = INTERNSHIP_SCHEMA_FIELDS.filter((field) => !available.has(field));
  return { schemaFieldsVerified: true, schemaIntegrationRequired: missingFields.length > 0, missingFields };
}

function payloadFor(record, runId, schema) {
  const candidate = record.candidate;
  return {
    lane: INTERNSHIP_LANE_ID,
    employmentCategory: 'Internship',
    'Employment Category': 'Internship',
    role: candidate.title,
    company: candidate.company,
    jdLink: candidate.discoveryUrl || candidate.canonicalUrl,
    originalApplicationUrl: candidate.originalApplicationUrl,
    originalApplicationEvidence: candidate.originalApplicationEvidence,
    stipendAmount: record.stipend.amount,
    stipendCurrency: record.stipend.currency,
    stipendPeriod: record.stipend.period,
    stipendMonthlyAmount: record.stipend.monthlyAmount,
    stipendRaw: copy(record.stipend.raw),
    stipendEvidence: record.stipend.evidence,
    stipendTier: record.stipend.tier,
    stipend: copy(record.stipend),
    geography: copy(record.geography),
    freshness: copy(record.freshness),
    readiness: copy(record.readiness),
    liveness: candidate.liveness,
    feesBonds: candidate.feeBondEvidence,
    provenance: {
      source: candidate.source,
      provider: candidate.provider,
      discoveryUrl: candidate.discoveryUrl || candidate.canonicalUrl,
      originalApplicationUrl: candidate.originalApplicationUrl,
      originalApplicationEvidence: candidate.originalApplicationEvidence,
      stipendRaw: copy(record.stipend.raw),
      stipendEvidence: record.stipend.evidence,
      geographyEvidence: record.geography.evidence,
      readinessEvidence: copy(record.readiness.evidence),
    },
    runId,
    dedupKey: candidateDedupKey(candidate),
    ...schema,
  };
}

function operationFor(record, runId, schema) {
  return {
    operation: 'create',
    resource: 'application',
    lane: INTERNSHIP_LANE_ID,
    dedupKey: candidateDedupKey(record.candidate),
    payload: payloadFor(record, runId, schema),
    provenance: payloadFor(record, runId, schema).provenance,
  };
}

function compareReady(left, right) {
  const tier = (value) => value.stipend.tier === 'Preferred' ? 0 : 1;
  return tier(left) - tier(right)
    || (right.stipend.monthlyAmount ?? 0) - (left.stipend.monthlyAmount ?? 0)
    || (left.freshness.ageHours ?? Number.POSITIVE_INFINITY) - (right.freshness.ageHours ?? Number.POSITIVE_INFINITY)
    || String(left.candidate.canonicalUrl).localeCompare(String(right.candidate.canonicalUrl));
}

async function readRecords({ sourceFunction, sourceFixture, records, runAt, runId }) {
  if (sourceFunction != null && typeof sourceFunction !== 'function') throw new InternshipLaneError('sourceFunction must be a function', 'source');
  if (sourceFunction) {
    const result = await sourceFunction({ lane: INTERNSHIP_LANE_ID, runAt, runId });
    return Array.isArray(result) ? result : Array.isArray(result?.records) ? result.records : [];
  }
  if (Array.isArray(records)) return records;
  if (Array.isArray(sourceFixture)) return sourceFixture;
  return [];
}

/** Run the separate internship lane using only injected source and gateway seams. */
export async function runInternshipLane({
  clock = () => new Date().toISOString(),
  runId: suppliedRunId = null,
  sourceFunction = null,
  sourceFixture = null,
  records = null,
  notionGateway = createNoWriteNotionGateway(),
  executeGateway = false,
  schemaFields = null,
} = {}) {
  const runAt = new Date(typeof clock === 'function' ? clock() : clock).toISOString();
  const runId = suppliedRunId || `internship-${runAt}`;
  const integratedSchemaFields = schemaFields ?? Object.values(propertyContract('applications')).map((field) => field.name);
  const schema = schemaGap(integratedSchemaFields);
  let rawRecords;
  try {
    rawRecords = await readRecords({ sourceFunction, sourceFixture, records, runAt, runId });
  } catch (error) {
    return {
      schemaVersion: 'LaunchpadV5InternshipLaneV1', lane: INTERNSHIP_LANE_ID, runId, runAt,
      shortlist: [], verificationQueue: [], rejected: [], plannedNotionOperations: [], transaction: null,
      counts: { fetched: 0, normalized: 0, ready: 0, needsVerification: 0, rejected: 0, preferred: 0, lowerStipend: 0, invalid: 0 },
      buckets: { verification: {}, rejection: {} }, schema, outcome: { status: 'fatal', fatal: true, degraded: false, errors: [{ stage: 'source', message: error.message }] },
    };
  }
  const invalid = [];
  const classified = [];
  for (const [index, raw] of rawRecords.entries()) {
    try { classified.push(classifyRecord(raw, { runAt })); }
    catch (error) { invalid.push({ index: index + 1, reason: 'CANDIDATE_INVALID', error: error.message }); }
  }
  const ready = classified.filter((record) => record.status === 'Ready').sort(compareReady);
  const verificationQueue = classified.filter((record) => record.status === 'Needs Verification');
  const rejected = classified.filter((record) => record.status === 'Rejected');
  const operations = ready.map((record) => operationFor(record, runId, schema));
  if (!notionGateway || typeof notionGateway.planWrites !== 'function') throw new InternshipLaneError('notion gateway must implement planWrites', 'notion');
  const planned = notionGateway.planWrites({ schemaVersion: 'LaunchpadV5InternshipPlanV1', lane: INTERNSHIP_LANE_ID, runId, runAt, operations: copy(operations) });
  const plannedOperations = Array.isArray(planned) ? planned : planned?.operations;
  if (!isDeepStrictEqual(plannedOperations, operations)) throw new InternshipLaneError('notion gateway planWrites must return authoritative operations unchanged', 'notion');
  let transaction = null;
  if (executeGateway) {
    if (notionGateway.kind !== 'fake-transactional-v5' || typeof notionGateway.executeWrites !== 'function') throw new InternshipLaneError('live or non-transactional gateway execution is disabled; inject the Issue04 fake gateway', 'notion');
    transaction = await notionGateway.executeWrites({ operations: plannedOperations });
  }
  const verificationBuckets = countReasons(verificationQueue.flatMap((record) => record.verificationReasons));
  const rejectionBuckets = countReasons(rejected.flatMap((record) => record.rejectionReasons));
  return {
    schemaVersion: 'LaunchpadV5InternshipLaneV1', lane: INTERNSHIP_LANE_ID, runId, runAt,
    shortlist: ready, verificationQueue, rejected, plannedNotionOperations: plannedOperations, transaction, schema,
    counts: {
      fetched: rawRecords.length, normalized: classified.length, invalid: invalid.length, ready: ready.length,
      needsVerification: verificationQueue.length, rejected: rejected.length,
      preferred: ready.filter((record) => record.stipend.tier === 'Preferred').length,
      lowerStipend: ready.filter((record) => record.stipend.tier === 'Lower-Stipend').length,
    },
    buckets: { verification: verificationBuckets, rejection: rejectionBuckets },
    invalid,
    outcome: { status: invalid.length ? 'degraded' : 'ok', fatal: false, degraded: invalid.length > 0, errors: [] },
  };
}

export { classifyFreshness, classifyGeography, parseStipend };
