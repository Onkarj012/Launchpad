import { createHash } from 'node:crypto';
import { normalizeIdentityKey } from '../job-pull/candidate.mjs';

/** Terminal user/action outcomes — permanently suppress resurfacing. */
export const ACTIONED_STATES = new Set(['applied', 'contacted', 'interviewing', 'rejected']);
/** Surfaced/cooldown — suppress until external ledger expires cooldown; never from raw observation alone. */
export const SURFACED_SUPPRESSION_STATES = new Set(['surfaced', 'cooldown']);
/** Full durable observation lifecycle (monotonic upgrades; actioned is terminal and external). */
export const LIFECYCLE_STATES = Object.freeze({
  OBSERVED: 'observed',
  RESOLVED: 'resolved',
  ELIGIBLE: 'eligible',
  FRESHNESS_VERIFIED: 'freshness-verified',
  APPLICATION_READY: 'application-ready',
  SURFACED: 'surfaced',
  APPLIED: 'applied',
  CONTACTED: 'contacted',
  INTERVIEWING: 'interviewing',
  REJECTED: 'rejected',
  COOLDOWN: 'cooldown',
});
const LIFECYCLE_RANK = Object.freeze({
  observed: 1,
  resolved: 2,
  eligible: 3,
  'freshness-verified': 4,
  'application-ready': 5,
  surfaced: 6,
  cooldown: 6,
  applied: 100,
  contacted: 100,
  interviewing: 100,
  rejected: 100,
});
const SUPPRESSION_STATES = new Set([...ACTIONED_STATES, ...SURFACED_SUPPRESSION_STATES]);
const CLOSED_STATES = new Set(['closed', 'inactive', 'filled', 'expired', 'removed', 'withdrawn']);
const MATCH_TYPES = ['provider_job_id', 'canonical_url', 'company_title_location'];
const UNRESOLVED_RESOLUTION = new Set(['unresolved', 'needs verification']);

const value = (row, ...names) => {
  for (const name of names) {
    if (row?.[name] != null && String(row[name]).trim() !== '') return row[name];
  }
  return null;
};

export function normalizeText(input) {
  return String(input ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function canonicalizeApplicationUrl(input) {
  if (!input) return null;
  try {
    const url = new URL(String(input).trim());
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|gh_src$|source$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    url.pathname = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    return url.toString();
  } catch {
    return normalizeText(input) || null;
  }
}

export function fingerprintDescription(description) {
  const normalized = normalizeText(description);
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

function keysFor(row) {
  const provider = normalizeText(value(row, 'provider', 'sourceProvider'));
  // Prefer stable provider requisition / job IDs (Workday jobReqId, etc.) over
  // company+title+location fallback so distinct requisitions never collapse.
  const providerJobId = normalizeText(value(
    row,
    'providerJobId', 'provider_job_id',
    'requisitionId', 'requisition_id', 'jobReqId', 'job_req_id', 'reqId',
    'jobId', 'job_id',
  )) || normalizeText(row?.evidence?.requisitionId);
  const url = canonicalizeApplicationUrl(value(row, 'canonicalUrl', 'canonical_url', 'url', 'jdLink', 'originalApplicationUrl'));
  const identityText = (input) => normalizeText(input).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const company = identityText(value(row, 'company'));
  const title = identityText(value(row, 'title', 'role'));
  const location = identityText(value(row, 'location'));
  return {
    providerJobId: provider && providerJobId ? `${provider}|${providerJobId}` : null,
    canonicalUrl: url,
    companyTitleLocation: company && title && location ? `${company}|${title}|${location}` : null,
  };
}

function durableJobKey(keys) {
  const selected = keys.providerJobId || keys.canonicalUrl || keys.companyTitleLocation;
  return createHash('sha256').update(`${selected ? selected : 'unkeyed'}\0${keys.providerJobId || ''}\0${keys.canonicalUrl || ''}\0${keys.companyTitleLocation || ''}`).digest('hex');
}

function rows(valueToRows) {
  if (Array.isArray(valueToRows)) return valueToRows.filter(Boolean);
  if (valueToRows instanceof Map) return [...valueToRows.values()].filter(Boolean);
  return [];
}

function jobKey(row) {
  return value(row, 'jobKey', 'job_key') || durableJobKey(keysFor(row));
}

function matchingRows(observation, candidates) {
  const observationKeys = keysFor(observation);
  for (const type of MATCH_TYPES) {
    const key = observationKeys[type === 'provider_job_id' ? 'providerJobId' : type === 'canonical_url' ? 'canonicalUrl' : 'companyTitleLocation'];
    if (!key) continue;
    const matches = candidates.filter((candidate) => {
      const candidateKeys = keysFor(candidate);
      const candidateKey = candidateKeys[type === 'provider_job_id' ? 'providerJobId' : type === 'canonical_url' ? 'canonicalUrl' : 'companyTitleLocation'];
      if (type === 'provider_job_id') {
        const observationIds = [key, ...(observation.identityAliases || [])].map(normalizeIdentityKey);
        const candidateIds = [candidateKey, ...(candidate.identityAliases || [])].filter(Boolean).map(normalizeIdentityKey);
        if (!candidateIds.some((id) => observationIds.includes(id))) return false;
      } else if (candidateKey !== key) return false;
      // Same-provider distinct requisition IDs must never collapse via company-
      // title-location fallback (e.g. two Workday REQs sharing title+location).
      // Cross-source URL matches remain valid when provider IDs differ.
      if (type === 'company_title_location' && observationKeys.providerJobId && candidateKeys.providerJobId
        && observationKeys.providerJobId !== candidateKeys.providerJobId) {
        const obsProvider = observationKeys.providerJobId.split('|')[0];
        const candProvider = candidateKeys.providerJobId.split('|')[0];
        if (obsProvider && obsProvider === candProvider) return false;
      }
      return true;
    });
    if (matches.length) return { type, key, matches };
  }
  return { type: null, key: null, matches: [] };
}

function rawLifecycle(row) {
  return normalizeText(value(row, 'lifecycle', 'lifecycle_state', 'lifecycleState', 'suppressionState', 'action_state', 'actionState', 'state', 'status'));
}

/** Explicit suppression/action state only — never infer from raw observation alone. */
export function stateOf(row) {
  const state = rawLifecycle(row);
  if (ACTIONED_STATES.has(state) || SURFACED_SUPPRESSION_STATES.has(state)) return state;
  // Explicit surface markers set only when a role enters shortlist/reserve output.
  // Ledger last_surfaced_at is intentionally not permanent here — 7-day cooldown
  // expiry is owned by opportunity-ledger.suppressionFor.
  if (row?.surfaced === true || row?.surfacedAt || row?.surfaced_at) return 'surfaced';
  return null;
}

function isClosed(row) {
  return CLOSED_STATES.has(normalizeText(value(row, 'status', 'state', 'classification')));
}

function dateValue(row, ...names) {
  const raw = value(row, ...names);
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

function fingerprintOf(row) {
  return value(row, 'fingerprint', 'descriptionFingerprint', 'description_fingerprint') || fingerprintDescription(value(row, 'description'));
}

export function isApplicationReady(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.applicationReady === true || row.readiness?.ready === true || row.applicationReadiness?.ready === true) return true;
  const lifecycle = rawLifecycle(row);
  if (lifecycle === LIFECYCLE_STATES.APPLICATION_READY || lifecycle === LIFECYCLE_STATES.SURFACED || SURFACED_SUPPRESSION_STATES.has(lifecycle) || ACTIONED_STATES.has(lifecycle)) {
    return true;
  }
  const resolution = row.applicationResolution?.status ?? row.readiness?.evidence?.resolution?.status;
  return ['Resolved Original', 'Direct ATS'].includes(resolution);
}

export function isIncompleteObservation(row) {
  if (!row || typeof row !== 'object') return true;
  if (isApplicationReady(row)) return false;
  if (row.applicationReady === false) return true;
  const lifecycle = rawLifecycle(row);
  if (lifecycle && (LIFECYCLE_RANK[lifecycle] ?? 0) > 0 && (LIFECYCLE_RANK[lifecycle] ?? 0) < LIFECYCLE_RANK['application-ready']) return true;
  const resolution = normalizeText(row.applicationResolution?.status ?? row.readiness?.evidence?.resolution?.status);
  if (UNRESOLVED_RESOLUTION.has(resolution)) return true;
  // Durable jobs rows without readiness fields are incomplete until proven ready or surfaced.
  if (lifecycle == null || lifecycle === '' || lifecycle === 'open' || lifecycle === 'active') {
    return row.applicationReady !== true;
  }
  return true;
}

/** Derive durable lifecycle label from an observation (never 'surfaced' — that is selection-only). */
export function lifecycleFromObservation(observation) {
  if (isApplicationReady(observation)) return LIFECYCLE_STATES.APPLICATION_READY;
  const resolution = normalizeText(observation?.applicationResolution?.status);
  if (resolution && !UNRESOLVED_RESOLUTION.has(resolution) && resolution !== '') return LIFECYCLE_STATES.RESOLVED;
  if (observation?.postedAt || observation?.description || observation?.canonicalUrl) return LIFECYCLE_STATES.OBSERVED;
  return LIFECYCLE_STATES.OBSERVED;
}

export function mergeLifecycleState(prior, next) {
  const previous = normalizeText(prior) || null;
  const incoming = normalizeText(next) || null;
  if (!incoming) return previous;
  if (!previous) return incoming;
  if (ACTIONED_STATES.has(previous)) return previous;
  if (ACTIONED_STATES.has(incoming)) return incoming;
  if (SURFACED_SUPPRESSION_STATES.has(previous) && !ACTIONED_STATES.has(incoming)) return previous;
  const priorRank = LIFECYCLE_RANK[previous] ?? 0;
  const nextRank = LIFECYCLE_RANK[incoming] ?? 0;
  return nextRank >= priorRank ? incoming : previous;
}

function baseEvidence(observation, matchType, matchKey, matches, fingerprint, lifecycleMatch) {
  const lifecycleRow = lifecycleMatch?.matches?.[0] ?? null;
  return {
    matchType,
    matchKey,
    candidates: matches.map((row) => ({ jobKey: jobKey(row), provider: value(row, 'provider'), canonicalUrl: canonicalizeApplicationUrl(value(row, 'canonicalUrl', 'canonical_url', 'url')) })),
    fingerprint: {
      current: fingerprint,
      prior: matches.length === 1 ? fingerprintOf(matches[0]) : null,
      same: matches.length === 1 && fingerprint && fingerprintOf(matches[0]) ? fingerprint === fingerprintOf(matches[0]) : null,
    },
    lifecycle: lifecycleRow ? { state: stateOf(lifecycleRow) || rawLifecycle(lifecycleRow), matchType: lifecycleMatch.type, matchKey: lifecycleMatch.key } : null,
  };
}

export function resolveJobIdentity(observation, { existingJobs = [], lifecycleRows = [] } = {}) {
  const currentKeys = keysFor(observation);
  const fingerprint = value(observation, 'fingerprint', 'descriptionFingerprint', 'description_fingerprint') || fingerprintDescription(value(observation, 'description'));
  const jobs = rows(existingJobs);
  const lifecycle = rows(lifecycleRows);
  const jobMatch = matchingRows(observation, jobs);
  const lifecycleMatch = matchingRows(observation, lifecycle);
  const identity = {
    jobKey: jobMatch.matches.length === 1 ? jobKey(jobMatch.matches[0]) : durableJobKey(currentKeys),
    providerJobId: currentKeys.providerJobId,
    canonicalUrl: currentKeys.canonicalUrl,
    companyTitleLocation: currentKeys.companyTitleLocation,
  };

  if (jobMatch.matches.length > 1 || lifecycleMatch.matches.length > 1) {
    return { code: 'AMBIGUOUS_COLLISION', novelty: 'not_new', authority: 'external_lifecycle_data', identity, fingerprint, evidence: baseEvidence(observation, jobMatch.type || lifecycleMatch.type, jobMatch.key || lifecycleMatch.key, jobMatch.matches.length > 1 ? jobMatch.matches : lifecycleMatch.matches, fingerprint, null) };
  }

  // Actioned always wins — permanent suppression even if observation looks newly actionable.
  if (lifecycleMatch.matches.length === 1 && stateOf(lifecycleMatch.matches[0])) {
    const state = stateOf(lifecycleMatch.matches[0]);
    return { code: `SUPPRESSED_${state.toUpperCase()}`, novelty: 'not_new', authority: 'external_lifecycle_data', identity, fingerprint, evidence: baseEvidence(observation, jobMatch.type || lifecycleMatch.type, jobMatch.key || lifecycleMatch.key, jobMatch.matches, fingerprint, lifecycleMatch) };
  }

  if (!jobMatch.matches.length) {
    const code = isClosed(observation) ? 'CLOSURE' : 'NEW_TO_ME';
    return {
      code,
      novelty: code === 'NEW_TO_ME' ? 'new_to_me' : 'not_new',
      authority: 'crawler_identity_only',
      identity,
      fingerprint,
      lifecycle: lifecycleFromObservation(observation),
      evidence: baseEvidence(observation, null, null, [], fingerprint, null),
    };
  }

  const prior = jobMatch.matches[0];
  const priorSuppression = stateOf(prior);
  if (priorSuppression) {
    return {
      code: `SUPPRESSED_${priorSuppression.toUpperCase()}`,
      novelty: 'not_new',
      authority: 'crawler_identity_only',
      identity,
      fingerprint,
      lifecycle: priorSuppression,
      evidence: baseEvidence(observation, jobMatch.type, jobMatch.key, jobMatch.matches, fingerprint, null),
    };
  }

  const priorFingerprint = fingerprintOf(prior);
  const evidence = baseEvidence(observation, jobMatch.type, jobMatch.key, jobMatch.matches, fingerprint, null);
  const materialRefresh = Boolean(fingerprint && priorFingerprint && fingerprint !== priorFingerprint);
  const repost = !isClosed(observation) && isClosed(prior) && (dateValue(observation, 'postedAt', 'posted_at') ?? 0) > (dateValue(prior, 'closedAt', 'closed_at', 'lastSeenAt', 'last_seen_at') ?? 0);
  const currentReady = isApplicationReady(observation);
  const priorIncomplete = isIncompleteObservation(prior);
  // Incomplete prior observation becoming application-ready may surface once.
  const newlyActionable = currentReady && priorIncomplete && !isClosed(observation) && !repost;

  let code = 'UNCHANGED_DUPLICATE';
  let novelty = 'not_new';
  if (isClosed(observation)) code = 'CLOSURE';
  else if (repost) { code = 'REPOST'; novelty = 'new_to_me'; }
  else if (newlyActionable) { code = 'NEWLY_ACTIONABLE'; novelty = 'new_to_me'; }
  else if (materialRefresh) code = 'MATERIAL_REFRESH';

  evidence.classification = {
    priorStatus: value(prior, 'status', 'state', 'lifecycle', 'lifecycle_state'),
    currentStatus: value(observation, 'status', 'state'),
    repost,
    materialRefresh,
    newlyActionable,
    reevaluate: materialRefresh || newlyActionable,
  };
  return {
    code,
    novelty,
    authority: 'crawler_identity_only',
    identity,
    fingerprint,
    lifecycle: newlyActionable ? LIFECYCLE_STATES.APPLICATION_READY : mergeLifecycleState(rawLifecycle(prior) || lifecycleFromObservation(prior), lifecycleFromObservation(observation)),
    evidence,
  };
}

export const reconcileJobIdentity = resolveJobIdentity;
