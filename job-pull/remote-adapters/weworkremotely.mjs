import { parseWwrFeed } from '../../career-ops/providers/weworkremotely.mjs';

// Live-verified 2026-07-24: GET https://weworkremotely.com/remote-jobs.rss still
// returns the documented <rss><channel><item>...</item></channel></rss> shape with
// <title>, <link>, <pubDate>, <region>, <country>, <category>, and <type> per item.
// <region>/<country> reflect the employer's location/HQ (e.g. a US state, or a
// flag-emoji country like "🇨🇦 Canada"), not an applicant-eligibility restriction,
// so they are kept as `location` display text only, not as country-restriction
// evidence — that would fabricate an eligibility signal the feed does not assert.
// <type> (e.g. "Full-Time", "Contract") is a real employment-structure field and is
// extracted here since career-ops's shared parser does not carry it through.
export const WWR_FEED_URL = 'https://weworkremotely.com/remote-jobs.rss';

function wwrTagText(block, tag) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

/** Index raw <item> blocks by their <link> so parsed records can recover <type> (career-ops's shared parser does not carry it through). */
function rawItemIndex(xml) {
  const index = new Map();
  if (typeof xml !== 'string') return index;
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const link = wwrTagText(block, 'link').trim();
    if (link && !index.has(link)) index.set(link, block);
  }
  return index;
}

export async function fetchWeWorkRemotely({ fetchText, defaultCompany = 'We Work Remotely' } = {}) {
  if (typeof fetchText !== 'function') throw new Error('We Work Remotely requires an injected fetchText function');
  const response = await fetchText(WWR_FEED_URL, { redirect: 'error' });
  const rawIndex = rawItemIndex(response);
  const records = parseWwrFeed(response, defaultCompany).map((job) => {
    const rawBlock = rawIndex.get(job.url);
    const employmentType = rawBlock ? wwrTagText(rawBlock, 'type') : '';
    return {
      ...job,
      provider: 'weworkremotely',
      providerDateField: 'pubDate',
      providerDateEvidence: job.postedAt == null ? null : 'weworkremotely.pubDate',
      ...(employmentType ? { employmentType, employmentEvidence: employmentType } : {}),
      sourceKind: 'niche-public',
      sourceCategory: 'broad-remote',
    };
  });
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
