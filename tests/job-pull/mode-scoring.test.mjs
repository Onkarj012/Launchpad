import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeliveryPlan,
  buildDeliveryReconciliation,
  finalizeDeliveryReconciliation,
  nextScoringRetryState,
} from '../../job-pull/mode-scoring.mjs';
import { candidateDedupKey, candidateRequisitionKey } from '../../job-pull/candidate.mjs';

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

const RUN_AT = '2026-10-22T06:00:00.000Z';

// Build one scoring-failed queue row the way scoringQueueRecord emits it, plus a payload field that must never be stored.
function failedRow(providerJobId, reason = 'SCORER_TIMEOUT') {
  return {
    company: 'Acme', title: 'AI Engineer', canonicalUrl: `https://jobs.example.test/${providerJobId}`,
    provider: 'greenhouse', providerJobId, scoringStatus: 'scoring-failed', scoringFailureReason: reason,
    matchScore: null, rationale: 'payload that must not be stored',
  };
}

test('A: a scoring-failed role gets a pending retry record, then terminal after three failed attempts', () => {
  const first = nextScoringRetryState({ prior: null, result: { scoringQueue: [failedRow('acme-1')] }, runAt: RUN_AT });
  assert.equal(first.schemaVersion, 1);
  assert.deepEqual(first.records, [{
    dedupKey: candidateDedupKey(failedRow('acme-1')),
    requisitionKey: candidateRequisitionKey(failedRow('acme-1')),
    identityAliases: ['greenhouse|acme 1'],
    canonicalUrl: 'https://jobs.example.test/acme-1',
    company: 'Acme', title: 'AI Engineer', reason: 'SCORER_TIMEOUT',
    attemptCount: 1, firstFailedAt: RUN_AT, attemptedAt: RUN_AT,
    nextEligibleAt: '2026-10-22T08:00:00.000Z', outcome: 'pending', outcomeReason: 'scoring-failed', carried: false,
  }]);

  const second = nextScoringRetryState({ prior: first, result: { scoringQueue: [failedRow('acme-1')] }, runAt: '2026-10-22T09:00:00.000Z' });
  assert.equal(second.records[0].attemptCount, 2);
  assert.equal(second.records[0].firstFailedAt, RUN_AT);
  assert.equal(second.records[0].nextEligibleAt, '2026-10-22T13:00:00.000Z');

  const third = nextScoringRetryState({ prior: second, result: { scoringQueue: [failedRow('acme-1')] }, runAt: '2026-10-22T18:00:00.000Z' });
  assert.equal(third.records[0].attemptCount, 3);
  assert.equal(third.records[0].outcome, 'terminal');
  assert.equal(third.records[0].outcomeReason, 'scoring-retry-exhausted');
  assert.equal(third.records[0].nextEligibleAt, null);
  assert.doesNotMatch(JSON.stringify(third), /matchScore|componentScores|rationale|"score"/);
});

test('B: absent pending roles wait or go stale, gate-stopped roles end terminal, and requisitions never merge', () => {
  const pending = {
    dedupKey: candidateDedupKey(failedRow('acme-1')), requisitionKey: candidateRequisitionKey(failedRow('acme-1')),
    canonicalUrl: 'https://jobs.example.test/acme-1', company: 'Acme', title: 'AI Engineer', reason: 'SCORER_TIMEOUT',
    attemptCount: 1, firstFailedAt: '2026-10-21T06:00:00.000Z', attemptedAt: '2026-10-21T06:00:00.000Z',
    nextEligibleAt: '2026-10-21T08:00:00.000Z', outcome: 'pending', outcomeReason: 'scoring-failed', carried: false,
  };
  const prior = (record) => ({ schemaVersion: 1, records: [record] });

  const absent = nextScoringRetryState({ prior: prior(pending), result: {}, runAt: RUN_AT });
  assert.deepEqual(absent.records[0], { ...pending, outcomeReason: 'awaiting-current-evidence' });

  const stale = nextScoringRetryState({ prior: prior({ ...pending, firstFailedAt: '2026-10-14T05:59:00.000Z' }), result: {}, runAt: RUN_AT });
  assert.equal(stale.records[0].outcome, 'terminal');
  assert.equal(stale.records[0].outcomeReason, 'stale-without-current-evidence');

  const suppressed = nextScoringRetryState({
    prior: prior(pending),
    result: { historicalSuppressions: [{ dedupKey: pending.dedupKey, canonicalUrl: pending.canonicalUrl, code: 'SUPPRESSED_ACTIONED' }] },
    runAt: RUN_AT,
  });
  assert.equal(suppressed.records[0].outcome, 'terminal');
  assert.equal(suppressed.records[0].outcomeReason, 'current-gate-rejected:SUPPRESSED_ACTIONED');

  // Same company, title and URL, different requisition: the prior record must not match it.
  const otherRequisition = { ...failedRow('acme-2'), canonicalUrl: pending.canonicalUrl };
  const separate = nextScoringRetryState({ prior: prior(pending), result: { scoringQueue: [otherRequisition] }, runAt: RUN_AT });
  const waiting = separate.records.find((record) => record.dedupKey === pending.dedupKey);
  const fresh = separate.records.find((record) => record.dedupKey !== pending.dedupKey);
  assert.equal(waiting.outcomeReason, 'awaiting-current-evidence');
  assert.equal(waiting.attemptCount, 1);
  assert.equal(fresh.attemptCount, 1);
  assert.equal(fresh.firstFailedAt, RUN_AT);
});

test('a role that gains a requisition ID keeps its retry record by canonical URL', () => {
  const unidentified = { company: 'Acme', title: 'AI Engineer', canonicalUrl: 'https://jobs.example.test/acme-1', scoringStatus: 'scoring-failed', scoringFailureReason: 'SCORER_TIMEOUT' };
  const identified = { company: 'Acme', title: 'AI Engineer', canonicalUrl: 'https://jobs.example.test/acme-1', provider: 'greenhouse', providerJobId: 'acme-1' };
  const first = nextScoringRetryState({ prior: null, result: { scoringQueue: [unidentified] }, runAt: RUN_AT });

  const selected = nextScoringRetryState({ prior: first, result: { shortlist: [identified] }, runAt: '2026-10-22T09:00:00.000Z' });
  assert.deepEqual(selected.records.map((record) => [record.outcome, record.attemptCount]), [['selected', 2]]);

  const recovered = nextScoringRetryState({ prior: first, result: { results: [identified] }, runAt: '2026-10-22T09:00:00.000Z' });
  assert.deepEqual(recovered.records.map((record) => record.outcome), ['recovered']);
});

test('a retained identity alias keeps the retry record when the canonical URL changed', () => {
  const old = { company: 'Acme', title: 'AI Engineer', canonicalUrl: 'https://jobs.example.test/old', identityAliases: ['greenhouse|acme-1'], scoringStatus: 'scoring-failed', scoringFailureReason: 'SCORER_TIMEOUT' };
  const moved = { company: 'Acme', title: 'AI Engineer', canonicalUrl: 'https://jobs.example.test/new', provider: 'greenhouse', providerJobId: 'acme-1' };
  const first = nextScoringRetryState({ prior: null, result: { scoringQueue: [old] }, runAt: RUN_AT });

  const second = nextScoringRetryState({ prior: first, result: { shortlist: [moved] }, runAt: '2026-10-22T09:00:00.000Z' });
  assert.deepEqual(second.records.map((record) => [record.outcome, record.attemptCount]), [['selected', 2]]);
});

test('two requisitions of one provider that share a URL alias never merge', () => {
  const sharedUrl = 'https://jobs.example.test/shared';
  const sharedAliases = [`url|${sharedUrl}`];
  const first = nextScoringRetryState({
    prior: null,
    result: { scoringQueue: [{ ...failedRow('req-1'), canonicalUrl: sharedUrl, identityAliases: sharedAliases }] },
    runAt: RUN_AT,
  });
  const second = nextScoringRetryState({
    prior: first,
    result: { scoringQueue: [{ ...failedRow('req-2'), canonicalUrl: sharedUrl, identityAliases: sharedAliases }] },
    runAt: '2026-10-22T07:00:00.000Z',
  });
  assert.deepEqual(second.records.map((record) => [record.attemptCount, record.outcomeReason]).sort(), [[1, 'awaiting-current-evidence'], [1, 'scoring-failed']]);
});

test('a settled record is shown once in a later run with a previous-run reason, then dropped', () => {
  const settled = (id, outcome, outcomeReason) => ({
    dedupKey: `greenhouse|${id}`, requisitionKey: `greenhouse|${id}`, identityAliases: [`greenhouse|${id}`],
    canonicalUrl: `https://jobs.example.test/${id}`, company: 'Acme', title: 'AI Engineer', reason: 'SCORER_TIMEOUT',
    attemptCount: 2, firstFailedAt: '2026-10-21T06:00:00.000Z', attemptedAt: '2026-10-21T09:00:00.000Z',
    nextEligibleAt: null, outcome, outcomeReason, carried: false,
  });
  const prior = { schemaVersion: 1, records: [settled('acme-1', 'selected', 'shortlisted-this-run'), settled('acme-2', 'recovered', 'scored-this-run')] };

  const carried = nextScoringRetryState({ prior, result: {}, runAt: RUN_AT });
  assert.deepEqual(carried.records.map((record) => [record.outcomeReason, record.carried]), [['shortlisted-previous-run', true], ['scored-previous-run', true]]);

  const dropped = nextScoringRetryState({ prior: carried, result: {}, runAt: '2026-10-23T06:00:00.000Z' });
  assert.deepEqual(dropped.records, []);
});
