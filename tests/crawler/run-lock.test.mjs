import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireCrawlerRunLock, CrawlerRunLockError } from '../../crawler/run-lock.mjs';

test('reclaims a dead-pid lock but rejects a live-pid lock', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-run-lock-'));
  const stalePath = path.join(root, 'stale.lock');
  writeFileSync(stalePath, JSON.stringify({ pid: 99_999_999, startedAt: new Date().toISOString(), lockPath: stalePath }));

  const reclaimed = acquireCrawlerRunLock(stalePath);
  reclaimed.release();

  const livePath = path.join(root, 'live.lock');
  writeFileSync(livePath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), lockPath: livePath }));
  try {
    assert.throws(() => acquireCrawlerRunLock(livePath), (error) => {
      assert.ok(error instanceof CrawlerRunLockError);
      assert.equal(error.code, 'CRAWLER_RUN_LOCK_HELD');
      assert.equal(error.message, `crawler run lock already held: ${path.resolve(livePath)}`);
      return true;
    });
  } finally {
    unlinkSync(livePath);
  }
});
