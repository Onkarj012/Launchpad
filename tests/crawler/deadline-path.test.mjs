import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { discoverCompanyCareers } from '../../crawler/company-careers.mjs';
import { fetchWarmAts } from '../../crawler/ats-warm.mjs';
import { createRenderedFetcher } from '../../crawler/browser-transport.mjs';
import { createChromiumFallbackTransport } from '../../crawler/chromium-fallback.mjs';
import { buildSourcePlans } from '../../crawler/operator.mjs';
import { runPortalSourcePlan } from '../../job-pull/normal-sources.mjs';
import { enrichWorkdayCandidates } from '../../job-pull/workday-enrichment.mjs';
import { scorePoolInRun } from '../../job-pull/mode-scoring.mjs';
import { cloneJsonSafe } from '../../crawler/run.mjs';
import { createHostLimiter } from '../../crawler/http-policy.mjs';

// Control a pending operation without sleeping or external requests.
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Advance deadline timers and their cancellation cleanup deterministically.
async function expire(t, milliseconds) {
  t.mock.timers.tick(milliseconds);
  await yieldTurn();
  t.mock.timers.tick(0);
  await yieldTurn();
}

test('company careers forwards caps and retains completed companies plus stalled URL', async () => {
  const controller = new AbortController();
  const started = deferred();
  const progress = [];
  const calls = [];
  const resultPromise = discoverCompanyCareers({
    companies: [{ company: 'Done', websiteUrl: 'https://done.example' }, { company: 'Stalled', websiteUrl: 'https://stalled.example' }],
    robots: [], maxPagesPerCompany: 1, timeoutMs: 123, signal: controller.signal,
    deadline: { remainingMs: () => 500 }, hostLimiterOptions: { minSpacingMs: 0 },
    onProgress: (value) => progress.push(value),
    transport: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('stalled')) { started.resolve(); return new Promise(() => {}); }
      return { status: 200, body: '<html></html>' };
    },
  });
  await started.promise;
  controller.abort(new Error('source cancelled'));
  const result = await resultPromise;
  assert.equal(calls.length, 2);
  assert.ok(calls[1].options.timeoutMs > 0 && calls[1].options.timeoutMs <= 123);
  assert.equal(calls[1].options.signal.aborted, true);
  assert.equal(result.manifest.sources[0].pagesFetched, 1);
  assert.equal(result.manifest.sources[1].status, 'interrupted');
  assert.equal(result.manifest.sources[1].currentUrl, 'https://stalled.example/');
  assert.ok(progress.some(({ sources }) => sources[1]?.currentUrl === 'https://stalled.example/'));
});

test('company careers bounds body reads at the source deadline without starting another company', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const bodyStarted = deferred();
  const deadline = { deadlineMs: 1020 };
  let requests = 0;
  const resultPromise = discoverCompanyCareers({
    companies: [{ websiteUrl: 'https://first.example' }, { websiteUrl: 'https://second.example' }],
    robots: [], deadline, hostLimiterOptions: { minSpacingMs: 0 },
    transport: async () => { requests++; return { status: 200, text: () => { bodyStarted.resolve(); return new Promise(() => {}); } }; },
  });
  await bodyStarted.promise;
  await expire(t, 20);
  const result = await resultPromise;
  assert.equal(requests, 1);
  assert.equal(result.manifest.sources[0].status, 'interrupted');
});

test('startup company wrapper keeps configured page caps and checkpoint progress', async () => {
  const config = { sources: { startup: { companyCareers: [{ company: 'Example', websiteUrl: 'https://careers.example' }] }, careerOptions: { robots: [], maxPagesPerCompany: 1, hostLimiterOptions: { minSpacingMs: 0 } } } };
  const plan = buildSourcePlans({ config, profile: { mode: 'normal' }, schedule: 'morning', runAt: '2026-10-13T00:00:00Z', transport: async () => ({ status: 200, body: '<a href="/careers/next">next</a>' }) }).find(({ id }) => id === 'startup-company-careers');
  const checkpoints = [];
  const result = await plan.fetch({ checkpoint: (progress) => checkpoints.push(progress) });
  assert.equal(result.manifest.companies[0].pagesFetched, 1);
  assert.equal(result.manifest.companies[0].capped, true);
  assert.ok(checkpoints.some(({ manifestDelta }) => manifestDelta.telemetry.companies[0].currentUrl));
});

test('company progress remains persistable at configured company and page caps', async () => {
  const companies = Array.from({ length: 20 }, (_, i) => ({ company: `Company ${i}`, websiteUrl: `https://company${i}.example` }));
  const body = Array.from({ length: 200 }, (_, i) => `<a href="/careers/${i}">careers</a>`).join('');
  const config = { sources: { startup: { companyCareers: companies }, careerOptions: { robots: [], maxPagesPerCompany: 25, hostLimiterOptions: { minSpacingMs: 0 } } } };
  const plan = buildSourcePlans({ config, profile: { mode: 'normal' }, transport: async () => ({ status: 200, body }) }).find(({ id }) => id === 'startup-company-careers');
  let checkpoints = 0;
  const result = await plan.fetch({ checkpoint: ({ manifestDelta }) => {
    cloneJsonSafe({ manifest: manifestDelta, telemetry: manifestDelta.telemetry });
    checkpoints++;
  } });
  cloneJsonSafe({ manifest: result.manifest, telemetry: result.manifest });
  assert.ok(checkpoints >= 500);
  assert.equal(result.manifest.companies.length, 20);
  assert.equal(result.manifest.companies[19].pagesFetched, 25);
  assert.equal('discoveredCareerUrls' in result.manifest.companies[0], false);
});

test('company cancellation clears retry backoff timers and prevents further attempts', async () => {
  const controller = new AbortController();
  let calls = 0;
  const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const promise = discoverCompanyCareers({ company: 'Retry', websiteUrl: 'https://retry.example', robots: [], signal: controller.signal,
    hostLimiterOptions: { minSpacingMs: 0 }, retry: { baseDelayMs: 10_000, jitterRatio: 0 },
    transport: async () => { calls++; return { status: 429 }; },
  });
  await yieldTurn();
  assert.ok(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length > before);
  controller.abort(new Error('stop backoff'));
  const result = await promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(result.manifest.sources[0].status, 'interrupted');
  assert.equal(calls, 1);
  assert.equal(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length, before);
});

test('host spacing cancellation clears its timer without starting another request', async () => {
  const limiter = createHostLimiter({ minSpacingMs: 10_000 });
  await limiter.run('example', async () => {});
  await yieldTurn();
  const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const controller = new AbortController();
  let calls = 0;
  const promise = limiter.run('example', async () => { calls++; }, { signal: controller.signal });
  const rejection = assert.rejects(promise, /abort/i);
  controller.abort();
  await rejection;
  await yieldTurn();
  assert.equal(calls, 0);
  assert.equal(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length, before);
});

test('warm ATS honors function remaining budget before fetching', async () => {
  let calls = 0;
  const result = await fetchWarmAts({ boards: [{ provider: 'ashby', slug: 'expired' }], deadline: { remainingMs: () => 0 }, transport: async () => { calls++; return {}; } });
  assert.equal(calls, 0);
  assert.equal(result.manifest.deadline.exhausted, true);
});

test('warm ATS bulk rows cooperate with parent cancellation', async () => {
  const controller = new AbortController();
  let rowsRead = 0;
  const jobs = Array.from({ length: 1000 }, (_, index) => ({ id: index, get title() { rowsRead++; if (rowsRead === 5) controller.abort(new Error('stop rows')); return 'Software Engineer'; }, jobUrl: `https://jobs.ashbyhq.com/acme/${index}`, location: 'Pune', publishedAt: '2026-10-13T00:00:00Z' }));
  const result = await fetchWarmAts({ boards: [{ provider: 'ashby', slug: 'acme' }], signal: controller.signal, transport: async () => ({ status: 200, body: { jobs } }) });
  assert.ok(rowsRead < jobs.length);
  assert.equal(result.manifest.sources[0].status, 'interrupted');
  assert.equal(result.manifest.deadline.exhausted, true);
});

test('warm ATS cancellation stops waiting for an uncooperative transport', async () => {
  const controller = new AbortController();
  const started = deferred();
  const promise = fetchWarmAts({ boards: [{ provider: 'ashby', slug: 'hung' }], requestTimeoutMs: 1000, signal: controller.signal, transport: async () => { started.resolve(); return new Promise(() => {}); } });
  await started.promise;
  controller.abort(new Error('stop transport'));
  const result = await promise;
  assert.equal(result.manifest.deadline.exhausted, true);
  assert.equal(result.failures.length, 1);
});

// Supply a browser with controlled navigation, waiting and content stages.
function fakeBrowser(stage, started, closed) {
  const pending = () => { started.resolve(); return new Promise(() => {}); };
  const page = {
    goto: async () => stage === 'navigation' ? pending() : { status: () => 200, headers: () => ({}) },
    waitForTimeout: async () => stage === 'wait' ? pending() : undefined,
    content: async () => stage === 'body' ? pending() : '<html>ok</html>',
    close: async () => { closed.count++; },
  };
  const context = { addInitScript: async () => {}, newPage: async () => page, close: async () => {} };
  return { newContext: async () => context, newPage: async () => page, close: async () => {} };
}

for (const stage of ['navigation', 'wait', 'body']) {
  test(`rendered browser abort closes a page stalled in ${stage}`, async () => {
    const controller = new AbortController();
    const started = deferred();
    const closed = { count: 0 };
    const browser = createRenderedFetcher({ launchBrowser: async () => fakeBrowser(stage, started, closed) });
    const promise = browser.fetchRendered('https://portal.example', { signal: controller.signal, waitMs: 1 });
    const rejection = assert.rejects(promise, /stop browser/);
    await started.promise;
    controller.abort(new Error('stop browser'));
    await rejection;
    assert.ok(closed.count >= 1);
    await browser.close();
  });
}

test('rendered browser deadline bounds stalled body reads and closes the page', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const started = deferred();
  const closed = { count: 0 };
  const browser = createRenderedFetcher({ launchBrowser: async () => fakeBrowser('body', started, closed) });
  const promise = browser.fetchRendered('https://portal.example', { waitMs: 0, deadline: { remainingMs: () => 20 } });
  const rejection = assert.rejects(promise, { code: 'DAILY_DEADLINE_EXCEEDED' });
  await started.promise;
  await expire(t, 20);
  await rejection;
  assert.ok(closed.count >= 1);
  await browser.close();
});

test('Chromium fallback does not issue HTTP fallback after parent cancellation', async () => {
  const controller = new AbortController();
  const started = deferred();
  const closed = { count: 0 };
  let httpCalls = 0;
  const transport = createChromiumFallbackTransport({ enabled: true, renderHosts: ['careers.example'], launchBrowser: async () => fakeBrowser('body', started, closed), baseTransport: async () => { httpCalls++; return {}; } });
  const promise = transport('https://careers.example', { signal: controller.signal });
  const rejection = assert.rejects(promise, /stop fallback/);
  await started.promise;
  controller.abort(new Error('stop fallback'));
  await rejection;
  assert.equal(httpCalls, 0);
  assert.ok(closed.count >= 1);
  await transport.close();
});

test('portal source plan forwards its deadline to rendered transport', async () => {
  const deadline = { remainingMs: () => 123 };
  let forwarded;
  await runPortalSourcePlan({ providerFetchers: { glassdoor: { fetchRendered: async (_url, options) => { forwarded = options.deadline; throw new Error('fixture stop'); } } }, laneInputs: { glassdoor: { queries: [{ url: 'https://portal.example' }] } }, deadline });
  assert.equal(forwarded, deadline);
});

test('Workday enrichment stops stalled retries at cutoff and skips later details', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const requested = deferred();
  let calls = 0;
  const candidates = [1, 2].map((id) => ({ provider: 'workday', title: 'Software Engineer', location: 'Pune', url: `https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_${id}`, evidence: {} }));
  const promise = enrichWorkdayCandidates(candidates, { concurrency: 1, deadline: { deadlineMs: 1020 }, ctx: { fetchJson: async (_url, options) => { calls++; assert.equal(options.deadline.deadlineMs, 1020); requested.resolve(); throw new Error('temporary fixture failure'); }, sleep: () => new Promise(() => {}) } });
  await requested.promise;
  await yieldTurn();
  await expire(t, 20);
  await promise;
  assert.equal(calls, 1);
  assert.equal(candidates[0].evidence.detailHydration.reason, 'deadline-exceeded');
  assert.equal(candidates[1].evidence.detailHydration.reason, 'deadline-exceeded');
});

test('Workday cutoff between detail creation and waiting observes the rejected detail promise', async () => {
  let reads = 0;
  const deadline = { remainingMs: () => ++reads < 4 ? 1000 : 0 };
  const candidate = { provider: 'workday', title: 'Software Engineer', location: 'Pune', url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_1', evidence: {} };
  await enrichWorkdayCandidates([candidate], { deadline, ctx: { fetchJson: async () => ({ jobPostingInfo: {} }) } });
  await yieldTurn();
  assert.equal(candidate.evidence.detailHydration.reason, 'deadline-exceeded');
});

test('scoring refuses an expired live budget or aborted parent before invoking scorer', async () => {
  const candidate = { canonicalUrl: 'https://jobs.example/one' };
  const controller = new AbortController();
  let calls = 0;
  const scorer = async () => { calls++; return {}; };
  const expired = await scorePoolInRun([candidate], scorer, { remainingMs: () => 0 });
  controller.abort();
  const aborted = await scorePoolInRun([candidate], scorer, { signal: controller.signal, remainingMs: 100 });
  assert.equal(calls, 0);
  assert.equal(expired.telemetry.reasonCode, 'SCORER_DEADLINE_EXCEEDED');
  assert.equal(aborted.telemetry.reasonCode, 'SCORER_ABORTED');
});

test('Normal mode forwards the discovery cutoff into Workday enrichment', async (t) => {
  const { runNormalMode } = await import('../../job-pull/normal-mode.mjs');
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetchCalls++; throw new Error('expired enrichment must not fetch'); });
  const result = await runNormalMode({
    clock: () => '2026-10-13T00:00:00Z', ledgerRows: [], opportunityLedgerRows: [],
    deadline: { remainingMs: () => 0 },
    sourceFixtures: { 'reverse-ats-warm': { candidates: [{ provider: 'workday', title: 'Software Engineer', company: 'Acme', location: 'Pune', url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_1', liveness: { status: 'Active' } }] } },
  });
  assert.equal(fetchCalls, 0);
  assert.equal(result.counts.fetched, 1);
  assert.equal(result.verificationQueue[0].provider, 'workday');
  assert.ok(result.verificationQueue[0].reasons.includes('FRESHNESS_NOT_VERIFIED'));
});

test('a request timeout on robots does not skip a healthy company with source time left', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const started = deferred();
  const calls = [];
  const promise = discoverCompanyCareers({
    companies: [{ websiteUrl: 'https://stalled.example' }, { websiteUrl: 'https://healthy.example' }],
    timeoutMs: 10, deadline: { deadlineMs: 2000 }, maxPagesPerCompany: 1,
    hostLimiterOptions: { minSpacingMs: 0 },
    transport: async (url) => { calls.push(url); if (url.includes('stalled')) { started.resolve(); return new Promise(() => {}); } return { status: 200, body: '' }; },
  });
  await started.promise;
  await expire(t, 10);
  const result = await promise;
  assert.ok(calls.includes('https://healthy.example/'));
  assert.equal(result.manifest.sources[0].status, 'terminal');
  assert.equal(result.manifest.sources[1].pagesFetched, 1);
});

test('an immediate ATS transport timeout keeps the live allowance for the next board', async () => {
  const calls = [];
  const result = await fetchWarmAts({
    boards: [{ provider: 'ashby', slug: 'broken' }, { provider: 'ashby', slug: 'healthy' }],
    deadline: { remainingMs: () => 500 },
    transport: async (url) => { calls.push(url); if (url.includes('broken')) throw Object.assign(new Error('connection timeout'), { code: 'ETIMEDOUT' }); return { status: 200, body: { jobs: [] } }; },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.manifest.deadline.exhausted, false);
  assert.equal(result.manifest.sources[0].board, 'healthy');
});

test('Workday parent cancellation clears an owned Retry-After timer', async (t) => {
  const { fetchWorkdayJobDetail } = await import('../../vendor/career-ops/providers/workday.mjs');
  const controller = new AbortController();
  const sleeping = deferred();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  let retryTimer;
  let cleared = false;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    const timer = nativeSetTimeout(callback, ms, ...args);
    if (ms === 32_000) { retryTimer = timer; sleeping.resolve(); }
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => { if (timer === retryTimer) cleared = true; return nativeClearTimeout(timer); });
  const promise = fetchWorkdayJobDetail('https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_1', {
    fetchJson: async () => { throw Object.assign(new Error('fixture 429'), { status: 429, retryAfter: '32' }); },
  }, { signal: controller.signal });
  const rejection = assert.rejects(promise, /stop retry/);
  await sleeping.promise;
  controller.abort(new Error('stop retry'));
  await rejection;
  assert.equal(cleared, true);
});
