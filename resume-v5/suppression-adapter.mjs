import { markAction, readOpportunityLedger } from '../job-pull/opportunity-ledger.mjs';

export class SuppressionAdapterError extends Error {
  constructor(message, code = 'SUPPRESSION_ERROR') {
    super(message);
    this.name = 'SuppressionAdapterError';
    this.code = code;
  }
}

const LEDGER_STATE_BY_OUTCOME = Object.freeze({
  Applied: 'applied',
  Interviewing: 'interviewing',
  Offer: 'interviewing',
  Rejected: 'rejected',
  Withdrawn: 'rejected',
  'Not Pursuing': 'rejected',
  'Closed/Expired': 'rejected',
});
const LEDGER_STATE_RANK = Object.freeze({ none: 0, contacted: 1, applied: 2, interviewing: 3, rejected: 4 });

/**
 * Additive adapter over the existing opportunity ledger. Reading is always
 * performed first; the adapter never creates ledger rows or overwrites an
 * unrelated action state.
 */
export function createLedgerSuppressionAdapter({ ledgerPath } = {}) {
  if (!ledgerPath) throw new SuppressionAdapterError('ledgerPath is required for the explicit ledger adapter', 'LEDGER_PATH_REQUIRED');
  return {
    async ensureSuppressed(application, { now, outcome = 'Applied' } = {}) {
      const ledger = readOpportunityLedger(ledgerPath);
      const key = application?.dedupKey;
      const url = application?.canonicalUrl ?? application?.originalApplicationUrl ?? application?.jdLink;
      const row = ledger.rows.find((candidate) => (key && candidate.dedup_key === key) || (url && candidate.canonical_url === url));
      if (!row) return { status: 'not-found', key: key ?? null, url: url ?? null };
      const state = LEDGER_STATE_BY_OUTCOME[outcome];
      if (!state) throw new SuppressionAdapterError(`unsupported lifecycle outcome for opportunity ledger: ${outcome}`, 'LEDGER_OUTCOME_INVALID');
      if (row.action_state === state || LEDGER_STATE_RANK[row.action_state] > LEDGER_STATE_RANK[state]) return { status: 'already', row, outcome, ledgerState: row.action_state };
      return { status: 'updated', row: markAction({ key: row.dedup_key, state, path: ledgerPath, now }), outcome, ledgerState: state };
    },
  };
}
