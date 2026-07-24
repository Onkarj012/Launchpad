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

/** Default age after which a successfully parsed snapshot is reported as stale. */
export const DEFAULT_V4_SNAPSHOT_MAX_AGE_DAYS = 30;

const MS_PER_DAY = 86_400_000;

function snapshotMeta({ path: resolved, rows, generatedAt, status, error = null }) {
  return {
    path: resolved,
    rows,
    missing: status === 'missing',
    generatedAt,
    status,
    rowCount: rows.length,
    error,
  };
}

function isStale(generatedAt, maxAgeDays, nowMs) {
  if (generatedAt == null || generatedAt === '') return false;
  const parsed = Date.parse(generatedAt);
  if (Number.isNaN(parsed)) return false;
  const ageDays = Number(maxAgeDays);
  if (!Number.isFinite(ageDays) || ageDays < 0) return false;
  return (nowMs - parsed) > ageDays * MS_PER_DAY;
}

/**
 * Read a V4 history snapshot for historical suppression. Missing, stale, or
 * malformed files are not fatal -- they degrade to zero rows from this source
 * (the same graceful-missing pattern as readOpportunityLedger), never fabricate
 * rows, and always surface an explicit status for run telemetry.
 *
 * @param {string} [snapshotPath]
 * @param {{ maxAgeDays?: number, now?: string|number|Date }} [options]
 */
export function readV4HistorySnapshot(snapshotPath = DEFAULT_V4_HISTORY_SNAPSHOT_PATH, options = {}) {
  const resolved = path.resolve(snapshotPath);
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_V4_SNAPSHOT_MAX_AGE_DAYS;
  const nowRaw = options.now;
  const nowMs = nowRaw instanceof Date
    ? nowRaw.getTime()
    : typeof nowRaw === 'number'
      ? nowRaw
      : nowRaw
        ? Date.parse(String(nowRaw))
        : Date.now();
  const clockMs = Number.isFinite(nowMs) ? nowMs : Date.now();

  if (!fs.existsSync(resolved)) {
    return snapshotMeta({ path: resolved, rows: [], generatedAt: null, status: 'missing' });
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    return snapshotMeta({
      path: resolved,
      rows: [],
      generatedAt: null,
      status: 'malformed',
      error: `v4 history snapshot is not valid JSON: ${resolved} (${error.message})`,
    });
  }

  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.rows) ? payload.rows : null;
  if (!rows) {
    return snapshotMeta({
      path: resolved,
      rows: [],
      generatedAt: null,
      status: 'malformed',
      error: `v4 history snapshot must be an array or { rows: [...] }: ${resolved}`,
    });
  }

  const generatedAt = Array.isArray(payload) ? null : payload?.generatedAt ?? null;
  if (isStale(generatedAt, maxAgeDays, clockMs)) {
    return snapshotMeta({ path: resolved, rows, generatedAt, status: 'stale' });
  }
  return snapshotMeta({ path: resolved, rows, generatedAt, status: 'loaded' });
}

export default readV4HistorySnapshot;
