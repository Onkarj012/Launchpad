import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeCanaryVersion,
  DEFAULT_CANARY_CODE_PATHS,
  evaluateDeliveryCanary,
} from '../../crawler/canary-evaluator.mjs';

function healthyRecord(index, version = 'code-config-v1', discoveryProfile = { schedule: 'morning', mode: 'normal', locationPreset: 'india' }) {
  return {
    runId: `run-${index}`,
    runAt: `2026-07-${String(index + 1).padStart(2, '0')}T06:30:00.000Z`,
    valid: true,
    codeConfigVersion: version,
    discoveryProfile,
    engineering: {
      fatalScorerInfrastructureFailures: 0,
      sourceOutagesReportedHealthy: 0,
      selectedSuppressedRoles: 0,
      rolesSurfacedBeforeCommit: 0,
      duplicateRequisitionCollisions: 0,
      unattributedFunnelLoss: 0,
      durationMs: 1_000,
      reportComplete: true,
      reportPaths: { markdown: '/tmp/report.md', json: '/tmp/report.json' },
      manualInventoryMatch: true,
    },
  };
}

test('seven same-version healthy runs return per-gate passing verdicts with evidence', () => {
  const evaluation = evaluateDeliveryCanary(Array.from({ length: 7 }, (_, index) => healthyRecord(index)));

  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.streak.count, 7);
  assert.deepEqual(evaluation.streak.discoveryProfile, { schedule: 'morning', mode: 'normal', locationPreset: 'india' });
  assert.equal(evaluation.gates.length, 10);
  for (const gate of evaluation.gates) {
    assert.equal(gate.passed, true, gate.id);
    assert.equal(typeof gate.evidence, 'object');
    assert.ok(Object.keys(gate.evidence).length > 0);
  }
});

test('every engineering gate can fail independently and a version change resets the streak', () => {
  const mutations = {
    'fatal-scorer-infrastructure': ['fatalScorerInfrastructureFailures', 1],
    'source-outage-truthfulness': ['sourceOutagesReportedHealthy', 1],
    'selected-suppression': ['selectedSuppressedRoles', 1],
    'post-commit-surfacing': ['rolesSurfacedBeforeCommit', 1],
    'duplicate-requisition': ['duplicateRequisitionCollisions', 1],
    'funnel-reconciliation': ['unattributedFunnelLoss', 1],
    'routine-duration': ['durationMs', 2_700_001],
    'complete-local-report': ['reportComplete', false],
    'manual-inventory-match': ['manualInventoryMatch', false],
  };
  for (const [gateId, [field, value]] of Object.entries(mutations)) {
    const runs = Array.from({ length: 7 }, (_, index) => healthyRecord(index));
    runs[3].engineering[field] = value;
    const gate = evaluateDeliveryCanary(runs).gates.find((item) => item.id === gateId);
    assert.equal(gate.passed, false, gateId);
    assert.ok(gate.evidence.failingRunIds.includes('run-3'), gateId);
  }

  const changed = Array.from({ length: 7 }, (_, index) => healthyRecord(index));
  changed[6] = healthyRecord(6, 'code-config-v2');
  const evaluation = evaluateDeliveryCanary(changed);
  const streakGate = evaluation.gates.find((gate) => gate.id === 'seven-consecutive-valid-runs');
  assert.equal(streakGate.passed, false);
  assert.equal(evaluation.streak.count, 1);
  assert.equal(evaluation.streak.version, 'code-config-v2');
  assert.deepEqual(streakGate.evidence.versionChanges, [{
    fromRunId: 'run-5',
    toRunId: 'run-6',
    fromVersion: 'code-config-v1',
    toVersion: 'code-config-v2',
  }]);
});

test('invalid, fatal invalid, historical profile-less, or mixed-profile records reset the promotion streak', () => {
  const invalidRuns = Array.from({ length: 8 }, (_, index) => healthyRecord(index));
  invalidRuns[5] = { ...healthyRecord(5), valid: false, outcome: { status: 'fatal', fatal: true, degraded: false }, invalidReasons: ['run outcome is fatal'] };
  const original = structuredClone(invalidRuns[5]);
  const invalidEvaluation = evaluateDeliveryCanary(invalidRuns);
  assert.equal(invalidEvaluation.streak.count, 2);
  assert.deepEqual(invalidEvaluation.streak.invalidRunIds, ['run-5']);
  assert.equal(invalidEvaluation.streak.runIds.includes('run-5'), false);
  assert.deepEqual(invalidRuns[5], original);

  const profileCases = [
    ['normal/startup', { schedule: 'morning', mode: 'startup', locationPreset: 'india' }],
    ['morning/midday', { schedule: 'midday', mode: 'normal', locationPreset: 'india' }],
    ['india/pune', { schedule: 'morning', mode: 'normal', locationPreset: 'pune' }],
  ];
  for (const [label, discoveryProfile] of profileCases) {
    const runs = Array.from({ length: 7 }, (_, index) => healthyRecord(index));
    runs[6] = healthyRecord(6, 'code-config-v1', discoveryProfile);
    const evaluation = evaluateDeliveryCanary(runs);
    assert.equal(evaluation.streak.count, 1, label);
    assert.deepEqual(evaluation.streak.discoveryProfile, discoveryProfile, label);
    assert.equal(evaluation.passed, false, label);
  }

  const historical = Array.from({ length: 7 }, (_, index) => healthyRecord(index));
  delete historical[6].discoveryProfile;
  const historicalEvaluation = evaluateDeliveryCanary(historical);
  assert.equal(historicalEvaluation.streak.count, 0);
  assert.equal(historicalEvaluation.streak.discoveryProfile, null);
  assert.deepEqual(historicalEvaluation.streak.invalidRunIds, ['run-6']);
});

test('default fingerprint covers mode-critical deterministic policy, inventory, and enrichment inputs', () => {
  assert.equal(DEFAULT_CANARY_CODE_PATHS.includes('crawler/daily-report.mjs'), false);
  for (const requiredPath of [
    'crawler/daily-runner.mjs', 'crawler/operator.mjs', 'crawler/ats-warm.mjs',
    'crawler/ats-batch-1.mjs', 'crawler/ats-batch-2.mjs', 'crawler/ats-enterprise.mjs',
    'crawler/brave-search.mjs', 'crawler/commercial-rescue.mjs', 'crawler/connector-inbox.mjs',
    'crawler/discovery-profile.mjs', 'crawler/india-startup-lanes.mjs',
    'crawler/original-listing-resolver.mjs', 'crawler/run.mjs', 'crawler/schedules.mjs',
    'crawler/theirstack.mjs', 'crawler/vc-portfolio-watchlist.mjs', 'crawler/workflow.mjs',
    'crawler/delivery-canary.mjs', 'crawler/canary-evaluator.mjs', 'crawler/cli.mjs',
    'crawler/board-registry.mjs', 'crawler/board-rotation-state.mjs', 'crawler/identity.mjs',
    'career-ops/providers/workday.mjs',
    'config/crawler-v2.json', 'config/reverse-warm-set.json',
    'config/vc-portfolio-watchlist.json', 'config/job-pull.json', 'config/conversion-plan.json',
    'config/board-registry.json', 'config/match-score.schema.json', 'job-pull/config.mjs',
    'job-pull/warm-set.mjs', 'job-pull/run.mjs', 'job-pull/candidate.mjs', 'job-pull/eligibility.mjs',
    'job-pull/freshness.mjs', 'job-pull/dedup.mjs', 'job-pull/conversion-score.mjs',
    'job-pull/match-scorer.mjs', 'job-pull/opportunity-ledger.mjs',
    'job-pull/mode-scoring.mjs', 'job-pull/normal-mode.mjs',
    'job-pull/normal-readiness.mjs', 'job-pull/normal-sources.mjs',
    'job-pull/normal-selection.mjs', 'job-pull/workday-enrichment.mjs',
    'job-pull/startup-mode.mjs', 'job-pull/startup-sources.mjs',
    'job-pull/startup-enrichment.mjs', 'job-pull/startup-selection.mjs',
    'job-pull/remote-mode.mjs', 'job-pull/remote-sources.mjs',
    'job-pull/remote-enrichment.mjs', 'job-pull/remote-selection.mjs',
    'job-pull/remote-adapters/himalayas.mjs', 'job-pull/remote-adapters/jobicy.mjs',
    'job-pull/remote-adapters/remoteok.mjs', 'job-pull/remote-adapters/remotive.mjs',
    'job-pull/remote-adapters/weworkremotely.mjs', 'career-ops/providers/himalayas.mjs',
    'career-ops/providers/jobicy.mjs', 'career-ops/providers/weworkremotely.mjs',
  ]) assert.ok(DEFAULT_CANARY_CODE_PATHS.includes(requiredPath), requiredPath);
});

test('default fingerprint changes for policy, identity, Workday provider, and every remote adapter', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-canary-version-'));
  for (const relative of DEFAULT_CANARY_CODE_PATHS) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${relative}:baseline`);
  }
  let previous = computeCanaryVersion({ root });
  for (const relative of [
    'config/job-pull.json',
    'crawler/identity.mjs',
    'career-ops/providers/workday.mjs',
    'job-pull/remote-adapters/himalayas.mjs',
    'job-pull/remote-adapters/jobicy.mjs',
    'job-pull/remote-adapters/remoteok.mjs',
    'job-pull/remote-adapters/remotive.mjs',
    'job-pull/remote-adapters/weworkremotely.mjs',
  ]) {
    writeFileSync(path.join(root, relative), `${relative}:changed`);
    const changed = computeCanaryVersion({ root });
    assert.notEqual(changed, previous, relative);
    previous = changed;
  }
});

test('fingerprint fails closed when a tracked file is missing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-canary-missing-'));
  assert.throws(
    () => computeCanaryVersion({ root, codePaths: ['crawler/daily-runner.mjs'] }),
    /missing tracked file/,
  );
});
