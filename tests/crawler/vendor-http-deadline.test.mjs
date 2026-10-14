import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { fetchJson, fetchText, makeHttpCtx } from '../../vendor/career-ops/providers/_http.mjs';

const URL = 'https://example.test/jobs';
const NOW = 1_800_000_000_000;

// Install a fetch that ignores abort, with deterministic timers and body reads.
function installStalledFetch(t, stage = 'json', delayHeadersMs = 0) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  let requestSignal;
  let bodyStarted = false;
  const stalledBody = () => {
    bodyStarted = true;
    return new Promise(() => {});
  };
  const response = {
    ok: stage !== 'error',
    status: stage === 'error' ? 429 : 200,
    statusText: stage === 'error' ? 'Too Many Requests' : 'OK',
    headers: new Headers({ 'retry-after': '2' }),
    json: stalledBody,
    text: stalledBody,
  };
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    requestSignal = options.signal;
    if (stage === 'headers') return new Promise(() => {});
    if (delayHeadersMs) return new Promise((resolve) => setTimeout(() => resolve(response), delayHeadersMs));
    return Promise.resolve(response);
  });
  return { signal: () => requestSignal, bodyStarted: () => bodyStarted };
}

for (const stage of ['headers', 'json', 'text', 'error']) {
  test(`timeout bounds stalled ${stage} even when abort is ignored`, async (t) => {
    const fake = installStalledFetch(t, stage);
    const request = stage === 'text' ? fetchText : fetchJson;
    const rejected = assert.rejects(request(URL, { timeoutMs: 40 }), { code: 'ETIMEDOUT' });
    await setImmediate();
    assert.equal(fake.bodyStarted(), stage !== 'headers');
    t.mock.timers.tick(39);
    assert.equal(fake.signal().aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(fake.signal().aborted, true);
  });

  test(`parent cancellation bounds stalled ${stage} and preserves its reason`, async (t) => {
    const fake = installStalledFetch(t, stage);
    const parent = new AbortController();
    const reason = Object.assign(new Error('source stopped'), { code: 'SOURCE_MAX_DURATION_EXCEEDED' });
    const request = stage === 'text' ? fetchText : fetchJson;
    const rejected = assert.rejects(request(URL, { signal: parent.signal }), (error) => error === reason);
    await setImmediate();
    parent.abort(reason);
    await rejected;
    assert.equal(fake.signal().reason, reason);
  });
}

for (const [name, deadline] of [
  ['absolute timestamp', NOW + 30],
  ['deadlineMs', { deadlineMs: NOW + 30 }],
  ['remainingMs value', { remainingMs: 30 }],
  ['remainingMs function', { remainingMs: () => 30 }],
]) {
  test(`${name} clamps a longer configured timeout`, async (t) => {
    const fake = installStalledFetch(t);
    const rejected = assert.rejects(fetchJson(URL, { deadline, timeoutMs: 100 }), { code: 'DAILY_DEADLINE_EXCEEDED' });
    await setImmediate();
    t.mock.timers.tick(29);
    assert.equal(fake.signal().aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(fake.signal().aborted, true);
  });
}

test('a shorter configured timeout wins over the parent deadline', async (t) => {
  const fake = installStalledFetch(t);
  const rejected = assert.rejects(fetchJson(URL, { deadline: NOW + 100, timeoutMs: 20 }), { code: 'ETIMEDOUT' });
  await setImmediate();
  t.mock.timers.tick(19);
  assert.equal(fake.signal().aborted, false);
  t.mock.timers.tick(1);
  await rejected;
});

test('headers and body share one timeout without resetting it', async (t) => {
  const fake = installStalledFetch(t, 'json', 25);
  const rejected = assert.rejects(fetchJson(URL, { timeoutMs: 40 }), { code: 'ETIMEDOUT' });
  t.mock.timers.tick(25);
  await setImmediate();
  assert.equal(fake.bodyStarted(), true);
  t.mock.timers.tick(14);
  assert.equal(fake.signal().aborted, false);
  t.mock.timers.tick(1);
  await rejected;
});

test('late headers after cancellation never start a body read', async (t) => {
  const fake = installStalledFetch(t, 'json', 100);
  const rejected = assert.rejects(fetchJson(URL, { timeoutMs: 40 }), { code: 'ETIMEDOUT' });
  t.mock.timers.tick(40);
  await rejected;
  t.mock.timers.tick(60);
  await setImmediate();
  assert.equal(fake.bodyStarted(), false);
});

test('the default timeout bounds a stalled body', async (t) => {
  const fake = installStalledFetch(t);
  const rejected = assert.rejects(fetchJson(URL), { code: 'ETIMEDOUT' });
  await setImmediate();
  t.mock.timers.tick(9_999);
  assert.equal(fake.signal().aborted, false);
  t.mock.timers.tick(1);
  await rejected;
});

test('exhausted budgets and an already aborted caller never start fetch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const fetchMock = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  await assert.rejects(fetchJson(URL, { deadline: NOW }), { code: 'DAILY_DEADLINE_EXCEEDED' });
  await assert.rejects(fetchText(URL, { deadline: { remainingMs: () => 0 } }), { code: 'DAILY_DEADLINE_EXCEEDED' });
  await assert.rejects(fetchJson(URL, { timeoutMs: 0 }), { code: 'ETIMEDOUT' });
  const parent = new AbortController();
  const reason = new Error('cancelled before start');
  parent.abort(reason);
  await assert.rejects(fetchJson(URL, { signal: parent.signal }), (error) => error === reason);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('successful JSON and text preserve request options and release cancellation hooks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const parent = new AbortController();
  const addListener = t.mock.method(parent.signal, 'addEventListener');
  const removeListener = t.mock.method(parent.signal, 'removeEventListener');
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{"jobs":[]}'));
  const ctx = makeHttpCtx();
  assert.equal(ctx.transport, 'http');
  assert.deepEqual(await ctx.fetchJson(URL, {
    signal: parent.signal, timeoutMs: 40, method: 'POST', body: '{}', redirect: 'error', headers: { 'x-test': 'yes' },
  }), { jobs: [] });
  assert.equal(await ctx.fetchText(URL, { signal: parent.signal, timeoutMs: 40 }), '{"jobs":[]}');
  const options = fetchMock.mock.calls[0].arguments[1];
  assert.equal(options.method, 'POST');
  assert.equal(options.body, '{}');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers['x-test'], 'yes');
  assert.match(options.headers['user-agent'], /career-ops/);
  assert.equal(addListener.mock.callCount(), 2);
  assert.equal(removeListener.mock.callCount(), 2);
  parent.abort(new Error('after completion'));
  t.mock.timers.tick(100);
  for (const call of fetchMock.mock.calls) assert.equal(call.arguments[1].signal.aborted, false);
});

test('HTTP errors retain status, body and retry-after without logging body markup', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>challenge</html>', {
    status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '2' },
  }));
  for (const request of [fetchJson, fetchText]) {
    await assert.rejects(request(URL), (error) => {
      assert.equal(error.message, 'HTTP 429 Too Many Requests');
      assert.equal(error.status, 429);
      assert.equal(error.body, '<html>challenge</html>');
      assert.equal(error.retryAfter, '2');
      return true;
    });
  }
});

test('failed error-body reads retain the HTTP error with an empty body', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false, status: 503, statusText: '', headers: new Headers(),
    text: async () => { throw new Error('body failed'); },
  }));
  await assert.rejects(fetchJson(URL), { message: 'HTTP 503', status: 503, body: '', retryAfter: null });
});

test('network failures and invalid JSON still reject and clear their timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const reason = new TypeError('network failed');
  const signals = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signals.push(options.signal);
    if (signals.length === 1) throw reason;
    return new Response('invalid JSON');
  });
  await assert.rejects(fetchText(URL, { timeoutMs: 40 }), (error) => error === reason);
  await assert.rejects(fetchJson(URL, { timeoutMs: 40 }), SyntaxError);
  t.mock.timers.tick(100);
  for (const signal of signals) assert.equal(signal.aborted, false);
});
