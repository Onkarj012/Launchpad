import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoPendingExternalRecovery,
  buildRollbackRecoveryPlan,
  markJobsSurfaced,
  openCrawlerStore,
  persistRunDeliveryReceipt,
  readCrawlerConfigSnapshots,
  startCrawlRun,
} from '../../crawler/run.mjs';

test('rollback state is immutable, surfacing requires a receipt, and pending journals stop', () => {
  const store = openCrawlerStore(':memory:');
  startCrawlRun(store, {
    runId: 'config-run-1',
    config: { sourceFeatureFlags: { safeCareerPageAdapter: false } },
    clock: { now: () => '2026-07-26T00:00:00.000Z' },
  });
  startCrawlRun(store, {
    runId: 'config-run-2',
    config: { sourceFeatureFlags: { safeCareerPageAdapter: true } },
    clock: { now: () => '2026-07-26T01:00:00.000Z' },
  });
  const snapshots = readCrawlerConfigSnapshots(store);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].config.sourceFeatureFlags.safeCareerPageAdapter, false);
  assert.equal(snapshots[1].config.sourceFeatureFlags.safeCareerPageAdapter, true);
  const rollback = buildRollbackRecoveryPlan(store, {
    targetRunId: 'config-run-1',
    disableSourceIds: ['career-sites'],
    externalJournalEntries: [{ id: 'journal-1', status: 'pending' }],
  });
  assert.equal(rollback.configSnapshot.runId, 'config-run-1');
  assert.deepEqual(rollback.sourceLaneActions, [{
    sourceId: 'career-sites',
    action: 'disable-via-config',
  }]);
  assert.deepEqual(rollback.destructiveActions, []);
  assert.deepEqual(rollback.preservedData, ['crawler', 'ledger', 'Notion', 'resume', 'outreach']);
  assert.equal(rollback.pendingExternalJournalEntries[0].id, 'journal-1');

  store.prepare(`INSERT INTO jobs(
    job_key, company, title, location, first_seen_at, last_seen_at,
    lifecycle_state, lifecycle_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'job-1',
    'acme',
    'ai engineer',
    'pune',
    '2026-07-26T00:00:00.000Z',
    '2026-07-26T00:00:00.000Z',
    'application-ready',
    '{"state":"application-ready","applicationReady":true}',
  );
  assert.throws(
    () => markJobsSurfaced(store, ['job-1'], {
      receiptRunId: 'delivery-run',
      requireReceipt: true,
    }),
    /delivery receipt is required/,
  );
  persistRunDeliveryReceipt(store, 'delivery-run', {
    markdownPath: '/tmp/report.md',
    jsonPath: '/tmp/report.json',
    hashes: { markdown: 'a', json: 'b' },
  });
  assert.equal(markJobsSurfaced(store, ['job-1'], {
    receiptRunId: 'delivery-run',
    requireReceipt: true,
  }), 1);

  assert.throws(() => assertNoPendingExternalRecovery([
    { id: 'journal-1', status: 'pending' },
  ]), (error) => (
    error.code === 'EXTERNAL_RECOVERY_REQUIRED'
    && error.entries[0].id === 'journal-1'
  ));
  assert.deepEqual(assertNoPendingExternalRecovery([
    { id: 'journal-2', status: 'committed' },
  ]), []);
  store.close();
});
