import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSuccessfulDcoTelemetry,
  buildDcoTelemetry,
} from '../../job-pull/normal-mode.mjs';

test('DCO telemetry covers all groups and rejects any unattributed stage loss', () => {
  const telemetry = buildDcoTelemetry({
    runId: 'telemetry-run',
    schedule: 'morning',
    runAt: '2026-07-26T06:30:00.000Z',
    sourceManifests: [{
      sourceId: 'ats',
      status: 'ok',
      boardsConfigured: 3,
      boardsAttempted: 2,
      succeeded: 2,
      boardsOmitted: 1,
      fetched: 8,
      acceptedObservations: 5,
      requestCount: 2,
      durationMs: 120,
      resolverSucceeded: 1,
      resolverFailed: 0,
      workdayDetail: { attempted: 2, succeeded: 1, failed: 0, skipped: 1 },
      newlyActionableYield: 2,
    }],
    funnel: {
      lifecycle: {
        normalized: 5,
        eligible: 5,
        freshnessClasses: { Hot: 3, Active: 2 },
      },
      firstFailureCodes: { NOT_READY: 1 },
    },
    readinessRepair: { input: 5, attempted: 1, repaired: 0, rejected: 1, queued: 1 },
    verificationQueue: [{ reasons: ['NOT_READY'] }],
    scoring: {
      scoredCount: 3,
      scoringFailedCount: 1,
      scorer: { attempted: 4, failures: [{ reason: 'ROW_INVALID' }] },
    },
    selection: {
      selected: [
        { selectionTier: 'Strict' },
        { selectionTier: 'Fallback' },
      ],
      stretch: [],
      exclusions: [{ code: 'SELECTION_COMPANY_CAP' }],
      scorePolicy: { stretchCount: 0, belowFloorCount: 0 },
    },
    reconciliation: {
      eligible: 5,
      ready: 4,
      scored: 3,
      selected: 2,
      causes: {
        eligibleToReady: { NOT_APPLICATION_READY: 1 },
        readyToScored: { SCORING_FAILED: 1 },
        scoredToSelected: { SELECTION_COMPANY_CAP: 1 },
      },
    },
    committed: 2,
    deliveryCommitStatus: 'committed',
  });

  assert.deepEqual(Object.keys(telemetry).sort(), ['funnel', 'operations', 'schemaVersion', 'source']);
  for (const field of [
    'boards', 'rawRows', 'acceptedObservations', 'deduplicatedUniqueJobs',
    'truncation', 'requests', 'resolver', 'detailHydration', 'perSourceNewlyActionableYield',
  ]) assert.ok(Object.hasOwn(telemetry.source, field), field);
  for (const field of [
    'normalizedUnique', 'cheapGate', 'hydration', 'hardGateEligible', 'freshnessClasses',
    'readinessBlockers', 'suppressions', 'scorer', 'scoreFloorExclusions',
    'capExclusions', 'selected', 'deliveryCommitStatus', 'reconciliation',
  ]) assert.ok(Object.hasOwn(telemetry.funnel, field), field);
  for (const field of [
    'runId', 'schedule', 'configPath', 'databasePath', 'startedAt', 'endedAt',
    'durationMs', 'deadlineStatus', 'localReportPaths', 'localReportHashes',
    'externalTransactionStatus', 'surfacedStateCommitCount', 'unresolvedReconciliationCount',
  ]) assert.ok(Object.hasOwn(telemetry.operations, field), field);
  assert.equal(assertSuccessfulDcoTelemetry(telemetry), telemetry);

  const broken = structuredClone(telemetry);
  broken.funnel.reconciliation.causes.scoredToSelected = {};
  broken.funnel.reconciliation.ok = false;
  broken.funnel.reconciliation.unresolvedCount = 1;
  assert.throws(() => assertSuccessfulDcoTelemetry(broken), /unattributed funnel loss/);
});
