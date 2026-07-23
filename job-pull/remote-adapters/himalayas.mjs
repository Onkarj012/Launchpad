import { parseHimalayasResponse } from '../../career-ops/providers/himalayas.mjs';

export const HIMALAYAS_FEED_URL = 'https://himalayas.app/jobs/api?limit=50';
export const HIMALAYAS_PAGE_LIMIT = 50;

/**
 * The repository's existing native provider contract documents one fixed
 * response at limit=50. It does not document an offset, cursor, or next-page
 * token, so this adapter exposes page 1 metadata without inventing pagination.
 */
export function buildHimalayasRequestPlan({ limit = HIMALAYAS_PAGE_LIMIT, page = 1 } = {}) {
  if (limit !== HIMALAYAS_PAGE_LIMIT) throw new Error('Himalayas supports the documented limit=50 only');
  if (page !== 1) throw new Error('Himalayas pagination is not documented by the repository provider contract');
  return {
    provider: 'himalayas',
    pagination: {
      supported: false,
      page: 1,
      limit: HIMALAYAS_PAGE_LIMIT,
      nextPage: null,
      reason: 'provider contract exposes the fixed ?limit=50 feed only',
    },
    requests: [{ page: 1, limit: HIMALAYAS_PAGE_LIMIT, url: HIMALAYAS_FEED_URL }],
  };
}

export async function fetchHimalayas({ fetchJson, requestPlan = buildHimalayasRequestPlan() } = {}) {
  if (typeof fetchJson !== 'function') throw new Error('Himalayas requires an injected fetchJson function');
  const request = requestPlan.requests[0];
  const response = await fetchJson(request.url, { redirect: 'error' });
  if (!response || !Array.isArray(response.jobs)) throw new Error('himalayas: expected { jobs: [...] }');
  const records = parseHimalayasResponse(response).map((job) => ({
    ...job,
    provider: 'himalayas',
    providerDateField: 'pubDate',
    providerDateEvidence: job.postedAt == null ? null : 'himalayas.pubDate',
    sourceKind: 'niche-public',
    sourceCategory: 'broad-remote',
  }));
  return {
    records,
    telemetry: {
      provider: 'himalayas',
      requestPlan,
      pages: [{ page: 1, requested: HIMALAYAS_PAGE_LIMIT, returned: records.length }],
      dateField: 'pubDate',
      dated: records.filter((record) => record.postedAt != null).length,
    },
  };
}
