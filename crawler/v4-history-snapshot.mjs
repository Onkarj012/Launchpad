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

export class V4HistorySnapshotError extends Error {
  constructor(message, code, snapshotPath) {
    super(message);
    this.name = 'V4HistorySnapshotError';
    this.code = code;
    this.snapshotPath = snapshotPath;
  }
}

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
 * Read a V4 history snapshot for historical suppression. Missing or malformed
 * files are fatal because silently substituting zero rows disables a production
 * suppression authority. A valid stale snapshot remains usable and visible.
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
    throw new V4HistorySnapshotError(
      `v4 history snapshot does not exist: ${resolved}`,
      'V4_HISTORY_SNAPSHOT_MISSING',
      resolved,
    );
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new V4HistorySnapshotError(
      `v4 history snapshot is not valid JSON: ${resolved} (${error.message})`,
      'V4_HISTORY_SNAPSHOT_MALFORMED',
      resolved,
    );
  }

  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.rows) ? payload.rows : null;
  if (!rows) {
    throw new V4HistorySnapshotError(
      `v4 history snapshot must be an array or { rows: [...] }: ${resolved}`,
      'V4_HISTORY_SNAPSHOT_MALFORMED',
      resolved,
    );
  }
  const invalidRow = rows.findIndex((row) => !row || typeof row !== 'object' || Array.isArray(row));
  if (invalidRow >= 0) {
    throw new V4HistorySnapshotError(
      `v4 history snapshot row ${invalidRow} must be an object: ${resolved}`,
      'V4_HISTORY_SNAPSHOT_MALFORMED',
      resolved,
    );
  }

  const generatedAt = Array.isArray(payload) ? null : payload?.generatedAt ?? null;
  if (generatedAt != null && Number.isNaN(Date.parse(String(generatedAt)))) {
    throw new V4HistorySnapshotError(
      `v4 history snapshot generatedAt must be a valid timestamp: ${resolved}`,
      'V4_HISTORY_SNAPSHOT_MALFORMED',
      resolved,
    );
  }
  if (isStale(generatedAt, maxAgeDays, clockMs)) {
    return snapshotMeta({ path: resolved, rows, generatedAt, status: 'stale' });
  }
  return snapshotMeta({ path: resolved, rows, generatedAt, status: 'loaded' });
}

export default readV4HistorySnapshot;
