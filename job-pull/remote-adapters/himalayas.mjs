import { parseHimalayasResponse } from '../../career-ops/providers/himalayas.mjs';

// Live-verified 2026-07-24 against https://himalayas.app/docs/remote-jobs-api and
// direct curl of both endpoints. Himalayas exposes two distinct endpoints:
//   - /jobs/api        : unfiltered browse feed, offset/limit only, capped at 20.
//   - /jobs/api/search : filtered search (q, country, worldwide, exclude_worldwide,
//                        seniority, employment_type, company, timezone, sort, page),
//                        also capped at 20 records per page.
// The repository previously documented a fixed limit=50 browse-only contract; the
// live API now defaults to and caps every request (browse or search) at 20 records
// regardless of the requested `limit` value, and the filters needed for India-first
// discovery only exist on the search endpoint. There is no `keyword` parameter name
// on the wire — free-text search uses `q`.
export const HIMALAYAS_SEARCH_URL = 'https://himalayas.app/jobs/api/search';
export const HIMALAYAS_PAGE_LIMIT = 20;
export const HIMALAYAS_DEFAULT_SENIORITY = 'Entry-level';
export const HIMALAYAS_DEFAULT_SORT = 'recent';

// Country tokens recognized by remote-enrichment.mjs's COUNTRY_RESTRICTION exclusion
// regex. A single-country locationRestrictions array is an unambiguous "X only"
// restriction; anything else is left as informational text so the classifier can
// make its own Needs-Verification call rather than us guessing at eligibility.
const RESTRICTIVE_COUNTRY_TOKENS = new Set([
  'united states', 'usa', 'us', 'canada', 'europe', 'eu', 'united kingdom', 'uk',
  'australia', 'new zealand', 'latam', 'latin america',
]);

function buildSearchUrl(params) {
  const url = new URL(HIMALAYAS_SEARCH_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Builds the India-first + worldwide two-pass Himalayas search plan. The browse
 * endpoint has no country/seniority/keyword filters, so India-first discovery must
 * use the search endpoint; a second worldwide pass follows so eligible-worldwide
 * roles are not missed just because they omit "India" from locationRestrictions.
 */
export function buildHimalayasRequestPlan({ keyword = null, seniority = HIMALAYAS_DEFAULT_SENIORITY, sort = HIMALAYAS_DEFAULT_SORT } = {}) {
  const indiaUrl = buildSearchUrl({ country: 'IN', seniority, q: keyword, sort });
  const worldwideUrl = buildSearchUrl({ worldwide: 'true', seniority, q: keyword, sort });
  return {
    provider: 'himalayas',
    pagination: {
      supported: false,
      page: 1,
      limit: HIMALAYAS_PAGE_LIMIT,
      nextPage: null,
      reason: 'Himalayas search endpoint caps every request at 20 records; discovery runs an India-first pass then a worldwide pass instead of paging deeper',
    },
    requests: [
      { pass: 'india', params: { country: 'IN', seniority, keyword, sort }, url: indiaUrl },
      { pass: 'worldwide', params: { worldwide: true, seniority, keyword, sort }, url: worldwideUrl },
    ],
  };
}

function normalizeForMatch(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return new URL(value.trim()).href; } catch { return null; }
}

/** Index raw search-response jobs by their (validated-URL-comparable) applicationLink/guid so parsed records can recover extra fields the shared career-ops parser drops. */
function rawJobIndex(response) {
  const index = new Map();
  for (const item of response?.jobs || []) {
    if (!item || typeof item !== 'object') continue;
    for (const link of [item.applicationLink, item.guid]) {
      const key = normalizeForMatch(link);
      if (key && !index.has(key)) index.set(key, item);
    }
  }
  return index;
}

function toIso(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

/** locationRestrictions: [] means worldwide (documented API semantic, not inferred from "remote"); a single country is an explicit "X only" restriction. */
function countryRestrictionEvidence(locationRestrictions) {
  if (!Array.isArray(locationRestrictions)) return null;
  if (locationRestrictions.length === 0) return 'Worldwide (Himalayas locationRestrictions: empty)';
  if (locationRestrictions.length === 1) {
    const country = String(locationRestrictions[0]);
    const suffix = RESTRICTIVE_COUNTRY_TOKENS.has(country.trim().toLowerCase()) ? ' only' : '';
    return `${country}${suffix} (Himalayas locationRestrictions)`;
  }
  return `Himalayas locationRestrictions: ${locationRestrictions.join(', ')}`;
}

/** timezoneRestrictions: [] means all timezones accepted (documented API semantic). */
function timezoneEvidence(timezoneRestrictions) {
  if (!Array.isArray(timezoneRestrictions)) return null;
  if (timezoneRestrictions.length === 0) return 'All timezones accepted (Himalayas timezoneRestrictions: empty)';
  return `Himalayas timezoneRestrictions (UTC offsets): ${timezoneRestrictions.join(', ')}`;
}

function buildRecord(job, raw) {
  const locationRestrictions = Array.isArray(raw?.locationRestrictions) ? raw.locationRestrictions : null;
  const timezoneRestrictions = Array.isArray(raw?.timezoneRestrictions) ? raw.timezoneRestrictions : null;
  const employmentType = typeof raw?.employmentType === 'string' && raw.employmentType.trim() ? raw.employmentType.trim() : null;
  const expiryIso = toIso(raw?.expiryDate);
  const tzEvidence = timezoneEvidence(timezoneRestrictions);
  return {
    ...job,
    provider: 'himalayas',
    providerDateField: 'pubDate',
    providerDateEvidence: job.postedAt == null ? null : 'himalayas.pubDate',
    providerExpiryDate: expiryIso,
    providerExpiryEvidence: expiryIso == null ? null : 'himalayas.expiryDate',
    ...(employmentType ? { employmentType, employmentEvidence: employmentType } : {}),
    countryRestrictionEvidence: locationRestrictions ? countryRestrictionEvidence(locationRestrictions) : null,
    timezoneEvidence: tzEvidence,
    timezoneOverlapEvidence: tzEvidence,
    sourceKind: 'niche-public',
    sourceCategory: 'broad-remote',
  };
}

export async function fetchHimalayas({ fetchJson, requestPlan = null, keyword = null, seniority = HIMALAYAS_DEFAULT_SENIORITY, sort = HIMALAYAS_DEFAULT_SORT } = {}) {
  if (typeof fetchJson !== 'function') throw new Error('Himalayas requires an injected fetchJson function');
  const plan = requestPlan || buildHimalayasRequestPlan({ keyword, seniority, sort });
  const seenUrls = new Set();
  const records = [];
  const pages = [];
  for (const request of plan.requests) {
    const response = await fetchJson(request.url, { redirect: 'error' });
    if (!response || !Array.isArray(response.jobs)) throw new Error(`himalayas: expected { jobs: [...] } for the ${request.pass} pass`);
    const rawIndex = rawJobIndex(response);
    const parsed = parseHimalayasResponse(response);
    let added = 0;
    for (const job of parsed) {
      if (seenUrls.has(job.url)) continue;
      seenUrls.add(job.url);
      added += 1;
      records.push(buildRecord(job, rawIndex.get(normalizeForMatch(job.url))));
    }
    pages.push({ page: 1, pass: request.pass, requested: HIMALAYAS_PAGE_LIMIT, returned: parsed.length, added });
  }
  return {
    records,
    telemetry: {
      provider: 'himalayas',
      requestPlan: plan,
      pages,
      dateField: 'pubDate',
      dated: records.filter((record) => record.postedAt != null).length,
    },
  };
}
