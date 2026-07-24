import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// A point-in-time export of Applications v4 (Notion) rows, distinct from and
// larger than career-ops/data/opportunity-ledger.tsv (the local run cache
// already wired via priorLifecycleRows). There is no automatic Notion sync
// for the scheduled crawler, so this file is refreshed manually/periodically
// -- see docs/research/ for the refresh procedure. Row shape matches what
// crawler/historical-suppression.mjs expects: { provider, provider_job_id,
// canonical_url, company, title, location, state }.
export const DEFAULT_V4_HISTORY_SNAPSHOT_PATH = path.resolve(MODULE_DIR, '../career-ops/data/v4-history-snapshot.json');

/**
 * Read a V4 history snapshot for historical suppression. Missing file is not
 * an error -- it degrades to no suppression from this source (the same
 * graceful-missing pattern as readOpportunityLedger), never fabricates rows.
 */
export function readV4HistorySnapshot(snapshotPath = DEFAULT_V4_HISTORY_SNAPSHOT_PATH) {
  const resolved = path.resolve(snapshotPath);
  if (!fs.existsSync(resolved)) return { path: resolved, rows: [], missing: true, generatedAt: null };
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`v4 history snapshot is not valid JSON: ${resolved} (${error.message})`);
  }
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.rows) ? payload.rows : null;
  if (!rows) throw new Error(`v4 history snapshot must be an array or { rows: [...] }: ${resolved}`);
  return { path: resolved, rows, missing: false, generatedAt: Array.isArray(payload) ? null : payload?.generatedAt ?? null };
}

export default readV4HistorySnapshot;
