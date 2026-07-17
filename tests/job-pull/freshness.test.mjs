import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFreshness } from '../../job-pull/freshness.mjs';

const now = '2026-07-14T12:00:00.000Z';

test('freshness keeps exact 24h primary and exact 72h extended boundaries', () => {
  assert.equal(classifyFreshness('2026-07-13T12:00:00.000Z', { now }).window, 'Primary');
  assert.equal(classifyFreshness('2026-07-13T11:59:59.999Z', { now }).window, 'Extended');
  assert.equal(classifyFreshness('2026-07-11T12:00:00.000Z', { now }).window, 'Extended');
  assert.equal(classifyFreshness('2026-07-11T11:59:59.999Z', { now }).code, 'FRESHNESS_OLDER_THAN_72H');
});

test('undated records are kept as relaxed candidates while future records fail', () => {
  const undated = classifyFreshness(null, { now });
  assert.equal(undated.eligible, true);
  assert.equal(undated.window, 'undated');
  assert.equal(undated.code, 'FRESHNESS_UNDATED_KEPT');
  assert.equal(undated.evidence, 'Not Verified');
  assert.equal(classifyFreshness('2026-07-14T12:00:00.001Z', { now }).code, 'FRESHNESS_FUTURE_POSTED_AT');
});
