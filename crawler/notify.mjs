import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const NOTIFICATION_RECEIPT_SCHEMA = 'LaunchpadNotificationReceiptV1';
export const DEFAULT_NOTIFICATION_LOG = 'logs/notification-receipts.jsonl';

/**
 * Best-effort local desktop notification. Never throws — a notification
 * failure (non-macOS host, missing osascript, sandboxed environment) must
 * never fail or alter the exit code of the run it's reporting on.
 */
export function notifyDesktop({ title, message, spawn = spawnSync } = {}) {
  if (!message) return { sent: false, reason: 'empty-message' };
  try {
    const script = `display notification ${JSON.stringify(String(message))} with title ${JSON.stringify(String(title ?? 'Launchpad'))}`;
    const result = spawn('osascript', ['-e', script], { timeout: 5000 });
    if (result.error || result.status !== 0) return { sent: false, reason: result.error?.message ?? `exit ${result.status}` };
    return { sent: true, reason: null };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
}

/**
 * Notify every terminal daily outcome with run identity. Best-effort: never
 * throws, never changes the run exit code.
 */
export function notifyRunOutcome({
  runId,
  status,
  outcome,
  schedule,
  mode,
  locationPreset,
  freshCount = 0,
  error,
  notify = notifyDesktop,
  now = () => new Date(),
} = {}) {
  const terminalStatus = status ?? outcome?.status ?? null;
  const fatal = outcome?.fatal === true || terminalStatus === 'fatal';
  const degraded = outcome?.degraded === true || (!fatal && terminalStatus != null && terminalStatus !== 'ok');
  const identity = [runId || 'unknown-run', schedule, mode, locationPreset].filter(Boolean).join(' · ');
  const title = fatal ? 'Launchpad — run failed' : 'Launchpad — daily run';
  const message = fatal
    ? `${identity} failed: ${error ?? 'see logs'}`
    : `${identity}: ${freshCount} fresh match${freshCount === 1 ? '' : 'es'}`;
  let iso;
  try {
    const sentAt = typeof now === 'function' ? now() : now;
    const date = sentAt instanceof Date ? sentAt : new Date(sentAt);
    iso = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  } catch {
    iso = new Date().toISOString();
  }
  let delivery;
  try {
    delivery = notify({ title, message }) ?? { sent: true, reason: null };
  } catch (notifyError) {
    delivery = { sent: false, reason: notifyError?.message ?? 'notifier failed' };
  }
  return {
    schemaVersion: NOTIFICATION_RECEIPT_SCHEMA,
    runId: runId ?? null,
    discoveryProfile: {
      schedule: schedule ?? null,
      mode: mode ?? null,
      locationPreset: locationPreset ?? null,
    },
    outcome: {
      status: terminalStatus,
      fatal,
      degraded,
    },
    freshCount: Number.isFinite(Number(freshCount)) ? Number(freshCount) : 0,
    sentAt: iso,
    sent: delivery.sent !== false,
    reason: delivery.reason ?? null,
  };
}

/**
 * Append one safe terminal receipt to a local JSONL log. Never throws.
 */
export function persistNotificationReceipt(
  receipt,
  filePath = DEFAULT_NOTIFICATION_LOG,
  { fsApi = fs, pathApi = path } = {},
) {
  const target = filePath ?? DEFAULT_NOTIFICATION_LOG;
  try {
    fsApi.mkdirSync(pathApi.dirname(target), { recursive: true });
    fsApi.appendFileSync(target, `${JSON.stringify(receipt)}\n`, 'utf8');
    return { persisted: true, path: target, reason: null };
  } catch (error) {
    return { persisted: false, path: target, reason: error?.message ?? 'receipt persistence failed' };
  }
}
