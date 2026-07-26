import fs from 'node:fs';
import path from 'node:path';

export class CrawlerRunLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CrawlerRunLockError';
  }
}

export function crawlerRunLockPath(databasePath) {
  if (typeof databasePath !== 'string' || !databasePath.trim()) {
    throw new TypeError('databasePath is required for the crawler run lock');
  }
  return `${path.resolve(databasePath)}.run.lock`;
}

/**
 * Hold an atomic lock for the duration of one crawler run.
 * The wx open is the important part: two processes cannot both acquire it.
 */
export function withCrawlerRunLock(lockPath, callback, metadata = {}) {
  const resolved = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, 'wx');
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, ...metadata })}\n`, 'utf8');
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
      try { fs.unlinkSync(resolved); } catch { /* setup did not create a removable lock */ }
    }
    if (error.code === 'EEXIST') {
      throw new CrawlerRunLockError(`crawler run refused: another run is already active (lock: ${resolved})`);
    }
    throw error;
  }
  fs.closeSync(descriptor);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { fs.unlinkSync(resolved); } catch { /* already released */ }
  };

  try {
    const result = callback();
    if (result && typeof result.then === 'function') return result.finally(release);
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}
