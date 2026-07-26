export const ORIGINAL_LISTING_RESOLVER_VERSION = 'OriginalListingResolverV1';

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
const CAREER_PATH = /(?:^|[\/_-])(career|careers|jobs?|join[-_ ]?us|work[-_ ]?with[-_ ]?us|opportunit)(?:$|[\/_-])/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_STATUSES = new Set([401, 403, 407, 429, 451]);
const APPLY_HINT = /\b(apply|view\s+original|view\s+job|original\s+posting|company\s+site|employer|external\s+apply|continue\s+to\s+application)\b/i;
const CANONICAL_REL = /\brel\s*=\s*["'][^"']*canonical[^"']*["']/i;
const CAPTCHA_HINT = /\b(captcha|recaptcha|hcaptcha|cf-challenge|attention\s+required|access\s+denied|paywall|subscribe\s+to\s+continue|verify\s+you\s+are\s+human)\b/i;
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

function extractExperienceYears(raw) {
  const cleaned = stripHtmlToText(raw || '');
  if (!cleaned) return null;
  const matches = [];
  const patterns = [
    /(?:minimum(?:\s+of)?|at\s+least|must\s+have|require(?:d|s)?|requirements?:|experience:)\D{0,40}?\b(\d+(?:\.\d+)?)(?:\s*(?:\+|to|-)\s*(\d+(?:\.\d+)?))?\s*(?:years?|yrs?)/gi,
    /\b(\d+(?:\.\d+)?)(?:\s*(?:\+|to|-)\s*(\d+(?:\.\d+)?))?\s*(?:years?|yrs?)\b(?:\s+of)?(?:\s+(?:professional|relevant|industry))?\s+experience\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const minYears = Number(match[1]);
      const maxYears = match[2] == null ? null : Number(match[2]);
      if (!Number.isFinite(minYears)) continue;
      matches.push({
        minYears,
        maxYears: Number.isFinite(maxYears) ? maxYears : null,
        evidence: match[0].trim().replace(/\s+/g, ' '),
      });
    }
  }
  if (!matches.length) return null;
  return matches.reduce((best, current) => (current.minYears > best.minYears ? current : best));
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
    : headers[name] ?? headers[name.toLowerCase()] ?? null;
  return { location: get('location'), contentType: get('content-type') };
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
  const key = text(typeof raw === 'object' ? raw?.name ?? raw?.value : raw)?.toLowerCase().replace(/\s+/g, ' ');
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
    const last = segments[segments.length - 1];
    if (last && /^[0-9a-f-]{8,}$/i.test(last)) requisitionId = last;
  } else if (classified.provider === 'ashby') {
    const last = segments[segments.length - 1];
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
    if (last && !/^(en-us|careers|job|jobs)$/i.test(last)) requisitionId = decodeURIComponent(last);
  } else if (classified.provider === 'employer-career') {
    const last = segments[segments.length - 1];
    if (last && last.length >= 3) requisitionId = decodeURIComponent(last);
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

function emptyTelemetry(budget) {
  return {
    requests: 0,
    requestCount: 0,
    redirects: 0,
    hostsFollowed: 0,
    bytesObserved: 0,
    finalUrl: null,
    redirectChain: [],
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

function looksBlocked(response, status) {
  if (BLOCKED_STATUSES.has(status)) return true;
  const body = htmlBody(response);
  if (!body) return false;
  return CAPTCHA_HINT.test(body) && body.length < 50_000;
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
  const resolverTelemetry = telemetry || emptyTelemetry(DEFAULT_ORIGINAL_LISTING_RESOLVER_BUDGET);
  resolverTelemetry.requestCount = resolverTelemetry.requests;
  resolverTelemetry.finalUrl = chain.at(-1) ?? resolverTelemetry.finalUrl;
  resolverTelemetry.redirectChain = [...chain];
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
    telemetry: resolverTelemetry,
  };
}

function mergePatch(observation, details, finalUrl, provider, runAt, fingerprint) {
  const patch = {
    originalApplicationUrl: finalUrl,
    originalApplicationEvidence: `original-listing:${provider}-detail`,
    applicationResolution: { status: 'Resolved Original', evidence: `original-listing:${provider}-detail` },
    sourceKind: 'ats-direct',
    provider: provider === 'employer-career' ? observation.provider : provider,
    ...(fingerprint?.requisitionId ? { jobId: fingerprint.requisitionId, requisitionId: fingerprint.requisitionId } : {}),
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
      discoveryUrl,
      originalApplicationUrl: null,
      applicationResolution: { status: 'Needs Verification', evidence: null },
      shortlistEligible: false,
      evidence: { ...(observation.evidence || {}), ...(resolution.evidence || {}), resolver: resolution.evidence?.resolver || ORIGINAL_LISTING_RESOLVER_VERSION, leadOnly: true },
    };
  }
  const finalUrl = canonical(resolution.originalApplicationUrl ?? resolution.url);
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
  if (resolution.shortlistEligible === true) return true;
  if (resolution.status === 'resolved' && canonical(resolution.originalApplicationUrl ?? resolution.url)) {
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
  timeoutMs = 30_000,
  config,
  budget,
} = {}) {
  if (typeof transport !== 'function') throw new TypeError('createOriginalListingResolver requires injected transport');
  const limits = normalizeOriginalListingResolverBudget({
    maxRedirects,
    maxHosts,
    maxBytes,
    maxRequests: maxRequests ?? requestBudget,
    budget,
    ...(config || {}),
  });
  const redirectLimit = limits.maxRedirects;
  const hostLimit = Math.max(1, limits.maxHosts);
  const requestLimit = Math.max(1, limits.maxRequests);
  const byteLimit = Math.max(1, limits.maxBytes);

  return async function resolveOriginalListing(observation = {}) {
    const discoveryUrl = canonical(observation.discoveryUrl ?? observation.canonicalUrl ?? observation.url);
    const telemetry = emptyTelemetry(limits);
    const hosts = new Set();
    if (!discoveryUrl || !/^https:\/\//i.test(discoveryUrl)) {
      return resolutionFailure(observation, 'invalid-or-insecure-discovery-url', [], {}, telemetry);
    }
    let current = discoveryUrl;
    const chain = [];
    const seen = new Set();
    for (let hop = 0; hop <= redirectLimit; hop += 1) {
      // A redirect into an unsupported host is a classification failure, not
      // a loop, even when canonicalization makes the destination recur.
      if (hop > 0 && classifyOriginalListingUrl(current).kind === 'unsupported') {
        return resolutionFailure(observation, 'redirect-to-unsupported-host', [...chain, current], {}, telemetry);
      }
      if (seen.has(current)) return resolutionFailure(observation, 'redirect-loop', chain, {}, telemetry);
      seen.add(current);
      chain.push(current);
      telemetry.finalUrl = current;
      telemetry.redirectChain = [...chain];

      const host = hostOf(current);
      if (host && !hosts.has(host)) {
        if (hosts.size >= hostLimit) {
          return resolutionFailure(observation, 'host-budget-exceeded', chain, {}, telemetry);
        }
        hosts.add(host);
        telemetry.hostsFollowed = hosts.size;
      }

      if (telemetry.requests >= requestLimit) {
        return resolutionFailure(observation, 'request-budget-exceeded', chain, {}, telemetry);
      }

      let response;
      try {
        telemetry.requests += 1;
        telemetry.requestCount = telemetry.requests;
        response = await transport(current, {
          method: 'GET',
          redirect: 'manual',
          timeoutMs,
          maxHosts: hostLimit,
          maxRequests: requestLimit,
          maxRedirects: redirectLimit,
          maxBytes: byteLimit,
          purpose: 'original-listing-resolution',
          runAt,
          hop,
          budget: limits,
          telemetry: { ...telemetry },
        });
      } catch (error) {
        return resolutionFailure(observation, 'transport-error', chain, { error: error?.message || 'transport-error' }, telemetry);
      }

      const status = Number(response?.status ?? 200);
      telemetry.bytesObserved += responseBytes(response);
      if (Number.isFinite(Number(response?.byteLength)) && Number(response.byteLength) > byteLimit) {
        return resolutionFailure(observation, 'response-too-large', chain, {}, telemetry);
      }

      const headers = headersOf(response);
      const responseUrl = canonical(response?.url);
      const location = canonical(headers.location, current);
      const next = location || (response?.redirected && responseUrl && responseUrl !== current ? responseUrl : null);

      if (REDIRECT_STATUSES.has(status) || next) {
        if (!next) return resolutionFailure(observation, 'redirect-without-location', chain, {}, telemetry);
        const target = classifyOriginalListingUrl(next);
        if (target.kind === 'unsupported' || target.kind === 'invalid') {
          return resolutionFailure(observation, 'redirect-to-unsupported-host', [...chain, next], {}, telemetry);
        }
        if (hop === redirectLimit) {
          return resolutionFailure(observation, 'redirect-limit-exceeded', [...chain, next], {}, telemetry);
        }
        telemetry.redirects += 1;
        current = next;
        continue;
      }

      if (looksBlocked(response, status)) {
        return resolutionFailure(observation, 'blocked', chain, { httpStatus: status }, telemetry);
      }
      if (status < 200 || status >= 300) {
        return resolutionFailure(observation, `detail-http-${status}`, chain, { httpStatus: status }, telemetry);
      }
      if (looksMalformed(response, status)) {
        return resolutionFailure(observation, 'malformed-response', chain, {}, telemetry);
      }

      const target = classifyOriginalListingUrl(current);
      if (!['ats', 'employer-career'].includes(target.kind)) {
        const preferred = preferOutboundTargets(response, current, { exclude: seen });
        const original = preferred.find((item) => item.isOriginal);
        const intermediate = preferred.find((item) => !item.isOriginal);
        const destination = original?.url
          || intermediate?.url
          || urlsFromBody(response, current).find((url) => ['ats', 'employer-career'].includes(classifyOriginalListingUrl(url).kind));
        if (!destination) {
          const reason = target.kind === 'aggregator' ? 'destination-intermediary' : 'original-listing-not-found';
          return resolutionFailure(observation, reason, chain, {
            pageKind: target.kind,
            outboundCandidates: preferred.slice(0, 5).map((item) => item.url),
          }, telemetry);
        }
        const destinationClass = classifyOriginalListingUrl(destination);
        if (seen.has(destination)) return resolutionFailure(observation, 'redirect-loop', [...chain, destination], {}, telemetry);
        if (hop === redirectLimit) return resolutionFailure(observation, 'redirect-limit-exceeded', [...chain, destination], {}, telemetry);
        if (destinationClass.kind === 'unsupported') {
          return resolutionFailure(observation, 'destination-unsupported-host', [...chain, destination], {}, telemetry);
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
        return resolutionFailure(observation, reason, chain, { provider, fingerprint }, telemetry);
      }
      const patched = mergePatch(observation, details, current, provider, runAt, fingerprint);
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
        telemetry: {
          ...telemetry,
          requestCount: telemetry.requests,
          finalUrl: current,
          redirectChain: [...chain],
        },
      };
    }
    return resolutionFailure(observation, 'resolver-bound-exhausted', chain, {}, telemetry);
  };
}

export const createOriginalEmployerResolver = createOriginalListingResolver;
export default createOriginalListingResolver;
