import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultHttpTransport, validateCrawlerConfig } from './operator.mjs';
import { runDailyNormal } from './daily-runner.mjs';
import { openCrawlerStore } from './run.mjs';
import { deadlineError } from './deadline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_CONFIG_PATH = path.join(ROOT, 'config', 'crawler-v2-dev.json');
const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed']);
const PROOF_SCHEMA = 'LaunchpadLocalRecoveryProofV1';

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isoNow() {
  return new Date().toISOString();
}

function requireDirectory(value, flag) {
  if (!value || typeof value !== 'string') throw new Error(`${flag} is required`);
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`${flag} must name an existing directory: ${resolved}`);
  return resolved;
}

function requireOutput(value) {
  if (!value || typeof value !== 'string') throw new Error('--out is required');
  const resolved = path.resolve(value);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error(`--out parent directory is missing: ${parent}`);
  return resolved;
}

export function parseArgs(args = []) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!['--out', '--work-dir'].includes(flag)) throw new Error(`unsupported argument: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (Object.hasOwn(values, flag)) throw new Error(`${flag} may be supplied only once`);
    values[flag] = value;
    index += 1;
  }
  return { out: requireOutput(values['--out']), workDir: requireDirectory(values['--work-dir'], '--work-dir') };
}

function isolatedConfig(workDir, configOverride = null) {
  const source = configOverride ? structuredClone(configOverride) : readJson(DEV_CONFIG_PATH);
  source.boardRegistryPath = source.boardRegistryPath
    ? path.resolve(ROOT, source.boardRegistryPath)
    : source.boardRegistryPath;
  validateCrawlerConfig(source);
  return {
    ...source,
    databasePath: path.join(workDir, 'crawler.sqlite'),
    opportunityLedgerPath: path.join(workDir, 'opportunity-ledger.tsv'),
    v4HistorySnapshotPath: path.join(workDir, 'no-v4-history.json'),
  };
}

function requestCounter(baseTransport, counters) {
  return async (url, options = {}) => {
    counters.started += 1;
    if (options.signal?.aborted) {
      counters.postCancel += 1;
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error('request started after cancellation');
    }
    let settled = false;
    let cancelled = false;
    const onAbort = () => {
      if (!settled && !cancelled) {
        cancelled = true;
        counters.cancelled += 1;
      }
    };
    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const response = await baseTransport(url, options);
      settled = true;
      if (!cancelled) counters.completed += 1;
      return response;
    } catch (error) {
      settled = true;
      if (options.signal?.aborted && !cancelled) {
        cancelled = true;
        counters.cancelled += 1;
      }
      throw error;
    } finally {
      options.signal?.removeEventListener?.('abort', onAbort);
    }
  };
}

function emptySideEffects() {
  return {
    opportunityLedgerPersisted: 0,
    gatewayExecuted: 0,
    canaryPersisted: 0,
    notificationSent: 0,
    applicationsSubmitted: 0,
    outreachSent: 0,
    checkboxesChanged: 0,
    credentialsChanged: 0,
    schedulesChanged: 0,
    productionConfigChanged: 0,
  };
}

function plannerEvidence(manifests = [], crawlerTelemetry = {}) {
  const telemetryManifests = Object.entries(crawlerTelemetry).map(([sourceId, telemetry]) => ({ sourceId, ...object(telemetry) }));
  const plans = [...manifests, ...telemetryManifests]
    .map((manifest) => ({ sourceId: manifest?.sourceId ?? null, boardPlan: manifest?.boardPlan ?? manifest?.detail?.boardPlan ?? null }))
    .filter((item) => item.boardPlan);
  const decisions = plans.flatMap((item) => (item.boardPlan.decisions ?? []).map((decision) => ({ ...decision, sourceId: item.sourceId })));
  return {
    plans,
    decisions,
    selected: decisions.filter((item) => ['selected', 'resumed'].includes(item.action)),
    deferred: decisions.filter((item) => item.action === 'deferred'),
    omitted: decisions.filter((item) => item.action === 'omitted'),
  };
}

function sourceCoverage(result) {
  const envelope = object(result?.terminalEnvelope);
  return {
    ...(object(envelope.sourceCoverage)),
    completed: [...(envelope.completedSources ?? envelope.sourceCoverage?.completed ?? [])],
    interrupted: [...(envelope.interruptedSources ?? envelope.sourceCoverage?.interrupted ?? [])],
    failed: [...(envelope.failedSources ?? envelope.sourceCoverage?.failed ?? [])],
    not_started: [...(envelope.notStartedSources ?? envelope.sourceCoverage?.not_started ?? [])],
  };
}

function deliverySummary(result) {
  const plan = object(result?.deliveryPlan);
  const reconciliation = object(result?.deliveryReconciliation ?? result?.terminalEnvelope?.deliveryReconciliation);
  return {
    status: plan.status ?? null,
    selectedCount: number(plan.selectedCount ?? plan.shortlist?.length),
    plannedV5OperationCount: number(plan.plannedV5OperationCount ?? plan.plannedNotionOperations?.length),
    opportunitySurfacingCount: number(plan.opportunitySurfacing?.length),
    reconciliation,
  };
}

function plannedV5OperationCount(result) {
  const plan = object(result?.deliveryPlan);
  const counts = object(result?.deliveryReconciliation?.counts ?? result?.terminalEnvelope?.deliveryReconciliation?.counts);
  return number(plan.plannedV5OperationCount ?? plan.plannedNotionOperations?.length ?? counts.plannedV5Operations);
}

function partialSafetyEvidence(result, sideEffects) {
  const envelope = object(result?.terminalEnvelope);
  const reconciliation = object(result?.deliveryReconciliation ?? envelope.deliveryReconciliation);
  const counts = object(reconciliation.counts);
  const surfacedCount = number(result?.surfaced?.rows?.length ?? result?.surfaced);
  return {
    writesPlanned: result?.writesPlanned ?? envelope.writesPlanned ?? null,
    plannedV5OperationCount: plannedV5OperationCount(result),
    ledgerAbsent: number(sideEffects.opportunityLedgerPersisted) === 0 && number(counts.opportunityLedgerSurfaced) === 0,
    surfacingAbsent: surfacedCount === 0,
    canaryAbsent: result?.deliveryCanary == null && number(counts.canaryShortlist) === 0,
    notificationAbsent: result?.notification == null
      && reconciliation.notification?.status === 'not_emitted'
      && number(counts.notification) === 0,
  };
}

function summarizeRun({ result, runNumber, startedAt, requestCounts, sideEffects, gatewayPlanCalls }) {
  const envelope = object(result?.terminalEnvelope);
  const status = envelope.status;
  if (!TERMINAL_STATUSES.has(status)) throw new Error(`run ${runNumber} did not produce a terminal status: ${String(status)}`);
  const manifests = Array.isArray(result.sourceManifests) ? result.sourceManifests : [];
  return {
    runNumber,
    runId: result.runId ?? envelope.runId ?? null,
    startedAt,
    finishedAt: isoNow(),
    durationMs: Math.max(0, Date.now() - Date.parse(startedAt)),
    status,
    terminalEnvelope: envelope,
    sourceManifests: manifests,
    sourceCoverage: sourceCoverage(result),
    planner: plannerEvidence(manifests, result.crawlerV2Telemetry),
    funnel: result.funnel ?? null,
    counts: result.counts ?? null,
    readyYield: {
      scoredReady: result.scoredReady ?? envelope.scoredReady ?? [],
      scorePendingReady: result.scorePendingReady ?? envelope.scorePendingReady ?? [],
      shortlist: result.shortlist ?? [],
      verificationQueue: result.verificationQueue ?? [],
    },
    rejectionReasons: [...new Set([...(result.rejectionReasons ?? []), ...(envelope.rejectionReasons ?? [])])].sort(),
    incompleteSourceReasons: [...new Set([
      ...(result.shortfall?.reasons ?? []),
      ...(manifests.flatMap((manifest) => manifest.errors ?? [])),
      ...(envelope.rejectionReasons ?? []).filter((reason) => /SOURCE_|INCOMPLETE|INTERRUPT|FAILED|NOT_STARTED/.test(reason)),
    ])].sort(),
    scoring: {
      supplied: false,
      scoreSource: 'none',
      result: result.scoring ?? null,
      queue: result.scoringQueue ?? [],
    },
    requestCounts,
    delivery: deliverySummary(result),
    writesPlanned: Boolean(result.writesPlanned ?? envelope.writesPlanned),
    sideEffectCounters: { ...sideEffects, gatewayPlanCalls },
  };
}

function noWriteHooks(sideEffects) {
  const hookCounters = { gatewayPlanCalls: 0, opportunityLedgerNoOpCalls: 0 };
  const gateway = {
    planWrites({ operations }) {
      hookCounters.gatewayPlanCalls += 1;
      return { status: 'planned', operations };
    },
    async executeWrites() {
      sideEffects.gatewayExecuted += 1;
      throw new Error('fixture gateway execution is prohibited');
    },
  };
  return {
    gateway,
    opportunityLedgerWriter: () => {
      hookCounters.opportunityLedgerNoOpCalls += 1;
      return 0;
    },
    hookCounters,
    sideEffects,
  };
}

async function runNoWriteExercise({ config, workDir, runNumber, transport }) {
  const startedAt = isoNow();
  const requestCounts = { started: 0, completed: 0, cancelled: 0, postCancel: 0 };
  const sideEffects = emptySideEffects();
  const hooks = noWriteHooks(sideEffects);
  const result = await runDailyNormal({
    config,
    transport: requestCounter(transport, requestCounts),
    clock: { now: () => startedAt },
    runId: `ticket-06-normal-morning-india-${runNumber}`,
    schedule: 'morning',
    mode: 'normal',
    locationPreset: 'india',
    historicalV4Rows: [],
    ledgerRows: [],
    opportunityLedgerRows: [],
    opportunityLedgerPath: path.join(workDir, 'opportunity-ledger.tsv'),
    opportunityLedgerWriter: hooks.opportunityLedgerWriter,
    notionGateway: hooks.gateway,
    executeGateway: false,
    scorer: null,
    canaryEvidence: null,
    canaryStore: null,
  });
  return summarizeRun({ result, runNumber, startedAt, requestCounts, sideEffects, gatewayPlanCalls: hooks.hookCounters.gatewayPlanCalls });
}

function fixtureConfig(workDir) {
  const board = (slug) => ({
    id: `workday:${slug}`,
    provider: 'workday',
    slug,
    boardKey: slug,
    company: `Fixture ${slug}`,
    url: `https://${slug}.wd1.myworkdayjobs.com/jobs`,
    scheduleLane: 'enterprise',
    enabled: true,
    activationState: 'enabled',
    sourceTier: 'targeted-enterprise',
    indiaFirst: true,
  });
  return {
    schemaVersion: 'LaunchpadCrawlerConfigV1',
    databasePath: path.join(workDir, 'resume-drill.sqlite'),
    opportunityLedgerPath: path.join(workDir, 'resume-drill-ledger.tsv'),
    sourcePlanner: { enabled: false, legacyPlannerRollback: false },
    sources: {
      atsWarm: { boards: [], maxBoards: 0, maxJobsPerBoard: 10 },
      atsBatch1: { boards: [] },
      atsBatch2: { boards: [] },
      enterprise: { boards: [board('fast'), board('slow')], maxPages: 1, maxJobsPerBoard: 10, enrichDetails: false },
    },
    execution: {
      wholeRunDeadlineMs: 80,
      discoveryBudgetMs: 35,
      downstreamReserveMs: 20,
      handoffReserveMs: 10,
      scorerFloorMs: 10,
      perSourceMaxDurationMs: 35,
      minimumSourceStartAllocationMs: 1,
    },
  };
}

function fixtureTransport({ interrupted = false } = {}) {
  let slowCalls = 0;
  return async (url) => {
    const text = String(url);
    const slow = /slow\.wd1\.myworkdayjobs\.com/.test(text);
    if (slow && interrupted && slowCalls++ === 0) {
      throw deadlineError('injected fixture resume deadline');
    }
    const board = text.match(/(?:https?:\/\/)?([^./]+)\.wd1\.myworkdayjobs\.com/)?.[1] ?? 'fixture';
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ total: 1, jobPostings: [{ title: 'AI Engineer', externalPath: `/job/${board}`, locations: ['Pune, India'], postedOn: '2026-08-21T04:00:00.000Z', jobReqId: board }] }),
    };
  };
}

async function runResumeDrill(workDir) {
  const firstConfig = fixtureConfig(workDir);
  const firstEffects = emptySideEffects();
  const firstHooks = noWriteHooks(firstEffects);
  const runId = 'ticket-06-fixture-resume';
  const firstStartedAt = Date.now();
  const firstRequestCounts = { started: 0, completed: 0, cancelled: 0, postCancel: 0 };
  const first = await runDailyNormal({
    config: firstConfig,
    transport: requestCounter(fixtureTransport({ interrupted: true }), firstRequestCounts),
    clock: { now: () => '2026-08-21T04:00:00.000Z' },
    runId,
    schedule: 'morning', mode: 'normal', locationPreset: 'india',
    historicalV4Rows: [], ledgerRows: [], opportunityLedgerRows: [],
    opportunityLedgerPath: firstConfig.opportunityLedgerPath,
    opportunityLedgerWriter: firstHooks.opportunityLedgerWriter,
    notionGateway: firstHooks.gateway, executeGateway: false,
    scorer: async (rows) => ({ scored: rows.map((row) => ({ ...row, matchScore: 80 })) }),
    canaryEvidence: null, canaryStore: null,
  });
  if (first.terminalEnvelope?.status !== 'partial') throw new Error('fixture resume drill first result was not partial');

  const resumedConfig = { ...firstConfig, execution: { ...firstConfig.execution, wholeRunDeadlineMs: 1_000, discoveryBudgetMs: 800 } };
  const secondEffects = emptySideEffects();
  const secondHooks = noWriteHooks(secondEffects);
  const secondStartedAt = Date.now();
  const secondRequestCounts = { started: 0, completed: 0, cancelled: 0, postCancel: 0 };
  const second = await runDailyNormal({
    config: resumedConfig,
    transport: requestCounter(fixtureTransport(), secondRequestCounts),
    clock: { now: () => '2026-08-21T04:00:00.000Z' },
    runId,
    schedule: 'morning', mode: 'normal', locationPreset: 'india',
    historicalV4Rows: [], ledgerRows: [], opportunityLedgerRows: [],
    opportunityLedgerPath: resumedConfig.opportunityLedgerPath,
    opportunityLedgerWriter: secondHooks.opportunityLedgerWriter,
    notionGateway: secondHooks.gateway, executeGateway: false,
    scorer: async (rows) => ({ scored: rows.map((row) => ({ ...row, matchScore: 80 })) }),
    canaryEvidence: null, canaryStore: null,
  });
  const store = openCrawlerStore(firstConfig.databasePath);
  const durableRunId = `${runId}-crawler-v2`;
  const durableObservationRows = store.prepare('SELECT observation_key, run_id FROM job_observations ORDER BY observation_key').all();
  const durableObservationCount = Number(store.prepare('SELECT COUNT(*) AS count FROM job_observations').get().count);
  const durableDuplicateCount = Number(store.prepare('SELECT COUNT(*) - COUNT(DISTINCT observation_key) AS count FROM job_observations').get().count);
  const durableRunIds = store.prepare('SELECT DISTINCT run_id FROM job_observations ORDER BY run_id').all().map((row) => row.run_id);
  const sourceAttemptRows = store.prepare('SELECT source_id, attempt, status FROM source_attempts WHERE run_id = ? ORDER BY source_id, attempt').all(durableRunId);
  store.close();
  const partialProhibited = Object.values(firstEffects).reduce((sum, value) => sum + number(value), 0);
  const partialSafety = partialSafetyEvidence(first, firstEffects);
  const sameRunId = first.runId === runId && second.runId === runId && first.terminalEnvelope?.runId === second.terminalEnvelope?.runId;
  const durableNoDuplicateProof = durableObservationCount === 2
    && durableDuplicateCount === 0
    && durableObservationRows.length === 2
    && durableObservationRows.every((row) => row.run_id === durableRunId)
    && durableRunIds.length === 1
    && durableRunIds[0] === durableRunId;
  const sourceAttemptHistoryShowsResume = sourceAttemptRows.some((row) => Number(row.attempt) > 1);
  return {
    fixtureOnly: true,
    runId,
    firstStatus: first.terminalEnvelope?.status ?? null,
    secondStatus: second.terminalEnvelope?.status ?? null,
    firstTerminalEnvelope: first.terminalEnvelope,
    secondTerminalEnvelope: second.terminalEnvelope,
    firstDurationMs: Date.now() - firstStartedAt,
    secondDurationMs: Math.max(0, Date.now() - secondStartedAt),
    firstRequestCounts,
    secondRequestCounts,
    durableRunId,
    durableObservationCount,
    durableDuplicateCount,
    durableRunIds,
    durableNoDuplicateProof,
    sourceAttemptRows,
    sourceAttemptHistoryShowsResume,
    sameRunId,
    partialWritesPlanned: partialSafety.writesPlanned,
    partialPlannedV5OperationCount: partialSafety.plannedV5OperationCount,
    partialLedgerAbsent: partialSafety.ledgerAbsent,
    partialSurfacingAbsent: partialSafety.surfacingAbsent,
    partialCanaryAbsent: partialSafety.canaryAbsent,
    partialNotificationAbsent: partialSafety.notificationAbsent,
    firstRequestPostCancel: number(firstRequestCounts.postCancel),
    partialProhibitedOperationCount: partialProhibited,
    sideEffectCounters: Object.fromEntries(Object.keys(firstEffects).map((key) => [key, number(firstEffects[key]) + number(secondEffects[key])])),
    planningCounters: {
      gatewayPlanCalls: firstHooks.hookCounters.gatewayPlanCalls + secondHooks.hookCounters.gatewayPlanCalls,
      opportunityLedgerNoOpCalls: firstHooks.hookCounters.opportunityLedgerNoOpCalls + secondHooks.hookCounters.opportunityLedgerNoOpCalls,
    },
    pass: first.terminalEnvelope?.status === 'partial'
      && second.terminalEnvelope?.status === 'completed'
      && sameRunId
      && durableNoDuplicateProof
      && sourceAttemptHistoryShowsResume
      && partialSafety.writesPlanned === false
      && partialSafety.plannedV5OperationCount === 0
      && partialSafety.ledgerAbsent
      && partialSafety.surfacingAbsent
      && partialSafety.canaryAbsent
      && partialSafety.notificationAbsent
      && firstRequestCounts.postCancel === 0
      && partialProhibited === 0,
  };
}

export function proofPass(evidence) {
  if (!evidence || evidence.schemaVersion !== PROOF_SCHEMA || !Array.isArray(evidence.evidence) || evidence.evidence.length === 0) return false;
  if (evidence.evidence.length !== 3 || !evidence.evidence.every((run) => TERMINAL_STATUSES.has(run.status) && number(run.durationMs) <= 1_200_000)) return false;
  if (!evidence.evidence.every((run) => number(run.requestCounts?.postCancel) === 0)) return false;
  const planningDiagnostics = new Set(['gatewayPlanCalls', 'opportunityLedgerNoOpCalls']);
  const externalCountersAreZero = (counters) => Object.entries(counters ?? {})
    .filter(([key]) => !planningDiagnostics.has(key))
    .every(([, value]) => number(value) === 0);
  if (!evidence.evidence.every((run) => externalCountersAreZero(run.sideEffectCounters))) return false;
  if (Object.values(evidence.sideEffectCounters ?? {}).some((value) => number(value) !== 0)) return false;
  const resume = evidence.resumeDrill;
  return resume?.pass === true
    && externalCountersAreZero(resume.sideEffectCounters)
    && resume.sameRunId === true
    && resume.durableNoDuplicateProof === true
    && resume.durableObservationCount === 2
    && resume.durableDuplicateCount === 0
    && resume.sourceAttemptHistoryShowsResume === true
    && resume.firstStatus === 'partial'
    && resume.secondStatus === 'completed'
    && resume.partialWritesPlanned === false
    && resume.partialPlannedV5OperationCount === 0
    && resume.partialLedgerAbsent === true
    && resume.partialSurfacingAbsent === true
    && resume.partialCanaryAbsent === true
    && resume.partialNotificationAbsent === true
    && number(resume.firstRequestCounts?.postCancel) === 0
    && number(resume.firstRequestPostCancel) === 0
    && number(resume.partialProhibitedOperationCount) === 0;
}

export async function runRecoveryProof({ workDir, transport = defaultHttpTransport, configOverride = null } = {}) {
  const resolvedWorkDir = requireDirectory(workDir, '--work-dir');
  const config = isolatedConfig(resolvedWorkDir, configOverride);
  const evidence = [];
  for (let runNumber = 1; runNumber <= 3; runNumber += 1) {
    evidence.push(await runNoWriteExercise({ config, workDir: resolvedWorkDir, runNumber, transport }));
  }
  const resumeDrill = await runResumeDrill(resolvedWorkDir);
  const sideEffectCounters = Object.fromEntries(Object.keys(emptySideEffects()).map((key) => [key,
    evidence.reduce((sum, run) => sum + number(run.sideEffectCounters?.[key]), 0) + number(resumeDrill.sideEffectCounters?.[key])
  ]));
  const output = {
    schemaVersion: PROOF_SCHEMA,
    proofKind: 'local-recovery-only',
    productionActivation: false,
    productionScoringClaim: false,
    configPath: configOverride ? null : DEV_CONFIG_PATH,
    workDir: resolvedWorkDir,
    profile: { schedule: 'morning', mode: 'normal', locationPreset: 'india' },
    evidence,
    resumeDrill,
    sideEffectCounters,
    planningCounters: {
      gatewayPlanCalls: evidence.reduce((sum, run) => sum + number(run.sideEffectCounters?.gatewayPlanCalls), 0) + number(resumeDrill.planningCounters?.gatewayPlanCalls),
      opportunityLedgerNoOpCalls: number(resumeDrill.planningCounters?.opportunityLedgerNoOpCalls),
    },
    pass: false,
  };
  output.pass = proofPass(output);
  if (!output.pass) throw new Error('local recovery proof invariants failed');
  return output;
}

export async function main(args = process.argv.slice(2)) {
  const { out, workDir } = parseArgs(args);
  const evidence = await runRecoveryProof({ workDir });
  try {
    fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    throw new Error(`failed to write evidence document ${out}: ${error.message}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`local recovery proof failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
