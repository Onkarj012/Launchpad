/**
 * PROTOTYPE QUESTION:
 * Can plugin/web records use Launchpad's existing strict discovery policy while
 * making deduplication, verification, staleness, rejection, and selection state
 * fully inspectable without persistence or external actions?
 *
 * This module is deliberately pure: no filesystem, terminal, network, database,
 * Notion, apply, or send operations.
 */

import {
  candidateDedupKey,
  normalizeCandidate,
} from '../../../job-pull/candidate.mjs';
import { classifyCandidate } from '../../../job-pull/eligibility.mjs';
import { classifyFreshness } from '../../../job-pull/freshness.mjs';
import { parseStipend } from '../../../job-pull/internship-lane.mjs';
import { applicationReadiness } from '../../../job-pull/normal-readiness.mjs';
import { selectDailyReserve } from '../../reserve.mjs';

export const PROTOTYPE_QUESTION = 'Can plugin/web discovery feed the strict Launchpad pipeline with every decision visible?';
export const ALLOWED_SOURCES = Object.freeze(['indeed', 'apna', 'whatjobs', 'web']);

const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

function requireEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('input must be a JSON object with a records array');
  }
  if (!Array.isArray(envelope.records)) throw new TypeError('input.records must be an array');
  return envelope.records;
}

function requireRecord(record, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError(`records[${index}] must be an object`);
  }
  const source = clean(record.source)?.toLowerCase();
  if (!ALLOWED_SOURCES.includes(source)) {
    throw new TypeError(`records[${index}].source must be one of: ${ALLOWED_SOURCES.join(', ')}`);
  }
  for (const field of ['title', 'company', 'location', 'description', 'url']) {
    if (!clean(record[field])) throw new TypeError(`records[${index}].${field} is required`);
  }
  if (!Object.hasOwn(record, 'postedAt')) throw new TypeError(`records[${index}].postedAt is required (use null when unknown)`);
  if (record.postedAt != null && !clean(record.postedAt)) {
    throw new TypeError(`records[${index}].postedAt must be an ISO timestamp or null`);
  }
  const sourceJobId = record.sourceJobId ?? record.jobId;
  if (!clean(String(sourceJobId ?? ''))) {
    throw new TypeError(`records[${index}] needs sourceJobId or jobId`);
  }
  return { source, sourceJobId: String(sourceJobId).trim() };
}

function normalizeRecord(record, index, now) {
  const { source, sourceJobId } = requireRecord(record, index);
  return normalizeCandidate({
    ...record,
    provider: source,
    source: `prototype:${source}`,
    jobId: sourceJobId,
    sourceKind: 'aggregator',
    sourceCategory: 'aggregator',
    discoveredAt: now,
    crawledAt: now,
    originalApplicationEvidence: record.originalApplicationUrl
      ? 'provided by plugin/web discovery envelope'
      : null,
  }, { runAt: now, provider: source, sourceKind: 'aggregator' });
}

function identityKeys(candidate) {
  return [
    `source-job:${candidate.provider}:${candidate.jobId}`,
    `url:${candidate.canonicalUrl}`,
    `shape:${candidateDedupKey(candidate)}`,
  ];
}

function internshipGate(raw, candidate) {
  const applicable = candidate.employment?.type === 'internship'
    || /\b(?:intern|internship|trainee)\b/i.test(`${candidate.title || ''} ${candidate.description || ''}`);
  if (!applicable) {
    return {
      applicable: false,
      status: 'Not Applicable',
      tier: null,
      monthlyAmount: null,
      applicationReadyAllowed: true,
      verification: false,
      rejected: false,
      reason: null,
    };
  }
  let stipend = parseStipend(raw);
  const structured = raw?.stipend && typeof raw.stipend === 'object' && !Array.isArray(raw.stipend)
    ? raw.stipend
    : null;
  const maximum = Number(String(structured?.maximum ?? structured?.max ?? '').replace(/,/g, ''));
  const currency = clean(String(structured?.currency ?? ''));
  const period = clean(String(structured?.period ?? ''));
  const safeBelowFloorRange = stipend.status === 'Needs Verification'
    && stipend.reason === 'STIPEND_AMBIGUOUS'
    && Number.isFinite(maximum)
    && /^(?:inr|₹|rs\.?|rupees?)$/i.test(currency || '')
    && /^(?:month|monthly|per month|\/month|pm)$/i.test(period || '')
    && maximum < 25000;
  if (safeBelowFloorRange) {
    stipend = {
      ...stipend,
      monthlyAmount: maximum,
      tier: 'Reject',
      status: 'Rejected',
      reason: 'STIPEND_BELOW_25000_INR_MONTHLY',
      conservativeRangeOverride: true,
      rangeMaximumMonthly: maximum,
    };
  }
  return {
    ...stipend,
    applicable: true,
    applicationReadyAllowed: stipend.status === 'Verified',
    verification: stipend.status === 'Needs Verification',
    rejected: stipend.status === 'Rejected',
  };
}

function view(entry) {
  const candidate = entry.candidate;
  return {
    key: entry.key,
    source: candidate.provider,
    sourceJobId: candidate.jobId,
    title: candidate.title,
    company: candidate.company,
    location: candidate.location,
    postedAt: candidate.postedAt,
    url: candidate.canonicalUrl,
    originalApplicationUrl: candidate.originalApplicationUrl,
    eligibility: entry.eligibility,
    freshness: entry.freshness,
    readiness: candidate.readiness,
    internshipGate: entry.internshipGate,
  };
}

function sortedCounts(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function decisionReasons(entry) {
  const reasons = new Set(entry.eligibility.reasons || []);
  if (!entry.freshness.eligible) reasons.add(entry.freshness.code || 'FRESHNESS_REJECTED');
  if (entry.internshipGate?.reason) reasons.add(entry.internshipGate.reason);
  if (!entry.candidate.readiness.ready) {
    for (const reason of entry.candidate.readiness.reasons || []) reasons.add(reason);
  }
  return [...reasons].sort();
}

function hasPolicyRejection(entry) {
  return policyRejectionReasons(entry).length > 0;
}

function policyRejectionReasons(entry) {
  const reasons = entry.eligibility.reasons || [];
  return entry.internshipGate.verification
    ? reasons.filter((reason) => reason !== 'INTERNSHIP_PAY_NOT_EXPLICIT')
    : reasons;
}

function hardFailureReasons(entry) {
  const reasons = new Set(policyRejectionReasons(entry));
  if (entry.internshipGate.rejected && entry.internshipGate.reason) reasons.add(entry.internshipGate.reason);
  if (entry.freshness.code === 'FRESHNESS_OLDER_THAN_14D') reasons.add(entry.freshness.code);
  for (const reason of entry.candidate.readiness.reasons || []) {
    if (['LIVENESS_EXPIRED', 'FEES_OR_BOND_CONCERN'].includes(reason)) reasons.add(reason);
  }
  return [...reasons].sort();
}

function reserveEligibility(entry) {
  const eligibility = entry.eligibility;
  if (eligibility.eligible !== true || eligibility.relaxed !== true) return eligibility;
  return {
    ...eligibility,
    reach: true,
    reachMinimumYears: eligibility.experience?.minYears,
  };
}

function rebuildState(base) {
  const entries = base.records;
  const selection = selectDailyReserve(entries.map((entry) => ({
    // The production reserve selector treats evidence readiness and freshness
    // as consecutive gates. Preserve that ordering while the prototype's
    // public applicationReady field represents the final intersection.
    candidate: {
      ...entry.candidate,
      applicationReady: entry.candidate.readiness.ready
        && entry.internshipGate.applicationReadyAllowed,
      // The internship lane orders Preferred before Lower-Stipend, then by
      // monthly amount. This score exists only in the selector copy.
      matchScore: entry.internshipGate.applicable && entry.internshipGate.monthlyAmount != null
        ? Math.min(100, entry.internshipGate.monthlyAmount / 1000)
        : entry.candidate.matchScore,
    },
    identity: { code: 'PROTOTYPE_NEW', novelty: 'new_to_me' },
    novelty: { newToMe: true },
    // classifyCandidate calls the <=2-year shortage fallback "relaxed"; the
    // production reserve selector calls the same bounded lane "reach". Adapt
    // that vocabulary only in this disposable selector input.
    eligibility: reserveEligibility(entry),
    freshness: entry.freshness,
    internshipGate: entry.internshipGate,
  })));
  const eligible = entries
    .filter((entry) => entry.eligibility.eligible && entry.internshipGate.applicationReadyAllowed)
    .map(view);
  const applicationReady = entries.filter((entry) => entry.candidate.applicationReady).map(view);
  const freshUnresolved = entries
    .filter((entry) => entry.freshness.eligible
      && !entry.candidate.readiness.evidence.resolution.ready
      && hardFailureReasons(entry).length === 0)
    .map((entry) => ({ ...view(entry), reasons: entry.candidate.readiness.evidence.resolution.reasons }));
  const undatedVerification = entries
    .filter((entry) => entry.freshness.verifyQueue && hardFailureReasons(entry).length === 0)
    .map((entry) => ({ ...view(entry), reasons: decisionReasons(entry) }));
  const ineligible = entries
    .filter((entry) => hasPolicyRejection(entry) || entry.internshipGate.rejected)
    .map((entry) => ({ ...view(entry), reasons: decisionReasons(entry) }));
  const internships = entries
    .filter((entry) => entry.internshipGate.applicable)
    .map((entry) => view(entry));
  const internshipVerification = entries
    .filter((entry) => entry.internshipGate.verification && hardFailureReasons(entry).length === 0)
    .map((entry) => ({ ...view(entry), reasons: [entry.internshipGate.reason] }));
  const internshipRejected = entries
    .filter((entry) => entry.internshipGate.rejected)
    .map((entry) => ({ ...view(entry), reasons: [entry.internshipGate.reason] }));
  const verification = entries
    .filter((entry) => !(entry.candidate.readiness.ready
      && entry.freshness.eligible
      && entry.internshipGate.applicationReadyAllowed)
      && hardFailureReasons(entry).length === 0)
    .map((entry) => ({ ...view(entry), reasons: decisionReasons(entry) }));
  const stale = entries
    .filter((entry) => !entry.freshness.eligible && !entry.freshness.verifyQueue)
    .map((entry) => ({ ...view(entry), reason: entry.freshness.code }));
  const decisions = entries
    .map((entry) => ({ ...view(entry), reasons: decisionReasons(entry) }))
    .filter((entry) => entry.reasons.length > 0);
  const hardRejected = entries
    .map((entry) => ({ ...view(entry), reasons: hardFailureReasons(entry) }))
    .filter((entry) => entry.reasons.length > 0);
  const rejectionReasons = sortedCounts(hardRejected.flatMap((entry) => entry.reasons));
  const decisionReasonCounts = sortedCounts(decisions.flatMap((entry) => entry.reasons));
  const shortlist = selection.shortlist.map((entry) => view({
    key: identityKeys(entry.candidate)[0],
    candidate: entry.candidate,
    eligibility: entry.eligibility,
    freshness: entry.freshness,
    internshipGate: entry.internshipGate,
  }));

  return {
    ...base,
    eligible,
    applicationReady,
    freshUnresolved,
    undatedVerification,
    ineligible,
    internships,
    internshipVerification,
    internshipRejected,
    verification,
    stale,
    decisions,
    rejections: hardRejected,
    hardRejected,
    rejectionReasons,
    decisionReasonCounts,
    shortlist,
    selection: {
      counts: selection.counts,
      composition: selection.composition,
      excluded: selection.excluded,
      shortfall: selection.shortfall,
    },
    counts: {
      imported: base.imported.length,
      unique: entries.length,
      duplicates: base.duplicates.length,
      eligible: eligible.length,
      applicationReady: applicationReady.length,
      freshUnresolved: freshUnresolved.length,
      undatedVerification: undatedVerification.length,
      ineligible: ineligible.length,
      internships: internships.length,
      internshipVerification: internshipVerification.length,
      internshipRejected: internshipRejected.length,
      verification: verification.length,
      stale: stale.length,
      rejected: hardRejected.length,
      hardRejected: hardRejected.length,
      shortlist: shortlist.length,
    },
  };
}

export function createDiscoveryState({ now } = {}) {
  if (!clean(now)) throw new TypeError('createDiscoveryState requires an explicit ISO now value');
  return rebuildState({
    schemaVersion: 'PluginWebDiscoveryPrototypeV1',
    prototype: true,
    question: PROTOTYPE_QUESTION,
    safety: {
      inMemoryOnly: true,
      networkUsed: false,
      productionSqliteUsed: false,
      notionWrites: false,
      applies: false,
      sends: false,
    },
    now,
    imported: [],
    records: [],
    duplicates: [],
  });
}

export function importEnvelope(state, envelope, { policy, now = state?.now } = {}) {
  if (!state?.prototype) throw new TypeError('state must come from createDiscoveryState');
  if (!policy || typeof policy !== 'object') throw new TypeError('importEnvelope requires a Launchpad policy object');
  if (!clean(now)) throw new TypeError('importEnvelope requires an explicit ISO now value');

  const records = [...state.records];
  const imported = [...state.imported];
  const duplicates = [...state.duplicates];
  const known = new Map();
  for (const entry of records) for (const key of entry.identityKeys) known.set(key, entry.key);

  for (const [index, raw] of requireEnvelope(envelope).entries()) {
    let candidate = normalizeRecord(raw, index, now);
    const stipendGate = internshipGate(raw, candidate);
    if (stipendGate.applicable && stipendGate.status === 'Verified' && candidate.employment.paid == null) {
      candidate = {
        ...candidate,
        employment: {
          ...candidate.employment,
          paid: true,
          evidence: candidate.employment.evidence ?? stipendGate.evidence ?? null,
        },
      };
    }
    const keys = identityKeys(candidate);
    const duplicateKey = keys.find((key) => known.has(key));
    const event = {
      source: candidate.provider,
      sourceJobId: candidate.jobId,
      title: candidate.title,
      company: candidate.company,
      canonicalUrl: candidate.canonicalUrl,
    };
    if (duplicateKey) {
      const duplicate = { ...event, duplicateKey, duplicateOf: known.get(duplicateKey) };
      duplicates.push(duplicate);
      imported.push({ ...event, outcome: 'duplicate', duplicateOf: duplicate.duplicateOf });
      continue;
    }

    const eligibility = classifyCandidate(candidate, policy);
    const freshness = classifyFreshness(candidate, { now, ...policy.freshness });
    const readiness = applicationReadiness(candidate, eligibility);
    const prepared = {
      key: keys[0],
      identityKeys: keys,
      candidate: {
        ...candidate,
        applicationReady: readiness.ready
          && freshness.eligible
          && stipendGate.applicationReadyAllowed,
        readiness,
      },
      eligibility,
      freshness,
      internshipGate: stipendGate,
    };
    records.push(prepared);
    for (const key of keys) known.set(key, prepared.key);
    imported.push({ ...event, outcome: 'accepted', key: prepared.key });
  }

  return rebuildState({ ...state, now, imported, records, duplicates });
}

export function resetDiscoveryState(state) {
  return createDiscoveryState({ now: state.now });
}
