import { spawnSync } from 'node:child_process';

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
  schedule,
  mode,
  locationPreset,
  freshCount = 0,
  error,
  notify = notifyDesktop,
  now = () => new Date(),
} = {}) {
  const sentAt = (typeof now === 'function' ? now() : now);
  const iso = sentAt instanceof Date ? sentAt.toISOString() : String(sentAt);
  const identity = [runId || 'unknown-run', schedule, mode, locationPreset].filter(Boolean).join(' · ');
  const fatal = status === 'fatal';
  const title = fatal ? 'Launchpad — run failed' : 'Launchpad — daily run';
  const message = fatal
    ? `${identity} failed: ${error ?? 'see logs'}`
    : `${identity}: ${freshCount} fresh match${freshCount === 1 ? '' : 'es'}`;
  const delivery = notify({ title, message }) ?? { sent: true, reason: null };
  return {
    runId: runId ?? null,
    status: status ?? null,
    schedule: schedule ?? null,
    mode: mode ?? null,
    locationPreset: locationPreset ?? null,
    sentAt: iso,
    sent: delivery.sent !== false,
    reason: delivery.reason ?? null,
  };
}
