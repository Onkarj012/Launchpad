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
