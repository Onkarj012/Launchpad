import {
  buildSourcePlans,
  crawlerDiscoveryPlan,
  defaultHttpTransport,
  runCrawlerOperator,
  validateCrawlerConfig,
} from './operator.mjs';
import { crawlWorkflow } from './workflow.mjs';
import { fetchWarmAts } from './ats-warm.mjs';
import { loadWarmSet, warmEntries, WARM_ATS } from '../job-pull/warm-set.mjs';
import { runNormalMode } from '../job-pull/normal-mode.mjs';

function runAtFrom(clock) {
  const value = typeof clock === 'function'
    ? clock()
    : typeof clock?.now === 'function'
      ? clock.now()
      : clock;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError('invalid injected clock value');
  return date.toISOString();
}

function crawlerClock(clock, runAt) {
  return {
    ...(clock && typeof clock === 'object' ? clock : {}),
    now: () => runAt,
  };
}

function warmOnlyConfig(config) {
  const sources = config.sources ?? {};
  return {
    ...config,
    sources: {
      atsWarm: sources.atsWarm ?? { boards: [] },
      atsBatch1: { boards: [] },
      atsBatch2: { boards: [] },
      enterprise: { boards: [] },
      careerSites: [],
      brave: { enabled: false },
      indeed: { enabled: false },
      connectorInbox: { enabled: false },
      indiaStartup: { enabled: false },
      commercialRescue: { enabled: false },
    },
  };
}

function trackedBoards(config) {
  const file = config.reverseWarmSetPath
    ?? config.sources?.trackedAts?.warmSetPath
    ?? 'config/reverse-warm-set.json';
  const set = loadWarmSet(file);
  const boards = [];
  for (const provider of WARM_ATS) {
    for (const slug of set.boards?.[provider] ?? []) {
      const entry = warmEntries({ ...set, boards: { ...set.boards, [provider]: [slug] } }, provider)[0];
      if (entry) boards.push({ provider, slug, careersUrl: entry.careers_url });
    }
  }
  return boards;
}

function failureMessages(failures) {
  return failures.map((failure) => [
    failure.provider,
    failure.board,
    failure.code,
    failure.message,
  ].filter(Boolean).join(': '));
}

function fixtureStatus(candidates, failures) {
  if (failures.length) return candidates.length ? 'degraded' : 'failed';
  return candidates.length ? 'ok' : 'empty';
}

function crawlerFixture(result) {
  const candidates = result.observations.filter((observation) => observation.sourceId === 'ats-warm');
  const failures = result.failures.filter((failure) => failure.sourceId === 'ats-warm');
  return {
    candidates,
    manifest: {
      ...(result.sourceTelemetry['ats-warm'] ?? {}),
      status: fixtureStatus(candidates, failures),
      errors: failureMessages(failures),
    },
  };
}

function trackedFixture(result) {
  return {
    candidates: result.observations,
    manifest: {
      ...result.manifest,
      status: fixtureStatus(result.observations, result.failures),
      errors: failureMessages(result.failures),
    },
  };
}

async function runCrawlerWarm({ config, transport, clock, runAt, runId, store }) {
  const crawlerConfig = validateCrawlerConfig(warmOnlyConfig(config));
  const crawlerRunId = `${runId}-crawler-v2`;
  if (!store) {
    return runCrawlerOperator({
      config: crawlerConfig,
      transport,
      clock,
      runId: crawlerRunId,
      schedule: 'morning',
      mode: 'normal',
      locationPreset: 'india',
    });
  }

  const { profile } = crawlerDiscoveryPlan(crawlerConfig, {
    schedule: 'morning',
    mode: 'normal',
    locationPreset: 'india',
  });
  const sourcePlans = buildSourcePlans({
    config: crawlerConfig,
    transport,
    runAt,
    clock,
    schedule: 'morning',
    profile,
  }).filter((plan) => plan.id === 'ats-warm');
  return crawlWorkflow({
    store,
    runId: crawlerRunId,
    schedule: 'morning',
    config: { ...crawlerConfig, discoveryProfile: profile },
    clock,
    sourcePlans,
  });
}

export async function runDailyNormal({
  config,
  transport = defaultHttpTransport,
  clock,
  runId,
  historicalV4Rows = [],
  notionGateway,
  executeGateway = false,
  conversionPlan,
  ledgerRows,
  opportunityLedgerRows,
  store,
  sourceFunctions = {},
  sourceFixtures = {},
  laneInputs = {},
} = {}) {
  const runAt = runAtFrom(clock);
  const effectiveRunId = runId ?? `daily-normal-${runAt}`;
  const effectiveClock = crawlerClock(clock, runAt);
  const crawlerResult = await runCrawlerWarm({
    config,
    transport,
    clock: effectiveClock,
    runAt,
    runId: effectiveRunId,
    store,
  });
  const trackedResult = await fetchWarmAts({
    ...(config.sources?.trackedAts ?? {}),
    boards: trackedBoards(config),
    transport,
    runAt,
  });
  const result = await runNormalMode({
    clock: () => runAt,
    runId: effectiveRunId,
    sourceFunctions,
    sourceFixtures: {
      'reverse-ats-warm': crawlerFixture(crawlerResult),
      'tracked-ats': trackedFixture(trackedResult),
      ...sourceFixtures,
    },
    laneInputs,
    historicalV4Rows,
    notionGateway,
    executeGateway,
    conversionPlan,
    ledgerRows,
    opportunityLedgerRows,
  });
  return {
    ...result,
    crawlerV2Telemetry: crawlerResult.sourceTelemetry,
  };
}

export default runDailyNormal;
