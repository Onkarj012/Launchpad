import { extractExperienceYears, normalizeCandidate, stripHtmlToText } from '../job-pull/candidate.mjs';
import { parsePostedOn } from '../career-ops/providers/workday.mjs';

const SUPPORTED = new Set(['workday', 'successfactors', 'phenom', 'icims', 'jobvite', 'oracle', 'custom']);
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

// Role-family vocabulary aligned with eligibility title patterns and job-pull role families
// (ai/ml/backend/full-stack/new-grad SWE/adjacent). Used only to decide which Workday LIST
// rows are worth a DETAIL request — never as a final reject gate.
const DEFAULT_ROLE_FAMILY_KEYWORDS = Object.freeze([
  'software', 'engineer', 'developer', 'sde', 'swe', 'backend', 'front end', 'frontend',
  'full stack', 'fullstack', 'full-stack', 'ai', 'ml', 'machine learning', 'llm', 'genai',
  'gen ai', 'python', 'data scientist', 'data engineer', 'platform', 'devops', 'sre',
  'site reliability', 'product engineer', 'application engineer', 'solutions engineer',
  'research engineer', 'automation engineer', 'associate software', 'graduate engineer',
  'member of technical staff', 'mts', 'nlp', 'prompt', 'agentic',
]);
const DEFAULT_LOCATION_KEYWORDS = Object.freeze([
  'pune', 'india', 'indian', 'bengaluru', 'bangalore', 'hyderabad', 'mumbai', 'chennai',
  'delhi', 'noida', 'gurgaon', 'gurugram', 'remote', 'apac', 'asia', 'worldwide',
  'world wide', 'global', 'anywhere', 'hinjawadi', 'hinjewadi', 'kharadi', 'baner',
]);

const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const first = (...values) => values.find((value) => clean(value) || (typeof value === 'number' && Number.isFinite(value))) ?? null;

function canonical(value, base) {
  if (value == null || value === '') return null;
  try {
    const url = new URL(String(value), base);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|source$|ref$)/i.test(key)) url.searchParams.delete(key);
    url.protocol = url.protocol.toLowerCase(); url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    url.pathname = url.pathname.replace(/\/+/g, '/');
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/$/, '');
    return url.toString();
  } catch { return null; }
}

function host(value) { try { return new URL(value).hostname; } catch { return ''; } }
function parseDate(value) { if (!value) return null; const time = Date.parse(String(value)); return Number.isNaN(time) ? null : new Date(time).toISOString(); }
function locationText(value) {
  if (Array.isArray(value)) return value.map(locationText).filter(Boolean).join(', ') || null;
  if (typeof value === 'string') return clean(value);
  if (!value || typeof value !== 'object') return null;
  return clean([value.name, value.city, value.addressLocality, value.region, value.country, value.descriptor].filter(Boolean).join(', '));
}

function jsonLd(body) {
  const found = [];
  for (const match of String(body ?? '').matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { found.push(JSON.parse(match[1].trim())); } catch { found.push({ __malformedJsonLd: true }); }
  }
  return found.flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (value?.['@graph'] && Array.isArray(value['@graph'])) return value['@graph'];
    return [value];
  }).filter((value) => value && typeof value === 'object' && (value.__malformedJsonLd || String(value['@type'] ?? '').toLowerCase().split(/\s*,\s*/).includes('jobposting')));
}

function payloadOf(response) {
  if (response?.json && typeof response.json === 'object') return response.json;
  if (response?.body && typeof response.body === 'object') return response.body;
  if (typeof response?.body === 'string') {
    const body = response.body.trim();
    if (!body) return null;
    if (/^</.test(body)) return { __html: body };
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' && typeof parsed.html === 'string' ? { __html: parsed.html } : parsed;
    } catch { return { __malformed: true }; }
  }
  return null;
}

function rowsFor(provider, payload) {
  if (!payload || payload.__html || payload.__malformed) return [];
  if (provider === 'workday') return payload.jobPostings ?? payload.postings ?? payload.data?.jobPostings ?? [];
  if (provider === 'successfactors') return payload.d?.results ?? payload.data?.d?.results ?? payload.results ?? [];
  if (provider === 'phenom') return payload.jobs ?? payload.data?.jobs ?? payload.data?.results ?? [];
  if (provider === 'icims') return payload.jobs ?? payload.results ?? payload.items ?? payload.data?.jobs ?? [];
  return payload.items ?? payload.jobs ?? payload.results ?? payload.data?.items ?? payload.data?.jobs ?? [];
}

function nextUrl(provider, payload, current, page) {
  if (!payload || payload.__html) return null;
  const supplied = first(payload.next, payload.nextPage, payload.links?.next, payload.data?.next, payload.d?.__next, payload['@odata.nextLink']);
  if (supplied) return canonical(supplied, current);
  const more = payload.hasMore === true || payload.more === true || payload.data?.hasMore === true;
  return more ? canonical(`${current}${current.includes('?') ? '&' : '?'}page=${page + 1}`, current) : null;
}

function providerFrom(board) {
  const provider = clean(board.provider)?.toLowerCase().replace(/[ ._-]+/g, '') || '';
  if (provider === 'successfactor' || provider === 'successfactors') return 'successfactors';
  if (provider === 'workday' || provider === 'phenom' || provider === 'icims' || provider === 'jobvite' || provider === 'oracle') return provider;
  if (provider === 'custom' || provider === 'jsonld') return 'custom';
  const name = host(board.url);
  if (/myworkdayjobs|workday/i.test(name)) return 'workday';
  if (/successfactors|jobs2web/i.test(name)) return 'successfactors';
  if (/phenom/i.test(name)) return 'phenom';
  if (/icims/i.test(name)) return 'icims';
  if (/jobvite/i.test(name)) return 'jobvite';
  if (/oracle/i.test(name)) return 'oracle';
  return null;
}

function listRequisitionId(row) {
  const direct = first(row.jobReqId, row.requisitionId, row.requisitionid, row.reqId, row.externalCode, row.id, row.jobId);
  if (direct != null) return String(direct);
  if (Array.isArray(row.bulletFields) && row.bulletFields.length) {
    const bullet = clean(String(row.bulletFields[0]));
    if (bullet) return bullet;
  }
  return null;
}

function fields(provider, row, boardUrl, runAt) {
  const url = first(row.url, row.jobUrl, row.detailUrl, row.careerSiteUrl, row.applyUrl, row.applyurl, row.externalPath, row.jobPostingUrl, row.links?.self, row.links?.job);
  const title = first(row.title, row.jobTitle, row.jobtitle, row.name, row.role);
  const company = first(row.company, row.companyName, row.hiringOrganization?.name);
  const date = first(row.postedAt, row.datePosted, row.postingDate, row.postedOn, row.posteddate, row.createdAt, row.startDate);
  const parsedDate = parseDate(date);
  // Relative labels resolve against the run clock, not wall-clock at parse time: a long
  // crawl would otherwise date "Posted Today" rows after runAt and trip FRESHNESS_FUTURE_POSTED_AT.
  const runClock = Date.parse(String(runAt ?? ''));
  const postedOnMs = provider === 'workday' && typeof date === 'string' && parsedDate === null
    ? parsePostedOn(date, Number.isNaN(runClock) ? Date.now() : runClock)
    : undefined;
  const id = listRequisitionId(row);
  return {
    url: canonical(url, boardUrl), title: clean(title), company: clean(company), postedAt: postedOnMs === undefined ? parsedDate : new Date(postedOnMs).toISOString(), id: id == null ? null : String(id),
    freshness: provider === 'workday'
      ? postedOnMs === undefined ? { kind: 'workday-unverified' } : { kind: 'workday-postedOn', label: date }
      : null,
    location: locationText(first(row.location, row.locations, row.locationsText, row.jobLocation, row.city)),
    description: clean(row.description || row.descriptionPlain || row.jobDescription),
    applicationUrl: canonical(first(row.applyUrl, row.applyurl, row.applicationUrl, row.externalUrl), boardUrl), provider,
    externalPath: clean(row.externalPath),
  };
}

function candidateFrom(row, { provider, board, endpointUrl, page, runAt, parser }) {
  const value = fields(provider, row, board.url, runAt);
  if (!value.url || !value.title) return { value: null, failure: { code: value.url ? 'LISTING_TITLE_MISSING' : 'LISTING_URL_MISSING', message: 'listing omitted because a trustworthy URL or title was absent' } };
  const classification = host(value.url) === host(board.url) ? 'direct' : 'lead';
  const candidate = normalizeCandidate({
    url: value.url, company: value.company || board.company || 'Unknown Company', title: value.title, location: value.location,
    description: value.description, postedAt: value.postedAt, discoveredAt: runAt, crawledAt: runAt, jobId: value.id,
    applicationUrl: value.applicationUrl, originalApplicationEvidence: 'enterprise ATS observation', provider,
    source: endpointUrl, sourceKind: classification === 'direct' ? 'ats-direct' : 'aggregator',
    liveness: { status: value.postedAt ? 'Active' : 'Not Verified', checkedAt: runAt, evidence: 'enterprise-ats-feed' },
    evidence: { classification, parser, provider, boardUrl: board.url, endpointUrl, page, verified: false, requisitionId: value.id, ...(value.freshness ? { freshness: value.freshness } : {}) },
  }, { runAt, provider });
  candidate.classification = classification;
  candidate.provenance = { provider, boardUrl: board.url, endpointUrl, page, parser, transportInjected: true };
  candidate.providerJobId = value.id;
  candidate._listExternalPath = value.externalPath;
  return { value: candidate };
}

function candidateIdentity(candidate) {
  return String(candidate.jobId ?? candidate.evidence?.providerJobId ?? candidate.canonicalUrl);
}

function parserRows(provider, payload) {
  if (payload?.__html) return { rows: jsonLd(payload.__html), parser: 'json-ld-fallback', malformedJsonLd: jsonLd(payload.__html).filter((row) => row.__malformedJsonLd).length };
  const rows = rowsFor(provider, payload);
  return { rows: Array.isArray(rows) ? rows : null, parser: `${provider}-json`, malformedJsonLd: 0 };
}

function failure(board, page, code, message, endpointUrl) {
  return { board: board.company || null, provider: board.provider || null, page, code, message, endpointUrl, provenance: { source: endpointUrl, transportInjected: true } };
}

// Workday's public CXS jobs endpoint rejects GET (HTTP 400) and requires a
// POST with a JSON search body; every other supported provider here is a
// plain GET feed. The endpoint returns { total, jobPostings } with no
// next-link, so pagination is driven by advancing `offset` in the request
// body, not by following a URL. limit stays at the verified-working 20 per
// page (config/crawler-v2.json evidenceRef); only the page count changes.
const WORKDAY_PAGE_SIZE = 20;
function workdayLimit(maxJobsPerBoard) { return Math.min(WORKDAY_PAGE_SIZE, Math.max(1, Number(maxJobsPerBoard) || WORKDAY_PAGE_SIZE)); }
function requestOptions(provider, maxJobsPerBoard, etag, offset = 0) {
  if (provider !== 'workday') return { method: 'GET', headers: { ...(etag ? { 'if-none-match': etag } : {}) } };
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(etag ? { 'if-none-match': etag } : {}) },
    body: JSON.stringify({ appliedFacets: {}, limit: workdayLimit(maxJobsPerBoard), offset: Math.max(0, Number(offset) || 0), searchText: '' }),
  };
}

function keywordHit(text, keywords) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return false;
  return keywords.some((keyword) => {
    const needle = String(keyword || '').toLowerCase().trim();
    return needle && hay.includes(needle);
  });
}

/**
 * Decide whether a Workday LIST row is worth a DETAIL fetch. Ambiguous rows
 * (missing title/location, or unclear) always select true so they are not
 * silently dropped before hydration can reveal relevance. Final policy gates
 * still own eligibility — this never rejects a role from the observation set.
 */
export function preselectWorkdayListRow(row, { roleFamilyKeywords = DEFAULT_ROLE_FAMILY_KEYWORDS, locationKeywords = DEFAULT_LOCATION_KEYWORDS } = {}) {
  const title = clean(first(row?.title, row?.jobTitle, row?.jobtitle, row?.name, row?.role)) || '';
  const location = locationText(first(row?.location, row?.locations, row?.locationsText, row?.jobLocation, row?.city)) || '';
  const roleHit = keywordHit(title, roleFamilyKeywords);
  const locationPresent = Boolean(location);
  const locationHit = locationPresent && keywordHit(location, locationKeywords);
  const ambiguous = !title || !locationPresent;

  if (ambiguous) return { selected: true, reason: 'ambiguous' };
  if (roleHit) return { selected: true, reason: 'role-family' };
  if (locationHit) return { selected: true, reason: 'location-relevant' };
  // Clearly off-family title at a clearly non-relevant location: skip DETAIL only.
  return { selected: false, reason: 'not-plausible' };
}

/**
 * Build the CXS DETAIL URL from a LIST board URL and externalPath.
 * LIST:  https://{host}/wday/cxs/{tenant}/{site}/jobs
 * DETAIL: https://{host}/wday/cxs/{tenant}/{site}/job/{loc}/{slug_REQ}
 * externalPath is typically "/job/{loc}/{slug_REQ}".
 */
export function workdayDetailUrl(boardUrl, externalPath) {
  const path = clean(externalPath);
  if (!boardUrl || !path) return null;
  if (/^https?:\/\//i.test(path)) return null;
  try {
    const board = new URL(boardUrl);
    const basePath = board.pathname.replace(/\/jobs\/?$/, '');
    if (!/\/wday\/cxs\//i.test(basePath) && !/\/wday\/cxs\//i.test(board.pathname)) {
      // Non-CXS board URL: resolve relative to host root.
      return canonical(path.startsWith('/') ? path : `/${path}`, `${board.origin}/`);
    }
    const joined = `${basePath}${path.startsWith('/') ? path : `/${path}`}`;
    return canonical(joined, board.origin);
  } catch {
    return null;
  }
}

function workdayPublicApplicationUrl(boardUrl, externalPath, detailExternalUrl) {
  const fromDetail = canonical(detailExternalUrl);
  if (fromDetail) return fromDetail;
  const path = clean(externalPath);
  if (!boardUrl || !path) return null;
  if (/^https?:\/\//i.test(path)) return canonical(path);
  try {
    const board = new URL(boardUrl);
    // Prefer human careers URL: https://{host}/{site}/job/...
    const match = board.pathname.match(/\/wday\/cxs\/[^/]+\/([^/]+)\/jobs\/?$/i);
    if (match) {
      const site = match[1];
      return canonical(`/${site}${path.startsWith('/') ? path : `/${path}`}`, board.origin);
    }
    return canonical(path, board.origin);
  } catch {
    return null;
  }
}

function extractWorkdayDetail(payload) {
  if (!payload || payload.__malformed || payload.__html) return null;
  const info = payload.jobPostingInfo && typeof payload.jobPostingInfo === 'object' ? payload.jobPostingInfo : payload;
  if (!info || typeof info !== 'object') return null;
  const descriptionHtml = first(info.jobDescription, info.description, info.descriptionHtml);
  const description = descriptionHtml ? stripHtmlToText(descriptionHtml) : null;
  const location = locationText(first(
    info.location,
    info.locationsText,
    info.jobRequisitionLocation?.descriptor,
    info.jobRequisitionLocation,
    info.country?.descriptor,
  ));
  const requisitionId = first(info.jobReqId, info.requisitionId, info.reqId, info.id);
  const applicationUrl = canonical(first(info.externalUrl, info.jobPostingUrl, info.url));
  const experienceEvidence = first(
    typeof info.experience === 'string' ? info.experience : null,
    info.experienceRequired,
    info.additionalInformation,
  );
  const experienceFromText = extractExperienceYears(description || experienceEvidence || '') || null;
  const experience = experienceFromText || (experienceEvidence ? { minYears: null, maxYears: null, evidence: experienceEvidence } : null);
  const closed = info.closed === true || info.isClosed === true || info.posted === false || info.canApply === false
    || /closed|expired|filled|withdrawn|removed/i.test(String(info.status ?? info.jobStatus ?? ''));
  const live = !closed && (info.posted === true || info.canApply === true || Boolean(description || info.title));
  // startDate / postedOn are mutable Workday provider timestamps — retained as
  // uncorroborated evidence only (see job-pull/freshness.mjs Workday exception).
  const providerStartDate = parseDate(info.startDate);
  const providerPostedOn = parseDate(info.postedOn);
  return {
    title: clean(info.title),
    description,
    location,
    requisitionId: requisitionId == null ? null : String(requisitionId),
    applicationUrl,
    experience,
    liveness: closed
      ? { status: 'Expired', evidence: 'workday-detail-closed' }
      : live
        ? { status: 'Active', evidence: 'workday-detail-live' }
        : { status: 'Not Verified', evidence: 'workday-detail-liveness-unverified' },
    providerStartDate,
    providerPostedOn,
    company: clean(payload.hiringOrganization?.name || info.hiringOrganization?.name),
  };
}

function applyWorkdayDetail(candidate, detail, { runAt, detailUrl }) {
  const requisitionId = detail.requisitionId || candidate.jobId || candidate.providerJobId || null;
  const applicationUrl = detail.applicationUrl || candidate.originalApplicationUrl || candidate.canonicalUrl;
  const description = detail.description || candidate.description || null;
  const location = detail.location || candidate.location || null;
  const experience = detail.experience || candidate.experience || { minYears: null, maxYears: null, evidence: null };
  const next = normalizeCandidate({
    ...candidate,
    url: applicationUrl,
    originalApplicationUrl: applicationUrl,
    company: detail.company || candidate.company,
    title: detail.title || candidate.title,
    location,
    description,
    jobId: requisitionId,
    postedAt: candidate.postedAt,
    discoveredAt: candidate.discoveredAt || runAt,
    crawledAt: runAt,
    applicationUrl,
    originalApplicationEvidence: 'workday detail externalUrl',
    provider: 'workday',
    source: candidate.source,
    sourceKind: candidate.sourceKind || 'ats-direct',
    experience,
    liveness: { ...detail.liveness, checkedAt: runAt },
    evidence: {
      ...candidate.evidence,
      verified: true,
      detailHydration: { status: 'succeeded', detailUrl },
      requisitionId,
      providerStartDate: detail.providerStartDate,
      providerPostedOn: detail.providerPostedOn,
      freshness: candidate.evidence?.freshness?.kind === 'workday-postedOn'
        ? candidate.evidence.freshness
        : { kind: 'workday-unverified', providerStartDate: detail.providerStartDate, providerPostedOn: detail.providerPostedOn },
    },
  }, { runAt, provider: 'workday' });
  next.classification = candidate.classification;
  next.provenance = { ...candidate.provenance, detailUrl, detailHydrated: true };
  next.providerJobId = requisitionId;
  return next;
}

function markWorkdayDetailFailure(candidate, { runAt, detailUrl, code, message }) {
  const next = {
    ...candidate,
    crawledAt: runAt || candidate.crawledAt,
    evidence: {
      ...candidate.evidence,
      verified: false,
      detailHydration: { status: 'failed', detailUrl, code, message },
      verificationReason: code,
    },
    provenance: { ...candidate.provenance, detailUrl, detailHydrated: false, detailFailure: code },
  };
  return next;
}

async function mapPool(items, concurrency, fn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  }
  const width = Math.max(1, Math.min(Number(concurrency) || 1, items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

async function hydrateWorkdayDetails(pending, {
  transport, runAt, detailConcurrency, maxDetailRequests, detailTelemetry, verificationQueue,
}) {
  let remaining = Math.max(0, Number(maxDetailRequests) || 0);
  const selected = [];
  for (const item of pending) {
    if (remaining <= 0) {
      detailTelemetry.budgetExhausted += 1;
      item.candidate.evidence = {
        ...item.candidate.evidence,
        detailHydration: { status: 'skipped', reason: 'budget-exhausted' },
      };
      continue;
    }
    remaining -= 1;
    selected.push(item);
  }

  await mapPool(selected, detailConcurrency, async (item) => {
    detailTelemetry.attempted += 1;
    const detailUrl = item.detailUrl;
    let response;
    try {
      response = await transport(detailUrl, {
        method: 'GET',
        headers: {},
        endpoint: 'enterprise-ats-detail',
        provider: 'workday',
        detail: true,
        runAt,
      });
    } catch (error) {
      detailTelemetry.failed += 1;
      item.candidate = markWorkdayDetailFailure(item.candidate, {
        runAt, detailUrl, code: 'WORKDAY_DETAIL_TRANSPORT_ERROR', message: error?.message || 'detail transport error',
      });
      verificationQueue.push({
        url: item.candidate.canonicalUrl, company: item.candidate.company,
        reason: 'workday-detail-failed', evidence: item.candidate.evidence.detailHydration,
      });
      return;
    }

    const status = Number(response?.status ?? 0);
    if (status < 200 || status >= 300) {
      detailTelemetry.failed += 1;
      const code = status === 404 ? 'WORKDAY_DETAIL_NOT_FOUND' : RETRYABLE.has(status) ? 'WORKDAY_DETAIL_RATE_LIMITED' : `WORKDAY_DETAIL_HTTP_${status || '0'}`;
      item.candidate = markWorkdayDetailFailure(item.candidate, {
        runAt, detailUrl, code, message: response?.error?.message || `workday detail returned HTTP ${status}`,
      });
      verificationQueue.push({
        url: item.candidate.canonicalUrl, company: item.candidate.company,
        reason: 'workday-detail-failed', evidence: item.candidate.evidence.detailHydration,
      });
      return;
    }

    const payload = payloadOf(response);
    if (!payload || payload.__malformed || payload.__html) {
      detailTelemetry.failed += 1;
      item.candidate = markWorkdayDetailFailure(item.candidate, {
        runAt, detailUrl, code: 'WORKDAY_DETAIL_MALFORMED', message: 'workday detail response was not valid JSON jobPostingInfo',
      });
      verificationQueue.push({
        url: item.candidate.canonicalUrl, company: item.candidate.company,
        reason: 'workday-detail-failed', evidence: item.candidate.evidence.detailHydration,
      });
      return;
    }

    const detail = extractWorkdayDetail(payload);
    if (!detail || (!detail.description && !detail.requisitionId && !detail.location)) {
      detailTelemetry.failed += 1;
      item.candidate = markWorkdayDetailFailure(item.candidate, {
        runAt, detailUrl, code: 'WORKDAY_DETAIL_EMPTY', message: 'workday detail payload lacked description, requisition id, and location',
      });
      verificationQueue.push({
        url: item.candidate.canonicalUrl, company: item.candidate.company,
        reason: 'workday-detail-failed', evidence: item.candidate.evidence.detailHydration,
      });
      return;
    }

    // Prefer list externalPath-derived public URL when detail omits externalUrl.
    if (!detail.applicationUrl) {
      detail.applicationUrl = workdayPublicApplicationUrl(item.boardUrl, item.externalPath, null);
    }
    detailTelemetry.succeeded += 1;
    item.candidate = applyWorkdayDetail(item.candidate, detail, { runAt, detailUrl });
  });
}

export async function discoverEnterpriseAts({
  boards = [],
  transport,
  runAt = new Date().toISOString(),
  conditionalState = {},
  maxPages = 3,
  maxJobsPerBoard = 100,
  retry = {},
  enrichDetails = false,
  detailConcurrency = 4,
  maxDetailRequestsPerRun = 0,
  roleFamilyKeywords = DEFAULT_ROLE_FAMILY_KEYWORDS,
  locationKeywords = DEFAULT_LOCATION_KEYWORDS,
} = {}) {
  if (typeof transport !== 'function') throw new TypeError('discoverEnterpriseAts requires injected transport');
  const observations = []; const failures = []; const verificationQueue = []; const seen = new Set(); const state = { ...conditionalState };
  const sources = [];
  const detailTelemetry = { attempted: 0, succeeded: 0, failed: 0, budgetExhausted: 0, preselected: 0, skipped: 0 };
  const telemetry = {
    boards: boards.length, attempted: 0, succeeded: 0, pages: 0, extracted: 0, direct: 0, leads: 0, duplicates: 0, skipped: 0, capped: 0,
    workdayDetail: detailTelemetry,
  };
  const detailBudget = Math.max(0, Number(maxDetailRequestsPerRun) || (enrichDetails ? 50 : 0));
  const detailEnabled = enrichDetails === true || detailBudget > 0;
  const concurrency = Math.max(1, Number(detailConcurrency) || 4);
  const workdayPending = [];

  for (const input of boards) {
    const board = { ...input, url: canonical(input.url || input.endpoint || input.boardUrl) };
    const provider = providerFrom(board);
    const boardKey = board.company || board.url;
    const resume = state.__cursor?.[boardKey] || {};
    const source = { board: board.company || null, provider, url: board.url, status: 'pending', startingCursor: resume, pagesFetched: 0, pagesCapped: false, failures: [], naturalTerminal: false, interrupted: false, truncated: false, capHit: null, recordsNotExamined: null, newestPostingAt: null };
    sources.push(source);
    if (!board.url || !provider || !SUPPORTED.has(provider)) {
      const item = failure(board, 0, 'UNSUPPORTED_PROVIDER', 'board provider is unsupported or private; no listing was inferred', board.url);
      failures.push(item); source.failures.push(item); source.status = 'degraded'; telemetry.skipped += 1; continue;
    }
    let endpointUrl = resume.endpointUrl || board.url; const visited = new Set(); let page = Number(resume.page || 0); let boardJobs = 0; let workdayTotal = null; let workdayReceived = Number(resume.workdayReceived || 0);
    while (endpointUrl && page < Math.max(1, Number(maxPages))) {
      const workdayOffset = provider === 'workday' ? workdayReceived : 0;
      page += 1; telemetry.pages += 1; telemetry.attempted += 1; source.pagesFetched += 1; visited.add(endpointUrl);
      let response; let attempts = 0; const maxAttempts = Math.max(1, Number(retry.maxAttempts ?? 1));
      while (attempts < maxAttempts) {
        attempts += 1;
        try { response = await transport(endpointUrl, { endpoint: 'enterprise-ats', provider, page, ...requestOptions(provider, maxJobsPerBoard, state[endpointUrl]?.etag, workdayOffset), runAt }); }
        catch (error) { if (error?.retryable && attempts < maxAttempts) continue; response = { status: 0, error }; break; }
        if (!RETRYABLE.has(Number(response?.status)) || attempts >= maxAttempts) break;
      }
      const status = Number(response?.status ?? 200);
      if (status === 304) { source.status = 'ok'; source.naturalTerminal = true; state[endpointUrl] = { ...state[endpointUrl], canonicalUrl: endpointUrl, notModified: true }; telemetry.succeeded += 1; break; }
      if (status < 200 || status >= 300) {
        const item = failure(board, page, response?.error ? 'TRANSPORT_ERROR' : RETRYABLE.has(status) ? 'RETRY_EXHAUSTED' : `HTTP_${status}`, response?.error?.message || `enterprise ATS returned HTTP ${status}`, endpointUrl);
        failures.push(item); source.failures.push(item); source.status = 'degraded'; source.interrupted = true; break;
      }
      const body = typeof response.body === 'string' ? response.body : response.body ?? response.json;
      state[endpointUrl] = { ...state[endpointUrl], canonicalUrl: endpointUrl, etag: response.headers?.etag ?? state[endpointUrl]?.etag ?? null, lastModified: response.headers?.['last-modified'] ?? state[endpointUrl]?.lastModified ?? null, fingerprint: String(body ?? '') };
      const payload = payloadOf(response);
      if (payload?.__malformed) {
        const item = failure(board, page, 'MALFORMED_PAYLOAD', 'response was neither valid JSON nor structured HTML', endpointUrl);
        failures.push(item); source.failures.push(item); source.status = 'degraded'; source.interrupted = true; break;
      }
      if (provider === 'workday' && Number.isFinite(Number(payload?.total))) workdayTotal = Number(payload.total);
      const parsed = parserRows(provider, payload);
      if (provider === 'workday') workdayReceived += Array.isArray(parsed.rows) ? parsed.rows.length : 0;
      if (!parsed.rows) {
        const item = failure(board, page, 'MALFORMED_PAYLOAD', 'provider payload did not contain an array of listings', endpointUrl);
        failures.push(item); source.failures.push(item); source.status = 'degraded'; source.interrupted = true; break;
      }
      if (parsed.malformedJsonLd) {
        const item = failure(board, page, 'MALFORMED_JSON_LD', 'one or more JSON-LD blocks could not be parsed', endpointUrl);
        failures.push(item); source.failures.push(item);
        source.status = 'degraded';
      }
      telemetry.succeeded += 1; source.status = 'ok';
      for (let rowIndex = 0; rowIndex < parsed.rows.length; rowIndex += 1) {
        const row = parsed.rows[rowIndex];
        if (boardJobs >= Math.max(0, Number(maxJobsPerBoard))) { source.pagesCapped = true; source.truncated = true; source.capHit = 'maxJobsPerBoard'; source.recordsNotExamined = parsed.rows.length - rowIndex; telemetry.capped += 1; break; }
        const parsedRow = row?.__malformedJsonLd ? null : candidateFrom(row, { provider, board, endpointUrl, page, runAt, parser: parsed.parser });
        if (!parsedRow?.value) { if (parsedRow?.failure) { const item = failure(board, page, parsedRow.failure.code, parsedRow.failure.message, endpointUrl); failures.push(item); source.failures.push(item); } telemetry.skipped += 1; continue; }
        const candidate = parsedRow.value; const identity = candidateIdentity(candidate); if (seen.has(identity)) { telemetry.duplicates += 1; continue; }
        seen.add(identity);
        observations.push(candidate); boardJobs += 1; source.newestPostingAt = [source.newestPostingAt, candidate.postedAt].filter(Boolean).sort().at(-1) ?? null; telemetry.extracted += 1; telemetry[candidate.classification === 'direct' ? 'direct' : 'leads'] += 1;
        if (candidate.classification !== 'direct') verificationQueue.push({ url: candidate.canonicalUrl, company: candidate.company, reason: 'enterprise-lead', evidence: candidate.provenance });

        if (provider === 'workday' && detailEnabled) {
          const selection = preselectWorkdayListRow(row, { roleFamilyKeywords, locationKeywords });
          if (!selection.selected) {
            detailTelemetry.skipped += 1;
            candidate.evidence = { ...candidate.evidence, detailHydration: { status: 'skipped', reason: selection.reason } };
          } else {
            detailTelemetry.preselected += 1;
            const detailUrl = workdayDetailUrl(board.url, candidate._listExternalPath || row.externalPath);
            if (!detailUrl) {
              detailTelemetry.skipped += 1;
              candidate.evidence = { ...candidate.evidence, detailHydration: { status: 'skipped', reason: 'no-detail-url' } };
            } else {
              workdayPending.push({
                candidate,
                observationIndex: observations.length - 1,
                detailUrl,
                boardUrl: board.url,
                externalPath: candidate._listExternalPath || row.externalPath,
              });
            }
          }
        }
        delete candidate._listExternalPath;
      }
      if (provider === 'workday') {
        const moreOnServer = workdayTotal == null || workdayReceived < workdayTotal;
        endpointUrl = boardJobs < Math.max(0, Number(maxJobsPerBoard)) && moreOnServer ? board.url : null;
      } else {
        const next = nextUrl(provider, payload, endpointUrl, page);
        endpointUrl = next && !visited.has(next) ? next : null;
      }
      if (endpointUrl && !source.truncated && !source.interrupted) state.__cursor = { ...(state.__cursor || {}), [boardKey]: { endpointUrl, page, workdayReceived } };
      else if (!endpointUrl && !source.truncated && !source.interrupted && state.__cursor) delete state.__cursor[boardKey];
      if (!endpointUrl && !source.truncated && !source.interrupted) source.naturalTerminal = true;
    }
    if (endpointUrl) { source.pagesCapped = true; source.truncated = true; source.capHit = source.capHit ?? 'maxPages'; telemetry.capped += 1; }
  }

  if (workdayPending.length && detailEnabled) {
    await hydrateWorkdayDetails(workdayPending, {
      transport, runAt, detailConcurrency: concurrency, maxDetailRequests: detailBudget, detailTelemetry, verificationQueue,
    });
    for (const item of workdayPending) {
      observations[item.observationIndex] = item.candidate;
    }
  }

  return {
    observations,
    manifests: sources,
    manifest: { schemaVersion: 'EnterpriseAtsManifestV1', runAt, sources, telemetry, changed: observations.length, naturalTerminal: sources.length > 0 && sources.every((source) => source.naturalTerminal), interrupted: sources.some((source) => source.interrupted), truncated: sources.some((source) => source.truncated), capHit: sources.find((source) => source.capHit)?.capHit ?? null, recordsNotExamined: sources.reduce((sum, source) => sum + (source.recordsNotExamined ?? 0), 0) || null, newestPostingAt: observations.map((row) => row.postedAt).filter(Boolean).sort().at(-1) ?? null, noAutoApply: true },
    conditionalState: state,
    failures,
    verificationQueue,
    provenance: { transportInjected: true, networkUsed: false, providers: [...SUPPORTED] },
    telemetry,
  };
}

export const ENTERPRISE_ATS_PROVIDERS = [...SUPPORTED];
export const WORKDAY_DEFAULT_ROLE_FAMILY_KEYWORDS = DEFAULT_ROLE_FAMILY_KEYWORDS;
export const WORKDAY_DEFAULT_LOCATION_KEYWORDS = DEFAULT_LOCATION_KEYWORDS;
export default discoverEnterpriseAts;
