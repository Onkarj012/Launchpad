import { parseWwrFeed } from '../../career-ops/providers/weworkremotely.mjs';

export const WWR_FEED_URL = 'https://weworkremotely.com/remote-jobs.rss';

export async function fetchWeWorkRemotely({ fetchText, defaultCompany = 'We Work Remotely' } = {}) {
  if (typeof fetchText !== 'function') throw new Error('We Work Remotely requires an injected fetchText function');
  const response = await fetchText(WWR_FEED_URL, { redirect: 'error' });
  const records = parseWwrFeed(response, defaultCompany).map((job) => ({
    ...job,
    provider: 'weworkremotely',
    providerDateField: 'pubDate',
    providerDateEvidence: job.postedAt == null ? null : 'weworkremotely.pubDate',
    sourceKind: 'niche-public',
    sourceCategory: 'broad-remote',
  }));
  return {
    records,
    telemetry: {
      provider: 'weworkremotely',
      requestPlan: { pagination: { supported: false, reason: 'native RSS feed has no documented page parameter' }, url: WWR_FEED_URL },
      pages: [{ page: 1, returned: records.length }],
      dateField: 'pubDate',
      dated: records.filter((record) => record.postedAt != null).length,
    },
  };
}
