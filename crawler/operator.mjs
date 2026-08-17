import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fetchAtsBatch1 } from './ats-batch-1.mjs';
import { fetchWarmAts } from './ats-warm.mjs';
import { buildBraveQueries, DEFAULT_BRAVE_DIMENSIONS, discoverBraveSearch } from './brave-search.mjs';
import { createChromiumFallbackTransport } from './chromium-fallback.mjs';
import { discoverAtsBatch2 } from './ats-batch-2.mjs';
import { discoverEnterpriseAts } from './ats-enterprise.mjs';
import { importIndeedInbox } from './indeed-inbox.mjs';
import {
  ORIGINAL_LISTING_RESOLVER_VERSION,
  applyOriginalListingResolution,
  createOriginalListingResolver,
} from './original-listing-resolver.mjs';
import { discoverIndiaStartupLanes } from './india-startup-lanes.mjs';
import { discoverTheirStack } from './theirstack.mjs';
import { discoverYcJobs } from './yc-discovery.mjs';
import { buildVcWatchlistRequests, loadVcPortfolioWatchlist } from './vc-portfolio-watchlist.mjs';
import { runCommercialRescue } from './commercial-rescue.mjs';
import { openCrawlerStore } from './run.mjs';
import { selectDailyReserve } from './reserve.mjs';
import { buildSchedulePlans } from './schedules.mjs';
import { crawlWorkflow } from './workflow.mjs';
import { classifyCandidate } from '../job-pull/eligibility.mjs';
import { classifyFreshness } from '../job-pull/freshness.mjs';
import { loadConfig as loadJobPullPolicy } from '../job-pull/config.mjs';
import { applicationReadiness } from '../job-pull/normal-readiness.mjs';
import { readOpportunityLedger } from '../job-pull/opportunity-ledger.mjs';
import { readV4HistorySnapshot } from './v4-history-snapshot.mjs';
import { normalizeCandidate } from '../job-pull/candidate.mjs';
import { runStartupSourcePlan } from '../job-pull/startup-sources.mjs';
import { runRemoteSourcePlan, selectRemoteProviders } from '../job-pull/remote-sources.mjs';
import { buildDiscoveryProfile } from './discovery-profile.mjs';
import {
  CONNECTOR_PROVIDERS,
  normalizeConnectorEnvelope,
} from './connector-inbox.mjs';
import {
  withRegistryProjectedBoards,
} from './board-registry.mjs';

export const CRAWLER_CONFIG_VERSION = 'LaunchpadCrawlerConfigV1';

const THEIRSTACK_POSITIVE_INTEGER_FIELDS = Object.freeze([
  'pageSize',
  'maxQueriesPerRun',
  'maxPagesPerQuery',
  'maxItemsPerRun',
  'maxCreditsPerRun',
]);
const THEIRSTACK_REQUIRED_FILTER_FIELDS = Object.freeze([
  'posted_at_max_age_days',
  'posted_at_gte',
  'posted_at_lte',
  'company_domain_or',
  'company_linkedin_url_or',
  'company_name_or',
]);
const THEIRSTACK_ADAPTER_FILTER_FIELDS = new Set([
  'limit',
  'offset',
  'page',
  'cursor',
  'include_total_results',
  'order_by',
  'blur_company_data',
]);
const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

function hasTheirStackConstraint(filters) {
  return THEIRSTACK_REQUIRED_FILTER_FIELDS.some((field) => {
    if (!Object.hasOwn(filters, field)) return false;
    const value = filters[field];
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return Boolean(value.trim());
    return value !== null && value !== undefined;
  });
}

function validateTheirStackConfig(theirStack) {
  if (theirStack == null) return;
  if (typeof theirStack !== 'object' || Array.isArray(theirStack)) throw new Error('sources.theirstack must be an object');
  if (typeof theirStack.enabled !== 'boolean') throw new Error('sources.theirstack.enabled must be a boolean');
  const apiKeyEnv = theirStack.apiKeyEnv ?? 'THEIRSTACK_API_KEY';
  if (typeof apiKeyEnv !== 'string' || !ENV_VAR_NAME_RE.test(apiKeyEnv)) {
    throw new Error('sources.theirstack.apiKeyEnv must be an uppercase environment variable name');
  }
  if (Object.hasOwn(theirStack, 'endpoint')) throw new Error('sources.theirstack.endpoint cannot override the fixed TheirStack endpoint');
  for (const field of THEIRSTACK_POSITIVE_INTEGER_FIELDS) {
    if (!Number.isInteger(theirStack[field]) || theirStack[field] <= 0) {
      throw new Error(`sources.theirstack.${field} must be a positive integer`);
    }
  }
  if (!Array.isArray(theirStack.queries)) throw new Error('sources.theirstack.queries must be an array');
  const queryIds = new Set();
  for (const [index, query] of theirStack.queries.entries()) {
    if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error(`sources.theirstack.queries[${index}] must be an object`);
    const id = typeof query.id === 'string' ? query.id.trim() : '';
    if (!id) throw new Error(`sources.theirstack.queries[${index}].id must be nonempty`);
    if (queryIds.has(id)) throw new Error(`sources.theirstack query id must be unique: ${id}`);
    queryIds.add(id);
    const filters = query.filters;
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
      throw new Error(`sources.theirstack.queries[${index}].filters must be an object`);
    }
    if (!hasTheirStackConstraint(filters)) {
      throw new Error(`sources.theirstack.queries[${index}].filters must include a supported TheirStack constraint`);
    }
    const ownedField = Object.keys(filters).find((field) => THEIRSTACK_ADAPTER_FILTER_FIELDS.has(field));
    if (ownedField) throw new Error(`sources.theirstack.queries[${index}].filters.${ownedField} is adapter-owned`);
  }
}

export function buildCrawlerHelp() {
  return `Launchpad Crawler v2

Usage:
  node crawler/cli.mjs validate [--config FILE]
  node crawler/cli.mjs plan [morning|midday] [--mode normal|startup|remote] [--location-preset india|pune] [--config FILE]
  node crawler/cli.mjs run [morning|midday] [--mode normal|startup|remote] [--location-preset india|pune] [--config FILE] [--run-id ID]
  node crawler/cli.mjs daily [morning] [--config FILE] [--env production|live-test|dev] [--run-id ID] [--scores-json FILE] [--no-scorer]
  node crawler/cli.mjs readiness [--run-tests] [--operational-evidence FILE]
  node crawler/cli.mjs install-schedule [--dry-run]
  node crawler/cli.mjs schedule-health [--config FILE]

The crawler performs discovery and produces a planning-only handoff. It never applies or sends.
install-schedule installs local launchd agents for the morning and midday
schedules; schedule-health reports durable per-schedule run history.
Commercial rescue remains explicit and
requires separate configured credentials and operator invocation.
`;
}

export function validateCrawlerConfig(config) {
  if (!config || config.schemaVersion !== CRAWLER_CONFIG_VERSION) throw new Error(`schemaVersion must be ${CRAWLER_CONFIG_VERSION}`);
  if (typeof config.databasePath !== 'string' || !config.databasePath.trim()) throw new Error('databasePath is required');
  if (!config.sources || typeof config.sources !== 'object' || Array.isArray(config.sources)) throw new Error('sources configuration is required');
  for (const section of ['atsWarm', 'atsBatch1', 'atsBatch2', 'enterprise']) {
    if (config.sources[section] && !Array.isArray(config.sources[section].boards)) throw new Error(`sources.${section}.boards must be an array`);
  }
  if (config.sources.careerSites && !Array.isArray(config.sources.careerSites)) throw new Error('sources.careerSites must be an array');
  validateTheirStackConfig(config.sources.theirstack);
  return config;
}

export function loadCrawlerConfig(file = 'config/crawler-v2.json') {
  const resolved = path.resolve(file);
  const config = validateCrawlerConfig(JSON.parse(fs.readFileSync(resolved, 'utf8')));
  return { config: withRegistryProjectedBoards(config), path: resolved };
}

function requestAbortSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timeout = Number(timeoutMs);
  let timer = null;
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener?.('abort', abortFromCaller, { once: true });
  if (Number.isFinite(timeout) && timeout > 0) {
    timer = setTimeout(() => {
      const error = new Error('request timed out');
      error.code = 'ETIMEDOUT';
      controller.abort(error);
    }, timeout);
  }
  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', abortFromCaller);
    },
  };
}

export async function defaultHttpTransport(url, options = {}) {
  const abort = requestAbortSignal(options.signal, options.timeoutMs ?? 10000);
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: abort.signal,
    });
    return { status: response.status, headers: response.headers, body: await response.text() };
  } finally {
    abort.cleanup();
  }
}

function sourcePlan(id, lane, provider, fetcher, metadata = {}) {
  return { id, lane, provider, trustClass: 'direct', ...metadata, fetch: fetcher };
}

function resolverSettings(config) {
  const configured = config?.originalListingResolver
    ?? config?.sources?.originalListingResolver
    ?? config?.sources?.resolver
    ?? {};
  const settings = {};
  if (configured.maxRedirects != null) settings.maxRedirects = configured.maxRedirects;
  if (configured.maxBytes != null) settings.maxBytes = configured.maxBytes;
  return settings;
}

/**
 * Shared SearXNG search transport: wraps the base HTTP transport into the
 * `(query) => { status, body: { results, unresponsive_engines? } }` shape every
 * search-based discovery function (discoverBraveSearch, discoverYcJobs) expects.
 * Preserves unresponsive_engines so zero-result engine degradation is distinct
 * from a healthy empty market.
 */
function searxngTransport(endpoint, baseTransport) {
  return async (query) => {
    const url = new URL('/search', endpoint);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    const response = await baseTransport(url.toString(), { headers: { Accept: 'application/json' } });
    const body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
    const payload = { results: body?.results ?? [] };
    if (Array.isArray(body?.unresponsive_engines)) payload.unresponsive_engines = body.unresponsive_engines;
    return { ...response, body: payload };
  };
}

/**
 * Merges configured india-startup requests with VC watchlist seeds and
 * dimension-generated Brave queries (ATS domain / role family / geography /
 * entry-level / startup) so the lane always carries the full dimension set.
 */
export function buildIndiaStartupLaneRequests(sources = {}) {
  const india = sources.indiaStartup ?? {};
  const configured = Array.isArray(india.requests) ? india.requests.map((request) => ({ ...request })) : [];
  const watchlistPath = india.watchlist
    ?? sources.startup?.vcPortfolioWatchlistPath
    ?? 'config/vc-portfolio-watchlist.json';
  let watchlistRequests = [];
  try {
    const watchlist = loadVcPortfolioWatchlist(watchlistPath);
    watchlistRequests = buildVcWatchlistRequests(watchlist, {
      limit: india.vcPortfolioLimit ?? sources.startup?.vcPortfolioLimit ?? 20,
    });
  } catch {
    watchlistRequests = [];
  }
  const budget = Math.max(0, Number(india.queryBudget ?? india.dailyBudget ?? 20));
  const dimensionCap = Math.min(budget, Math.max(0, Number(india.dimensionQueryBudget ?? 8)));
  const dimensionQueries = buildBraveQueries({
    roles: india.roles ?? DEFAULT_BRAVE_DIMENSIONS.roles,
    geographies: india.geographies ?? DEFAULT_BRAVE_DIMENSIONS.geographies,
    experiences: india.experiences ?? DEFAULT_BRAVE_DIMENSIONS.experiences,
    ats: india.ats ?? DEFAULT_BRAVE_DIMENSIONS.ats,
    career: india.career ?? DEFAULT_BRAVE_DIMENSIONS.career,
    startup: india.startup ?? DEFAULT_BRAVE_DIMENSIONS.startup,
    vc: india.vc ?? DEFAULT_BRAVE_DIMENSIONS.vc,
    maxQueries: dimensionCap,
  });
  const dimensionRequests = dimensionQueries.map((query) => ({ id: 'ats-search', query }));
  const seen = new Set();
  const take = (requests, limit) => {
    const out = [];
    for (const request of requests) {
      if (out.length >= limit) break;
      const query = typeof request?.query === 'string' ? request.query.trim() : '';
      if (!query) continue;
      const key = query.toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: request.id || 'ats-search', query, evidence: request.evidence });
    }
    return out;
  };
  // Reserve dimension coverage (ATS/role/geo/entry-level) so VC watchlist volume
  // cannot crowd out the provider-specific Brave query matrix.
  const dimensions = take(dimensionRequests, dimensionCap);
  const remainder = take([...configured, ...watchlistRequests], Math.max(0, budget - dimensions.length));
  return [...dimensions, ...remainder].slice(0, budget);
}

function verificationResolution(observation, error) {
  const discoveryUrl = observation?.discoveryUrl ?? observation?.canonicalUrl ?? observation?.url ?? null;
  return {
    status: 'verification',
    discoveryUrl,
    originalApplicationUrl: null,
    applicationResolution: { status: 'Needs Verification', evidence: null },
    evidence: {
      resolver: ORIGINAL_LISTING_RESOLVER_VERSION,
      resolution: { status: 'verification', reason: 'resolver-error' },
      error: error?.message || 'resolver-error',
    },
  };
}

/** Build the one resolver shared by all resolver-capable sources in a run. */
export function createCrawlerRunResolver({ config, transport, runAt }) {
  const resolver = createOriginalListingResolver({
    transport,
    runAt,
    ...resolverSettings(config),
  });

  return async (observation = {}) => {
    const discoveryUrl = observation.discoveryUrl ?? observation.canonicalUrl ?? observation.url ?? null;
    try {
      // The connector hook copies the observation after resolving. Keep the
      // discovery URL on that object as well as in the resolver result.
      if (discoveryUrl && !observation.discoveryUrl) observation.discoveryUrl = discoveryUrl;
      const resolution = await resolver({ ...observation, discoveryUrl });
      return resolution && typeof resolution === 'object'
        ? { ...resolution, discoveryUrl: resolution.discoveryUrl ?? discoveryUrl }
        : resolution;
    } catch (error) {
      return verificationResolution({ ...observation, discoveryUrl }, error);
    }
  };
}

async function readConnectorInbox({ inboxDir, runAt, resolver }) {
  const root = path.resolve(inboxDir);
  if (!fs.existsSync(root)) return { observations: [], manifest: { status: 'unavailable', reason: 'inbox-missing', fetched: 0 } };
  const receiptDir = path.join(root, '.receipts');
  fs.mkdirSync(receiptDir, { recursive: true });
  const observations = [];
  const receipts = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith('.json')).sort()) {
    const file = path.join(root, entry.name);
    const raw = fs.readFileSync(file);
    const digest = createHash('sha256').update(raw).digest('hex');
    const receipt = path.join(receiptDir, `${digest}.json`);
    if (fs.existsSync(receipt)) { receipts.push({ file, status: 'duplicate' }); continue; }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); }
    catch (error) { receipts.push({ file, status: 'quarantined', error: error.message }); continue; }
    const imported = normalizeConnectorEnvelope(payload, { runAt });
    for (const observation of imported.observations) {
      const resolved = typeof resolver === 'function' ? await resolver(observation) : null;
      if (resolved) {
        const { applyOriginalListingResolution } = await import('./original-listing-resolver.mjs');
        observations.push(applyOriginalListingResolution(observation, resolved));
      } else observations.push(observation);
    }
    fs.writeFileSync(receipt, JSON.stringify({ file, digest, imported: imported.observations.length, quarantined: imported.quarantine.length, importedAt: runAt }) + '\n', { flag: 'wx' });
    receipts.push({ file, status: 'imported', imported: imported.observations.length, quarantined: imported.quarantine.length });
  }
  return { observations, manifest: { status: 'succeeded', fetched: observations.length, receipts, noAutoApply: true } };
}

export function buildSourcePlans({ config, transport, runAt, clock, schedule, resolver, profile, signal = null, deadline = null }) {
  // Project boards from the unified registry when configured; tests that inject
  // inline sources.*.boards without boardRegistryPath keep their fixtures.
  const projected = withRegistryProjectedBoards(config);
  const sources = projected.sources;
  const plans = [];
  if (sources.atsWarm?.boards?.length) plans.push(sourcePlan('ats-warm', 'ats-warm', 'ats-warm', async () =>
    fetchWarmAts({ ...sources.atsWarm, boards: sources.atsWarm.boards, transport, runAt, signal, deadline })));
  if (sources.atsBatch1?.boards?.length) plans.push(sourcePlan('ats-batch-1', 'ats-expanded', 'ats-batch-1', async ({ cursor }) => {
    const result = await fetchAtsBatch1({ ...sources.atsBatch1, boards: sources.atsBatch1.boards, transport, runAt, cursorState: cursor?.cursorState, conditionalState: cursor?.conditionalState });
    return { ...result, cursor: { cursorState: result.cursorState, conditionalState: result.conditionalState } };
  }, { capabilities: { newestFirst: true, paginated: true } }));
  if (schedule !== 'midday' && sources.atsBatch2?.boards?.length) plans.push(sourcePlan('ats-batch-2', 'ats-expanded', 'ats-batch-2', async ({ cursor }) => {
    const result = await discoverAtsBatch2({ ...sources.atsBatch2, boards: sources.atsBatch2.boards, transport, runAt, state: cursor ?? {} });
    return { ...result, cursor: Object.fromEntries(result.results.map((entry, index) => [sources.atsBatch2.boards[index]?.slug || sources.atsBatch2.boards[index]?.company, entry.conditionalState])) };
  }, { capabilities: { newestFirst: true, completeArray: true } }));
  if (schedule !== 'midday' && sources.enterprise?.boards?.length) plans.push(sourcePlan('ats-enterprise', 'ats-expanded', 'ats-enterprise', async ({ cursor }) => {
    const result = await discoverEnterpriseAts({ ...sources.enterprise, boards: sources.enterprise.boards, transport, runAt, conditionalState: cursor ?? {} });
    return { ...result, cursor: result.conditionalState };
  }, { capabilities: { newestFirst: true, paginated: true } }));
  if (sources.indeed?.enabled) plans.push(sourcePlan('indeed-inbox', 'connector-imports', 'indeed', async () => importIndeedInbox({
    ...sources.indeed,
    date: sources.indeed.date ?? runAt.slice(0, 10),
    clock,
    resolver,
  }), { capabilities: { resolver: typeof resolver === 'function', discoveryUrl: true } }));
  if (sources.connectorInbox?.enabled) plans.push(sourcePlan('connector-inbox', 'connector-imports', 'connector-inbox', async () => readConnectorInbox({ inboxDir: sources.connectorInbox.inboxDir, runAt, resolver }), { capabilities: { resolver: typeof resolver === 'function', providers: [...CONNECTOR_PROVIDERS] } }));
  if (schedule !== 'midday' && profile?.mode === 'normal' && sources.theirstack?.enabled) {
    plans.push(sourcePlan('theirstack', 'connector-imports', 'theirstack', async ({ cursor } = {}) => {
      const theirStackConfig = sources.theirstack;
      const apiKey = process.env[theirStackConfig.apiKeyEnv ?? 'THEIRSTACK_API_KEY'];
      return discoverTheirStack({
        ...theirStackConfig,
        queries: theirStackConfig.queries.map((query) => query.filters),
        apiKey,
        transport,
        runAt,
        cursor,
      });
    }, {
      trustClass: 'aggregator',
      capabilities: {
        newestFirst: true,
        paginated: true,
        discoveryUrl: true,
        creditsMetered: true,
      },
    }));
  }
  if (profile?.mode === 'startup' && schedule !== 'midday') plans.push(sourcePlan('startup-mode', 'startup-sources', 'startup', async () => {
    const sourceFunctions = {};
    // yc and vc-portfolio-boards both need a search transport and an original-listing
    // resolver; without both, honestly leave them unavailable rather than fabricate.
    if (sources.searxng?.enabled && sources.searxng.endpoint && typeof resolver === 'function') {
      const searxTransport = searxngTransport(sources.searxng.endpoint, transport);
      const ycQueries = (sources.searxng.queries ?? []).filter((query) => /ycombinator\.com\/jobs/i.test(query));
      if (ycQueries.length) {
        sourceFunctions.yc = async () => {
          const result = await discoverYcJobs({
            transport: searxTransport,
            queries: ycQueries,
            resolveOriginalListing: resolver,
            runAt,
            perQueryResultCap: sources.searxng.perQueryResultCap,
          });
          return { candidates: result.observations, manifest: { status: 'ok', ...result.manifest } };
        };
      }
      sourceFunctions['vc-portfolio-boards'] = async () => {
        const watchlist = loadVcPortfolioWatchlist(sources.startup?.vcPortfolioWatchlistPath ?? 'config/vc-portfolio-watchlist.json');
        const requests = buildVcWatchlistRequests(watchlist, { limit: sources.startup?.vcPortfolioLimit ?? 20 });
        if (!requests.length) return { candidates: [], manifest: { status: 'empty', fetched: 0 } };
        const result = await discoverBraveSearch({
          transport: searxTransport,
          provider: 'searxng',
          queries: requests.map((request) => request.query),
          dailyBudget: requests.length,
          perQueryResultCap: sources.searxng.perQueryResultCap,
          resolveOriginalListing: resolver,
          runAt,
        });
        return { candidates: result.observations, manifest: { status: 'ok', ...result.manifest } };
      };
    }
    const outputs = await runStartupSourcePlan({ sourceFixtures: sources.startup?.fixtures ?? {}, sourceFunctions, laneInputs: sources.startup?.laneInputs ?? {}, runAt, runId: profile.mode });
    return { observations: outputs.flatMap((item) => item.candidates || []), manifest: { fetched: outputs.reduce((n, item) => n + (item.candidates?.length || 0), 0), changed: outputs.length, telemetry: { mode: 'startup', lanes: outputs.map((item) => item.manifest) } } };
  }));
  // Morning Remote can run configured native feeds. Midday Remote is a cheap
  // selector over the shared ATS/delta inventory and must not start them.
  // Scheduled Normal also runs native feeds when the config enables the lane.
  // Startup mode never inherits remote lanes.
  const explicitRemoteMode = profile?.mode === 'remote' && schedule !== 'midday';
  const scheduledRemoteEnabled = sources.remote?.enabled === true
    && profile?.mode === 'normal'
    && schedule !== 'midday';
  if (explicitRemoteMode || scheduledRemoteEnabled) plans.push(sourcePlan('remote-mode', 'remote-sources', 'remote', async () => {
    const remoteConfig = sources.remote ?? {};
    const forceAll = explicitRemoteMode;
    const activeProviders = selectRemoteProviders({ remoteConfig, runAt, forceAll });
    const fetchJson = async (url, options) => { const response = await transport(url, options); const body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body; return body; };
    const fetchText = async (url, options) => { const response = await transport(url, options); return response.body; };
    const providerFetchers = {};
    for (const provider of activeProviders) {
      providerFetchers[provider] = provider === 'weworkremotely' ? { fetchText } : { fetchJson };
    }
    const outputs = await runRemoteSourcePlan({ providerFetchers, runAt, runId: profile?.mode || 'normal' });
    const primarySet = new Set(remoteConfig.primaryProviders ?? ['himalayas']);
    const maxPrimary = Math.max(1, Number(remoteConfig.maxRecordsPrimary ?? 40));
    const maxSecondary = Math.max(1, Number(remoteConfig.maxRecordsPerSecondary ?? remoteConfig.maxRecordsPerProvider ?? 25));
    const observations = [];
    const verificationQueue = [];
    for (const item of outputs) {
      const laneId = item.manifest?.sourceId || item.manifest?.provider;
      const cap = primarySet.has(laneId) ? maxPrimary : maxSecondary;
      const candidates = (item.candidates || []).slice(0, cap);
      for (const candidate of candidates) {
        const alreadyResolved = ['Direct ATS', 'Resolved Original'].includes(candidate.applicationResolution?.status)
          && candidate.originalApplicationUrl;
        if (typeof resolver === 'function' && !alreadyResolved) {
          let resolution;
          try { resolution = await resolver(candidate); }
          catch (error) { resolution = verificationResolution(candidate, error); }
          const resolved = applyOriginalListingResolution(candidate, resolution);
          if (resolved.classification !== 'direct' || !resolved.originalApplicationUrl) {
            verificationQueue.push({
              url: candidate.discoveryUrl || candidate.canonicalUrl,
              company: candidate.company,
              reason: 'original-listing',
              evidence: resolved.evidence,
            });
          }
          observations.push(resolved);
        } else {
          observations.push(candidate);
        }
      }
    }
    return {
      observations,
      verificationQueue,
      manifest: {
        fetched: observations.length,
        changed: observations.length,
        noAutoApply: true,
        writesPlanned: false,
        telemetry: {
          mode: forceAll ? 'remote' : 'scheduled-remote',
          activeProviders,
          lanes: outputs.map((item) => item.manifest),
        },
      },
    };
  }));
  if (schedule !== 'midday' && sources.indiaStartup?.enabled) plans.push(sourcePlan('india-startup', 'brave-startup', 'india-startup', async () => {
    // discoverIndiaStartupLanes calls transport(request, meta) with a {source, kind, query, url}
    // object, not transport(url, options) like every other lane — every configured request here
    // is kind:'search' (see INDIA_STARTUP_LANES), so route it through the same SearXNG query
    // transport the startup/searxng lanes already use. Without SearXNG configured, leave the lane
    // unavailable rather than fabricate results.
    if (!sources.searxng?.enabled || !sources.searxng.endpoint) {
      return { observations: [], verificationQueue: [], manifest: { schemaVersion: 'IndiaStartupLanesManifestV1', runAt, sources: [], telemetry: { unavailable: 'searxng-not-configured' }, noAutoApply: true }, telemetry: {} };
    }
    const searxTransport = searxngTransport(sources.searxng.endpoint, transport);
    const requests = buildIndiaStartupLaneRequests(sources);
    return discoverIndiaStartupLanes({
      ...sources.indiaStartup,
      requests,
      transport: async (request) => searxTransport(request.query),
      runAt,
    });
  }));
  if (schedule !== 'midday' && sources.searxng?.enabled) plans.push(sourcePlan('searxng-search', 'web-discovery', 'searxng', async () => {
    if (!sources.searxng.endpoint) throw new Error('SearXNG is enabled but endpoint is unavailable');
    return discoverBraveSearch({
      ...sources.searxng,
      provider: 'searxng',
      transport: searxngTransport(sources.searxng.endpoint, transport),
      resolveOriginalListing: resolver,
      runAt,
      country: sources.searxng.country ?? 'IN',
    });
  }, { capabilities: { resolver: typeof resolver === 'function', discoveryUrl: true } }));
  return plans;
}

/**
 * Direct Brave lane query materialization. Empty `queries: []` expands from the
 * role / ATS / geography / entry-level / startup / VC dimensions so the workflow
 * `brave-search` plan is not a no-op when the lane is enabled.
 */
export function listBraveQueries(braveConfig = {}) {
  const configured = Array.isArray(braveConfig.queries)
    ? braveConfig.queries.map((query) => (typeof query === 'string' ? query.trim() : '')).filter(Boolean)
    : [];
  if (configured.length) return configured;
  return buildBraveQueries({
    ...braveConfig,
    roles: braveConfig.roles ?? DEFAULT_BRAVE_DIMENSIONS.roles,
    geographies: braveConfig.geographies ?? DEFAULT_BRAVE_DIMENSIONS.geographies,
    experiences: braveConfig.experiences ?? DEFAULT_BRAVE_DIMENSIONS.experiences,
    ats: braveConfig.ats ?? DEFAULT_BRAVE_DIMENSIONS.ats,
    career: braveConfig.career ?? DEFAULT_BRAVE_DIMENSIONS.career,
    startup: braveConfig.startup ?? DEFAULT_BRAVE_DIMENSIONS.startup,
    vc: braveConfig.vc ?? DEFAULT_BRAVE_DIMENSIONS.vc,
    maxQueries: braveConfig.maxQueries ?? braveConfig.dailyBudget ?? 20,
  });
}

function braveTransportFor(config, transport) {
  if (!config.sources.brave?.enabled) return null;
  const key = process.env[config.sources.brave.apiKeyEnv ?? 'BRAVE_SEARCH_API_KEY'];
  if (!key) throw new Error(`Brave is enabled but ${config.sources.brave.apiKeyEnv ?? 'BRAVE_SEARCH_API_KEY'} is unavailable`);
  const country = config.sources.brave.country ?? 'IN';
  const searchLang = config.sources.brave.searchLang ?? 'en';
  return async (query, meta = {}) => {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(config.sources.brave.perQueryResultCap ?? 10));
    url.searchParams.set('country', meta.country ?? country);
    url.searchParams.set('search_lang', searchLang);
    if (meta.offset != null) url.searchParams.set('offset', String(meta.offset));
    return transport(url.toString(), { headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
  };
}

export function crawlerSchedulePlan(config, schedule = 'morning') {
  const plans = buildSchedulePlans(config.schedule);
  if (!plans[schedule]) throw new Error(`unknown crawler schedule: ${schedule}`);
  return plans[schedule];
}

export function crawlerDiscoveryPlan(config, { schedule = 'morning', mode = 'normal', locationPreset = 'india' } = {}) {
  const profile = buildDiscoveryProfile({ schedule, mode, locationPreset });
  return { ...crawlerSchedulePlan(config, schedule), profile };
}

export async function runCrawlerOperator({
  config,
  runId,
  schedule = 'morning',
  mode = 'normal',
  locationPreset = 'india',
  transport = defaultHttpTransport,
  clock = {},
  store: suppliedStore = null,
  signal = null,
  deadline = null,
} = {}) {
  validateCrawlerConfig(config);
  crawlerSchedulePlan(config, schedule);
  const profile = buildDiscoveryProfile({ mode, locationPreset, schedule });
  const nowValue = typeof clock.now === 'function' ? clock.now() : new Date().toISOString();
  const runAt = nowValue instanceof Date ? nowValue.toISOString() : String(nowValue);
  const resolver = createCrawlerRunResolver({ config, transport, runAt });
  const databasePath = path.resolve(config.databasePath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const store = suppliedStore ?? openCrawlerStore(databasePath);
  try {
    const policy = loadJobPullPolicy();
    const lifecycleRows = readOpportunityLedger(config.opportunityLedgerPath).rows;
    const v4Snapshot = readV4HistorySnapshot(config.v4HistorySnapshotPath, {
      maxAgeDays: config.v4HistorySnapshotMaxAgeDays,
      now: runAt,
    });
    const historicalRows = v4Snapshot.rows;
    const prepareEntry = (candidate) => {
      const eligibility = classifyCandidate(candidate, policy);
      const freshness = classifyFreshness(candidate, { now: runAt, ...policy.freshness });
      const readiness = applicationReadiness(candidate, eligibility);
      return {
        candidate: { ...candidate, applicationReady: readiness.ready, readiness },
        eligibility,
        freshness,
      };
    };
    let result = await crawlWorkflow({
      store,
      runId: runId ?? `${schedule}-${runAt.replace(/[:.]/g, '-')}`,
      schedule,
      config: { ...config, discoveryProfile: profile },
      clock,
      priorLifecycleRows: lifecycleRows,
      historicalRows,
      v4Snapshot,
      sourcePlans: buildSourcePlans({ config, transport, runAt, clock, schedule, resolver, profile, signal, deadline }),
      careerSites: config.sources.careerSites ?? [],
      careerOptions: config.sources.careerOptions ?? {},
      careerTransport: (config.sources.careerSites ?? []).length
        ? createChromiumFallbackTransport({ baseTransport: transport, ...(config.sources.chromium ?? {}) })
        : undefined,
      brave: schedule !== 'midday' && config.sources.brave?.enabled
        ? { ...config.sources.brave, queries: listBraveQueries(config.sources.brave) }
        : null,
      braveOptions: {
        ...(config.sources.brave ?? {}),
        country: config.sources.brave?.country ?? 'IN',
        resolveOriginalListing: resolver,
      },
      braveTransport: schedule !== 'midday' ? braveTransportFor(config, transport) : null,
      prepareEntry,
      signal,
      deadline,
    });
    const commercialConfig = config.sources.commercialRescue ?? {};
    if (commercialConfig.enabled) {
      if (!commercialConfig.recordsFile) throw new Error('commercial rescue is enabled but recordsFile is not configured');
      const commercial = await runCommercialRescue({
        ...commercialConfig,
        enabled: true,
        freeLanesComplete: true,
        verifiedReserve: result.reserve.length,
        now: runAt,
        source: {
          id: 'commercial-records-file',
          supportsAgencyExclusion: true,
          async fetch() {
            const payload = JSON.parse(fs.readFileSync(path.resolve(commercialConfig.recordsFile), 'utf8'));
            return { records: Array.isArray(payload) ? payload : payload.records ?? [], costUsd: Number(payload.costUsd ?? 0) };
          },
        },
      });
      if (commercial.invoked && commercial.records.length) {
        const rescueWorkflow = await crawlWorkflow({
          store,
          runId: `${result.run.runId}-commercial`,
          schedule: `${schedule}-commercial-rescue`,
          config: { ...config, discoveryProfile: profile },
          clock,
          priorLifecycleRows: lifecycleRows,
          historicalRows,
          v4Snapshot,
          sourcePlans: [sourcePlan('commercial-rescue', 'commercial-rescue', 'commercial-rescue', async () => ({
            observations: commercial.records.map((record) => normalizeCandidate({
              ...record,
              provider: record.provider ?? 'commercial-rescue',
              source: record.source ?? commercialConfig.recordsFile,
              sourceKind: record.sourceKind ?? 'aggregator',
              classification: record.classification ?? 'direct',
              discoveredAt: record.discoveredAt ?? runAt,
              crawledAt: record.crawledAt ?? runAt,
            }, { runAt })),
            manifest: { fetched: commercial.records.length, changed: commercial.records.length, telemetry: commercial.telemetry },
          }))],
          prepareEntry,
        });
        const combined = selectDailyReserve([...result.reserve, ...rescueWorkflow.reserve]);
        result = {
          ...result,
          observations: [...result.observations, ...rescueWorkflow.observations],
          jobs: rescueWorkflow.jobs,
          reserve: combined.reserve,
          shortlist: combined.shortlist,
          shortfall: combined.shortfall,
          sourceTelemetry: { ...result.sourceTelemetry, ...rescueWorkflow.sourceTelemetry },
          failures: [...result.failures, ...rescueWorkflow.failures],
          plannedDownstreamHandoff: {
            ...result.plannedDownstreamHandoff,
            shortlist: combined.shortlist.map((item) => ({ jobKey: item.identity?.identity?.jobKey ?? item.candidate?.canonicalUrl, candidate: item.candidate })),
            reserveQueue: combined.reserveQueue.map((item) => ({ jobKey: item.identity?.identity?.jobKey ?? item.candidate?.canonicalUrl, candidate: item.candidate })),
          },
        };
      }
      result.commercialRescue = commercial;
    } else {
      result.commercialRescue = { invoked: false, status: 'disabled', records: [] };
    }
    return {
      ...result,
      v4Snapshot: result.v4Snapshot ?? {
        status: v4Snapshot.status,
        path: v4Snapshot.path,
        generatedAt: v4Snapshot.generatedAt,
        rowCount: v4Snapshot.rowCount,
        error: v4Snapshot.error ?? null,
      },
      profile,
      operator: { databasePath, schedule, configVersion: config.schemaVersion, profile },
    };
  } finally {
    if (!suppliedStore) store.close();
  }
}
