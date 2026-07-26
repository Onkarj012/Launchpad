import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDeliveryCanary } from '../../crawler/canary-evaluator.mjs';

function healthyRecord(index, version = 'code-config-v1') {
  return {
    runId: `run-${index}`,
    runAt: `2026-07-${String(index + 1).padStart(2, '0')}T06:30:00.000Z`,
    valid: true,
    codeConfigVersion: version,
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
    },
  };
}

test('seven same-version healthy runs return per-gate passing verdicts with evidence', () => {
  const evaluation = evaluateDeliveryCanary(Array.from({ length: 7 }, (_, index) => healthyRecord(index)));

  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.streak.count, 7);
  assert.equal(evaluation.gates.length, 9);
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
