import { normalizeCandidate } from '../job-pull/candidate.mjs';

const ATS_HOST = /(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|myworkdayjobs\.com)$/i;
const CAREER_PATH = /(?:career|careers|jobs|job|join[-_ ]?us|work[-_ ]?with[-_ ]?us|opportunit)/i;
const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const sourceId = (value) => clean(typeof value === 'string' ? value : value?.id ?? value?.source)?.toLowerCase() || null;
const list = (value) => Array.isArray(value) ? value.map(clean).filter(Boolean) : clean(value) ? [clean(value)] : [];

/** Public lane policy. Inputs are deliberately limited to public search, feed, or connector adapters. */
export const INDIA_STARTUP_LANES = Object.freeze({
  naukri: Object.freeze({ input: 'search', family: 'india-niche', host: 'naukri.com' }),
  foundit: Object.freeze({ input: 'search', family: 'india-niche', host: 'foundit.in' }),
  hirist: Object.freeze({ input: 'feed', family: 'india-niche', host: 'hirist.tech' }),
  cutshort: Object.freeze({ input: 'search', family: 'india-niche', host: 'cutshort.io' }),
  instahyre: Object.freeze({ input: 'search', family: 'india-niche', host: 'instahyre.com' }),
  peerlist: Object.freeze({ input: 'connector', family: 'startup', host: 'peerlist.io' }),
  yc: Object.freeze({ input: 'search', family: 'startup', host: 'ycombinator.com' }),
  vc: Object.freeze({ input: 'search', family: 'startup', host: 'portfolio' }),
  careers: Object.freeze({ input: 'feed', family: 'career', host: 'company-careers' }),
});

function canonical(value, base = null) {
  try {
    const url = new URL(String(value), base || undefined);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|source$|ref$)/i.test(key)) url.searchParams.delete(key);
    url.protocol = url.protocol.toLowerCase(); url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    url.pathname = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    return url.toString();
  } catch { return null; }
}

function host(value) { try { return new URL(value).hostname; } catch { return ''; } }
function parseDate(value) { const time = value == null ? NaN : Date.parse(String(value)); return Number.isNaN(time) ? null : new Date(time).toISOString(); }
function retryableStatus(status) { return [408, 425, 429].includes(status) || status >= 500; }
function responseBody(response) {
  if (typeof response?.body === 'string') {
    try { return JSON.parse(response.body); } catch { return response.body; }
  }
  return response?.body ?? response?.json ?? response;
}

function feedRecords(value, base) {
  const body = String(value || '');
  return [...body.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => {
    const chunk = match[2];
    const field = (name) => chunk.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() || null;
    const link = chunk.match(/<link\b[^>]*href\s*=\s*["']([^"']+)/i)?.[1] || field('link') || field('guid');
    return { title: field('title'), description: field('description') || field('summary') || field('content'), url: canonical(link, base), postedAt: parseDate(field('pubDate') || field('published') || field('updated')) };
  }).filter((row) => row.url);
}

function recordsFrom(response, request) {
  const body = responseBody(response);
  if (request.kind === 'feed' && typeof body === 'string') return feedRecords(body, request.url);
  if (Array.isArray(response?.records)) return response.records;
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(body)) return body;
  return body?.results ?? body?.records ?? body?.items ?? body?.jobs ?? [];
}

function directListing(url) {
  const value = canonical(url);
  if (!value) return false;
  return ATS_HOST.test(host(value)) || CAREER_PATH.test(new URL(value).pathname) && !/\b(?:naukri|foundit|hirist|cutshort|instahyre|peerlist|ycombinator)\b/i.test(host(value));
}

function requestFor(source, query) {
  const policy = INDIA_STARTUP_LANES[source.id] || {};
  return { source: source.id, kind: source.input || policy.input || 'search', query: clean(source.query || query), url: canonical(source.url), connector: clean(source.connector) };
}

/** Builds deterministic lane requests; it never creates more than queryBudget requests. */
export function buildIndiaStartupRequests(options = {}) {
  const configured = Array.isArray(options.requests) ? options.requests : [];
  if (configured.length) return configured.map((request) => requestFor({ id: sourceId(request), ...request }, request.query)).filter((request) => request.source);
  const configuredSources = Array.isArray(options.sources) ? options.sources : null;
  const explicit = configuredSources?.filter((source) => typeof source === 'object' && source !== null).map((source) => requestFor({ id: sourceId(source), ...source }, source.query)) || [];
  const ids = (configuredSources || Object.keys(INDIA_STARTUP_LANES)).filter((source) => typeof source === 'string').map((id) => id.toLowerCase());
  if (explicit.length) {
    const budget = Math.max(0, Number(options.queryBudget ?? options.dailyBudget ?? explicit.length));
    return explicit.slice(0, budget);
  }
  const roles = list(options.roles ?? ['AI Engineer']);
  const geographies = list(options.geographies ?? ['India']);
  const experiences = list(options.experiences ?? ['fresher']);
  const queries = list(options.queries);
  const generated = queries.length ? queries : roles.flatMap((role) => geographies.flatMap((geo) => experiences.map((experience) => `${role} ${geo} ${experience}`)));
  const budget = Math.max(0, Number(options.queryBudget ?? options.dailyBudget ?? generated.length * ids.length));
  const sourceBudgets = options.sourceBudgets ?? options.sourceBudget ?? {};
  const usedBySource = new Map();
  const requests = [];
  for (const id of ids) for (const query of generated) {
    if (requests.length >= budget) return requests;
    const limit = typeof sourceBudgets === 'number' ? sourceBudgets : sourceBudgets[id];
    if (limit != null && (usedBySource.get(id) || 0) >= Math.max(0, Number(limit))) continue;
    requests.push(requestFor({ id }, query));
    usedBySource.set(id, (usedBySource.get(id) || 0) + 1);
  }
  return requests;
}

function observationFrom(record, request, runAt) {
  const rawUrl = record?.applicationUrl || record?.originalUrl || record?.url || record?.link;
  const url = canonical(rawUrl, request.url);
  if (!url) return null;
  const applicationUrl = canonical(record?.applicationUrl || record?.originalUrl);
  const classification = directListing(applicationUrl || url) ? 'direct' : 'lead';
  const direct = classification === 'direct';
  const candidate = normalizeCandidate({
    url,
    company: clean(record?.company || record?.hiringOrganization?.name) || 'Unknown Company',
    title: clean(record?.title || record?.role || record?.name) || 'Unresolved job lead',
    location: clean(record?.location),
    description: clean(record?.description || record?.summary || record?.snippet),
    postedAt: parseDate(record?.postedAt || record?.datePosted || record?.publishedAt),
    discoveredAt: runAt,
    crawledAt: runAt,
    source: request.url || request.query || request.source,
    provider: `india-startup-${request.source}`,
    sourceKind: direct && ATS_HOST.test(host(url)) ? 'ats-direct' : request.source === 'vc' || request.source === 'yc' ? 'aggregator' : 'niche-public',
    liveness: { status: 'Not Verified', checkedAt: runAt, evidence: `${request.kind}-observation` },
    originalApplicationUrl: applicationUrl,
    applicationUrl,
    evidence: {
      source: request.source,
      input: request.kind,
      query: request.query,
      sourceUrl: request.url,
      classification,
      verified: direct,
      provenance: clean(record?.provenance) || 'injected-input',
    },
  }, { runAt });
  candidate.classification = classification;
  return candidate;
}

/**
 * Executes only injected public-input adapters. It intentionally has no network fallback.
 * A source without a configured feed/search/connector input is reported as unavailable.
 */
export async function discoverIndiaStartupLanes({ transport, runAt = new Date().toISOString(), retry = {}, perRequestResultCap = 20, ...options } = {}) {
  if (typeof transport !== 'function') throw new TypeError('discoverIndiaStartupLanes requires injected transport');
  const requests = buildIndiaStartupRequests(options);
  const observations = []; const seen = new Set(); const verificationQueue = []; const sources = [];
  const telemetry = { requestsGenerated: requests.length, budgetRequested: Number(options.queryBudget ?? options.dailyBudget ?? requests.length), budgetUsed: 0, extracted: 0, duplicateRecords: 0, unavailable: 0, retryable: 0, terminal: 0, malformed: 0, direct: 0, leads: 0 };
  const maxAttempts = Math.max(1, Number(retry.maxAttempts ?? 1));
  for (const request of requests) {
    const manifest = { source: request.source, input: request.kind, query: request.query, url: request.url, status: 'pending', attempts: 0, observations: 0, failures: [], provenance: { adapter: `india-startup-${request.source}`, injected: true } };
    sources.push(manifest); telemetry.budgetUsed += 1;
    if (!request.query && !request.url && !request.connector) { manifest.status = 'unavailable'; manifest.failures.push({ reason: 'missing-safe-input' }); telemetry.unavailable += 1; verificationQueue.push({ source: request.source, reason: 'source-unavailable', evidence: manifest.failures[0] }); continue; }
    let response = null; let outcome = 'terminal'; let reason = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      manifest.attempts = attempt;
      try { response = await transport(request, { runAt, attempt, lane: INDIA_STARTUP_LANES[request.source] || null }); }
      catch (error) { reason = error?.message || 'transport-error'; if (error?.retryable && attempt < maxAttempts) continue; outcome = error?.retryable ? 'retryable' : 'terminal'; break; }
      const status = Number(response?.status ?? 200);
      if (status >= 200 && status < 300) { outcome = 'success'; break; }
      reason = `http-${status}`; if (retryableStatus(status) && attempt < maxAttempts) continue;
      outcome = retryableStatus(status) ? 'retryable' : 'terminal'; break;
    }
    if (outcome !== 'success') { manifest.status = outcome; manifest.failures.push({ reason }); telemetry[outcome] += 1; verificationQueue.push({ source: request.source, query: request.query, url: request.url, reason: 'source-fetch', evidence: reason }); continue; }
    const rows = recordsFrom(response, request);
    if (!Array.isArray(rows)) { manifest.status = 'malformed'; manifest.failures.push({ reason: 'records-not-array' }); telemetry.malformed += 1; continue; }
    manifest.status = 'succeeded';
    for (const record of rows.slice(0, perRequestResultCap)) {
      const candidate = observationFrom(record, request, runAt); if (!candidate) continue;
      if (seen.has(candidate.canonicalUrl)) { telemetry.duplicateRecords += 1; continue; }
      seen.add(candidate.canonicalUrl); observations.push(candidate); manifest.observations += 1; telemetry.extracted += 1; telemetry[candidate.classification === 'direct' ? 'direct' : 'leads'] += 1;
      if (candidate.classification !== 'direct') verificationQueue.push({ source: request.source, url: candidate.canonicalUrl, company: candidate.company, reason: 'original-listing', evidence: candidate.evidence });
    }
  }
  return { observations, verificationQueue, manifest: { schemaVersion: 'IndiaStartupLanesManifestV1', runAt, sources, telemetry, noAutoApply: true }, telemetry };
}

export const discoverIndianStartupLanes = discoverIndiaStartupLanes;
export default discoverIndiaStartupLanes;
