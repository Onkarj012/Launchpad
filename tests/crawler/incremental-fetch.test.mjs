import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalUrl,
  contentFingerprint,
  conditionalHeaders,
  evaluateIncrementalResponse,
  fetchIncrementally,
} from '../../crawler/incremental-fetch.mjs';

test('canonical URL and fingerprints are stable', () => {
  assert.equal(canonicalUrl('HTTPS://Example.test:443/jobs/1#apply'), 'https://example.test/jobs/1');
  assert.equal(contentFingerprint('same content'), contentFingerprint('same content'));
  assert.notEqual(contentFingerprint('same content'), contentFingerprint('changed content'));
});

test('conditional headers use validators and sitemap metadata', () => {
  assert.deepEqual(conditionalHeaders({ etag: '"abc"', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT', sitemapLastmod: '2025-01-02' }), {
    'if-none-match': '"abc"',
    'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT',
    'x-sitemap-lastmod': '2025-01-02',
  });
});

test('incremental evaluation distinguishes 304, unchanged, and changed', async () => {
  const prior = { canonicalUrl: 'https://example.test/jobs/1', fingerprint: contentFingerprint('body'), etag: '"v1"' };
  assert.equal((await evaluateIncrementalResponse({ status: 304, headers: {} }, prior)).classification, 'not-modified');
  assert.equal((await evaluateIncrementalResponse({ status: 200, headers: {}, text: async () => 'body' }, prior)).classification, 'unchanged');
  assert.equal((await evaluateIncrementalResponse({ status: 200, headers: {}, text: async () => 'new body' }, prior)).classification, 'changed');
});

test('injected transport receives conditional headers and retries deterministically', async () => {
  const requests = [];
  let now = 0;
  const result = await fetchIncrementally({
    url: 'https://example.test/jobs/1',
    state: { etag: '"v1"', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' },
    transport: async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) return { status: 503, headers: {} };
      return { status: 304, headers: {} };
    },
    retry: { maxAttempts: 2, baseDelayMs: 50, jitterRatio: 0, rng: () => 0 },
    hostLimiterOptions: { minSpacingMs: 0 },
    clock: { now: () => now, sleep: async (ms) => { now += ms; } },
  });
  assert.equal(result.classification, 'not-modified');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers['if-none-match'], '"v1"');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(requests[0].options.timeoutMs, 30_000);
  assert.equal(requests[0].options.maxBytes, 2_000_000);
  assert.equal(requests[0].options.maxRedirects, 0);
  assert.equal(requests[0].options.maxHosts, 1);
  assert.equal(requests[0].options.maxRequests, 1);
  assert.equal(now, 50);
});

test('injected timer enforces a terminal request timeout without network access', async () => {
  let calls = 0;
  const result = await fetchIncrementally({
    url: 'https://example.test/slow',
    transport: async () => { calls += 1; return new Promise(() => {}); },
    retry: { maxAttempts: 1 },
    timeoutMs: 25,
    clock: { setTimeout: (callback) => { callback(); return 1; }, clearTimeout() {} },
  });
  assert.equal(calls, 1);
  assert.equal(result.classification, 'terminal');
  assert.equal(result.reason, 'request timed out');
});
