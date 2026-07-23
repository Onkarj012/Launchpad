import { assertValidConfig, assertValidConversionPlan, loadConfig, loadConversionPlan } from './config.mjs';
import { candidateDedupKey } from './candidate.mjs';
import { runPipeline } from './run.mjs';
import { createNoWriteNotionGateway } from './workflow.mjs';
import { applicationReadiness } from './normal-readiness.mjs';
import { enrichStartupSources } from './startup-enrichment.mjs';
import { runStartupSourcePlan } from './startup-sources.mjs';
import { selectStartupApplications } from './startup-selection.mjs';

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
  return {
    schemaVersion: STARTUP_MODE_SCHEMA_VERSION, runId, runAt, mode: 'startup', shortlist: [], verificationQueue: [], sourceManifests, sourceTelemetry: sourceManifests,
    companyRecords, plannedNotionOperations: [], transaction: null,
    shortfall: { minimum: 10, preferred: 12, maximum: 20, selected: 0, missing: 10, failedLanes: sourceManifests.filter((item) => ['failed', 'unavailable'].includes(item.status)).map((item) => item.sourceId), emptyLanes: [], linkedinRescueSuggestion: { suggested: true, command: 'linkedin-leads', invoked: false } },
    outcome: { status: 'fatal', fatal: true, degraded: false, errors: [{ stage: error.stage || 'pipeline', name: error.name || 'Error', message: error.message || String(error) }] },
    counts: null,
  };
}

/** Complete fixture/injection seam for Startup mode; no source or Notion network primitive is used. */
export async function runStartupMode({
  mode = 'startup', clock = () => new Date().toISOString(), runId: suppliedRunId = null,
  sourceFunctions = {}, sourceFixtures = {}, laneInputs = {}, notionGateway = createNoWriteNotionGateway(), executeGateway = false,
  config = null, conversionPlan = null, ledgerRows = [], opportunityLedgerRows = [],
} = {}) {
  if (String(mode).toLowerCase() !== 'startup') throw new StartupModeError(`Startup runner only supports startup mode, received ${mode}`, 'mode');
  const runAt = readClock(clock);
  const runId = suppliedRunId || `startup-${runAt}`;
  let sourceResults = [];
  let companyRecords = [];
  try {
    sourceResults = await runStartupSourcePlan({ sourceFunctions, sourceFixtures, laneInputs, runAt, runId });
    const enriched = enrichStartupSources(sourceResults, { runAt });
    sourceResults = enriched.sources;
    companyRecords = enriched.companyRecords;
    const sourceManifests = sourceResults.map(({ manifest }) => manifest);
    const baseConfig = config || loadConfig();
    const baseConversionPlan = conversionPlan || loadConversionPlan();
    assertValidConfig(baseConfig);
    assertValidConversionPlan(baseConversionPlan);
    const pipeline = runPipeline({ config: baseConfig, conversionPlan: baseConversionPlan, now: runAt, runId, ledgerRows, opportunityLedgerRows, sources: sourceResults, dryRun: true });
    const selectionEntries = pipeline.scoringCandidates.map((candidate) => ({ candidate, eligibility: candidate.eligibility, freshness: candidate.freshness }));
    const selection = selectStartupApplications(selectionEntries, { maximumPerCompany: baseConfig.run.maximumPerCompany });
    const shortlist = selection.selected;
    const operations = shortlist.map((candidate) => ({ operation: 'create', resource: 'application', dedupKey: candidateDedupKey(candidate), payload: startupPayload(candidate, runId), provenance: provenanceFor(candidate, runId) }));
    if (!notionGateway || typeof notionGateway.planWrites !== 'function') throw new StartupModeError('notion gateway must implement planWrites', 'notion');
    const planned = notionGateway.planWrites({ schemaVersion: 'LaunchpadV5PlanV1', mode: 'startup', runId, runAt, operations: structuredClone(operations) });
    const plannedOperations = Array.isArray(planned) ? planned : planned?.operations;
    if (!Array.isArray(plannedOperations) || JSON.stringify(plannedOperations) !== JSON.stringify(operations)) throw new StartupModeError('notion gateway planWrites must return authoritative operations unchanged', 'notion');
    let transaction = null;
    if (executeGateway) {
      if (notionGateway.kind !== 'fake-transactional-v5' || typeof notionGateway.executeWrites !== 'function') throw new StartupModeError('live or non-transactional gateway execution is disabled; inject the startup test fake gateway', 'notion');
      transaction = await notionGateway.executeWrites({ operations: plannedOperations });
    }
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
      schemaVersion: STARTUP_MODE_SCHEMA_VERSION, runId, runAt, mode: 'startup', shortlist, verificationQueue, sourceManifests, sourceTelemetry: sourceManifests, companyRecords, plannedNotionOperations: plannedOperations, transaction,
      shortfall: { minimum: 10, preferred: 12, maximum: 20, selected: shortlist.length, missing, preferredMissing: Math.max(0, 12 - shortlist.length), failedLanes, emptyLanes, reasons: [...(missing ? ['APPLICATION_READY_MINIMUM_SHORTFALL'] : []), ...failedLanes.map((lane) => `SOURCE_FAILED:${lane}`), ...emptyLanes.map((lane) => `SOURCE_EMPTY:${lane}`)], linkedinRescueSuggestion: { suggested: missing >= 5, command: 'linkedin-leads', invoked: false, reason: missing >= 5 ? `verified inventory is short by ${missing}` : 'shortfall is below rescue threshold' } },
      outcome: { status: failedLanes.length || sourceManifests.some((manifest) => manifest.errors.length) ? 'degraded' : 'ok', fatal: false, degraded: Boolean(failedLanes.length || sourceManifests.some((manifest) => manifest.errors.length)), errors: sourceManifests.map(issueFor).filter(Boolean) },
      counts: { fetched: sourceResults.reduce((sum, source) => sum + source.candidates.length, 0), companyRecords: companyRecords.length, fundingSignals: companyRecords.filter((company) => company.fundingSignal?.within18Months).length, underSixMonthFunding: companyRecords.filter((company) => company.fundingSignal?.under6Months).length, applicationReadyPool: selection.readyPoolCount, selected: shortlist.length, verificationQueue: verificationQueue.length, minimum: 10, preferred: 12, maximum: 20, bands: selection.bands, familyCounts: selection.familyCounts, startupSources: selection.startupSources },
    };
  } catch (error) {
    return fatalResult(runId, runAt, sourceResults.map(({ manifest }) => manifest), companyRecords, error);
  }
}

