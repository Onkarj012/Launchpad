import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class CrawlerRunLockError extends Error {
  constructor(message, code = 'CRAWLER_RUN_LOCK_HELD') {
    super(message);
    this.name = 'CrawlerRunLockError';
    this.code = code;
  }
}

export function acquireCrawlerRunLock(lockPath = '.local/launchpad-crawler/daily.lock') {
  const resolved = path.resolve(lockPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  let fd;
  try {
    fd = openSync(resolved, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), lockPath: resolved })}\n`);
  } catch (error) {
    if (fd != null) try { closeSync(fd); } catch {}
    if (error?.code === 'EEXIST') throw new CrawlerRunLockError(`crawler run lock already held: ${resolved}`);
    throw error;
  }
  let released = false;
  return {
    path: resolved,
    release() {
      if (released) return;
      released = true;
      try { closeSync(fd); } catch {}
      try { unlinkSync(resolved); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
}

export default acquireCrawlerRunLock;
