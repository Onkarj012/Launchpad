import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fetchAtsBatch1 } from './ats-batch-1.mjs';
import { fetchWarmAts } from './ats-warm.mjs';
import { discoverBraveSearch } from './brave-search.mjs';
import { createChromiumFallbackTransport } from './chromium-fallback.mjs';
import { discoverAtsBatch2 } from './ats-batch-2.mjs';
import { discoverEnterpriseAts } from './ats-enterprise.mjs';
import { importIndeedInbox } from './indeed-inbox.mjs';
import {
  ORIGINAL_LISTING_RESOLVER_VERSION,
  createOriginalListingResolver,
} from './original-listing-resolver.mjs';
import { discoverIndiaStartupLanes } from './india-startup-lanes.mjs';
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
import { runRemoteSourcePlan } from '../job-pull/remote-sources.mjs';
import { buildDiscoveryProfile } from './discovery-profile.mjs';
import {
  normalizeConnectorEnvelope,
} from './connector-inbox.mjs';

export const CRAWLER_CONFIG_VERSION = 'LaunchpadCrawlerConfigV1';

export function buildCrawlerHelp() {
  return `Launchpad Crawler v2

Usage:
  node crawler/cli.mjs validate [--config FILE]
  node crawler/cli.mjs plan [morning|midday] [--mode normal|startup|remote] [--location-preset india|pune] [--config FILE]
  node crawler/cli.mjs run [morning|midday] [--mode normal|startup|remote] [--location-preset india|pune] [--config FILE] [--run-id ID]
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
  return config;
}

export function loadCrawlerConfig(file = 'config/crawler-v2.json') {
  const resolved = path.resolve(file);
  return { config: validateCrawlerConfig(JSON.parse(fs.readFileSync(resolved, 'utf8'))), path: resolved };
}

export async function defaultHttpTransport(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 10000);
  const timeoutSignal = typeof AbortSignal?.timeout === 'function'
    ? AbortSignal.timeout(Math.max(1, timeoutMs))
    : undefined;
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
    signal: options.signal ?? timeoutSignal,
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
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

/** Shared SearXNG search transport: wraps the base HTTP transport into the `(query) => { status, body: { results } }` shape every search-based discovery function (discoverBraveSearch, discoverYcJobs) expects. */
function searxngTransport(endpoint, baseTransport) {
  return async (query) => {
    const url = new URL('/search', endpoint);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    const response = await baseTransport(url.toString(), { headers: { Accept: 'application/json' } });
    const body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
    return { ...response, body: { results: body?.results ?? [] } };
  };
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

export function buildSourcePlans({ config, transport, runAt, clock, schedule, resolver, profile }) {
  const sources = config.sources;
  const plans = [];
  if (sources.atsWarm?.boards?.length) plans.push(sourcePlan('ats-warm', 'ats-warm', 'ats-warm', async () =>
    fetchWarmAts({ ...sources.atsWarm, boards: sources.atsWarm.boards, transport, runAt })));
  if (sources.atsBatch1?.boards?.length) plans.push(sourcePlan('ats-batch-1', 'ats-expanded', 'ats-batch-1', async ({ cursor }) => {
    const result = await fetchAtsBatch1({ ...sources.atsBatch1, boards: sources.atsBatch1.boards, transport, runAt, cursorState: cursor?.cursorState, conditionalState: cursor?.conditionalState });
    return { ...result, cursor: { cursorState: result.cursorState, conditionalState: result.conditionalState } };
  }));
  if (schedule !== 'midday' && sources.atsBatch2?.boards?.length) plans.push(sourcePlan('ats-batch-2', 'ats-expanded', 'ats-batch-2', async ({ cursor }) => {
    const result = await discoverAtsBatch2({ ...sources.atsBatch2, boards: sources.atsBatch2.boards, transport, runAt, state: cursor ?? {} });
    return { ...result, cursor: Object.fromEntries(result.results.map((entry) => [entry.manifest.sourceId, entry.conditionalState])) };
  }));
  if (schedule !== 'midday' && sources.enterprise?.boards?.length) plans.push(sourcePlan('ats-enterprise', 'ats-expanded', 'ats-enterprise', async ({ cursor }) => {
    const result = await discoverEnterpriseAts({ ...sources.enterprise, boards: sources.enterprise.boards, transport, runAt, conditionalState: cursor ?? {} });
    return { ...result, cursor: result.conditionalState };
  }));
  if (sources.indeed?.enabled) plans.push(sourcePlan('indeed-inbox', 'connector-imports', 'indeed', async () => importIndeedInbox({
    ...sources.indeed,
    date: sources.indeed.date ?? runAt.slice(0, 10),
    clock,
    resolver,
  }), { capabilities: { resolver: typeof resolver === 'function', discoveryUrl: true } }));
  if (sources.connectorInbox?.enabled) plans.push(sourcePlan('connector-inbox', 'connector-imports', 'connector-inbox', async () => readConnectorInbox({ inboxDir: sources.connectorInbox.inboxDir, runAt, resolver }), { capabilities: { resolver: typeof resolver === 'function', providers: ['indeed', 'apna', 'whatjobs'] } }));
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
  if (profile?.mode === 'remote') plans.push(sourcePlan('remote-mode', 'remote-sources', 'remote', async () => {
    const fetchJson = async (url, options) => { const response = await transport(url, options); const body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body; return body; };
    const fetchText = async (url, options) => { const response = await transport(url, options); return response.body; };
    const providerFetchers = {
      ...Object.fromEntries(['himalayas', 'jobicy', 'remotive'].map((provider) => [provider, { fetchJson }])),
      weworkremotely: { fetchText },
    };
    const outputs = await runRemoteSourcePlan({ providerFetchers, runAt, runId: profile.mode });
    return { observations: outputs.flatMap((item) => item.candidates || []), manifest: { fetched: outputs.reduce((n, item) => n + (item.candidates?.length || 0), 0), changed: outputs.length, telemetry: { mode: 'remote', lanes: outputs.map((item) => item.manifest) } } };
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
    return discoverIndiaStartupLanes({
      ...sources.indiaStartup,
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
    });
  }, { capabilities: { resolver: typeof resolver === 'function', discoveryUrl: true } }));
  return plans;
}

function braveTransportFor(config, transport) {
  if (!config.sources.brave?.enabled) return null;
  const key = process.env[config.sources.brave.apiKeyEnv ?? 'BRAVE_SEARCH_API_KEY'];
  if (!key) throw new Error(`Brave is enabled but ${config.sources.brave.apiKeyEnv ?? 'BRAVE_SEARCH_API_KEY'} is unavailable`);
  return async (query) => {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(config.sources.brave.perQueryResultCap ?? 10));
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
} = {}) {
  validateCrawlerConfig(config);
  crawlerSchedulePlan(config, schedule);
  const profile = buildDiscoveryProfile({ mode, locationPreset, schedule });
  const nowValue = typeof clock.now === 'function' ? clock.now() : new Date().toISOString();
  const runAt = nowValue instanceof Date ? nowValue.toISOString() : String(nowValue);
  const resolver = createCrawlerRunResolver({ config, transport, runAt });
  const databasePath = path.resolve(config.databasePath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const store = openCrawlerStore(databasePath);
  try {
    const policy = loadJobPullPolicy();
    const lifecycleRows = readOpportunityLedger(config.opportunityLedgerPath).rows;
    const historicalRows = readV4HistorySnapshot(config.v4HistorySnapshotPath).rows;
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
      sourcePlans: buildSourcePlans({ config, transport, runAt, clock, schedule, resolver, profile }),
      careerSites: config.sources.careerSites ?? [],
      careerOptions: config.sources.careerOptions ?? {},
      careerTransport: (config.sources.careerSites ?? []).length
        ? createChromiumFallbackTransport({ baseTransport: transport, ...(config.sources.chromium ?? {}) })
        : undefined,
      brave: schedule !== 'midday' && config.sources.brave?.enabled ? config.sources.brave : null,
      braveOptions: config.sources.brave ?? {},
      braveTransport: schedule !== 'midday' ? braveTransportFor(config, transport) : null,
      prepareEntry,
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
    return { ...result, profile, operator: { databasePath, schedule, configVersion: config.schemaVersion, profile } };
  } finally {
    store.close();
  }
}
