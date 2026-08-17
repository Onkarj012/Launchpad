import path from 'node:path';
import {
  defaultHttpTransport,
  runCrawlerOperator,
  validateCrawlerConfig,
} from './operator.mjs';
import { fetchWarmAts } from './ats-warm.mjs';
import {
  DEFAULT_BOARD_ROTATION_STATE_PATH,
  loadBoardRotationState,
  saveBoardRotationState,
} from './board-rotation-state.mjs';
import { loadWarmSet, warmEntries, WARM_ATS } from '../job-pull/warm-set.mjs';
import { projectTrackedBoards, resolveBoardRegistry } from './board-registry.mjs';
import { runNormalMode } from '../job-pull/normal-mode.mjs';
import { runStartupMode } from '../job-pull/startup-mode.mjs';
import { runRemoteMode } from '../job-pull/remote-mode.mjs';
import { candidateDedupKey } from '../job-pull/candidate.mjs';
import { recordSurfaced } from '../job-pull/opportunity-ledger.mjs';
import { createCodexScorer } from '../job-pull/match-scorer.mjs';
import { readV4HistorySnapshot } from './v4-history-snapshot.mjs';
import { computeDeliveryInventoryIdentity, prepareDeliveryCanary } from './delivery-canary.mjs';
import { computeCanaryVersion } from './canary-evaluator.mjs';

export function createDailyExecution(config, runAt) {
  const deadlineMs = Math.max(1, Number(config?.execution?.wholeRunDeadlineMs ?? 2_520_000) || 2_520_000);
  const reserveMs = Math.max(0, Number(config?.execution?.downstreamReserveMs ?? 300_000) || 300_000);
  const scorerFloorMs = Math.max(1, Number(config?.execution?.scorerFloorMs ?? 300_000) || 300_000);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error(`daily execution deadline exceeded after ${deadlineMs}ms`);
    error.code = 'DAILY_DEADLINE_EXCEEDED';
    controller.abort(error);
  }, deadlineMs);
  return {
    runAt,
    signal: controller.signal,
    deadlineMs,
    reserveMs,
    scorerFloorMs,
    startedAt,
    remainingMs: () => Math.max(0, deadlineMs - (Date.now() - startedAt)),
    sourceBudget() {
      return {
        deadlineMs: startedAt + deadlineMs - reserveMs,
        remainingMs: Math.max(0, deadlineMs - (Date.now() - startedAt) - reserveMs),
        reserveMs,
      };
    },
    cleanup() { clearTimeout(timer); },
  };
}

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

export const CRAWLER_SOURCE_TO_NORMAL_LANE = Object.freeze({
  'ats-warm': 'reverse-ats-warm',
  'ats-batch-1': 'expanded-ats',
  'ats-batch-2': 'expanded-ats',
  'ats-enterprise': 'expanded-ats',
  'career-sites': 'structured-career-pages',
  'remote-mode': 'native-remote-feeds',
  'indeed-inbox': 'indeed',
  'connector-inbox': 'connector-inbox',
  theirstack: 'connector-inbox',
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

const DAILY_MODES = new Set(['normal', 'startup', 'remote']);
const STARTUP_LANE_IDS = new Set([
  'startup-employer-boards', 'vc-portfolio-boards', 'yc', 'wellfound',
  'india-startup-directories', 'startup-watchlist', 'funding-hiring-signals',
]);
const REMOTE_LANE_IDS = new Set([
  'remote-ats', 'yc', 'wellfound', 'bounded-remote-search',
  'himalayas', 'jobicy', 'weworkremotely', 'remotive', 'remoteok',
]);
const SHARED_DIRECT_ATS_SOURCES = new Set([
  'ats-warm', 'ats-batch-1', 'ats-batch-2', 'ats-enterprise', 'career-sites', 'tracked-ats',
]);
const ATS_PROVIDERS = new Set([
  'ashby', 'breezy', 'greenhouse', 'lever', 'recruitee', 'smartrecruiters', 'workable', 'workday',
]);

export function normalizeDailyMode(mode = 'normal') {
  const normalized = String(mode).trim().toLowerCase();
  if (!DAILY_MODES.has(normalized)) throw new TypeError(`unknown daily mode: ${mode}`);
  return normalized;
}

function candidateIdentity(candidate) {
  return candidate?.canonicalUrl
    || [candidate?.provider, candidate?.providerJobId ?? candidate?.jobId, candidateDedupKey(candidate)].filter(Boolean).join('|');
}

function isSharedDirectAts(candidate, sourceId) {
  return SHARED_DIRECT_ATS_SOURCES.has(sourceId)
    || candidate?.sourceKind === 'ats-direct'
    || candidate?.classification === 'direct'
    || ATS_PROVIDERS.has(String(candidate?.provider || '').toLowerCase());
}

function retainedEvidenceText(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return Boolean(text) && !/^(?:warm ATS board tagged startup|startup source lane|explicit company stage):/i.test(text);
}

function structuredStartupEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return [
    value.evidenceRef,
    value.ref,
    value.url,
    value.sourceUrl,
    value.stageEvidence,
    value.careerPageUrl,
    value.atsBoardUrl,
    typeof value.source === 'object'
      ? value.source?.evidenceRef || value.source?.ref || value.source?.url || value.source?.sourceUrl
      : null,
  ].some(retainedEvidenceText);
}

function hasStartupEvidence(candidate) {
  const stage = String(candidate?.companyStage || candidate?.companyRecord?.stage || '').trim().toLowerCase();
  if (!['startup', 'scale-up'].includes(stage)) return false;
  return [
    candidate?.startupStageEvidenceRef,
    candidate?.companyStageEvidence,
    candidate?.companyRecord?.stageEvidence,
    candidate?.companyRecord?.evidenceRef,
    candidate?.startupEvidence,
  ].some(retainedEvidenceText)
    || structuredStartupEvidence(candidate?.companyRecord?.evidence)
    || structuredStartupEvidence(candidate?.startupEvidence)
    || structuredStartupEvidence(candidate?.evidence?.startup);
}

function focusedManifest(modeLaneId, sourceIds, candidates, result) {
  const telemetrySources = Object.fromEntries(sourceIds.map((sourceId) => [sourceId, result.sourceTelemetry?.[sourceId] ?? {}]));
  const sourceFailures = (result.failures ?? [])
    .filter((failure) => sourceIds.includes(failure.sourceId))
    .map((failure) => ({ ...failure }));
  const telemetryErrors = sourceIds
    .map((sourceId) => result.sourceTelemetry?.[sourceId]?.error)
    .filter(Boolean)
    .map((message) => ({ sourceId: modeLaneId, message }));
  const failures = [...sourceFailures, ...telemetryErrors];
  return {
    sourceId: modeLaneId,
    sourceIds,
    status: fixtureStatus(candidates, failures),
    attempted: true,
    fetched: candidates.length,
    errors: failureMessages(failures),
    telemetry: {
      sourceIds,
      sources: telemetrySources,
      observations: candidates.length,
      failures: failures.length,
    },
  };
}

function resultSourceId(observation) {
  return observation?.sourceId || observation?.source || observation?.provider || 'shared-crawler';
}

function focusedModeFixtures(result, mode, callerFixtures = {}) {
  const laneIds = mode === 'startup' ? STARTUP_LANE_IDS : REMOTE_LANE_IDS;
  const entries = result.observations.map((candidate) => {
    const sourceId = resultSourceId(candidate);
    const existingLaneId = candidate?.[`${mode}LaneId`];
    const laneId = laneIds.has(existingLaneId)
      ? existingLaneId
      : isSharedDirectAts(candidate, sourceId) && (mode !== 'startup' || hasStartupEvidence(candidate))
        ? (mode === 'startup' ? 'startup-employer-boards' : 'remote-ats')
        : null;
    return { candidate, sourceId, laneId };
  }).filter((entry) => entry.laneId);

  // Native focused candidates win a canonical identity before shared direct/ATS
  // candidates are projected into the focused fallback lane.
  entries.sort((left, right) => (
    Number(laneIds.has(right.candidate?.[`${mode}LaneId`]))
    - Number(laneIds.has(left.candidate?.[`${mode}LaneId`]))
  ));
  const seen = new Set();
  const lanes = new Map();
  const add = (laneId, candidate, sourceId) => {
    const identity = candidateIdentity(candidate);
    if (!identity || seen.has(identity)) return;
    seen.add(identity);
    const lane = lanes.get(laneId) ?? { candidates: [], sourceIds: new Set() };
    lane.candidates.push(candidate);
    lane.sourceIds.add(sourceId);
    lanes.set(laneId, lane);
  };
  for (const entry of entries) add(entry.laneId, entry.candidate, entry.sourceId);

  // Carry attempted shared-lane failures into the focused fallback lane even
  // when that source produced no observation.
  const fallbackLane = mode === 'startup' ? 'startup-employer-boards' : 'remote-ats';
  const sharedSourceIds = new Set([
    ...Object.keys(result.sourceTelemetry ?? {}).filter((sourceId) => SHARED_DIRECT_ATS_SOURCES.has(sourceId)),
    ...(result.failures ?? []).map((failure) => failure.sourceId).filter((sourceId) => SHARED_DIRECT_ATS_SOURCES.has(sourceId)),
  ]);
  if (sharedSourceIds.size) {
    const lane = lanes.get(fallbackLane) ?? { candidates: [], sourceIds: new Set() };
    for (const sourceId of sharedSourceIds) lane.sourceIds.add(sourceId);
    lanes.set(fallbackLane, lane);
  }

  // Explicit fixtures remain supported as a deterministic injection seam. They
  // are merged by canonical identity so a fixture cannot duplicate a crawler row.
  for (const laneId of laneIds) {
    const fixture = callerFixtures[laneId];
    if (!fixture) continue;
    for (const candidate of fixture.candidates ?? fixture.records ?? []) add(laneId, candidate, laneId);
  }

  return Object.fromEntries([...lanes.entries()].map(([laneId, lane]) => [laneId, {
    candidates: lane.candidates,
    manifest: (() => {
      const generated = focusedManifest(laneId, [...lane.sourceIds], lane.candidates, result);
      const supplied = callerFixtures[laneId]?.manifest ?? {};
      return {
        ...generated,
        ...supplied,
        sourceId: laneId,
        sourceIds: [...new Set([...lane.sourceIds, ...(supplied.sourceIds ?? [])])],
        fetched: lane.candidates.length,
        errors: [...new Set([...generated.errors, ...(supplied.errors ?? [])])],
        status: supplied.status === 'failed'
          ? 'failed'
          : generated.status === 'degraded' || supplied.status === 'degraded'
            ? 'degraded'
            : generated.status,
      };
    })(),
  }]));
}

export function buildFocusedModeFixtures(result, mode, callerFixtures = {}) {
  const normalizedMode = normalizeDailyMode(mode);
  if (normalizedMode === 'normal') return { ...crawlerLaneFixtures(result), ...callerFixtures };
  return focusedModeFixtures(result, normalizedMode, callerFixtures);
}

export const DAILY_MODE_RUNNERS = Object.freeze({
  normal: runNormalMode,
  startup: runStartupMode,
  remote: runRemoteMode,
});

async function runCrawlerFull({
  config,
  transport,
  clock,
  runId,
  store,
  schedule = 'morning',
  mode = 'normal',
  locationPreset = 'india',
  signal = null,
  deadline = null,
}) {
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
    signal,
    deadline,
  });
}

async function runDailyNormalImpl({
  config,
  transport = defaultHttpTransport,
  clock,
  runId,
  historicalV4Rows,
  notionGateway,
  executeGateway = false,
  conversionPlan,
  ledgerRows,
  opportunityLedgerRows,
  opportunityLedgerPath,
  opportunityLedgerWriter = recordSurfaced,
  scores,
  scorer = null,
  store,
  canaryStore,
  canaryEvidence = null,
  canaryValidationOptions = {},
  schedule = 'morning',
  mode = 'normal',
  locationPreset = 'india',
  sourceFunctions = {},
  sourceFixtures = {},
  laneInputs = {},
  execution = null,
} = {}) {
  const runAt = runAtFrom(clock);
  const dailyExecution = execution ?? createDailyExecution(config, runAt);
  const selectedMode = normalizeDailyMode(mode);
  const effectiveRunId = runId ?? `daily-${schedule}-${selectedMode}-${runAt}`;
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
    store,
    schedule,
    mode: selectedMode,
    locationPreset,
    signal: dailyExecution.signal,
    deadline: dailyExecution.sourceBudget(),
  });
  const defaultRotationStatePath = config.databasePath ? path.join(path.dirname(config.databasePath), 'board-rotation-state.json') : DEFAULT_BOARD_ROTATION_STATE_PATH;
  const rotationStatePath = config.sources?.trackedAts?.rotationStatePath ?? defaultRotationStatePath;
  const rotationState = loadBoardRotationState(rotationStatePath);
  const trackedResult = await fetchWarmAts({
    ...(config.sources?.trackedAts ?? {}),
    boards: trackedBoards(config),
    transport,
    runAt,
    signal: dailyExecution.signal,
    deadline: dailyExecution.sourceBudget(),
    requestTimeoutMs: config.sources?.trackedAts?.requestTimeoutMs ?? 10_000,
    maxDurationMs: config.sources?.trackedAts?.maxDurationMs ?? Math.max(1, dailyExecution.remainingMs() - dailyExecution.reserveMs),
    boardConcurrency: config.sources?.trackedAts?.boardConcurrency ?? 2,
    rotation: { enabled: true, providerQuotas: config.sources?.trackedAts?.rotationProviderQuotas ?? { ashby: 1, greenhouse: 1, lever: 1 } },
    rotationState,
  });
  saveBoardRotationState(rotationStatePath, trackedResult.rotationState, runAt);
  const sharedCrawlerResult = {
    ...crawlerResult,
    observations: [
      ...crawlerResult.observations,
      ...trackedResult.observations.map((candidate) => ({ ...candidate, sourceId: 'tracked-ats' })),
    ],
    failures: [...crawlerResult.failures, ...trackedResult.failures],
    sourceTelemetry: { ...crawlerResult.sourceTelemetry, 'tracked-ats': trackedResult.manifest },
  };
  const modeRunner = DAILY_MODE_RUNNERS[selectedMode];
  const sharedFixtures = buildFocusedModeFixtures(sharedCrawlerResult, selectedMode, sourceFixtures);
  const result = await modeRunner({
    clock: () => runAt,
    runId: effectiveRunId,
    // Focused modes consume the shared crawler observations as fixtures. This
    // prevents a second native source fetch after the one shared crawl.
    sourceFunctions: selectedMode === 'normal' ? sourceFunctions : {},
    sourceFixtures: selectedMode === 'normal'
      ? { ...crawlerLaneFixtures(crawlerResult), 'tracked-ats': trackedFixture(trackedResult), ...sourceFixtures }
      : sharedFixtures,
    laneInputs,
    mode: selectedMode,
    historicalV4Rows: effectiveHistoricalV4Rows,
    notionGateway,
    executeGateway,
    conversionPlan,
    ledgerRows,
    opportunityLedgerRows,
    opportunityLedgerPath: opportunityLedgerPath ?? config.opportunityLedgerPath,
    scores,
    commitSurfaced: false,
    // Match scoring is opt-in: 'codex' constructs the real codex CLI scorer
    // (production), an injected async function fakes it (tests). The default
    // keeps the run byte-identical to the pre-scorer behaviour — offline, no
    // child processes.
    scorer: scorer === 'codex'
      // Scoring keeps a minimum runway so discovery cannot starve the scorer.
      ? createCodexScorer({ wholeTimeoutMs: Math.max(dailyExecution.scorerFloorMs, dailyExecution.remainingMs()) })
      : (scorer ?? undefined),
    ...(selectedMode === 'normal' ? { includeCrawlerLanes: true } : {}),
    enrichmentBudget: config.sources?.enterprise?.maxDetailRequestsPerRun ?? 50,
  });
  const snapshotTelemetry = v4HistoryTelemetry(v4HistorySnapshot);
  const codeConfigVersion = computeCanaryVersion({ config });
  const discoveryProfile = {
    schedule: String(schedule).trim().toLowerCase(),
    mode: selectedMode,
    locationPreset: String(locationPreset).trim().toLowerCase(),
  };
  const inventoryIdentity = computeDeliveryInventoryIdentity(result.shortlist, result.plannedNotionOperations);
  const resolvedCanaryEvidence = typeof canaryEvidence === 'function'
    ? canaryEvidence({
      shortlist: result.shortlist,
      plannedNotionOperations: result.plannedNotionOperations,
      codeConfigVersion,
      discoveryProfile,
      inventoryIdentity,
    })
    : canaryEvidence;
  const { record: deliveryCanary } = prepareDeliveryCanary({
    run: {
      ...result,
      v4HistorySnapshot: snapshotTelemetry,
      canaryConfig: config,
      codeConfigVersion,
      discoveryProfile,
      inventoryIdentity,
      canaryEvidence: resolvedCanaryEvidence,
    },
    clock: effectiveClock,
    store: canaryStore,
    ...canaryValidationOptions,
  });
  const surfaced = opportunityLedgerWriter(result.shortlist, {
    path: opportunityLedgerPath ?? config.opportunityLedgerPath,
    now: runAt,
  });
  let canaryPersistenceError = null;
  try {
    canaryStore?.append?.(deliveryCanary);
  } catch (error) {
    canaryPersistenceError = {
      stage: 'delivery-canary-persistence',
      name: error.name || 'Error',
      code: error.code ?? null,
      message: error.message || String(error),
    };
  }
  const outcome = canaryPersistenceError
    ? {
      ...(result.outcome ?? {}),
      status: 'degraded',
      fatal: false,
      degraded: true,
      errors: [...(result.outcome?.errors ?? []), canaryPersistenceError],
    }
    : result.outcome;
  return {
    ...result,
    outcome,
    crawlerV2Telemetry: Object.fromEntries(Object.entries(crawlerResult.sourceTelemetry ?? {}).map(([sourceId, telemetry]) => [sourceId, {
      ...telemetry,
      durationMs: crawlerResult.run?.telemetry?.sourceDurations?.[sourceId] ?? null,
    }])),
    v4HistorySnapshot: snapshotTelemetry,
    deliveryCanary: canaryPersistenceError
      ? {
        ...deliveryCanary,
        valid: false,
        preparedValid: deliveryCanary.valid === true,
        invalidReasons: [...deliveryCanary.invalidReasons, `canary persistence failed: ${canaryPersistenceError.message}`],
        persisted: false,
      }
      : { ...deliveryCanary, persisted: typeof canaryStore?.append === 'function' ? true : null },
    canaryPersistenceError,
    surfaced,
    telemetry: {
      ...(result.telemetry ?? {}),
      v4HistorySnapshot: snapshotTelemetry,
    },
  };
}

export async function runDailyNormal(options = {}) {
  const selectedMode = normalizeDailyMode(options.mode);
  const runAt = runAtFrom(options.clock);
  const execution = createDailyExecution(options.config ?? {}, runAt);
  try {
    return await runDailyNormalImpl({ ...options, mode: selectedMode, execution });
  } finally {
    execution.cleanup();
  }
}

export default runDailyNormal;
