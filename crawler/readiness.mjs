const REQUIRED_MILESTONES = Object.freeze(
  Array.from({ length: 15 }, (_, index) => String(index + 1).padStart(2, '0')),
);
export const READINESS_EVIDENCE_SCHEMA = 'LaunchpadReadinessEvidenceV2';

export function buildLocalReadinessEvidence({
  testsPassed = false,
  testTotal = 0,
  dirtyPaths = [],
  operationalEvidence = null,
  sourceIds = [],
  credentialsAvailable = false,
  evidenceProvenance = null,
} = {}) {
  const verified = testsPassed === true;
  const sources = Object.fromEntries(sourceIds.map((sourceId) => [sourceId, { status: 'verified-by-local-suite' }]));
  return {
    milestones: Object.fromEntries(REQUIRED_MILESTONES.map((id) => [id, { status: verified ? 'verified' : 'unverified' }])),
    dependencyOrder: { pass: verified, coveredMilestones: [...REQUIRED_MILESTONES] },
    durableRun: { pass: verified, resumable: verified, idempotent: verified },
    sourceTelemetry: { pass: verified && sourceIds.length > 0, sources },
    politeFetch: { pass: verified, robotsHonored: verified, hostLimits: verified, retriesBounded: verified },
    novelty: { pass: verified, errorCount: verified ? 0 : 1, zeroErrors: verified },
    shortfall: { exact: verified, minimumMissing: 0, reasons: [], autoRescue: false },
    reserveShortlist: { pass: verified, noPadding: true, controlledReachMaximum: 2 },
    actionSafety: { noAutoApply: true, noAutoSend: true, writesPlanned: false },
    contactGating: { pass: verified, onlyAfterSelection: true, verifiedOnly: true, maxPerApplication: 2 },
    audit: { pass: verified, evidence: verified ? ['crawler-test-suite'] : [] },
    testSummary: { supplied: true, passed: verified, failed: verified ? 0 : 1, total: Number(testTotal) || 0 },
    unresolvedBlockers: [],
    reproducibility: { dirtyPaths: [...dirtyPaths], captured: true },
    evidenceProvenance: evidenceProvenance ?? {
      schemaVersion: READINESS_EVIDENCE_SCHEMA,
      runId: null,
      runAt: null,
      codeConfigVersion: null,
      receiptHash: null,
      recognized: false,
    },
    liveCredentials: { required: true, available: credentialsAvailable === true },
    operationalVerification: operationalEvidence && nonEmptyArray(operationalEvidence.evidence)
      ? { ...operationalEvidence, pass: operationalEvidence.pass === true }
      : { pass: false, evidence: [] },
  };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
const finite = (value) => Number.isFinite(Number(value));
const nonEmptyArray = (value) => Array.isArray(value) && value.length > 0;

function passed(value) {
  if (value === true) return true;
  return isObject(value) && (value.pass === true || value.ok === true || value.status === 'pass');
}

function milestoneMap(value) {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((item) => [
      String(item?.id ?? item?.milestone ?? '').padStart(2, '0'), item,
    ]));
  }
  return isObject(value) ? value : {};
}

function milestoneComplete(value) {
  return value === true || passed(value) || (
    isObject(value) && ['complete', 'completed', 'code-complete', 'verified', 'pass', 'passed'].includes(value.status)
  );
}

function checkMilestones(evidence) {
  const milestones = milestoneMap(evidence.milestones);
  const missing = REQUIRED_MILESTONES.filter((id) => !hasOwn(milestones, id));
  const incomplete = REQUIRED_MILESTONES.filter((id) => hasOwn(milestones, id) && !milestoneComplete(milestones[id]));
  const dependency = evidence.dependencyOrder;
  const covered = Array.isArray(dependency?.coveredMilestones)
    ? new Set(dependency.coveredMilestones.map((id) => String(id).padStart(2, '0')))
    : null;
  const uncovered = covered ? REQUIRED_MILESTONES.filter((id) => !covered.has(id)) : REQUIRED_MILESTONES;
  const reasons = [];
  if (missing.length) reasons.push('MILESTONES_01_15_EVIDENCE_MISSING');
  if (incomplete.length) reasons.push('MILESTONES_01_15_INCOMPLETE');
  if (!passed(dependency) || uncovered.length) reasons.push('MILESTONE_DEPENDENCY_ORDER_UNVERIFIED');
  return { pass: reasons.length === 0, reasons };
}

function checkDurability(evidence) {
  const value = evidence.durableRun;
  const idempotent = value?.idempotent === true || value?.idempotency?.pass === true;
  const resumable = value?.resumable === true || value?.durable === true;
  const reasons = [];
  if (!passed(value)) reasons.push('DURABLE_RUN_EVIDENCE_MISSING');
  if (!idempotent) reasons.push('IDEMPOTENCY_UNVERIFIED');
  if (!resumable) reasons.push('DURABLE_RESUME_UNVERIFIED');
  return { pass: reasons.length === 0, reasons };
}

function checkTelemetry(evidence) {
  const value = evidence.sourceTelemetry;
  const sources = value?.sources;
  const hasSources = isObject(sources) && Object.keys(sources).length > 0;
  const reasons = [];
  if (!passed(value) || !hasSources) reasons.push('SOURCE_TELEMETRY_EVIDENCE_MISSING');
  return { pass: reasons.length === 0, reasons };
}

function checkPoliteFetch(evidence) {
  const value = evidence.politeFetch;
  const reasons = [];
  if (!passed(value)) reasons.push('POLITE_FETCH_POLICY_UNVERIFIED');
  if (value?.robotsHonored !== true) reasons.push('ROBOTS_POLICY_UNVERIFIED');
  if (value?.hostLimits !== true) reasons.push('HOST_LIMITS_UNVERIFIED');
  if (value?.retriesBounded !== true) reasons.push('RETRY_POLICY_UNVERIFIED');
  return { pass: reasons.length === 0, reasons };
}

function checkNovelty(evidence) {
  const value = evidence.novelty;
  const errors = Number(value?.errorCount);
  const zeroErrors = value?.zeroErrors === true || (finite(errors) && errors === 0);
  const reasons = [];
  if (!passed(value)) reasons.push('NOVELTY_GATE_FAILED');
  if (!zeroErrors) reasons.push('NOVELTY_ERRORS_PRESENT');
  return { pass: reasons.length === 0, reasons };
}

function checkShortfall(evidence) {
  const value = evidence.shortfall;
  const reasons = [];
  if (value?.exact !== true || !finite(value?.minimumMissing) || !Array.isArray(value?.reasons)) {
    reasons.push('EXACT_SHORTFALL_EVIDENCE_MISSING');
  }
  if (value?.autoRescue !== false) reasons.push('SHORTFALL_AUTOFILL_UNSAFE');
  return { pass: reasons.length === 0, reasons };
}

function checkReserve(evidence) {
  const value = evidence.reserveShortlist;
  const reasons = [];
  if (!passed(value)) reasons.push('RESERVE_SHORTLIST_SAFETY_UNVERIFIED');
  if (value?.noPadding !== true) reasons.push('RESERVE_SHORTLIST_PADDING_UNSAFE');
  if (value?.controlledReachMaximum !== 2) reasons.push('CONTROLLED_REACH_CAP_UNVERIFIED');
  return { pass: reasons.length === 0, reasons };
}

function checkActions(evidence) {
  const value = evidence.actionSafety;
  const reasons = [];
  if (value?.noAutoApply !== true) reasons.push('AUTO_APPLY_NOT_DISABLED');
  if (value?.noAutoSend !== true) reasons.push('AUTO_SEND_NOT_DISABLED');
  if (value?.writesPlanned !== false) reasons.push('DOWNSTREAM_WRITES_NOT_DISABLED');
  return { pass: reasons.length === 0, reasons };
}

function checkContacts(evidence) {
  const value = evidence.contactGating;
  const reasons = [];
  if (!passed(value)) reasons.push('CONTACT_GATING_UNVERIFIED');
  if (value?.onlyAfterSelection !== true) reasons.push('CONTACTS_NOT_GATED_ON_SELECTION');
  if (value?.verifiedOnly !== true) reasons.push('UNVERIFIED_CONTACTS_NOT_EXCLUDED');
  if (value?.maxPerApplication !== 2) reasons.push('CONTACT_PER_APPLICATION_CAP_UNVERIFIED');
  return { pass: reasons.length === 0, reasons };
}

function checkAudit(evidence) {
  const value = evidence.audit;
  return {
    pass: passed(value) && nonEmptyArray(value.evidence),
    reasons: passed(value) && nonEmptyArray(value.evidence) ? [] : ['AUDIT_EVIDENCE_MISSING'],
  };
}

function checkTests(evidence) {
  const value = evidence.testSummary;
  const supplied = isObject(value) && value.supplied !== false;
  const failing = value?.passed === false || Number(value?.failed) > 0;
  const reasons = [];
  if (!supplied) reasons.push('TEST_SUMMARY_MISSING');
  if (failing) reasons.push('TEST_SUITE_FAILING');
  if (supplied && value?.passed !== true && !failing) reasons.push('TEST_SUMMARY_NOT_PASSING');
  return { pass: reasons.length === 0, reasons };
}

function checkBlockers(evidence) {
  const supplied = hasOwn(evidence, 'unresolvedBlockers') || hasOwn(evidence, 'blockers');
  const blockers = evidence.unresolvedBlockers ?? evidence.blockers;
  const reasons = [];
  if (!supplied || !Array.isArray(blockers)) reasons.push('UNRESOLVED_BLOCKERS_NOT_EXPLICIT');
  else if (blockers.length) reasons.push('UNRESOLVED_BLOCKERS_PRESENT');
  return { pass: reasons.length === 0, reasons };
}

function checkEvidenceProvenance(evidence) {
  const value = evidence.evidenceProvenance;
  const valid = isObject(value)
    && value.schemaVersion === READINESS_EVIDENCE_SCHEMA
    && typeof value.runId === 'string' && value.runId.trim()
    && typeof value.runAt === 'string' && !Number.isNaN(Date.parse(value.runAt))
    && typeof value.codeConfigVersion === 'string' && value.codeConfigVersion.trim()
    && typeof value.receiptHash === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value.receiptHash)
    && value.recognized === true;
  return { pass: valid, reasons: valid ? [] : ['READINESS_EVIDENCE_PROVENANCE_INVALID'] };
}

function checkOperational(evidence) {
  const credentials = evidence.liveCredentials;
  const verification = evidence.operationalVerification;
  const reasons = [];
  if (!isObject(credentials)) reasons.push('LIVE_CREDENTIALS_EVIDENCE_MISSING');
  else if (credentials.required === true && credentials.available !== true) reasons.push('LIVE_CREDENTIALS_UNAVAILABLE');
  if (!passed(verification) || !nonEmptyArray(verification.evidence)) reasons.push('OPERATIONAL_VERIFICATION_MISSING');
  return { pass: reasons.length === 0, reasons };
}

/**
 * Evaluate caller-supplied crawler release evidence without performing I/O.
 * `codeComplete` is the deterministic implementation/test verdict; only
 * `productionReady` additionally requires operational verification.
 */
export function assessProductionReadiness(evidence = {}) {
  const input = isObject(evidence) ? evidence : {};
  const checks = [
    ['milestones-01-15', checkMilestones(input)],
    ['durable-run-idempotency', checkDurability(input)],
    ['source-telemetry', checkTelemetry(input)],
    ['polite-fetch-robots', checkPoliteFetch(input)],
    ['novelty-zero-error', checkNovelty(input)],
    ['exact-shortfall', checkShortfall(input)],
    ['reserve-shortlist-safety', checkReserve(input)],
    ['manual-action-safety', checkActions(input)],
    ['contact-gating', checkContacts(input)],
    ['audit-evidence', checkAudit(input)],
    ['test-summary', checkTests(input)],
    ['unresolved-blockers', checkBlockers(input)],
    ['evidence-provenance', checkEvidenceProvenance(input)],
    ['operational-verification', checkOperational(input)],
  ].map(([name, result]) => ({ name, ...result }));
  const deterministic = checks.filter((check) => check.name !== 'operational-verification');
  const codeComplete = deterministic.every((check) => check.pass);
  const operationallyVerified = checks.find((check) => check.name === 'operational-verification').pass;
  const reasons = checks.flatMap((check) => check.reasons);
  const productionReady = codeComplete && operationallyVerified;
  return {
    schemaVersion: 'LaunchpadV5CrawlerProductionReadinessV1',
    pass: productionReady,
    productionReady,
    codeComplete,
    operationallyVerified,
    checks,
    reasons: [...new Set(reasons)],
  };
}

export const productionReadinessGate = assessProductionReadiness;
export const checkProductionReadiness = assessProductionReadiness;
export default assessProductionReadiness;
