import { parseJobicyResponse } from '../../career-ops/providers/jobicy.mjs';

// Live-verified 2026-07-24: GET https://jobicy.com/api/v2/remote-jobs?count=50
// still returns { jobCount, jobs: [...] } with count=50 honored exactly (50 jobs
// back), so the documented count=50 contract has not drifted. Each job carries
// jobGeo (candidate-eligibility geography, e.g. "USA", "Europe, Germany,
// Netherlands, UK", "EMEA") and jobType (array, e.g. ["Full-Time"]) alongside the
// existing jobTitle/url/companyName/pubDate fields. Jobicy's own fair-use notice
// states application buttons must resolve to the original job URL and Jobicy be
// credited; Jobicy's own docs put its refresh delay at roughly six hours.
export const JOBICY_FEED_URL = 'https://jobicy.com/api/v2/remote-jobs?count=50';
export const JOBICY_FEED_LIMIT = 50;
export const JOBICY_PROVIDER_DELAY_HOURS = 6;

// Country tokens recognized by remote-enrichment.mjs's COUNTRY_RESTRICTION
// exclusion regex — used only to decide whether a single-token jobGeo value is
// unambiguous enough to phrase as "X only"; multi-token geos (e.g. "Europe,
// Germany, Netherlands, UK") are passed through as plain informational text so
// no eligibility is inferred here.
const RESTRICTIVE_COUNTRY_TOKENS = new Set([
  'united states', 'usa', 'us', 'canada', 'europe', 'eu', 'united kingdom', 'uk',
  'australia', 'new zealand', 'latam', 'latin america',
]);

function jobicyEmploymentType(job) {
  const type = Array.isArray(job?.jobType) ? job.jobType.find((value) => typeof value === 'string' && value.trim()) : null;
  return typeof type === 'string' ? type.trim() : null;
}

/** jobGeo is Jobicy's candidate-eligibility geography field (documented alongside "geography, level and job type"), not company HQ. A single restrictive token is an unambiguous "X only" restriction. */
function countryRestrictionEvidence(jobGeo) {
  const text = typeof jobGeo === 'string' ? jobGeo.trim() : '';
  if (!text) return null;
  const tokens = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (tokens.length === 1 && RESTRICTIVE_COUNTRY_TOKENS.has(tokens[0].toLowerCase())) {
    return `${tokens[0]} only (Jobicy jobGeo)`;
  }
  return `Jobicy jobGeo: ${text}`;
}

export async function fetchJobicy({ fetchJson, defaultCompany = 'Jobicy' } = {}) {
  if (typeof fetchJson !== 'function') throw new Error('Jobicy requires an injected fetchJson function');
  const response = await fetchJson(JOBICY_FEED_URL, { redirect: 'error' });
  if (!response || !Array.isArray(response.jobs)) throw new Error('jobicy: expected { jobs: [...] }');
  const rawByUrl = new Map(response.jobs.filter((job) => job && typeof job.url === 'string').map((job) => [job.url.trim(), job]));
  const records = parseJobicyResponse(response, defaultCompany).map((job) => {
    // parseJobicyResponse does not pass jobGeo/jobType through, so recover the raw
    // feed item by URL (both job.url values are derived from the same raw record).
    const raw = rawByUrl.get(job.url) || null;
    const employmentType = jobicyEmploymentType(raw);
    return {
      ...job,
      provider: 'jobicy',
      providerDateField: 'pubDate',
      providerDateEvidence: job.postedAt == null ? null : 'jobicy.pubDate',
      providerDelayHours: JOBICY_PROVIDER_DELAY_HOURS,
      ...(employmentType ? { employmentType, employmentEvidence: employmentType } : {}),
      countryRestrictionEvidence: countryRestrictionEvidence(raw?.jobGeo),
      sourceKind: 'niche-public',
      sourceCategory: 'broad-remote',
    };
  });
  return {
    records,
    telemetry: {
      provider: 'jobicy',
      requestPlan: { pagination: { supported: false, reason: 'native feed is the documented count=50 response' }, count: JOBICY_FEED_LIMIT, url: JOBICY_FEED_URL },
      pages: [{ page: 1, requested: JOBICY_FEED_LIMIT, returned: records.length }],
      dateField: 'pubDate',
      dated: records.filter((record) => record.postedAt != null).length,
      providerDelayHours: JOBICY_PROVIDER_DELAY_HOURS,
    },
  };
}
