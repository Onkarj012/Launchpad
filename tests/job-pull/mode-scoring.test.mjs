import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeliveryPlan,
  buildDeliveryReconciliation,
  finalizeDeliveryReconciliation,
} from '../../job-pull/mode-scoring.mjs';

function deliveryPlan() {
  return buildDeliveryPlan({
    shortlist: [{ dedupKey: 'workday|req-1' }],
    plannedNotionOperations: [{ dedupKey: 'workday|req-1' }],
  });
}

function transaction(status, overrides = {}) {
  return {
    status,
    newlyCommitted: [],
    alreadyCommitted: [],
    failed: [],
    recovery: [],
    deliveredKeys: [],
    ...overrides,
  };
}

test('aborted and recovery transactions stay incomplete in delivery reconciliation', () => {
  const aborted = buildDeliveryReconciliation({
    status: 'degraded',
    deliveryPlan: deliveryPlan(),
    transaction: transaction('aborted', {
      failed: [{ key: 'workday|req-1' }],
    }),
    surfacedCount: 0,
    ledgerRepairedCount: 0,
    canaryCount: 1,
    canaryStatus: 'invalid',
  });
  assert.ok(aborted.mismatchReasons.includes('TRANSACTION_ABORTED'));
  assert.ok(aborted.mismatchReasons.includes('TRANSACTION_FAILED_ROWS'));
  assert.ok(aborted.mismatchReasons.includes('SHORTLIST_DELIVERED_KEY_COUNT_MISMATCH'));

  const recovery = buildDeliveryReconciliation({
    status: 'degraded',
    deliveryPlan: deliveryPlan(),
    transaction: transaction('recovery', {
      recovery: [{ key: 'workday|req-1', state: 'verified' }],
    }),
    surfacedCount: 0,
    ledgerRepairedCount: 0,
    canaryCount: 1,
    canaryStatus: 'invalid',
  });
  assert.ok(recovery.mismatchReasons.includes('TRANSACTION_RECOVERY'));
  assert.ok(recovery.mismatchReasons.includes('TRANSACTION_RECOVERY_BLOCKED'));
});

test('no-write reconciliation balances a nonempty shortlist without canary or notification side effects', () => {
  const reconciliation = buildDeliveryReconciliation({
    status: 'no-write',
    deliveryPlan: deliveryPlan(),
    surfacedCount: 0,
    ledgerRepairedCount: 0,
    canaryCount: 0,
    canaryStatus: 'not_emitted',
    notificationCount: 0,
    notificationStatus: 'not_emitted',
  });

  assert.equal(reconciliation.ok, true);
  assert.deepEqual(reconciliation.mismatchReasons, []);
  assert.equal(reconciliation.counts.selected, 1);
  assert.equal(reconciliation.counts.shortlist, 1);
  assert.equal(reconciliation.counts.plannedV5Operations, 1);
  assert.equal(reconciliation.counts.opportunityLedgerSurfaced, 0);
  assert.equal(reconciliation.counts.opportunityLedgerRepaired, 0);
  assert.equal(reconciliation.counts.canaryShortlist, 0);
  assert.equal(reconciliation.counts.notification, 0);
});

test('notification finalization preserves transaction and ledger repair counts', () => {
  const current = buildDeliveryReconciliation({
    status: 'completed',
    deliveryPlan: deliveryPlan(),
    transaction: transaction('replayed', {
      alreadyCommitted: ['workday|req-1'],
      deliveredKeys: ['workday|req-1'],
    }),
    surfacedCount: 0,
    ledgerRepairedCount: 1,
    canaryCount: 1,
    canaryStatus: 'valid',
  });
  const finalized = finalizeDeliveryReconciliation(current, {
    canaryCount: 1,
    canaryStatus: 'valid',
    notificationReceipt: { sent: false, reason: 'desktop unavailable' },
  });

  assert.equal(finalized.counts.alreadyCommitted, 1);
  assert.equal(finalized.counts.deliveredKeys, 1);
  assert.equal(finalized.counts.opportunityLedgerSurfaced, 0);
  assert.equal(finalized.counts.opportunityLedgerRepaired, 1);
  assert.ok(finalized.mismatchReasons.includes('NOTIFICATION_FAILED'));
});
