export const ORIGINAL_LISTING_RESOLVER_VERSION = 'OriginalListingResolverV1';
import { linkedInPublicJobId, parseLinkedInJobDetail } from '../job-pull/portal-adapters/linkedin.mjs';
import { remainingDeadlineMs, requestWithDeadline, throwIfNetworkWorkDisallowed } from './deadline.mjs';
import { candidateRequisitionKey, extractExperienceYears, hiringEmployerConflict, normalizeRequisitionId } from '../job-pull/candidate.mjs';

export const DEFAULT_ORIGINAL_LISTING_RESOLVER_BUDGET = Object.freeze({
  maxRedirects: 5,
  maxHosts: 4,
  maxBytes: 2_000_000,
  maxRequests: 8,
});

const ATS_HOSTS = Object.freeze([
  ['greenhouse', /(?:^|\.)greenhouse\.io$/i],
  ['lever', /(?:^|\.)lever\.co$/i],
  ['ashby', /(?:^|\.)ashbyhq\.com$/i],
  ['smartrecruiters', /(?:^|\.)smartrecruiters\.com$/i],
  ['workable', /(?:^|\.)workable\.com$/i],
  ['recruitee', /(?:^|\.)recruitee\.com$/i],
  ['workday', /(?:^|\.)myworkdayjobs\.com$/i],
]);
const AGGREGATOR_HOST = /(?:^|\.)(?:linkedin\.com|indeed\.[a-z.]+|glassdoor\.[a-z.]+|wellfound\.com|builtin\.com|ziprecruiter\.com|dice\.com|monster\.[a-z.]+|simplyhired\.[a-z.]+|hirist\.tech|cutshort\.io|instahyre\.com|naukri\.com|internshala\.com|angel\.co|remoteok\.com|weworkremotely\.com|remotive\.com|himalayas\.app|jobicy\.com)$/i;
const RESERVED_HOST = /(?:^|\.)(?:example|invalid|test|localhost)(?:$|\.)/i;
const CAREER_PATH = /(?:^|[\/_-])(career|careers|jobs?|apply|application|join[-_ ]?us|work[-_ ]?with[-_ ]?us|opportunit)(?:$|[\/_-])/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_STATUSES = new Set([401, 403, 407, 429, 451]);
const APPLY_HINT = /\b(apply|view\s+original|view\s+job|original\s+posting|company\s+site|employer|external\s+apply|continue\s+to\s+application)\b/i;
const CANONICAL_REL = /\brel\s*=\s*["'][^"']*canonical[^"']*["']/i;
const CAPTCHA_HINT = /\b(captcha|recaptcha|hcaptcha|cf-challenge|just\s+a\s+moment|paywall|subscribe\s+to\s+continue|verify\s+you\s+are\s+human)\b/i;
const FIELD_SOURCE_ORIGINAL = 'original-employer-detail';
const FIELD_SOURCE_LEAD = 'lead-only';

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const first = (...values) => values.find((value) => text(value) != null) ?? null;

/** Minimal entity decode + tag strip so the resolver stays free of the career-ops import graph. */
function stripHtmlToText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function canonical(value, base = null) {
  if (!text(value)) return null;
  try {
    const url = new URL(value, base || undefined);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|source$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    url.pathname = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    return url.toString();
  } catch {
    return null;
  }
}

function hostOf(value) {
  try { return new URL(value).hostname; } catch { return ''; }
}

function headersOf(response) {
  const headers = response?.headers || {};
  const get = (name) => typeof headers.get === 'function'
    ? headers.get(name)
    : Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
  return { location: get('location'), contentType: get('content-type'), cfMitigated: get('cf-mitigated') };
}

function bodyOf(response) {
  if (response?.body && typeof response.body === 'object') return response.body;
  if (response?.json && typeof response.json === 'object') return response.json;
  if (typeof response?.body === 'string') {
    try { return JSON.parse(response.body); } catch { return response.body; }
  }
  if (typeof response?.text === 'string') return response.text;
  return null;
}

function htmlBody(response) {
  const body = bodyOf(response);
  return typeof body === 'string' ? body : '';
}

function readPath(value, path) {
  return path.split('.').reduce((current, key) => current == null ? null : current[key], value);
}

function jsonLdNodes(body) {
  if (typeof body !== 'string') return [];
  const nodes = [];
  for (const match of body.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(match[1].trim());
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (item?.['@graph']) nodes.push(...(Array.isArray(item['@graph']) ? item['@graph'] : [item['@graph']]));
        else nodes.push(item);
      }
    } catch {
      // A malformed JSON-LD block is evidence for verification, not a run error.
    }
  }
  return nodes.filter((node) => node && typeof node === 'object');
}

function isJobPosting(node) {
  return String(node?.['@type'] ?? '').split(/\s*,\s*/).some((type) => type.toLowerCase() === 'jobposting');
}

function detailRoot(response) {
  const body = bodyOf(response);
  const nodes = jsonLdNodes(htmlBody(response));
  const posting = nodes.find(isJobPosting) || null;
  const candidates = [
    response?.details,
    response?.detail,
    response?.job,
    body?.jobPostingInfo,
    body?.jobPosting,
    body?.posting,
    body?.job,
    body,
    posting,
  ];
  return { body, posting, root: candidates.find((value) => value && typeof value === 'object') || null };
}

function locationValue(value) {
  const location = Array.isArray(value) ? value[0] : value;
  if (!location) return null;
  if (typeof location === 'string') return text(location);
  const address = location.address;
  if (typeof address === 'string') return text(address);
  return text([
    address?.addressLocality,
    address?.addressRegion,
    address?.addressCountry,
    location.name,
  ].filter(Boolean).join(', '));
}

function employmentType(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const key = text(typeof raw === 'object' ? raw?.name ?? raw?.value : raw)?.toLowerCase().replace(/[_\s]+/g, ' ');
  if (!key) return null;
  const types = new Map([
    ['full time', 'full-time'], ['full-time', 'full-time'], ['fulltime', 'full-time'], ['permanent', 'full-time'],
    ['intern', 'internship'], ['internship', 'internship'], ['paid internship', 'internship'],
    ['part time', 'part-time'], ['part-time', 'part-time'], ['contract', 'contract'], ['contractor', 'contract'],
    ['temporary', 'temporary'],
  ]);
  return types.get(key) || null;
}

function salaryValue(root) {
  const value = root?.baseSalary ?? root?.salary ?? root?.compensation ?? root?.estimatedSalary;
  const salary = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const range = salary.value && typeof salary.value === 'object' ? salary.value : salary;
  const minimum = Number(range.minValue ?? range.minimum ?? range.min ?? root?.salaryMin);
  const maximum = Number(range.maxValue ?? range.maximum ?? range.max ?? root?.salaryMax);
  const currency = text(salary.currency ?? salary.currencyCode ?? range.currency ?? root?.salaryCurrency);
  const period = text(salary.unitText ?? salary.period ?? root?.salaryPeriod);
  const evidence = text(typeof value === 'string' ? value : root?.salaryEvidence)
    || (Number.isFinite(minimum) || Number.isFinite(maximum) ? [minimum, maximum].filter(Number.isFinite).join('-') : null);
  if (!Number.isFinite(minimum) && !Number.isFinite(maximum) && !currency && !period && !evidence) return null;
  return {
    minimum: Number.isFinite(minimum) ? minimum : null,
    maximum: Number.isFinite(maximum) ? maximum : null,
    currency,
    period,
    evidence,
  };
}

function parseDate(value) {
  if (value == null || value === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function firstField(root, paths) {
  return first(...paths.map((path) => readPath(root, path)));
}

// Normalize identity text so portal and registry fields compare without punctuation differences.
function normalizedIdentity(value) {
  return stripHtmlToText(text(value) || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Match location labels when both identify the same place at different detail levels.
function locationsMatch(left, right) {
  const a = normalizedIdentity(left);
  const b = normalizedIdentity(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

// Build a public listing feed request for a supported registry board.
function registrySearchRequest(board, title) {
  const slug = encodeURIComponent(String(board.slug || board.board || board.boardKey || '').trim());
  if (['greenhouse', 'lever', 'ashby'].includes(board.provider) && slug) {
    const url = board.endpoint || (board.provider === 'greenhouse'
      ? `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`
      : board.provider === 'lever' ? `https://api.lever.co/v0/postings/${slug}`
        : `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
    return { url, options: { method: 'GET', redirect: 'manual' } };
  }
  if (board.provider === 'workday') {
    const url = board.endpoint || (board.tenant && board.instance && board.site
      ? `https://${board.tenant}.${board.instance}.myworkdayjobs.com/wday/cxs/${board.tenant}/${board.site}/jobs`
      : board.url);
    if (!url) return null;
    return { url, options: { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 50, offset: 0, searchText: title }) } };
  }
  return null;
}

// Keep a feed match on the exact employer board that supplied it.
function registryOwnsRoute(board, value) {
  const target = classifyOriginalListingUrl(value);
  if (target.kind !== 'ats' || target.provider !== board.provider) return false;
  const parts = pathSegments(target.url);
  const boardName = String(board.slug || board.board || board.boardKey || '').toLowerCase();
  if (['greenhouse', 'lever', 'ashby'].includes(board.provider)) return parts[0]?.toLowerCase() === boardName;
  if (board.provider === 'workday') {
    const expectedHost = `${board.tenant}.${board.instance}.myworkdayjobs.com`.toLowerCase();
    return target.host === expectedHost && parts[0]?.toLowerCase() === String(board.site).toLowerCase();
  }
  return false;
}

// Return a single listing only when the registry employer, title, location, and optional requisition agree.
function registryListingMatch(response, board, observation) {
  const rows = board.provider === 'lever' ? bodyOf(response)
    : bodyOf(response)?.jobs ?? bodyOf(response)?.jobPostings ?? bodyOf(response)?.postings;
  if (!Array.isArray(rows)) return null;
  const expectedCompany = normalizedIdentity(observation.company);
  const expectedTitle = normalizedIdentity(observation.title);
  const expectedLocation = normalizedIdentity(observation.location);
  const normalizeRow = (row) => {
    if (board.provider === 'greenhouse') return { title: row.title, location: typeof row.location === 'string' ? row.location : row.location?.name, id: row.id, url: row.absolute_url };
    if (board.provider === 'lever') return { title: row.text, location: row.categories?.location, id: row.id, url: row.hostedUrl };
    if (board.provider === 'ashby') return { title: row.title, location: row.location, id: row.id, url: row.jobUrl || row.applyUrl };
    const workdayBase = board.tenant && board.instance && board.site
      ? `https://${board.tenant}.${board.instance}.myworkdayjobs.com/${board.site}` : board.url;
    const workdayPath = row.externalPath ?? row.jobPostingInfo?.externalPath;
    const workdayUrl = workdayBase && workdayPath
      ? `${workdayBase.replace(/\/$/, '')}/${String(workdayPath).replace(/^\/+/, '')}` : null;
    const url = row.url ?? row.externalUrl ?? row.applicationUrl ?? workdayUrl;
    return { title: row.title ?? row.jobPostingInfo?.title,
      location: row.location?.descriptor ?? row.location?.name ?? row.location ?? row.locationsText ?? row.jobPostingInfo?.jobRequisitionLocation?.descriptor,
      id: row.jobReqId ?? row.jobPostingInfo?.jobReqId ?? extractProviderFingerprint(url).requisitionId, url };
  };
  const matches = rows.map(normalizeRow).filter((row) => {
    const actualTitle = normalizedIdentity(row.title);
    const actualLocation = normalizedIdentity(row.location);
    const titleMatches = actualTitle === expectedTitle;
    const locationMatches = locationsMatch(actualLocation, expectedLocation);
    const expectedReq = normalizeRequisitionId(board.provider, observation.requisitionId);
    const actualReq = normalizeRequisitionId(board.provider, row.id);
    return normalizedIdentity(board.company) === expectedCompany && titleMatches && locationMatches
      && (!expectedReq || (actualReq && actualReq === expectedReq)) && registryOwnsRoute(board, row.url);
  });
  return matches.length === 1 ? matches[0].url : null;
}

// Match known lead identity and require a named employer on the destination.
function terminalLinkedInIdentityFailure(response, observation, provider, { allowMissingLeadIdentity = false } = {}) {
  const { posting, root } = detailRoot(response);
  const identity = posting || root;
  const normalize = (value) => stripHtmlToText(text(value) || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const employer = normalize(firstField(identity, ['hiringOrganization.name', 'company.name', 'company', 'companyName', 'employer.name', 'employer']));
  const expectedEmployer = normalize(allowMissingLeadIdentity && observation.company === 'Not Verified' ? null : observation.company);
  if (!employer || (!expectedEmployer && !allowMissingLeadIdentity)) return 'destination-employer-identity-missing';
  if (expectedEmployer && employer !== expectedEmployer) return 'destination-employer-identity-mismatch';
  const title = normalize(firstField(identity, ['title', 'name', 'text']));
  const expectedTitle = normalize(allowMissingLeadIdentity && observation.title === 'Not Verified' ? null : observation.title);
  // LinkedIn job IDs and an action target URL do not prove an ATS requisition.
  const requisition = text(normalizeRequisitionId(provider, firstField(identity, ['requisitionId', 'jobReqId', 'identifier.value', 'identifier'])));
  const expectedRequisition = text(normalizeRequisitionId(provider, observation.requisitionId));
  if (expectedRequisition && requisition && requisition !== expectedRequisition) return 'destination-role-identity-mismatch';
  if (allowMissingLeadIdentity && !expectedTitle && title) return null;
  if (title && expectedTitle && title === expectedTitle) return null;
  if (expectedRequisition && requisition === expectedRequisition) return null;
  return title && expectedTitle ? 'destination-role-identity-mismatch' : 'destination-role-identity-missing';
}

function extractDetails(response, observation, provider) {
  const { body, posting, root } = detailRoot(response);
  const description = first(
    posting?.description,
    firstField(root, ['description', 'descriptionPlain', 'descriptionHtml', 'jobDescription', 'content', 'body', 'additionalInformation']),
    body?.jobPostingInfo?.jobDescription,
  );
  const title = first(posting?.title, firstField(root, ['title', 'name', 'text']));
  const location = locationValue(posting?.jobLocation ?? firstField(root, ['location', 'locations', 'locationsText', 'jobLocation']));
  const employment = employmentType(posting?.employmentType ?? firstField(root, ['employmentType', 'typeOfEmployment', 'employment', 'jobType']));
  const experienceRaw = firstField(root, ['experience', 'experienceRequired', 'qualifications.experience', 'requirements.experience']);
  const plainDescription = stripHtmlToText(description || '');
  const employerConflict = hiringEmployerConflict(plainDescription);
  if (employerConflict) return { verified: false, ...employerConflict };
  const experience = typeof experienceRaw === 'object' && experienceRaw
    ? experienceRaw
    : text(experienceRaw)
      ? { evidence: text(experienceRaw), ...extractExperienceYears(String(experienceRaw)) }
      : extractExperienceYears(plainDescription);
  const validThrough = parseDate(first(
    posting?.validThrough,
    firstField(root, ['validThrough', 'expiresAt', 'expirationDate', 'closingDate']),
  ));
  const rawStatus = String(firstField(root, ['status', 'state', 'jobStatus']) ?? '').toLowerCase();
  const closed = root?.closed === true || root?.isClosed === true || root?.active === false || /closed|expired|filled|withdrawn|removed/.test(rawStatus);
  const active = !closed && (root?.active === true || root?.isOpen === true || Boolean(posting || description || title));
  const workday = provider === 'workday';
  const workdayStartDate = parseDate(first(
    firstField(root, ['startDate', 'jobPostingInfo.startDate']),
    body?.jobPostingInfo?.startDate,
  ));
  const postedAt = workday ? workdayStartDate : parseDate(first(
    posting?.datePosted,
    firstField(root, ['datePosted', 'publishedAt', 'published_at', 'createdAt', 'created_at', 'postedAt']),
  ));
  const hasDetail = Boolean(posting || (description && (title || location || employment || postedAt || validThrough)) || (root && (root.title || root.description || root.jobDescription)));
  if (!hasDetail) return { verified: false, reason: 'job-detail-not-found' };
  const fieldSources = {
    title: title ? FIELD_SOURCE_ORIGINAL : null,
    description: plainDescription ? FIELD_SOURCE_ORIGINAL : null,
    location: location ? FIELD_SOURCE_ORIGINAL : null,
    employment: employment ? FIELD_SOURCE_ORIGINAL : null,
    experience: experience && (experience.minYears != null || experience.evidence) ? FIELD_SOURCE_ORIGINAL : null,
    postedAt: postedAt ? FIELD_SOURCE_ORIGINAL : null,
    liveness: FIELD_SOURCE_ORIGINAL,
    originalApplicationUrl: FIELD_SOURCE_ORIGINAL,
  };
  return {
    verified: true,
    title,
    description: plainDescription || null,
    location,
    employment: employment ? { type: employment, paid: null, evidence: employment } : null,
    experience: experience && (experience.minYears != null || experience.maxYears != null || experience.evidence)
      ? { minYears: experience.minYears ?? null, maxYears: experience.maxYears ?? null, evidence: experience.evidence ?? null }
      : { minYears: null, maxYears: null, evidence: null },
    salary: salaryValue(posting || root),
    postedAt,
    validThrough,
    liveness: closed || (validThrough && Date.parse(validThrough) < Date.now())
      ? { status: 'Expired', checkedAt: null, evidence: validThrough ? 'validThrough' : rawStatus || 'closing-status' }
      : active ? { status: 'Active', checkedAt: null, evidence: validThrough ? 'job-detail-and-validThrough' : 'job-detail' }
        : { status: 'Not Verified', checkedAt: null, evidence: 'job-detail-liveness-unverified' },
    freshness: workday ? { kind: postedAt ? 'workday-startDate' : 'workday-unverified' } : null,
    fieldSources,
    evidence: {
      detail: 'original-listing-detail',
      description: Boolean(description),
      experience: Boolean(experience?.evidence || experience?.minYears != null),
      employment: Boolean(employment),
      location: Boolean(location),
      compensation: Boolean(salaryValue(posting || root)),
      closing: Boolean(validThrough || closed || rawStatus),
      liveness: active || closed,
      fieldSources,
    },
  };
}

function pathSegments(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Provider fingerprint + requisition/job id from a resolved original URL.
 * Returns only values that the URL itself proves — never invents ids.
 */
export function extractProviderFingerprint(value) {
  const classified = classifyOriginalListingUrl(value);
  if (!classified.url || !['ats', 'employer-career'].includes(classified.kind)) {
    return { provider: classified.provider, kind: classified.kind, host: classified.host || null, requisitionId: null, url: classified.url };
  }
  const segments = pathSegments(classified.url);
  let requisitionId = null;
  if (classified.provider === 'greenhouse') {
    const jobsIdx = segments.findIndex((part) => part.toLowerCase() === 'jobs');
    if (jobsIdx >= 0 && segments[jobsIdx + 1] && /^\d+$/.test(segments[jobsIdx + 1])) requisitionId = segments[jobsIdx + 1];
  } else if (classified.provider === 'lever') {
    const last = /^(apply|application)$/i.test(segments.at(-1) || '') ? segments.at(-2) : segments.at(-1);
    if (last && /^[0-9a-f-]{8,}$/i.test(last)) requisitionId = last;
  } else if (classified.provider === 'ashby') {
    const last = /^(apply|application)$/i.test(segments.at(-1) || '') ? segments.at(-2) : segments.at(-1);
    if (last && /^[0-9a-f-]{8,}$/i.test(last)) requisitionId = last;
  } else if (classified.provider === 'smartrecruiters') {
    const last = segments[segments.length - 1];
    if (last && last.toLowerCase() !== 'jobs') requisitionId = last;
  } else if (classified.provider === 'workable') {
    const jIdx = segments.findIndex((part) => part.toLowerCase() === 'j');
    if (jIdx >= 0 && segments[jIdx + 1]) requisitionId = segments[jIdx + 1];
  } else if (classified.provider === 'recruitee') {
    const oIdx = segments.findIndex((part) => part.toLowerCase() === 'o');
    if (oIdx >= 0 && segments[oIdx + 1]) requisitionId = segments[oIdx + 1];
  } else if (classified.provider === 'workday') {
    const last = segments[segments.length - 1];
    if (last && !/^(en-us|careers|job|jobs)$/i.test(last)) {
      const slug = decodeURIComponent(last);
      requisitionId = normalizeRequisitionId('workday', slug);
    }
  } else if (classified.provider === 'employer-career') {
    const last = segments[segments.length - 1];
    const query = new URL(classified.url).searchParams;
    const keys = ['jobid', 'job_id', 'reqid', 'req', 'requisitionid', 'career_job_req_id', 'jobreqid', 'gh_jid', 'id', 'job'];
    for (const key of keys) {
      const entry = [...query].find(([name, value]) => name.toLowerCase() === key && value.trim());
      if (entry) { requisitionId = entry[1].trim(); break; }
    }
    const segment = last ? decodeURIComponent(last) : '';
    if (!requisitionId && /\d/.test(segment) && !/^(jobdetails|job-details|details|job|jobs|careers|apply|search|view|index|en|en-us)$/i.test(segment)) requisitionId = segment;
  }
  return {
    provider: classified.provider,
    kind: classified.kind,
    host: classified.host,
    requisitionId,
    url: classified.url,
  };
}

function collectHrefCandidates(html, base) {
  const ranked = [];
  const add = (value, rank, why) => {
    const url = canonical(value, base);
    if (!url) return;
    ranked.push({ url, rank, why });
  };

  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = match[1] || '';
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href && CANONICAL_REL.test(attrs)) add(href, 0, 'canonical-link');
  }
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1] || '';
    if (/\bhttp-equiv\s*=\s*["']refresh["']/i.test(attrs)) {
      const content = attrs.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1] || '';
      const target = content.match(/url\s*=\s*([^\s;]+)/i)?.[1];
      if (target) add(target.replace(/^['"]|['"]$/g, ''), 1, 'meta-refresh');
    }
    if (/\bproperty\s*=\s*["']og:url["']/i.test(attrs) || /\bname\s*=\s*["']original[-_]?url["']/i.test(attrs)) {
      const content = attrs.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
      if (content) add(content, 2, 'meta-original');
    }
  }
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1] || '';
    const inner = stripHtmlToText(match[2] || '');
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const labeled = APPLY_HINT.test(inner) || APPLY_HINT.test(attrs);
    add(href, labeled ? 3 : 8, labeled ? 'apply-link' : 'anchor');
  }
  return ranked;
}

function urlsFromBody(response, base) {
  const body = bodyOf(response);
  const urls = [];
  const add = (value) => { const url = canonical(value, base); if (url) urls.push(url); };
  for (const path of ['url', 'jobUrl', 'job_url', 'applyUrl', 'applicationUrl', 'originalApplicationUrl', 'absolute_url', 'hostedUrl', 'redirectUrl', 'sameAs']) add(readPath(body, path));
  for (const node of jsonLdNodes(htmlBody(response))) {
    add(node.url);
    add(node.sameAs);
    add(node.potentialAction?.target);
  }
  for (const candidate of collectHrefCandidates(htmlBody(response), base)) add(candidate.url);
  return [...new Set(urls)];
}

/**
 * Rank outbound targets: original ATS/employer destinations first, then
 * apply/view-original intermediate hops (tracking pages) that may still resolve.
 */
function preferOutboundTargets(response, base, { exclude = new Set() } = {}) {
  const body = bodyOf(response);
  const ranked = [];
  const push = (url, rank, why, { allowIntermediate = false } = {}) => {
    const value = canonical(url, base);
    if (!value || exclude.has(value)) return;
    const classified = classifyOriginalListingUrl(value);
    const isOriginal = ['ats', 'employer-career'].includes(classified.kind);
    if (!isOriginal && !allowIntermediate) return;
    if (!isOriginal && classified.kind === 'unsupported') return;
    ranked.push({ url: value, rank: isOriginal ? rank : rank + 20, why, classified, isOriginal });
  };

  for (const path of ['applyUrl', 'applicationUrl', 'originalApplicationUrl', 'absolute_url', 'hostedUrl', 'redirectUrl', 'jobUrl', 'job_url', 'url', 'sameAs']) {
    push(readPath(body, path), 4, `json:${path}`, { allowIntermediate: true });
  }
  for (const node of jsonLdNodes(htmlBody(response))) {
    push(node.url, 5, 'jsonld:url', { allowIntermediate: true });
    push(node.sameAs, 5, 'jsonld:sameAs', { allowIntermediate: true });
    push(node.potentialAction?.target, 3, 'jsonld:potentialAction', { allowIntermediate: true });
  }
  for (const candidate of collectHrefCandidates(htmlBody(response), base)) {
    const allowIntermediate = candidate.why === 'apply-link'
      || candidate.why === 'canonical-link'
      || candidate.why === 'meta-refresh'
      || candidate.why === 'meta-original';
    push(candidate.url, candidate.rank, candidate.why, { allowIntermediate });
  }

  ranked.sort((a, b) => a.rank - b.rank || a.url.localeCompare(b.url));
  const seen = new Set();
  return ranked.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

export function classifyOriginalListingUrl(value) {
  const url = canonical(value);
  if (!url) return { kind: 'invalid', provider: null, url: null };
  const host = hostOf(url);
  const ats = ATS_HOSTS.find(([, pattern]) => pattern.test(host));
  if (ats) return { kind: 'ats', provider: ats[0], host, url };
  if (AGGREGATOR_HOST.test(host)) return { kind: 'aggregator', provider: null, host, url };
  if (RESERVED_HOST.test(host)) return { kind: 'unsupported', provider: null, host, url };
  let pathname = '/';
  try { pathname = new URL(url).pathname; } catch { /* canonical already checked */ }
  if (host.startsWith('jobs.') || host.startsWith('careers.') || CAREER_PATH.test(pathname)) return { kind: 'employer-career', provider: 'employer-career', host, url };
  return { kind: 'unsupported', provider: null, host, url };
}

function safePortalApplicationTarget(item, boundTarget = null) {
  if (item.classified.kind !== 'ats') return false;
  if (boundTarget ? item.url !== canonical(boundTarget) : item.why !== 'apply-link') return false;
  const url = new URL(item.url);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port;
}

// Keep portal Apply links on public HTTPS pages and out of authentication routes.
function safeVisiblePortalApplyTarget(item, portalUrl) {
  if (item.why !== 'apply-link' || hostOf(item.url) === hostOf(portalUrl) || AGGREGATOR_HOST.test(hostOf(item.url))) return false;
  const url = new URL(item.url);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && !/\b(?:login|log-in|signin|sign-in|sign_in|auth|oauth|sso|api|graphql|internal)\b/i.test(`${url.hostname}${url.pathname}`);
}

// Restrict pasted-post resolution to public employer routes without URL credentials.
function safeHiringPostTarget(value) {
  const target = classifyOriginalListingUrl(value);
  if (!['ats', 'employer-career'].includes(target.kind)) return false;
  const url = new URL(target.url);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && !/\b(?:login|log-in|signin|sign-in|sign_in|auth|oauth|sso)\b/i.test(url.pathname);
}

function emptyTelemetry(budget) {
  return {
    requests: 0,
    redirects: 0,
    hostsFollowed: 0,
    bytesObserved: 0,
    budget: { ...budget },
  };
}

function responseBytes(response) {
  if (typeof response?.body === 'string') return Buffer.byteLength(response.body);
  if (typeof response?.text === 'string') return Buffer.byteLength(response.text);
  const headers = response?.headers || {};
  const raw = typeof headers.get === 'function' ? headers.get('content-length') : headers['content-length'] ?? headers['Content-Length'];
  const length = Number(raw);
  return Number.isFinite(length) ? length : 0;
}

async function boundedTransport(transport, url, options, { signal, remainingMs, deadline, hostLimiter }) {
  throwIfNetworkWorkDisallowed(signal, deadline ?? { remainingMs });
  const request = () => requestWithDeadline(transport, url, options, {
    signal, deadline: deadline ?? { remainingMs }, abortOnDeadline: true,
  });
  if (typeof hostLimiter === 'function') return hostLimiter(hostOf(url), request);
  if (hostLimiter?.run) return hostLimiter.run(hostOf(url), request);
  return request();
}

function looksBlocked(response, status) {
  if (BLOCKED_STATUSES.has(status) || headersOf(response).cfMitigated === 'challenge') return true;
  const body = htmlBody(response);
  if (!body) return false;
  if (CAPTCHA_HINT.test(body) && body.length < 50_000) return true;
  const jobContent = /JobPosting|jobPostingInfo|job[-_]?(?:title|description)|\b(?:responsibilities|qualifications|requirements|years? of experience)\b/i.test(body);
  return /\b(?:access\s+denied|attention\s+required)\b/i.test(body) && !jobContent;
}

function looksMalformed(response, status) {
  if (status < 200 || status >= 300) return false;
  const body = bodyOf(response);
  if (body == null) return true;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return true;
    // Binary-ish garbage or truncated non-markup payload with no useful structure.
    if (trimmed.length < 16) return true;
    if (!/[<>{[]/.test(trimmed) && trimmed.length < 80) return true;
  }
  return false;
}

function resolutionFailure(observation, reason, chain = [], extra = {}, telemetry = null) {
  const discoveryUrl = canonical(observation?.discoveryUrl ?? observation?.canonicalUrl ?? observation?.url);
  const leadOnly = {
    title: text(observation?.title) ? FIELD_SOURCE_LEAD : null,
    description: text(observation?.description) || text(observation?.snippet) ? FIELD_SOURCE_LEAD : null,
    location: text(observation?.location) ? FIELD_SOURCE_LEAD : null,
    postedAt: observation?.postedAt ? FIELD_SOURCE_LEAD : null,
  };
  return {
    status: 'verification',
    discoveryUrl,
    originalApplicationUrl: null,
    applicationResolution: { status: 'Needs Verification', evidence: null },
    shortlistEligible: false,
    evidence: {
      resolver: ORIGINAL_LISTING_RESOLVER_VERSION,
      resolution: { status: 'verification', reason, chain },
      fieldSources: leadOnly,
      leadOnly: true,
      ...extra,
    },
    telemetry: telemetry || emptyTelemetry(DEFAULT_ORIGINAL_LISTING_RESOLVER_BUDGET),
  };
}

function mergePatch(observation, details, finalUrl, provider, runAt, fingerprint) {
  const patch = {
    identityAliases: [...new Set([...(observation.identityAliases || []), candidateRequisitionKey(observation)].filter(Boolean))],
    originalApplicationUrl: finalUrl,
    originalApplicationEvidence: `original-listing:${provider}-detail`,
    applicationResolution: { status: 'Resolved Original', evidence: `original-listing:${provider}-detail` },
    sourceKind: 'ats-direct',
    provider: provider === 'employer-career' ? observation.provider : provider,
    ...(fingerprint?.requisitionId ? { jobId: fingerprint.requisitionId, providerJobId: fingerprint.requisitionId, requisitionId: fingerprint.requisitionId } : {}),
    ...(details.title ? { title: details.title } : {}),
    ...(details.description ? { description: details.description } : {}),
    ...(details.location ? { location: details.location } : {}),
    ...(details.employment ? { employment: details.employment } : {}),
    ...(details.experience ? { experience: details.experience } : {}),
    ...(details.salary ? { salary: details.salary } : {}),
    ...(details.postedAt ? { postedAt: details.postedAt } : provider === 'workday' ? { postedAt: null } : {}),
    ...(details.liveness ? { liveness: { ...details.liveness, checkedAt: details.liveness.checkedAt || runAt } } : {}),
    evidence: {
      ...(observation.evidence || {}),
      resolver: ORIGINAL_LISTING_RESOLVER_VERSION,
      originalApplication: `original-listing:${provider}-detail`,
      originalApplicationProvider: provider,
      originalApplicationLiveness: details.liveness,
      providerFingerprint: fingerprint,
      fieldSources: details.fieldSources || {},
      leadOnly: false,
      ...(details.freshness ? { freshness: details.freshness } : {}),
      resolution: details.evidence,
    },
  };
  return { ...observation, ...patch };
}

export function applyOriginalListingResolution(observation, resolution) {
  if (!resolution || typeof resolution !== 'object') return observation;
  const discoveryUrl = resolution.discoveryUrl || observation.discoveryUrl || observation.canonicalUrl || observation.url || null;
  const successful = resolution.status === 'resolved' || resolution.applicationResolution?.status === 'Resolved Original';
  if (!successful || !canonical(resolution.originalApplicationUrl ?? resolution.url)) {
    return {
      ...observation,
      ...(resolution.portalPatch || {}),
      discoveryUrl,
      originalApplicationUrl: null,
      applicationResolution: { status: 'Needs Verification', evidence: null },
      shortlistEligible: false,
      evidence: { ...(observation.evidence || {}), ...(resolution.evidence || {}), resolver: resolution.evidence?.resolver || ORIGINAL_LISTING_RESOLVER_VERSION, leadOnly: true },
    };
  }
  const finalUrl = canonical(resolution.originalApplicationUrl ?? resolution.url);
  const finalKind = classifyOriginalListingUrl(finalUrl).kind;
  if (!['ats', 'employer-career'].includes(finalKind)) {
    return {
      ...observation,
      discoveryUrl,
      originalApplicationUrl: null,
      applicationResolution: { status: 'Needs Verification', evidence: null },
      shortlistEligible: false,
      evidence: {
        ...(observation.evidence || {}),
        ...(resolution.evidence || {}),
        resolver: resolution.evidence?.resolver || ORIGINAL_LISTING_RESOLVER_VERSION,
        leadOnly: true,
        resolution: { status: 'verification', reason: 'destination-unsupported-host' },
      },
    };
  }
  const merged = { ...observation, ...(resolution.patch || {}), discoveryUrl, originalApplicationUrl: finalUrl };
  merged.applicationResolution = resolution.applicationResolution || { status: 'Resolved Original', evidence: resolution.evidence?.originalApplication || 'injected-resolver' };
  merged.evidence = { ...(observation.evidence || {}), ...(resolution.evidence || {}), ...(resolution.patch?.evidence || {}) };
  merged.classification = 'direct';
  merged.sourceKind = merged.sourceKind || 'ats-direct';
  merged.shortlistEligible = true;
  return merged;
}

/**
 * Pure shortlist gate from a resolver outcome. URL-only portal leads stay
 * non-eligible until hydration produces a Resolved Original destination.
 */
export function isShortlistEligibleFromResolution(resolution, observation = {}) {
  if (!resolution || typeof resolution !== 'object') return false;
  const resolvedUrl = canonical(resolution.originalApplicationUrl ?? resolution.url);
  if (resolution.shortlistEligible === true) {
    return Boolean(resolvedUrl && ['ats', 'employer-career'].includes(classifyOriginalListingUrl(resolvedUrl).kind));
  }
  if (resolution.status === 'resolved' && resolvedUrl && ['ats', 'employer-career'].includes(classifyOriginalListingUrl(resolvedUrl).kind)) {
    const patch = resolution.patch || {};
    return Boolean(patch.description || resolution.evidence?.resolution?.description);
  }
  const applied = applyOriginalListingResolution(observation, resolution);
  return applied.shortlistEligible === true
    && applied.applicationResolution?.status === 'Resolved Original'
    && Boolean(applied.originalApplicationUrl)
    && Boolean(applied.description || applied.evidence?.resolution?.description);
}

/** Normalize budget knobs from constructor options or crawler config. */
export function normalizeOriginalListingResolverBudget(input = {}) {
  const nested = input.originalListingResolver
    || input.sources?.originalListingResolver
    || input.sources?.resolver
    || input.budget
    || input;
  const defaults = DEFAULT_ORIGINAL_LISTING_RESOLVER_BUDGET;
  const number = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  return {
    maxRedirects: number(nested.maxRedirects ?? input.maxRedirects, defaults.maxRedirects),
    maxHosts: number(nested.maxHosts ?? input.maxHosts, defaults.maxHosts),
    maxBytes: number(nested.maxBytes ?? input.maxBytes, defaults.maxBytes),
    maxRequests: number(nested.maxRequests ?? input.maxRequests ?? nested.requestBudget ?? input.requestBudget, defaults.maxRequests),
  };
}

/**
 * Build a bounded, transport-injected resolver. It performs at most
 * `maxRequests` fetches, follows at most `maxRedirects` hops across
 * `maxHosts` hosts, and never treats aggregator snippets as employer facts.
 */
export function createOriginalListingResolver({
  transport,
  runAt = new Date().toISOString(),
  maxRedirects,
  maxHosts,
  maxBytes,
  maxRequests,
  requestBudget,
  config,
  budget,
  signal = null,
  deadline = null,
  sharedRequestBudget = null,
  hostLimiter = null,
} = {}) {
  if (typeof transport !== 'function') throw new TypeError('createOriginalListingResolver requires injected transport');
  const limits = normalizeOriginalListingResolverBudget({
    maxRedirects,
    maxHosts,
    maxBytes,
    maxRequests: maxRequests ?? (typeof requestBudget === 'number' ? requestBudget : undefined),
    budget,
    ...(config || {}),
  });
  const redirectLimit = limits.maxRedirects;
  const hostLimit = Math.max(0, limits.maxHosts);
  const requestLimit = Math.max(0, limits.maxRequests);
  const byteLimit = Math.max(0, limits.maxBytes);
  let sharedBudgetFailureReported = false;
  const publicResponseCache = new Map();

  return async function resolveOriginalListing(observation = {}, invocation = {}) {
    const activeSignal = invocation.signal ?? signal;
    const activeDeadline = invocation.deadline ?? deadline;
    const activeRequestBudget = invocation.requestBudget
      ?? sharedRequestBudget
      ?? (requestBudget && typeof requestBudget === 'object' ? requestBudget : null);
    const activeHostLimiter = invocation.hostLimiter ?? hostLimiter;
    const discoveryUrl = canonical(observation.discoveryUrl ?? observation.canonicalUrl ?? observation.url);
    const telemetry = emptyTelemetry(limits);
    const hosts = new Set();
    let portalPatch = observation.evidence?.portalDetail?.status === 'extracted' ? observation : null;
    const fail = (reason, chain = [], extra = {}, telemetryValue = telemetry) => {
      const result = resolutionFailure(observation, reason, chain, extra, telemetryValue);
      if (portalPatch) {
        result.portalPatch = portalPatch;
        result.evidence = { ...result.evidence, ...portalPatch.evidence, resolution: result.evidence.resolution,
          fieldSources: { ...result.evidence.fieldSources, ...portalPatch.evidence?.fieldSources } };
      }
      return result;
    };
    const hiringPost = observation.provider === 'hiring-post';
    const publicId = hiringPost ? null : linkedInPublicJobId(discoveryUrl);
    if (publicId && /^\d+$/.test(String(observation.jobId ?? '')) && String(observation.jobId) !== publicId) return fail('portal-detail-request-identity-mismatch');
    if (activeSignal?.aborted) return fail('aborted');
    if (remainingDeadlineMs(activeDeadline) <= 0) return fail('deadline-exceeded');

    if (!discoveryUrl || !/^https:\/\//i.test(discoveryUrl)) {
      return fail('invalid-or-insecure-discovery-url', [], {}, telemetry);
    }
    const retainedTargets = portalPatch?.evidence?.portalDetail?.applicationTargets ?? [];
    if (portalPatch && !retainedTargets.length) return fail('destination-intermediary', [discoveryUrl]);
    let current = retainedTargets.find((url) => classifyOriginalListingUrl(url).kind === 'ats') ?? discoveryUrl;
    if (hiringPost) {
      const pastedText = observation.evidence?.hiringPost?.pastedText ?? '';
      const targets = [...pastedText.matchAll(/https:\/\/[^\s<>"'\[\]]+/g)]
        .map((match) => canonical(match[0].replace(/[.,;!?)]+$/, '')))
        .filter((url) => url && safeHiringPostTarget(url));
      if (targets.length !== 1) return fail(targets.length ? 'hiring-post-ambiguous-application-links' : 'original-listing-not-found');
      current = targets[0];
    }
    const chain = [];
    const seen = new Set();
    const portalProviders = new Set(['linkedin', 'linkedin-jobs', 'glassdoor', 'instahyre', 'wellfound']);
    let crossMatchBoard = null;
    const boards = (config?.boardRegistry?.boards ?? []).filter((board) => board.enabled === true
      && ['greenhouse', 'lever', 'ashby', 'workday'].includes(board.provider)
      && normalizedIdentity(board.company) === normalizedIdentity(observation.company));
    if (portalProviders.has(String(observation.provider || '').toLowerCase()) && text(observation.company) && text(observation.title) && boards.length) {
      const matchedRoutes = [];
      let boardRequests = 0;
      for (const board of boards) {
        const request = registrySearchRequest(board, observation.title);
        if (!request || telemetry.requests >= requestLimit) break;
        const host = hostOf(request.url);
        if (host && !hosts.has(host)) {
          if (hosts.size >= hostLimit) break;
          hosts.add(host);
          telemetry.hostsFollowed = hosts.size;
        }
        if (activeRequestBudget?.claim && !activeRequestBudget.claim()) break;
        telemetry.requests += 1;
        boardRequests += 1;
        try {
          const response = await boundedTransport(transport, request.url, {
            ...request.options, maxBytes: byteLimit, signal: activeSignal, deadline: activeDeadline,
            remainingMs: remainingDeadlineMs(activeDeadline), purpose: 'portal-registry-cross-match', runAt, budget: limits,
          }, { signal: activeSignal, remainingMs: remainingDeadlineMs(activeDeadline), deadline: activeDeadline, hostLimiter: activeHostLimiter });
          telemetry.bytesObserved += responseBytes(response);
          if (Number(response?.status ?? 200) >= 200 && Number(response?.status ?? 200) < 300
            && responseBytes(response) <= byteLimit) {
            const url = registryListingMatch(response, board, observation);
            if (url) matchedRoutes.push({ board, url });
          }
        } catch {
          // A failed public board search leaves the portal lead in verification.
        }
      }
      const selected = matchedRoutes.length === 1 ? matchedRoutes[0] : null;
      telemetry.crossMatch = {
        attempted: boardRequests > 0, boardRequests, verifiedRoutes: 0,
        resolverRequests: telemetry.requests, verifiedRoutesPerRequest: boardRequests ? 0 : null, budgetRaised: false,
      };
      if (!selected && !['instahyre', 'wellfound'].includes(String(observation.provider || '').toLowerCase())) {
        return fail('original-listing-not-found', [], { crossMatch: telemetry.crossMatch }, telemetry);
      }
      if (selected) {
        crossMatchBoard = selected.board;
        current = canonical(selected.url);
      }
    }
    for (let hop = 0; hop <= redirectLimit; hop += 1) {
      if (hiringPost && !safeHiringPostTarget(current)) return fail('hiring-post-public-employer-route-required', [...chain, current]);
      if (activeSignal?.aborted) return fail('aborted', chain, {}, telemetry);
      const remainingMs = remainingDeadlineMs(activeDeadline);
      if (remainingMs <= 0) return fail('deadline-exceeded', chain, {}, telemetry);
      // A redirect into an unsupported host is a classification failure, not
      // a loop, even when canonicalization makes the destination recur.
      if (hop > 0 && classifyOriginalListingUrl(current).kind === 'unsupported') {
        return fail('redirect-to-unsupported-host', [...chain, current], {}, telemetry);
      }
      if (seen.has(current)) return fail('redirect-loop', chain, {}, telemetry);
      seen.add(current);
      chain.push(current);

      if (publicId && classifyOriginalListingUrl(current).kind === 'aggregator'
        && linkedInPublicJobId(current) !== publicId) return fail('portal-detail-redirect-identity-mismatch', chain);

      const host = hostOf(current);
      if (host && !hosts.has(host)) {
        if (hosts.size >= hostLimit) {
          return fail('host-budget-exceeded', chain, {}, telemetry);
        }
        hosts.add(host);
        telemetry.hostsFollowed = hosts.size;
      }

      const cacheKey = linkedInPublicJobId(current) ? (hop === 0 ? `linkedin:${publicId}` : canonical(current)) : null;
      const cached = cacheKey ? publicResponseCache.get(cacheKey) : null;
      if (!cached && telemetry.requests >= requestLimit) return fail('request-budget-exceeded', chain);
      if (!cached && activeRequestBudget?.claim && !activeRequestBudget.claim()) {
        const reason = sharedBudgetFailureReported ? 'resolver-bound-exhausted' : 'request-budget-exhausted';
        sharedBudgetFailureReported = true;
        return fail(reason, chain);
      }
      let response;
      try {
        if (cached) {
          telemetry.cacheHits = (telemetry.cacheHits || 0) + 1;
          response = await cached;
        } else {
          telemetry.requests += 1;
          const pending = boundedTransport(transport, current, {
            method: 'GET', redirect: 'manual', maxBytes: byteLimit,
            ...(hiringPost ? { credentials: 'omit' } : {}),
            signal: activeSignal, deadline: activeDeadline, remainingMs,
            purpose: 'original-listing-resolution', runAt, hop, budget: limits,
            telemetry: { ...telemetry },
          }, { signal: activeSignal, remainingMs, deadline: activeDeadline, hostLimiter: activeHostLimiter });
          if (cacheKey) publicResponseCache.set(cacheKey, pending);
          response = await pending;
        }
      } catch (error) {
        const reason = activeSignal?.aborted ? 'aborted' : remainingDeadlineMs(activeDeadline) <= 0 ? 'deadline-exceeded'
          : error?.message === 'response-too-large' ? 'response-too-large' : 'transport-error';
        return fail(reason, chain, { error: error?.message || reason });
      }
      if (activeSignal?.aborted) return fail('aborted', chain);
      const status = Number(response?.status ?? 200);
      if (!cached) telemetry.bytesObserved += responseBytes(response);
      if (responseBytes(response) > byteLimit || (Number.isFinite(Number(response?.byteLength)) && Number(response.byteLength) > byteLimit)) {
        return fail('response-too-large', chain);
      }

      const headers = headersOf(response);
      const responseUrl = canonical(response?.url);
      const location = canonical(headers.location, current);
      const next = location || (response?.redirected && responseUrl && responseUrl !== current ? responseUrl : null);

      if (REDIRECT_STATUSES.has(status) || next) {
        if (!next) return fail('redirect-without-location', chain, {}, telemetry);
        const target = classifyOriginalListingUrl(next);
        if (target.kind === 'unsupported' || target.kind === 'invalid'
          || (publicId && (new URL(next).protocol !== 'https:' || new URL(next).username || new URL(next).password || new URL(next).port
            || (target.kind !== 'ats' && linkedInPublicJobId(next) !== publicId)))) {
          return fail('redirect-to-unsupported-host', [...chain, next], {}, telemetry);
        }
        if (hop === redirectLimit) {
          return fail('redirect-limit-exceeded', [...chain, next], {}, telemetry);
        }
        telemetry.redirects += 1;
        current = next;
        continue;
      }

      if (looksBlocked(response, status)) {
        return fail('blocked', chain, { httpStatus: status }, telemetry);
      }
      if (status < 200 || status >= 300) {
        return fail(`detail-http-${status}`, chain, { httpStatus: status }, telemetry);
      }
      if (looksMalformed(response, status)) {
        return fail('malformed-response', chain, {}, telemetry);
      }

      // Replace the initial redirect response with the completed public page.
      // A later card using its canonical country-host URL must reuse the page,
      // rather than replaying a redirect to its own URL and reporting a loop.
      if (publicId && linkedInPublicJobId(current) === publicId) publicResponseCache.set(`linkedin:${publicId}`, Promise.resolve(response));

      const target = classifyOriginalListingUrl(current);
      if (publicId && linkedInPublicJobId(current) === publicId) {
        const extracted = parseLinkedInJobDetail(htmlBody(response), {
          requestedUrl: current, jobId: publicId, title: observation.title,
          company: observation.company, observedAt: runAt,
        });
        if (extracted.patch) {
          extracted.patch.evidence.portalDetail.applicationTargets = preferOutboundTargets(response, current, { exclude: seen })
            .filter((item) => extracted.patch.evidence.portalDetail.applicationActionTarget
              && safePortalApplicationTarget(item, extracted.patch.evidence.portalDetail.applicationActionTarget)).slice(0, 1).map((item) => item.url);
          portalPatch = { ...extracted.patch, evidence: { ...(observation.evidence || {}),
            ...extracted.patch.evidence, fieldSources: { ...observation.evidence?.fieldSources, ...extracted.patch.evidence.fieldSources } } };
        } else if (extracted.reason !== 'portal-detail-jobposting-not-found') {
          return fail(extracted.reason, chain);
        }
      }
      if (!['ats', 'employer-career'].includes(target.kind)) {
        const preferred = preferOutboundTargets(response, current, { exclude: seen })
          .filter((item) => !['instahyre', 'wellfound'].includes(String(observation.provider || '').toLowerCase())
            || safeVisiblePortalApplyTarget(item, current))
          .filter((item) => !publicId || (portalPatch
            ? portalPatch.evidence.portalDetail.applicationTargets.includes(item.url)
            : safePortalApplicationTarget(item) && !/<(?:section|ul|li)\b/i.test(htmlBody(response))));
        const original = preferred.find((item) => item.isOriginal);
        const intermediate = preferred.find((item) => !item.isOriginal);
        const destination = original?.url
          || intermediate?.url
          || (!publicId && !['instahyre', 'wellfound'].includes(String(observation.provider || '').toLowerCase())
            && urlsFromBody(response, current).find((url) => ['ats', 'employer-career'].includes(classifyOriginalListingUrl(url).kind)));
        if (!destination) {
          const reason = target.kind === 'aggregator' ? 'destination-intermediary' : 'original-listing-not-found';
          return fail(reason, chain, {
            pageKind: target.kind,
            outboundCandidates: preferred.slice(0, 5).map((item) => item.url),
          }, telemetry);
        }
        const destinationClass = classifyOriginalListingUrl(destination);
        if (seen.has(destination)) return fail('redirect-loop', [...chain, destination], {}, telemetry);
        if (hop === redirectLimit) return fail('redirect-limit-exceeded', [...chain, destination], {}, telemetry);
        if (destinationClass.kind === 'unsupported') {
          return fail('destination-unsupported-host', [...chain, destination], {}, telemetry);
        }
        telemetry.redirects += 1;
        current = destination;
        continue;
      }

      const provider = target.provider;
      const fingerprint = extractProviderFingerprint(current);
      const details = extractDetails(response, observation, provider);
      if (!details.verified) {
        const reason = details.reason === 'job-detail-not-found' && looksMalformed(response, status)
          ? 'malformed-response'
          : details.reason;
        return fail(reason, chain, { provider, fingerprint }, telemetry);
      }
      if (publicId || hiringPost || crossMatchBoard) {
        const identityObservation = crossMatchBoard ? { ...observation, company: crossMatchBoard.company } : observation;
        const identityFailure = terminalLinkedInIdentityFailure(response, identityObservation, provider, { allowMissingLeadIdentity: hiringPost });
        if (identityFailure) return fail(identityFailure, chain, { provider, fingerprint }, telemetry);
      }
      if (crossMatchBoard && !locationsMatch(details.location, observation.location)) {
        return fail('destination-role-identity-mismatch', chain, { provider, fingerprint }, telemetry);
      }
      const patched = mergePatch({ ...observation, ...(portalPatch || {}), evidence: { ...observation.evidence, ...portalPatch?.evidence } }, details, current, provider, runAt, fingerprint);
      if (hiringPost) {
        const { posting, root } = detailRoot(response);
        patched.company = stripHtmlToText(firstField(posting || root, ['hiringOrganization.name', 'company.name', 'company', 'companyName', 'employer.name', 'employer']));
        patched.evidence.fieldSources.company = FIELD_SOURCE_ORIGINAL;
      }
      if (crossMatchBoard && telemetry.crossMatch) {
        telemetry.crossMatch.verifiedRoutes = 1;
        telemetry.crossMatch.resolverRequests = telemetry.requests;
        telemetry.crossMatch.verifiedRoutesPerRequest = telemetry.requests ? 1 / telemetry.requests : null;
      }
      return {
        status: 'resolved',
        discoveryUrl,
        originalApplicationUrl: current,
        applicationResolution: patched.applicationResolution,
        patch: patched,
        evidence: patched.evidence,
        redirectChain: chain,
        providerFingerprint: fingerprint,
        shortlistEligible: true,
        telemetry,
      };
    }
    return fail('resolver-bound-exhausted', chain, {}, telemetry);
  };
}

export const createOriginalEmployerResolver = createOriginalListingResolver;
export default createOriginalListingResolver;
