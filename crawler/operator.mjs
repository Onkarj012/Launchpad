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
import { discoverCompanyCareers } from './company-careers.mjs';
import { discoverCareerPages } from './career-page-discovery.mjs';
import { discoverTheirStack } from './theirstack.mjs';
import { discoverYcJobs } from './yc-discovery.mjs';
import { discoverHnJobs } from './hn-discovery.mjs';
import { isSourceTrialActive } from './source-yield.mjs';
import { buildVcWatchlistRequests, loadVcPortfolioWatchlist } from './vc-portfolio-watchlist.mjs';
import { runCommercialRescue } from './commercial-rescue.mjs';
import { openCrawlerStore } from './run.mjs';
import { selectDailyReserve } from './reserve.mjs';
import { buildSchedulePlans } from './schedules.mjs';
import { crawlWorkflow } from './workflow.mjs';
import { classifyCandidate } from '../job-pull/eligibility.mjs';
import { linkedInPublicJobId } from '../job-pull/portal-adapters/linkedin.mjs';
import { createLinkedInGuestPolicy } from './linkedin-guest-policy.mjs';
import { classifyFreshness } from '../job-pull/freshness.mjs';
import { loadConfig as loadJobPullPolicy } from '../job-pull/config.mjs';
import { applicationReadiness } from '../job-pull/normal-readiness.mjs';
import { readOpportunityLedger } from '../job-pull/opportunity-ledger.mjs';
import { readV4HistorySnapshot } from './v4-history-snapshot.mjs';
import { normalizeCandidate } from '../job-pull/candidate.mjs';
import { runStartupSourcePlan } from '../job-pull/startup-sources.mjs';
import { runRemoteSourcePlan, selectRemoteProviders } from '../job-pull/remote-sources.mjs';
import { PORTAL_SOURCE_LANES, runPortalSourcePlan } from '../job-pull/normal-sources.mjs';
import { createRenderedFetcher } from './browser-transport.mjs';
import { createHostSerializedRunner, mapProviderSafe } from './bounded-concurrency.mjs';
import { buildDiscoveryProfile } from './discovery-profile.mjs';
import {
  CONNECTOR_PROVIDERS,
  normalizeConnectorEnvelope,
  parseHiringPostInbox,
} from './connector-inbox.mjs';
import {
  planBoundedSources,
  boardIdentityKey,
  boardPauseReason,
  PROVIDER_LANES,
  recordBoardProbeResponse,
  registryProbeUrl,
  withRegistryProjectedBoards,
} from './board-registry.mjs';
import { dailyRunIdentity } from './scheduler.mjs';
import {
  normalizeExecutionBudget,
  remainingDeadlineMs,
  requestWithDeadline,
  throwIfNetworkWorkDisallowed,
  validateExecutionBudget,
} from './deadline.mjs';

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
  node crawler/cli.mjs daily [morning] [--config FILE] [--env production|live-test|dev] [--run-id ID] [--scores-json FILE] [--no-scorer] [--execute-writes --credential-file FILE --journal FILE]
  node crawler/cli.mjs audit-v5-journal --credential-file ABS_PATH --journal ABS_PATH --receipt ABS_PATH
  node crawler/cli.mjs readiness [--run-tests] [--operational-evidence FILE]
  node crawler/cli.mjs trial-yield --trial-start YYYY-MM-DD --runs FILE
  node crawler/cli.mjs install-schedule [--dry-run]
  node crawler/cli.mjs promote-schedule --revision <40hex> [--canary-log FILE] [--release-root DIR] [--release-state FILE] [--mode normal|startup|remote] [--location-preset india|pune] [--dry-run]
  node crawler/cli.mjs rollback-schedule [--release-state FILE] [--dry-run]
  node crawler/cli.mjs schedule-health [--config FILE]

The crawler performs discovery and produces a planning-only handoff. It never applies or sends automatically.
install-schedule installs local launchd agents for the morning and midday
schedules; promote-schedule installs only a verified canary-gated immutable
release checkout; rollback-schedule restores the retained prior release.
schedule-health reports durable per-schedule run history.
Commercial rescue remains explicit and
requires separate configured credentials and operator invocation.
`;
}

export function validateCrawlerConfig(config) {
  if (!config || config.schemaVersion !== CRAWLER_CONFIG_VERSION) throw new Error(`schemaVersion must be ${CRAWLER_CONFIG_VERSION}`);
  if (typeof config.databasePath !== 'string' || !config.databasePath.trim()) throw new Error('databasePath is required');
  if (!config.sources || typeof config.sources !== 'object' || Array.isArray(config.sources)) throw new Error('sources configuration is required');
  if (config.execution != null) {
    if (typeof config.execution !== 'object' || Array.isArray(config.execution)) throw new Error('execution must be an object');
    validateExecutionBudget(normalizeExecutionBudget(config.execution));
  }
  for (const section of ['atsWarm', 'atsBatch1', 'atsBatch2', 'enterprise']) {
    if (config.sources[section] && !Array.isArray(config.sources[section].boards)) throw new Error(`sources.${section}.boards must be an array`);
  }
  if (config.sourcePlanner != null) {
    if (typeof config.sourcePlanner !== 'object' || Array.isArray(config.sourcePlanner)) throw new Error('sourcePlanner must be an object');
    for (const field of ['enabled', 'legacyPlannerRollback']) {
      if (config.sourcePlanner[field] != null && typeof config.sourcePlanner[field] !== 'boolean') throw new Error(`sourcePlanner.${field} must be a boolean`);
    }
    for (const field of ['maxBoards', 'priorityShare', 'explorationShare']) {
      if (config.sourcePlanner[field] != null && (!Number.isFinite(Number(config.sourcePlanner[field])) || Number(config.sourcePlanner[field]) < 0)) throw new Error(`sourcePlanner.${field} must be non-negative`);
    }
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
  throwIfNetworkWorkDisallowed(options.signal, options.deadline);
  const remainingMs = remainingDeadlineMs(options.deadline);
  const timeoutMs = Math.max(1, Math.min(Number(options.timeoutMs ?? 10000), Number.isFinite(remainingMs) ? remainingMs : Number(options.timeoutMs ?? 10000)));
  const abort = requestAbortSignal(options.signal, timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: abort.signal,
      redirect: options.redirect ?? 'follow',
      ...(options.credentials ? { credentials: options.credentials } : {}),
    });
    const maxBytes = options.maxBytes ?? 2_000_000;
    const chunks = [];
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel();
            throw new Error('response-too-large');
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
    }
    return { status: response.status, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), byteLength: bytes, url: response.url };
  } finally {
    abort.cleanup();
  }
}

function sourcePlan(id, lane, provider, fetcher, metadata = {}) {
  return { id, lane, provider, trustClass: 'direct', ...metadata, fetch: fetcher };
}

function sourceTransport(transport, signal, deadline) {
  return (url, options = {}) => requestWithDeadline(transport, url, options, {
    signal: options.signal ?? signal,
    deadline: options.deadline ?? deadline,
    abortOnDeadline: options.abortOnDeadline === true,
  });
}

function persistSourcePlanState(store, sourceId, state, at) {
  const row = store.prepare('SELECT cursor_json FROM sources WHERE source_id = ?').get(sourceId);
  if (!row) return;
  let cursorState = {};
  try {
    const parsed = row.cursor_json ? JSON.parse(row.cursor_json) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cursorState = parsed;
  } catch {
    cursorState = {};
  }
  delete cursorState.pendingSourcePlanState;
  store.prepare('UPDATE sources SET cursor_json = ?, updated_at = ? WHERE source_id = ?')
    .run(JSON.stringify({ ...cursorState, sourcePlanState: state }), at, sourceId);
}

function resolverSettings(config) {
  const configured = config?.originalListingResolver
    ?? config?.sources?.originalListingResolver
    ?? config?.sources?.resolver
    ?? {};
  const settings = {};
  if (configured.maxRedirects != null) settings.maxRedirects = configured.maxRedirects;
  if (configured.maxBytes != null) settings.maxBytes = configured.maxBytes;
  if (configured.maxHosts != null) settings.maxHosts = configured.maxHosts;
  if (configured.maxRequests != null) settings.maxRequests = configured.maxRequests;
  if (configured.requestBudget != null && settings.maxRequests == null) settings.maxRequests = configured.requestBudget;
  return settings;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function portalResolverSettings(config) {
  const portals = config?.sources?.portals ?? {};
  return {
    maxCandidates: positiveInteger(portals.maxCandidates, 24),
    maxRequests: positiveInteger(portals.maxResolverRequests, 48),
    concurrency: positiveInteger(portals.resolverConcurrency, 3),
    perHostConcurrency: positiveInteger(portals.perHostConcurrency, 1),
    maxDurationMs: positiveInteger(portals.resolverMaxDurationMs, 60_000),
    handoffReserveMs: Number.isInteger(Number(portals.handoffReserveMs)) && Number(portals.handoffReserveMs) >= 0
      ? Number(portals.handoffReserveMs)
      : 5_000,
  };
}

function hostOfUrl(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return 'unknown'; }
}

function withPortalIdentity(candidate) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  let jobId = candidate.jobId;
  if (jobId == null) {
    try { jobId = new URL(candidate.canonicalUrl).pathname.match(/\/jobs\/view\/([^/]+)/i)?.[1] ?? null; }
    catch { jobId = null; }
  }
  const sourceRecordKey = candidate.sourceRecordKey ?? jobId ?? candidate.canonicalUrl;
  return {
    ...candidate,
    ...(jobId != null ? { jobId: String(jobId) } : {}),
    ...(sourceRecordKey != null ? { sourceRecordKey: String(sourceRecordKey) } : {}),
  };
}

function checkpointResolutionObservation(candidate, resolved) {
  const identity = candidate.sourceRecordKey ?? candidate.providerJobId ?? candidate.jobId ?? candidate.canonicalUrl;
  return { ...resolved, sourceRecordKey: identity };
}

function createSharedRequestBudget(maxRequests) {
  let used = 0;
  let exhausted = false;
  return {
    maxRequests,
    claim() {
      if (used >= maxRequests) {
        exhausted = true;
        return false;
      }
      used += 1;
      return true;
    },
    get used() { return used; },
    get exhausted() { return exhausted; },
  };
}

function monotonicClockNow(clock) {
  const value = typeof clock?.monotonicNow === 'function'
    ? Number(clock.monotonicNow())
    : Number(globalThis.performance?.now?.());
  return Number.isFinite(value) ? value : Date.now();
}

function resolverPhaseDeadline({ clock, sourceDeadline, maxDurationMs, handoffReserveMs }) {
  const startMs = monotonicClockNow(clock);
  return {
    remainingMs: () => {
      const elapsed = Math.max(0, monotonicClockNow(clock) - startMs);
      const sourceRemaining = remainingDeadlineMs(sourceDeadline);
      const safeSourceRemaining = Number.isFinite(sourceRemaining)
        ? Math.max(0, sourceRemaining - handoffReserveMs)
        : Infinity;
      return Math.max(0, Math.min(maxDurationMs - elapsed, safeSourceRemaining));
    },
  };
}

// Leave bounded detail time inside the existing source allowance before searching portals.
function portalDiscoveryDeadline(sourceDeadline, limits) {
  const available = Math.max(0, remainingDeadlineMs(sourceDeadline) - limits.handoffReserveMs);
  const resolutionReserveMs = Math.min(limits.maxDurationMs, available / 2);
  return {
    resolutionReserveMs,
    remainingMs: () => Math.max(0, remainingDeadlineMs(sourceDeadline) - limits.handoffReserveMs - resolutionReserveMs),
  };
}

// Prefer leads with an enabled supported employer board without changing provider fairness.
function portalBoardPriority(candidate, config) {
  const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const employer = normalize(candidate.company);
  return Boolean(employer && (config.boardRegistry?.boards ?? []).some((board) => board.enabled === true && board.probeStatus === 'verified'
    && ['greenhouse', 'lever', 'ashby', 'workday'].includes(board.provider)
    && normalize(board.company) === employer));
}

/**
 * Shared SearXNG search transport: wraps the base HTTP transport into the
 * `(query) => { status, body: { results, unresponsive_engines? } }` shape every
 * search-based discovery function (discoverBraveSearch, discoverYcJobs) expects.
 * Preserves unresponsive_engines so zero-result engine degradation is distinct
 * from a healthy empty market.
 */
function searxngTransport(endpoint, baseTransport) {
  return async (query, options = {}) => {
    const url = new URL('/search', endpoint);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    const response = await requestWithDeadline(baseTransport, url.toString(), { headers: { Accept: 'application/json' }, ...options }, { signal: options.signal ?? null, deadline: options.deadline ?? null });
    const body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
    const payload = { results: body?.results };
    if (Array.isArray(body?.unresponsive_engines)) payload.unresponsive_engines = body.unresponsive_engines;
    return { ...response, body: payload };
  };
}

// Crawl configured startup career pages with the shared transport.
async function fetchStartupCompanyCareers({ sources, transport, runAt, signal, deadline }) {
  const companyCareers = sources.startup?.companyCareers ?? [];
  const result = await discoverCompanyCareers({ companies: companyCareers, transport, runAt, signal, deadline });
  const failed = result.manifest.sources.some(({ status }) => ['terminal', 'retryable', 'interrupted'].includes(status));
  const status = result.observations.length ? (failed ? 'degraded' : 'ok') : failed ? 'failed' : 'empty';
  return {
    observations: result.observations.map((candidate) => ({
      ...candidate,
      startupLaneId: 'startup-company-careers',
      originalApplicationEvidence: candidate.originalApplicationEvidence || candidate.evidence?.applicationUrl || null,
    })),
    manifest: {
      status,
      ...(status === 'empty' ? { reason: companyCareers.length ? 'company-careers-search-returned-no-roles' : 'no-company-career-sites-configured' } : {}),
      fetched: result.observations.length,
      telemetry: result.telemetry,
    },
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

function verificationResolution(observation, error, reason = 'resolver-error') {
  const discoveryUrl = observation?.discoveryUrl ?? observation?.canonicalUrl ?? observation?.url ?? null;
  return {
    status: 'verification',
    discoveryUrl,
    originalApplicationUrl: null,
    applicationResolution: { status: 'Needs Verification', evidence: null },
    evidence: {
      resolver: ORIGINAL_LISTING_RESOLVER_VERSION,
      resolution: { status: 'verification', reason },
      error: error?.message || reason,
    },
  };
}

/** Build the one resolver shared by all resolver-capable sources in a run. */
export function createCrawlerRunResolver({ config, transport, runAt, signal = null, deadline = null, requestBudget = null, hostLimiter = null }) {
  const resolver = createOriginalListingResolver({
    transport,
    config,
    runAt,
    signal,
    deadline,
    sharedRequestBudget: requestBudget,
    hostLimiter,
    ...resolverSettings(config),
  });

  return async (observation = {}, invocation = {}) => {
    const discoveryUrl = observation.discoveryUrl ?? observation.canonicalUrl ?? observation.url ?? null;
    try {
      // The connector hook copies the observation after resolving. Keep the
      // discovery URL on that object as well as in the resolver result.
      if (discoveryUrl && !observation.discoveryUrl) observation.discoveryUrl = discoveryUrl;
      const resolution = await resolver({ ...observation, discoveryUrl }, invocation);
      return resolution && typeof resolution === 'object'
        ? { ...resolution, discoveryUrl: resolution.discoveryUrl ?? discoveryUrl }
        : resolution;
    } catch (error) {
      return verificationResolution({ ...observation, discoveryUrl }, error);
    }
  };
}

// Import local JSON exports and pasted Markdown leads through the shared resolver.
async function readConnectorInbox({ inboxDir, readJson = true, hiringPostsFile = null, runAt, resolver }) {
  const root = path.resolve(inboxDir);
  if (!fs.existsSync(root) && !hiringPostsFile) return { observations: [], manifest: { status: 'unavailable', reason: 'inbox-missing', fetched: 0 } };
  const receiptDir = path.join(root, '.receipts');
  const observations = [];
  const receipts = [];
  const entries = readJson && fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith('.json')).sort() : [];
  if (entries.length) fs.mkdirSync(receiptDir, { recursive: true });
  for (const entry of entries) {
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
  if (hiringPostsFile && fs.existsSync(hiringPostsFile)) {
    for (const envelope of parseHiringPostInbox(fs.readFileSync(hiringPostsFile, 'utf8'))) {
      const imported = normalizeConnectorEnvelope(envelope, { runAt });
      for (const observation of imported.observations) {
        const resolved = typeof resolver === 'function' ? await resolver(observation) : null;
        observations.push(resolved ? applyOriginalListingResolution(observation, resolved) : observation);
      }
      receipts.push({ file: hiringPostsFile, status: 'imported', imported: imported.observations.length, quarantined: imported.quarantine.length,
        quarantine: imported.quarantine });
    }
  }
  return { observations, manifest: { status: 'succeeded', fetched: observations.length, receipts, noAutoApply: true } };
}

/** Round-robin provider ownership keeps a capped resolver from spending its
 * entire budget on the first adapter. Preserve order within each provider.
 */
export function fairPortalResolutionCandidates(candidates, maximum) {
  const queues = new Map();
  for (const item of candidates) {
    const provider = item.candidate.discoveryProvider || item.candidate.provider || item.candidate.source;
    if (!queues.has(provider)) queues.set(provider, []);
    queues.get(provider).push(item);
  }
  const result = [];
  for (let index = 0; result.length < maximum; index += 1) {
    let added = false;
    for (const queue of queues.values()) {
      if (result.length >= maximum) break;
      if (queue[index]) { result.push(queue[index]); added = true; }
    }
    if (!added) break;
  }
  return result;
}

/** Search cards can disprove fit, but missing detail is not a mismatch. */
export function screenPortalCandidate(candidate, policy) {
  const eligibility = classifyCandidate(candidate, policy);
  const uncertain = new Set(['GEO_NOT_VERIFIED', 'GEO_REMOTE_SCOPE_UNCLEAR', 'INTERNSHIP_PAY_NOT_EXPLICIT']);
  const reasons = eligibility.reasons.filter((reason) => !uncertain.has(reason));
  return { eligible: reasons.length === 0, reasons };
}

// Build the scheduled source fetchers with their run-scoped policies.
export function buildSourcePlans({ config, transport, runAt, clock, schedule, resolver, profile, signal = null, deadline = null, onSourcePlanState = null, portalCandidateScreen = null, linkedInPolicy = null, renderedFetcherFactory = createRenderedFetcher }) {
  transport = (linkedInPolicy ?? createLinkedInGuestPolicy({ transport, runAt, clock })).transport;
  // Project boards from the unified registry when configured; tests that inject
  // inline sources.*.boards without boardRegistryPath keep their fixtures.
  const projected = withRegistryProjectedBoards(config, { locationPreset: profile?.locationPreset, sourcePlan: profile?.sourcePlan });
  const sources = projected.sources;
  const careerPageCompanies = (projected.boardRegistry?.boards ?? []).filter((board) =>
    board.enabled !== false
    && !PROVIDER_LANES[String(board.provider || '').toLowerCase()]
    && typeof board.careerPageUrl === 'string'
    && board.probe?.jobPostingJsonLd === true)
    .map((board) => ({ company: board.company, websiteUrl: board.careerPageUrl }));
  const careerPagePlan = sourcePlan('structured-career-pages', 'career-pages', 'career-page-discovery', async ({ signal: sourceSignal = signal, deadline: sourceDeadline = deadline } = {}) => {
    if (!careerPageCompanies.length) {
      return { observations: [], manifest: {
        status: projected.boardRegistry ? 'empty' : 'unavailable',
        reason: projected.boardRegistry
          ? 'no-registry-employers-with-unsupported-ats-and-jobposting-jsonld'
          : 'no-board-registry-configured',
        fetched: 0,
      }, telemetry: { requests: 0, fetched: 0 } };
    }
    const result = await discoverCareerPages({
      ...(sources.careerPageDiscovery ?? projected.careerPageDiscovery ?? {}),
      companies: careerPageCompanies,
      transport: sourceTransport(transport, sourceSignal, sourceDeadline),
      runAt,
      clock,
    });
    return {
      ...result,
      manifest: {
        ...result.manifest,
        status: result.observations.length ? 'ok' : 'empty',
        ...(result.observations.length ? {} : { reason: 'no-jobposting-jsonld-roles-found' }),
        fetched: result.observations.length,
      },
    };
  });
  const hnPlans = isSourceTrialActive(sources.hn, runAt) && schedule !== 'midday'
    ? [sourcePlan('hn-discovery', 'startup-sources', 'hn-discovery', ({ signal: sourceSignal = signal, deadline: sourceDeadline = deadline } = {}) => discoverHnJobs({ ...sources.hn, transport, resolveOriginalListing: resolver, runAt, signal: sourceSignal, deadline: sourceDeadline }), { trustClass: 'aggregator', maxDurationMs: sources.hn.maxDurationMs })]
    : [];
  const ycPlans = isSourceTrialActive(sources.yc, runAt) && schedule !== 'midday'
    ? [sourcePlan('yc-discovery', 'startup-sources', 'yc-discovery', async ({ signal: sourceSignal = signal, deadline: sourceDeadline = deadline } = {}) => {
      if (!sources.searxng?.enabled || !sources.searxng.endpoint) throw new Error('YC trial requires configured SearXNG');
      return discoverYcJobs({ ...sources.yc, transport: searxngTransport(sources.searxng.endpoint, transport), resolveOriginalListing: resolver, runAt, signal: sourceSignal, deadline: sourceDeadline });
    }, { trustClass: 'aggregator', maxDurationMs: sources.yc.maxDurationMs })]
    : [];
  const plannerConfig = projected.sourcePlanner ?? {};
  const plannerEnabled = plannerConfig.enabled === true && plannerConfig.legacyPlannerRollback !== true;
  const boardPlan = plannerEnabled ? planBoundedSources({
    boardsByLane: Object.fromEntries(['atsWarm', 'atsBatch1', 'atsBatch2', 'enterprise'].map((lane) => [lane, sources[lane]?.boards ?? []])),
    locationPreset: profile?.locationPreset ?? 'india',
    targetTitles: plannerConfig.targetTitles ?? profile?.sourcePlan?.queryHints ?? [],
    maxBoards: plannerConfig.maxBoards,
    allocation: {
      priorityShare: plannerConfig.priorityShare ?? 0.8,
      explorationShare: plannerConfig.explorationShare ?? 0.2,
    },
    state: plannerConfig.state ?? {},
    runAt,
  }) : null;
  const probeState = boardPlan?.state || { ...plannerConfig.state, boards: { ...(plannerConfig.state?.boards || {}) } };
  let probeRegistry = projected.boardRegistry ? {
    ...projected.boardRegistry,
    boards: projected.boardRegistry.boards,
  } : null;
  const probedBoards = new Set();
  // Retain listing geography from the adapter's existing request, with no extra fetch.
  const probeTransport = (lane, sourceSignal, sourceDeadline) => {
    const bounded = sourceTransport(transport, sourceSignal, sourceDeadline);
    return async (url, options = {}) => {
      const response = await bounded(url, options);
      if (!probeRegistry || options.detail) return response;
      const identity = options.board ? boardIdentityKey(options.board)?.toLowerCase() : null;
      const board = probeRegistry.boards.find((entry) => entry.scheduleLane === lane && (identity
        ? entry.id.toLowerCase() === identity
        : [entry.url, entry.endpoint, registryProbeUrl(entry)]
          .filter(Boolean).some((base) => String(url).split('?')[0] === base.split('?')[0])));
      if (board && !probedBoards.has(board.id)) {
        const priorRegistry = probeRegistry;
        probeRegistry = recordBoardProbeResponse(probeRegistry, board.id, response, { sourceUrl: url, runAt });
        const observed = probeRegistry.boards.find((entry) => entry.id === board.id);
        if (probeRegistry !== priorRegistry) probedBoards.add(board.id);
        if (observed.probe) probeState.boards[board.id.toLowerCase()] = {
          ...probeState.boards[board.id.toLowerCase()], probe: observed.probe,
          puneRelevant: observed.puneRelevant, indiaRelevant: observed.indiaRelevant,
        };
      }
      return response;
    };
  };
  const plannedBoards = (lane) => boardPlan?.boardsByLane?.[lane] ?? (sources[lane]?.boards ?? []).filter((board) => !boardPauseReason(board, probeState, runAt));
  const planResult = (result, lane) => boardPlan
    ? {
      ...result,
      sourcePlanState: boardPlan.resumeState,
      manifest: {
        ...(result?.manifest ?? {}),
        boardPlan: { ...boardPlan.boardPlan, ownerLane: lane },
      },
    }
    : { ...result, sourcePlanState: plannerConfig.state || {} };
  const rememberPlanState = (result) => {
    if (typeof onSourcePlanState === 'function') onSourcePlanState(probeState);
    return result;
  };
  const plans = [];
  if (profile && schedule !== 'midday' && profile.mode !== 'startup' && Array.isArray(sources.startup?.companyCareers)) plans.push(sourcePlan('startup-company-careers', 'startup-sources', 'startup-company-careers', async ({ signal: sourceSignal = signal, deadline: sourceDeadline = deadline } = {}) => fetchStartupCompanyCareers({ sources, transport, runAt, signal: sourceSignal, deadline: sourceDeadline })));
  if (plannerEnabled || sources.atsWarm?.boards?.length) plans.push(sourcePlan('ats-warm', 'ats-warm', 'ats-warm', async ({ signal: sourceSignal = signal, deadline: sourceDeadline = deadline } = {}) => rememberPlanState(planResult(
    await fetchWarmAts({ ...sources.atsWarm, boards: plannedBoards('atsWarm'), transport: probeTransport('atsWarm', sourceSignal, sourceDeadline), runAt, signal: sourceSignal, deadline: sourceDeadline }), 'atsWarm')), { maxDurationMs: sources.atsWarm?.maxDurationMs }));
  if (plannerEnabled || sources.atsBatch1?.boards?.length) plans.push(sourcePlan('ats-batch-1', 'ats-expanded', 'ats-batch-1', async ({ cursor, signal: sourceSignal = signal, deadline: sourceDeadline = deadline } = {}) => {
    const result = await fetchAtsBatch1({ ...sources.atsBatch1, boards: plannedBoards('atsBatch1'), transport: probeTransport('atsBatch1', sourceSignal, sourceDeadline), runAt, cursorState: cursor?.cursorState, conditionalState: cursor?.conditionalState, signal: sourceSignal, deadline: sourceDeadline });
    return rememberPlanState(planResult({ ...result, cursor: { cursorState: result.cursorState, conditionalState: result.conditionalState } }, 'atsBatch1'));
  }, { capabilities: { newestFirst: true, paginated: true }, maxDurationMs: sources.atsBatch1?.maxDurationMs }));
  if (schedule !== 'midday' && (plannerEnabled || sources.atsBatch2?.boards?.length)) plans.push(sourcePlan('ats-batch-2', 'ats-expanded', 'ats-batch-2', async ({ cursor, signal: sourceSignal = signal, deadline: sourceDeadline = deadline } = {}) => {
    const result = await discoverAtsBatch2({ ...sources.atsBatch2, boards: plannedBoards('atsBatch2'), transport: probeTransport('atsBatch2', sourceSignal, sourceDeadline), runAt, state: cursor ?? {}, signal: sourceSignal, deadline: sourceDeadline });
    return rememberPlanState(planResult({ ...result, cursor: Object.fromEntries(result.results.map((entry, index) => [plannedBoards('atsBatch2')[index]?.slug || plannedBoards('atsBatch2')[index]?.company, entry.conditionalState])) }, 'atsBatch2'));
  }, { capabilities: { newestFirst: true, completeArray: true }, maxDurationMs: sources.atsBatch2?.maxDurationMs }));
  if (schedule !== 'midday' && (plannerEnabled || sources.enterprise?.boards?.length)) plans.push(sourcePlan('ats-enterprise', 'ats-expanded', 'ats-enterprise', async ({ cursor, signal: sourceSignal = signal, deadline: sourceDeadline = deadline, checkpoint = null } = {}) => {
    const result = await discoverEnterpriseAts({ ...sources.enterprise, boards: plannedBoards('enterprise'), transport: probeTransport('enterprise', sourceSignal, sourceDeadline), runAt, conditionalState: cursor ?? {}, checkpoint, signal: sourceSignal, deadline: sourceDeadline });
    return rememberPlanState(planResult({ ...result, cursor: result.conditionalState }, 'enterprise'));
  }, { capabilities: { newestFirst: true, paginated: true }, maxDurationMs: sources.enterprise?.maxDurationMs }));
  if (sources.indeed?.enabled) plans.push(sourcePlan('indeed-inbox', 'connector-imports', 'indeed', async () => importIndeedInbox({
    ...sources.indeed,
    date: sources.indeed.date ?? runAt.slice(0, 10),
    clock,
    resolver,
  }), { capabilities: { resolver: typeof resolver === 'function', discoveryUrl: true } }));
  const connectorInboxDir = sources.connectorInbox?.inboxDir ?? 'connector-inbox';
  const hiringPostsFile = schedule === 'morning'
    ? sources.connectorInbox?.hiringPostsFile ?? path.join(connectorInboxDir, 'hiring-posts.md') : null;
  if (sources.connectorInbox?.enabled || (hiringPostsFile && fs.existsSync(hiringPostsFile))) {
    plans.push(sourcePlan('connector-inbox', 'connector-imports', 'connector-inbox', async () => readConnectorInbox({
      inboxDir: connectorInboxDir, readJson: sources.connectorInbox?.enabled === true, hiringPostsFile, runAt, resolver,
    }), { capabilities: { resolver: typeof resolver === 'function', providers: [...CONNECTOR_PROVIDERS] } }));
  }
  if (schedule !== 'midday' && profile?.mode === 'normal' && sources.theirstack?.enabled) {
    plans.push(sourcePlan('theirstack', 'connector-imports', 'theirstack', async ({ cursor, signal: sourceSignal = signal, deadline: sourceDeadline = deadline } = {}) => {
      const theirStackConfig = sources.theirstack;
      const apiKey = process.env[theirStackConfig.apiKeyEnv ?? 'THEIRSTACK_API_KEY'];
      return discoverTheirStack({
        ...theirStackConfig,
        queries: theirStackConfig.queries.map((query) => query.filters),
        apiKey,
        transport,
        runAt,
        cursor,
        signal: sourceSignal,
        deadline: sourceDeadline,
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
  if (profile?.mode === 'startup' && schedule !== 'midday') plans.push(sourcePlan('startup-mode', 'startup-sources', 'startup', async ({ signal: sourceSignal = signal, deadline: sourceDeadline = deadline } = {}) => {
    const sourceFunctions = {};
    sourceFunctions['startup-company-careers'] = async () => {
      const result = await fetchStartupCompanyCareers({ sources, transport, runAt, signal: sourceSignal, deadline: sourceDeadline });
      return { candidates: result.observations, manifest: result.manifest };
    };
    // yc and vc-portfolio-boards both need a search transport and an original-listing
    // resolver; without both, honestly leave them unavailable rather than fabricate.
    if (sources.searxng?.enabled && sources.searxng.endpoint && typeof resolver === 'function') {
      const searxTransport = searxngTransport(sources.searxng.endpoint, transport);
      const ycQueries = (sources.searxng.queries ?? []).filter((query) => /ycombinator\.com\/jobs/i.test(query));
      if (ycQueries.length) {
        sourceFunctions.yc = async ({ signal: sourceSignal, deadline: sourceDeadline } = {}) => {
          const result = await discoverYcJobs({
            transport: searxTransport,
            queries: ycQueries,
            resolveOriginalListing: resolver,
            runAt,
            perQueryResultCap: sources.searxng.perQueryResultCap,
            signal: sourceSignal,
            deadline: sourceDeadline,
          });
          return { candidates: result.observations, manifest: { status: 'ok', ...result.manifest } };
        };
      }
      sourceFunctions['vc-portfolio-boards'] = async ({ signal: sourceSignal, deadline: sourceDeadline } = {}) => {
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
          signal: sourceSignal,
          deadline: sourceDeadline,
        });
        return { candidates: result.observations, manifest: { status: 'ok', ...result.manifest } };
      };
    }
    const outputs = await runStartupSourcePlan({ sourceFixtures: sources.startup?.fixtures ?? {}, sourceFunctions, laneInputs: sources.startup?.laneInputs ?? {}, runAt, runId: profile.mode, signal: sourceSignal, deadline: sourceDeadline });
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
  if (explicitRemoteMode || scheduledRemoteEnabled) plans.push(sourcePlan('remote-mode', 'remote-sources', 'remote', async ({ signal: sourceSignal = signal, deadline: sourceDeadline = deadline } = {}) => {
    const remoteConfig = sources.remote ?? {};
    const forceAll = explicitRemoteMode;
    const activeProviders = selectRemoteProviders({ remoteConfig, runAt, forceAll });
    const fetchJson = async (url, options = {}) => { throwIfNetworkWorkDisallowed(sourceSignal, sourceDeadline); const response = await requestWithDeadline(transport, url, options, { signal: sourceSignal, deadline: sourceDeadline }); const body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body; return body; };
    const fetchText = async (url, options = {}) => { throwIfNetworkWorkDisallowed(sourceSignal, sourceDeadline); const response = await requestWithDeadline(transport, url, options, { signal: sourceSignal, deadline: sourceDeadline }); return response.body; };
    const providerFetchers = {};
    for (const provider of activeProviders) {
      providerFetchers[provider] = provider === 'weworkremotely' ? { fetchText } : { fetchJson };
    }
    const outputs = await runRemoteSourcePlan({ providerFetchers, runAt, runId: profile?.mode || 'normal', signal: sourceSignal, deadline: sourceDeadline });
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
          try { throwIfNetworkWorkDisallowed(sourceSignal, sourceDeadline); resolution = await resolver(candidate, { signal: sourceSignal, deadline: sourceDeadline }); }
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
  // Portal discovery. LinkedIn runs on the shared HTTP transport; the browser
  // portals share one Chromium context for the whole run and it is always torn
  // down, including on failure, so a crashed lane cannot leak a browser.
  let linkedInGuestPass = null;
  if (sources.portals?.enabled) plans.push(sourcePlan('portal-discovery', 'portal-sources', 'portals', async ({ runId: sourceRunId = runAt, cursor = null, signal: sourceSignal = signal, deadline: sourceDeadline = deadline, checkpoint = null } = {}) => {
    const portalConfig = sources.portals ?? {};
    const portalLimits = portalResolverSettings({ sources: { portals: portalConfig } });
    const discoveryDeadline = portalDiscoveryDeadline(sourceDeadline, portalLimits);
    const browserEnabled = portalConfig.browser?.enabled === true;
    const browserProviders = new Set(browserEnabled ? (portalConfig.browser?.providers ?? []) : []);
    const httpProviders = new Set(portalConfig.http?.providers ?? ['linkedin-jobs']);
    const cachedGuestPass = cursor?.linkedInGuestPass ?? linkedInGuestPass;
    let discoveryDeadlineExhausted = cachedGuestPass?.runId === sourceRunId
      && (cursor?.discoveryDeadlineExhausted === true || cachedGuestPass.discoveryDeadlineExhausted === true);

    // Record shortened search-budget failures before adapters turn them into lane errors.
    const fetchDiscovery = async (fetcher, url, options = {}) => {
      try {
        return await requestWithDeadline(fetcher, url, options, { signal: sourceSignal, deadline: discoveryDeadline, abortOnDeadline: true });
      } catch (error) {
        if (error?.code === 'DAILY_DEADLINE_EXCEEDED' || remainingDeadlineMs(discoveryDeadline) <= 0) discoveryDeadlineExhausted = true;
        throw error;
      }
    };

    const fetchText = async (url, options = {}) => {
      const response = await fetchDiscovery(transport, url, options);
      const status = Number(response.status ?? 200);
      if (status < 200 || status >= 300) {
        const error = new Error(`HTTP ${status}`);
        error.statusCode = status;
        throw error;
      }
      return response.body;
    };

    let browser = null;
    const providerFetchers = {};
    const laneInputs = {};
    for (const lane of PORTAL_SOURCE_LANES) {
      const provider = lane.provider;
      if (portalConfig[provider === 'linkedin-jobs' ? 'linkedin' : provider]?.enabled === false) continue;
      const queries = portalConfig[provider === 'linkedin-jobs' ? 'linkedin' : provider]?.queries;
      if (!queries?.length) continue;
      if (httpProviders.has(provider)) {
        providerFetchers[provider] = { fetchText };
        laneInputs[provider] = {
          queries,
          timeWindow: portalConfig.linkedin?.timeWindow ?? 'day',
          maxPagesPerQuery: portalConfig.linkedin?.maxPagesPerQuery ?? 2,
          pageSize: portalConfig.linkedin?.pageSize ?? 25,
          ...(provider === 'linkedin-jobs' ? {
            guestPass: (cursor?.linkedInGuestPass ?? linkedInGuestPass)?.runId === sourceRunId
              ? JSON.parse((cursor?.linkedInGuestPass ?? linkedInGuestPass).result) : null,
            onGuestPass: (result) => { linkedInGuestPass = { runId: sourceRunId, result: JSON.stringify(result), discoveryDeadlineExhausted }; },
          } : {}),
        };
      } else if (browserProviders.has(provider)) {
        browser ??= renderedFetcherFactory({
          maxPages: portalConfig.browser?.maxPagesPerRun ?? 24,
          timeoutMs: portalConfig.browser?.timeoutMs ?? 45_000,
          defaultWaitMs: portalConfig.browser?.waitMs ?? 6_000,
        });
        providerFetchers[provider] = { fetchRendered: (url, options = {}) => fetchDiscovery(browser.fetchRendered, url, options) };
        laneInputs[provider] = { queries };
      }
    }

    let outputs;
    try {
      outputs = await runPortalSourcePlan({
        providerFetchers,
        laneInputs,
        runAt,
        runId: profile?.mode || 'normal',
        signal: sourceSignal,
        maxRecordsPerProvider: portalConfig.maxRecordsPerProvider ?? null,
      });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
    linkedInGuestPass = cursor?.linkedInGuestPass?.runId === sourceRunId ? cursor.linkedInGuestPass : linkedInGuestPass;

    const retained = new Map((cursor?.completedDetails || []).map((candidate) => [linkedInPublicJobId(candidate.discoveryUrl ?? candidate.canonicalUrl), candidate]).filter(([id]) => id));
    const candidates = outputs.flatMap((item) => item.candidates || []).map(withPortalIdentity)
      .map((candidate) => retained.get(linkedInPublicJobId(candidate.discoveryUrl ?? candidate.canonicalUrl)) ?? candidate);
    const completedDetails = new Map(retained);
    const resolutionCursor = (nextIndex) => ({ phase: 'portal-resolution', nextIndex, maxCandidates: portalLimits.maxCandidates,
      linkedInGuestPass, discoveryDeadlineExhausted,
      completedDetails: [...completedDetails.values()].slice(0, portalLimits.maxCandidates) });
    const screened = candidates.map((candidate) => {
      let result = { eligible: true };
      if (typeof portalCandidateScreen === 'function') {
        try { result = portalCandidateScreen(candidate) ?? { eligible: false }; }
        catch { result = { eligible: false }; }
      }
      return { candidate, eligible: result === true || result?.eligible === true };
    });
    const isAlreadyResolved = (candidate) => ['Direct ATS', 'Resolved Original'].includes(candidate.applicationResolution?.status)
      && candidate.originalApplicationUrl;
    const targetCandidates = screened.filter((item) => item.eligible);
    const unresolvedTargetCandidates = targetCandidates.filter(({ candidate }) => !isAlreadyResolved(candidate));
    const boardCandidates = unresolvedTargetCandidates.filter(({ candidate }) => portalBoardPriority(candidate, config));
    const otherCandidates = unresolvedTargetCandidates.filter(({ candidate }) => !portalBoardPriority(candidate, config));
    const preferredCandidates = fairPortalResolutionCandidates(boardCandidates, portalLimits.maxCandidates);
    const resolutionCandidates = [...preferredCandidates,
      ...fairPortalResolutionCandidates(otherCandidates, portalLimits.maxCandidates - preferredCandidates.length)];
    const sharedRequestBudget = createSharedRequestBudget(portalLimits.maxRequests);
    const hostLimiter = createHostSerializedRunner();
    const resolverDeadline = resolverPhaseDeadline({
      clock, sourceDeadline, maxDurationMs: portalLimits.maxDurationMs, handoffReserveMs: portalLimits.handoffReserveMs,
    });
    const initialTelemetry = {
      candidatesFetched: candidates.length,
      targetScreened: targetCandidates.length,
      resolutionCandidates: resolutionCandidates.length,
      resolutionAllocation: Object.fromEntries([...new Set(resolutionCandidates.map(({ candidate }) => candidate.provider))]
        .map((provider) => [provider, resolutionCandidates.filter(({ candidate }) => candidate.provider === provider).length])),
      resolutionRequests: 0,
      detailErrors: [],
      resolved: targetCandidates.filter(({ candidate }) => isAlreadyResolved(candidate)).length,
      unresolved: candidates.length,
      skippedByTargetScreen: candidates.length - targetCandidates.length,
      skippedByCandidateCap: Math.max(0, unresolvedTargetCandidates.length - portalLimits.maxCandidates),
      requestBudgetExhausted: false,
      deadlineExhausted: false,
      concurrency: portalLimits.concurrency,
      perHostConcurrency: portalLimits.perHostConcurrency,
      maxCandidates: portalLimits.maxCandidates,
      maxRequests: portalLimits.maxRequests,
      maxDurationMs: portalLimits.maxDurationMs,
      handoffReserveMs: portalLimits.handoffReserveMs,
      resolutionReserveMs: discoveryDeadline.resolutionReserveMs,
      discoveryDeadlineExhausted,
      verificationReasonCounts: {},
      checkpointed: false,
    };
    if (typeof checkpoint === 'function') {
      await checkpoint({
        observations: candidates,
        cursor: resolutionCursor(0),
        manifestDelta: { fetched: candidates.length, changed: candidates.length, telemetry: initialTelemetry },
      });
      initialTelemetry.checkpointed = true;
    }

    const verificationQueue = [];
    let checkpointCursor = 0;
    const completedIndexes = new Set();
    // Retain each completed portal resolution and advance its durable cursor.
    const checkpointResolution = async (candidate, resolved, candidateIndex, { advance = true, requested = false } = {}) => {
      const id = linkedInPublicJobId(candidate.discoveryUrl ?? candidate.canonicalUrl);
      if (id && (requested || resolved.evidence?.portalDetail?.status === 'extracted')) completedDetails.set(id, resolved);
      if (typeof checkpoint !== 'function') return;
      if (advance) {
        completedIndexes.add(candidateIndex);
        while (completedIndexes.has(checkpointCursor)) checkpointCursor += 1;
      }
      await checkpoint({
        observations: [checkpointResolutionObservation(candidate, resolved)],
        cursor: resolutionCursor(checkpointCursor),
        replaceObservations: true,
        manifestDelta: { telemetry: { ...initialTelemetry, checkpointed: true } },
      });
    };
    const resolutionResults = await mapProviderSafe(resolutionCandidates, {
      concurrency: portalLimits.concurrency,
      providerKey: ({ candidate }) => hostOfUrl(candidate.discoveryUrl ?? candidate.canonicalUrl),
    }, async ({ candidate }, candidateIndex) => {
      const unresolved = (reason) => applyOriginalListingResolution(candidate, verificationResolution(candidate, null, reason));
      let resolution;
      if (isAlreadyResolved(candidate)) return candidate;
      const retainedReason = retained.get(linkedInPublicJobId(candidate.discoveryUrl ?? candidate.canonicalUrl))?.evidence?.resolution?.reason;
      if (retainedReason && !['aborted', 'deadline-exceeded', 'request-budget-exhausted', 'request-budget-exceeded'].includes(retainedReason)) return candidate;
      if (sourceSignal?.aborted) {
        resolution = verificationResolution(candidate, null, 'aborted');
      } else if (resolverDeadline.remainingMs() <= 0) {
        initialTelemetry.deadlineExhausted = true;
        resolution = verificationResolution(candidate, null, 'deadline-exceeded');
      } else if (sharedRequestBudget.used >= portalLimits.maxRequests) {
        initialTelemetry.requestBudgetExhausted = true;
        resolution = verificationResolution(candidate, null, 'request-budget-exhausted');
      } else {
        try {
          throwIfNetworkWorkDisallowed(sourceSignal, resolverDeadline);
          resolution = typeof resolver === 'function'
            ? await resolver(candidate, { signal: sourceSignal, deadline: resolverDeadline, requestBudget: sharedRequestBudget, hostLimiter })
            : verificationResolution(candidate, null, 'resolver-unavailable');
        } catch (error) {
          resolution = verificationResolution(candidate, error, sourceSignal?.aborted
            ? 'aborted'
            : resolverDeadline.remainingMs() <= 0 ? 'deadline-exceeded' : 'resolver-error');
        }
      }
      const resolved = applyOriginalListingResolution(candidate, resolution);
      const eligibility = classifyCandidate(resolved, loadJobPullPolicy());
      resolved.eligibility = eligibility;
      if (!eligibility.eligible) resolved.shortlistEligible = false;
      if (resolved.evidence?.resolution?.reason === 'deadline-exceeded') initialTelemetry.deadlineExhausted = true;
      if (resolved.evidence?.resolution?.reason === 'request-budget-exhausted') initialTelemetry.requestBudgetExhausted = true;
      initialTelemetry.resolutionRequests = sharedRequestBudget.used;
      if (resolved.classification === 'direct' && resolved.originalApplicationUrl) initialTelemetry.resolved += 1;
      const reason = resolved.evidence?.resolution?.reason;
      if (reason && !['destination-intermediary', 'original-listing-not-found'].includes(reason)) {
        initialTelemetry.detailErrors.push({ jobId: candidate.jobId ?? null, url: candidate.discoveryUrl ?? candidate.canonicalUrl, reason, error: resolved.evidence?.error ?? null });
      }
      await checkpointResolution(candidate, resolved, candidateIndex, {
        requested: resolution.telemetry?.requests > 0,
        advance: !['aborted', 'deadline-exceeded', 'request-budget-exhausted'].includes(reason),
      });
      return resolved;
    });
    const resultsByCandidate = new Map(resolutionCandidates.map(({ candidate }, index) => [candidate, resolutionResults[index]]));
    const observations = screened.map(({ candidate, eligible }) => {
      if (resultsByCandidate.has(candidate)) return resultsByCandidate.get(candidate);
      if (isAlreadyResolved(candidate)) return candidate;
      const result = eligible ? verificationResolution(candidate, null, 'candidate-cap-exceeded') : verificationResolution(candidate, null, 'target-screen-rejected');
      return { ...applyOriginalListingResolution(candidate, result), shortlistEligible: false };
    });
    initialTelemetry.unresolved = observations.filter((candidate) => candidate.classification !== 'direct' || !candidate.originalApplicationUrl).length;
    initialTelemetry.resolutionRequests = sharedRequestBudget.used;
    if (sharedRequestBudget.exhausted) initialTelemetry.requestBudgetExhausted = true;
    for (const [index, { candidate }] of screened.entries()) {
      if (resultsByCandidate.has(candidate) || isAlreadyResolved(candidate)) continue;
      await checkpointResolution(candidate, observations[index], resolutionCandidates.length, { advance: false });
    }
    for (const candidate of observations) {
      if (candidate.eligibility?.eligible === false) continue;
      if (candidate.classification === 'direct' && candidate.originalApplicationUrl) continue;
      const reason = candidate.evidence?.resolution?.reason || 'original-listing';
      initialTelemetry.verificationReasonCounts[reason] = (initialTelemetry.verificationReasonCounts[reason] || 0) + 1;
      verificationQueue.push({ url: candidate.discoveryUrl || candidate.canonicalUrl, company: candidate.company, reason: 'original-listing', resolutionReason: reason, evidence: candidate.evidence });
    }
    const constrained = Boolean(discoveryDeadlineExhausted || (initialTelemetry.unresolved > 0 && (
      initialTelemetry.skippedByCandidateCap > 0
      || initialTelemetry.requestBudgetExhausted
      || initialTelemetry.deadlineExhausted
      || sourceSignal?.aborted
    )));
    initialTelemetry.truncated = constrained;
    initialTelemetry.naturalTerminal = !constrained;
    const laneErrors = [...outputs.flatMap((item) => item.manifest.errors || []),
      ...initialTelemetry.detailErrors.map((item) => `${item.url}: ${item.reason}${item.error ? `: ${item.error}` : ''}`)];
    if (typeof checkpoint === 'function') {
      await checkpoint({
        observations: [],
        cursor: resolutionCursor(checkpointCursor),
        manifestDelta: { telemetry: { ...initialTelemetry, checkpointed: true } },
      });
    }
    return {
      observations,
      verificationQueue,
      manifest: {
        status: laneErrors.length ? (observations.length ? 'degraded' : 'failed') : observations.length ? 'ok' : 'empty',
        failed: laneErrors.length,
        errors: laneErrors,
        fetched: observations.length,
        changed: observations.length,
        noAutoApply: true,
        writesPlanned: false,
        truncated: constrained,
        naturalTerminal: !constrained,
        telemetry: {
          mode: 'portals',
          browserEnabled,
          providers: Object.keys(providerFetchers),
          lanes: outputs.map((item) => item.manifest),
          ...initialTelemetry,
        },
      },
    };
  }));
  if (schedule !== 'midday' && sources.indiaStartup?.enabled) plans.push(sourcePlan('india-startup', 'brave-startup', 'india-startup', async ({ signal: sourceSignal = signal, deadline: sourceDeadline = deadline } = {}) => {
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
      transport: async (request, options = {}) => searxTransport(request.query, { ...options, signal: sourceSignal, deadline: sourceDeadline }),
      runAt,
      signal: sourceSignal,
      deadline: sourceDeadline,
    });
  }));
  if (schedule !== 'midday' && sources.searxng?.enabled) plans.push(sourcePlan('searxng-search', 'web-discovery', 'searxng', async ({ signal: sourceSignal = signal, deadline: sourceDeadline = deadline } = {}) => {
    if (!sources.searxng.endpoint) throw new Error('SearXNG is enabled but endpoint is unavailable');
    return discoverBraveSearch({
      ...sources.searxng,
      provider: 'searxng',
      transport: searxngTransport(sources.searxng.endpoint, transport),
      resolveOriginalListing: resolver,
      runAt,
      country: sources.searxng.country ?? 'IN',
      signal: sourceSignal,
      deadline: sourceDeadline,
    });
  }, { capabilities: { resolver: typeof resolver === 'function', discoveryUrl: true } }));
  // Spend ATS request budgets on Pune lanes before lanes with no Pune evidence.
  const atsLanes = { 'ats-warm': 'atsWarm', 'ats-batch-1': 'atsBatch1', 'ats-batch-2': 'atsBatch2', 'ats-enterprise': 'enterprise' };
  const orderedAts = plans.filter((plan) => atsLanes[plan.id]).sort((left, right) =>
    Number(plannedBoards(atsLanes[right.id]).some((board) => board.puneRelevant === true))
    - Number(plannedBoards(atsLanes[left.id]).some((board) => board.puneRelevant === true)));
  let atsIndex = 0;
  return [...plans.map((plan) => atsLanes[plan.id] ? orderedAts[atsIndex++] : plan), careerPagePlan, ...hnPlans, ...ycPlans];
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
    return requestWithDeadline(transport, url.toString(), { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal: meta.signal, deadline: meta.deadline }, { signal: meta.signal ?? null, deadline: meta.deadline ?? null });
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
  const databasePath = path.resolve(config.databasePath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const store = suppliedStore ?? openCrawlerStore(databasePath);
  try {
    const linkedInPolicy = createLinkedInGuestPolicy({ transport, store, runAt, clock });
    const resolver = createCrawlerRunResolver({ config, transport: linkedInPolicy.transport, runAt, signal, deadline });
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
    let durablePlannerState = null;
    if (config.boardRegistry || config.boardRegistryPath || config.sourcePlanner?.enabled === true) {
      const rawPlannerState = store.prepare('SELECT cursor_json FROM sources WHERE source_id = ?').get('ats-warm')?.cursor_json;
      try { durablePlannerState = rawPlannerState ? JSON.parse(rawPlannerState).sourcePlanState ?? null : null; } catch { durablePlannerState = null; }
    }
    const plannerConfig = durablePlannerState
      ? { ...config.sourcePlanner, state: durablePlannerState }
      : config.sourcePlanner;
    const effectiveCrawlerConfig = plannerConfig ? { ...config, sourcePlanner: plannerConfig } : config;
    let pendingPlannerState = null;
    let result = await crawlWorkflow({
      store,
      runId: runId ?? dailyRunIdentity({ schedule, mode, locationPreset, at: runAt }),
      schedule,
      config: { ...effectiveCrawlerConfig, discoveryProfile: profile },
      clock,
      priorLifecycleRows: lifecycleRows,
      historicalRows,
      v4Snapshot,
      sourcePlans: buildSourcePlans({
        linkedInPolicy,
        config: effectiveCrawlerConfig,
        transport,
        runAt,
        clock,
        schedule,
        resolver,
        profile,
        signal,
        deadline,
        onSourcePlanState: (state) => { pendingPlannerState = state; },
        portalCandidateScreen: (candidate) => screenPortalCandidate(candidate, policy),
      }),
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
    const completedCrawlerRun = ['completed', 'completed_with_failures'].includes(result.run?.status);
    if (pendingPlannerState && completedCrawlerRun) {
      persistSourcePlanState(store, 'ats-warm', pendingPlannerState, runAt);
      result = {
        ...result,
        sourceTelemetry: {
          ...result.sourceTelemetry,
          'ats-warm': {
            ...(result.sourceTelemetry?.['ats-warm'] ?? {}),
            sourcePlanState: pendingPlannerState,
          },
        },
      };
    }
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
