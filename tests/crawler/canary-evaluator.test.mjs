import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectTrackedModuleGraph,
  collectTrackedModuleInventory,
  computeCanaryVersion,
  DEFAULT_CANARY_CODE_PATHS,
  DEFAULT_CANARY_ENTRYPOINTS,
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

test('seven healthy runs on one UTC day do not satisfy the seven-day canary gate', () => {
  const runs = Array.from({ length: 7 }, (_, index) => ({
    ...healthyRecord(index),
    runAt: `2026-07-01T06:${String(30 + index).padStart(2, '0')}:00.000Z`,
  }));
  const evaluation = evaluateDeliveryCanary(runs);
  const gate = evaluation.gates.find((item) => item.id === 'seven-consecutive-valid-runs');

  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.streak.count, 7);
  assert.equal(evaluation.streak.dayCount, 1);
  assert.deepEqual(evaluation.streak.dates, ['2026-07-01']);
  assert.equal(gate.passed, false);
  assert.equal(gate.evidence.dayCount, 1);
  assert.deepEqual(gate.evidence.dates, ['2026-07-01']);
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

test('default code-path compatibility export contains only operational entrypoints', () => {
  assert.deepEqual(DEFAULT_CANARY_CODE_PATHS, DEFAULT_CANARY_ENTRYPOINTS);
  assert.ok(DEFAULT_CANARY_ENTRYPOINTS.includes('vendor/career-ops/runtime.mjs'));
});

test('default canary graph includes dynamically loaded vendor modules and excludes nested runtime roots', () => {
  const graph = collectTrackedModuleGraph();
  assert.ok(graph.includes('vendor/career-ops/runtime.mjs'));
  assert.ok(graph.includes('vendor/career-ops/providers/greenhouse.mjs'));
  assert.ok(graph.includes('vendor/career-ops/plugins/_engine.mjs'));
  assert.equal(graph.some((file) => file.startsWith('career-ops/')), false);
  assert.equal(graph.includes('career-ops/package.json'), false);
});

test('recursive graph fingerprints transitive bytes, export-from dependencies, and cycles', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-canary-version-'));
  const files = {
    'src/main.mjs': "import { value } from './nested/entry'; export { value } from './nested/entry';",
    'src/nested/entry/index.mjs': "export { value } from '../leaf.js';",
    'src/nested/leaf.js': "import { cycle } from './cycle.mjs'; export const value = cycle;",
    'src/nested/cycle.mjs': "import { value } from './leaf.js'; export const cycle = value;",
    'config/policy.json': '{"version":1}\n',
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  const inventory = collectTrackedModuleInventory(['src/main.mjs'], { root });
  assert.deepEqual(inventory.map((file) => file.path), [
    'src/main.mjs', 'src/nested/cycle.mjs', 'src/nested/entry/index.mjs', 'src/nested/leaf.js',
  ]);
  assert.ok(inventory.every((file) => Buffer.isBuffer(file.bytes)));
  assert.deepEqual(collectTrackedModuleGraph(['src/main.mjs'], { root }), inventory.map((file) => file.path));

  let previous = computeCanaryVersion({ root, entrypoints: ['src/main.mjs'], nonCodePaths: ['config/policy.json'] });
  writeFileSync(path.join(root, 'src/nested/leaf.js'), 'import { cycle } from \'./cycle.mjs\'; export const value = cycle + 1;');
  let changed = computeCanaryVersion({ root, entrypoints: ['src/main.mjs'], nonCodePaths: ['config/policy.json'] });
  assert.notEqual(changed, previous);
  previous = changed;
  writeFileSync(path.join(root, 'config/policy.json'), '{"version":2}\n');
  changed = computeCanaryVersion({ root, entrypoints: ['src/main.mjs'], nonCodePaths: ['config/policy.json'] });
  assert.notEqual(changed, previous);
});

test('module discovery ignores fake imports outside executable literals and parses JSON only as a leaf', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-canary-lexical-'));
  const files = {
    'src/main.mjs': `
      // import './comment-missing.mjs';
      /** export { value } from './jsdoc-missing.mjs'; */
      const ordinary = "import './string-missing.mjs'";
      const template = \`import('./template-missing.mjs')\`;
      const regex = /import\\(\\s*['"]\\.\\/regex-missing\\.mjs['"]\\s*\\)/;
      const decimal = 1.25 / 2; import './decimal-dep.mjs';
      const separated = 1_000 / 2; import './separated-dep.mjs';
      const hexadecimal = 0x10 / 2; import './hexadecimal-dep.mjs';
      const binary = 0b10 / 2; import './binary-dep.mjs';
      const octal = 0o10 / 2; import './octal-dep.mjs';
      const exponent = 1e2 / 2; import './exponent-dep.mjs';
      const bigint = 1n / 2n; import './bigint-dep.mjs';
      let counter = 0;
      const increment = counter++ / 2; import './increment-dep.mjs';
      const decrement = counter-- / 2; import './decrement-dep.mjs';
      import './side-effect.mjs';
      import { value } from './static.mjs';
      export { value } from './exported.mjs';
      import('./dynamic.mjs');
      import(moduleName);
      import data from './values.json';
    `,
    'src/side-effect.mjs': 'export const sideEffect = true;\n',
    'src/static.mjs': 'export const value = 1;\n',
    'src/exported.mjs': 'export const value = 2;\n',
    'src/dynamic.mjs': 'export const value = 3;\n',
    'src/values.json': '{"example":"import \'./json-value-missing.mjs\'"}\n',
  };
  for (const dependency of [
    'decimal-dep.mjs', 'separated-dep.mjs', 'hexadecimal-dep.mjs', 'binary-dep.mjs',
    'octal-dep.mjs', 'exponent-dep.mjs', 'bigint-dep.mjs', 'increment-dep.mjs', 'decrement-dep.mjs',
  ]) files[`src/${dependency}`] = 'export const value = true;\n';
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }

  assert.deepEqual(collectTrackedModuleGraph(['src/main.mjs'], { root }), [
    'src/bigint-dep.mjs',
    'src/binary-dep.mjs',
    'src/decimal-dep.mjs',
    'src/decrement-dep.mjs',
    'src/dynamic.mjs',
    'src/exponent-dep.mjs',
    'src/exported.mjs',
    'src/hexadecimal-dep.mjs',
    'src/increment-dep.mjs',
    'src/main.mjs',
    'src/octal-dep.mjs',
    'src/separated-dep.mjs',
    'src/side-effect.mjs',
    'src/static.mjs',
    'src/values.json',
  ]);
});

test('fingerprint fails closed when a local dependency is unresolved', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-canary-unresolved-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/main.mjs'), "export { value } from './missing';");
  assert.throws(
    () => computeCanaryVersion({ root, entrypoints: ['src/main.mjs'], nonCodePaths: [] }),
    /unresolved local import: src\/main\.mjs -> \.\/missing/,
  );
});

test('fingerprint fails closed when a tracked file is missing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-canary-missing-'));
  assert.throws(
    () => computeCanaryVersion({ root, codePaths: ['crawler/daily-runner.mjs'] }),
    /missing tracked file/,
  );
});
