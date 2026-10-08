import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { classifyScheduleRun } from './scheduler.mjs';

const SCHEDULES = ['morning', 'midday'];
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function durationMs(row) {
  if (!row?.started_at || !row?.finished_at) return null;
  const start = Date.parse(row.started_at);
  const end = Date.parse(row.finished_at);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function nullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceTelemetryFor(db, runId, runTelemetry = {}) {
  if (!runId) return {};
  const persisted = runTelemetry.workflow?.sourceTelemetry ?? runTelemetry.sources ?? {};
  const rows = db?.prepare('SELECT * FROM source_telemetry WHERE run_id = ? ORDER BY source_id').all(runId) ?? [];
  const byId = new Map(rows.map((row) => [row.source_id, row]));
  const sourceIds = new Set([...Object.keys(persisted), ...rows.map((row) => row.source_id)]);
  return Object.fromEntries([...sourceIds].sort().map((sourceId) => {
    const row = byId.get(sourceId);
    const details = parseJson(row?.details_json, {});
    const source = persisted[sourceId] ?? {};
    return [sourceId, {
      status: row?.status ?? source.status ?? 'unknown',
      truncated: Boolean(source.truncated ?? details.truncated),
      capHit: source.capHit ?? details.capHit ?? null,
      recordsNotExamined: source.recordsNotExamined ?? details.recordsNotExamined ?? null,
      durationMs: nullableNumber(runTelemetry.sourceDurations?.[sourceId]),
    }];
  }));
}

function toRunSummary(row, sourceTelemetry = {}) {
  if (!row) return null;
  const counts = parseJson(row.counts_json, {});
  const telemetry = parseJson(row.telemetry_json, {});
  const workflow = telemetry.workflow ?? {};
  return {
    runId: row.run_id,
    schedule: row.schedule,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: durationMs(row),
    error: row.error,
    counts,
    sourceYield: workflow.sourceYield ?? null,
    verificationQueueLength: Array.isArray(workflow.verificationQueue) ? workflow.verificationQueue.length : null,
    sourceTelemetry,
  };
}

function sourceFailureCount(db, runId) {
  if (!db || !runId) return 0;
  return db.prepare('SELECT COUNT(*) AS n FROM source_failures WHERE run_id = ?').get(runId)?.n ?? 0;
}

function countsFor(run) {
  return {
    ready: number(run?.counts?.ready ?? run?.sourceYield?.totals?.applicationReady),
    verification: number(run?.counts?.verification ?? run?.verificationQueueLength),
    rejected: number(run?.counts?.rejected),
  };
}

function healthState(lastRun, now) {
  if (!lastRun) return null;
  if (lastRun.status === 'partial') return 'partial/resumable';
  if (lastRun.status === 'failed') return 'failed';
  if (lastRun.status === 'completed' || lastRun.status === 'completed_with_failures') return 'completed';
  if (lastRun.status === 'running') {
    const started = Date.parse(lastRun.startedAt || '');
    const elapsed = Number.isFinite(started) ? Math.max(0, now.getTime() - started) : 0;
    return elapsed > 20 * 60 * 1000 ? 'stale/abandoned' : 'active';
  }
  return lastRun.status;
}

/**
 * Read-only per-schedule health report built from durable crawler run history
 * (crawler/run.mjs sqlite store) plus crawler/scheduler.mjs's pure run
 * classification. Never installs, schedules, applies, or sends anything.
 */
export function buildScheduleHealthReport({ databasePath, now = new Date() } = {}) {
  const resolved = databasePath ? path.resolve(databasePath) : null;
  const exists = Boolean(resolved) && fs.existsSync(resolved);
  const schedules = {};
  let db = null;
  try {
    if (exists) db = new DatabaseSync(resolved, { readOnly: true });
    for (const schedule of SCHEDULES) {
      const lastRunRow = db
        ? db.prepare('SELECT * FROM crawl_runs WHERE schedule = ? ORDER BY started_at DESC LIMIT 1').get(schedule)
        : null;
      const lastSuccessfulRow = db
        ? db.prepare("SELECT * FROM crawl_runs WHERE schedule = ? AND status IN ('completed','completed_with_failures') ORDER BY started_at DESC LIMIT 1").get(schedule)
        : null;
      const lastRun = toRunSummary(lastRunRow, sourceTelemetryFor(db, lastRunRow?.run_id, parseJson(lastRunRow?.telemetry_json, {})));
      const lastSuccessfulRun = toRunSummary(lastSuccessfulRow, sourceTelemetryFor(db, lastSuccessfulRow?.run_id, parseJson(lastSuccessfulRow?.telemetry_json, {})));
      const classification = classifyScheduleRun({
        schedule,
        now,
        lastRun: lastRun ? { runId: lastRun.runId, status: lastRun.status, startedAt: lastRun.startedAt } : null,
      });
      schedules[schedule] = {
        schedule,
        hasRunHistory: Boolean(lastRun),
        lastRun,
        lastSuccessfulRun,
        durationMs: lastRun?.durationMs ?? null,
        sourceFailures: sourceFailureCount(db, lastRun?.runId),
        sourceTelemetry: lastRun?.sourceTelemetry ?? {},
        counts: countsFor(lastRun),
        health: healthState(lastRun, now instanceof Date ? now : new Date(now)),
        classification,
      };
    }
  } finally {
    db?.close();
  }
  return {
    schemaVersion: 'LaunchpadScheduleHealthReportV1',
    generatedAt: now instanceof Date ? now.toISOString() : String(now),
    databasePath: resolved,
    hasDatabase: exists,
    schedules,
    noAutoApply: true,
    noAutoSend: true,
    noScheduling: true,
  };
}

export default buildScheduleHealthReport;
