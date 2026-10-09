import { assertValidConfig, assertValidConversionPlan, loadConfig, loadConversionPlan } from './config.mjs';
import { candidateDedupKey } from './candidate.mjs';
import { applyScores, runPipeline } from './run.mjs';
import { createNoWriteNotionGateway } from './workflow.mjs';
import { applicationReadiness } from './normal-readiness.mjs';
import { enrichStartupSources } from './startup-enrichment.mjs';
import { runStartupSourcePlan } from './startup-sources.mjs';
import { selectStartupApplications } from './startup-selection.mjs';
import { filterHistoricalCandidates } from '../crawler/historical-suppression.mjs';
import { readOpportunityLedger, recordSurfaced } from './opportunity-ledger.mjs';
import {
  buildDeliveryPlan, buildDeliveryReconciliation, buildReconciliation, emptyDeliveryPlan,
  hasUsableMatchScore, partialSourceReasons, scorePoolInRun, scorerIsBroken,
  scoringGateError, selectionRejectionReasons, sourceCoverageFromManifests,
} from './mode-scoring.mjs';

export const STARTUP_MODE_SCHEMA_VERSION = 'LaunchpadV5StartupModeV1';

export class StartupModeError extends Error {
  constructor(message, stage = 'startup-mode') { super(message); this.name = 'StartupModeError'; this.stage = stage; }
}

function readClock(clock) {
  const value = typeof clock === 'function' ? clock() : clock && typeof clock.now === 'function' ? clock.now() : clock;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new StartupModeError('invalid injected clock value', 'clock');
  return date.toISOString();
}

function jsonEvidence(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function issueFor(manifest) {
  if (manifest.status !== 'ok' || manifest.errors?.length) return { sourceId: manifest.sourceId, status: manifest.status, errors: manifest.errors || [] };
  return null;
}

function startupPayload(candidate, runId) {
  const company = candidate.companyRecord || {};
  const sourceEvidence = candidate.evidence?.discovery || {};
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
    resumeState: 'Not Started',
    employmentCategory: candidate.employment?.type === 'internship' ? 'Internship' : candidate.employment?.type === 'contract' ? 'Contractor/EOR' : 'Full-time',
    selectionTier: candidate.selectionTier,
    relaxation: candidate.relaxations || [],
    roleFamily: candidate.roleFamily || null,
    companyStage: candidate.companyStage || null,
    workMode: candidate.workMode ? candidate.workMode[0].toUpperCase() + candidate.workMode.slice(1) : null,
    location: candidate.location,
    matchScore: candidate.matchScore,
    conversionScore: candidate.conversionScore,
    responseLikelihood: candidate.responseLikelihood,
    source: candidate.source,
    provider: candidate.provider,
    sourceJobId: candidate.jobId,
    originalApplicationEvidence: candidate.originalApplicationEvidence || candidate.applicationResolution?.evidence || null,
    liveness: candidate.liveness?.status,
    requirementsEvidence: jsonEvidence(candidate.requirementsEvidence || candidate.evidence?.requirements || candidate.experience?.evidence),
    relaxationEvidence: jsonEvidence(candidate.readinessEvidence),
    rationale: candidate.rationale,
    hook: candidate.hook,
    runId,
    dedupKey: candidateDedupKey(candidate),
    syncKey: candidateDedupKey(candidate),
    // Startup fields are additive evidence for the v5 application operation.
    discoveryMode: 'Startup',
    startupSource: candidate.startupSource || sourceEvidence.source || candidate.source,
    startupSourceLanes: candidate.startupSourceLanes || [],
    companyStageEvidence: candidate.companyStageEvidence || null,
    companyVerifiedAt: candidate.companyVerifiedAt || null,
    fundingDate: candidate.fundingDate || null,
    fundingEvidence: candidate.fundingEvidence || null,
    fundingSignal: candidate.fundingSignal || null,
    hiringSignal: candidate.hiringSignal || null,
    careerPageUrl: candidate.careerPageUrl || company.careerPageUrl || null,
    atsProvider: candidate.atsProvider || company.atsProvider || null,
    atsBoardUrl: candidate.atsBoardUrl || company.atsBoardUrl || null,
    remotePolicy: candidate.remotePolicy || company.remotePolicy || null,
    companyRecord: company,
  };
}

function provenanceFor(candidate, runId) {
  return {
    discoveryUrl: candidate.discoveryUrl || candidate.canonicalUrl,
    discoverySource: candidate.discoverySource || candidate.source,
    discoveryCategory: candidate.discoveryCategory || candidate.sourceCategory,
    discoveryProvider: candidate.provider,
    originalApplicationUrl: candidate.originalApplicationUrl,
    originalApplicationEvidence: candidate.originalApplicationEvidence || candidate.applicationResolution?.evidence || null,
    verifiedAt: candidate.verifiedAt || candidate.liveness?.checkedAt || null,
    postedAt: candidate.postedAt,
    discoveredAt: candidate.discoveredAt,
    crawledAt: candidate.crawledAt,
    location: candidate.location,
    experience: candidate.experience,
    employment: candidate.employment,
    liveness: candidate.liveness,
    score: candidate.matchScore,
    rationale: candidate.rationale,
    hook: candidate.hook,
    startup: {
      source: candidate.startupSource || candidate.source,
      sourceLanes: candidate.startupSourceLanes || [],
      company: candidate.companyRecord || null,
      stage: candidate.companyStage || null,
      stageEvidence: candidate.companyStageEvidence || null,
      verifiedAt: candidate.companyVerifiedAt || null,
      funding: candidate.fundingSignal || null,
      careerPageUrl: candidate.careerPageUrl || null,
      atsProvider: candidate.atsProvider || null,
      atsBoardUrl: candidate.atsBoardUrl || null,
      remotePolicy: candidate.remotePolicy || null,
    },
    runId,
    dedupKey: candidateDedupKey(candidate),
  };
}

function verificationRecord(candidate, eligibility) {
  const readiness = applicationReadiness(candidate, eligibility);
  if (readiness.ready && candidate.postedAt) return null;
  const reasons = [...readiness.reasons];
  if (!candidate.postedAt) reasons.push('FRESHNESS_NOT_VERIFIED');
  return {
    company: candidate.company,
    title: candidate.title,
    discoveryUrl: candidate.discoveryUrl || candidate.canonicalUrl,
    originalApplicationUrl: candidate.originalApplicationUrl,
    provider: candidate.provider,
    source: candidate.source,
    applicationResolution: readiness.evidence.resolution,
    liveness: readiness.evidence.liveness,
    reasons: [...new Set(reasons)],
    evidence: readiness.evidence,
    companyRecord: candidate.companyRecord || null,
    dedupKey: candidateDedupKey(candidate),
  };
}

function fatalResult(runId, runAt, sourceManifests, companyRecords, error) {
  const details = error.details || {};
  return {
    schemaVersion: STARTUP_MODE_SCHEMA_VERSION, runId, runAt, mode: 'startup', results: [], shortlist: [], verificationQueue: [], sourceManifests, sourceTelemetry: sourceManifests,
    companyRecords, plannedNotionOperations: [], deliveryPlan: emptyDeliveryPlan(), deliveryReconciliation: buildDeliveryReconciliation({ status: 'failed' }), writesPlanned: false, transaction: null, historicalSuppressions: [], scoringQueue: details.scoringQueue || [], scoring: details.scoring || null, reconciliation: details.reconciliation || null,
    shortfall: { minimum: 10, preferred: 12, maximum: 20, selected: 0, missing: 10, failedLanes: sourceManifests.filter((item) => ['failed', 'unavailable'].includes(item.status)).map((item) => item.sourceId), emptyLanes: [], linkedinRescueSuggestion: { suggested: true, command: 'linkedin-leads', invoked: false } },
    outcome: { status: 'fatal', fatal: true, degraded: false, errors: [{ stage: error.stage || 'pipeline', name: error.name || 'Error', message: error.message || String(error) }] },
    counts: details.counts || null,
  };
}

/** Complete fixture/injection seam for Startup mode; no source or Notion network primitive is used. */
export async function runStartupMode({
  mode = 'startup', clock = () => new Date().toISOString(), runId: suppliedRunId = null,
  sourceFunctions = {}, sourceFixtures = {}, laneInputs = {}, notionGateway = createNoWriteNotionGateway(), executeGateway = false,
  config = null, conversionPlan = null, ledgerRows = [], opportunityLedgerRows = null, opportunityLedgerPath = null, historicalV4Rows = [], scores, scorer, dailyExcludedKeys = [], previousDailyCandidates = [], scoringSignal = null, scoringRemainingMs = null, commitSurfaced = false, partial = false, shortlistLimit = null,
} = {}) {
  if (String(mode).toLowerCase() !== 'startup') throw new StartupModeError(`Startup runner only supports startup mode, received ${mode}`, 'mode');
  const runAt = readClock(clock);
  const runId = suppliedRunId || `startup-${runAt}`;
  let sourceResults = [];
  let companyRecords = [];
  try {
    sourceResults = await runStartupSourcePlan({ sourceFunctions, sourceFixtures, laneInputs, runAt, runId });
    sourceResults = applyScores(sourceResults, scores);
    const enriched = enrichStartupSources(sourceResults, { runAt });
    sourceResults = enriched.sources;
    companyRecords = enriched.companyRecords;
    const sourceManifests = sourceResults.map(({ manifest }) => manifest);
    const baseConfig = config || loadConfig();
    const baseConversionPlan = conversionPlan || loadConversionPlan();
    assertValidConfig(baseConfig);
    assertValidConversionPlan(baseConversionPlan);
    const effectiveOpportunityLedgerRows = opportunityLedgerRows ?? readOpportunityLedger(opportunityLedgerPath ?? undefined).rows;
    const pipeline = runPipeline({ config: baseConfig, conversionPlan: baseConversionPlan, now: runAt, runId, ledgerRows, opportunityLedgerRows: effectiveOpportunityLedgerRows, opportunityLedgerPath, sources: sourceResults, dryRun: true });
    // v4 identity matches are suppressed before they reach shortlist/Notion planning.
    // Read-only against v4 rows: never migrates, mutates, or deletes historical data.
    const { kept: nonHistoricalCandidates, suppressed: historicalSuppressions } = filterHistoricalCandidates(pipeline.postSuppressionCandidates, historicalV4Rows);
    const { pool: scoredPool, telemetry: scorerTelemetry } = await scorePoolInRun(nonHistoricalCandidates.filter((candidate) => !dailyExcludedKeys.includes(candidateDedupKey(candidate)) && applicationReadiness(candidate, candidate.eligibility).ready), scorer, { runId, runAt, signal: scoringSignal, remainingMs: scoringRemainingMs });
    const selectionEntries = scoredPool.map((candidate) => ({ candidate, eligibility: candidate.eligibility, freshness: candidate.freshness }));
    if (shortlistLimit != null && (!Number.isInteger(shortlistLimit) || shortlistLimit < 0 || shortlistLimit > 20)) throw new StartupModeError('shortlist limit must be an integer between 0 and 20', 'selection');
    const selection = selectStartupApplications(selectionEntries, { previousDailyCandidates, maximum: shortlistLimit ?? 20, maximumPerCompany: baseConfig.run.maximumPerCompany });
    const eligibleCount = pipeline.scoringCandidates.length;
    const scorerRan = scorerTelemetry !== null;
    const scoringBudgetEnded = ['SCORER_DEADLINE_EXCEEDED', 'SCORER_ABORTED'].includes(scorerTelemetry?.reasonCode);
    const droppedScoringRows = selection.unscoredCount > 0 || selection.scoringFailedCount > 0;
    const incompleteScoring = scorerRan ? scorerIsBroken(scorerTelemetry) : droppedScoringRows;
    const scoringDropped = scorerRan && droppedScoringRows && !incompleteScoring;
    const reconciliation = buildReconciliation({ fetched: pipeline.counts.fetched, dated: pipeline.counts.dated, eligible: eligibleCount, historicalSuppressed: historicalSuppressions.length, selection, selected: incompleteScoring ? 0 : selection.selected.length, runFailed: incompleteScoring });
    const rejectionReasons = selectionRejectionReasons({ pipeline, selection, eligible: eligibleCount, selected: incompleteScoring ? 0 : selection.selected.length });
    if (partial || scoringBudgetEnded) {
      const scoredReady = scoredPool.filter((candidate) => hasUsableMatchScore(candidate) && applicationReadiness(candidate, candidate.eligibility).ready);
      const scorePendingReady = selection.scoringQueue.filter((candidate) => applicationReadiness(candidate, candidate.eligibility).ready);
      const candidatesByUrl = new Map(pipeline.scoringCandidates.map((candidate) => [candidate.canonicalUrl, candidate]));
      const verificationQueue = sourceResults.flatMap((source) => source.candidates)
        .map((candidate) => candidatesByUrl.get(candidate.canonicalUrl) || candidate)
        .map((candidate) => verificationRecord(candidate, candidate.eligibility || null))
        .filter(Boolean)
        .filter((record, index, records) => records.findIndex((item) => item.dedupKey === record.dedupKey) === index);
      return {
        schemaVersion: STARTUP_MODE_SCHEMA_VERSION, runId, runAt, mode: 'startup', results: selection.results, shortlist: selection.selected,
        scoredReady, scorePendingReady, fallback: selection.selected.filter((candidate) => candidate.selectionTier === 'Fallback'),
        verificationQueue, sourceManifests, sourceTelemetry: sourceManifests, plannedNotionOperations: [], deliveryPlan: emptyDeliveryPlan(), deliveryReconciliation: buildDeliveryReconciliation({ status: 'partial', sourceCoverage: sourceCoverageFromManifests(sourceManifests), rejectionReasons: [...rejectionReasons, ...partialSourceReasons(sourceManifests)] }), writesPlanned: false, transaction: null,
        historicalSuppressions, scoringQueue: selection.scoringQueue, reconciliation,
        outcome: { status: 'partial', fatal: false, degraded: true, errors: [{ stage: 'recovery', name: 'PartialRun', message: 'source coverage or downstream scoring budget ended before completion' }] },
        counts: { fetched: pipeline.counts.fetched, dated: pipeline.counts.dated, eligible: eligibleCount, scored: selection.scoredCount, ready: selection.readyCount, selected: selection.selected.length, verificationQueue: verificationQueue.length, unscored: selection.unscoredCount, scoringFailed: selection.scoringFailedCount },
      };
    }
    if (incompleteScoring) {
      const error = scoringGateError(StartupModeError, selection, scorerRan ? scorerTelemetry : null);
      error.details = {
        scoringQueue: selection.scoringQueue,
        scoring: { required: true, scoredCount: selection.scoredCount, unscoredCount: selection.unscoredCount, scoringFailedCount: selection.scoringFailedCount, selectedCount: 0, ...(scorerTelemetry ? { scorer: scorerTelemetry } : {}) },
        reconciliation,
        counts: { fetched: pipeline.counts.fetched, dated: pipeline.counts.dated, eligible: eligibleCount, scored: selection.scoredCount, ready: selection.readyCount, selected: 0, unscored: selection.unscoredCount, scoringFailed: selection.scoringFailedCount },
      };
      throw error;
    }
    const shortlist = selection.selected;
    const operations = shortlist.map((candidate) => ({ operation: 'create', resource: 'application', dedupKey: candidateDedupKey(candidate), payload: startupPayload(candidate, runId), provenance: provenanceFor(candidate, runId), company: candidate.companyRecord || null }));
    if (!notionGateway || typeof notionGateway.planWrites !== 'function') throw new StartupModeError('notion gateway must implement planWrites', 'notion');
    const planned = notionGateway.planWrites({ schemaVersion: 'LaunchpadV5PlanV1', mode: 'startup', runId, runAt, operations: structuredClone(operations) });
    const plannedOperations = Array.isArray(planned) ? planned : planned?.operations;
    if (!Array.isArray(plannedOperations) || JSON.stringify(plannedOperations) !== JSON.stringify(operations)) throw new StartupModeError('notion gateway planWrites must return authoritative operations unchanged', 'notion');
    let transaction = null;
    if (executeGateway) {
      if (notionGateway.kind !== 'fake-transactional-v5' || typeof notionGateway.executeWrites !== 'function') throw new StartupModeError('live or non-transactional gateway execution is disabled; inject the startup test fake gateway', 'notion');
      transaction = await notionGateway.executeWrites({ operations: plannedOperations });
    }
    const deliveryPlan = buildDeliveryPlan({ shortlist, plannedNotionOperations: plannedOperations });
    const surfaced = commitSurfaced ? recordSurfaced(deliveryPlan.opportunitySurfacing, { path: opportunityLedgerPath || undefined, now: runAt }) : null;
    const candidatesByUrl = new Map(pipeline.scoringCandidates.map((candidate) => [candidate.canonicalUrl, candidate]));
    const verificationQueue = sourceResults.flatMap((source) => source.candidates)
      .map((candidate) => candidatesByUrl.get(candidate.canonicalUrl) || candidate)
      .map((candidate) => verificationRecord(candidate, candidate.eligibility || null))
      .filter(Boolean)
      .filter((record, index, records) => records.findIndex((item) => item.dedupKey === record.dedupKey) === index);
    for (const source of sourceResults) source.manifest.selected = shortlist.filter((candidate) => candidate.startupLaneId === source.manifest.sourceId).length;
    const failedLanes = sourceManifests.filter((manifest) => ['failed', 'unavailable'].includes(manifest.status)).map((manifest) => manifest.sourceId);
    const emptyLanes = sourceManifests.filter((manifest) => manifest.status === 'empty').map((manifest) => manifest.sourceId);
    const missing = Math.max(0, 10 - shortlist.length);
    return {
      schemaVersion: STARTUP_MODE_SCHEMA_VERSION, runId, runAt, mode: 'startup', results: selection.results, shortlist, verificationQueue, sourceManifests, sourceTelemetry: sourceManifests, companyRecords, plannedNotionOperations: plannedOperations, deliveryPlan, deliveryReconciliation: buildDeliveryReconciliation({ status: 'completed', deliveryPlan, sourceCoverage: sourceCoverageFromManifests(sourceManifests), rejectionReasons, surfacedCount: surfaced?.rows?.length ?? null }), writesPlanned: plannedOperations.length > 0, transaction,
      historicalSuppressions,
      scoringQueue: selection.scoringQueue,
      ...(scorerTelemetry ? { scoring: { required: selection.unscoredCount > 0 || selection.scoringFailedCount > 0, scoredCount: selection.scoredCount, unscoredCount: selection.unscoredCount, scoringFailedCount: selection.scoringFailedCount, selectedCount: shortlist.length, scorer: scorerTelemetry } } : {}),
      reconciliation,
      shortfall: { minimum: 10, preferred: 12, maximum: 20, selected: shortlist.length, missing, preferredMissing: Math.max(0, 12 - shortlist.length), failedLanes, emptyLanes, reasons: [...(missing ? ['APPLICATION_READY_MINIMUM_SHORTFALL'] : []), ...failedLanes.map((lane) => `SOURCE_FAILED:${lane}`), ...emptyLanes.map((lane) => `SOURCE_EMPTY:${lane}`), ...(shortlist.length === 0 ? rejectionReasons : [])], linkedinRescueSuggestion: { suggested: missing >= 5, command: 'linkedin-leads', invoked: false, reason: missing >= 5 ? `verified inventory is short by ${missing}` : 'shortfall is below rescue threshold' } },
      outcome: { status: failedLanes.length || scoringDropped || sourceManifests.some((manifest) => manifest.errors.length) ? 'degraded' : 'ok', fatal: false, degraded: Boolean(failedLanes.length || scoringDropped || sourceManifests.some((manifest) => manifest.errors.length)), errors: sourceManifests.map(issueFor).filter(Boolean) },
      rejectionReasons,
      counts: { fetched: pipeline.counts.fetched, dated: pipeline.counts.dated, companyRecords: companyRecords.length, fundingSignals: companyRecords.filter((company) => company.fundingSignal?.within18Months).length, underSixMonthFunding: companyRecords.filter((company) => company.fundingSignal?.under6Months).length, eligible: eligibleCount, scored: selection.scoredCount, ready: selection.readyCount, applicationReadyPool: selection.readyPoolCount, selected: shortlist.length, verificationQueue: verificationQueue.length, historicalSuppressed: historicalSuppressions.length, minimum: 10, preferred: 12, maximum: 20, strictSelected: selection.strictSelected, strictShortfall: selection.strictShortfall, bands: selection.bands, familyCounts: selection.familyCounts, startupSources: selection.startupSources, unscored: selection.unscoredCount, scoringFailed: selection.scoringFailedCount },
    };
  } catch (error) {
    return fatalResult(runId, runAt, sourceResults.map(({ manifest }) => manifest), companyRecords, error);
  }
}
