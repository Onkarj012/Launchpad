// LinkedIn public guest job search.
//
// GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
// returns an HTML fragment of <li> job cards with no authentication, no API
// key, and no browser. Each card can carry an exact portal post date in
// <time datetime="YYYY-MM-DD">, so this lane never depends on relative-date
// parsing or on a DETAIL request to become datable.
//
// Query parameters used here:
//   keywords   free-text title query
//   location   e.g. "Pune, Maharashtra, India" or "India"
//   f_TPR      recency window: r86400 = 24h, r604800 = 7d
//   f_WT       work type: 1 on-site, 2 remote, 3 hybrid (omit for any)
//   start      pagination offset; the endpoint returns 10-30 cards per call
//
// LinkedIn is an aggregator and carries reposted and ghost listings. Records
// emitted here keep `postedAt` as portal date evidence and stay
// sourceCategory 'aggregator', so the shared original-listing resolver and the
// opportunity ledger still get to demote or drop them.

import { decodeEntities } from '../../vendor/career-ops/providers/_html-entities.mjs';
import { assertPortalPageHealth } from './page-health.mjs';
import { createHash } from 'node:crypto';
import { extractExperienceYears } from '../candidate.mjs';

/** Only public job pages, never auth routes, company pages or recommendations. */
export function linkedInPublicJobId(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password
      || !/^(?:www|in|[a-z]{2})\.linkedin\.com$|^linkedin\.com$/i.test(url.hostname)) return null;
    return url.pathname.match(/^\/jobs\/view\/(?:[^/]*-)?(\d{6,12})\/?$/)?.[1] ?? null;
  } catch { return null; }
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)]
    .map((match) => [match[1].toLowerCase(), decodeEntities(match[2])]));
}

function postingNodes(value) {
  if (Array.isArray(value)) return value.flatMap(postingNodes);
  if (!value || typeof value !== 'object') return [];
  const types = [value['@type']].flat();
  return [...(types.includes('JobPosting') ? [value] : []), ...postingNodes(value['@graph'])];
}

const identityText = (value) => text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Pure extraction. All evidence is portal evidence, including exact dates. */
export function parseLinkedInJobDetail(html, { requestedUrl, jobId, title, company, observedAt } = {}) {
  const requestedId = linkedInPublicJobId(requestedUrl);
  const fail = (reason) => ({ status: 'verification', reason, patch: null });
  if (!requestedId || (jobId && String(jobId) !== requestedId)) return fail('portal-detail-request-identity-mismatch');
  if (typeof html !== 'string') return fail('portal-detail-malformed-response');
  // A public JD can include optional sign-in dialogs for networking or saving.
  // Those are not access gates. Reject actual login/challenge pages and explicit
  // gates to job content; never render, log in, or use a second transport.
  const visible = text(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' '));
  if (/<title[^>]*>[^<]*(?:sign in|log in|just a moment|attention required|security verification)/i.test(html)
    || /\b(?:access denied|verify (?:that )?you are (?:a )?human|security verification|unusual traffic|complete the captcha|sign in to (?:view|see) (?:this |the )?(?:job|description)|(?:sign|log) in to continue)\b/i.test(visible)
    || /(?:cf-challenge|g-recaptcha|hcaptcha|checkpoint\/challenge)/i.test(html)) return fail('portal-detail-access-blocked');
  const canonicalIds = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => attributes(match[0]))
    .filter((attr) => /\bcanonical\b/i.test(attr.rel ?? '')).map((attr) => linkedInPublicJobId(attr.href));
  if (!canonicalIds.length || canonicalIds.some((id) => id !== requestedId)) return fail('portal-detail-canonical-identity-mismatch');
  const nodes = [];
  for (const match of html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)) {
    if (attributes(match[0].slice(0, match[0].indexOf('>') + 1)).type !== 'application/ld+json') continue;
    try { nodes.push(...postingNodes(JSON.parse(match[0].replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim()))); }
    catch { /* Invalid JSON supplies no evidence. */ }
  }
  const expectedTitle = identityText(title);
  const expectedCompany = identityText(company);
  if (!expectedTitle || !expectedCompany) return fail('portal-detail-request-identity-mismatch');
  const matchingIdentity = nodes.filter((node) =>
    identityText(node.title) === expectedTitle
    && identityText(node.hiringOrganization?.name) === expectedCompany);
  const matches = matchingIdentity.filter((posting) => {
    const ids = [posting.url, posting['@id']].filter((item) => typeof item === 'string').flatMap((item) => {
      const publicId = linkedInPublicJobId(item);
      const urnId = item.match(/^urn:li:jobPosting:(\d+)$/)?.[1];
      return publicId || urnId ? [publicId || urnId] : [];
    });
    const identifier = posting.identifier;
    const value = typeof identifier === 'object' ? identifier?.value : identifier;
    // Employer requisition IDs are not LinkedIn IDs. LinkedIn often names the
    // employer in PropertyValue and publishes its internal numeric identifier.
    const employerIdentifier = identifier && typeof identifier === 'object'
      && identityText(identifier.name) === identityText(posting.hiringOrganization?.name)
      && identityText(identifier.name) !== '';
    const numeric = !employerIdentifier && /^\d+$/.test(String(value ?? '')) ? String(value) : null;
    const urn = String(value ?? '').match(/^urn:li:jobPosting:(\d+)$/)?.[1];
    if (numeric || urn) ids.push(numeric || urn);
    return ids.every((id) => id === requestedId);
  });
  if (matches.length !== 1) return fail(nodes.length ? 'portal-detail-posting-identity-mismatch' : 'portal-detail-jobposting-not-found');
  const node = matches[0];
  const description = text(decodeEntities(typeof node.description === 'string' ? node.description : ''));
  if (!description) return fail('portal-detail-description-missing');
  const patch = { description, experience: extractExperienceYears(description) || { minYears: null, maxYears: null, evidence: null } };
  const months = node.experienceRequirements?.monthsOfExperience;
  if (typeof months === 'number' && Number.isFinite(months) && months >= 0
    && (patch.experience.minYears == null || months / 12 > patch.experience.minYears)) {
    patch.experience = { minYears: months / 12, maxYears: null, evidence: `JobPosting.experienceRequirements.monthsOfExperience=${months}` };
  }
  const rawEmployment = [node.employmentType].flat().filter((value) => typeof value === 'string').join(', ');
  const types = { FULL_TIME: 'full-time', PART_TIME: 'part-time', CONTRACTOR: 'contract', TEMPORARY: 'temporary', INTERN: 'internship', INTERNSHIP: 'internship', VOLUNTEER: 'volunteer' };
  if (rawEmployment) patch.employment = { type: types[rawEmployment.toUpperCase().replace(/[ -]/g, '_')] ?? null, paid: null, evidence: rawEmployment };
  if (typeof node.datePosted === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(node.datePosted)) {
    const day = node.datePosted.slice(0, 10);
    const dayTime = Date.parse(`${day}T00:00:00.000Z`);
    const postedTime = Date.parse(node.datePosted);
    if (Number.isFinite(dayTime) && Number.isFinite(postedTime) && new Date(dayTime).toISOString().slice(0, 10) === day) patch.postedAt = new Date(postedTime).toISOString();
  }
  const salary = node.baseSalary;
  const range = salary?.value;
  const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (salary && typeof salary === 'object' && range && typeof range === 'object') {
    const minimum = finite(range.minValue ?? range.value);
    const maximum = finite(range.maxValue ?? range.value);
    if (minimum != null || maximum != null) patch.salary = { minimum, maximum, currency: text(salary.currency) || null, period: text(range.unitText) || null, evidence: JSON.stringify(salary) };
  }
  // A labelled LPA disclosure is annual INR compensation. Do not interpret
  // unrelated numbers, unlabelled ranges, or unspecified currency/periods.
  if (!patch.salary) {
    const lpa = description.match(/\b(?:CTC|salary|compensation)\s*[:=-]\s*(?:(?:INR|Rs\.?|₹)\s*)?(\d+(?:\.\d+)?)\s*(?:LPA\s*)?(?:[-–]|to)\s*(\d+(?:\.\d+)?)\s*LPA\b/i)
      ?? description.match(/\b(?:CTC|salary|compensation)\s*[:=-]\s*(?:(?:INR|Rs\.?|₹)\s*)?(\d+(?:\.\d+)?)\s*LPA\b/i);
    if (lpa) patch.salary = { minimum: Number(lpa[1]) * 100000, maximum: Number(lpa[2] ?? lpa[1]) * 100000, currency: 'INR', period: 'YEAR', evidence: lpa[0] };
  }
  const fieldSources = Object.fromEntries(Object.keys(patch).map((field) => [field, 'portal-detail-jsonld']));
  patch.evidence = { fieldSources, portalDetail: {
    provider: 'linkedin-jobs', status: 'extracted', sourceCategory: 'aggregator', requestedJobId: requestedId,
    url: requestedUrl, observedAt, responseDigest: createHash('sha256').update(html).digest('hex'),
    fieldSource: 'portal-detail-jsonld', rawDatePosted: node.datePosted ?? null, rawEmploymentType: node.employmentType ?? null,
    // The identity-validated posting may bind its own application action. An
    // unrelated node or recommended-job anchor cannot bind this role's route.
    applicationActionTarget: typeof node.potentialAction?.target === 'string' ? node.potentialAction.target : null,
  } };
  return { status: 'extracted', reason: null, patch };
}

export const LINKEDIN_GUEST_SEARCH_URL =
  'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

/** Recency windows LinkedIn accepts for f_TPR. */
export const LINKEDIN_TIME_WINDOWS = Object.freeze({ day: 'r86400', week: 'r604800' });

/** Work-type facet values for f_WT. */
export const LINKEDIN_WORK_TYPES = Object.freeze({ onsite: '1', remote: '2', hybrid: '3' });

export function buildLinkedInQueryUrl({ keywords, location, timeWindow = 'day', workType = null, start = 0 } = {}) {
  if (!keywords || !location) throw new Error('linkedin: keywords and location are required');
  const params = new URLSearchParams({
    keywords,
    location,
    f_TPR: LINKEDIN_TIME_WINDOWS[timeWindow] ?? timeWindow,
    start: String(start),
  });
  if (workType) params.set('f_WT', LINKEDIN_WORK_TYPES[workType] ?? workType);
  return `${LINKEDIN_GUEST_SEARCH_URL}?${params.toString()}`;
}

function text(value) {
  if (typeof value !== 'string') return '';
  return decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function firstMatch(card, pattern) {
  const match = card.match(pattern);
  return match ? text(match[1]) : '';
}

/**
 * Parse the guest-search HTML fragment into raw records.
 * Pure: no network, no clock. Cards that lack a title or a usable /jobs/view/
 * URL are dropped rather than emitted with holes.
 */
export function parseLinkedInGuestCards(html, { query = null } = {}) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const cards = html.split(/<li[\s>]/).slice(1);
  const records = [];
  for (const card of cards) {
    const title = firstMatch(card, /<h3[^>]*base-search-card__title[^>]*>([\s\S]*?)<\/h3>/);
    const urlMatch = card.match(/class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/)
      || card.match(/href="(https:\/\/[a-z.]*linkedin\.com\/jobs\/view\/[^"]+)"/);
    if (!title || !urlMatch) continue;

    // Strip LinkedIn's tracking query string; the path alone is the canonical posting.
    const url = decodeEntities(urlMatch[1]).split('?')[0];
    const publicId = linkedInPublicJobId(url);
    if (!publicId) continue;
    const company = firstMatch(card, /<h4[^>]*base-search-card__subtitle[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)
      || firstMatch(card, /<h4[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/);
    const location = firstMatch(card, /<span[^>]*job-search-card__location[^>]*>([\s\S]*?)<\/span>/);

    // Exact public portal date; it is not employer-original corroboration.
    const dateMatch = card.match(/<time[^>]*datetime="([0-9]{4}-[0-9]{2}-[0-9]{2})"/);
    const postedAt = dateMatch ? new Date(`${dateMatch[1]}T00:00:00.000Z`).toISOString() : null;

    const urn = card.match(/data-entity-urn="urn:li:jobPosting:(\d+)"/);
    const jobId = publicId;
    if (urn && urn[1] !== publicId) continue;

    // "Be an early applicant" is a genuine freshness signal LinkedIn exposes.
    const earlyApplicant = /job-posting-benefits__text[\s\S]{0,200}?early applicant/i.test(card);

    records.push({
      title,
      url,
      company: company || null,
      location,
      postedAt,
      providerDateField: dateMatch ? 'time.datetime' : null,
      providerDateEvidence: dateMatch ? `linkedin.datetime=${dateMatch[1]}` : null,
      jobId,
      earlyApplicant,
      provider: 'linkedin-jobs',
      source: 'portal-linkedin-jobs',
      sourceKind: 'aggregator',
      sourceCategory: 'aggregator',
      discoveryProvider: 'linkedin-jobs',
      queryKeywords: query?.keywords ?? null,
      queryLocation: query?.location ?? null,
      evidence: {
        ...(postedAt ? { portalDate: postedAt, providerDateField: 'time.datetime', fieldSources: { postedAt: 'portal-search-card' } } : {}),
        ...(earlyApplicant ? { earlyApplicant: true } : {}),
        discoveryQuery: query ? `${query.keywords} @ ${query.location}` : null,
      },
    });
  }
  return records;
}

function dedupeByUrl(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = linkedInPublicJobId(record.url) ?? record.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Run the configured query matrix against the guest endpoint.
 * `fetchText` is injected so tests never touch the network and so the caller
 * owns host spacing, retry, and byte limits via crawler/http-policy.mjs.
 */
export async function fetchLinkedIn({
  fetchText,
  queries = [],
  maxPagesPerQuery = 2,
  pageSize = 25,
  maxRecords = 400,
  timeWindow = 'day',
  signal = null,
  guestPass = null,
  onGuestPass = null,
} = {}) {
  if (guestPass) return { ...guestPass, telemetry: { ...guestPass.telemetry, requests: 0, guestPassReused: true } };
  if (typeof fetchText !== 'function') throw new Error('LinkedIn requires an injected fetchText function');
  if (!Array.isArray(queries) || !queries.length) throw new Error('LinkedIn requires at least one configured query');

  const records = [];
  const pages = [];
  const errors = [];
  let requests = 0;
  let disabledReason = null;
  const attemptedPages = new Set();

  queriesLoop:
  for (const query of queries) {
    for (let page = 0; page < maxPagesPerQuery; page += 1) {
      if (records.length >= maxRecords) break;
      if (signal?.aborted) break;
      const url = buildLinkedInQueryUrl({ timeWindow, ...query, start: page * pageSize });
      if (attemptedPages.has(url)) break;
      attemptedPages.add(url);
      let parsed = [];
      try {
        requests += 1;
        const html = await fetchText(url, { redirect: 'follow', signal });
        parsed = parseLinkedInGuestCards(html, { query });
        assertPortalPageHealth(html, { provider: 'linkedin-jobs', records: parsed, allowEmptyFragment: true });
      } catch (error) {
        if (error?.code === 'LINKEDIN_PAUSED') {
          requests -= 1;
          disabledReason = error.message;
          break queriesLoop;
        }
        errors.push(`${query.keywords} @ ${query.location} p${page}: ${error?.message || String(error)}`);
        if (error?.statusCode === 429 || /\bHTTP 429\b/.test(error?.message ?? '')) break queriesLoop;
        break;
      }
      pages.push({ query: `${query.keywords} @ ${query.location}`, page, returned: parsed.length });
      records.push(...parsed);
      // A short page means the result set is exhausted; stop paginating this query.
      if (parsed.length < 10) break;
    }
  }

  const deduped = dedupeByUrl(records).slice(0, maxRecords);
  const result = {
    records: deduped,
    ...(disabledReason && requests === 0 ? { manifest: { status: 'disabled', reason: disabledReason } } : {}),
    telemetry: {
      provider: 'linkedin-jobs',
      requestPlan: { queries: queries.length, maxPagesPerQuery, pageSize, url: LINKEDIN_GUEST_SEARCH_URL },
      pages,
      requests,
      dateField: 'time.datetime',
      dated: deduped.filter((record) => record.postedAt != null).length,
      duplicatesDropped: records.length - deduped.length,
      first24hEligible: true,
      errors,
    },
  };
  onGuestPass?.(result);
  return result;
}

export default fetchLinkedIn;
