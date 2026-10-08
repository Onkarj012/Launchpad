import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  buildDeliveryCanary,
  compareDeliveryCanaryRuns,
  computeDeliveryInventoryIdentity,
  createJsonCanaryStore,
  DELIVERY_CANARY_EVIDENCE_SCHEMA,
  DELIVERY_CANARY_SIDECAR_SCHEMA,
  recordDeliveryCanary,
} from '../../crawler/delivery-canary.mjs';
import { verifySafetyContracts } from '../../crawler/safety-contract.mjs';

const RUN_AT = '2026-07-25T06:30:00.000Z';
const EXPECTED_REVISION = '978ce25';
const REPORT_ROOT = mkdtempSync(path.join(os.tmpdir(), 'launchpad-canary-reports-'));
const REPORT_MARKDOWN = '# Canary report\nBound inventory.\n';
const INVENTORY_IDENTITY = `sha256:${createHash('sha256').update('inventory-v1').digest('hex')}`;
const REPORT_DIGEST = `sha256:${createHash('sha256').update(REPORT_MARKDOWN).digest('hex')}`;

function writeReports(overrides = {}) {
  const reportDir = path.join(REPORT_ROOT, 'reports');
  mkdirSync(reportDir, { recursive: true });
  const markdownPath = path.join(reportDir, 'report.md');
  const jsonPath = path.join(reportDir, 'report.json');
  writeFileSync(markdownPath, overrides.markdown ?? REPORT_MARKDOWN);
  writeFileSync(jsonPath, overrides.jsonText ?? JSON.stringify({
    schemaVersion: DELIVERY_CANARY_SIDECAR_SCHEMA,
    runId: 'morning-2026-07-25',
    codeConfigVersion: 'code-config-v1',
    revision: EXPECTED_REVISION,
    inventoryIdentity: INVENTORY_IDENTITY,
    markdownDigest: REPORT_DIGEST,
    ...(overrides.sidecar ?? {}),
  }));
}
writeReports();

function canaryOptions(overrides = {}) {
  return { expectedRevision: EXPECTED_REVISION, reportRoot: REPORT_ROOT, ...overrides };
}

function buildCanary(options = {}) {
  return buildDeliveryCanary({ ...options, ...canaryOptions(options.validationOptions) });
}

function evidence(overrides = {}) {
  return {
    schemaVersion: DELIVERY_CANARY_EVIDENCE_SCHEMA,
    runId: 'morning-2026-07-25',
    codeConfigVersion: 'code-config-v1',
    inventoryIdentity: INVENTORY_IDENTITY,
    engineering: {
      fatalScorerInfrastructureFailures: 0,
      sourceOutagesReportedHealthy: 0,
      selectedSuppressedRoles: 0,
      rolesSurfacedBeforeCommit: 0,
      duplicateRequisitionCollisions: 0,
      unattributedFunnelLoss: 0,
      durationMs: 1_000,
      reportComplete: true,
      reportPaths: { markdown: 'reports/report.md', json: 'reports/report.json' },
      manualInventoryMatch: true,
    },
    reproducibility: { revision: '978ce25', clean: true, dirtyPaths: [] },
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    runId: 'morning-2026-07-25',
    codeConfigVersion: 'code-config-v1',
    discoveryProfile: { schedule: 'morning', mode: 'normal', locationPreset: 'india' },
    inventoryIdentity: INVENTORY_IDENTITY,
    canaryEvidence: evidence(),
    runAt: RUN_AT,
    outcome: { status: 'ok', fatal: false, degraded: false, errors: [] },
    counts: { eligible: 10, scored: 4, ready: 5, selected: 1 },
    reconciliation: {
      causes: {
        eligibleToReady: { HISTORICAL_SUPPRESSION: 2, NOT_APPLICATION_READY: 1 },
        readyToScored: {},
        scoredToSelected: { COMPANY_CAP: 1, DIVERSITY: 1 },
      },
    },
    shortfall: { missing: 1 },
    v4HistorySnapshot: { status: 'missing', path: '/tmp/v4-history.json' },
    ...overrides,
  };
}

test('records normalized discovery profile, per-run counts, and every delta cause', () => {
  const record = buildCanary({ run: run({ discoveryProfile: { schedule: ' MORNING ', mode: 'Normal', locationPreset: 'INDIA' } }) });

  assert.equal(record.valid, true);
  assert.deepEqual(record.discoveryProfile, { schedule: 'morning', mode: 'normal', locationPreset: 'india' });
  assert.deepEqual(record.counts, { eligible: 10, scoredPool: 4, ready: 5, shortlist: 1 });
  assert.deepEqual(record.deltas[0].attributions, [
    { cause: 'historical suppression', count: 2 },
    { cause: 'readiness', count: 1 },
    { cause: 'unattributed', count: 2 },
  ]);
  assert.deepEqual(record.deltas[1].attributions, [{ cause: 'unattributed', count: 1 }]);
  assert.deepEqual(record.deltas[2].attributions, [
    { cause: 'company cap', count: 1 },
    { cause: 'diversity', count: 1 },
    { cause: 'shortfall', count: 1 },
  ]);
});

test('missing profile and missing, malformed, mismatched, or wrong-revision evidence stay invalid with explicit reasons', () => {
  const profileless = buildCanary({ run: run({ discoveryProfile: undefined }) });
  assert.equal(profileless.valid, false);
  assert.equal(profileless.discoveryProfile, null);
  assert.ok(profileless.invalidReasons.some((reason) => /discoveryProfile/.test(reason)));

  const missing = buildCanary({ run: run({ canaryEvidence: null }) });
  assert.equal(missing.valid, false);
  assert.match(missing.invalidReasons[0], /must be an object/);

  const malformed = buildCanary({ run: run({ canaryEvidence: { schemaVersion: 'UnknownEvidence' } }) });
  assert.equal(malformed.valid, false);
  assert.ok(malformed.invalidReasons.some((reason) => /unrecognized.*schema/i.test(reason)));
  assert.ok(malformed.invalidReasons.some((reason) => /runId mismatch/.test(reason)));

  const mismatched = buildCanary({ run: run({ canaryEvidence: evidence({ runId: 'other-run', codeConfigVersion: 'other-version' }) }) });
  assert.equal(mismatched.valid, false);
  assert.ok(mismatched.invalidReasons.some((reason) => /runId mismatch/.test(reason)));
  assert.ok(mismatched.invalidReasons.some((reason) => /codeConfigVersion mismatch/.test(reason)));

  const wrongRevision = buildCanary({ run: run({ canaryEvidence: evidence({
    reproducibility: { revision: 'other-revision', clean: true, dirtyPaths: [] },
  }) }) });
  assert.equal(wrongRevision.valid, false);
  assert.ok(wrongRevision.invalidReasons.some((reason) => /revision mismatch: expected 978ce25, received other-revision/.test(reason)));
});

test('incomplete engineering/report evidence and dirty reproducibility evidence cannot pass', () => {
  const incomplete = buildCanary({ run: run({ canaryEvidence: evidence({
    engineering: {
      fatalScorerInfrastructureFailures: 0,
      sourceOutagesReportedHealthy: 0,
      selectedSuppressedRoles: 0,
      rolesSurfacedBeforeCommit: 0,
      duplicateRequisitionCollisions: 0,
      reportComplete: false,
      reportPaths: { markdown: '', json: null },
      manualInventoryMatch: false,
    },
  }) }) });
  assert.equal(incomplete.valid, false);
  assert.ok(incomplete.invalidReasons.some((reason) => /unattributedFunnelLoss must be finite/.test(reason)));
  assert.ok(incomplete.invalidReasons.some((reason) => /durationMs must be finite/.test(reason)));
  assert.ok(incomplete.invalidReasons.some((reason) => /reportComplete must be true/.test(reason)));
  assert.ok(incomplete.invalidReasons.some((reason) => /manualInventoryMatch must be true/.test(reason)));

  const dirty = buildCanary({ run: run({ canaryEvidence: evidence({
    reproducibility: { revision: '978ce25', clean: false, dirtyPaths: ['crawler/cli.mjs'] },
  }) }) });
  assert.equal(dirty.valid, false);
  assert.equal(dirty.revision, '978ce25');
  assert.equal(dirty.clean, false);
  assert.deepEqual(dirty.dirtyPaths, ['crawler/cli.mjs']);
  assert.ok(dirty.invalidReasons.some((reason) => /clean must be true/.test(reason)));
  assert.ok(dirty.invalidReasons.some((reason) => /dirtyPaths must be empty/.test(reason)));
});

test('missing, empty, non-file, and outside-root reports record explicit invalid reasons', () => {
  const cases = [
    ['missing', 'reports/missing.md', undefined],
    ['empty', 'reports/empty.md', { statSync: () => ({ size: 0, isFile: () => true }) }],
    ['not a regular file', 'reports/directory.md', { statSync: () => ({ size: 12, isFile: () => false }) }],
    ['resolve under approved root', '../outside.md', undefined],
  ];
  for (const [reason, markdown, fsApi] of cases) {
    const engineering = { ...evidence().engineering, reportPaths: { markdown, json: 'reports/report.json' } };
    const record = buildCanary({
      run: run({ canaryEvidence: evidence({ engineering }) }),
      validationOptions: fsApi ? { fsApi } : {},
    });
    assert.equal(record.valid, false, reason);
    assert.ok(record.invalidReasons.some((item) => item.includes(reason)), `${reason}: ${record.invalidReasons.join('; ')}`);
  }
});

test('JSON sidecar must parse and bind schema, current fields, inventory, and Markdown bytes', () => {
  const cases = [
    ['parse', { jsonText: '{not json' }, /failed to parse canary JSON sidecar/],
    ['schema', { sidecar: { schemaVersion: 'OldSidecar' } }, /unrecognized canary JSON sidecar schema/],
    ['run', { sidecar: { runId: 'prior-run' } }, /sidecar runId mismatch/],
    ['inventory', { sidecar: { inventoryIdentity: 'sha256:bad' } }, /sidecar inventoryIdentity mismatch/],
    ['digest', { sidecar: { markdownDigest: `sha256:${'0'.repeat(64)}` } }, /markdownDigest mismatch/],
    ['reused report', { markdown: '# Different report\n' }, /markdownDigest mismatch/],
  ];
  for (const [label, report, reason] of cases) {
    writeReports(report);
    const record = buildCanary({ run: run() });
    assert.equal(record.valid, false, label);
    assert.ok(record.invalidReasons.some((item) => reason.test(item)), `${label}: ${record.invalidReasons.join('; ')}`);
  }
  writeReports();
  const evidenceMismatch = buildCanary({ run: run({ canaryEvidence: evidence({ inventoryIdentity: `sha256:${'f'.repeat(64)}` }) }) });
  assert.equal(evidenceMismatch.valid, false);
  assert.ok(evidenceMismatch.invalidReasons.some((reason) => /evidence inventoryIdentity mismatch/.test(reason)));
});

test('run outcome and machine-observable source/scorer truth override perfect evidence', () => {
  const cases = [
    ['fatal', run({
      outcome: { status: 'fatal', fatal: true, degraded: false, errors: [{ stage: 'scoring', message: 'scorer broken' }] },
      scoring: { scorer: { degraded: true, reasonCode: 'SCORER_AUTH_FAILED', failures: [] } },
    }), /run outcome is fatal/],
    ['degraded', run({ outcome: { status: 'degraded', fatal: false, degraded: true, errors: [] } }), /run outcome is degraded/],
    ['failed source', run({ sourceManifests: [{ sourceId: 'expanded-ats', status: 'failed' }] }), /sourceOutagesReportedHealthy under-reports/],
  ];
  for (const [label, input, reason] of cases) {
    const record = buildCanary({ run: input });
    assert.equal(record.valid, false, label);
    assert.ok(record.invalidReasons.some((item) => reason.test(item)), `${label}: ${record.invalidReasons.join('; ')}`);
  }
  const fatal = buildCanary({ run: cases[0][1] });
  assert.equal(fatal.engineering.fatalScorerInfrastructureFailures, 1);
  const failedSource = buildCanary({ run: cases[2][1] });
  assert.equal(failedSource.engineering.sourceOutagesReportedHealthy, 1);
});

test('every honestly reported nonzero effective engineering zero-gate invalidates the canary', () => {
  const cases = [
    ['fatalScorerInfrastructureFailures', {
      scoring: { scorer: { degraded: true, reasonCode: 'SCORER_AUTH_FAILED', failures: [] } },
    }],
    ['sourceOutagesReportedHealthy', {
      sourceManifests: [{ sourceId: 'expanded-ats', status: 'failed' }],
    }],
    ['selectedSuppressedRoles', {
      shortlist: [{ dedupKey: 'workday:req-1' }],
      historicalSuppressions: [{ dedupKey: 'workday:req-1' }],
    }],
    ['rolesSurfacedBeforeCommit', {
      transaction: {
        status: 'aborted',
        newlyCommitted: [],
        alreadyCommitted: [],
      },
      surfaced: { rows: [{ dedupKey: 'workday:req-1' }] },
    }],
    ['duplicateRequisitionCollisions', {
      duplicateRequisitionCollisions: 1,
    }],
    ['unattributedFunnelLoss', {
      funnel: { reconciliation: { ok: false, delta: 1 } },
    }],
  ];

  for (const [field, runOverrides] of cases) {
    const engineering = { ...evidence().engineering, [field]: 1 };
    const record = buildCanary({
      run: run({
        ...runOverrides,
        canaryEvidence: evidence({ engineering }),
      }),
    });

    assert.equal(record.valid, false, field);
    assert.equal(record.engineering[field], 1, field);
    assert.equal(record.derivedEngineering[field], 1, field);
    assert.ok(
      record.invalidReasons.includes(`effective canary engineering.${field} must be exactly 0, received 1`),
      `${field}: ${record.invalidReasons.join('; ')}`,
    );
  }
});

test('recognized healthy ok evidence records a valid reproducible canary without inventing unavailable facts', () => {
  const record = buildCanary({ run: run() });
  assert.equal(record.valid, true);
  assert.deepEqual(record.invalidReasons, []);
  assert.deepEqual(record.outcome, { status: 'ok', fatal: false, degraded: false });
  assert.equal(record.revision, '978ce25');
  assert.equal(record.clean, true);
  assert.deepEqual(record.dirtyPaths, []);
  assert.equal(record.engineering.manualInventoryMatch, true);
  assert.equal(record.engineering.durationMs, 1_000);
  assert.deepEqual(record.derivedEngineering, {
    fatalScorerInfrastructureFailures: 0,
    sourceOutagesReportedHealthy: 0,
    selectedSuppressedRoles: 0,
    rolesSurfacedBeforeCommit: 0,
    duplicateRequisitionCollisions: 0,
    unattributedFunnelLoss: 0,
  });
});

test('delivery identity binds semantic shortlist and authoritative operations with stable object-key ordering', () => {
  const shortlist = [{
    canonicalUrl: 'https://jobs.example.test/1',
    company: 'Alpha',
    title: 'AI Engineer',
    provider: 'workday',
    jobId: 'REQ-1',
    originalApplicationUrl: 'https://alpha.example.test/apply/1',
    matchScore: 81,
    conversionScore: 74,
    responseLikelihood: 16,
    freshnessWindow: 'Hot',
    selectionTier: 'Strict',
    applicationReadiness: { ready: true, evidence: { liveness: 'active' } },
    rationale: 'Strong Python fit',
    hook: 'Production agent systems',
  }];
  const operations = [{
    operation: 'create',
    resource: 'application',
    dedupKey: 'workday:req-1',
    payload: { role: 'AI Engineer', Company: 'Alpha', matchScore: 81, nested: { b: 2, a: 1 } },
    provenance: { discoveryProvider: 'workday', evidence: { second: 2, first: 1 } },
  }];
  const baseline = computeDeliveryInventoryIdentity(shortlist, operations);
  const reordered = computeDeliveryInventoryIdentity(
    [{ ...shortlist[0], applicationReadiness: { evidence: { liveness: 'active' }, ready: true } }],
    [{ provenance: { evidence: { first: 1, second: 2 }, discoveryProvider: 'workday' }, payload: { nested: { a: 1, b: 2 }, matchScore: 81, Company: 'Alpha', role: 'AI Engineer' }, dedupKey: 'workday:req-1', resource: 'application', operation: 'create' }],
  );
  assert.equal(reordered, baseline);

  for (const [label, mutatedShortlist, mutatedOperations] of [
    ['title', [{ ...shortlist[0], title: 'ML Engineer' }], operations],
    ['company', [{ ...shortlist[0], company: 'Beta' }], operations],
    ['score', [{ ...shortlist[0], matchScore: 82 }], operations],
    ['payload', shortlist, [{ ...operations[0], payload: { ...operations[0].payload, role: 'ML Engineer' } }]],
    ['provenance', shortlist, [{ ...operations[0], provenance: { ...operations[0].provenance, discoveryProvider: 'greenhouse' } }]],
  ]) assert.notEqual(computeDeliveryInventoryIdentity(mutatedShortlist, mutatedOperations), baseline, label);
});

test('fully timed-out scoring loss is attributed to scorer infrastructure', () => {
  const record = buildCanary({ run: run({
    counts: { eligible: 22, scored: 0, ready: 22, selected: 0 },
    reconciliation: { causes: {
      eligibleToReady: {},
      readyToScored: { UNSCORED: 22, SCORING_FAILED: 0 },
      scoredToSelected: {},
    } },
    scoring: { scorer: { degraded: true, reasonCode: 'SCORER_TIMEOUT' } },
  }) });

  assert.deepEqual(record.deltas[1].attributions, [{ cause: 'scorer infrastructure failure', count: 22 }]);
  assert.equal(record.deltas[1].attributions.some((item) => item.cause === 'unattributed'), false);
});

test('scoring-failed rows on a degraded scorer are attributed to infrastructure', () => {
  const record = buildCanary({ run: run({
    counts: { eligible: 6, scored: 0, ready: 6, selected: 0 },
    reconciliation: { causes: {
      eligibleToReady: {},
      readyToScored: { UNSCORED: 0, SCORING_FAILED: 6 },
      scoredToSelected: {},
    } },
    scoring: { scorer: { degraded: true } },
  }) });

  assert.deepEqual(record.deltas[1].attributions, [{ cause: 'scorer infrastructure failure', count: 6 }]);
});

test('mixed scoring losses use the full total without readiness attribution', () => {
  const record = buildCanary({ run: run({
    counts: { eligible: 6, scored: 0, ready: 6, selected: 0 },
    reconciliation: { causes: {
      eligibleToReady: {},
      readyToScored: { UNSCORED: 3, SCORING_FAILED: 3, READINESS: 0 },
      scoredToSelected: {},
    } },
    scoring: { scorer: { degraded: true } },
  }) });

  assert.deepEqual(record.deltas[1].attributions, [{ cause: 'scorer infrastructure failure', count: 6 }]);
});

test('healthy scorer row failures are attributed to scoring failure', () => {
  const record = buildCanary({ run: run({
    counts: { eligible: 6, scored: 0, ready: 6, selected: 0 },
    reconciliation: { causes: {
      eligibleToReady: {},
      readyToScored: { UNSCORED: 0, SCORING_FAILED: 6 },
      scoredToSelected: {},
    } },
    scoring: { scorer: { degraded: false } },
  }) });

  assert.deepEqual(record.deltas[1].attributions, [{ cause: 'scoring failure', count: 6 }]);
});

test('compares two or more recorded runs day over day', () => {
  const first = buildCanary({ run: run() });
  const second = buildCanary({
    run: run({ runId: 'morning-2026-07-26', runAt: '2026-07-26T06:30:00.000Z', canaryEvidence: evidence({ runId: 'morning-2026-07-26' }), counts: { eligible: 12, scored: 8, ready: 9, selected: 3 } }),
  });
  const comparison = compareDeliveryCanaryRuns([first, second]);

  assert.equal(comparison.runCount, 2);
  assert.deepEqual(comparison.dayOverDay[0].deltas, { eligible: 2, scoredPool: 4, ready: 4, shortlist: 2 });
});

test('persists the snapshot before/after transition without seeding canary records', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'launchpad-canary-'));
  const file = path.join(directory, 'delivery-canary.json');
  const store = createJsonCanaryStore(file);
  assert.deepEqual(store.readRuns(), []);

  const before = recordDeliveryCanary({ run: run(), clock: () => RUN_AT, store, ...canaryOptions() });
  const after = recordDeliveryCanary({
    run: run({ runId: 'morning-2026-07-26', runAt: '2026-07-26T06:30:00.000Z', canaryEvidence: evidence({ runId: 'morning-2026-07-26' }), counts: { eligible: 10, scored: 3, ready: 4, selected: 2 }, v4HistorySnapshot: { status: 'loaded', path: '/tmp/v4-history.json' } }),
    clock: () => '2026-07-26T06:30:00.000Z',
    store,
    ...canaryOptions(),
  });

  assert.equal(before.historySnapshot.shortlistBeforePopulation, 1);
  assert.equal(after.historySnapshot.shortlistBeforePopulation, 1);
  assert.equal(after.historySnapshot.shortlistAfterPopulation, 2);
  assert.match(after.historySnapshot.note, /snapshot working, not a regression/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).runs.length, 2);
});

test('safety-contract verification passes current code and fails a violated contract', () => {
  const passing = verifySafetyContracts({ root: process.cwd() });
  assert.equal(passing.passed, true);
  const configPath = 'config/launchpad-v5.commands.json';
  const config = readFileSync(path.join(process.cwd(), configPath), 'utf8').replace('"autoApply": false', '"autoApply": true');
  const failing = verifySafetyContracts({ root: process.cwd(), files: { [configPath]: config } });
  assert.equal(failing.passed, false);
  assert.ok(failing.checks.some((check) => check.id === 'no-auto-apply' && !check.ok));
});
