import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
import { boardIdentityKey, projectTrackedBoards, resolveBoardRegistry } from './board-registry.mjs';
import { runNormalMode } from '../job-pull/normal-mode.mjs';
import { PORTAL_SOURCE_LANES } from '../job-pull/normal-sources.mjs';
import { buildSourceEndStates } from './source-yield.mjs';
import { runStartupMode } from '../job-pull/startup-mode.mjs';
import { runRemoteMode } from '../job-pull/remote-mode.mjs';
import { candidateDedupKey } from '../job-pull/candidate.mjs';
import { readOpportunityLedger, recordSurfaced, repairMissingSurfaced, withOpportunityLedgerLock } from '../job-pull/opportunity-ledger.mjs';
import { createCodexScorer } from '../job-pull/match-scorer.mjs';
import { readV4HistorySnapshot } from './v4-history-snapshot.mjs';
import { computeDeliveryInventoryIdentity, prepareDeliveryCanary } from './delivery-canary.mjs';
import { computeCanaryVersion } from './canary-evaluator.mjs';
import { dailyRunIdentity } from './scheduler.mjs';
import { buildDeliveryReconciliation } from '../job-pull/mode-scoring.mjs';
import { selectNormalApplications } from '../job-pull/normal-selection.mjs';
import { readHiringEvents } from './hiring-events.mjs';

// Read retained allocations for the shared IST-day shortlist ceiling.
export function dailyShortlistBudget(budgetPath, runAt, runId) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(runAt));
  const state = existsSync(budgetPath) ? JSON.parse(readFileSync(budgetPath, 'utf8')) : { schemaVersion: 'DailyShortlistBudgetV1', days: {} };
  if (state.schemaVersion !== 'DailyShortlistBudgetV1' || !state.days || typeof state.days !== 'object' || Array.isArray(state.days)) throw new Error('invalid daily shortlist budget');
  const runs = Object.hasOwn(state.days, date) ? state.days[date] : {};
  if (!runs || typeof runs !== 'object' || Array.isArray(runs) || Object.values(runs).some((records) => !Array.isArray(records) || records.some((record) => !record || typeof record.key !== 'string' || !record.key || typeof record.company !== 'string' || typeof record.family !== 'string' || typeof record.tier !== 'string'))) throw new Error('invalid daily shortlist allocation');
  const allocations = new Map();
  for (const records of Object.values(runs)) for (const record of records) {
    const previous = allocations.get(record.key);
    if (previous && ['company', 'family', 'tier'].some((field) => previous[field] !== record[field])) throw new Error('conflicting daily shortlist allocation');
    allocations.set(record.key, record);
  }
  const previous = [...new Map(Object.entries(runs).filter(([id]) => id !== runId).flatMap(([, records]) => records).map((record) => [record.key, record])).values()];
  const otherKeys = new Set(previous.map((record) => record.key));
  const used = new Set(Object.values(runs).flat().map((record) => record.key)).size;
  if (used > 20) throw new Error('daily shortlist ceiling already exceeded');
  return { date, state, used, remaining: 20 - otherKeys.size, otherKeys: [...otherKeys], previousCandidates: previous.map((record) => ({ company: record.company, roleFamily: record.family, primaryMode: record.primaryMode ?? 'normal' })) };
}

// Retain completed local plans under a lock; partial and failed runs consume no capacity.
export function retainDailyShortlist(budgetPath, runAt, runId, shortlist) {
  return withOpportunityLedgerLock(budgetPath, () => {
    const budget = dailyShortlistBudget(budgetPath, runAt, runId);
    const existing = budget.state.days[budget.date]?.[runId] || [];
    const byKey = new Map(existing.map((record) => [record.key, record]));
    for (const candidate of shortlist) byKey.set(candidateDedupKey(candidate), { key: candidateDedupKey(candidate), company: candidate.company || '', family: candidate.roleFamily || 'adjacent-engineering', tier: candidate.selectionTier || candidate.eligibility?.tier || 'Not Verified', primaryMode: candidate.primaryMode ?? 'normal' });
    const records = [...byKey.values()];
    const keys = records.map((record) => record.key);
    if (new Set([...budget.otherKeys, ...keys]).size > 20 || keys.some((key) => budget.otherKeys.includes(key))) throw new Error('daily shortlist capacity changed before completion');
    const combined = [...Object.values(budget.state.days[budget.date] || {}).flat(), ...records];
    const companyCounts = new Map();
    for (const record of new Map(combined.map((record) => [record.key, record])).values()) {
      const company = `${record.primaryMode ?? 'normal'}|${record.company.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`;
      companyCounts.set(company, (companyCounts.get(company) || 0) + 1);
    }
    if ([...companyCounts.values()].some((count) => count > 2)) throw new Error('daily company capacity changed before completion');
    budget.state.days[budget.date] = { ...(budget.state.days[budget.date] || {}), [runId]: records };
    mkdirSync(path.dirname(budgetPath), { recursive: true });
    const temporary = `${budgetPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(budget.state, null, 2)}\n`);
    renameSync(temporary, budgetPath);
    const dailyRecords = new Map(Object.values(budget.state.days[budget.date]).flat().map((record) => [record.key, record]));
    const selectedToday = dailyRecords.size;
    const strictSelected = [...dailyRecords.values()].filter((record) => record.tier.toLowerCase() === 'strict').length;
    return { date: budget.date, minimum: 10, preferred: 12, maximum: 20, selectedToday,
      strictSelected, strictShortfall: Math.max(0, 10 - strictSelected), shortfall: Math.max(0, 10 - selectedToday),
      preferredShortfall: Math.max(0, 12 - selectedToday), previouslyAllocated: budget.used,
      selected: shortlist.length, remaining: 20 - selectedToday, path: budgetPath };

  });
}

// Read the remaining Stretch capacity for one IST day.
function dailyStretchBudget(budgetPath, runAt, runId) {
  const { date, state } = dailyShortlistBudget(budgetPath, runAt, runId);
  const days = state.stretchDays ?? {};
  if (!days || typeof days !== 'object' || Array.isArray(days)) throw new Error('invalid daily stretch allocation');
  const runs = days[date] ?? {};
  if (!runs || typeof runs !== 'object' || Array.isArray(runs) || Object.values(runs).some((records) => !Array.isArray(records) || records.some((record) => !record || typeof record.key !== 'string' || !record.key))) throw new Error('invalid daily stretch allocation');
  const otherKeys = [...new Set(Object.entries(runs).filter(([id]) => id !== runId).flatMap(([, records]) => records.map((record) => record.key)))];
  return { date, state, remaining: Math.max(0, 3 - otherKeys.length), otherKeys };
}

// Retain Stretch rows without consuming any mode shortlist capacity.
function retainDailyStretch(budgetPath, runAt, runId, stretch) {
  return withOpportunityLedgerLock(budgetPath, () => {
    const budget = dailyStretchBudget(budgetPath, runAt, runId);
    const existing = budget.state.stretchDays?.[budget.date]?.[runId] ?? [];
    const records = [...new Map([...existing, ...stretch.map((candidate) => ({ key: candidateDedupKey(candidate) }))].map((record) => [record.key, record])).values()];
    if (records.length + budget.otherKeys.length > 3 || records.some((record) => budget.otherKeys.includes(record.key))) throw new Error('daily Stretch capacity changed before completion');
    budget.state.stretchDays = {
      ...(budget.state.stretchDays ?? {}),
      [budget.date]: { ...(budget.state.stretchDays?.[budget.date] ?? {}), [runId]: records },
    };
    mkdirSync(path.dirname(budgetPath), { recursive: true });
    const temporary = `${budgetPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(budget.state, null, 2)}\n`);
    renameSync(temporary, budgetPath);
    return { date: budget.date, selectedToday: records.length + budget.otherKeys.length, remaining: 3 - records.length - budget.otherKeys.length, path: budgetPath };
  });
}

export function createDailyExecution(config, runAt) {
  const deadlineMs = Math.max(1, Number(config?.execution?.wholeRunDeadlineMs ?? 2_520_000) || 2_520_000);
  const reserveMs = Math.max(0, Number(config?.execution?.downstreamReserveMs ?? 300_000) || 300_000);
  const scorerFloorMs = Math.max(1, Number(config?.execution?.scorerFloorMs ?? 300_000) || 300_000);
  const twentyMinuteContract = deadlineMs <= 1_200_000;
  const handoffReserveMs = Math.max(0, Number(config?.execution?.handoffReserveMs ?? (twentyMinuteContract ? deadlineMs * 0.15 : 0)) || 0);
  const discoveryBudgetMs = Math.max(1, Number(config?.execution?.discoveryBudgetMs ?? (twentyMinuteContract ? deadlineMs * 0.6 : deadlineMs - reserveMs)) || 1);
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
    handoffReserveMs,
    discoveryBudgetMs,
    scorerFloorMs,
    startedAt,
    remainingMs: () => Math.max(0, deadlineMs - (Date.now() - startedAt)),
    sourceBudget() {
      return {
        deadlineMs: startedAt + Math.min(discoveryBudgetMs, deadlineMs - reserveMs - handoffReserveMs),
        remainingMs: Math.max(0, Math.min(discoveryBudgetMs, deadlineMs - reserveMs - handoffReserveMs) - (Date.now() - startedAt)),
        reserveMs,
        wallClock: true,
      };
    },
    downstreamRemainingMs() {
      return Math.max(0, deadlineMs - handoffReserveMs - (Date.now() - startedAt));
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

function terminalEnvelope({ crawlerResult = null, result = null, runId, schedule, mode, locationPreset, status = null, fatalReason = null, additionalSources = {}, lastDurableSourceState = null } = {}) {
  const crawlerEnvelope = crawlerResult?.terminalEnvelope ?? {};
  const resolvedStatus = status
    ?? (result?.outcome?.status === 'fatal' ? 'failed' : crawlerResult?.run?.status === 'partial' ? 'partial' : 'completed');
  const sourceCoverage = {
    completed: [...(crawlerEnvelope.sourceCoverage?.completed ?? [])],
    interrupted: [...(crawlerEnvelope.sourceCoverage?.interrupted ?? [])],
    failed: [...(crawlerEnvelope.sourceCoverage?.failed ?? [])],
    not_started: [...(crawlerEnvelope.sourceCoverage?.not_started ?? crawlerEnvelope.sourceCoverage?.notStarted ?? [])],
  };
  for (const [sourceId, telemetry] of Object.entries(additionalSources)) {
    const status = telemetry?.status;
    const group = ['succeeded', 'ok', 'empty', 'degraded', 'truncated'].includes(status)
      ? 'completed'
      : status === 'interrupted'
        ? 'interrupted'
        : ['failed', 'unavailable'].includes(status)
          ? 'failed'
          : 'not_started';
    if (!sourceCoverage[group].includes(sourceId)) sourceCoverage[group].push(sourceId);
  }
  for (const values of Object.values(sourceCoverage)) values.sort();
  const notStartedSources = sourceCoverage.not_started;
  const rejectionCounts = {
    ...(crawlerEnvelope.rejectionCounts ?? {}),
    ...(result?.rejectionCounts ?? {}),
  };
  return {
    schemaVersion: 'LaunchpadDailyTerminalEnvelopeV1',
    status: resolvedStatus,
    runId,
    schedule,
    mode,
    locationPreset,
    writesPlanned: resolvedStatus === 'completed' && (result?.deliveryPlan?.plannedV5OperationCount ?? result?.plannedNotionOperations?.length ?? 0) > 0,
    scoringQueue: result?.scoringQueue ?? crawlerEnvelope.scoringQueue ?? [],
    verificationQueue: result?.verificationQueue ?? crawlerEnvelope.verificationQueue ?? [],
    rejectionCounts,
    rejectionReasons: [...new Set([
      ...(crawlerEnvelope.rejectionReasons ?? []),
      ...(result?.rejectionReasons ?? []),
      ...Object.keys(rejectionCounts),
    ])].sort(),
    sourceCoverage,
    sourceEndStates: { ...(crawlerEnvelope.sourceEndStates ?? {}), ...buildSourceEndStates(additionalSources) },
    completedSources: sourceCoverage.completed,
    interruptedSources: sourceCoverage.interrupted,
    failedSources: sourceCoverage.failed,
    notStartedSources,
    not_startedSources: notStartedSources,
    fatalReason: fatalReason ?? (resolvedStatus === 'failed' ? result?.outcome?.errors?.[0]?.message ?? null : null),
    lastDurableSourceState: lastDurableSourceState ?? crawlerEnvelope.lastDurableSourceState ?? sourceCoverage,
    deliveryReconciliation: result?.deliveryReconciliation ?? null,
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

function normalizedBoardId(board) {
  const identity = boardIdentityKey(board);
  return identity ? identity.toLowerCase() : null;
}

function crawlerOwnedBoardIds(crawlerResult) {
  const telemetry = crawlerResult?.sourceTelemetry?.['ats-warm'] ?? {};
  const boardPlan = telemetry.boardPlan ?? telemetry.detail?.boardPlan;
  const owned = new Set();
  for (const decision of boardPlan?.decisions ?? []) {
    if (!['selected', 'resumed'].includes(decision.action) || decision.sourceLane !== 'atsWarm') continue;
    if (decision.boardId) owned.add(String(decision.boardId).toLowerCase());
  }
  for (const source of telemetry.sources ?? telemetry.detail?.sources ?? []) {
    const id = normalizedBoardId({ provider: source.provider, slug: source.board });
    if (id) owned.add(id);
  }
  for (const event of telemetry.healthEvents ?? telemetry.detail?.healthEvents ?? []) {
    if (event.boardId) owned.add(String(event.boardId).toLowerCase());
  }
  return owned;
}

function filterLegacyTrackedBoards(boards, ownedBoardIds) {
  const seen = new Set();
  const selected = [];
  const deduplicatedBoardIds = [];
  const omissions = [];
  for (const board of boards) {
    const id = normalizedBoardId(board);
    if (!id) continue;
    if (ownedBoardIds.has(id)) {
      if (!deduplicatedBoardIds.includes(id)) deduplicatedBoardIds.push(id);
      omissions.push({ boardId: id, provider: board.provider, reason: 'already-owned-by-ats-warm' });
      continue;
    }
    if (seen.has(id)) {
      if (!deduplicatedBoardIds.includes(id)) deduplicatedBoardIds.push(id);
      omissions.push({ boardId: id, provider: board.provider, reason: 'duplicate-normalized-board' });
      continue;
    }
    seen.add(id);
    selected.push(board);
  }
  return { selected, deduplicatedBoardIds, omissions };
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
  // Portal observations already carry their own lane id in `source`
  // (portal-linkedin-jobs, portal-glassdoor, ...). The plan-level id maps to
  // web-discovery only as a fallback for rows that lost that attribution.
  'portal-discovery': 'web-discovery',
  'brave-search': 'web-discovery',
  'searxng-search': 'web-discovery',
  'india-startup': 'web-discovery',
  'startup-mode': 'web-discovery',
  'commercial-rescue': 'web-discovery',
});

/** Normal-mode lane ids a portal observation is allowed to claim. */
const PORTAL_OBSERVATION_LANES = new Set(PORTAL_SOURCE_LANES.map((lane) => lane.id));

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
    // The portal plan is one crawler source that feeds several normal lanes.
    // Its observations already name their own lane in `source`, so splitting
    // here keeps per-portal telemetry honest: without it every portal lane
    // reports SOURCE_EMPTY while the plan reports hundreds of rows, and the
    // shortfall report blames lanes that actually worked.
    if (sourceId === 'portal-discovery') {
      const portalRows = result.observations.filter((observation) => observation.sourceId === sourceId);
      const byLane = new Map();
      for (const observation of portalRows) {
        const portalLane = PORTAL_OBSERVATION_LANES.has(observation.source) ? observation.source : 'web-discovery';
        if (!byLane.has(portalLane)) byLane.set(portalLane, []);
        byLane.get(portalLane).push(observation);
      }
      const laneManifests = result.sourceTelemetry?.[sourceId]?.detail?.telemetry?.lanes ?? [];
      for (const manifest of laneManifests) {
        if (!manifest.attempted || !PORTAL_OBSERVATION_LANES.has(manifest.sourceId)) continue;
        if (!byLane.has(manifest.sourceId)) byLane.set(manifest.sourceId, []);
      }
      for (const [portalLane, rows] of byLane) {
        if (!observationsByLane.has(portalLane)) observationsByLane.set(portalLane, { sourceIds: [], candidates: [], failures: [], unmappedSourceIds: [] });
        const entry = observationsByLane.get(portalLane);
        entry.sourceIds.push(sourceId);
        entry.candidates.push(...rows);
        const manifest = laneManifests.find((item) => item.sourceId === portalLane);
        entry.failures.push(...(manifest?.errors ?? []).map((message) => ({ message })));
      }
      const portalFailures = result.failures.filter((failure) => failure.sourceId === sourceId);
      if (portalFailures.length) {
        if (!observationsByLane.has('web-discovery')) observationsByLane.set('web-discovery', { sourceIds: [], candidates: [], failures: [], unmappedSourceIds: [] });
        observationsByLane.get('web-discovery').failures.push(...portalFailures);
      }
      continue;
    }
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
    const emptyReasons = lane.sourceIds.flatMap((sourceId) => {
      const reason = telemetry[sourceId]?.detail?.telemetry?.emptyReason;
      return reason ? [{ sourceId, reason }] : [];
    });
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
      ...(emptyReasons.length ? { emptyReasons } : {}),
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
        ...(!lane.candidates.length && emptyReasons.length ? { reason: [...new Set(emptyReasons.map(({ reason }) => reason))].join(', ') } : {}),
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
  return candidateDedupKey(candidate);
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

// Route a verified pool once, keeping uncapped results beside each mode's shortlist.
function selectDailyModes(entries, options, selectedMode, stretchBudget) {
  const pools = { normal: [], startup: [], remote: [], eorContract: [] };
  const stretch = entries
    .filter((entry) => {
      const candidate = entry.candidate;
      const family = entry.roleFamily || candidate.roleFamily || entry.eligibility?.roleFamily;
      const score = Number(candidate.matchScore ?? candidate.score);
      const coreFamily = ['ai-llm-agentic', 'ml', 'full-stack-ai', 'backend-python'].includes(family)
        || /\bfull[ -]?stack\b/i.test(candidate.title || '')
        || /\bback[- ]?end\b/i.test(candidate.title || '');
      const listedAsStartupOrRemote = hasStartupEvidence(candidate) || entry.eligibility?.geo?.mode === 'remote';
      return entry.eligibility?.hardMinimumExactly3Years === true
        && coreFamily
        && Number.isFinite(score) && score >= 80
        && listedAsStartupOrRemote
        && !stretchBudget.otherKeys.includes(candidateDedupKey(candidate));
    })
    .sort((left, right) => Number(right.candidate.matchScore ?? right.candidate.score) - Number(left.candidate.matchScore ?? left.candidate.score)
      || String(left.candidate.canonicalUrl || '').localeCompare(String(right.candidate.canonicalUrl || '')))
    .slice(0, stretchBudget.remaining)
    .map((entry) => entry.candidate);
  for (const entry of entries) {
    const candidate = entry.candidate;
    if (entry.eligibility?.employment?.lane === 'eor-contract') {
      pools.eorContract.push({ ...entry, candidate: { ...candidate, eligibility: entry.eligibility, labels: entry.eligibility.labels, primaryMode: 'eor-contract', otherModes: [] } });
      continue;
    }
    const fits = [];
    if (hasStartupEvidence(candidate) || STARTUP_LANE_IDS.has(candidate.startupLaneId)) fits.push('startup');
    const pune = entry.eligibility?.geo?.code === 'GEO_PUNE_METRO'
      || (entry.eligibility?.geo?.mode === 'remote' && options.config.geo.puneMetroAliases.some((alias) => String(candidate.location || '').toLowerCase().includes(alias.toLowerCase())));
    if (pune) fits.push('normal');
    if (entry.eligibility?.geo?.mode === 'remote') fits.push('remote');
    if (!fits.length) continue;
    const [primaryMode, ...otherModes] = fits;
    pools[primaryMode].push({ ...entry, candidate: { ...candidate, primaryMode, otherModes } });
  }
  const selections = Object.fromEntries(Object.entries(pools).map(([mode, pool]) => [mode, selectNormalApplications(pool, {
    ...options, includeEorContract: mode === 'eorContract', previousDailyCandidates: options.previousDailyCandidates.filter((candidate) => candidate.primaryMode === mode),
  })]));
  const shared = selectNormalApplications(entries, { ...options, maximum: 0 });
  return {
    ...selections[selectedMode],
    eorContract: { results: selections.eorContract.results, shortlist: selections.eorContract.selected },
    stretch,
    readyCount: shared.readyCount, scoredCount: shared.scoredCount,
    unscoredCount: shared.unscoredCount, scoringFailedCount: shared.scoringFailedCount,
    scoringQueue: shared.scoringQueue,
    modes: Object.fromEntries(Object.entries(selections).map(([mode, selection]) => [mode, { results: selection.results, shortlist: selection.selected }])),
  };
}

// Merge injected focused lanes into the shared pipeline without fetching them again.
function sharedModeFixtures(result, callerFixtures) {
  const fixtures = { ...crawlerLaneFixtures(result), ...callerFixtures };
  const focused = [];
  for (const laneId of new Set([...STARTUP_LANE_IDS, ...REMOTE_LANE_IDS])) {
    const fixture = callerFixtures[laneId];
    for (const candidate of fixture?.candidates ?? fixture?.records ?? []) {
      focused.push({ ...candidate, ...(STARTUP_LANE_IDS.has(laneId) ? { startupLaneId: laneId } : {}) });
    }
  }
  if (focused.length) {
    const web = fixtures['web-discovery'];
    fixtures['web-discovery'] = { ...web, candidates: [...(web?.candidates ?? web?.records ?? []), ...focused] };
  }
  return fixtures;
}

function candidatesForKeys(shortlist, keys) {
  const wanted = new Set((keys ?? []).map(String));
  return shortlist.filter((candidate) => wanted.has(candidateDedupKey(candidate)));
}

function committedAtResolver(gateway, override) {
  if (typeof override === 'function') return override;
  return (key) => {
    const entry = gateway?.journal?.get?.(key) ?? gateway?.transactionJournal?.get?.(key);
    return entry?.state === 'committed' ? entry.updatedAt : null;
  };
}

async function executeDeliveryTransaction({ factory, operations, credentialFile, journalPath }) {
  if (typeof factory !== 'function') throw new Error('live writes require a lazy notionGatewayFactory');
  const gateway = await factory();
  if (!gateway) throw new Error('notionGatewayFactory returned no gateway');
  const transaction = typeof gateway.writeApplications === 'function'
    ? await gateway.writeApplications(operations, { credentialFile, journalPath })
    : typeof gateway.executeWrites === 'function'
      ? await gateway.executeWrites({ operations, credentialFile, journalPath })
      : null;
  if (!transaction) throw new Error('live gateway must implement writeApplications or executeWrites');
  return { gateway, transaction };
}

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
  notionGatewayFactory = null,
  executeWrites = false,
  credentialFile = null,
  journalPath = null,
  transactionCommitTimeForKey = null,
  conversionPlan,
  ledgerRows,
  opportunityLedgerRows,
  opportunityLedgerPath,
  opportunityLedgerWriter = recordSurfaced,
  opportunityLedgerReader = readOpportunityLedger,
  opportunityLedgerRepairer = repairMissingSurfaced,
  scores,
  scorer = null,
  store,
  canaryStore,
  canaryEvidence = null,
  canaryValidationOptions = {},
  deferCanaryPersistence = false,
  shortlistLimit = null,
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
  const effectiveRunId = runId ?? dailyRunIdentity({ schedule, mode: selectedMode, locationPreset, at: runAt });
  if (shortlistLimit != null && (!Number.isInteger(shortlistLimit) || shortlistLimit < 0 || shortlistLimit > 20)) throw new Error('shortlist limit must be an integer between 0 and 20');
  const dailyBudgetPath = `${config.databasePath || '.local/launchpad-crawler/crawler.sqlite'}.daily-shortlist.json`;
  const dailyBudget = dailyShortlistBudget(dailyBudgetPath, runAt, effectiveRunId);
  const stretchBudget = dailyStretchBudget(dailyBudgetPath, runAt, effectiveRunId);
  const dailyShortlistLimit = Math.min(shortlistLimit ?? 20, dailyBudget.remaining);
  const effectiveClock = crawlerClock(clock, runAt);
  const v4HistorySnapshot = readV4HistorySnapshot(config?.v4HistorySnapshotPath, {
    maxAgeDays: config?.v4HistorySnapshotMaxAgeDays,
    now: runAt,
  });
  const effectiveHistoricalV4Rows = historicalV4Rows === undefined
    ? v4HistorySnapshot.rows
    : historicalV4Rows;
  const boundedPlannerActive = config.sourcePlanner?.enabled === true && config.sourcePlanner?.legacyPlannerRollback !== true;
  const crawlerConfig = boundedPlannerActive
    ? {
      ...config,
      sources: {
        ...(config.sources ?? {}),
        atsWarm: {
          ...(config.sources?.atsWarm ?? {}),
          // Keep the tracked reverse-ATS inventory in the first durable plan.
          // The registry path deduplicates these aliases before any adapter runs.
          boards: [...(config.sources?.atsWarm?.boards ?? []), ...trackedBoards(config)],
        },
      },
    }
    : {
      ...config,
      sources: {
        ...(config.sources ?? {}),
        atsWarm: {
          ...(config.sources?.atsWarm ?? {}),
          // Preserve legacy ordering, but do not let case/alias variants issue
          // more than one first-pass request for the same normalized board.
          boards: filterLegacyTrackedBoards(config.sources?.atsWarm?.boards ?? [], new Set()).selected,
        },
      },
    };
  let crawlerResult;
  try {
    crawlerResult = await runCrawlerFull({
      config: crawlerConfig,
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
  } catch (error) {
    const failed = {
      runId: effectiveRunId,
      schedule,
      mode: selectedMode,
      locationPreset,
      shortlist: [],
      plannedNotionOperations: [],
      deliveryPlan: { status: 'empty', shortlist: [], plannedNotionOperations: [], opportunitySurfacing: [], selectedCount: 0, plannedV5OperationCount: 0 },
      deliveryReconciliation: buildDeliveryReconciliation({ status: 'failed', surfacedCount: 0, canaryCount: 0, canaryStatus: 'not_emitted', notificationCount: 0, notificationStatus: 'not_emitted' }),
      transaction: null,
      surfaced: 0,
      outcome: { status: 'fatal', fatal: true, degraded: false, errors: [{ stage: error.stage || 'crawler', name: error.name || 'Error', message: error.message || String(error) }] },
    };
    return { ...failed, terminalEnvelope: terminalEnvelope({ result: failed, runId: effectiveRunId, schedule, mode: selectedMode, locationPreset, status: 'failed', fatalReason: error.message || String(error), lastDurableSourceState: error.lastDurableSourceState?.telemetry?.sources ?? null }) };
  }
  const defaultRotationStatePath = config.databasePath ? path.join(path.dirname(config.databasePath), 'board-rotation-state.json') : DEFAULT_BOARD_ROTATION_STATE_PATH;
  const rotationStatePath = config.sources?.trackedAts?.rotationStatePath ?? defaultRotationStatePath;
  const rotationState = loadBoardRotationState(rotationStatePath);
  const trackedResult = boundedPlannerActive
    ? {
      observations: [],
      failures: [],
      manifest: {
        sourceId: 'tracked-ats', status: crawlerResult.run?.status === 'partial' ? 'not_started' : 'succeeded', fetched: 0, changed: 0,
        firstPassOwner: 'ats-warm', duplicateFetches: 0,
        boardPlan: crawlerResult.sourceTelemetry?.['ats-warm']?.boardPlan ?? crawlerResult.sourceTelemetry?.['ats-warm']?.detail?.boardPlan ?? null,
        ...(crawlerResult.run?.status === 'partial' ? { errors: ['skipped after partial crawler checkpoint'] } : {}),
      },
    }
    : crawlerResult.run?.status === 'partial'
      ? { observations: [], failures: [], manifest: { sourceId: 'tracked-ats', status: 'not_started', fetched: 0, changed: 0, errors: ['skipped after partial crawler checkpoint'] } }
      : await (async () => {
    const ownedBoardIds = crawlerOwnedBoardIds(crawlerResult);
    const filtered = filterLegacyTrackedBoards(trackedBoards(config), ownedBoardIds);
    const result = await fetchWarmAts({
    ...(config.sources?.trackedAts ?? {}),
    boards: filtered.selected,
    transport,
    runAt,
    signal: dailyExecution.signal,
    deadline: dailyExecution.sourceBudget(),
    requestTimeoutMs: config.sources?.trackedAts?.requestTimeoutMs ?? 10_000,
    maxDurationMs: config.sources?.trackedAts?.maxDurationMs ?? Math.max(1, dailyExecution.remainingMs() - dailyExecution.reserveMs),
    boardConcurrency: config.sources?.trackedAts?.boardConcurrency ?? 2,
    rotation: { enabled: true, providerQuotas: config.sources?.trackedAts?.rotationProviderQuotas ?? { ashby: 1, greenhouse: 1, lever: 1 } },
    rotationState: {
      ...rotationState,
      // Share the scheduled pass's durable probe history with the tracked pass.
      boardPlanState: crawlerResult.sourceTelemetry?.['ats-warm']?.sourcePlanState || rotationState.boardPlanState,
    },
  });
    const boardFetchOwners = Object.fromEntries([
      ...[...ownedBoardIds].map((boardId) => [boardId, 'ats-warm']),
      ...filtered.selected.map((board) => [normalizedBoardId(board), 'tracked-ats']),
    ]);
    return {
      ...result,
      manifest: {
        ...result.manifest,
        firstPassOwner: 'tracked-ats',
        duplicateFetches: 0,
        deduplicatedBoardIds: filtered.deduplicatedBoardIds,
        boardsOmitted: Number(result.manifest?.boardsOmitted ?? 0) + filtered.omissions.length,
        omissions: [...(result.manifest?.omissions ?? []), ...filtered.omissions],
        boardFetchOwners,
      },
    };
  })();
  if (!boundedPlannerActive && crawlerResult.run?.status !== 'partial') saveBoardRotationState(rotationStatePath, trackedResult.rotationState, runAt);
  const sharedFixtures = sharedModeFixtures(crawlerResult, { 'tracked-ats': trackedFixture(trackedResult), ...sourceFixtures });
  const result = await runNormalMode({
    clock: () => runAt,
    runId: effectiveRunId,
    // Focused modes consume the shared crawler observations as fixtures. This
    // prevents a second native source fetch after the one shared crawl.
    sourceFunctions: selectedMode === 'normal' ? sourceFunctions : {},
    sourceFixtures: sharedFixtures,
    laneInputs,
    mode: 'normal',
    historicalV4Rows: effectiveHistoricalV4Rows,
    notionGateway,
    executeGateway: false,
    conversionPlan,
    ledgerRows,
    opportunityLedgerRows,
    opportunityLedgerPath: opportunityLedgerPath ?? config.opportunityLedgerPath,
    scores,
    dailyExcludedKeys: dailyBudget.otherKeys,
    previousDailyCandidates: dailyBudget.previousCandidates,
    scoringSignal: dailyExecution.signal,
    scoringRemainingMs: dailyExecution.downstreamRemainingMs(),
    commitSurfaced: false,
    partial: crawlerResult.run?.status === 'partial',
    shortlistLimit: dailyShortlistLimit,
    // Match scoring is opt-in: 'codex' constructs the real codex CLI scorer
    // (production), an injected async function fakes it (tests). The default
    // keeps the run byte-identical to the pre-scorer behaviour — offline, no
    // child processes.
    scorer: scorer === 'codex'
      // Scoring may use the reserved floor only when that time still remains.
      // Never extend past the parent deadline, and honor its AbortSignal.
      ? createCodexScorer({
        wholeTimeoutMs: Math.min(dailyExecution.downstreamRemainingMs(), Math.max(1, dailyExecution.scorerFloorMs)),
        signal: dailyExecution.signal,
      })
      : (scorer ?? undefined),
    includeCrawlerLanes: true,
    selectApplications: (entries, options) => selectDailyModes(entries, options, selectedMode, stretchBudget),
    enrichmentBudget: crawlerResult.run?.status === 'partial'
      ? 0
      : config.sources?.enterprise?.maxDetailRequestsPerRun ?? 50,
  });
  result.mode = selectedMode;
  const finalStatus = result.outcome?.status === 'fatal'
    ? 'failed'
    : crawlerResult.run?.status === 'partial' || result.outcome?.status === 'partial'
      ? 'partial'
      : 'completed';
  const envelope = terminalEnvelope({ crawlerResult, result, runId: effectiveRunId, schedule, mode: selectedMode, locationPreset, status: finalStatus, additionalSources: { 'tracked-ats': trackedFixture(trackedResult).manifest } });
  if (finalStatus !== 'completed') {
    const coverageReasons = [
      ...envelope.sourceCoverage.interrupted.map((sourceId) => `SOURCE_INTERRUPTED:${sourceId}`),
      ...envelope.sourceCoverage.failed.map((sourceId) => `SOURCE_FAILED:${sourceId}`),
      ...envelope.sourceCoverage.not_started.map((sourceId) => `SOURCE_NOT_STARTED:${sourceId}`),
    ];
    const deliveryReconciliation = buildDeliveryReconciliation({
      status: finalStatus,
      deliveryPlan: result.deliveryPlan,
      sourceCoverage: envelope.sourceCoverage,
      rejectionReasons: [...(result.rejectionReasons ?? []), ...coverageReasons],
      surfacedCount: 0,
      canaryCount: 0,
      canaryStatus: 'not_emitted',
      notificationCount: 0,
      notificationStatus: 'not_emitted',
    });
    const finalEnvelope = { ...envelope, deliveryReconciliation };
    return {
      ...result,
      terminalEnvelope: finalEnvelope,
      deliveryReconciliation,
      writesPlanned: false,
      observations: crawlerResult.observations,
      outcome: finalStatus === 'failed'
        ? { ...(result.outcome ?? {}), status: 'fatal', fatal: true, degraded: false }
        : { ...(result.outcome ?? {}), status: 'partial', fatal: false, degraded: true },
      surfaced: 0,
      deliveryCanary: null,
      canaryPersistenceError: null,
      crawlerV2Telemetry: Object.fromEntries(Object.entries(crawlerResult.sourceTelemetry ?? {}).map(([sourceId, telemetry]) => [sourceId, {
        ...telemetry,
        durationMs: crawlerResult.run?.telemetry?.sourceDurations?.[sourceId] ?? null,
      }])),
      telemetry: { ...(result.telemetry ?? {}), terminalEnvelope: finalEnvelope, v4HistorySnapshot: v4HistoryTelemetry(v4HistorySnapshot) },
    };
  }
  result.dailyShortlistBudget = retainDailyShortlist(dailyBudgetPath, runAt, effectiveRunId, result.shortlist);
  result.dailyStretchBudget = retainDailyStretch(dailyBudgetPath, runAt, effectiveRunId, result.stretch);
  const snapshotTelemetry = v4HistoryTelemetry(v4HistorySnapshot);
  const codeConfigVersion = computeCanaryVersion({ config });
  const discoveryProfile = {
    schedule: String(schedule).trim().toLowerCase(),
    mode: selectedMode,
    locationPreset: String(locationPreset).trim().toLowerCase(),
  };
  const deliveryPlan = result.deliveryPlan;
  if (!deliveryPlan || deliveryPlan.status !== 'planned') throw new Error('completed mode result is missing its selector-owned delivery plan');
  const crawlerV2Telemetry = Object.fromEntries(Object.entries(crawlerResult.sourceTelemetry ?? {}).map(([sourceId, telemetry]) => [sourceId, {
    ...telemetry,
    durationMs: crawlerResult.run?.telemetry?.sourceDurations?.[sourceId] ?? null,
  }]));

  if (!executeWrites) {
    const deliveryReconciliation = buildDeliveryReconciliation({
      status: 'no-write',
      deliveryPlan,
      sourceCoverage: envelope.sourceCoverage,
      rejectionReasons: result.rejectionReasons ?? [],
      surfacedCount: 0,
      ledgerRepairedCount: 0,
      canaryCount: 0,
      canaryStatus: 'not_emitted',
      notificationCount: 0,
      notificationStatus: 'not_emitted',
    });
    const finalEnvelope = { ...envelope, deliveryReconciliation };
    return {
      ...result,
      terminalEnvelope: finalEnvelope,
      deliveryReconciliation,
      transaction: null,
      surfaced: { path: opportunityLedgerPath ?? config.opportunityLedgerPath, rows: [] },
      ledgerRepairs: { path: opportunityLedgerPath ?? config.opportunityLedgerPath, rows: [] },
      deliveryCanary: null,
      canaryPersistenceError: null,
      crawlerV2Telemetry,
      v4HistorySnapshot: snapshotTelemetry,
      telemetry: { ...(result.telemetry ?? {}), v4HistorySnapshot: snapshotTelemetry },
    };
  }

  let liveGateway = null;
  let transaction;
  if (deliveryPlan.plannedNotionOperations.length === 0) {
    transaction = { status: 'noop', newlyCommitted: [], alreadyCommitted: [], failed: [], recovery: [], deliveredKeys: [] };
  } else {
    try {
      const executionResult = await executeDeliveryTransaction({
        factory: notionGatewayFactory,
        operations: deliveryPlan.plannedNotionOperations,
        credentialFile,
        journalPath,
      });
      liveGateway = executionResult.gateway;
      transaction = executionResult.transaction;
    } catch (error) {
      transaction = {
        status: 'aborted',
        newlyCommitted: [],
        alreadyCommitted: [],
        failed: [{ key: null, error: { code: error.code ?? 'TRANSACTION_FAILED', name: error.name || 'Error', message: error.message || String(error), stage: error.stage ?? 'transaction' } }],
        recovery: [],
        deliveredKeys: [],
      };
    }
  }

  const ledgerPath = opportunityLedgerPath ?? config.opportunityLedgerPath;
  let surfaced = { path: ledgerPath, rows: [] };
  let ledgerRepairs = { path: ledgerPath, rows: [] };
  let ledgerError = null;
  try {
    const newlyCommittedCandidates = candidatesForKeys(deliveryPlan.shortlist, transaction.newlyCommitted);
    if (newlyCommittedCandidates.length) {
      surfaced = opportunityLedgerWriter(newlyCommittedCandidates, { path: ledgerPath, now: runAt });
    }
    const existingKeys = new Set((opportunityLedgerReader(ledgerPath)?.rows ?? []).map((row) => row.dedup_key));
    const missingReplayCandidates = candidatesForKeys(deliveryPlan.shortlist, transaction.alreadyCommitted)
      .filter((candidate) => !existingKeys.has(candidateDedupKey(candidate)));
    if (missingReplayCandidates.length) {
      ledgerRepairs = opportunityLedgerRepairer(missingReplayCandidates, {
        path: ledgerPath,
        committedAtForKey: committedAtResolver(liveGateway, transactionCommitTimeForKey),
      });
    }
  } catch (error) {
    ledgerError = {
      stage: 'opportunity-ledger',
      name: error.name || 'Error',
      code: error.code ?? null,
      message: error.message || String(error),
    };
  }

  const transactionComplete = ['committed', 'replayed', 'noop'].includes(transaction.status)
    && transaction.failed.length === 0
    && transaction.recovery.length === 0
    && transaction.deliveredKeys.length === deliveryPlan.selectedCount;
  const deliveryErrors = [
    ...(!transactionComplete ? [{ stage: 'transaction', name: 'DeliveryTransactionError', message: `delivery transaction incomplete: ${transaction.status}` }] : []),
    ...(ledgerError ? [ledgerError] : []),
  ];
  const outcome = deliveryErrors.length
    ? {
      ...(result.outcome ?? {}),
      status: 'degraded',
      fatal: false,
      degraded: true,
      errors: [...(result.outcome?.errors ?? []), ...deliveryErrors],
    }
    : result.outcome;
  const inventoryIdentity = computeDeliveryInventoryIdentity(deliveryPlan.shortlist, deliveryPlan.plannedNotionOperations);
  const resolvedCanaryEvidence = typeof canaryEvidence === 'function'
    ? canaryEvidence({
      shortlist: deliveryPlan.shortlist,
      plannedNotionOperations: deliveryPlan.plannedNotionOperations,
      codeConfigVersion,
      discoveryProfile,
      inventoryIdentity,
    })
    : canaryEvidence;
  const canaryRun = {
    ...result,
    outcome,
    transaction,
    surfaced: { rows: [...(surfaced?.rows ?? []), ...(ledgerRepairs?.rows ?? [])] },
    shortlist: deliveryPlan.shortlist,
    plannedNotionOperations: deliveryPlan.plannedNotionOperations,
    v4HistorySnapshot: snapshotTelemetry,
    canaryConfig: config,
    codeConfigVersion,
    discoveryProfile,
    inventoryIdentity,
    canaryEvidence: resolvedCanaryEvidence,
  };
  let preparedCanary = null;
  let deliveryCanary = null;
  let canaryPersistenceError = null;
  try {
    ({ record: preparedCanary } = prepareDeliveryCanary({
      run: canaryRun,
      clock: effectiveClock,
      store: canaryStore,
      ...canaryValidationOptions,
    }));
    deliveryCanary = { ...preparedCanary, persisted: false };
  } catch (error) {
    canaryPersistenceError = {
      stage: 'delivery-canary-preflight',
      name: error.name || 'Error',
      code: error.code ?? null,
      message: error.message || String(error),
    };
  }
  if (preparedCanary && !deferCanaryPersistence) {
    try {
      canaryStore?.append?.(preparedCanary);
      deliveryCanary = { ...preparedCanary, persisted: typeof canaryStore?.append === 'function' ? true : null };
    } catch (error) {
      canaryPersistenceError = {
        stage: 'delivery-canary-persistence',
        name: error.name || 'Error',
        code: error.code ?? null,
        message: error.message || String(error),
      };
      deliveryCanary = {
        ...preparedCanary,
        valid: false,
        preparedValid: preparedCanary.valid === true,
        invalidReasons: [...preparedCanary.invalidReasons, `canary persistence failed: ${canaryPersistenceError.message}`],
        persisted: false,
      };
    }
  }
  const finalOutcome = canaryPersistenceError
    ? {
      ...(outcome ?? {}),
      status: 'degraded',
      fatal: false,
      degraded: true,
      errors: [...(outcome?.errors ?? []), canaryPersistenceError],
    }
    : outcome;
  const deliveryReconciliation = buildDeliveryReconciliation({
    status: finalOutcome?.degraded ? 'degraded' : 'completed',
    deliveryPlan,
    sourceCoverage: envelope.sourceCoverage,
    rejectionReasons: result.rejectionReasons ?? [],
    transaction,
    surfacedCount: surfaced?.rows?.length ?? 0,
    ledgerRepairedCount: ledgerRepairs?.rows?.length ?? 0,
    canaryCount: deliveryCanary?.counts?.shortlist ?? null,
    canaryStatus: deliveryCanary?.valid === true ? 'valid' : 'invalid',
    notificationCount: null,
    notificationStatus: 'not_emitted',
  });
  const finalEnvelope = { ...envelope, deliveryReconciliation };
  return {
    ...result,
    terminalEnvelope: finalEnvelope,
    deliveryReconciliation,
    outcome: finalOutcome,
    transaction,
    crawlerV2Telemetry,
    v4HistorySnapshot: snapshotTelemetry,
    deliveryCanary,
    canaryPersistenceError,
    surfaced,
    ledgerRepairs,
    telemetry: { ...(result.telemetry ?? {}), v4HistorySnapshot: snapshotTelemetry },
  };
}

export async function runDailyNormal(options = {}) {
  const selectedMode = normalizeDailyMode(options.mode);
  const hiringEvents = readHiringEvents(options.config?.hiringEventsPath);
  const runAt = runAtFrom(options.clock);
  const execution = createDailyExecution(options.config ?? {}, runAt);
  try {
    const result = await runDailyNormalImpl({ ...options, mode: selectedMode, execution });
    return { ...result, hiringEvents };
  } finally {
    execution.cleanup();
  }
}

export default runDailyNormal;
