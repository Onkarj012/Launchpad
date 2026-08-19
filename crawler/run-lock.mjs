import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
  const openLock = () => {
    let fd;
    try {
      fd = openSync(resolved, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), lockPath: resolved })}\n`);
      return fd;
    } catch (error) {
      if (fd != null) try { closeSync(fd); } catch {}
      throw error;
    }
  };
  const heldError = () => new CrawlerRunLockError(`crawler run lock already held: ${resolved}`);
  let fd;
  try {
    fd = openLock();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let pid;
    try {
      const existing = JSON.parse(readFileSync(resolved, 'utf8'));
      pid = existing?.pid;
    } catch {}
    let alive = false;
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (killError) {
        alive = killError?.code === 'EPERM';
      }
    }
    if (alive) throw heldError();
    try { unlinkSync(resolved); } catch (unlinkError) {
      if (unlinkError?.code !== 'ENOENT') throw unlinkError;
    }
    try {
      fd = openLock();
    } catch (retryError) {
      if (retryError?.code === 'EEXIST') throw heldError();
      throw retryError;
    }
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
