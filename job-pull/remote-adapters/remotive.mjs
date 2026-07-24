// Live-verified 2026-07-24: GET https://remotive.com/api/remote-jobs still returns
// { "job-count", "total-job-count", jobs: [...] } with each job carrying
// candidate_required_location (a free-text applicant-eligibility field, e.g. "USA",
// "Worldwide", "Europe, UK, Germany, France, European timezones") and job_type
// (e.g. "full_time", "contract", "freelance", "part_time", or ""). Remotive's own
// API terms state public API results are delayed 24 hours versus the live board.
export const REMOTIVE_FEED_URL = 'https://remotive.com/api/remote-jobs';

// Country tokens recognized by remote-enrichment.mjs's COUNTRY_RESTRICTION
// exclusion regex — used only to decide whether a single-token restriction is
// unambiguous enough to phrase as "X only"; multi-token locations are passed
// through as plain informational text so no eligibility is inferred here.
const RESTRICTIVE_COUNTRY_TOKENS = new Set([
  'united states', 'usa', 'us', 'canada', 'europe', 'eu', 'united kingdom', 'uk',
  'australia', 'new zealand', 'latam', 'latin america',
]);

const JOB_TYPE_LABELS = new Map([
  ['full_time', 'Full Time'],
  ['part_time', 'Part Time'],
  ['contract', 'Contract'],
  ['freelance', 'Freelance'],
  ['internship', 'Internship'],
]);

function dateValue(value) {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function remotiveEmploymentType(jobType) {
  const key = typeof jobType === 'string' ? jobType.trim().toLowerCase() : '';
  return key ? JOB_TYPE_LABELS.get(key) || jobType.trim() : null;
}

/** candidate_required_location is Remotive's own applicant-eligibility field, not company HQ. A single restrictive token is an unambiguous "X only" restriction. */
function countryRestrictionEvidence(location) {
  const text = typeof location === 'string' ? location.trim() : '';
  if (!text) return null;
  const tokens = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (tokens.length === 1 && RESTRICTIVE_COUNTRY_TOKENS.has(tokens[0].toLowerCase())) {
    return `${tokens[0]} only (Remotive candidate_required_location)`;
  }
  return `Remotive candidate_required_location: ${text}`;
}

export function parseRemotiveResponse(response, defaultCompany = 'Remotive') {
  if (!response || !Array.isArray(response.jobs)) return [];
  return response.jobs.flatMap((job) => {
    if (!job || typeof job !== 'object') return [];
    const title = typeof job.title === 'string' ? job.title.trim() : '';
    const url = typeof job.url === 'string' ? job.url.trim() : '';
    if (!title || !/^https?:\/\//i.test(url)) return [];
    const postedAt = dateValue(job.publication_date ?? job.postedAt ?? job.created_at);
    const employmentType = remotiveEmploymentType(job.job_type);
    return [{
      title,
      url,
      company: typeof job.company_name === 'string' && job.company_name.trim() ? job.company_name.trim() : defaultCompany,
      location: typeof job.candidate_required_location === 'string' ? job.candidate_required_location.trim() : '',
      description: typeof job.description === 'string' ? job.description : null,
      postedAt,
      providerDateField: job.publication_date != null ? 'publication_date' : job.postedAt != null ? 'postedAt' : job.created_at != null ? 'created_at' : null,
      providerDateEvidence: postedAt ? 'remotive provider date field' : null,
      ...(employmentType ? { employmentType, employmentEvidence: employmentType } : {}),
      countryRestrictionEvidence: countryRestrictionEvidence(job.candidate_required_location),
      sourceKind: 'niche-public',
      sourceCategory: 'broad-remote',
      provider: 'remotive',
      remoteProviderPolicy: { first24hEligible: false, reason: 'Remotive inventory is delayed and cannot satisfy the first-24-hour tier' },
    }];
  });
}

export async function fetchRemotive({ fetchJson, defaultCompany = 'Remotive' } = {}) {
  if (typeof fetchJson !== 'function') throw new Error('Remotive requires an injected fetchJson function');
  const response = await fetchJson(REMOTIVE_FEED_URL, { redirect: 'error' });
  if (!response || !Array.isArray(response.jobs)) throw new Error('remotive: expected { jobs: [...] }');
  const records = parseRemotiveResponse(response, defaultCompany);
  return {
    records,
    telemetry: {
      provider: 'remotive',
      requestPlan: { pagination: { supported: false, reason: 'native board-wide feed has no documented page parameter' }, url: REMOTIVE_FEED_URL },
      pages: [{ page: 1, returned: records.length }],
      dateField: 'publication_date',
      dated: records.filter((record) => record.postedAt != null).length,
      first24hEligible: false,
    },
  };
}
