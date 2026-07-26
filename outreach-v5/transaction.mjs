import { runReservedBatch, structuredError } from '../notion-v5/transaction.mjs';

export class OutreachTransactionError extends Error {
  constructor(message, code = 'OUTREACH_TRANSACTION_FAILED', details = null) {
    super(message);
    this.name = 'OutreachTransactionError';
    this.code = code;
    this.details = details;
  }
}

function restoreGatewayReservation(gateway, previous) {
  gateway.activeJournal = previous.journal;
  gateway.activeTransactionKey = previous.key;
}

/**
 * Execute one logical outreach transition through the existing external
 * transaction journal. Completed steps are compensated in reverse order before
 * a failure is exposed, so callers never observe a partially applied transition.
 */
export async function runOutreachTransaction({ gateway, key, target, steps = [] } = {}) {
  if (!gateway) throw new OutreachTransactionError('an injected scoped gateway is required', 'GATEWAY_REQUIRED');
  if (!String(key ?? '').trim()) throw new OutreachTransactionError('transaction key is required', 'TRANSACTION_KEY_REQUIRED');
  if (!steps.length || steps.some((step) => typeof step.apply !== 'function')) throw new OutreachTransactionError('transaction steps are required', 'TRANSACTION_STEPS_REQUIRED');
  const journal = gateway.journal ?? null;
  if (gateway.live && !journal) throw new OutreachTransactionError('live outreach writes require the gateway external transaction journal', 'JOURNAL_REQUIRED');
  const item = Object.freeze({ dedupKey: key, resource: target });
  const transaction = await runReservedBatch({
    items: [item],
    journal,
    reserve: async (items) => ({ reserved: items, committedKeys: [] }),
    write: async () => {
      const previous = { journal: gateway.activeJournal ?? null, key: gateway.activeTransactionKey ?? null };
      gateway.activeJournal = journal;
      gateway.activeTransactionKey = key;
      const completed = [];
      const results = [];
      try {
        for (const step of steps) {
          const result = await step.apply();
          if (step.verify && await step.verify(result) !== true) throw new OutreachTransactionError(`transaction step ${step.name ?? 'unnamed'} could not be verified`, 'STEP_VERIFICATION_FAILED');
          completed.push(step);
          results.push(result);
        }
        return { verified: true, results };
      } catch (error) {
        const rollbackFailures = [];
        for (const step of completed.reverse()) {
          if (typeof step.rollback !== 'function') continue;
          try { await step.rollback(); }
          catch (rollbackError) { rollbackFailures.push({ step: step.name ?? null, error: structuredError(rollbackError) }); }
        }
        if (rollbackFailures.length) throw new OutreachTransactionError('outreach transition failed and compensation was incomplete', 'COMPENSATION_FAILED', { cause: structuredError(error), rollbackFailures });
        throw error;
      } finally {
        restoreGatewayReservation(gateway, previous);
      }
    },
    verify: async (_item, result) => result?.verified === true,
    commit: async (rows) => rows,
    abort: async () => {},
  });
  if (transaction.status !== 'committed' && transaction.status !== 'noop') {
    throw new OutreachTransactionError('outreach transaction did not commit', 'TRANSACTION_ABORTED', transaction);
  }
  if (transaction.status === 'noop' || transaction.skipped.length) return Object.freeze({ status: 'noop', key, results: [] });
  return Object.freeze({ status: 'committed', key, results: transaction.verified[0]?.result?.results ?? [] });
}
