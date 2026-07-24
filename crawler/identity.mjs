import { createHash } from 'node:crypto';

const SUPPRESSION_STATES = new Set(['surfaced', 'applied', 'contacted', 'interviewing', 'rejected', 'cooldown']);
const CLOSED_STATES = new Set(['closed', 'inactive', 'filled', 'expired', 'removed', 'withdrawn']);
const MATCH_TYPES = ['provider_job_id', 'canonical_url', 'company_title_location'];

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
  const providerJobId = normalizeText(value(row, 'providerJobId', 'provider_job_id', 'jobId', 'job_id'));
  const url = canonicalizeApplicationUrl(value(row, 'canonicalUrl', 'canonical_url', 'url', 'jdLink'));
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
      return candidateKeys[type === 'provider_job_id' ? 'providerJobId' : type === 'canonical_url' ? 'canonicalUrl' : 'companyTitleLocation'] === key;
    });
    if (matches.length) return { type, key, matches };
  }
  return { type: null, key: null, matches: [] };
}

function stateOf(row) {
  const state = normalizeText(value(row, 'state', 'status', 'lifecycle', 'suppressionState', 'action_state', 'actionState'));
  if (SUPPRESSION_STATES.has(state)) return state;
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

function baseEvidence(observation, matchType, matchKey, matches, fingerprint, lifecycleMatch) {
  return {
    matchType,
    matchKey,
    candidates: matches.map((row) => ({ jobKey: jobKey(row), provider: value(row, 'provider'), canonicalUrl: canonicalizeApplicationUrl(value(row, 'canonicalUrl', 'canonical_url', 'url')) })),
    fingerprint: {
      current: fingerprint,
      prior: matches.length === 1 ? fingerprintOf(matches[0]) : null,
      same: matches.length === 1 && fingerprint && fingerprintOf(matches[0]) ? fingerprint === fingerprintOf(matches[0]) : null,
    },
    lifecycle: lifecycleMatch ? { state: stateOf(lifecycleMatch.row), matchType: lifecycleMatch.type, matchKey: lifecycleMatch.key } : null,
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

  if (lifecycleMatch.matches.length === 1 && stateOf(lifecycleMatch.matches[0])) {
    const state = stateOf(lifecycleMatch.matches[0]);
    return { code: `SUPPRESSED_${state.toUpperCase()}`, novelty: 'not_new', authority: 'external_lifecycle_data', identity, fingerprint, evidence: baseEvidence(observation, jobMatch.type || lifecycleMatch.type, jobMatch.key || lifecycleMatch.key, jobMatch.matches, fingerprint, lifecycleMatch) };
  }

  if (!jobMatch.matches.length) {
    const code = isClosed(observation) ? 'CLOSURE' : 'NEW_TO_ME';
    return { code, novelty: code === 'NEW_TO_ME' ? 'new_to_me' : 'not_new', authority: 'crawler_identity_only', identity, fingerprint, evidence: baseEvidence(observation, null, null, [], fingerprint, null) };
  }

  const prior = jobMatch.matches[0];
  const priorFingerprint = fingerprintOf(prior);
  const evidence = baseEvidence(observation, jobMatch.type, jobMatch.key, jobMatch.matches, fingerprint, null);
  const repost = !isClosed(observation) && isClosed(prior) && (dateValue(observation, 'postedAt', 'posted_at') ?? 0) > (dateValue(prior, 'closedAt', 'closed_at', 'lastSeenAt', 'last_seen_at') ?? 0);
  let code = 'UNCHANGED_DUPLICATE';
  let novelty = 'not_new';
  if (isClosed(observation)) code = 'CLOSURE';
  else if (repost) { code = 'REPOST'; novelty = 'new_to_me'; }
  else if (fingerprint && priorFingerprint && fingerprint !== priorFingerprint) code = 'MATERIAL_REFRESH';
  evidence.classification = { priorStatus: value(prior, 'status', 'state'), currentStatus: value(observation, 'status', 'state'), repost };
  return { code, novelty, authority: 'crawler_identity_only', identity, fingerprint, evidence };
}

export const reconcileJobIdentity = resolveJobIdentity;
