import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHostLimiter,
  decideRobots,
  parseRobotsTxt,
  classifyRetry,
  retryDelay,
  validateResponse,
} from '../../crawler/http-policy.mjs';

test('robots decisions use the most specific matching rule and allow ties', () => {
  const rules = parseRobotsTxt(`User-agent: *\nDisallow: /private\nAllow: /private/public\n\nUser-agent: LaunchpadBot\nDisallow: /jobs\nAllow: /jobs/open`);

  assert.equal(decideRobots('https://example.test/private/public/1', rules, 'LaunchpadBot').allowed, true);
  assert.equal(decideRobots('https://example.test/private/file', rules, 'LaunchpadBot').allowed, false);
  assert.equal(decideRobots('https://example.test/jobs/closed', rules, 'LaunchpadBot').allowed, false);
  assert.equal(decideRobots('https://example.test/jobs/open/1', rules, 'LaunchpadBot').allowed, true);
});

test('host limiter enforces concurrency and spacing with an injected clock', async () => {
  let now = 0;
  let active = 0;
  let peak = 0;
  const starts = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const limiter = createHostLimiter({
    minSpacingMs: 100,
    maxConcurrency: 2,
    clock: { now: () => now, sleep: async (ms) => { now += ms; } },
  });

  const work = (id) => limiter.run('example.test', async () => {
    active += 1; peak = Math.max(peak, active); starts.push([id, now]);
    if (starts.length < 3) { if (starts.length === 2) release(); await gate; }
    active -= 1;
    return id;
  });
  assert.deepEqual(await Promise.all([work('a'), work('b'), work('c')]), ['a', 'b', 'c']);
  assert.equal(peak, 2);
  assert.ok(starts[2][1] - starts[0][1] >= 100);
});

test('retry classification and bounded jitter are deterministic', () => {
  assert.equal(classifyRetry({ response: { status: 429 } }).kind, 'retryable');
  assert.equal(classifyRetry({ response: { status: 404 } }).kind, 'terminal');
  assert.equal(classifyRetry({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }).kind, 'retryable');
  assert.equal(classifyRetry({ response: { status: 200 } }).kind, 'success');
  assert.equal(retryDelay(3, { baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0.25, rng: () => 1 }), 500);
  assert.equal(retryDelay(10, { baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0, rng: () => 0 }), 500);
});

test('response limits reject oversized and invalid responses', () => {
  assert.deepEqual(validateResponse({ status: 200, headers: { 'content-length': '12' } }, { maxBytes: 10 }), { ok: false, kind: 'terminal', reason: 'response-too-large' });
  assert.deepEqual(validateResponse({ status: 503, headers: {} }), { ok: false, kind: 'retryable', reason: 'http-status' });
  assert.deepEqual(validateResponse({ status: 200, headers: {} }), { ok: true, kind: 'success' });
});
