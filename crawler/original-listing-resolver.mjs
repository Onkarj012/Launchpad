import { extractExperienceYears, stripHtmlToText } from '../job-pull/candidate.mjs';

export const ORIGINAL_LISTING_RESOLVER_VERSION = 'OriginalListingResolverV1';

const ATS_HOSTS = Object.freeze([
  ['greenhouse', /(?:^|\.)greenhouse\.io$/i],
  ['lever', /(?:^|\.)lever\.co$/i],
  ['ashby', /(?:^|\.)ashbyhq\.com$/i],
  ['smartrecruiters', /(?:^|\.)smartrecruiters\.com$/i],
  ['workable', /(?:^|\.)workable\.com$/i],
  ['recruitee', /(?:^|\.)recruitee\.com$/i],
  ['workday', /(?:^|\.)myworkdayjobs\.com$/i],
]);
const AGGREGATOR_HOST = /(?:^|\.)(?:linkedin\.com|indeed\.[a-z.]+|glassdoor\.[a-z.]+|wellfound\.com|builtin\.com|ziprecruiter\.com|dice\.com|monster\.[a-z.]+|simplyhired\.[a-z.]+)$/i;
const RESERVED_HOST = /(?:^|\.)(?:example|invalid|test|localhost)(?:$|\.)/i;
const CAREER_PATH = /(?:^|[\/_-])(career|careers|jobs?|join[-_ ]?us|work[-_ ]?with[-_ ]?us|opportunit)(?:$|[\/_-])/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 3;

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const first = (...values) => values.find((value) => text(value) != null) ?? null;

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
    evidence: {
      detail: 'original-listing-detail',
      description: Boolean(description),
      experience: Boolean(experience?.evidence || experience?.minYears != null),
      employment: Boolean(employment),
      location: Boolean(location),
      compensation: Boolean(salaryValue(posting || root)),
      closing: Boolean(validThrough || closed || rawStatus),
      liveness: active || closed,
    },
  };
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
  const html = htmlBody(response);
  for (const match of html.matchAll(/<(?:link|meta)\b[^>]*(?:href|content)\s*=\s*["']([^"']+)["'][^>]*>/gi)) add(match[1]);
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) add(match[1]);
  return [...new Set(urls)];
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

function resolutionFailure(observation, reason, chain = [], extra = {}) {
  const discoveryUrl = canonical(observation?.discoveryUrl ?? observation?.canonicalUrl ?? observation?.url);
  return {
    status: 'verification',
    discoveryUrl,
    originalApplicationUrl: null,
    applicationResolution: { status: 'Needs Verification', evidence: null },
    evidence: {
      resolver: ORIGINAL_LISTING_RESOLVER_VERSION,
      resolution: { status: 'verification', reason, chain },
      ...extra,
    },
  };
}

function mergePatch(observation, details, finalUrl, provider, runAt) {
  const patch = {
    originalApplicationUrl: finalUrl,
    originalApplicationEvidence: `original-listing:${provider}-detail`,
    applicationResolution: { status: 'Resolved Original', evidence: `original-listing:${provider}-detail` },
    sourceKind: 'ats-direct',
    provider: provider === 'employer-career' ? observation.provider : provider,
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
      evidence: { ...(observation.evidence || {}), ...(resolution.evidence || {}), resolver: resolution.evidence?.resolver || ORIGINAL_LISTING_RESOLVER_VERSION },
    };
  }
  const finalUrl = canonical(resolution.originalApplicationUrl ?? resolution.url);
  const merged = { ...observation, ...(resolution.patch || {}), discoveryUrl, originalApplicationUrl: finalUrl };
  merged.applicationResolution = resolution.applicationResolution || { status: 'Resolved Original', evidence: resolution.evidence?.originalApplication || 'injected-resolver' };
  merged.evidence = { ...(observation.evidence || {}), ...(resolution.evidence || {}), ...(resolution.patch?.evidence || {}) };
  merged.classification = 'direct';
  return merged;
}

/**
 * Build a bounded, transport-injected resolver. It performs at most
 * `maxRedirects + 1` requests and never follows a redirect to an unsupported
 * host. It does not run shared eligibility, freshness, or readiness gates.
 */
export function createOriginalListingResolver({ transport, runAt = new Date().toISOString(), maxRedirects = MAX_REDIRECT_HOPS, maxBytes = 2_000_000 } = {}) {
  if (typeof transport !== 'function') throw new TypeError('createOriginalListingResolver requires injected transport');
  const redirectLimit = Math.max(0, Math.min(MAX_REDIRECT_HOPS, Number(maxRedirects) || 0));

  return async function resolveOriginalListing(observation = {}) {
    const discoveryUrl = canonical(observation.discoveryUrl ?? observation.canonicalUrl ?? observation.url);
    if (!discoveryUrl || !/^https:\/\//i.test(discoveryUrl)) return resolutionFailure(observation, 'invalid-or-insecure-discovery-url');
    let current = discoveryUrl;
    const chain = [];
    const seen = new Set();
    for (let hop = 0; hop <= redirectLimit; hop += 1) {
      // A redirect into an unsupported host is a classification failure, not
      // a loop, even when canonicalization makes the destination recur.
      if (hop > 0 && classifyOriginalListingUrl(current).kind === 'unsupported') {
        return resolutionFailure(observation, 'redirect-to-unsupported-host', [...chain, current]);
      }
      if (seen.has(current)) return resolutionFailure(observation, 'redirect-loop', chain);
      seen.add(current); chain.push(current);
      let response;
      try {
        response = await transport(current, { method: 'GET', redirect: 'manual', maxBytes, purpose: 'original-listing-resolution', runAt, hop });
      } catch (error) {
        return resolutionFailure(observation, 'transport-error', chain, { error: error?.message || 'transport-error' });
      }
      const status = Number(response?.status ?? 200);
      const headers = headersOf(response);
      const responseUrl = canonical(response?.url);
      const location = canonical(headers.location, current);
      const next = location || (response?.redirected && responseUrl && responseUrl !== current ? responseUrl : null);
      if (REDIRECT_STATUSES.has(status) || next) {
        if (!next) return resolutionFailure(observation, 'redirect-without-location', chain);
        const target = classifyOriginalListingUrl(next);
        if (target.kind === 'unsupported' || target.kind === 'invalid') return resolutionFailure(observation, 'redirect-to-unsupported-host', [...chain, next]);
        if (hop === redirectLimit) return resolutionFailure(observation, 'redirect-limit-exceeded', [...chain, next]);
        current = next;
        continue;
      }
      if (status < 200 || status >= 300) return resolutionFailure(observation, `detail-http-${status}`, chain);
      const target = classifyOriginalListingUrl(current);
      if (!['ats', 'employer-career'].includes(target.kind)) {
        const destination = urlsFromBody(response, current).find((url) => ['ats', 'employer-career'].includes(classifyOriginalListingUrl(url).kind));
        if (!destination) return resolutionFailure(observation, 'original-listing-not-found', chain);
        const destinationClass = classifyOriginalListingUrl(destination);
        if (seen.has(destination)) return resolutionFailure(observation, 'redirect-loop', [...chain, destination]);
        if (hop === redirectLimit) return resolutionFailure(observation, 'redirect-limit-exceeded', [...chain, destination]);
        if (destinationClass.kind === 'unsupported') return resolutionFailure(observation, 'destination-unsupported-host', [...chain, destination]);
        current = destination;
        continue;
      }
      const provider = target.provider;
      const details = extractDetails(response, observation, provider);
      if (!details.verified) return resolutionFailure(observation, details.reason, chain);
      const patched = mergePatch(observation, details, current, provider, runAt);
      return {
        status: 'resolved',
        discoveryUrl,
        originalApplicationUrl: current,
        applicationResolution: patched.applicationResolution,
        patch: patched,
        evidence: patched.evidence,
        redirectChain: chain,
      };
    }
    return resolutionFailure(observation, 'resolver-bound-exhausted', chain);
  };
}

export const createOriginalEmployerResolver = createOriginalListingResolver;
export default createOriginalListingResolver;
