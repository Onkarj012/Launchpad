import path from 'node:path';
import {
  defaultHttpTransport,
  runCrawlerOperator,
  validateCrawlerConfig,
} from './operator.mjs';
import { fetchWarmAts } from './ats-warm.mjs';
import { loadWarmSet, warmEntries, WARM_ATS } from '../job-pull/warm-set.mjs';
import { boardIdentityKey, projectTrackedBoards, resolveBoardRegistry } from './board-registry.mjs';
import { runNormalMode } from '../job-pull/normal-mode.mjs';
import { createCodexScorer } from '../job-pull/match-scorer.mjs';
import { readV4HistorySnapshot } from './v4-history-snapshot.mjs';
import { recordDeliveryCanary } from './delivery-canary.mjs';
import { dailyRunIdentity } from './scheduler.mjs';
import { crawlerRunLockPath, withCrawlerRunLock } from './run-lock.mjs';
import { sourceFailureHistogram } from './run.mjs';

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

function v4HistoryTelemetry(snapshot) {
  return {
    status: snapshot.status,
    path: snapshot.path,
    generatedAt: snapshot.generatedAt,
    rowCount: snapshot.rowCount,
    error: snapshot.error ?? null,
    warning: snapshot.status === 'stale'
      ? `v4 history snapshot is stale: ${snapshot.path}`
      : null,
  };
}

function trackedBoards(config) {
  // Unified registry is authoritative when wired; reverse-warm-set remains the
  // legacy / test-fixture input path.
  const registry = resolveBoardRegistry(config);
  if (registry) return projectTrackedBoards(registry);

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

export { trackedBoards };

export function partitionTrackedScan(config) {
  const configured = trackedBoards(config);
  const registry = resolveBoardRegistry(config);
  const covered = new Set();
  if (registry) {
    for (const board of registry.boards ?? []) {
      if (board.enabled && board.activationState !== 'proposed') covered.add(board.id || boardIdentityKey(board));
    }
  } else {
    for (const board of config.sources?.atsWarm?.boards ?? []) covered.add(board.id || board.registryId || boardIdentityKey(board));
    for (const board of config.sources?.enterprise?.boards ?? []) covered.add(board.id || board.registryId || boardIdentityKey(board));
  }
  const boards = [];
  const omissions = [];
  for (const board of configured) {
    const boardId = board.id || board.registryId || boardIdentityKey(board);
    if (covered.has(boardId)) omissions.push({ boardId, provider: board.provider, reason: 'covered-by-crawler-source-plan' });
    else boards.push(board);
  }
  return { configured, boards, omissions };
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

function truthfulDailyOutcome(result) {
  if (result.outcome?.fatal) return result;
  const degradedSources = result.sourceManifests
    .filter((manifest) => manifest.attempted !== false && manifest.status === 'degraded')
    .map((manifest) => manifest.sourceId);
  if (!degradedSources.length) return result;
  const issues = result.sourceManifests
    .filter((manifest) => degradedSources.includes(manifest.sourceId))
    .map((manifest) => ({ sourceId: manifest.sourceId, status: manifest.status, errors: manifest.errors ?? [] }));
  return {
    ...result,
    shortfall: {
      ...result.shortfall,
      degradedLanes: [...new Set([...(result.shortfall?.degradedLanes ?? []), ...degradedSources])],
      reasons: [...new Set([...(result.shortfall?.reasons ?? []), ...degradedSources.map((sourceId) => `SOURCE_DEGRADED:${sourceId}`)])],
    },
    outcome: {
      ...result.outcome,
      status: 'degraded',
      degraded: true,
      errors: [...(result.outcome?.errors ?? []), ...issues],
    },
  };
}

export const CRAWLER_SOURCE_TO_NORMAL_LANE = Object.freeze({
  'ats-warm': 'reverse-ats-warm',
  'ats-batch-1': 'expanded-ats',
  'ats-batch-2': 'expanded-ats',
  'ats-enterprise': 'expanded-ats',
  'career-sites': 'structured-career-pages',
  'remote-mode': 'native-remote-feeds',
  'indeed-inbox': 'indeed',
  'connector-inbox': 'connector-inbox',
  'brave-search': 'web-discovery',
  'searxng-search': 'web-discovery',
  'india-startup': 'web-discovery',
  'startup-mode': 'web-discovery',
  'commercial-rescue': 'web-discovery',
});

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function crawlerLaneFixtures(result) {
  const observationsByLane = new Map();
  const sourceIds = new Set([
    ...Object.keys(result.sourceTelemetry ?? {}),
    ...result.observations.map((observation) => observation.sourceId).filter(Boolean),
    ...result.failures.map((failure) => failure.sourceId).filter(Boolean),
  ]);
  for (const sourceId of sourceIds) {
    const laneId = CRAWLER_SOURCE_TO_NORMAL_LANE[sourceId] ?? 'web-discovery';
    if (!observationsByLane.has(laneId)) observationsByLane.set(laneId, { sourceIds: [], candidates: [], failures: [], unmappedSourceIds: [] });
    const lane = observationsByLane.get(laneId);
    lane.sourceIds.push(sourceId);
    if (!CRAWLER_SOURCE_TO_NORMAL_LANE[sourceId]) lane.unmappedSourceIds.push(sourceId);
    lane.candidates.push(...result.observations.filter((observation) => observation.sourceId === sourceId));
    lane.failures.push(...result.failures.filter((failure) => failure.sourceId === sourceId));
  }

  return Object.fromEntries([...observationsByLane.entries()].map(([laneId, lane]) => {
    const telemetry = Object.fromEntries(lane.sourceIds.map((sourceId) => [sourceId, result.sourceTelemetry?.[sourceId] ?? {}]));
    const telemetryErrors = lane.sourceIds
      .map((sourceId) => result.sourceTelemetry?.[sourceId]?.error)
      .filter(Boolean)
      .map((message) => ({ message }));
    const failures = [...lane.failures, ...telemetryErrors];
    const searchTelemetry = lane.sourceIds
      .map((sourceId) => result.sourceTelemetry?.[sourceId]?.detail?.telemetry)
      .filter((value) => value && typeof value === 'object');
    const queryDiagnostics = searchTelemetry.flatMap((value) => Array.isArray(value.queryDiagnostics) ? value.queryDiagnostics : []);
    const unresponsiveEngineEvents = searchTelemetry.flatMap((value) => Array.isArray(value.unresponsiveEngineEvents) ? value.unresponsiveEngineEvents : []);
    const engineHealth = [...new Set(searchTelemetry.map((value) => value.engineHealth).filter(Boolean))];
    const mergedTelemetry = {
      sourceIds: lane.sourceIds,
      sources: telemetry,
      attempts: lane.sourceIds.reduce((sum, sourceId) => sum + number(telemetry[sourceId].attempts), 0),
      fetched: lane.sourceIds.reduce((sum, sourceId) => sum + number(telemetry[sourceId].fetched), 0),
      changed: lane.sourceIds.reduce((sum, sourceId) => sum + number(telemetry[sourceId].changed), 0),
      observations: lane.candidates.length,
      failures: failures.length,
      ...(queryDiagnostics.length ? { queryDiagnostics } : {}),
      ...(unresponsiveEngineEvents.length ? { unresponsiveEngineEvents } : {}),
      ...(engineHealth.length ? { engineHealth: engineHealth.length === 1 ? engineHealth[0] : engineHealth } : {}),
    };
    return [laneId, {
      candidates: lane.candidates,
      manifest: {
        sourceId: laneId,
        sourceIds: lane.sourceIds,
        status: fixtureStatus(lane.candidates, failures),
        attempted: true,
        fetched: lane.candidates.length,
        errors: failureMessages(failures),
        ...(lane.unmappedSourceIds.length ? { unmappedSourceIds: lane.unmappedSourceIds } : {}),
        telemetry: mergedTelemetry,
      },
    }];
  }));
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

async function runCrawlerFull({ config, transport, clock, runId, schedule, mode, locationPreset, store }) {
  const crawlerConfig = validateCrawlerConfig(config);
  const crawlerRunId = `${runId}-crawler-v2`;
  return runCrawlerOperator({
    config: crawlerConfig,
    transport,
    clock,
    runId: crawlerRunId,
    schedule,
    mode,
    locationPreset,
    store,
  });
}

async function runDailyNormalUnlocked({
  config,
  configPath = null,
  databasePath = null,
  environment = null,
  transport = defaultHttpTransport,
  clock,
  schedule = 'morning',
  mode = 'normal',
  locationPreset = 'india',
  runId,
  historicalV4Rows,
  notionGateway,
  executeGateway = false,
  conversionPlan,
  ledgerRows,
  opportunityLedgerRows,
  scores,
  scorer = null,
  store,
  canaryStore,
  sourceFunctions = {},
  sourceFixtures = {},
  laneInputs = {},
} = {}) {
  const runAt = runAtFrom(clock);
  const effectiveRunId = runId ?? dailyRunIdentity({ schedule, at: runAt });
  const effectiveClock = crawlerClock(clock, runAt);
  const v4HistorySnapshot = readV4HistorySnapshot(config?.v4HistorySnapshotPath, {
    maxAgeDays: config?.v4HistorySnapshotMaxAgeDays,
    now: runAt,
  });
  const effectiveHistoricalV4Rows = historicalV4Rows === undefined
    ? v4HistorySnapshot.rows
    : historicalV4Rows;
  const crawlerResult = await runCrawlerFull({
    config,
    transport,
    clock: effectiveClock,
    runAt,
    runId: effectiveRunId,
    schedule,
    mode,
    locationPreset,
    store,
  });
  const trackedPartition = partitionTrackedScan(config);
  const trackedResult = await fetchWarmAts({
    ...(config.sources?.trackedAts ?? {}),
    boards: trackedPartition.boards,
    transport,
    runAt,
  });
  trackedResult.manifest.boardsConfigured = trackedPartition.configured.length;
  trackedResult.manifest.boardsOmitted += trackedPartition.omissions.length;
  trackedResult.manifest.omissions = [...trackedPartition.omissions, ...(trackedResult.manifest.omissions ?? [])];
  const normalResult = await runNormalMode({
    clock: () => runAt,
    runId: effectiveRunId,
    sourceFunctions,
    sourceFixtures: {
      ...crawlerLaneFixtures(crawlerResult),
      'tracked-ats': trackedFixture(trackedResult),
      ...sourceFixtures,
    },
    laneInputs,
    historicalV4Rows: effectiveHistoricalV4Rows,
    notionGateway,
    executeGateway,
    conversionPlan,
    ledgerRows,
    opportunityLedgerRows,
    scores,
    // Match scoring is opt-in: 'codex' constructs the real codex CLI scorer
    // (production), an injected async function fakes it (tests). The default
    // keeps the run byte-identical to the pre-scorer behaviour — offline, no
    // child processes.
    scorer: scorer === 'codex' ? createCodexScorer() : (scorer ?? undefined),
    includeCrawlerLanes: true,
    enrichmentBudget: config.sources?.enterprise?.maxDetailRequestsPerRun ?? 50,
  });
  const result = truthfulDailyOutcome(normalResult);
  const snapshotTelemetry = v4HistoryTelemetry(v4HistorySnapshot);
  const failureHistogram = sourceFailureHistogram(crawlerResult.sourceTelemetry, crawlerResult.failures);
  const crawlerDeadline = crawlerResult.run?.telemetry?.deadline ?? null;
  const canaryStoreWithFailures = canaryStore && {
    readRuns: () => canaryStore.readRuns?.() ?? [],
    append: (record) => canaryStore.append?.({ ...record, sourceFailureHistogram: failureHistogram, crawlerDeadline }),
  };
  const deliveryCanary = recordDeliveryCanary({
    run: { ...result, v4HistorySnapshot: snapshotTelemetry, sourceFailureHistogram: failureHistogram, crawlerDeadline },
    clock: effectiveClock,
    store: canaryStoreWithFailures,
  });
  return {
    ...result,
    crawlerV2Profile: crawlerResult.profile,
    crawlerV2Operator: crawlerResult.operator,
    crawlerV2Run: crawlerResult.run,
    sourceFailureHistogram: failureHistogram,
    crawlerDeadline,
    crawlerV2Telemetry: Object.fromEntries(Object.entries(crawlerResult.sourceTelemetry ?? {}).map(([sourceId, telemetry]) => [sourceId, {
      ...telemetry,
      durationMs: crawlerResult.run?.telemetry?.sourceDurations?.[sourceId] ?? null,
    }])),
    v4HistorySnapshot: snapshotTelemetry,
    deliveryCanary: { ...deliveryCanary, sourceFailureHistogram: failureHistogram, crawlerDeadline },
    telemetry: {
      ...(result.telemetry ?? {}),
      v4HistorySnapshot: snapshotTelemetry,
      sourceFailureHistogram: failureHistogram,
      crawlerDeadline,
    },
    receipt: {
      schemaVersion: 'LaunchpadCrawlerRunReceiptV1',
      configPath: configPath ? path.resolve(configPath) : null,
      databasePath: path.resolve(databasePath ?? config.databasePath),
      environment,
      schedule,
      mode,
      locationPreset,
      runId: effectiveRunId,
      noAutoApply: true,
      noAutoSend: true,
    },
  };
}

export async function runDailyNormal(options = {}) {
  const databasePath = options.databasePath ?? options.config?.databasePath;
  return withCrawlerRunLock(
    crawlerRunLockPath(databasePath),
    () => runDailyNormalUnlocked(options),
    {
      runId: options.runId ?? null,
      schedule: options.schedule ?? 'morning',
    },
  );
}

export default runDailyNormal;
