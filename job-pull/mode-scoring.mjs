import { integerInRange, mergeScoreRow } from './match-scorer.mjs';

export const BROKEN_SCORER_REASON_CODES = new Set([
  'SCORER_BINARY_MISSING', 'SCORER_BINARY_NOT_ABSOLUTE', 'SCORER_AUTH_FAILED',
  'SCORER_SPAWN_FAILED', 'SCORER_EXEC_FAILED', 'SCORER_OUTPUT_INVALID', 'SCORER_CARDINALITY_MISMATCH',
  'SCORER_URL_MISMATCH', 'SCORER_TIMEOUT', 'SCORER_DEADLINE_EXCEEDED', 'SCORER_ABORTED',
]);

// Reuse the selection boundary when deciding whether scoring may be skipped.
export function hasUsableMatchScore(candidate) {
  return scoreState(candidate).status === 'scored';
}

// Validate cached model results and explicitly supplied scores before selection.
export function scoreState(entry) {
  const candidate = entry.candidate || entry;
  const raw = candidate.matchScore ?? candidate.score ?? entry.matchScore;
  if (candidate.scoringFailed === true || candidate.scoringStatus === 'scoring-failed') return { status: 'scoring-failed', score: null };
  if (raw == null || raw === '' || (typeof raw === 'string' && !raw.trim())) return { status: 'unscored', score: null };
  const score = integerInRange(raw, 0, 100);
  if (score === null) return { status: 'scoring-failed', score: null };
  // Normalized source rows are discovery data, never verified scoring output.
  if (!['explicit-scored-input', 'model-output'].includes(candidate.scoreOrigin)) return { status: 'unscored', score: null };
  const merged = mergeScoreRow(candidate, { ...candidate, matchScore: score }, { requireComponents: candidate.scoreOrigin === 'model-output' });
  return merged.failure ? { status: 'scoring-failed', score: null } : { status: 'scored', score: merged.candidate.matchScore };

}

export function scoringQueueRecord(entry) {
  const state = scoreState(entry);
  return {
    ...entry.candidate,
    scoringStatus: state.status,
    scoringQueueReason: state.status === 'scoring-failed' ? 'INVALID_MATCH_SCORE' : 'MATCH_SCORE_REQUIRED',
    ...(state.status === 'scoring-failed' && (entry.candidate.scoringError || entry.candidate.scoringFailureReason)
      ? { scoringFailureReason: entry.candidate.scoringError || entry.candidate.scoringFailureReason }
      : {}),
    autoSuggest: false,
  };
}

export function splitScoredEntries(entries) {
  const scored = entries.filter((entry) => scoreState(entry).status === 'scored');
  const scoringQueue = entries.filter((entry) => scoreState(entry).status !== 'scored');
  return {
    scored,
    scoringQueue,
    scoredCount: scored.length,
    unscoredCount: scoringQueue.filter((entry) => scoreState(entry).status === 'unscored').length,
    scoringFailedCount: scoringQueue.filter((entry) => scoreState(entry).status === 'scoring-failed').length,
  };
}

function parentScoringError(reasonCode) {
  const error = new Error(`scoring stopped by parent budget: ${reasonCode}`);
  error.reasonCode = reasonCode;
  return error;
}

async function awaitParentScoringBudget(promise, signal, remainingMs) {
  const budget = remainingMs != null && Number.isFinite(Number(remainingMs)) ? Math.max(0, Number(remainingMs)) : Infinity;
  if (!signal?.aborted && !Number.isFinite(budget)) return promise;
  let timer;
  let abortHandler;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        if (Number.isFinite(budget)) timer = setTimeout(() => reject(parentScoringError('SCORER_DEADLINE_EXCEEDED')), budget);
        abortHandler = () => reject(parentScoringError('SCORER_ABORTED'));
        if (signal?.aborted) abortHandler();
        else signal?.addEventListener?.('abort', abortHandler, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortHandler);
  }
}

export async function scorePoolInRun(candidates, scorer, { runId = null, runAt = null, signal = null, remainingMs = null } = {}) {
  if (typeof scorer !== 'function') return { pool: candidates, telemetry: null };
  const unscored = candidates.filter((candidate) => !hasUsableMatchScore(candidate));
  if (!unscored.length) return { pool: candidates, telemetry: { attempted: 0, chunks: 0, failures: [], degraded: false, reasonCode: null } };
  let scoring;
  try {
    scoring = await awaitParentScoringBudget(scorer(unscored, { runId, runAt, signal, remainingMs }), signal, remainingMs);
  } catch (error) {
    return {
      pool: candidates.map((candidate) => unscored.includes(candidate) ? { ...candidate, matchScore: null, score: null, autoSuggest: false, scoringFailed: true, scoringFailureReason: error.reasonCode || error.code || 'SCORER_EXEC_FAILED' } : candidate),
      telemetry: {
        attempted: unscored.length,
        chunks: 0,
        failures: unscored.map((candidate) => ({ canonicalUrl: candidate.canonicalUrl, reason: error.reasonCode || error.code || 'SCORER_EXEC_FAILED' })),
        degraded: true,
        reasonCode: error.reasonCode || error.code || 'SCORER_EXEC_FAILED',
        error: error.message || String(error),
      },
    };
  }
  const merged = new Map((Array.isArray(scoring?.scored) ? scoring.scored : [])
    .filter((candidate) => candidate?.canonicalUrl)
    .map((candidate) => [candidate.canonicalUrl, candidate]));
  const failures = new Map((Array.isArray(scoring?.failures) ? scoring.failures : [])
    .filter((failure) => failure?.canonicalUrl)
    .map((failure) => [failure.canonicalUrl, failure]));
  const validationFailures = [];
  const returnedCounts = new Map();
  for (const row of Array.isArray(scoring?.scored) ? scoring.scored : []) returnedCounts.set(row.canonicalUrl, (returnedCounts.get(row.canonicalUrl) || 0) + 1);
  const pool = candidates.map((candidate) => {
      if (!unscored.includes(candidate)) return candidate;
      const returned = merged.get(candidate.canonicalUrl);
      const failure = returnedCounts.get(candidate.canonicalUrl) > 1
        ? { reason: 'SCORER_URL_MISMATCH' } : failures.get(candidate.canonicalUrl);
      if (returnedCounts.get(candidate.canonicalUrl) > 1) validationFailures.push({ canonicalUrl: candidate.canonicalUrl, reason: 'SCORER_URL_MISMATCH' });
      if (failure || !returned) {
        if (!failure) validationFailures.push({ canonicalUrl: candidate.canonicalUrl, reason: 'SCORER_ROW_MISSING' });
        return { ...candidate, matchScore: null, score: null, autoSuggest: false,
          scoringFailed: true, scoringFailureReason: failure?.reason || 'SCORER_ROW_MISSING' };
      }
      const checked = mergeScoreRow(candidate, returned, { requireComponents: true });
      if (checked.failure) validationFailures.push({ canonicalUrl: candidate.canonicalUrl, reason: checked.failure.reason });
      return { ...candidate, ...checked.candidate };
    });
  return {
    pool,
    telemetry: {
      attempted: unscored.length,
      chunks: Number.isFinite(Number(scoring?.chunks)) ? Number(scoring.chunks) : 0,
      failures: [...(Array.isArray(scoring?.failures) ? scoring.failures : []), ...validationFailures],
      degraded: scoring?.degraded === true,
      reasonCode: scoring?.reasonCode ?? null,
    },
  };
}

export function scorerIsBroken(telemetry) {
  const failures = Array.isArray(telemetry?.failures) ? telemetry.failures : [];
  if (telemetry?.degraded === true && BROKEN_SCORER_REASON_CODES.has(telemetry.reasonCode)) return true;
  return telemetry?.attempted > 0 && failures.length / telemetry.attempted > 0.5;
}

export function scoringGateError(ErrorClass, selection, scorerTelemetry = null) {
  const causes = selection.scoringQueue.map((candidate) => {
    const reason = candidate.scoringFailureReason || candidate.scoringQueueReason;
    return `${candidate.company} — ${candidate.title}: ${reason}`;
  });
  const failures = Array.isArray(scorerTelemetry?.failures) ? scorerTelemetry.failures : [];
  const scorerCause = scorerTelemetry
    ? `; scorer broken: reason-code=${scorerTelemetry.reasonCode ?? 'none'}, degraded=${scorerTelemetry.degraded}, attempted=${scorerTelemetry.attempted}, failed=${failures.length}`
    : '';
  return new ErrorClass(
    `complete scoring required before selection: unscored=${selection.unscoredCount}, scoring-failed=${selection.scoringFailedCount}${scorerCause}${causes.length ? `; ${causes.join('; ')}` : ''}`,
    'scoring',
  );
}

function reconciliationLine({ fetched, dated, eligible, scored, ready, selected, causes }) {
  const causeText = Object.entries(causes)
    .flatMap(([stage, stageCauses]) => Object.entries(stageCauses).map(([cause, count]) => `${stage}:${cause}=${count}`))
    .join(',');
  return `fetched=${fetched}; dated=${dated}; eligible=${eligible}; scored=${scored}; ready=${ready}; selected=${selected}; causes=${causeText || 'none'}`;
}

export function buildReconciliation({ fetched = 0, dated = 0, eligible = 0, historicalSuppressed = 0, selection, selected, runFailed = false }) {
  const ready = selection.readyCount;
  const scored = selection.scoredCount;
  const fetchedToDated = Math.max(0, fetched - dated);
  const datedToEligible = Math.max(0, dated - eligible);
  const notReady = Math.max(0, eligible - historicalSuppressed - ready);
  const readyNotScored = Math.max(0, ready - scored);
  const selectedGap = Math.max(0, scored - selected);
  const causes = {
    fetchedToDated: {
      UNDATED: fetchedToDated,
    },
    datedToEligible: {
      NOT_ELIGIBLE_OR_FRESHNESS_REJECTED: datedToEligible,
    },
    eligibleToReady: {
      HISTORICAL_SUPPRESSION: historicalSuppressed,
      NOT_APPLICATION_READY: notReady,
    },
    readyToScored: {
      UNSCORED: selection.unscoredCount,
      SCORING_FAILED: selection.scoringFailedCount,
    },
    scoredToSelected: {
      ...(runFailed ? { RUN_FAILED_INCOMPLETE_SCORING: selectedGap } : { SELECTION_RULES: selectedGap }),
    },
  };
  return {
    fetched,
    dated,
    eligible,
    scored,
    ready,
    selected,
    causes,
    deltas: {
      fetchedToDated,
      datedToEligible,
      eligibleToReady: eligible - ready,
      readyToScored: readyNotScored,
      scoredToSelected: selectedGap,
    },
    line: reconciliationLine({ fetched, dated, eligible, scored, ready, selected, causes }),
  };
}

function count(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function emptyDeliveryPlan() {
  return {
    status: 'empty',
    shortlist: [],
    plannedNotionOperations: [],
    opportunitySurfacing: [],
    selectedCount: 0,
    plannedV5OperationCount: 0,
  };
}

/** Selector-owned handoff for all completed delivery side effects. */
export function buildDeliveryPlan({ shortlist = [], plannedNotionOperations = [], completed = true } = {}) {
  if (!completed) return emptyDeliveryPlan();
  return {
    status: 'planned',
    unsupportedStoreFields: ['Auto-Suggest'],
    storeContractWarnings: ['Auto-Suggest retained in shortlist/report only; absent from the declared Applications v5 schema.'],
    shortlist,
    plannedNotionOperations,
    opportunitySurfacing: shortlist,
    selectedCount: shortlist.length,
    plannedV5OperationCount: plannedNotionOperations.length,
  };
}

function deliveryCounts(deliveryPlan, { transaction = null, surfacedCount = null, ledgerRepairedCount = null, canaryCount = null, notificationCount = null } = {}) {
  return {
    selected: count(deliveryPlan?.selectedCount ?? deliveryPlan?.shortlist?.length),
    shortlist: count(deliveryPlan?.shortlist?.length),
    plannedV5Operations: count(deliveryPlan?.plannedV5OperationCount ?? deliveryPlan?.plannedNotionOperations?.length),
    newlyCommitted: transaction == null ? null : count(transaction.newlyCommitted?.length),
    alreadyCommitted: transaction == null ? null : count(transaction.alreadyCommitted?.length),
    failed: transaction == null ? null : count(transaction.failed?.length),
    recoveryBlocked: transaction == null ? null : count(transaction.recovery?.length),
    deliveredKeys: transaction == null ? null : count(transaction.deliveredKeys?.length),
    opportunityLedgerSurfaced: surfacedCount == null ? null : count(surfacedCount),
    opportunityLedgerRepaired: ledgerRepairedCount == null ? null : count(ledgerRepairedCount),
    canaryShortlist: canaryCount == null ? null : count(canaryCount),
    notification: notificationCount == null ? null : count(notificationCount),
  };
}

function deliveryMismatchReasons(counts, { status, transactionStatus = null, canaryStatus = 'not_emitted', notificationStatus = 'not_emitted' } = {}) {
  const reasons = [];
  if (counts.selected !== counts.shortlist) reasons.push('SHORTLIST_SELECTED_COUNT_MISMATCH');
  if (counts.selected !== counts.plannedV5Operations) reasons.push('SHORTLIST_V5_OPERATION_COUNT_MISMATCH');
  if (counts.deliveredKeys != null && counts.selected !== counts.deliveredKeys) reasons.push('SHORTLIST_DELIVERED_KEY_COUNT_MISMATCH');
  if (transactionStatus && ['partial', 'aborted', 'recovery'].includes(transactionStatus)) reasons.push(`TRANSACTION_${transactionStatus.toUpperCase()}`);
  if (counts.failed > 0) reasons.push('TRANSACTION_FAILED_ROWS');
  if (counts.recoveryBlocked > 0) reasons.push('TRANSACTION_RECOVERY_BLOCKED');
  if (counts.opportunityLedgerSurfaced != null && counts.newlyCommitted != null && counts.newlyCommitted !== counts.opportunityLedgerSurfaced) reasons.push('NEW_COMMIT_LEDGER_SURFACED_COUNT_MISMATCH');
  if (status !== 'no-write' && counts.canaryShortlist != null && counts.selected !== counts.canaryShortlist) reasons.push('SHORTLIST_CANARY_COUNT_MISMATCH');
  if (canaryStatus === 'invalid') reasons.push('CANARY_INVALID');
  if (status === 'completed' && notificationStatus === 'not_emitted') reasons.push('NOTIFICATION_RECEIPT_NOT_EMITTED');
  if (notificationStatus === 'failed') reasons.push('NOTIFICATION_FAILED');
  return reasons;
}

export function buildDeliveryReconciliation({
  status = 'pending', deliveryPlan = emptyDeliveryPlan(), sourceCoverage = null,
  rejectionReasons = [], transaction = null, surfacedCount = null, ledgerRepairedCount = null,
  canaryCount = null, canaryStatus = 'not_emitted', notificationCount = 0,
  notificationStatus = 'not_emitted', notificationReceipt = null,
} = {}) {
  const counts = deliveryCounts(deliveryPlan, { transaction, surfacedCount, ledgerRepairedCount, canaryCount, notificationCount });
  const mismatchReasons = deliveryMismatchReasons(counts, { status, transactionStatus: transaction?.status ?? null, canaryStatus, notificationStatus });
  return {
    schemaVersion: 'LaunchpadDeliveryReconciliationV1',
    status,
    counts,
    transaction: transaction == null ? null : {
      status: transaction.status,
      newlyCommitted: counts.newlyCommitted,
      alreadyCommitted: counts.alreadyCommitted,
      failed: counts.failed,
      recoveryBlocked: counts.recoveryBlocked,
      deliveredKeys: counts.deliveredKeys,
    },
    opportunityLedger: {
      status: surfacedCount == null ? 'not_emitted' : 'surfaced',
      count: counts.opportunityLedgerSurfaced,
      repaired: counts.opportunityLedgerRepaired,
    },
    canary: { status: canaryStatus, count: counts.canaryShortlist },
    notification: { status: notificationStatus, count: counts.notification, receipt: notificationReceipt },
    sourceCoverage,
    rejectionReasons: [...new Set(rejectionReasons.filter(Boolean))].sort(),
    mismatchReasons,
    ok: mismatchReasons.length === 0 && (status !== 'completed' || notificationStatus !== 'not_emitted'),
  };
}

export function finalizeDeliveryReconciliation(reconciliation, {
  transaction = undefined, surfacedCount = null, ledgerRepairedCount = null,
  canaryCount = null, canaryStatus = 'not_emitted', notificationReceipt = null,
} = {}) {
  const current = reconciliation || buildDeliveryReconciliation();
  const notificationCount = notificationReceipt == null ? null : 1;
  const notificationStatus = notificationReceipt == null
    ? 'not_emitted'
    : notificationReceipt.sent === true ? 'sent' : 'failed';
  return buildDeliveryReconciliation({
    status: current.status,
    deliveryPlan: {
      selectedCount: current.counts?.selected ?? 0,
      shortlist: Array.from({ length: current.counts?.shortlist ?? 0 }),
      plannedV5OperationCount: current.counts?.plannedV5Operations ?? 0,
    },
    sourceCoverage: current.sourceCoverage ?? null,
    rejectionReasons: current.rejectionReasons ?? [],
    transaction: transaction === undefined && current.transaction
      ? {
        status: current.transaction.status,
        newlyCommitted: Array.from({ length: current.transaction.newlyCommitted ?? 0 }),
        alreadyCommitted: Array.from({ length: current.transaction.alreadyCommitted ?? 0 }),
        failed: Array.from({ length: current.transaction.failed ?? 0 }),
        recovery: Array.from({ length: current.transaction.recoveryBlocked ?? 0 }),
        deliveredKeys: Array.from({ length: current.transaction.deliveredKeys ?? 0 }),
      }
      : transaction,
    surfacedCount: surfacedCount ?? current.counts?.opportunityLedgerSurfaced ?? null,
    ledgerRepairedCount: ledgerRepairedCount ?? current.counts?.opportunityLedgerRepaired ?? null,
    canaryCount,
    canaryStatus,
    notificationCount,
    notificationStatus,
    notificationReceipt,
  });
}

export function sourceCoverageFromManifests(manifests = []) {
  const coverage = { completed: [], interrupted: [], failed: [], not_started: [] };
  for (const manifest of manifests) {
    const sourceId = manifest?.sourceId;
    if (!sourceId) continue;
    const status = String(manifest.status ?? '').toLowerCase();
    const group = ['succeeded', 'ok', 'empty', 'degraded', 'truncated'].includes(status)
      ? 'completed'
      : status === 'interrupted' ? 'interrupted'
        : ['failed', 'unavailable'].includes(status) ? 'failed' : 'not_started';
    coverage[group].push(sourceId);
  }
  for (const values of Object.values(coverage)) values.sort();
  return coverage;
}

export function selectionRejectionReasons({ pipeline, selection, eligible = 0, selected = 0 } = {}) {
  const reasons = [
    ...Object.keys(pipeline?.funnel?.firstFailureCodes ?? {}),
    ...Object.keys(pipeline?.selection?.exclusions ?? {}),
    ...Object.keys(pipeline?.exclusionAudit?.selection ?? {}),
    ...((pipeline?.exclusionAudit?.gate ?? []).map((item) => item.code)),
  ];
  if (eligible > 0 && selected === 0) {
    if (selection?.unscoredCount || selection?.scoringFailedCount) reasons.push('SCORING_REQUIRED_BEFORE_SELECTION');
    else if (selection?.readyCount === 0) reasons.push('NO_APPLICATION_READY_ROLES');
    else reasons.push('SELECTION_RULES_NO_SELECTED_ROLES');
  }
  if (eligible === 0 && reasons.length === 0) reasons.push('NO_ELIGIBLE_INVENTORY');
  return [...new Set(reasons.filter(Boolean))].sort();
}

export function partialSourceReasons(manifests = []) {
  const coverage = sourceCoverageFromManifests(manifests);
  return [
    ...coverage.interrupted.map((sourceId) => `SOURCE_INTERRUPTED:${sourceId}`),
    ...coverage.failed.map((sourceId) => `SOURCE_FAILED:${sourceId}`),
    ...coverage.not_started.map((sourceId) => `SOURCE_NOT_STARTED:${sourceId}`),
  ];
}
