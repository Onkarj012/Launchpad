import fs from 'node:fs';
import path from 'node:path';
import { fetchAtsBatch1 } from './ats-batch-1.mjs';
import { fetchWarmAts } from './ats-warm.mjs';
import { discoverBraveSearch } from './brave-search.mjs';
import { createChromiumFallbackTransport } from './chromium-fallback.mjs';
import { discoverAtsBatch2 } from './ats-batch-2.mjs';
import { discoverEnterpriseAts } from './ats-enterprise.mjs';
import { importIndeedInbox } from './indeed-inbox.mjs';
import { discoverIndiaStartupLanes } from './india-startup-lanes.mjs';
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
import { normalizeCandidate } from '../job-pull/candidate.mjs';

export const CRAWLER_CONFIG_VERSION = 'LaunchpadCrawlerConfigV1';

export function buildCrawlerHelp() {
  return `Launchpad Crawler v2

Usage:
  node crawler/cli.mjs validate [--config FILE]
  node crawler/cli.mjs plan [morning|midday] [--config FILE]
  node crawler/cli.mjs run [morning|midday] [--config FILE] [--run-id ID]
  node crawler/cli.mjs readiness [--run-tests] [--operational-evidence FILE]

The crawler performs discovery and produces a planning-only handoff. It never applies or sends.
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
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.headers,
    signal: options.signal,
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

function sourcePlan(id, lane, provider, fetcher) {
  return { id, lane, provider, trustClass: 'direct', fetch: fetcher };
}

function buildSourcePlans({ config, transport, runAt, clock, schedule }) {
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
  })));
  if (schedule !== 'midday' && sources.indiaStartup?.enabled) plans.push(sourcePlan('india-startup', 'brave-startup', 'india-startup', async () => discoverIndiaStartupLanes({
    ...sources.indiaStartup,
    transport,
    runAt,
  })));
  if (schedule !== 'midday' && sources.searxng?.enabled) plans.push(sourcePlan('searxng-search', 'web-discovery', 'searxng', async () => {
    if (!sources.searxng.endpoint) throw new Error('SearXNG is enabled but endpoint is unavailable');
    return discoverBraveSearch({
      ...sources.searxng,
      provider: 'searxng',
      transport: async (query) => {
        const url = new URL('/search', sources.searxng.endpoint);
        url.searchParams.set('q', query);
        url.searchParams.set('format', 'json');
        const response = await transport(url.toString(), { headers: { Accept: 'application/json' } });
        const body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
        return { ...response, body: { results: body?.results ?? [] } };
      },
      runAt,
    });
  }));
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

export async function runCrawlerOperator({
  config,
  runId,
  schedule = 'morning',
  transport = defaultHttpTransport,
  clock = {},
} = {}) {
  validateCrawlerConfig(config);
  crawlerSchedulePlan(config, schedule);
  const nowValue = typeof clock.now === 'function' ? clock.now() : new Date().toISOString();
  const runAt = nowValue instanceof Date ? nowValue.toISOString() : String(nowValue);
  const databasePath = path.resolve(config.databasePath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const store = openCrawlerStore(databasePath);
  try {
    const policy = loadJobPullPolicy();
    const lifecycleRows = readOpportunityLedger(config.opportunityLedgerPath).rows;
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
      config,
      clock,
      priorLifecycleRows: lifecycleRows,
      sourcePlans: buildSourcePlans({ config, transport, runAt, clock, schedule }),
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
          config,
          clock,
          priorLifecycleRows: lifecycleRows,
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
    return { ...result, operator: { databasePath, schedule, configVersion: config.schemaVersion } };
  } finally {
    store.close();
  }
}
