import { normalizeCandidate } from '../job-pull/candidate.mjs';

const ATS_HOSTS = /(?:greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workable\.com|smartrecruiters\.com|breezy\.hr|recruitee\.com)$/i;
const AGGREGATOR_HOSTS = /(?:linkedin\.com|indeed\.com|glassdoor\.|wellfound\.com|builtin\.com|ziprecruiter\.com|dice\.com|monster\.|simplyhired\.)$/i;
const CAREER_PATH = /(?:career|careers|jobs|job|join-us|work-with-us|opportunit)/i;
const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const list = (value) => Array.isArray(value) ? value.map(clean).filter(Boolean) : clean(value) ? [clean(value)] : [];

function canonical(value) {
  try {
    const url = new URL(String(value));
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|source$|ref$)/i.test(key)) url.searchParams.delete(key);
    url.protocol = url.protocol.toLowerCase(); url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    url.pathname = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    return url.toString();
  } catch { return null; }
}
function host(value) { try { return new URL(value).hostname; } catch { return ''; } }
function directUrl(value) { const url = canonical(value); if (!url) return false; return ATS_HOSTS.test(host(url)) || (!AGGREGATOR_HOSTS.test(host(url)) && /(?:career|careers|join-us|work-with-us|opportunit)/i.test(new URL(url).pathname)); }
function parseDate(value) { if (!value) return null; const time = Date.parse(String(value)); return Number.isNaN(time) ? null : new Date(time).toISOString(); }
function title(value) { return clean(value) || 'Unresolved job lead'; }
function dimension(options, name, fallback = []) { return list(options[name] ?? options.dimensions?.[name] ?? fallback); }

/** Builds stable, duplicate-free Brave queries. Existing config.queries is accepted unchanged. */
export function buildBraveQueries(options = {}) {
  const configured = list(options.queries ?? options.searchConfig?.queries);
  if (configured.length) return [...new Set(configured.map((query) => query.trim()))].slice(0, options.maxQueries ?? 20);
  const roles = dimension(options, 'roles', ['AI Engineer']);
  const geographies = dimension(options, 'geographies', ['India']);
  const experiences = dimension(options, 'experiences', ['fresher']);
  const ats = dimension(options, 'ats');
  const career = dimension(options, 'career');
  const startup = dimension(options, 'startup');
  const vc = dimension(options, 'vc');
  const queries = [];
  for (const role of roles) for (const geography of geographies) for (const experience of experiences) {
    const base = [role, geography, experience].join(' ');
    queries.push(base);
    for (const value of ats) queries.push(`${base} site:${value}`);
    for (const value of career) queries.push(`${base} ${value}`);
    for (const value of startup) queries.push(`${base} ${value}`);
    for (const value of vc) queries.push(`${base} ${value}`);
  }
  return [...new Set(queries.map((query) => query.trim()).filter(Boolean))].slice(0, options.maxQueries ?? 20);
}

function classify(url) {
  if (directUrl(url)) return 'direct';
  if (AGGREGATOR_HOSTS.test(host(url))) return 'lead';
  return 'unresolved';
}
function responseBody(response) {
  if (typeof response?.body === 'string') { try { return JSON.parse(response.body); } catch { return null; } }
  return response?.body ?? response?.json ?? null;
}
function retryableStatus(status) { return status === 408 || status === 425 || status === 429 || status >= 500; }
function resultRows(body) { return body?.web?.results ?? body?.results; }

function observationFrom(row, sourceQuery, runAt, provider = 'brave-search') {
  const url = canonical(row?.url);
  if (!url) return null;
  const raw = {
    url,
    company: clean(row?.profile?.name ?? row?.company ?? row?.hiringOrganization?.name) || 'Unknown Company',
    title: title(row?.title),
    location: clean(row?.location),
    description: clean(row?.description),
    postedAt: parseDate(row?.page_age ?? row?.datePosted),
    discoveredAt: runAt,
    crawledAt: runAt,
    source: sourceQuery,
    provider,
    sourceKind: classify(url) === 'direct' ? 'ats-direct' : 'aggregator',
    liveness: { status: 'Not Verified', checkedAt: runAt, evidence: `${provider}-observation` },
    evidence: { classification: classify(url), sourceQuery, snippet: clean(row?.description), verified: false },
  };
  const candidate = normalizeCandidate(raw, { runAt, provider });
  candidate.classification = classify(url);
  return candidate;
}

export async function discoverBraveSearch({
  transport, runAt = new Date().toISOString(), dailyBudget, perQueryResultCap = 10, retry = {}, provider = 'brave-search', ...options
} = {}) {
  if (typeof transport !== 'function') throw new TypeError('discoverBraveSearch requires injected transport');
  const configuredQueries = list(options.queries ?? options.searchConfig?.queries);
  const queries = configuredQueries.length
    ? configuredQueries
    : buildBraveQueries({ ...options, maxQueries: options.maxQueries ?? dailyBudget ?? 20 });
  const budget = Math.max(0, Number(dailyBudget ?? queries.length));
  const receipts = []; const observations = []; const seen = new Set(); const verificationQueue = [];
  const discoveredCompanies = []; const discoveredBoards = []; const companyKeys = new Set(); const boardKeys = new Set();
  const telemetry = { queriesGenerated: queries.length, duplicateQueries: 0, budgetRequested: budget, budgetUsed: 0, resultCount: 0, duplicateResults: 0, malformedResponses: 0, retryable: 0, terminal: 0, direct: 0, leads: 0, unresolved: 0, resolverPromotions: 0 };
  const uniqueQueries = []; const queryKeys = new Set();
  for (const query of queries) { const key = query.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim(); if (queryKeys.has(key)) telemetry.duplicateQueries += 1; else { queryKeys.add(key); uniqueQueries.push(query); } }
  const maxAttempts = Math.max(1, Number(retry.maxAttempts ?? 1));
  for (const query of uniqueQueries.slice(0, budget)) {
    telemetry.budgetUsed += 1; let response; let attempts = 0; let outcome = 'terminal'; let reason = null;
    while (attempts < maxAttempts) {
      attempts += 1;
      try { response = await transport(query, { endpoint: 'brave-search', runAt }); }
      catch (error) { reason = error?.message || 'transport-error'; if (error?.retryable && attempts < maxAttempts) continue; outcome = 'terminal'; break; }
      const status = Number(response?.status ?? 200);
      if (status >= 200 && status < 300) { outcome = 'success'; break; }
      if (retryableStatus(status) && attempts < maxAttempts) continue;
      outcome = retryableStatus(status) ? 'retryable' : 'terminal'; reason = `http-${status}`; break;
    }
    if (outcome === 'terminal') telemetry.terminal += 1;
    if (outcome === 'retryable') telemetry.retryable += 1;
    const body = outcome === 'success' ? responseBody(response) : null;
    const rows = body && resultRows(body);
    if (outcome === 'success' && !Array.isArray(rows)) { outcome = 'malformed'; telemetry.malformedResponses += 1; }
    const observationsBeforeQuery = observations.length;
    if (outcome === 'success') {
      telemetry.resultCount += Math.min(rows.length, perQueryResultCap);
      for (const row of rows.slice(0, perQueryResultCap)) {
        const url = canonical(row?.url); if (!url || seen.has(url)) { if (url) telemetry.duplicateResults += 1; continue; }
        let observation = observationFrom({ ...row, url }, query, runAt, provider); if (!observation) continue; seen.add(url);
        if (typeof options.resolveOriginalListing === 'function') {
          const resolved = await options.resolveOriginalListing(observation);
          const resolvedUrl = canonical(typeof resolved === 'string' ? resolved : resolved?.url);
          if (resolvedUrl) { observation.originalApplicationUrl = resolvedUrl; observation.applicationResolution = { status: 'Resolved Original', evidence: 'injected-resolver' }; observation.classification = directUrl(resolvedUrl) ? 'direct' : 'lead'; observation.evidence = { ...observation.evidence, resolver: 'promoted', verified: true }; telemetry.resolverPromotions += 1; }
          if (resolved?.company) observation.company = resolved.company;
        }
        observations.push(observation); telemetry[observation.classification === 'direct' ? 'direct' : observation.classification === 'lead' ? 'leads' : 'unresolved'] += 1;
        if (observation.classification !== 'direct') verificationQueue.push({ url: observation.canonicalUrl, company: observation.company, reason: observation.classification === 'unresolved' ? 'unresolved-lead' : 'original-listing', evidence: observation.evidence });
        if (typeof options.enrichCompany === 'function') { const company = await options.enrichCompany(observation); if (company && !companyKeys.has(JSON.stringify(company))) { companyKeys.add(JSON.stringify(company)); discoveredCompanies.push(company); } }
        if (typeof options.enrichBoard === 'function' && observation.classification === 'direct') { const board = await options.enrichBoard(observation); if (board && !boardKeys.has(JSON.stringify(board))) { boardKeys.add(JSON.stringify(board)); discoveredBoards.push(board); } }
      }
    }
    receipts.push({ query, attempts, status: outcome, reason, resultCap: perQueryResultCap, results: outcome === 'success' ? Math.min(rows.length, perQueryResultCap) : 0, observations: outcome === 'success' ? observations.length - observationsBeforeQuery : 0 });
  }
  return { observations, verificationQueue, discoveredCompanies, discoveredBoards, receipts, manifest: { schemaVersion: provider === 'searxng' ? 'SearxngSearchManifestV1' : 'BraveSearchManifestV1', runAt, queries, telemetry, noAutoApply: true } };
}

export default discoverBraveSearch;
