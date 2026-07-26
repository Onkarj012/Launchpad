import { assertValidConfig, assertValidConversionPlan, loadConfig, loadConversionPlan } from './config.mjs';
import { buildPayloadRecord, candidateDedupKey } from './candidate.mjs';
import { applyScores, runPipeline } from './run.mjs';
import { createNoWriteNotionGateway } from './workflow.mjs';
import { applicationReadiness } from './normal-readiness.mjs';
import { repairReadinessPool } from './normal-readiness-repair.mjs';
import { runNormalSourcePlan } from './normal-sources.mjs';
import { selectNormalApplications } from './normal-selection.mjs';
import { readLedger } from './ledger.mjs';
import { readOpportunityLedger } from './opportunity-ledger.mjs';
import { enrichWorkdayCandidates } from './workday-enrichment.mjs';
import { filterHistoricalCandidates } from '../crawler/historical-suppression.mjs';
import { withConversionScore } from './conversion-score.mjs';
import { classifySeniorityPool } from './seniority-classifier.mjs';
import { classifyCandidate } from './eligibility.mjs';

export class NormalModeError extends Error {
  constructor(message, stage = 'normal-mode') { super(message); this.name = 'NormalModeError'; this.stage = stage; }
}

function readClock(clock) {
  const value = typeof clock === 'function' ? clock() : clock && typeof clock.now === 'function' ? clock.now() : clock;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new NormalModeError('invalid injected clock value', 'clock');
  return date.toISOString();
}

function issueFor(manifest) {
  const liveInjectionOnly = manifest.reasonCode === 'PORTAL_REQUIRES_LIVE_INJECTION'
    && manifest.status === 'unavailable'
    && !manifest.errors?.length;
  if (!liveInjectionOnly && (manifest.status === 'failed' || manifest.status === 'unavailable' || manifest.errors?.length)) {
    return { sourceId: manifest.sourceId, status: manifest.status, errors: manifest.errors || [] };
  }
  return null;
}

function jsonEvidence(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function v5Payload(candidate, runId) {
  const sourceEvidence = candidate.evidence?.discovery || {};
  const requirementsEvidence = candidate.requirementsEvidence || candidate.evidence?.requirements || candidate.experience?.evidence || null;
  return {
    name: `${candidate.title} — ${candidate.company}`,
    role: candidate.title,
    Company: candidate.company,
    jdLink: candidate.discoveryUrl || candidate.canonicalUrl,
    originalApplicationUrl: candidate.originalApplicationUrl,
    applicationResolution: candidate.applicationResolution?.status,
    applicationReady: true,
    postedDate: candidate.postedAt,
    discoveredAt: candidate.discoveredAt,
    crawledAt: candidate.crawledAt,
    freshnessTier: candidate.waterfallBand || candidate.freshnessWindow,
    status: 'Ready',
    makeResume: false,
    applied: false,
    resumeState: 'Not Started',
    employmentCategory: candidate.employment?.type === 'internship' ? 'Internship' : candidate.employment?.type === 'contract' ? 'Contractor/EOR' : 'Full-time',
    selectionTier: candidate.selectionTier,
    relaxation: candidate.relaxations || [],
    roleFamily: candidate.roleFamily || null,
    companyStage: candidate.companyStage || null,
    workMode: candidate.workMode ? candidate.workMode[0].toUpperCase() + candidate.workMode.slice(1) : null,
    location: candidate.location,
    matchScore: candidate.matchScore,
    matchScoreVersion: candidate.matchScoreVersion || null,
    matchScoreInputs: candidate.matchScoreInputs || null,
    seniorityDecision: candidate.seniorityAssessment?.seniorityDecision || null,
    seniorityRequirementKind: candidate.seniorityAssessment?.requirementKind || null,
    seniorityMinimumYears: candidate.seniorityAssessment?.minimumYears ?? null,
    seniorityEvidenceQuote: candidate.seniorityAssessment?.evidenceQuote || null,
    seniorityConfidence: candidate.seniorityAssessment?.confidence ?? null,
    seniorityReasonCode: candidate.seniorityAssessment?.reasonCode || null,
    seniorityPromptVersion: candidate.seniorityAssessment?.promptVersion || null,
    seniorityModelVersion: candidate.seniorityAssessment?.modelVersion || null,
    conversionScore: candidate.conversionScore,
    conversionScoreVersion: candidate.conversionScoreVersion || null,
    conversionInputs: candidate.conversionInputs || null,
    responseLikelihood: candidate.responseLikelihood,
    source: candidate.source,
    provider: candidate.provider,
    sourceJobId: candidate.jobId,
    originalApplicationEvidence: candidate.originalApplicationEvidence || candidate.applicationResolution?.evidence || null,
    liveness: candidate.liveness?.status,
    requirementsEvidence: jsonEvidence(requirementsEvidence),
    relaxationEvidence: jsonEvidence(candidate.readinessEvidence),
    rationale: candidate.rationale,
    hook: candidate.hook,
    runId,
    dedupKey: candidateDedupKey(candidate),
    syncKey: candidateDedupKey(candidate),
  };
}

function provenanceFor(candidate, runId) {
  const sourceEvidence = candidate.evidence?.discovery || {};
  return {
    discoveryUrl: candidate.discoveryUrl || candidate.canonicalUrl,
    discoverySource: candidate.discoverySource || sourceEvidence.source || candidate.source,
    discoveryCategory: candidate.discoveryCategory || sourceEvidence.category || candidate.sourceCategory,
    discoveryProvider: candidate.provider || sourceEvidence.provider,
    originalApplicationUrl: candidate.originalApplicationUrl,
    originalApplicationEvidence: candidate.originalApplicationEvidence || candidate.applicationResolution?.evidence || null,
    verifiedAt: candidate.verifiedAt || candidate.liveness?.checkedAt || null,
    postedAt: candidate.postedAt,
    discoveredAt: candidate.discoveredAt,
    crawledAt: candidate.crawledAt,
    location: candidate.location,
    citizenshipEvidence: candidate.citizenshipEvidence || candidate.remoteEligibility?.evidence || null,
    experience: candidate.experience,
    seniority: candidate.seniorityAssessment || null,
    employment: candidate.employment,
    feesBonds: candidate.feeBondEvidence || null,
    liveness: candidate.liveness,
    score: candidate.matchScore,
    rationale: candidate.rationale,
    hook: candidate.hook,
    runId,
    dedupKey: candidateDedupKey(candidate),
  };
}

function verificationRecord(candidate, eligibility) {
  const readiness = applicationReadiness(candidate, eligibility);
  if (readiness.ready && candidate.postedAt) return null;
  if (!candidate.postedAt) readiness.reasons = [...new Set([...readiness.reasons, 'FRESHNESS_NOT_VERIFIED'])];
  const needsResolution = !readiness.evidence.resolution.ready;
  const needsLiveness = !readiness.evidence.liveness.pass;
  if (!needsResolution && !needsLiveness && eligibility?.eligible === false && candidate.postedAt) return null;
  return {
    company: candidate.company,
    title: candidate.title,
    discoveryUrl: candidate.discoveryUrl || candidate.canonicalUrl,
    originalApplicationUrl: candidate.originalApplicationUrl,
    provider: candidate.provider,
    source: candidate.source,
    applicationResolution: readiness.evidence.resolution,
    liveness: readiness.evidence.liveness,
    reasons: readiness.reasons,
    evidence: readiness.evidence,
    dedupKey: candidateDedupKey(candidate),
  };
}

function fatalResult(runId, runAt, mode, sourceManifests, error, details = {}) {
  return {
    schemaVersion: 'LaunchpadV5NormalModeV1', runId, runAt, mode,
    shortlist: [], verificationQueue: details.verificationQueue || [], funnel: details.funnel || null, sourceManifests, sourceTelemetry: sourceManifests,
    plannedNotionOperations: [], transaction: null, historicalSuppressions: [], historicalAmbiguous: [],
    scoringQueue: details.scoringQueue || [],
    scoring: details.scoring || null,
    readinessRepair: details.readinessRepair || null,
    repairQueue: details.repairQueue || [],
    stretchShortage: details.stretchShortage || [],
    selectionExclusions: details.selectionExclusions || [],
    strictComposition: details.strictComposition || null,
    familyComposition: details.familyComposition || null,
    seniority: details.seniority || null,
    reconciliation: details.reconciliation || null,
    shortfall: { minimum: 10, selected: 0, missing: 10, failedLanes: sourceManifests.filter((item) => item.status === 'failed').map((item) => item.sourceId), emptyLanes: [], linkedinRescueSuggestion: { suggested: true, command: 'linkedin-leads', invoked: false } },
    outcome: { status: 'fatal', fatal: true, degraded: false, errors: [{ stage: error.stage || 'pipeline', name: error.name || 'Error', message: error.message || String(error) }] },
    counts: details.counts || null,
  };
}

function reconciliationLine({ eligible, scored, ready, selected, causes }) {
  const causeText = Object.entries(causes)
    .flatMap(([stage, stageCauses]) => Object.entries(stageCauses).map(([cause, count]) => `${stage}:${cause}=${count}`))
    .join(',');
  return `eligible=${eligible}; scored=${scored}; ready=${ready}; selected=${selected}; causes=${causeText || 'none'}`;
}

function buildReconciliation({ eligible, historicalSuppressed, historicalAmbiguous = 0, selection, selected, runFailed = false }) {
  const ready = selection.readyCount;
  const scored = selection.scoredCount;
  const notReady = Math.max(0, eligible - historicalSuppressed - historicalAmbiguous - ready);
  const readyNotScored = Math.max(0, ready - scored);
  const selectedGap = Math.max(0, scored - selected);
  const causes = {
    eligibleToReady: {
      HISTORICAL_SUPPRESSION: historicalSuppressed,
      HISTORICAL_AMBIGUOUS_COLLISION: historicalAmbiguous,
      NOT_APPLICATION_READY: notReady,
    },
    readyToScored: {
      UNSCORED: selection.unscoredCount,
      SCORING_FAILED: selection.scoringFailedCount,
    },
    scoredToSelected: {
      ...(runFailed
        ? { RUN_FAILED_INCOMPLETE_SCORING: selectedGap }
        : selection.reconciliationCounts),
    },
  };
  return {
    eligible,
    scored,
    ready,
    selected,
    causes,
    deltas: {
      eligibleToReady: eligible - ready,
      readyToScored: readyNotScored,
      scoredToSelected: selectedGap,
    },
    line: reconciliationLine({ eligible, scored, ready, selected, causes }),
  };
}

function count(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function histogram(values) {
  const result = {};
  for (const value of values.filter(Boolean)) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function sumReasons(reasons = {}) {
  return Object.values(reasons).reduce((sum, value) => sum + count(value), 0);
}

export function reconcileDeliveryFunnel({
  eligible = 0,
  ready = 0,
  scored = 0,
  selected = 0,
  committed = 0,
  causes = {},
} = {}) {
  const stages = [
    ['eligibleToReady', eligible, ready],
    ['readyToScored', ready, scored],
    ['scoredToSelected', scored, selected],
    ['selectedToCommitted', selected, committed],
  ].map(([stage, from, to]) => {
    const delta = count(from) - count(to);
    const attributed = sumReasons(causes[stage]);
    return {
      stage,
      from: count(from),
      to: count(to),
      delta,
      attributed,
      unattributed: Math.max(0, delta - attributed) + Math.max(0, attributed - delta),
      ok: delta >= 0 && delta === attributed,
    };
  });
  const unresolvedCount = stages.reduce((sum, stage) => sum + stage.unattributed, 0);
  return { ok: stages.every((stage) => stage.ok), unresolvedCount, stages };
}

function detailHydration(manifests) {
  const rows = manifests.map((manifest) => (
    manifest.telemetry?.workdayDetail
    ?? manifest.workdayDetail
    ?? manifest.telemetry?.detailHydration
    ?? {}
  ));
  return {
    attempted: rows.reduce((sum, row) => sum + count(row.attempted), 0),
    succeeded: rows.reduce((sum, row) => sum + count(row.succeeded), 0),
    failed: rows.reduce((sum, row) => sum + count(row.failed), 0),
    skipped: rows.reduce((sum, row) => sum + count(row.skipped ?? row.budgetExhausted), 0),
  };
}

export function buildDcoTelemetry({
  runId,
  schedule = null,
  runAt,
  sourceManifests = [],
  funnel = null,
  readinessRepair = null,
  verificationQueue = [],
  historicalSuppressions = [],
  opportunitySuppressions = 0,
  scoring = null,
  selection = null,
  reconciliation = null,
  committed = 0,
  deliveryCommitStatus = 'pending',
} = {}) {
  const selected = selection?.selected?.length ?? reconciliation?.selected ?? 0;
  const ready = reconciliation?.ready ?? selection?.readyCount ?? 0;
  const scored = reconciliation?.scored ?? selection?.scoredCount ?? 0;
  const eligible = reconciliation?.eligible ?? 0;
  const causes = {
    ...(reconciliation?.causes ?? {}),
    selectedToCommitted: selected === count(committed)
      ? {}
      : { [deliveryCommitStatus === 'failed' ? 'DELIVERY_COMMIT_FAILED' : 'DELIVERY_PENDING']: Math.max(0, selected - count(committed)) },
  };
  const reconciliationResult = reconcileDeliveryFunnel({
    eligible,
    ready,
    scored,
    selected,
    committed,
    causes,
  });
  const capCodes = selection?.exclusions ?? [];
  const scorerFailures = scoring?.scorer?.failures ?? [];
  const sourceRows = sourceManifests.map((manifest) => ({
    sourceId: manifest.sourceId ?? null,
    configured: manifest.boardsConfigured ?? null,
    attempted: manifest.boardsAttempted ?? (manifest.attempted === false ? 0 : null),
    succeeded: manifest.succeeded ?? manifest.telemetry?.succeeded ?? null,
    degraded: manifest.status === 'degraded',
    failed: manifest.status === 'failed',
    omitted: manifest.boardsOmitted ?? null,
    rawRows: manifest.rawRows ?? manifest.fetched ?? null,
    acceptedObservations: manifest.acceptedObservations ?? manifest.telemetry?.observations ?? null,
    truncation: manifest.truncated === true,
    recordsNotExamined: manifest.recordsNotExamined ?? null,
    requestCount: manifest.requestCount ?? manifest.telemetry?.requestCount ?? null,
    durationMs: manifest.durationMs ?? manifest.telemetry?.durationMs ?? null,
    timeout: manifest.timeout ?? manifest.telemetry?.timeout ?? null,
    resolverSucceeded: manifest.resolverSucceeded ?? manifest.telemetry?.resolverSucceeded ?? null,
    resolverFailed: manifest.resolverFailed ?? manifest.telemetry?.resolverFailed ?? null,
    newlyActionableYield: manifest.newlyActionableYield ?? null,
  }));
  return {
    schemaVersion: 'LaunchpadDcoTelemetryV1',
    source: {
      boards: {
        configured: sourceRows.reduce((sum, row) => sum + count(row.configured), 0),
        attempted: sourceRows.reduce((sum, row) => sum + count(row.attempted), 0),
        succeeded: sourceRows.reduce((sum, row) => sum + count(row.succeeded), 0),
        degraded: sourceRows.filter((row) => row.degraded).length,
        failed: sourceRows.filter((row) => row.failed).length,
        omitted: sourceRows.reduce((sum, row) => sum + count(row.omitted), 0),
      },
      rawRows: sourceRows.reduce((sum, row) => sum + count(row.rawRows), 0),
      acceptedObservations: sourceRows.reduce((sum, row) => sum + count(row.acceptedObservations), 0),
      deduplicatedUniqueJobs: funnel?.lifecycle?.normalized ?? null,
      truncation: {
        sources: sourceRows.filter((row) => row.truncation).map((row) => row.sourceId),
        recordsNotExamined: sourceRows.reduce((sum, row) => sum + count(row.recordsNotExamined), 0),
      },
      requests: {
        count: sourceRows.reduce((sum, row) => sum + count(row.requestCount), 0),
        durationMs: sourceRows.reduce((sum, row) => sum + count(row.durationMs), 0),
        timeout: sourceRows.some((row) => row.timeout === true),
      },
      resolver: {
        succeeded: sourceRows.reduce((sum, row) => sum + count(row.resolverSucceeded), 0),
        failed: sourceRows.reduce((sum, row) => sum + count(row.resolverFailed), 0),
      },
      detailHydration: detailHydration(sourceManifests),
      perSourceNewlyActionableYield: Object.fromEntries(sourceRows.map((row) => [row.sourceId, row.newlyActionableYield])),
      sources: sourceRows,
    },
    funnel: {
      normalizedUnique: funnel?.lifecycle?.normalized ?? null,
      cheapGate: {
        pass: funnel?.lifecycle?.eligible ?? eligible,
        failByFirstReason: funnel?.firstFailureCodes ?? {},
      },
      hydration: {
        pool: readinessRepair?.input ?? null,
        outcomes: {
          attempted: readinessRepair?.attempted ?? 0,
          repaired: readinessRepair?.repaired ?? 0,
          rejected: readinessRepair?.rejected ?? 0,
          queued: readinessRepair?.queued ?? 0,
        },
      },
      hardGateEligible: eligible,
      freshnessClasses: funnel?.lifecycle?.freshnessClasses ?? {},
      readinessBlockers: histogram(verificationQueue.flatMap((row) => row.reasons ?? row.blockers ?? [])),
      suppressions: {
        historical: historicalSuppressions.length,
        opportunity: count(opportunitySuppressions),
      },
      scorer: {
        attempted: scoring?.scorer?.attempted ?? scoring?.scoredCount ?? scored,
        scored,
        failed: scoring?.scoringFailedCount ?? scorerFailures.length,
        reasonHistogram: histogram(scorerFailures.map((failure) => failure.reason)),
      },
      scoreFloorExclusions: {
        stretch: selection?.scorePolicy?.stretchCount ?? 0,
        belowFloor: selection?.scorePolicy?.belowFloorCount ?? 0,
      },
      capExclusions: {
        company: capCodes.filter((row) => row.code === 'SELECTION_COMPANY_CAP').length,
        family: capCodes.filter((row) => row.code === 'SELECTION_FAMILY_DIVERSITY_TARGET').length,
      },
      selected: {
        strict: selection?.selected?.filter((row) => row.selectionTier === 'Strict').length ?? 0,
        fallback: selection?.selected?.filter((row) => row.selectionTier === 'Fallback').length ?? 0,
        stretch: selection?.stretch?.length ?? 0,
        total: selected,
        committed: count(committed),
      },
      deliveryCommitStatus,
      reconciliation: {
        counts: { eligible, ready, scored, selected, committed: count(committed) },
        causes,
        ...reconciliationResult,
      },
    },
    operations: {
      runId: runId ?? null,
      schedule,
      configPath: null,
      databasePath: null,
      startedAt: runAt ?? null,
      endedAt: null,
      durationMs: null,
      deadlineStatus: null,
      localReportPaths: { markdown: null, json: null },
      localReportHashes: { markdown: null, json: null },
      externalTransactionStatus: 'disabled',
      surfacedStateCommitCount: 0,
      unresolvedReconciliationCount: reconciliationResult.unresolvedCount,
    },
  };
}

export function assertSuccessfulDcoTelemetry(telemetry) {
  const reconciliation = telemetry?.funnel?.reconciliation;
  if (telemetry?.funnel?.deliveryCommitStatus !== 'committed') {
    throw new NormalModeError('successful run requires a committed local report', 'delivery-reconciliation');
  }
  if (!reconciliation?.ok || reconciliation.unresolvedCount !== 0) {
    throw new NormalModeError(
      `unattributed funnel loss: ${reconciliation?.unresolvedCount ?? 'unknown'}`,
      'delivery-reconciliation',
    );
  }
  return telemetry;
}

// Broken-scorer reason codes, read from job-pull/match-scorer.mjs: a missing
// binary and an auth failure abort the batch before it starts, and repeated
// invalid output means the scorer cannot produce usable scores at all.
const BROKEN_SCORER_REASON_CODES = new Set([
  'SCORER_BINARY_MISSING',
  'SCORER_BINARY_NOT_ABSOLUTE',
  'SCORER_AUTH_FAILED',
  'SCORER_OUTPUT_INVALID',
  'SCORER_TIMEOUT',
  'SCORER_SPAWN_FAILED',
  'SCORER_DEADLINE_EXCEEDED',
]);

/**
 * Gate policy (docs/spec/match-scoring.md §6): the run fails only when the
 * scorer is genuinely broken — a run-level reason code, or more than half the
 * attempted rows lost. Row share is authoritative because failures and
 * reconciliation are row-level and a final chunk may be smaller.
 */
function scorerIsBroken(telemetry) {
  if (telemetry.degraded === true && BROKEN_SCORER_REASON_CODES.has(telemetry.reasonCode)) return true;
  return telemetry.attempted > 0 && telemetry.failures.length / telemetry.attempted > 0.5;
}

function scoringGateError(selection, scorerTelemetry = null) {
  const causes = selection.scoringQueue.map((candidate) => {
    const reason = candidate.scoringFailureReason || candidate.scoringQueueReason;
    return `${candidate.company} — ${candidate.title}: ${reason}`;
  });
  const scorerCause = scorerTelemetry
    ? `; scorer broken: reason-code=${scorerTelemetry.reasonCode ?? 'none'}, degraded=${scorerTelemetry.degraded}, attempted=${scorerTelemetry.attempted}, failed=${scorerTelemetry.failures.length}`
    : '';
  const error = new NormalModeError(
    `complete scoring required before selection: unscored=${selection.unscoredCount}, scoring-failed=${selection.scoringFailedCount}${scorerCause}${causes.length ? `; ${causes.join('; ')}` : ''}`,
    'scoring',
  );
  return error;
}

function hasUsableMatchScore(candidate) {
  const raw = candidate?.matchScore ?? candidate?.score;
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return false;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * In-run Match Score step. Default is OFF: without an injected scorer the pool
 * is returned untouched and telemetry is null, keeping runs fully offline. The
 * scorer only sees rows that still lack a usable Match Score — a --scores-json
 * manual override always wins on any row it covers.
 */
async function scorePoolInRun(candidates, scorer, { runId, runAt } = {}) {
  if (typeof scorer !== 'function') return { pool: candidates, telemetry: null };
  const unscored = candidates.filter((candidate) => !hasUsableMatchScore(candidate));
  if (!unscored.length) return { pool: candidates, telemetry: { attempted: 0, chunks: 0, failures: [], degraded: false, reasonCode: null } };
  const scoring = await scorer(unscored, { runId, runAt });
  const merged = new Map((Array.isArray(scoring?.scored) ? scoring.scored : []).map((candidate) => [candidate.canonicalUrl, candidate]));
  const failures = Array.isArray(scoring?.failures) ? scoring.failures : [];
  const failuresByUrl = new Map(failures.map((failure) => [failure.canonicalUrl, failure]));
  return {
    pool: candidates.map((candidate) => {
      const scored = merged.get(candidate.canonicalUrl);
      const failure = failuresByUrl.get(candidate.canonicalUrl);
      return failure ? {
        ...(scored ?? candidate),
        matchScore: null,
        autoSuggest: false,
        scoringFailed: true,
        scoringFailureReason: failure.reason,
        scoringFailureStderr: failure.stderr ?? null,
      } : scored ?? candidate;
    }),
    telemetry: {
      attempted: unscored.length,
      chunks: Number.isFinite(Number(scoring?.chunks)) ? Number(scoring.chunks) : 0,
      failures,
      degraded: scoring?.degraded === true,
      reasonCode: scoring?.reasonCode ?? null,
    },
  };
}

/** Complete fixture/injection seam for India-first Normal mode. */
export async function runNormalMode({
  mode = 'normal', clock = () => new Date().toISOString(), runId: suppliedRunId = null,
  sourceFunctions = {}, sourceFixtures = {}, laneInputs = {}, notionGateway = createNoWriteNotionGateway(),
  executeGateway = false, config = null, conversionPlan = null, ledgerRows = null, opportunityLedgerRows = null,
  historicalV4Rows = [], includeCrawlerLanes = false, enrichmentBudget = 50, scores, scorer,
  seniorityClassifier = null, seniorityCache = null, seniorityPromptVersion, seniorityModelVersion,
  readinessRepairer = null, readinessRepairMaxRequests = 20, readinessRepairDeadlineMs = 30_000,
  runDeadlineAt = null, monotonicClock = Date.now,
} = {}) {
  if (String(mode).toLowerCase() !== 'normal') throw new NormalModeError(`Issue03 runner only supports normal mode, received ${mode}`, 'mode');
  const runAt = readClock(clock);
  const runId = suppliedRunId || `normal-${runAt}`;
  let sourceResults = [];
  try {
    sourceResults = await runNormalSourcePlan({ sourceFunctions, sourceFixtures, laneInputs, runAt, runId, includeCrawlerLanes });
    sourceResults = applyScores(sourceResults, scores);
    await enrichWorkdayCandidates(sourceResults.flatMap((source) => source.candidates), { maxRequests: enrichmentBudget });
    const seniority = await classifySeniorityPool(
      sourceResults.flatMap((source) => source.candidates),
      {
        classifyModel: seniorityClassifier,
        ...(seniorityCache ? { cache: seniorityCache } : {}),
        ...(seniorityPromptVersion ? { promptVersion: seniorityPromptVersion } : {}),
        ...(seniorityModelVersion ? { modelVersion: seniorityModelVersion } : {}),
      },
    );
    let seniorityIndex = 0;
    sourceResults = sourceResults.map((source) => ({
      ...source,
      candidates: source.candidates.map(() => seniority.pool[seniorityIndex++]),
    }));
    const sourceManifests = sourceResults.map(({ manifest }) => manifest);
    const baseConfig = config || loadConfig();
    const baseConversionPlan = conversionPlan || loadConversionPlan();
    assertValidConfig(baseConfig);
    assertValidConversionPlan(baseConversionPlan);
    const normalConfig = structuredClone(baseConfig);
    normalConfig.run = { ...normalConfig.run, minimumTotal: 10, maximumTotal: 20, strictTarget: 10 };
    const effectiveLedgerRows = ledgerRows ?? readLedger().rows;
    const effectiveOpportunityLedgerRows = opportunityLedgerRows ?? readOpportunityLedger().rows;
    const pipeline = runPipeline({
      config: normalConfig, conversionPlan: baseConversionPlan, now: runAt, runId,
      ledgerRows: effectiveLedgerRows, opportunityLedgerRows: effectiveOpportunityLedgerRows, sources: sourceResults, dryRun: true,
    });
    // v4 identity matches are suppressed before they reach shortlist/Notion planning.
    // Read-only against v4 rows: never migrates, mutates, or deletes historical data.
    const {
      kept: nonHistoricalCandidates,
      suppressed: historicalSuppressions,
      ambiguous: historicalAmbiguous,
    } = filterHistoricalCandidates(pipeline.scoringCandidates, historicalV4Rows);
    const readinessRepair = await repairReadinessPool(nonHistoricalCandidates, {
      repairCandidate: readinessRepairer,
      maxRequests: readinessRepairMaxRequests,
      now: runAt,
      maximumDurationMs: readinessRepairDeadlineMs,
      deadlineAtMs: runDeadlineAt == null ? null : Date.parse(runDeadlineAt),
      monotonicClock,
    });
    const { pool: scoredPool, telemetry: scorerTelemetry } = await scorePoolInRun(
      readinessRepair.scorerPool,
      scorer,
      { runId, runAt },
    );
    // A scorer opinion arrives after the first eligibility pass. Re-apply the
    // same deterministic gate before selection so a late uncertain/ineligible
    // adjudication cannot remain application-ready.
    const finalScoredPool = scoredPool.map((candidate) => {
      const seniorityAssessment = candidate.seniorityScoringOpinion || candidate.seniorityAssessment;
      if (!seniorityAssessment || seniorityAssessment === candidate.seniorityAssessment) return candidate;
      const assessedCandidate = { ...candidate, seniorityAssessment };
      return {
        ...assessedCandidate,
        eligibility: classifyCandidate(assessedCandidate, {
          ...normalConfig,
          salaryFloorLpa: baseConversionPlan.salaryFloorLpa,
        }),
      };
    });
    const seniorityTelemetry = {
      ...seniority.telemetry,
      scoringOpinions: finalScoredPool.filter((candidate) => candidate.seniorityScoringOpinion).length,
      postScoringUncertain: finalScoredPool.filter((candidate) => candidate.seniorityAssessment?.seniorityDecision === 'uncertain').length,
      postScoringIneligible: finalScoredPool.filter((candidate) => candidate.seniorityAssessment?.seniorityDecision === 'ineligible').length,
    };
    const convertedPool = finalScoredPool.map((candidate) => withConversionScore(candidate, {
      freshnessWindow: candidate.freshness?.window ?? null,
      eligibility: candidate.eligibility ?? null,
      policy: baseConversionPlan.conversionScore,
    }));
    const selectionEntries = convertedPool.map((candidate) => ({
      candidate, eligibility: candidate.eligibility, freshness: candidate.freshness,
    }));
    const selection = selectNormalApplications(selectionEntries, {
      maximumPerCompany: normalConfig.run.maximumPerCompany,
      maximumFamilyShare: normalConfig.run.maximumFamilyShare,
      strictTarget: normalConfig.run.strictTarget,
      scoreFloor: normalConfig.run.normalMatchScoreFloor,
      stretchFloor: normalConfig.run.stretchMatchScoreFloor,
    });
    const eligibleCount = pipeline.scoringCandidates.length;
    const droppedScoringRows = selection.unscoredCount > 0 || selection.scoringFailedCount > 0;
    const scorerRan = scorerTelemetry !== null;
    // Gate policy (docs/spec/match-scoring.md §6): with no scorer in the run
    // the legacy all-or-nothing gate stands — unscored rows then mean scoring
    // was never attempted, which must stay fatal. When a scorer did run, only
    // a genuinely broken scorer fails the run; per-row failures at or below
    // the threshold stay in the scoring queue and the run delivers the rest.
    const incompleteScoring = scorerRan ? scorerIsBroken(scorerTelemetry) : droppedScoringRows;
    const scoringDropped = scorerRan && droppedScoringRows && !incompleteScoring;
    const reconciliation = buildReconciliation({
      eligible: eligibleCount,
      historicalSuppressed: historicalSuppressions.length,
      historicalAmbiguous: historicalAmbiguous.length,
      selection,
      selected: incompleteScoring ? 0 : selection.selected.length,
      runFailed: incompleteScoring,
    });
    const verifiedCandidates = new Set(finalScoredPool.map((candidate) => candidate.canonicalUrl));
    const verificationCandidates = [
      ...finalScoredPool,
      ...sourceResults.flatMap((source) => source.candidates).filter((candidate) => !verifiedCandidates.has(candidate.canonicalUrl)),
    ];
    const verificationRows = [
      ...verificationCandidates.map((candidate) => verificationRecord(candidate, candidate.eligibility || null)).filter(Boolean),
      ...readinessRepair.rejected.map((record) => ({
        company: record.company,
        title: record.title,
        discoveryUrl: record.discoveryUrl,
        originalApplicationUrl: record.originalApplicationUrl,
        provider: record.provider,
        source: record.source,
        applicationResolution: record.applicationResolution,
        liveness: record.liveness,
        reasons: record.blockers,
        evidence: { readinessRepair: record },
        dedupKey: record.canonicalUrl,
      })),
      ...historicalAmbiguous.map((collision) => ({
        company: collision.company,
        title: collision.title,
        discoveryUrl: collision.candidate?.discoveryUrl || collision.canonicalUrl,
        originalApplicationUrl: collision.candidate?.originalApplicationUrl || null,
        provider: collision.candidate?.provider || null,
        source: collision.candidate?.source || null,
        applicationResolution: collision.candidate?.applicationResolution || null,
        liveness: collision.candidate?.liveness || null,
        reasons: ['AMBIGUOUS_HISTORICAL_COLLISION'],
        evidence: collision.evidence,
        dedupKey: candidateDedupKey(collision.candidate),
      })),
    ];
    const verificationQueue = [...new Map(verificationRows.map((record) => [
      record.discoveryUrl || record.dedupKey,
      record,
    ])).values()];
    if (incompleteScoring) {
      const error = scoringGateError(selection, scorerRan ? scorerTelemetry : null);
      error.details = {
        scoringQueue: selection.scoringQueue,
        readinessRepair: readinessRepair.telemetry,
        repairQueue: readinessRepair.repairQueue,
        stretchShortage: selection.stretch,
        selectionExclusions: selection.exclusions,
        strictComposition: selection.strictComposition,
        familyComposition: selection.familyComposition,
        seniority: seniorityTelemetry,
        scoring: {
          required: true,
          scoredCount: selection.scoredCount,
          unscoredCount: selection.unscoredCount,
          scoringFailedCount: selection.scoringFailedCount,
          selectedCount: 0,
          ...(scorerTelemetry ? { scorer: scorerTelemetry } : {}),
        },
        reconciliation,
        verificationQueue,
        funnel: pipeline.funnel,
        counts: {
          fetched: sourceResults.reduce((sum, source) => sum + source.candidates.length, 0),
          eligible: eligibleCount,
          scored: selection.scoredCount,
          ready: selection.readyCount,
          selected: 0,
          verificationQueue: verificationQueue.length,
          historicalSuppressed: historicalSuppressions.length,
          historicalAmbiguous: historicalAmbiguous.length,
          minimum: 10,
          preferred: 12,
          maximum: 20,
          stretch: selection.stretch.length,
          belowFloor: selection.scorePolicy.belowFloorCount,
          strictSelected: selection.strictComposition.selected,
          strictShortfall: selection.strictComposition.shortfall,
          unscored: selection.unscoredCount,
          scoringFailed: selection.scoringFailedCount,
        },
      };
      throw error;
    }
    const shortlist = selection.selected;
    const operations = shortlist.map((candidate) => ({
      operation: 'create', resource: 'application', dedupKey: candidateDedupKey(candidate),
      payload: v5Payload(candidate, runId),
      provenance: provenanceFor(candidate, runId),
    }));
    if (!notionGateway || typeof notionGateway.planWrites !== 'function') throw new NormalModeError('notion gateway must implement planWrites', 'notion');
    const planned = notionGateway.planWrites({ schemaVersion: 'LaunchpadV5NormalPlanV1', mode: 'normal', runId, runAt, operations: structuredClone(operations) });
    const plannedOperations = Array.isArray(planned) ? planned : planned?.operations;
    if (!Array.isArray(plannedOperations) || JSON.stringify(plannedOperations) !== JSON.stringify(operations)) throw new NormalModeError('notion gateway planWrites must return authoritative operations unchanged', 'notion');
    let transaction = null;
    if (executeGateway) {
      if (notionGateway.kind !== 'fake-transactional-v5' || typeof notionGateway.executeWrites !== 'function') throw new NormalModeError('live or non-transactional gateway execution is disabled; inject the Issue03 fake gateway', 'notion');
      transaction = await notionGateway.executeWrites({ operations: plannedOperations });
    }
    for (const source of sourceResults) {
      source.manifest.selected = 0;
      source.manifest.selected += shortlist.filter((candidate) => candidate.normalLaneId === source.manifest.sourceId).length;
    }
    const failedLanes = sourceManifests.filter((manifest) => {
      if (manifest.required === false) return manifest.status === 'failed';
      return manifest.status === 'failed' || manifest.status === 'unavailable';
    }).map((manifest) => manifest.sourceId);
    const emptyLanes = sourceManifests
      .filter((manifest) => ['empty', 'unavailable'].includes(manifest.status) && manifest.reasonCode !== 'PORTAL_REQUIRES_LIVE_INJECTION')
      .map((manifest) => manifest.sourceId);
    const missing = Math.max(0, 10 - shortlist.length);
    const scoringTelemetry = scorerTelemetry
      ? {
          required: selection.unscoredCount > 0 || selection.scoringFailedCount > 0,
          scoredCount: selection.scoredCount,
          unscoredCount: selection.unscoredCount,
          scoringFailedCount: selection.scoringFailedCount,
          selectedCount: shortlist.length,
          scorer: scorerTelemetry,
        }
      : null;
    const dcoTelemetry = buildDcoTelemetry({
      runId,
      runAt,
      sourceManifests,
      funnel: pipeline.funnel,
      readinessRepair: readinessRepair.telemetry,
      verificationQueue,
      historicalSuppressions,
      opportunitySuppressions: pipeline.funnel?.lifecycle?.suppressedActioned ?? 0,
      scoring: scoringTelemetry,
      selection,
      reconciliation,
    });
    return {
      schemaVersion: 'LaunchpadV5NormalModeV1', runId, runAt, mode: 'normal', shortlist,
      scoringQueue: selection.scoringQueue, funnel: pipeline.funnel,
      readinessRepair: readinessRepair.telemetry, repairQueue: readinessRepair.repairQueue,
      stretchShortage: selection.stretch,
      selectionExclusions: selection.exclusions,
      strictComposition: selection.strictComposition,
      familyComposition: selection.familyComposition,
      scorePolicy: selection.scorePolicy,
      seniority: seniorityTelemetry,
      verificationQueue, sourceManifests, sourceTelemetry: sourceManifests, plannedNotionOperations: plannedOperations, transaction,
      historicalSuppressions,
      historicalAmbiguous,
      dedupInputs: {
        committedLedgerRows: effectiveLedgerRows.length,
        opportunityLedgerRows: effectiveOpportunityLedgerRows.length,
      },
      shortfall: {
        minimum: 10, preferred: 12, maximum: 20, selected: shortlist.length, missing,
        preferredMissing: Math.max(0, 12 - shortlist.length), failedLanes, emptyLanes,
        reasons: [
          ...(missing ? ['APPLICATION_READY_MINIMUM_SHORTFALL'] : []),
          ...(selection.strictComposition.shortfall ? [`STRICT_COMPOSITION_SHORTFALL:${selection.strictComposition.shortfall}`] : []),
          ...failedLanes.map((lane) => `SOURCE_FAILED:${lane}`),
          ...emptyLanes.map((lane) => `SOURCE_EMPTY:${lane}`),
        ],
        linkedinRescueSuggestion: { suggested: missing >= 5, command: 'linkedin-leads', invoked: false, reason: missing >= 5 ? `verified inventory is short by ${missing}` : 'shortfall is below rescue threshold' },
      },
      outcome: { status: failedLanes.length || scoringDropped ? 'degraded' : 'ok', fatal: false, degraded: failedLanes.length > 0 || scoringDropped, errors: sourceManifests.map(issueFor).filter(Boolean) },
      reconciliation,
      telemetry: { dco: dcoTelemetry },
      ...(scoringTelemetry ? { scoring: scoringTelemetry } : {}),
      counts: { fetched: sourceResults.reduce((sum, source) => sum + source.candidates.length, 0), eligible: eligibleCount, scored: selection.scoredCount, ready: selection.readyCount, applicationReadyPool: selection.readyPoolCount, selected: shortlist.length, stretch: selection.stretch.length, belowFloor: selection.scorePolicy.belowFloorCount, strictSelected: selection.strictComposition.selected, strictShortfall: selection.strictComposition.shortfall, verificationQueue: verificationQueue.length, historicalSuppressed: historicalSuppressions.length, historicalAmbiguous: historicalAmbiguous.length, minimum: 10, preferred: 12, maximum: 20, bands: selection.bands, familyCounts: selection.familyCounts, companyCounts: selection.companyCounts, unscored: selection.unscoredCount, scoringFailed: selection.scoringFailedCount },
    };
  } catch (error) {
    return fatalResult(runId, runAt, 'normal', sourceResults.map(({ manifest }) => manifest), error, error.details);
  }
}
