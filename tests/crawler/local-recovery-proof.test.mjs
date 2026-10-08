import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, proofPass, runRecoveryProof } from '../../crawler/local-recovery-proof.mjs';

function proofConfig(workDir) {
  return {
    schemaVersion: 'LaunchpadCrawlerConfigV1',
    databasePath: path.join(workDir, 'ignored.sqlite'),
    opportunityLedgerPath: path.join(workDir, 'ignored.tsv'),
    boardRegistry: {
      schemaVersion: 'LaunchpadBoardRegistryV1',
      updatedAt: '2026-08-21T00:00:00.000Z',
      boards: [{
        id: 'greenhouse:fixture', provider: 'greenhouse', slug: 'fixture', company: 'Fixture',
        scheduleLane: 'atsWarm', enabled: true, activationState: 'enabled', sourceTier: 'daily-core',
      }],
    },
    sourcePlanner: { enabled: true, legacyPlannerRollback: false, maxBoards: 1, priorityShare: 1, explorationShare: 0, targetTitles: ['AI Engineer'] },
    sources: { atsWarm: { boards: [], maxBoards: 1, maxJobsPerBoard: 10 }, atsBatch1: { boards: [] }, atsBatch2: { boards: [] }, enterprise: { boards: [] } },
    execution: { wholeRunDeadlineMs: 1_000, discoveryBudgetMs: 600, downstreamReserveMs: 200, handoffReserveMs: 100, scorerFloorMs: 100 },
  };
}

test('local recovery proof passes with three fake-transport exercises and fixture resume drill', async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'launchpad-proof-test-'));
  try {
    const evidence = await runRecoveryProof({
      workDir,
      configOverride: proofConfig(workDir),
      transport: async () => ({ status: 200, headers: {}, body: JSON.stringify({ jobs: [] }) }),
    });
    assert.equal(evidence.pass, true);
    assert.equal(evidence.evidence.length, 3);
    assert.ok(evidence.evidence.every((run) => ['completed', 'partial', 'failed'].includes(run.status)));
    assert.equal(evidence.resumeDrill.fixtureOnly, true);
    assert.equal(evidence.resumeDrill.firstStatus, 'partial');
    assert.equal(evidence.resumeDrill.secondStatus, 'completed');
    assert.equal(evidence.resumeDrill.sameRunId, true);
    assert.equal(evidence.resumeDrill.durableObservationCount, 2);
    assert.equal(evidence.resumeDrill.durableDuplicateCount, 0);
    assert.equal(evidence.resumeDrill.durableNoDuplicateProof, true);
    assert.equal(evidence.resumeDrill.sourceAttemptHistoryShowsResume, true);
    assert.equal(evidence.resumeDrill.partialWritesPlanned, false);
    assert.equal(evidence.resumeDrill.partialPlannedV5OperationCount, 0);
    assert.equal(evidence.resumeDrill.partialLedgerAbsent, true);
    assert.equal(evidence.resumeDrill.partialSurfacingAbsent, true);
    assert.equal(evidence.resumeDrill.partialCanaryAbsent, true);
    assert.equal(evidence.resumeDrill.partialNotificationAbsent, true);
    assert.equal(evidence.resumeDrill.firstRequestPostCancel, 0);
    assert.equal(evidence.resumeDrill.partialProhibitedOperationCount, 0);
    assert.equal(evidence.evidence.every((run) => run.requestCounts.postCancel === 0), true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('local recovery proof fails closed on malformed args and invariant violations', () => {
  assert.throws(() => parseArgs([]), /--out is required/);
  assert.throws(() => parseArgs(['--out', '/tmp/evidence.json']), /--work-dir is required/);
  assert.throws(() => parseArgs(['--out', '/tmp/evidence.json', '--work-dir', '/tmp', '--unknown']), /unsupported argument/);
  const valid = {
    schemaVersion: 'LaunchpadLocalRecoveryProofV1',
    evidence: [
      { status: 'completed', durationMs: 1, requestCounts: { postCancel: 0 } },
      { status: 'partial', durationMs: 2, requestCounts: { postCancel: 0 } },
      { status: 'failed', durationMs: 3, requestCounts: { postCancel: 0 } },
    ],
    sideEffectCounters: { gatewayExecuted: 0 },
    resumeDrill: {
      pass: true,
      sameRunId: true,
      durableNoDuplicateProof: true,
      durableObservationCount: 2,
      durableDuplicateCount: 0,
      sourceAttemptHistoryShowsResume: true,
      firstStatus: 'partial',
      secondStatus: 'completed',
      partialWritesPlanned: false,
      partialPlannedV5OperationCount: 0,
      partialLedgerAbsent: true,
      partialSurfacingAbsent: true,
      partialCanaryAbsent: true,
      partialNotificationAbsent: true,
      firstRequestCounts: { postCancel: 0 },
      firstRequestPostCancel: 0,
      partialProhibitedOperationCount: 0,
    },
  };
  assert.equal(proofPass(valid), true);
  assert.equal(proofPass({ ...valid, evidence: valid.evidence.map((run) => ({ ...run, requestCounts: { postCancel: 1 } })) }), false);
  assert.equal(proofPass({ ...valid, resumeDrill: { pass: false } }), false);
});
