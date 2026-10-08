import { normalizeCandidate } from '../job-pull/candidate.mjs';
import { applyOriginalListingResolution } from './original-listing-resolver.mjs';
import { buildBoardPromotionProposals } from './board-promotion.mjs';
import { isDeadlineCancellation, requestWithDeadline, throwIfNetworkWorkDisallowed } from './deadline.mjs';

const ATS_HOSTS = /(?:greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workable\.com|smartrecruiters\.com|breezy\.hr|recruitee\.com)$/i;
const AGGREGATOR_HOSTS = /(?:linkedin\.com|indeed\.com|glassdoor\.|wellfound\.com|builtin\.com|ziprecruiter\.com|dice\.com|monster\.|simplyhired\.)$/i;
const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const list = (value) => Array.isArray(value) ? value.map(clean).filter(Boolean) : clean(value) ? [clean(value)] : [];

/** Shared India-first dimension defaults for Brave / search discovery lanes. */
export const DEFAULT_BRAVE_DIMENSIONS = Object.freeze({
  roles: Object.freeze(['AI Engineer', 'ML Engineer', 'Backend Engineer', 'Software Engineer']),
  geographies: Object.freeze(['Pune', 'India']),
  experiences: Object.freeze(['fresher', '0-2 years', 'new grad']),
  ats: Object.freeze([
    'boards.greenhouse.io',
    'jobs.lever.co',
    'myworkdayjobs.com',
    'jobs.ashbyhq.com',
  ]),
  career: Object.freeze(['careers']),
  startup: Object.freeze(['startup']),
  vc: Object.freeze(['Peak XV portfolio', 'Accel portfolio', 'Lightspeed portfolio', 'Antler portfolio', 'a16z portfolio']),
});

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

function providerFromUrl(url) {
  const hostname = host(url);
  if (/greenhouse\.io$/i.test(hostname)) return 'greenhouse';
  if (/lever\.co$/i.test(hostname)) return 'lever';
  if (/ashbyhq\.com$/i.test(hostname)) return 'ashby';
  if (/myworkdayjobs\.com$/i.test(hostname)) return 'workday';
  if (/workable\.com$/i.test(hostname)) return 'workable';
  if (/smartrecruiters\.com$/i.test(hostname)) return 'smartrecruiters';
  if (/recruitee\.com$/i.test(hostname)) return 'recruitee';
  if (/breezy\.hr$/i.test(hostname)) return 'breezy';
  return null;
}

/** Builds stable, duplicate-free Brave queries. Existing config.queries is accepted unchanged. */
export function buildBraveQueries(options = {}) {
  const configured = list(options.queries ?? options.searchConfig?.queries);
  if (configured.length) return [...new Set(configured.map((query) => query.trim()))].slice(0, options.maxQueries ?? 20);
  const roles = dimension(options, 'roles', DEFAULT_BRAVE_DIMENSIONS.roles);
  const geographies = dimension(options, 'geographies', DEFAULT_BRAVE_DIMENSIONS.geographies);
  const experiences = dimension(options, 'experiences', DEFAULT_BRAVE_DIMENSIONS.experiences);
  const ats = dimension(options, 'ats', DEFAULT_BRAVE_DIMENSIONS.ats);
  const career = dimension(options, 'career', DEFAULT_BRAVE_DIMENSIONS.career);
  const startup = dimension(options, 'startup', DEFAULT_BRAVE_DIMENSIONS.startup);
  const vc = dimension(options, 'vc', DEFAULT_BRAVE_DIMENSIONS.vc);
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
function unresponsiveEngines(body, provider) {
  if (provider !== 'searxng' || !Array.isArray(body?.unresponsive_engines)) return [];
  return body.unresponsive_engines
    .filter((pair) => Array.isArray(pair) && pair.length >= 2)
    .map(([engine, reason]) => [engine, reason]);
}
function engineListStatus(body, provider) {
  if (provider !== 'searxng') return 'not-applicable';
  if (!Object.hasOwn(body ?? {}, 'unresponsive_engines')) return 'absent';
  return Array.isArray(body.unresponsive_engines) ? 'present' : 'malformed';
}
function sparseResults(rows, resultCap) {
  const requested = Math.max(0, Number(resultCap));
  return rows.length === 0 || (requested > 1 && rows.length <= Math.floor(requested / 2));
}
function configuredEngineNames(options) {
  return list(options.configuredEngines
    ?? options.localEngines
    ?? options.searxngEngines
    ?? options.searchConfig?.configuredEngines
    ?? options.searchConfig?.localEngines
    ?? options.searchConfig?.searxngEngines
    ?? options.engines);
}
function fullyDegraded(unresponsive, rows, options) {
  if (!unresponsive.length || !sparseResults(rows, options.perQueryResultCap)) return false;
  const configured = configuredEngineNames(options);
  if (!configured.length) return true;
  const reported = new Set(unresponsive.map(([engine]) => String(engine).toLocaleLowerCase('en-US')));
  return configured.every((engine) => reported.has(engine.toLocaleLowerCase('en-US')));
}

function cacheKey(query, page, country) {
  return `${String(query).toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim()}|p${page}|${country || ''}`;
}

/**
 * Search-engine age (Brave page_age / generic datePosted) is discovery-priority
 * evidence only. It must never become trusted employer postedAt.
 */
function observationFrom(row, sourceQuery, runAt, provider = 'brave-search') {
  const url = canonical(row?.url);
  if (!url) return null;
  const searchAge = parseDate(row?.page_age ?? row?.datePosted ?? row?.age);
  const raw = {
    url,
    company: clean(row?.profile?.name ?? row?.company ?? row?.hiringOrganization?.name) || 'Unknown Company',
    title: title(row?.title),
    location: clean(row?.location),
    description: clean(row?.description ?? row?.content),
    postedAt: null,
    discoveredAt: runAt,
    crawledAt: runAt,
    source: sourceQuery,
    provider,
    sourceKind: classify(url) === 'direct' ? 'ats-direct' : 'aggregator',
    liveness: { status: 'Not Verified', checkedAt: runAt, evidence: `${provider}-observation` },
    evidence: {
      classification: classify(url),
      sourceQuery,
      snippet: clean(row?.content ?? row?.description),
      verified: false,
      searchAge,
      searchAgeTrustedPostedAt: false,
      discoveryPriorityBoost: searchAge ? true : false,
    },
  };
  const candidate = normalizeCandidate(raw, { runAt, provider });
  candidate.classification = classify(url);
  candidate.discoveryUrl = candidate.canonicalUrl;
  if (searchAge) candidate.discoveryPriorityAt = searchAge;
  return candidate;
}

export async function discoverBraveSearch({
  transport, runAt = new Date().toISOString(), dailyBudget, perQueryResultCap = 10, retry = {}, provider = 'brave-search', signal = null, deadline = null, ...options
} = {}) {
  if (typeof transport !== 'function') throw new TypeError('discoverBraveSearch requires injected transport');
  const configuredQueries = list(options.queries ?? options.searchConfig?.queries);
  const queries = configuredQueries.length
    ? configuredQueries
    : buildBraveQueries({ ...options, maxQueries: options.maxQueries ?? dailyBudget ?? 20 });
  const budget = Math.max(0, Number(dailyBudget ?? queries.length));
  const maxPages = Math.max(1, Number(options.maxPages ?? options.pagination?.maxPages ?? 1));
  const country = clean(options.country ?? options.searchConfig?.country) || 'IN';
  const cache = options.cache instanceof Map ? options.cache : new Map();
  const enableCache = options.enableCache !== false;
  const receipts = []; const observations = []; const seen = new Set(); const verificationQueue = [];
  const discoveredCompanies = []; const discoveredBoards = []; const companyKeys = new Set(); const boardKeys = new Set();
  const telemetry = {
    queriesGenerated: queries.length, duplicateQueries: 0, budgetRequested: budget, budgetUsed: 0,
    queriesSkipped: 0, skippedReason: null, resultCount: 0, duplicateResults: 0,
    malformedResponses: 0, retryable: 0, terminal: 0, degradedQueries: 0,
    unresponsiveEngines: [], unresponsiveEngineEvents: [], direct: 0, leads: 0,
    unresolved: 0, resolverPromotions: 0,
    country, cacheHits: 0, cacheMisses: 0, pagesFetched: 0, maxPages,
    consumedCredits: 0, engineHealth: null, queryDiagnostics: [],
  };
  const uniqueQueries = []; const queryKeys = new Set();
  for (const query of queries) { const key = query.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim(); if (queryKeys.has(key)) telemetry.duplicateQueries += 1; else { queryKeys.add(key); uniqueQueries.push(query); } }
  const maxAttempts = Math.max(1, Number(retry.maxAttempts ?? 1));
  const budgetQueries = uniqueQueries.slice(0, budget);
  let skipRemaining = false;
  for (const [queryIndex, query] of budgetQueries.entries()) {
    try { throwIfNetworkWorkDisallowed(signal, deadline); } catch { telemetry.queriesSkipped += budgetQueries.length - queryIndex; break; }
    if (skipRemaining) {
      telemetry.queriesSkipped += 1;
      const queryDiagnostic = {
        query, status: 'skipped', responseStatus: null, responseStatuses: [],
        engineHealth: 'skipped', engineListStatus: provider === 'searxng' ? 'absent' : 'not-applicable',
        unresponsiveEngines: [], results: 0,
      };
      telemetry.queryDiagnostics.push(queryDiagnostic);
      receipts.push({ ...queryDiagnostic, attempts: 0, reason: telemetry.skippedReason, resultCap: perQueryResultCap, observations: 0, pages: 0 });
      continue;
    }
    telemetry.budgetUsed += 1;
    let response; let attempts = 0; let outcome = 'terminal'; let reason = null;
    let body = null; let rows = []; let engineErrors = []; let engineStatus = provider === 'searxng' ? 'absent' : 'not-applicable';
    let responseStatus = null; const responseStatuses = [];
    let pagesFetchedForQuery = 0;
    const observationsBeforeQuery = observations.length;
    for (let page = 0; page < maxPages; page += 1) {
      try { throwIfNetworkWorkDisallowed(signal, deadline); } catch { outcome = 'interrupted'; break; }
      const key = cacheKey(query, page, country);
      attempts = 0; outcome = 'terminal'; reason = null; response = undefined;
      while (attempts < maxAttempts) {
        attempts += 1;
        try {
          throwIfNetworkWorkDisallowed(signal, deadline);
          if (enableCache && cache.has(key)) {
            response = cache.get(key);
            telemetry.cacheHits += 1;
            outcome = 'success';
            break;
          }
          response = await requestWithDeadline(transport, query, {
            endpoint: 'brave-search', runAt, page, offset: page * perQueryResultCap, country, provider,
          }, { signal, deadline });
          telemetry.cacheMisses += 1;
        } catch (error) {
          reason = error?.message || 'transport-error';
          if (isDeadlineCancellation(error, signal, deadline)) { outcome = 'interrupted'; break; }
          if (error?.retryable && attempts < maxAttempts) continue;
          outcome = 'terminal'; break;
        }
        const status = Number(response?.status ?? 200);
        responseStatus = Number.isFinite(status) ? status : null;
        if (responseStatus != null) responseStatuses.push(responseStatus);
        if (status >= 200 && status < 300) {
          outcome = 'success';
          if (enableCache) cache.set(key, response);
          break;
        }
        if (retryableStatus(status) && attempts < maxAttempts) continue;
        outcome = retryableStatus(status) ? 'retryable' : 'terminal'; reason = `http-${status}`; break;
      }
      if (outcome === 'terminal') { telemetry.terminal += 1; break; }
      if (outcome === 'retryable') { telemetry.retryable += 1; break; }
      if (outcome === 'interrupted') break;
      body = responseBody(response);
      const pageRows = body && resultRows(body);
      if (!Array.isArray(pageRows)) { outcome = 'malformed'; telemetry.malformedResponses += 1; break; }
      pagesFetchedForQuery += 1;
      telemetry.pagesFetched += 1;
      const pageEngineErrors = unresponsiveEngines(body, provider);
      engineErrors = [...engineErrors, ...pageEngineErrors.filter((pair) => !engineErrors.some((existing) => existing[0] === pair[0] && existing[1] === pair[1]))];
      const pageEngineStatus = engineListStatus(body, provider);
      if (pageEngineStatus === 'malformed' || (pageEngineStatus === 'present' && engineStatus === 'absent')) engineStatus = pageEngineStatus;
      const isDegraded = pageEngineErrors.length > 0 && sparseResults(pageRows, perQueryResultCap);
      if (isDegraded) {
        outcome = 'degraded';
        if (page === 0) telemetry.degradedQueries += 1;
        for (const pair of pageEngineErrors) if (!telemetry.unresponsiveEngines.some((existing) => existing[0] === pair[0] && existing[1] === pair[1])) telemetry.unresponsiveEngines.push(pair);
        telemetry.unresponsiveEngineEvents.push({ query, page, engines: pageEngineErrors });
        if (queryIndex === 0 && page === 0 && fullyDegraded(pageEngineErrors, pageRows, { ...options, perQueryResultCap })) {
          skipRemaining = true;
          telemetry.skippedReason = 'first-query-fully-degraded';
        }
      }
      telemetry.resultCount += Math.min(pageRows.length, perQueryResultCap);
      for (const row of pageRows.slice(0, perQueryResultCap)) {
        try { throwIfNetworkWorkDisallowed(signal, deadline); } catch { outcome = 'interrupted'; break; }
        const url = canonical(row?.url); if (!url || seen.has(url)) { if (url) telemetry.duplicateResults += 1; continue; }
        let observation = observationFrom({ ...row, url }, query, runAt, provider); if (!observation) continue; seen.add(url);
        const resolver = options.resolveOriginalListing || options.resolver;
        if (typeof resolver === 'function') {
          let resolution;
          try {
            resolution = await resolver(observation, { signal, deadline });
          } catch (error) {
            resolution = { status: 'verification', evidence: { resolver: 'injected-resolver', reason: error?.message || 'resolver-error' } };
          }
          // Preserve the original resolver hook's small `{ url, company }`
          // contract, while keeping structured results fail-closed unless they
          // explicitly declare a resolved application.
          if (resolution && typeof resolution === 'object'
            && resolution.url && resolution.company
            && !resolution.status && !resolution.applicationResolution) {
            resolution = { ...resolution, status: 'resolved' };
          }
          observation = applyOriginalListingResolution(observation, typeof resolution === 'string' ? { status: 'resolved', url: resolution } : resolution);
          if (resolution?.company) observation.company = resolution.company;
          if (observation.applicationResolution?.status === 'Resolved Original') telemetry.resolverPromotions += 1;
        }
        observations.push(observation); telemetry[observation.classification === 'direct' ? 'direct' : observation.classification === 'lead' ? 'leads' : 'unresolved'] += 1;
        if (observation.classification !== 'direct') verificationQueue.push({ url: observation.canonicalUrl, company: observation.company, reason: observation.classification === 'unresolved' ? 'unresolved-lead' : 'original-listing', evidence: observation.evidence });
        if (typeof options.enrichCompany === 'function') { throwIfNetworkWorkDisallowed(signal, deadline); const company = await options.enrichCompany(observation, { signal, deadline }); if (company && !companyKeys.has(JSON.stringify(company))) { companyKeys.add(JSON.stringify(company)); discoveredCompanies.push(company); } }
        if (typeof options.enrichBoard === 'function' && observation.classification === 'direct') { throwIfNetworkWorkDisallowed(signal, deadline); const board = await options.enrichBoard(observation, { signal, deadline }); if (board && !boardKeys.has(JSON.stringify(board))) { boardKeys.add(JSON.stringify(board)); discoveredBoards.push(board); } }
      }
      if (outcome === 'interrupted') break;
      rows = pageRows;
      if (pageRows.length < perQueryResultCap) break;
      if (outcome === 'degraded' && skipRemaining) break;
    }
    if (outcome === 'interrupted') {
      telemetry.queryDiagnostics.push({ query, status: 'interrupted', responseStatus: null, responseStatuses: [], engineHealth: 'interrupted', engineListStatus: provider === 'searxng' ? 'absent' : 'not-applicable', unresponsiveEngines: [], results: observations.length - observationsBeforeQuery });
      receipts.push({ query, status: 'interrupted', attempts, reason, resultCap: perQueryResultCap, results: 0, observations: 0, pages: pagesFetchedForQuery, country });
      break;
    }
    telemetry.consumedCredits = telemetry.budgetUsed;
    const queryEngineHealth = provider === 'searxng'
      ? engineErrors.length > 0 && sparseResults(rows, perQueryResultCap)
        ? 'degraded'
        : rows.length === 0 ? 'healthy-empty' : 'ok'
      : rows.length === 0 ? 'empty' : 'ok';
    const queryDiagnostic = {
      query, status: outcome, responseStatus, responseStatuses,
      engineHealth: queryEngineHealth, engineListStatus: engineStatus,
      unresponsiveEngines: engineErrors,
      results: outcome === 'success' || outcome === 'degraded' ? Math.min(rows.length, perQueryResultCap) : 0,
    };
    telemetry.queryDiagnostics.push(queryDiagnostic);
    receipts.push({
      ...queryDiagnostic, attempts, reason, resultCap: perQueryResultCap,
      results: outcome === 'success' || outcome === 'degraded' ? Math.min(rows.length, perQueryResultCap) : 0,
      observations: outcome === 'success' || outcome === 'degraded' ? observations.length - observationsBeforeQuery : 0,
      pages: pagesFetchedForQuery, country,
    });
  }
  const executedQueries = receipts.length - telemetry.queriesSkipped;
  const degradedRun = telemetry.degradedQueries > 0 && telemetry.degradedQueries * 3 >= Math.max(1, executedQueries * 2);
  if (provider === 'searxng') {
    telemetry.engineHealth = degradedRun || telemetry.degradedQueries > 0
      ? 'degraded'
      : telemetry.resultCount === 0
        ? 'healthy-empty'
        : 'ok';
  } else {
    telemetry.engineHealth = telemetry.resultCount === 0 ? 'empty' : 'ok';
  }
  telemetry.consumedCredits = telemetry.budgetUsed;

  const promotionDiscoveries = observations
    .filter((observation) => observation.classification === 'direct' || observation.applicationResolution?.status === 'Resolved Original')
    .map((observation) => {
      const url = observation.originalApplicationUrl || observation.canonicalUrl;
      return {
        provider: providerFromUrl(url) || observation.provider,
        company: observation.company,
        url,
        discoveredAt: observation.discoveredAt ?? runAt,
      };
    });
  const promotionOptions = options.boardPromotion ?? {};
  const boardPromotion = buildBoardPromotionProposals(
    promotionDiscoveries,
    options.boardPromotionState ?? {},
    {
      runAt,
      minOccurrences: promotionOptions.minOccurrences,
      minDistinctDates: promotionOptions.minDistinctDates,
    },
  );
  for (const proposal of boardPromotion.proposals) {
    if (proposal?.suggestedBoard && !boardKeys.has(JSON.stringify(proposal.suggestedBoard))) {
      boardKeys.add(JSON.stringify(proposal.suggestedBoard));
      discoveredBoards.push(proposal.suggestedBoard);
    }
  }

  const manifest = {
    schemaVersion: provider === 'searxng' ? 'SearxngSearchManifestV1' : 'BraveSearchManifestV1',
    runAt, queries, telemetry, noAutoApply: true,
    boardPromotion: boardPromotion.manifest,
  };
  if (degradedRun) manifest.status = 'degraded';
  return {
    observations, verificationQueue, discoveredCompanies, discoveredBoards,
    boardProposals: boardPromotion.proposals,
    boardPromotionState: boardPromotion.state,
    receipts, manifest,
  };
}

export default discoverBraveSearch;
