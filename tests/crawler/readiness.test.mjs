import test from 'node:test';
import assert from 'node:assert/strict';
import { assessProductionReadiness, buildLocalReadinessEvidence } from '../../crawler/readiness.mjs';

const milestoneEvidence = Object.fromEntries(
  Array.from({ length: 15 }, (_, index) => [String(index + 1).padStart(2, '0'), { status: 'complete' }]),
);

const completeEvidence = () => ({
  milestones: milestoneEvidence,
  dependencyOrder: { pass: true, coveredMilestones: Array.from({ length: 15 }, (_, i) => String(i + 1).padStart(2, '0')) },
  durableRun: { pass: true, resumable: true, idempotent: true },
  sourceTelemetry: { pass: true, sources: { ats: { attempts: 1, fetched: 1, status: 'ok' } } },
  politeFetch: { pass: true, robotsHonored: true, hostLimits: true, retriesBounded: true },
  novelty: { pass: true, errorCount: 0, zeroErrors: true },
  shortfall: { exact: true, minimumMissing: 0, reasons: [], autoRescue: false },
  reserveShortlist: { pass: true, noPadding: true, controlledReachMaximum: 2 },
  actionSafety: { noAutoApply: true, noAutoSend: true, writesPlanned: false },
  contactGating: { pass: true, onlyAfterSelection: true, verifiedOnly: true, maxPerApplication: 2 },
  audit: { pass: true, evidence: ['run-1', 'audit-1'] },
  testSummary: { supplied: true, passed: true, failed: 0, total: 42 },
  unresolvedBlockers: [],
  liveCredentials: { required: true, available: true },
  operationalVerification: { pass: true, evidence: ['fixture-replay', 'bounded-probe'] },
});

test('passes only when all required crawler evidence and operational verification are present', () => {
  const result = assessProductionReadiness(completeEvidence());

  assert.equal(result.pass, true);
  assert.equal(result.productionReady, true);
  assert.equal(result.codeComplete, true);
  assert.equal(result.operationallyVerified, true);
  assert.deepEqual(result.reasons, []);
});

test('fails closed when required evidence is missing', () => {
  const evidence = completeEvidence();
  delete evidence.sourceTelemetry;
  delete evidence.audit;

  const result = assessProductionReadiness(evidence);

  assert.equal(result.pass, false);
  assert.equal(result.codeComplete, false);
  assert.ok(result.reasons.includes('SOURCE_TELEMETRY_EVIDENCE_MISSING'));
  assert.ok(result.reasons.includes('AUDIT_EVIDENCE_MISSING'));
});

test('novelty is a zero-error release gate', () => {
  const result = assessProductionReadiness({
    ...completeEvidence(),
    novelty: { pass: false, errorCount: 1, zeroErrors: false },
  });

  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes('NOVELTY_ERRORS_PRESENT'));
});

test('a failing supplied test suite prevents code-complete and production-ready claims', () => {
  const result = assessProductionReadiness({
    ...completeEvidence(),
    testSummary: { supplied: true, passed: false, failed: 1, total: 42 },
  });

  assert.equal(result.pass, false);
  assert.equal(result.codeComplete, false);
  assert.ok(result.reasons.includes('TEST_SUITE_FAILING'));
});

test('no-live-credentials is reported as operationally unverified, not silently treated as ready', () => {
  const result = assessProductionReadiness({
    ...completeEvidence(),
    liveCredentials: { required: true, available: false },
    operationalVerification: { pass: false, evidence: [] },
  });

  assert.equal(result.codeComplete, true);
  assert.equal(result.operationallyVerified, false);
  assert.equal(result.productionReady, false);
  assert.ok(result.reasons.includes('LIVE_CREDENTIALS_UNAVAILABLE'));
  assert.ok(result.reasons.includes('OPERATIONAL_VERIFICATION_MISSING'));
});

test('generated local evidence reports dirty worktree and missing operational verification', () => {
  const evidence = buildLocalReadinessEvidence({
    testsPassed: true,
    testTotal: 90,
    dirtyPaths: ['crawler/workflow.mjs'],
    operationalEvidence: null,
    sourceIds: ['career-sites'],
  });
  const result = assessProductionReadiness(evidence);

  assert.equal(result.productionReady, false);
  assert.ok(evidence.unresolvedBlockers.includes('dirty-worktree:crawler/workflow.mjs'));
  assert.ok(result.reasons.includes('UNRESOLVED_BLOCKERS_PRESENT'));
  assert.ok(result.reasons.includes('OPERATIONAL_VERIFICATION_MISSING'));
});
