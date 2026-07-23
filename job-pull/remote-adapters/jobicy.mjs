import { parseJobicyResponse } from '../../career-ops/providers/jobicy.mjs';

export const JOBICY_FEED_URL = 'https://jobicy.com/api/v2/remote-jobs?count=50';
export const JOBICY_FEED_LIMIT = 50;

export async function fetchJobicy({ fetchJson, defaultCompany = 'Jobicy' } = {}) {
  if (typeof fetchJson !== 'function') throw new Error('Jobicy requires an injected fetchJson function');
  const response = await fetchJson(JOBICY_FEED_URL, { redirect: 'error' });
  if (!response || !Array.isArray(response.jobs)) throw new Error('jobicy: expected { jobs: [...] }');
  const records = parseJobicyResponse(response, defaultCompany).map((job) => ({
    ...job,
    provider: 'jobicy',
    providerDateField: 'pubDate',
    providerDateEvidence: job.postedAt == null ? null : 'jobicy.pubDate',
    sourceKind: 'niche-public',
    sourceCategory: 'broad-remote',
  }));
  return {
    records,
    telemetry: {
      provider: 'jobicy',
      requestPlan: { pagination: { supported: false, reason: 'native feed is the documented count=50 response' }, count: JOBICY_FEED_LIMIT, url: JOBICY_FEED_URL },
      pages: [{ page: 1, requested: JOBICY_FEED_LIMIT, returned: records.length }],
      dateField: 'pubDate',
      dated: records.filter((record) => record.postedAt != null).length,
    },
  };
}
