import { assertValidConfig, assertValidConversionPlan, loadConfig, loadConversionPlan } from './config.mjs';
import { candidateDedupKey } from './candidate.mjs';
import { runPipeline } from './run.mjs';
import { createNoWriteNotionGateway } from './workflow.mjs';
import { applicationReadiness } from './normal-readiness.mjs';
import { enrichRemoteSources, REMOTE_SCHEMA_FIELDS } from './remote-enrichment.mjs';
import { runRemoteSourcePlan } from './remote-sources.mjs';
import { selectRemoteApplications } from './remote-selection.mjs';

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
    plannedNotionOperations: [],
    transaction: null,
    shortfall: { minimum: 10, preferred: 12, maximum: 20, selected: 0, missing: 10, failedLanes: sourceManifests.filter((item) => ['failed', 'unavailable'].includes(item.status)).map((item) => item.sourceId), emptyLanes: [], linkedinRescueSuggestion: { suggested: true, command: 'linkedin-leads', invoked: false } },
    outcome: { status: 'fatal', fatal: true, degraded: false, errors: [{ stage: error.stage || 'pipeline', name: error.name || 'Error', message: error.message || String(error) }] },
    counts: null,
  };
}

/** Complete fixture/injection seam for Remote mode. It never performs live source or Notion access. */
export async function runRemoteMode({
  mode = 'remote', clock = () => new Date().toISOString(), runId: suppliedRunId = null,
  sourceFunctions = {}, sourceFixtures = {}, laneInputs = {}, providerFetchers = {},
  notionGateway = createNoWriteNotionGateway(), executeGateway = false,
  config = null, conversionPlan = null, ledgerRows = [], opportunityLedgerRows = [],
} = {}) {
  if (String(mode).toLowerCase() !== 'remote') throw new RemoteModeError(`Remote runner only supports remote mode, received ${mode}`, 'mode');
  const runAt = readClock(clock);
  const runId = suppliedRunId || `remote-${runAt}`;
  let sourceResults = [];
  try {
    sourceResults = enrichRemoteSources(await runRemoteSourcePlan({ sourceFunctions, sourceFixtures, laneInputs, providerFetchers, runAt, runId }));
    const sourceManifests = sourceResults.map(({ manifest }) => manifest);
    const baseConfig = config || loadConfig();
    const baseConversionPlan = conversionPlan || loadConversionPlan();
    assertValidConfig(baseConfig);
    assertValidConversionPlan(baseConversionPlan);
    const remoteConfig = structuredClone(baseConfig);
    remoteConfig.run = { ...remoteConfig.run, minimumTotal: 10, maximumTotal: 20, strictTarget: 10 };
    remoteConfig.employment.allowedTypes = [...new Set([...remoteConfig.employment.allowedTypes, 'contract'])];
    const pipeline = runPipeline({ config: remoteConfig, conversionPlan: baseConversionPlan, now: runAt, runId, ledgerRows, opportunityLedgerRows, sources: sourceResults, dryRun: true });
    const pipelineByUrl = new Map(pipeline.scoringCandidates.map((candidate) => [candidate.canonicalUrl, candidate]));
    const selectionEntries = pipeline.scoringCandidates
      .filter((candidate) => candidate.remoteReady === true)
      .map((candidate) => ({ candidate, eligibility: candidate.eligibility, freshness: candidate.freshness }));
    const selection = selectRemoteApplications(selectionEntries, { maximumPerCompany: remoteConfig.run.maximumPerCompany });
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
      transaction,
      shortfall: { minimum: 10, preferred: 12, maximum: 20, selected: shortlist.length, missing, preferredMissing: Math.max(0, 12 - shortlist.length), failedLanes, emptyLanes, reasons: [...(missing ? ['APPLICATION_READY_MINIMUM_SHORTFALL'] : []), ...failedLanes.map((lane) => `SOURCE_FAILED:${lane}`), ...emptyLanes.map((lane) => `SOURCE_EMPTY:${lane}`)], linkedinRescueSuggestion: { suggested: missing >= 5, command: 'linkedin-leads', invoked: false, reason: missing >= 5 ? `verified inventory is short by ${missing}` : 'shortfall is below rescue threshold' } },
      outcome: { status: failedLanes.length || sourceManifests.some((manifest) => manifest.errors.length) ? 'degraded' : 'ok', fatal: false, degraded: Boolean(failedLanes.length || sourceManifests.some((manifest) => manifest.errors.length)), errors: sourceManifests.map(issueFor).filter(Boolean) },
      counts: { fetched: sourceResults.reduce((sum, source) => sum + source.candidates.length, 0), dated: sourceResults.reduce((sum, source) => sum + source.candidates.filter((candidate) => candidate.postedAt != null).length, 0), applicationReadyPool: selection.readyPoolCount, selected: shortlist.length, verificationQueue: verificationQueue.length, minimum: 10, preferred: 12, maximum: 20, bands: selection.bands, familyCounts: selection.familyCounts, eligibilityClasses: selection.eligibilityClasses, schemaIntegrationRequired: true, missingFields: [...REMOTE_SCHEMA_FIELDS] },
    };
  } catch (error) {
    return fatalResult(runId, runAt, sourceResults.map(({ manifest }) => manifest), error);
  }
}
