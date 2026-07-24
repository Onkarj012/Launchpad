// Remote OK public API: GET https://remoteok.com/api
// Returns a JSON array. Index 0 is a legal/metadata object
// ({ last_updated, legal, ... }) that must be skipped; subsequent elements
// are job objects with id, position/title, company, location, tags, date,
// url, description (and often epoch/slug). Live feed is current postings
// (not delayed inventory), so first-24h eligibility remains on by default.

export const REMOTEOK_FEED_URL = 'https://remoteok.com/api';

const RESTRICTIVE_COUNTRY_TOKENS = new Set([
  'united states', 'usa', 'us', 'canada', 'europe', 'eu', 'united kingdom', 'uk',
  'australia', 'new zealand', 'latam', 'latin america',
]);

function dateValue(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isMetadataEntry(entry) {
  if (!entry || typeof entry !== 'object') return true;
  // Legal/header row has no job identity fields; skip it regardless of position.
  if (entry.legal != null || (entry.last_updated != null && entry.position == null && entry.title == null && entry.id == null)) {
    return true;
  }
  return false;
}

function countryRestrictionEvidence(location, tags) {
  const text = typeof location === 'string' ? location.trim() : '';
  if (text) {
    const tokens = text.split(/[,/|]/).map((part) => part.trim()).filter(Boolean);
    if (tokens.length === 1 && RESTRICTIVE_COUNTRY_TOKENS.has(tokens[0].toLowerCase())) {
      return `${tokens[0]} only (Remote OK location)`;
    }
    return `Remote OK location: ${text}`;
  }
  if (Array.isArray(tags) && tags.some((tag) => typeof tag === 'string' && /\bworldwide\b/i.test(tag))) {
    return 'Remote OK tags: worldwide';
  }
  return null;
}

export function parseRemoteOkResponse(response, defaultCompany = 'Remote OK') {
  if (!Array.isArray(response)) return [];
  return response.flatMap((job, index) => {
    if (!job || typeof job !== 'object') return [];
    if (index === 0 && isMetadataEntry(job)) return [];
    if (isMetadataEntry(job) && job.position == null && job.title == null) return [];
    const title = typeof job.position === 'string' && job.position.trim()
      ? job.position.trim()
      : typeof job.title === 'string' ? job.title.trim() : '';
    const url = typeof job.url === 'string' ? job.url.trim()
      : typeof job.apply_url === 'string' ? job.apply_url.trim()
      : '';
    if (!title || !/^https?:\/\//i.test(url)) return [];
    // Feed publication timestamp — aggregator evidence, not employer datePosted.
    const feedPublishedAt = dateValue(job.date ?? job.epoch ?? job.pubDate);
    const location = typeof job.location === 'string' ? job.location.trim() : '';
    const tags = Array.isArray(job.tags) ? job.tags.filter((tag) => typeof tag === 'string') : [];
    return [{
      title,
      url,
      company: typeof job.company === 'string' && job.company.trim() ? job.company.trim() : defaultCompany,
      location,
      description: typeof job.description === 'string' ? job.description : null,
      // Keep postedAt for in-feed ranking; tag separately so it is never treated as employer date evidence alone.
      postedAt: feedPublishedAt,
      feedPublishedAt,
      providerDateField: job.date != null ? 'date' : job.epoch != null ? 'epoch' : job.pubDate != null ? 'pubDate' : null,
      providerDateEvidence: feedPublishedAt ? 'remoteok.date' : null,
      jobId: job.id == null && job.slug == null ? null : String(job.id ?? job.slug),
      countryRestrictionEvidence: countryRestrictionEvidence(location, tags),
      tags,
      sourceKind: 'niche-public',
      sourceCategory: 'broad-remote',
      provider: 'remoteok',
      evidence: feedPublishedAt ? { feedPublishedAt, providerDateField: job.date != null ? 'date' : 'epoch' } : {},
    }];
  });
}

export async function fetchRemoteOk({ fetchJson, defaultCompany = 'Remote OK' } = {}) {
  if (typeof fetchJson !== 'function') throw new Error('Remote OK requires an injected fetchJson function');
  const response = await fetchJson(REMOTEOK_FEED_URL, { redirect: 'error' });
  if (!Array.isArray(response)) throw new Error('remoteok: expected a JSON array');
  const records = parseRemoteOkResponse(response, defaultCompany);
  return {
    records,
    telemetry: {
      provider: 'remoteok',
      requestPlan: { pagination: { supported: false, reason: 'native board-wide feed has no documented page parameter' }, url: REMOTEOK_FEED_URL },
      pages: [{ page: 1, returned: records.length }],
      dateField: 'date',
      dated: records.filter((record) => record.feedPublishedAt != null).length,
      first24hEligible: true,
    },
  };
}
