import { assertValidConfig, assertValidConversionPlan, loadConfig, loadConversionPlan } from './config.mjs';
import { buildPayloadRecord, candidateDedupKey } from './candidate.mjs';
import { applyScores, runPipeline } from './run.mjs';
import { createNoWriteNotionGateway } from './workflow.mjs';
import { applicationReadiness } from './normal-readiness.mjs';
import { runNormalSourcePlan } from './normal-sources.mjs';
import { selectNormalApplications } from './normal-selection.mjs';
import { readLedger } from './ledger.mjs';
import { readOpportunityLedger, recordSurfaced } from './opportunity-ledger.mjs';
import { enrichWorkdayCandidates } from './workday-enrichment.mjs';
import { filterHistoricalCandidates } from '../crawler/historical-suppression.mjs';
import { buildReconciliation, scorePoolInRun, scorerIsBroken, scoringGateError } from './mode-scoring.mjs';

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
    conversionScore: candidate.conversionScore,
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
    plannedNotionOperations: [], transaction: null, historicalSuppressions: [],
    scoringQueue: details.scoringQueue || [],
    scoring: details.scoring || null,
    reconciliation: details.reconciliation || null,
    shortfall: { minimum: 10, selected: 0, missing: 10, failedLanes: sourceManifests.filter((item) => item.status === 'failed').map((item) => item.sourceId), emptyLanes: [], linkedinRescueSuggestion: { suggested: true, command: 'linkedin-leads', invoked: false } },
    outcome: { status: 'fatal', fatal: true, degraded: false, errors: [{ stage: error.stage || 'pipeline', name: error.name || 'Error', message: error.message || String(error) }] },
    counts: details.counts || null,
  };
}

/** Complete fixture/injection seam for India-first Normal mode. */
export async function runNormalMode({
  mode = 'normal', clock = () => new Date().toISOString(), runId: suppliedRunId = null,
  sourceFunctions = {}, sourceFixtures = {}, laneInputs = {}, notionGateway = createNoWriteNotionGateway(),
  executeGateway = false, config = null, conversionPlan = null, ledgerRows = null, opportunityLedgerRows = null,
  opportunityLedgerPath = null,
  historicalV4Rows = [], includeCrawlerLanes = false, enrichmentBudget = 50, scores, scorer, scoringSignal = null, scoringRemainingMs = null, commitSurfaced = false,
} = {}) {
  if (String(mode).toLowerCase() !== 'normal') throw new NormalModeError(`Issue03 runner only supports normal mode, received ${mode}`, 'mode');
  const runAt = readClock(clock);
  const runId = suppliedRunId || `normal-${runAt}`;
  let sourceResults = [];
  try {
    sourceResults = await runNormalSourcePlan({ sourceFunctions, sourceFixtures, laneInputs, runAt, runId, includeCrawlerLanes });
    sourceResults = applyScores(sourceResults, scores);
    await enrichWorkdayCandidates(sourceResults.flatMap((source) => source.candidates), { maxRequests: enrichmentBudget });
    const sourceManifests = sourceResults.map(({ manifest }) => manifest);
    const baseConfig = config || loadConfig();
    const baseConversionPlan = conversionPlan || loadConversionPlan();
    assertValidConfig(baseConfig);
    assertValidConversionPlan(baseConversionPlan);
    const normalConfig = structuredClone(baseConfig);
    normalConfig.run = { ...normalConfig.run, minimumTotal: 10, maximumTotal: 20, strictTarget: 10 };
    const effectiveLedgerRows = ledgerRows ?? readLedger().rows;
    const effectiveOpportunityLedgerRows = opportunityLedgerRows ?? readOpportunityLedger(opportunityLedgerPath ?? undefined).rows;
    const pipeline = runPipeline({
      config: normalConfig, conversionPlan: baseConversionPlan, now: runAt, runId,
      ledgerRows: effectiveLedgerRows, opportunityLedgerRows: effectiveOpportunityLedgerRows, sources: sourceResults, dryRun: true,
      ...(opportunityLedgerPath ? { opportunityLedgerPath } : {}),
    });
    // v4 identity matches are suppressed before they reach shortlist/Notion planning.
    // Read-only against v4 rows: never migrates, mutates, or deletes historical data.
    const { kept: nonHistoricalCandidates, suppressed: historicalSuppressions } = filterHistoricalCandidates(pipeline.postSuppressionCandidates, historicalV4Rows);
    const { pool: scoredPool, telemetry: scorerTelemetry } = await scorePoolInRun(nonHistoricalCandidates, scorer, { runId, runAt, signal: scoringSignal, remainingMs: scoringRemainingMs });
    const selectionEntries = scoredPool.map((candidate) => ({
      candidate, eligibility: candidate.eligibility, freshness: candidate.freshness,
    }));
    const selection = selectNormalApplications(selectionEntries, { maximumPerCompany: normalConfig.run.maximumPerCompany });
    const eligibleCount = pipeline.postSuppressionCandidates.length;
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
      selection,
      selected: incompleteScoring ? 0 : selection.selected.length,
      runFailed: incompleteScoring,
    });
    const verifiedCandidates = new Set(pipeline.scoringCandidates.map((candidate) => candidate.canonicalUrl));
    const verificationCandidates = [
      ...pipeline.scoringCandidates,
      ...sourceResults.flatMap((source) => source.candidates).filter((candidate) => !verifiedCandidates.has(candidate.canonicalUrl)),
    ];
    const verificationQueue = verificationCandidates.map((candidate) => verificationRecord(candidate, candidate.eligibility || null)).filter(Boolean);
    if (incompleteScoring) {
      const error = scoringGateError(NormalModeError, selection, scorerRan ? scorerTelemetry : null);
      error.details = {
        scoringQueue: selection.scoringQueue,
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
          minimum: 10,
          preferred: 12,
          maximum: 20,
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
    if (commitSurfaced) recordSurfaced(shortlist, { path: opportunityLedgerPath || undefined, now: runAt });
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
    return {
      schemaVersion: 'LaunchpadV5NormalModeV1', runId, runAt, mode: 'normal', shortlist,
      scoringQueue: selection.scoringQueue, funnel: pipeline.funnel,
      verificationQueue, sourceManifests, sourceTelemetry: sourceManifests, plannedNotionOperations: plannedOperations, transaction,
      historicalSuppressions,
      dedupInputs: {
        committedLedgerRows: effectiveLedgerRows.length,
        opportunityLedgerRows: effectiveOpportunityLedgerRows.length,
      },
      shortfall: {
        minimum: 10, preferred: 12, maximum: 20, selected: shortlist.length, missing,
        preferredMissing: Math.max(0, 12 - shortlist.length), failedLanes, emptyLanes,
        reasons: [...(missing ? ['APPLICATION_READY_MINIMUM_SHORTFALL'] : []), ...failedLanes.map((lane) => `SOURCE_FAILED:${lane}`), ...emptyLanes.map((lane) => `SOURCE_EMPTY:${lane}`)],
        linkedinRescueSuggestion: { suggested: missing >= 5, command: 'linkedin-leads', invoked: false, reason: missing >= 5 ? `verified inventory is short by ${missing}` : 'shortfall is below rescue threshold' },
      },
      outcome: { status: failedLanes.length || scoringDropped ? 'degraded' : 'ok', fatal: false, degraded: failedLanes.length > 0 || scoringDropped, errors: sourceManifests.map(issueFor).filter(Boolean) },
      reconciliation,
      ...(scorerTelemetry
        ? { scoring: { required: selection.unscoredCount > 0 || selection.scoringFailedCount > 0, scoredCount: selection.scoredCount, unscoredCount: selection.unscoredCount, scoringFailedCount: selection.scoringFailedCount, selectedCount: shortlist.length, scorer: scorerTelemetry } }
        : {}),
      counts: { fetched: sourceResults.reduce((sum, source) => sum + source.candidates.length, 0), eligible: eligibleCount, scored: selection.scoredCount, ready: selection.readyCount, applicationReadyPool: selection.readyPoolCount, selected: shortlist.length, verificationQueue: verificationQueue.length, historicalSuppressed: historicalSuppressions.length, minimum: 10, preferred: 12, maximum: 20, bands: selection.bands, familyCounts: selection.familyCounts, unscored: selection.unscoredCount, scoringFailed: selection.scoringFailedCount },
    };
  } catch (error) {
    return fatalResult(runId, runAt, 'normal', sourceResults.map(({ manifest }) => manifest), error, error.details);
  }
}
