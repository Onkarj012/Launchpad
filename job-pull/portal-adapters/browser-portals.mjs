import { remainingDeadlineMs, throwIfNetworkWorkDisallowed } from '../../crawler/deadline.mjs';
// Browser-backed portal adapters: Glassdoor, Instahyre, Wellfound.
//
// These three serve a JS shell to plain HTTP and only yield job markup once a
// real page has rendered. They receive an injected `fetchRendered(url, opts)`
// that returns settled HTML — see crawler/browser-transport.mjs. Injection
// keeps this module pure enough to test against saved HTML with no browser.
//
// Coverage each one adds beyond the direct ATS lanes:
//   glassdoor  broad aggregator, exposes a relative job age per card
//   instahyre  curated India inventory (~13.6k active), employer-named rows
//   wellfound  startup roles, including India-eligible remote
//
// Probed 2026-08-22 with headless Chromium: all three returned rendered job
// markup. Naukri did not (403 + captcha) and is deliberately absent.
//
// All three are aggregators. Records keep aggregator provenance so the shared
// original-listing resolver still tries to reach the employer's own posting,
// and none of them supply a trustworthy exact post date, so `postedAt` is left
// null unless the card states one. Freshness classification owns that call.

import { decodeEntities } from '../../vendor/career-ops/providers/_html-entities.mjs';
import { assertPortalPageHealth } from './page-health.mjs';

function text(value) {
  if (typeof value !== 'string') return '';
  return decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function absolute(href, origin) {
  if (!href) return null;
  try {
    const url = new URL(decodeEntities(href), origin);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.*|fbclid|gclid|source|ref|src|ao|cs|pos|guid|srs|t)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch { return null; }
}

/**
 * Convert Glassdoor's relative age chip ("3d", "24h", "30d+") to an ISO date.
 * Unbounded "30d+" returns null: it cannot date a posting, so the row stays
 * undated and freshness sends it to VerifyQueue rather than guessing.
 */
export function parseRelativeAge(label, nowMs) {
  if (typeof label !== 'string' || !label.trim()) return null;
  const value = label.trim().toLowerCase();
  if (/\+/.test(value)) return null;
  if (/^(just posted|today|new)$/.test(value)) return new Date(nowMs).toISOString();
  const match = value.match(/^(\d+)\s*([hd])/);
  if (!match) return null;
  const amount = Number(match[1]);
  const ms = match[2] === 'h' ? amount * 3_600_000 : amount * 86_400_000;
  return new Date(nowMs - ms).toISOString();
}

function record(base, extra) {
  return {
    postedAt: null,
    providerDateField: null,
    providerDateEvidence: null,
    jobId: null,
    sourceKind: 'aggregator',
    sourceCategory: 'aggregator',
    ...base,
    ...extra,
  };
}

// ---------------------------------------------------------------- Glassdoor

export const GLASSDOOR_ORIGIN = 'https://www.glassdoor.co.in';

export function buildGlassdoorUrl({ path } = {}) {
  if (!path) throw new Error('glassdoor: a search path is required');
  return new URL(path, GLASSDOOR_ORIGIN).toString();
}

export function parseGlassdoorCards(html, { now = Date.now(), query = null } = {}) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const cards = html.split(/<li[^>]*data-test="jobListing"/).slice(1);
  const out = [];
  for (const card of cards) {
    const linkMatch = card.match(/<a[^>]*data-test="job-title"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      || card.match(/<a[^>]*href="([^"]+)"[^>]*data-test="job-title"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;
    const url = absolute(linkMatch[1], GLASSDOOR_ORIGIN);
    const title = text(linkMatch[2]);
    if (!url || !title) continue;
    const ageLabel = text((card.match(/data-test="job-age"[^>]*>([\s\S]*?)<\//) || [])[1] || '');
    const postedAt = parseRelativeAge(ageLabel, now);
    out.push(record({
      title,
      url,
      company: text((card.match(/EmployerProfile_compactEmployerName[^>]*>([\s\S]*?)<\//) || [])[1] || '') || null,
      location: text((card.match(/data-test="emp-location"[^>]*>([\s\S]*?)<\//) || [])[1] || ''),
      provider: 'glassdoor',
      source: 'portal-glassdoor',
      discoveryProvider: 'glassdoor',
      jobId: new URL(url).searchParams.get('jobListingId') || (url.match(/JV_[^.]*/) || [])[0] || null,
    }, {
      postedAt,
      providerDateField: postedAt ? 'job-age' : null,
      providerDateEvidence: ageLabel ? `glassdoor.job-age=${ageLabel}` : null,
      evidence: {
        dateConfidence: postedAt ? 'aggregator-relative' : 'unverified',
        ...(ageLabel ? { ageLabel } : {}),
        discoveryQuery: query?.label ?? null,
      },
    }));
  }
  return out;
}

// ---------------------------------------------------------------- Instahyre

export const INSTAHYRE_ORIGIN = 'https://www.instahyre.com';

export function parseInstahyreCards(html, { query = null } = {}) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const out = [];
  // Each row is a .employer-block. The canonical opportunity URL carries the
  // job id (/job-430057-...), and .employer-job-name's title attribute holds
  // "<Employer> - <Role>" already decoded, which is cleaner than the inner div.
  const blocks = html.split(/class="[^"]*employer-block/).slice(1);
  for (const block of blocks) {
    const href = absolute((block.match(/href="((?:https:\/\/www\.instahyre\.com)?\/job-[^"]+)"/) || [])[1], INSTAHYRE_ORIGIN);
    if (!href) continue;
    const label = decodeEntities((block.match(/class="employer-job-name"[^>]*title="([^"]*)"/) || [])[1] || '').trim()
      || text((block.match(/class="company-name[^"]*"[^>]*>([\s\S]*?)<\//) || [])[1] || '');
    if (!label) continue;
    // Split only on the first " - "; role names legitimately contain dashes.
    const separator = label.indexOf(' - ');
    const company = separator > 0 ? label.slice(0, separator).trim() : null;
    const title = separator > 0 ? label.slice(separator + 3).trim() : label;
    if (!title || !company) continue;
    const location = text((block.match(/Job available in\s*([^<]*)</) || [])[1] || '');
    out.push(record({
      title,
      url: href,
      company,
      location,
      provider: 'instahyre',
      source: 'portal-instahyre',
      discoveryProvider: 'instahyre',
      jobId: (href.match(/\/job-(\d+)-/) || [])[1] || null,
    }, {
      evidence: { dateConfidence: 'unverified', discoveryQuery: query?.label ?? null },
    }));
  }
  return out;
}

// ---------------------------------------------------------------- Wellfound

export const WELLFOUND_ORIGIN = 'https://wellfound.com';

// A Wellfound card renders as a flat run of text nodes after the job anchor:
//   "Senior Software Engineer" | "Full-time" | "Pune" | "2 weeks ago" | "Save"
// Reading them positionally breaks whenever a badge is absent, so classify each
// node by what it is. Anything left over is the location.
const WELLFOUND_EMPLOYMENT = /^(?:full|part)[- ]?time$|^contract(?:or)?$|^intern(?:ship)?$|^cofounder$|^temporary$/i;
const WELLFOUND_CHROME = /^(?:save|saved|apply|new|promoted|featured|\d+\+?)$/i;
const RELATIVE_AGE = /^(?:posted\s+)?(?:(\d+)\s*(minute|hour|day|week|month)s?\s+ago|today|yesterday|just\s+posted)$/i;

const RELATIVE_AGE_MS = Object.freeze({
  minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000,
});

/**
 * Convert a spelled-out relative age ("2 weeks ago", "today") to an ISO date.
 * Months are approximated at 30 days, which is well outside the 14-day
 * freshness window and therefore only ever resolves to "too old".
 */
export function parseSpelledRelativeAge(label, nowMs) {
  const match = RELATIVE_AGE.exec(String(label || '').trim());
  if (!match) return null;
  const value = match[0].toLowerCase();
  if (/just\s+posted|today/.test(value)) return new Date(nowMs).toISOString();
  if (/yesterday/.test(value)) return new Date(nowMs - 86_400_000).toISOString();
  const unit = RELATIVE_AGE_MS[match[2]?.toLowerCase()];
  if (!unit || !match[1]) return null;
  return new Date(nowMs - Number(match[1]) * unit).toISOString();
}

// Wellfound prints compensation on the card as "₹8L – ₹12L • No equity".
const WELLFOUND_SALARY = /^([₹$€£])\s*([\d.]+)\s*([LKM])?\s*[–-]\s*[₹$€£]?\s*([\d.]+)\s*([LKM])?/i;
const SALARY_MULTIPLIER = Object.freeze({ l: 100_000, k: 1_000, m: 1_000_000 });

/** Split a card's text nodes into the fields Wellfound actually renders. */
function wellfoundCardFields(window, nowMs) {
  const nodes = [...window.matchAll(/>([^<>{}]{2,60})</g)]
    .map((match) => text(match[1]))
    .filter(Boolean);
  const fields = { location: '', postedAt: null, ageLabel: null, employment: null, salary: null };
  // nodes[0] is the anchor's own title text.
  for (const node of nodes.slice(1)) {
    if (WELLFOUND_CHROME.test(node)) continue;
    if (!fields.employment && WELLFOUND_EMPLOYMENT.test(node)) { fields.employment = node; continue; }
    if (!fields.ageLabel && RELATIVE_AGE.test(node)) {
      fields.ageLabel = node;
      fields.postedAt = parseSpelledRelativeAge(node, nowMs);
      continue;
    }
    if (!fields.salary) {
      const money = WELLFOUND_SALARY.exec(node);
      // Only INR carries a currency the India salary policy can compare.
      if (money && money[1] === '₹') {
        const scale = (suffix) => SALARY_MULTIPLIER[String(suffix || 'l').toLowerCase()] ?? 1;
        fields.salary = {
          minimum: Number(money[2]) * scale(money[3]),
          maximum: Number(money[4]) * scale(money[5] || money[3]),
          currency: 'INR',
          period: 'annual',
          evidence: node,
        };
        continue;
      }
      if (money) continue; // foreign currency: recorded as neither salary nor location
    }
    if (!fields.location && /^[A-Z]/.test(node)) { fields.location = node; continue; }
    if (fields.location && fields.ageLabel) break;
  }
  return fields;
}

export function parseWellfoundCards(html, { query = null, now = Date.now() } = {}) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const seen = new Set();
  const out = [];
  // Wellfound groups roles under a company block, so the company name is not
  // inside the job anchor. Walk company and job anchors in document order and
  // attribute each job to the most recent company above it. A job with no
  // company above it is dropped: CandidateV1 requires a company, and an
  // unattributed startup role is not something to hand over for an application.
  const anchorRe = /<a[^>]*href="(\/(?:company|jobs)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let currentCompany = null;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const href = match[1];
    const label = text(match[2]);
    if (href.startsWith('/company/')) {
      // The logo anchor renders empty; only the text anchor names the company.
      if (label) currentCompany = label;
      continue;
    }
    const jobId = (href.match(/^\/jobs\/(\d+)-/) || [])[1];
    const url = absolute(href, WELLFOUND_ORIGIN);
    if (!jobId || !url || !label || !currentCompany || seen.has(url)) continue;
    seen.add(url);
    const fields = wellfoundCardFields(html.slice(match.index, match.index + 2500), now);
    out.push(record({
      title: label,
      url,
      company: currentCompany,
      location: fields.location,
      provider: 'wellfound',
      source: 'portal-wellfound',
      discoveryProvider: 'wellfound',
      jobId,
      sourceCategory: 'startup-board',
    }, {
      postedAt: fields.postedAt,
      providerDateField: fields.postedAt ? 'card-age' : null,
      providerDateEvidence: fields.ageLabel ? `wellfound.age=${fields.ageLabel}` : null,
      employment: fields.employment ? { type: /intern/i.test(fields.employment) ? 'internship' : fields.employment.toLowerCase(), evidence: fields.employment } : undefined,
      salary: fields.salary ?? undefined,
      evidence: {
        dateConfidence: fields.postedAt ? 'aggregator-relative' : 'unverified',
        ...(fields.ageLabel ? { ageLabel: fields.ageLabel } : {}),
        discoveryQuery: query?.label ?? null,
      },
    }));
  }
  return out;
}

// ------------------------------------------------------------------ fetchers

const PARSERS = Object.freeze({
  glassdoor: parseGlassdoorCards,
  instahyre: parseInstahyreCards,
  wellfound: parseWellfoundCards,
});

/**
 * Shared driver. `fetchRendered` must return settled HTML for a URL.
 * A query that throws is recorded and skipped; one dead portal query never
 * fails the lane, but the error is always reported rather than swallowed.
 */
async function fetchBrowserPortal(provider, { fetchRendered, queries = [], maxRecords = 200, now = Date.now(), signal = null, deadline = null } = {}) {
  if (typeof fetchRendered !== 'function') throw new Error(`${provider} requires an injected fetchRendered function`);
  if (!Array.isArray(queries) || !queries.length) throw new Error(`${provider} requires at least one configured query`);
  const parse = PARSERS[provider];
  const records = [];
  const pages = [];
  const errors = [];
  let requests = 0;
  for (const query of queries) {
    if (records.length >= maxRecords || signal?.aborted || remainingDeadlineMs(deadline) <= 0) break;
    const url = query.url || buildGlassdoorUrl(query);
    try {
      requests += 1;
      const html = await fetchRendered(url, { waitMs: query.waitMs ?? 6000, signal, deadline });
      throwIfNetworkWorkDisallowed(signal, deadline);
      const parsed = parse(html, { now, query });
      assertPortalPageHealth(html, { provider, records: parsed });
      pages.push({ url, returned: parsed.length });
      records.push(...parsed);
    } catch (error) {
      errors.push(`${url}: ${error?.message || String(error)}`);
    }
  }
  const seen = new Set();
  const deduped = records.filter((item) => (seen.has(item.url) ? false : (seen.add(item.url), true))).slice(0, maxRecords);
  return {
    records: deduped,
    telemetry: {
      provider,
      requestPlan: { queries: queries.length, rendered: true },
      pages,
      requests,
      dated: deduped.filter((item) => item.postedAt != null).length,
      duplicatesDropped: records.length - deduped.length,
      errors,
    },
  };
}

export const fetchGlassdoor = (options) => fetchBrowserPortal('glassdoor', options);
export const fetchInstahyre = (options) => fetchBrowserPortal('instahyre', options);
export const fetchWellfound = (options) => fetchBrowserPortal('wellfound', options);

export default { fetchGlassdoor, fetchInstahyre, fetchWellfound };
