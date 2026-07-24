import fs from 'node:fs';
import path from 'node:path';
import { openCrawlerStore } from './run.mjs';
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

function toRunSummary(row) {
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
    if (exists) db = openCrawlerStore(resolved);
    for (const schedule of SCHEDULES) {
      const lastRunRow = db
        ? db.prepare('SELECT * FROM crawl_runs WHERE schedule = ? ORDER BY started_at DESC LIMIT 1').get(schedule)
        : null;
      const lastSuccessfulRow = db
        ? db.prepare("SELECT * FROM crawl_runs WHERE schedule = ? AND status IN ('completed','completed_with_failures') ORDER BY started_at DESC LIMIT 1").get(schedule)
        : null;
      const lastRun = toRunSummary(lastRunRow);
      const lastSuccessfulRun = toRunSummary(lastSuccessfulRow);
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
        counts: countsFor(lastRun),
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
