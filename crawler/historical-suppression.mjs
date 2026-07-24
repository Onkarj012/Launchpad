import {
  canonicalizeApplicationUrl,
  normalizeText,
} from './identity.mjs';

const MATCH_TYPES = Object.freeze([
  'provider_job_id',
  'canonical_url',
  'company_title_location',
]);

const firstValue = (row, names) => {
  for (const name of names) {
    if (row?.[name] != null && String(row[name]).trim() !== '') return row[name];
  }
  return null;
};

const identityText = (value) => normalizeText(value)
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim() || null;

function keysFor(row) {
  const provider = identityText(firstValue(row, ['provider', 'sourceProvider', 'source_provider', 'portal']));
  const providerJobId = identityText(firstValue(row, [
    'providerJobId', 'provider_job_id', 'jobId', 'job_id', 'externalId', 'external_id',
  ]));
  const canonicalUrl = canonicalizeApplicationUrl(firstValue(row, [
    'canonicalUrl', 'canonical_url', 'originalApplicationUrl', 'original_application_url',
    'applicationUrl', 'application_url', 'url', 'jdLink', 'jd_link',
  ]));
  const company = identityText(firstValue(row, ['company', 'companyName', 'company_name']));
  const title = identityText(firstValue(row, ['title', 'role', 'jobTitle', 'job_title']));
  const location = identityText(firstValue(row, ['location', 'jobLocation', 'job_location']));

  return {
    providerJobId: provider && providerJobId ? `${provider}|${providerJobId}` : null,
    canonicalUrl,
    companyTitleLocation: company && title && location ? `${company}|${title}|${location}` : null,
  };
}

function rowsFrom(input) {
  if (Array.isArray(input)) return input.filter(Boolean);
  if (Array.isArray(input?.rows)) return input.rows.filter(Boolean);
  if (input instanceof Map) return [...input.values()].filter(Boolean);
  return [];
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function emptyBuckets() {
  return {
    provider_job_id: Object.create(null),
    canonical_url: Object.create(null),
    company_title_location: Object.create(null),
  };
}

function addBucket(bucket, key, entry) {
  if (!key) return;
  (bucket[key] ??= []).push(entry);
}

function evidenceFor(entry, matchTypes, matchKeys) {
  return {
    historicalRowIndex: entry.rowIndex,
    historicalIdentity: entry.identity,
    historicalState: entry.state,
    historicalProvider: entry.provider,
    matchTypes,
    matchKeys,
    immutable: true,
    v4Writes: false,
  };
}

/**
 * Build a read-only identity index from supplied v4 rows.
 *
 * This function intentionally performs no filesystem, network, v4 migration,
 * deletion, or write operation. Historical rows are represented only by
 * normalized identity and suppression evidence.
 */
export function buildHistoricalSuppressionIndex(input) {
  const buckets = emptyBuckets();
  const rows = rowsFrom(input);

  rows.forEach((row, rowIndex) => {
    const identity = keysFor(row);
    const entry = {
      rowIndex,
      identity,
      provider: identity.providerJobId?.split('|')[0] ?? null,
      state: identityText(firstValue(row, ['state', 'status', 'lifecycle', 'actionState', 'action_state'])),
    };
    addBucket(buckets.provider_job_id, identity.providerJobId, entry);
    addBucket(buckets.canonical_url, identity.canonicalUrl, entry);
    addBucket(buckets.company_title_location, identity.companyTitleLocation, entry);
  });

  // Plain frozen objects keep the returned index inspectable while preventing
  // callers from changing the historical view after construction.
  return freeze({
    schemaVersion: 'LaunchpadHistoricalSuppressionV1',
    rowCount: rows.length,
    keys: freeze({
      provider_job_id: freeze(buckets.provider_job_id),
      canonical_url: freeze(buckets.canonical_url),
      company_title_location: freeze(buckets.company_title_location),
    }),
    immutable: true,
    v4Writes: false,
  });
}

/**
 * Check one current candidate against the immutable historical index.
 * Ambiguous keys never suppress: the caller must resolve the collision first.
 */
export function suppressHistoricalCandidate(candidate, index) {
  const identity = keysFor(candidate);
  const matches = [];
  const ambiguous = [];

  for (const type of MATCH_TYPES) {
    const key = identity[type === 'provider_job_id' ? 'providerJobId' : type === 'canonical_url' ? 'canonicalUrl' : 'companyTitleLocation'];
    if (!key) continue;
    const entries = index?.keys?.[type]?.[key] ?? [];
    if (entries.length > 1) ambiguous.push({ matchType: type, matchKey: key, rowIndexes: entries.map((entry) => entry.rowIndex) });
    else if (entries.length === 1) matches.push({ type, key, entry: entries[0] });
  }

  const distinctRows = [...new Set(matches.map(({ entry }) => entry.rowIndex))];
  if (ambiguous.length || distinctRows.length > 1) {
    return {
      suppressed: false,
      code: 'AMBIGUOUS_COLLISION',
      identity,
      evidence: { ambiguous, matches: matches.map(({ type, key }) => ({ matchType: type, matchKey: key })), immutable: true, v4Writes: false },
    };
  }

  if (!matches.length) {
    return { suppressed: false, code: 'NO_HISTORICAL_MATCH', identity, evidence: null };
  }

  return {
    suppressed: true,
    code: 'SUPPRESSED_HISTORICAL',
    identity,
    evidence: evidenceFor(matches[0].entry, matches.map(({ type }) => type), matches.map(({ key }) => key)),
  };
}

/**
 * Convenience seam for mode runners: split candidates into those that survive
 * v4 suppression, those suppressed, and those with ambiguous historical matches.
 * Ambiguous collisions never auto-suppress or auto-merge — callers must route
 * them to verification (fail closed). Read-only against v4 rows; an
 * empty/missing historicalRows list is a no-op (nothing suppressed).
 */
export function filterHistoricalCandidates(candidates = [], historicalRows = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  const rows = Array.isArray(historicalRows) ? historicalRows : [];
  if (!rows.length) return { kept: list, suppressed: [], ambiguous: [], index: null };

  const index = buildHistoricalSuppressionIndex(rows);
  const kept = [];
  const suppressed = [];
  const ambiguous = [];
  for (const candidate of list) {
    const result = suppressHistoricalCandidate(candidate, index);
    if (result.code === 'AMBIGUOUS_COLLISION') {
      ambiguous.push({
        company: candidate?.company ?? null,
        title: candidate?.title ?? null,
        canonicalUrl: candidate?.canonicalUrl ?? candidate?.discoveryUrl ?? candidate?.originalApplicationUrl ?? candidate?.applicationUrl ?? candidate?.url ?? null,
        code: result.code,
        identity: result.identity,
        evidence: result.evidence,
        candidate,
        immutable: true,
        v4Writes: false,
      });
      continue;
    }
    if (!result.suppressed) { kept.push(candidate); continue; }
    suppressed.push({
      company: candidate?.company ?? null,
      title: candidate?.title ?? null,
      canonicalUrl: candidate?.canonicalUrl ?? candidate?.discoveryUrl ?? candidate?.originalApplicationUrl ?? candidate?.applicationUrl ?? candidate?.url ?? null,
      code: result.code,
      historicalIdentity: result.evidence.historicalIdentity,
      historicalRowIndex: result.evidence.historicalRowIndex,
      historicalState: result.evidence.historicalState,
      matchTypes: result.evidence.matchTypes,
      matchKeys: result.evidence.matchKeys,
      immutable: true,
      v4Writes: false,
    });
  }
  return { kept, suppressed, ambiguous, index };
}
