import { normalizeCandidate } from '../job-pull/candidate.mjs';

const SUPPORTED = new Set(['workday', 'successfactors', 'phenom', 'icims', 'jobvite', 'oracle', 'custom']);
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

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
  return clean([value.name, value.city, value.addressLocality, value.region, value.country].filter(Boolean).join(', '));
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

function fields(provider, row, boardUrl) {
  const url = first(row.url, row.jobUrl, row.detailUrl, row.careerSiteUrl, row.applyUrl, row.applyurl, row.externalPath, row.jobPostingUrl, row.links?.self, row.links?.job);
  const title = first(row.title, row.jobTitle, row.jobtitle, row.name, row.role);
  const company = first(row.company, row.companyName, row.hiringOrganization?.name);
  const date = first(row.postedAt, row.datePosted, row.postingDate, row.postedOn, row.posteddate, row.createdAt);
  const id = first(row.jobReqId, row.requisitionid, row.requisitionId, row.externalCode, row.id, row.jobId);
  return {
    url: canonical(url, boardUrl), title: clean(title), company: clean(company), postedAt: parseDate(date), id: id == null ? null : String(id),
    location: locationText(first(row.location, row.locations, row.jobLocation, row.city)), description: clean(row.description || row.descriptionPlain || row.jobDescription),
    applicationUrl: canonical(first(row.applyUrl, row.applyurl, row.applicationUrl), boardUrl), provider,
  };
}

function candidateFrom(row, { provider, board, endpointUrl, page, runAt, parser }) {
  const value = fields(provider, row, board.url);
  if (!value.url || !value.title) return { value: null, failure: { code: value.url ? 'LISTING_TITLE_MISSING' : 'LISTING_URL_MISSING', message: 'listing omitted because a trustworthy URL or title was absent' } };
  const classification = host(value.url) === host(board.url) ? 'direct' : 'lead';
  const candidate = normalizeCandidate({
    url: value.url, company: value.company || board.company || 'Unknown Company', title: value.title, location: value.location,
    description: value.description, postedAt: value.postedAt, discoveredAt: runAt, crawledAt: runAt, jobId: value.id,
    applicationUrl: value.applicationUrl, originalApplicationEvidence: 'enterprise ATS observation', provider,
    source: endpointUrl, sourceKind: classification === 'direct' ? 'ats-direct' : 'aggregator',
    liveness: { status: value.postedAt ? 'Active' : 'Not Verified', checkedAt: runAt, evidence: 'enterprise-ats-feed' },
    evidence: { classification, parser, provider, boardUrl: board.url, endpointUrl, page, verified: false },
  }, { runAt, provider });
  candidate.classification = classification;
  candidate.provenance = { provider, boardUrl: board.url, endpointUrl, page, parser, transportInjected: true };
  return { value: candidate };
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

export async function discoverEnterpriseAts({ boards = [], transport, runAt = new Date().toISOString(), conditionalState = {}, maxPages = 3, maxJobsPerBoard = 100, retry = {} } = {}) {
  if (typeof transport !== 'function') throw new TypeError('discoverEnterpriseAts requires injected transport');
  const observations = []; const failures = []; const verificationQueue = []; const seen = new Set(); const state = { ...conditionalState };
  const sources = []; const telemetry = { boards: boards.length, attempted: 0, succeeded: 0, pages: 0, extracted: 0, direct: 0, leads: 0, duplicates: 0, skipped: 0, capped: 0 };
  for (const input of boards) {
    const board = { ...input, url: canonical(input.url || input.endpoint || input.boardUrl) };
    const provider = providerFrom(board);
    const source = { board: board.company || null, provider, url: board.url, status: 'pending', pagesFetched: 0, pagesCapped: false, failures: [] };
    sources.push(source);
    if (!board.url || !provider || !SUPPORTED.has(provider)) {
      const item = failure(board, 0, 'UNSUPPORTED_PROVIDER', 'board provider is unsupported or private; no listing was inferred', board.url);
      failures.push(item); source.failures.push(item); source.status = 'degraded'; telemetry.skipped += 1; continue;
    }
    let endpointUrl = board.url; const visited = new Set(); let page = 0; let boardJobs = 0; let workdayTotal = null; let workdayReceived = 0;
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
      if (status === 304) { source.status = 'ok'; state[endpointUrl] = { ...state[endpointUrl], canonicalUrl: endpointUrl, notModified: true }; telemetry.succeeded += 1; break; }
      if (status < 200 || status >= 300) {
        const item = failure(board, page, response?.error ? 'TRANSPORT_ERROR' : RETRYABLE.has(status) ? 'RETRY_EXHAUSTED' : `HTTP_${status}`, response?.error?.message || `enterprise ATS returned HTTP ${status}`, endpointUrl);
        failures.push(item); source.failures.push(item); source.status = 'degraded'; break;
      }
      const body = typeof response.body === 'string' ? response.body : response.body ?? response.json;
      state[endpointUrl] = { ...state[endpointUrl], canonicalUrl: endpointUrl, etag: response.headers?.etag ?? state[endpointUrl]?.etag ?? null, lastModified: response.headers?.['last-modified'] ?? state[endpointUrl]?.lastModified ?? null, fingerprint: String(body ?? '') };
      const payload = payloadOf(response);
      if (payload?.__malformed) {
        const item = failure(board, page, 'MALFORMED_PAYLOAD', 'response was neither valid JSON nor structured HTML', endpointUrl);
        failures.push(item); source.failures.push(item); source.status = 'degraded'; break;
      }
      if (provider === 'workday' && Number.isFinite(Number(payload?.total))) workdayTotal = Number(payload.total);
      const parsed = parserRows(provider, payload);
      if (provider === 'workday') workdayReceived += Array.isArray(parsed.rows) ? parsed.rows.length : 0;
      if (!parsed.rows) {
        const item = failure(board, page, 'MALFORMED_PAYLOAD', 'provider payload did not contain an array of listings', endpointUrl);
        failures.push(item); source.failures.push(item); source.status = 'degraded'; break;
      }
      if (parsed.malformedJsonLd) {
        const item = failure(board, page, 'MALFORMED_JSON_LD', 'one or more JSON-LD blocks could not be parsed', endpointUrl);
        failures.push(item); source.failures.push(item);
        source.status = 'degraded';
      }
      telemetry.succeeded += 1; source.status = 'ok';
      for (const row of parsed.rows) {
        if (boardJobs >= Math.max(0, Number(maxJobsPerBoard))) { source.pagesCapped = true; telemetry.capped += 1; break; }
        const parsedRow = row?.__malformedJsonLd ? null : candidateFrom(row, { provider, board, endpointUrl, page, runAt, parser: parsed.parser });
        if (!parsedRow?.value) { if (parsedRow?.failure) { const item = failure(board, page, parsedRow.failure.code, parsedRow.failure.message, endpointUrl); failures.push(item); source.failures.push(item); } telemetry.skipped += 1; continue; }
        const candidate = parsedRow.value; if (seen.has(candidate.canonicalUrl)) { telemetry.duplicates += 1; continue; }
        seen.add(candidate.canonicalUrl); observations.push(candidate); boardJobs += 1; telemetry.extracted += 1; telemetry[candidate.classification === 'direct' ? 'direct' : 'leads'] += 1;
        if (candidate.classification !== 'direct') verificationQueue.push({ url: candidate.canonicalUrl, company: candidate.company, reason: 'enterprise-lead', evidence: candidate.provenance });
      }
      if (provider === 'workday') {
        const moreOnServer = workdayTotal == null || workdayReceived < workdayTotal;
        endpointUrl = boardJobs < Math.max(0, Number(maxJobsPerBoard)) && moreOnServer ? board.url : null;
      } else {
        const next = nextUrl(provider, payload, endpointUrl, page);
        endpointUrl = next && !visited.has(next) ? next : null;
      }
    }
    if (endpointUrl) { source.pagesCapped = true; telemetry.capped += 1; }
  }
  return { observations, manifests: sources, manifest: { schemaVersion: 'EnterpriseAtsManifestV1', runAt, sources, telemetry, noAutoApply: true }, conditionalState: state, failures, verificationQueue, provenance: { transportInjected: true, networkUsed: false, providers: [...SUPPORTED] }, telemetry };
}

export const ENTERPRISE_ATS_PROVIDERS = [...SUPPORTED];
export default discoverEnterpriseAts;
