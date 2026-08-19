import { markAction, readOpportunityLedger } from '../job-pull/opportunity-ledger.mjs';

export class SuppressionAdapterError extends Error {
  constructor(message, code = 'SUPPRESSION_ERROR') {
    super(message);
    this.name = 'SuppressionAdapterError';
    this.code = code;
  }
}

/**
 * Additive adapter over the existing opportunity ledger. Reading is always
 * performed first; the adapter never creates ledger rows or overwrites an
 * unrelated action state.
 */
export function createLedgerSuppressionAdapter({ ledgerPath } = {}) {
  if (!ledgerPath) throw new SuppressionAdapterError('ledgerPath is required for the explicit ledger adapter', 'LEDGER_PATH_REQUIRED');
  return {
    async ensureSuppressed(application, { now } = {}) {
      const ledger = readOpportunityLedger(ledgerPath);
      const key = application?.dedupKey;
      const url = application?.canonicalUrl ?? application?.originalApplicationUrl ?? application?.jdLink;
      const row = ledger.rows.find((candidate) => (key && candidate.dedup_key === key) || (url && candidate.canonical_url === url));
      if (!row) return { status: 'not-found', key: key ?? null, url: url ?? null };
      if (row.action_state === 'applied') return { status: 'already', row };
      if (row.action_state !== 'none') return { status: 'conflict', row };
      return { status: 'updated', row: markAction({ key: row.dedup_key, state: 'applied', path: ledgerPath, now }) };
    },
  };
}

