import { assertValidConfig, assertValidConversionPlan, loadConfig, loadConversionPlan } from './config.mjs';
import { candidateDedupKey } from './candidate.mjs';
import { applyScores, runPipeline } from './run.mjs';
import { createNoWriteNotionGateway } from './workflow.mjs';
import { applicationReadiness } from './normal-readiness.mjs';
import { enrichRemoteSources, REMOTE_SCHEMA_FIELDS } from './remote-enrichment.mjs';
import { runRemoteSourcePlan } from './remote-sources.mjs';
import { selectRemoteApplications } from './remote-selection.mjs';
import { filterHistoricalCandidates } from '../crawler/historical-suppression.mjs';
import { readOpportunityLedger, recordSurfaced } from './opportunity-ledger.mjs';
import {
  buildDeliveryPlan, buildDeliveryReconciliation, buildReconciliation, emptyDeliveryPlan,
  hasUsableMatchScore, partialSourceReasons, scorePoolInRun, scorerIsBroken,
  scoringGateError, selectionRejectionReasons, sourceCoverageFromManifests,
} from './mode-scoring.mjs';

export const REMOTE_MODE_SCHEMA_VERSION = 'LaunchpadV5RemoteModeV1';

export class RemoteModeError extends Error {
  constructor(message, stage = 'remote-mode') { super(message); this.name = 'RemoteModeError'; this.stage = stage; }
}

function readClock(clock) {
  const value = typeof clock === 'function' ? clock() : clock && typeof clock.now === 'function' ? clock.now() : clock;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new RemoteModeError('invalid injected clock value', 'clock');
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

function remotePayload(candidate, runId) {
  const eligibility = candidate.remoteEligibilityDecision || {};
  const employment = candidate.remoteEmploymentDecision || {};
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
    employmentCategory: employment.category || 'Full-time Employee',
    employmentStructure: employment.category || null,
    selectionTier: candidate.selectionTier,
    relaxation: candidate.relaxations || [],
    roleFamily: candidate.roleFamily || null,
    companyStage: candidate.companyStage || null,
    workMode: candidate.workMode ? candidate.workMode[0].toUpperCase() + candidate.workMode.slice(1) : 'Remote',
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
    discoveryMode: 'Remote',
    remoteEligibilityClass: eligibility.classification || null,
    remoteEligibilityStatus: eligibility.status || 'Needs Verification',
    remoteScopeEvidence: candidate.remoteEvidence?.scope || eligibility.evidence || null,
    citizenshipEvidence: candidate.remoteEvidence?.citizenship || null,
    countryRestrictionEvidence: candidate.remoteEvidence?.country || null,
    workAuthorizationEvidence: candidate.remoteEvidence?.workAuthorization || null,
    payrollEvidence: candidate.remoteEvidence?.payroll || null,
    employmentStabilityEvidence: candidate.remoteEvidence?.employment || employment.evidence || null,
    timezoneEvidence: candidate.timezoneDecision || { accepted: true },
    providerDateEvidence: candidate.providerDateEvidence || null,
    remoteProviderPolicy: candidate.remoteProviderPolicy || null,
    schemaIntegrationRequired: true,
    missingFields: [...REMOTE_SCHEMA_FIELDS],
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
    providerDateEvidence: candidate.providerDateEvidence || null,
    remote: {
      eligibility: candidate.remoteEligibilityDecision || null,
      employment: candidate.remoteEmploymentDecision || null,
      scopeEvidence: candidate.remoteEvidence?.scope || null,
      citizenshipEvidence: candidate.remoteEvidence?.citizenship || null,
      countryRestrictionEvidence: candidate.remoteEvidence?.country || null,
      workAuthorizationEvidence: candidate.remoteEvidence?.workAuthorization || null,
      payrollEvidence: candidate.remoteEvidence?.payroll || null,
      timezoneAccepted: true,
    },
    score: candidate.matchScore,
    rationale: candidate.rationale,
    hook: candidate.hook,
    runId,
    dedupKey: candidateDedupKey(candidate),
  };
}

function verificationRecord(candidate, pipelineCandidate = null) {
  const eligibility = pipelineCandidate?.eligibility || null;
  const freshness = pipelineCandidate?.freshness || null;
  const readiness = applicationReadiness(candidate, eligibility);
  const reasons = [
    ...(candidate.remoteEligibilityDecision?.reasons || []),
    ...(candidate.remoteEmploymentDecision?.reasons || []),
    ...readiness.reasons,
  ];
  if (!candidate.postedAt || freshness?.verifyQueue) reasons.push('FRESHNESS_NOT_VERIFIED');
  if (candidate.remoteReady && freshness && !freshness.eligible) reasons.push(freshness.code);
  if (!reasons.length) return null;
  return {
    company: candidate.company,
    title: candidate.title,
    discoveryUrl: candidate.discoveryUrl || candidate.canonicalUrl,
    originalApplicationUrl: candidate.originalApplicationUrl,
    provider: candidate.provider,
    source: candidate.source,
    applicationResolution: readiness.evidence.resolution,
    liveness: readiness.evidence.liveness,
    remoteEligibility: candidate.remoteEligibilityDecision || null,
    employment: candidate.remoteEmploymentDecision || null,
    reasons: [...new Set(reasons)],
    evidence: readiness.evidence,
    providerDateEvidence: candidate.providerDateEvidence || null,
    schemaIntegrationRequired: true,
    missingFields: [...REMOTE_SCHEMA_FIELDS],
    dedupKey: candidateDedupKey(candidate),
  };
}

function fatalResult(runId, runAt, sourceManifests, error) {
  const details = error.details || {};
  return {
    schemaVersion: REMOTE_MODE_SCHEMA_VERSION,
    runId,
    runAt,
    mode: 'remote',
    discoveryMode: 'Remote',
    shortlist: [],
    verificationQueue: [],
    sourceManifests,
    sourceTelemetry: sourceManifests,
    plannedNotionOperations: [], deliveryPlan: emptyDeliveryPlan(), deliveryReconciliation: buildDeliveryReconciliation({ status: 'failed' }), writesPlanned: false,
    transaction: null,
    historicalSuppressions: [],
    scoringQueue: details.scoringQueue || [],
    scoring: details.scoring || null,
    reconciliation: details.reconciliation || null,
    shortfall: { minimum: 10, preferred: 12, maximum: 20, selected: 0, missing: 10, failedLanes: sourceManifests.filter((item) => ['failed', 'unavailable'].includes(item.status)).map((item) => item.sourceId), emptyLanes: [], linkedinRescueSuggestion: { suggested: true, command: 'linkedin-leads', invoked: false } },
    outcome: { status: 'fatal', fatal: true, degraded: false, errors: [{ stage: error.stage || 'pipeline', name: error.name || 'Error', message: error.message || String(error) }] },
    counts: details.counts || null,
  };
}

/** Complete fixture/injection seam for Remote mode. It never performs live source or Notion access. */
export async function runRemoteMode({
  mode = 'remote', clock = () => new Date().toISOString(), runId: suppliedRunId = null,
  sourceFunctions = {}, sourceFixtures = {}, laneInputs = {}, providerFetchers = {},
  notionGateway = createNoWriteNotionGateway(), executeGateway = false,
  config = null, conversionPlan = null, ledgerRows = [], opportunityLedgerRows = null, historicalV4Rows = [],
  opportunityLedgerPath = null, scores, scorer, dailyExcludedKeys = [], previousDailyCandidates = [], scoringSignal = null, scoringRemainingMs = null, commitSurfaced = false, partial = false, shortlistLimit = null,
} = {}) {
  if (String(mode).toLowerCase() !== 'remote') throw new RemoteModeError(`Remote runner only supports remote mode, received ${mode}`, 'mode');
  const runAt = readClock(clock);
  const runId = suppliedRunId || `remote-${runAt}`;
  let sourceResults = [];
  try {
    sourceResults = enrichRemoteSources(await runRemoteSourcePlan({ sourceFunctions, sourceFixtures, laneInputs, providerFetchers, runAt, runId }));
    sourceResults = applyScores(sourceResults, scores);
    const sourceManifests = sourceResults.map(({ manifest }) => manifest);
    const baseConfig = config || loadConfig();
    const baseConversionPlan = conversionPlan || loadConversionPlan();
    assertValidConfig(baseConfig);
    assertValidConversionPlan(baseConversionPlan);
    const remoteConfig = structuredClone(baseConfig);
    remoteConfig.run = { ...remoteConfig.run, minimumTotal: 10, maximumTotal: 20, strictTarget: 10 };
    remoteConfig.employment.allowedTypes = [...new Set([...remoteConfig.employment.allowedTypes, 'contract'])];
    const effectiveOpportunityLedgerRows = opportunityLedgerRows ?? readOpportunityLedger(opportunityLedgerPath ?? undefined).rows;
    const pipeline = runPipeline({ config: remoteConfig, conversionPlan: baseConversionPlan, now: runAt, runId, ledgerRows, opportunityLedgerRows: effectiveOpportunityLedgerRows, opportunityLedgerPath, sources: sourceResults, dryRun: true });
    const pipelineByUrl = new Map(pipeline.scoringCandidates.map((candidate) => [candidate.canonicalUrl, candidate]));
    // v4 identity matches are suppressed before they reach shortlist/Notion planning.
    // Read-only against v4 rows: never migrates, mutates, or deletes historical data.
    const { kept: nonHistoricalCandidates, suppressed: historicalSuppressions } = filterHistoricalCandidates(pipeline.postSuppressionCandidates, historicalV4Rows);
    const { pool: scoredPool, telemetry: scorerTelemetry } = await scorePoolInRun(nonHistoricalCandidates.filter((candidate) => !dailyExcludedKeys.includes(candidateDedupKey(candidate)) && applicationReadiness(candidate, candidate.eligibility).ready), scorer, { runId, runAt, signal: scoringSignal, remainingMs: scoringRemainingMs });
    const selectionEntries = scoredPool
      .filter((candidate) => candidate.remoteReady === true)
      .map((candidate) => ({ candidate, eligibility: candidate.eligibility, freshness: candidate.freshness }));
    if (shortlistLimit != null && (!Number.isInteger(shortlistLimit) || shortlistLimit < 0 || shortlistLimit > 20)) throw new RemoteModeError('shortlist limit must be an integer between 0 and 20', 'selection');
    const selection = selectRemoteApplications(selectionEntries, { previousDailyCandidates, maximum: shortlistLimit ?? 20, maximumPerCompany: remoteConfig.run.maximumPerCompany });
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
      const selectedKeys = new Set(selection.selected.map((candidate) => candidateDedupKey(candidate)));
      const verificationQueue = sourceResults.flatMap((source) => source.candidates)
        .filter((candidate) => !selectedKeys.has(candidateDedupKey(candidate)))
        .map((candidate) => verificationRecord(candidate, pipelineByUrl.get(candidate.canonicalUrl) || candidate))
        .filter(Boolean)
        .filter((record, index, records) => records.findIndex((item) => item.dedupKey === record.dedupKey) === index);
      return {
        schemaVersion: REMOTE_MODE_SCHEMA_VERSION, runId, runAt, mode: 'remote', discoveryMode: 'Remote', shortlist: selection.selected,
        scoredReady, scorePendingReady, backfill: selection.selected.filter((candidate) => candidate.selectionTier === 'Backfill'),
        verificationQueue, sourceManifests, sourceTelemetry: sourceManifests, plannedNotionOperations: [], deliveryPlan: emptyDeliveryPlan(), deliveryReconciliation: buildDeliveryReconciliation({ status: 'partial', sourceCoverage: sourceCoverageFromManifests(sourceManifests), rejectionReasons: [...rejectionReasons, ...partialSourceReasons(sourceManifests)] }), writesPlanned: false, transaction: null,
        historicalSuppressions, scoringQueue: selection.scoringQueue, reconciliation,
        outcome: { status: 'partial', fatal: false, degraded: true, errors: [{ stage: 'recovery', name: 'PartialRun', message: 'source coverage or downstream scoring budget ended before completion' }] },
        counts: { fetched: pipeline.counts.fetched, dated: pipeline.counts.dated, eligible: eligibleCount, scored: selection.scoredCount, ready: selection.readyCount, selected: selection.selected.length, verificationQueue: verificationQueue.length, unscored: selection.unscoredCount, scoringFailed: selection.scoringFailedCount },
      };
    }
    if (incompleteScoring) {
      const error = scoringGateError(RemoteModeError, selection, scorerRan ? scorerTelemetry : null);
      error.details = {
        scoringQueue: selection.scoringQueue,
        scoring: { required: true, scoredCount: selection.scoredCount, unscoredCount: selection.unscoredCount, scoringFailedCount: selection.scoringFailedCount, selectedCount: 0, ...(scorerTelemetry ? { scorer: scorerTelemetry } : {}) },
        reconciliation,
        counts: { fetched: pipeline.counts.fetched, dated: pipeline.counts.dated, eligible: eligibleCount, scored: selection.scoredCount, ready: selection.readyCount, selected: 0, unscored: selection.unscoredCount, scoringFailed: selection.scoringFailedCount },
      };
      throw error;
    }
    const shortlist = selection.selected;
    const operations = shortlist.map((candidate) => ({ operation: 'create', resource: 'application', dedupKey: candidateDedupKey(candidate), payload: remotePayload(candidate, runId), provenance: provenanceFor(candidate, runId) }));
    if (!notionGateway || typeof notionGateway.planWrites !== 'function') throw new RemoteModeError('notion gateway must implement planWrites', 'notion');
    const planned = notionGateway.planWrites({ schemaVersion: 'LaunchpadV5RemotePlanV1', mode: 'remote', discoveryMode: 'Remote', runId, runAt, operations: structuredClone(operations) });
    const plannedOperations = Array.isArray(planned) ? planned : planned?.operations;
    if (!Array.isArray(plannedOperations) || JSON.stringify(plannedOperations) !== JSON.stringify(operations)) throw new RemoteModeError('notion gateway planWrites must return authoritative operations unchanged', 'notion');
    let transaction = null;
    if (executeGateway) {
      if (notionGateway.kind !== 'fake-transactional-v5' || typeof notionGateway.executeWrites !== 'function') throw new RemoteModeError('live or non-transactional gateway execution is disabled; inject the Remote fake gateway', 'notion');
      transaction = await notionGateway.executeWrites({ operations: plannedOperations });
    }
    const deliveryPlan = buildDeliveryPlan({ shortlist, plannedNotionOperations: plannedOperations });
    const surfaced = commitSurfaced ? recordSurfaced(deliveryPlan.opportunitySurfacing, { path: opportunityLedgerPath || undefined, now: runAt }) : null;
    const selectedKeys = new Set(shortlist.map((candidate) => candidateDedupKey(candidate)));
    const verificationQueue = sourceResults.flatMap((source) => source.candidates)
      .map((candidate) => ({ candidate, pipelineCandidate: pipelineByUrl.get(candidate.canonicalUrl) || null }))
      .filter(({ candidate }) => !selectedKeys.has(candidateDedupKey(candidate)))
      .map(({ candidate, pipelineCandidate }) => verificationRecord(candidate, pipelineCandidate))
      .filter(Boolean)
      .filter((record, index, records) => records.findIndex((item) => item.dedupKey === record.dedupKey) === index);
    for (const source of sourceResults) source.manifest.selected = shortlist.filter((candidate) => candidate.remoteLaneId === source.manifest.sourceId).length;
    const failedLanes = sourceManifests.filter((manifest) => ['failed', 'unavailable'].includes(manifest.status)).map((manifest) => manifest.sourceId);
    const emptyLanes = sourceManifests.filter((manifest) => manifest.status === 'empty').map((manifest) => manifest.sourceId);
    const missing = Math.max(0, 10 - shortlist.length);
    return {
      schemaVersion: REMOTE_MODE_SCHEMA_VERSION,
      runId,
      runAt,
      mode: 'remote',
      discoveryMode: 'Remote',
      shortlist,
      verificationQueue,
      sourceManifests,
      sourceTelemetry: sourceManifests,
      plannedNotionOperations: plannedOperations,
      deliveryPlan, deliveryReconciliation: buildDeliveryReconciliation({ status: 'completed', deliveryPlan, sourceCoverage: sourceCoverageFromManifests(sourceManifests), rejectionReasons, surfacedCount: surfaced?.rows?.length ?? null }),
      writesPlanned: plannedOperations.length > 0,
      transaction,
      historicalSuppressions,
      scoringQueue: selection.scoringQueue,
      ...(scorerTelemetry ? { scoring: { required: selection.unscoredCount > 0 || selection.scoringFailedCount > 0, scoredCount: selection.scoredCount, unscoredCount: selection.unscoredCount, scoringFailedCount: selection.scoringFailedCount, selectedCount: shortlist.length, scorer: scorerTelemetry } } : {}),
      reconciliation,
      shortfall: { minimum: 10, preferred: 12, maximum: 20, selected: shortlist.length, missing, preferredMissing: Math.max(0, 12 - shortlist.length), failedLanes, emptyLanes, reasons: [...(missing ? ['APPLICATION_READY_MINIMUM_SHORTFALL'] : []), ...failedLanes.map((lane) => `SOURCE_FAILED:${lane}`), ...emptyLanes.map((lane) => `SOURCE_EMPTY:${lane}`), ...(shortlist.length === 0 ? rejectionReasons : [])], linkedinRescueSuggestion: { suggested: missing >= 5, command: 'linkedin-leads', invoked: false, reason: missing >= 5 ? `verified inventory is short by ${missing}` : 'shortfall is below rescue threshold' } },
      outcome: { status: failedLanes.length || scoringDropped || sourceManifests.some((manifest) => manifest.errors.length) ? 'degraded' : 'ok', fatal: false, degraded: Boolean(failedLanes.length || scoringDropped || sourceManifests.some((manifest) => manifest.errors.length)), errors: sourceManifests.map(issueFor).filter(Boolean) },
      rejectionReasons,
      counts: { fetched: pipeline.counts.fetched, dated: pipeline.counts.dated, eligible: eligibleCount, scored: selection.scoredCount, ready: selection.readyCount, applicationReadyPool: selection.readyPoolCount, selected: shortlist.length, verificationQueue: verificationQueue.length, historicalSuppressed: historicalSuppressions.length, minimum: 10, preferred: 12, maximum: 20, strictSelected: selection.strictSelected, strictShortfall: selection.strictShortfall, bands: selection.bands, familyCounts: selection.familyCounts, eligibilityClasses: selection.eligibilityClasses, unscored: selection.unscoredCount, scoringFailed: selection.scoringFailedCount, schemaIntegrationRequired: true, missingFields: [...REMOTE_SCHEMA_FIELDS] },
    };
  } catch (error) {
    return fatalResult(runId, runAt, sourceResults.map(({ manifest }) => manifest), error);
  }
}
