export const REMOTIVE_FEED_URL = 'https://remotive.com/api/remote-jobs';

function dateValue(value) {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseRemotiveResponse(response, defaultCompany = 'Remotive') {
  if (!response || !Array.isArray(response.jobs)) return [];
  return response.jobs.flatMap((job) => {
    if (!job || typeof job !== 'object') return [];
    const title = typeof job.title === 'string' ? job.title.trim() : '';
    const url = typeof job.url === 'string' ? job.url.trim() : '';
    if (!title || !/^https?:\/\//i.test(url)) return [];
    const postedAt = dateValue(job.publication_date ?? job.postedAt ?? job.created_at);
    return [{
      title,
      url,
      company: typeof job.company_name === 'string' && job.company_name.trim() ? job.company_name.trim() : defaultCompany,
      location: typeof job.candidate_required_location === 'string' ? job.candidate_required_location.trim() : '',
      description: typeof job.description === 'string' ? job.description : null,
      postedAt,
      providerDateField: job.publication_date != null ? 'publication_date' : job.postedAt != null ? 'postedAt' : job.created_at != null ? 'created_at' : null,
      providerDateEvidence: postedAt ? 'remotive provider date field' : null,
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
