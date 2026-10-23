import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSourcePlans,
  buildIndiaStartupLaneRequests,
  listBraveQueries,
  buildCrawlerHelp,
  createCrawlerRunResolver,
  defaultHttpTransport,
  runCrawlerOperator,
  validateCrawlerConfig,
} from '../../crawler/operator.mjs';
import { crawlWorkflow } from '../../crawler/workflow.mjs';
import { openCrawlerStore } from '../../crawler/run.mjs';
import { HIMALAYAS_SEARCH_URL } from '../../job-pull/remote-adapters/himalayas.mjs';
import { createOriginalListingResolver } from '../../crawler/original-listing-resolver.mjs';

test('morning trial runs YC India and remote search in each mode and stops after seven IST dates', async () => {
  const config = { sources: {
    yc: { enabled: true, trialStartDate: '2026-10-08' },
    hn: { enabled: true, trialStartDate: '2026-10-08' },
    searxng: { enabled: true, endpoint: 'https://search.test', queries: [] },
  } };
  const args = {
    config, runAt: '2026-10-07T18:30:00.000Z', schedule: 'morning',
    transport: async (url) => {
      assert.match(new URL(url).searchParams.get('q'), /\(India OR remote\)/);
      return { status: 200, body: { results: [] } };
    },
    resolver: async () => ({ status: 'verification' }),
  };
  for (const mode of ['normal', 'startup', 'remote']) {
    const plans = buildSourcePlans({ ...args, profile: { mode } });
    const yc = plans.find(({ id }) => id === 'yc-discovery');
    assert.ok(yc);
    const result = await yc.fetch();
    assert.equal(result.telemetry.requests, 1);
    assert.equal(result.manifest.status, 'empty');
    assert.ok(plans.find(({ id }) => id === 'hn-discovery'));
  }
  for (const runAt of ['2026-10-07T18:29:59.000Z', '2026-10-14T18:30:00.000Z']) {
    const plans = buildSourcePlans({ ...args, runAt, profile: { mode: 'normal' } });
    assert.ok(plans.every(({ id }) => !['hn-discovery', 'yc-discovery'].includes(id)));
  }
  const midday = buildSourcePlans({ ...args, schedule: 'midday', profile: { mode: 'normal' } });
  assert.ok(midday.every(({ id }) => !['hn-discovery', 'yc-discovery'].includes(id)));
});
import { JOBICY_FEED_URL } from '../../job-pull/remote-adapters/jobicy.mjs';
import { WWR_FEED_URL } from '../../job-pull/remote-adapters/weworkremotely.mjs';
import { REMOTIVE_FEED_URL } from '../../job-pull/remote-adapters/remotive.mjs';
import { REMOTEOK_FEED_URL } from '../../job-pull/remote-adapters/remoteok.mjs';
import { mapProviderSafe } from '../../crawler/bounded-concurrency.mjs';
import { requestWithDeadline } from '../../crawler/deadline.mjs';
import { applicationReadiness } from '../../job-pull/normal-readiness.mjs';

function validTheirStackConfig(overrides = {}) {
  return {
    enabled: false,
    apiKeyEnv: 'THEIRSTACK_API_KEY',
    pageSize: 25,
    maxQueriesPerRun: 2,
    maxPagesPerQuery: 1,
    maxItemsPerRun: 50,
    maxCreditsPerRun: 50,
    queries: [{ id: 'india-ai', filters: { posted_at_max_age_days: 14 } }],
    ...overrides,
  };
}

function crawlerConfigWithTheirStack(theirstack) {
  return {
    schemaVersion: 'LaunchpadCrawlerConfigV1',
    databasePath: ':memory:',
    sources: { theirstack },
  };
}

function linkedinCards(count, { offTargetAt = null } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const title = index === offTargetAt ? 'Sales Manager' : 'AI Engineer';
    return `<li><h3 class="base-search-card__title">${title}</h3><h4 class="base-search-card__subtitle"><a>Company ${index}</a></h4><span class="job-search-card__location">Pune, Maharashtra, India</span><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/100${String(index).padStart(3, '0')}"></a><time datetime="2026-08-31"></time></li>`;
  }).join('');
}

function portalPlanConfig() {
  return {
    sources: {
      portals: {
        enabled: true,
        maxCandidates: 24,
        maxResolverRequests: 48,
        resolverConcurrency: 3,
        perHostConcurrency: 1,
        resolverMaxDurationMs: 60000,
        handoffReserveMs: 5000,
        http: { providers: ['linkedin-jobs'] },
        linkedin: { queries: [{ keywords: 'AI Engineer', location: 'Pune' }] },
      },
    },
  };
}

test('operator help exposes validation, planning, discovery, and readiness commands', () => {
  const help = buildCrawlerHelp();
  for (const command of ['validate', 'plan', 'run', 'readiness']) assert.match(help, new RegExp(command));
  assert.match(help, /never applies or sends/i);
});

test('configuration fails closed when durable paths or source sections are missing', () => {
  assert.throws(() => validateCrawlerConfig({}), /schemaVersion/);
  assert.throws(() => validateCrawlerConfig({
    schemaVersion: 'LaunchpadCrawlerConfigV1',
    databasePath: ':memory:',
  }), /sources/);
});

test('TheirStack configuration validates disabled without credentials and rejects unsafe shapes', () => {
  assert.doesNotThrow(() => validateCrawlerConfig(crawlerConfigWithTheirStack(validTheirStackConfig())));

  assert.throws(() => validateCrawlerConfig(crawlerConfigWithTheirStack(validTheirStackConfig({ enabled: 'yes' }))), /enabled/);
  assert.throws(() => validateCrawlerConfig(crawlerConfigWithTheirStack(validTheirStackConfig({ apiKeyEnv: 'theirstack-key' }))), /apiKeyEnv/);
  assert.throws(() => validateCrawlerConfig(crawlerConfigWithTheirStack(validTheirStackConfig({ endpoint: 'https://example.test' }))), /endpoint/);
  for (const field of ['pageSize', 'maxQueriesPerRun', 'maxPagesPerQuery', 'maxItemsPerRun', 'maxCreditsPerRun']) {
    assert.throws(() => validateCrawlerConfig(crawlerConfigWithTheirStack(validTheirStackConfig({ [field]: 0 }))), new RegExp(field));
    assert.throws(() => validateCrawlerConfig(crawlerConfigWithTheirStack(validTheirStackConfig({ [field]: 1.5 }))), new RegExp(field));
  }
  assert.throws(() => validateCrawlerConfig(crawlerConfigWithTheirStack(validTheirStackConfig({ queries: {} }))), /queries/);
  assert.throws(() => validateCrawlerConfig(crawlerConfigWithTheirStack(validTheirStackConfig({
    queries: [{ id: ' ', filters: { posted_at_max_age_days: 14 } }],
  }))), /id/);
  assert.throws(() => validateCrawlerConfig(crawlerConfigWithTheirStack(validTheirStackConfig({
    queries: [{ id: 'missing-filters' }],
  }))), /filters/);
  assert.throws(() => validateCrawlerConfig(crawlerConfigWithTheirStack(validTheirStackConfig({
    queries: [{ id: 'same', filters: { posted_at_max_age_days: 14 } }, { id: 'same', filters: { company_name_or: ['Acme'] } }],
  }))), /unique/);
  assert.throws(() => validateCrawlerConfig(crawlerConfigWithTheirStack(validTheirStackConfig({
    queries: [{ id: 'missing-constraint', filters: { job_country_code_or: ['IN'] } }],
  }))), /constraint/);
  assert.throws(() => validateCrawlerConfig(crawlerConfigWithTheirStack(validTheirStackConfig({
    queries: [{ id: 'adapter-field', filters: { posted_at_max_age_days: 14, limit: 25 } }],
  }))), /adapter-owned/);
});

test('TheirStack source plan is morning-normal only and defers credential use to fetch', async () => {
  const theirstack = validTheirStackConfig({ enabled: true, apiKeyEnv: 'THEIRSTACK_TEST_API_KEY' });
  const planArgs = {
    config: { sources: { theirstack } },
    transport: async () => ({ status: 200, body: JSON.stringify({ data: [], metadata: { total_results: 0, total_companies: 0, truncated_results: 0, truncated_companies: 0 } }) }),
    runAt: '2026-07-24T10:00:00.000Z',
    schedule: 'morning',
    profile: { mode: 'normal' },
  };

  assert.equal(buildSourcePlans({ ...planArgs, config: { sources: { theirstack: { ...theirstack, enabled: false } } } }).some(({ id }) => id === 'theirstack'), false);
  assert.equal(buildSourcePlans({ ...planArgs, schedule: 'midday' }).some(({ id }) => id === 'theirstack'), false);
  assert.equal(buildSourcePlans({ ...planArgs, profile: { mode: 'startup' } }).some(({ id }) => id === 'theirstack'), false);

  const calls = [];
  const previous = process.env.THEIRSTACK_TEST_API_KEY;
  try {
    const plans = buildSourcePlans({
      ...planArgs,
      transport: async (url, options) => {
        calls.push({ url, options });
        return { status: 200, body: JSON.stringify({ data: [], metadata: { total_results: 0, total_companies: 0, truncated_results: 0, truncated_companies: 0 } }) };
      },
    });
    const plan = plans.find(({ id }) => id === 'theirstack');
    assert.ok(plan);
    assert.equal(plan.lane, 'connector-imports');
    assert.equal(plan.provider, 'theirstack');
    assert.equal(plan.trustClass, 'aggregator');
    assert.deepEqual(plan.capabilities, { newestFirst: true, paginated: true, discoveryUrl: true, creditsMetered: true });
    assert.equal(calls.length, 0);

    process.env.THEIRSTACK_TEST_API_KEY = 'test-key-not-real';
    await plan.fetch({ cursor: null });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key-not-real');
    assert.equal(JSON.parse(calls[0].options.body).posted_at_max_age_days, 14);
  } finally {
    if (previous === undefined) delete process.env.THEIRSTACK_TEST_API_KEY;
    else process.env.THEIRSTACK_TEST_API_KEY = previous;
  }
});

test('builds resolver-capable SearXNG and connector plans without network access', async () => {
  const calls = [];
  const resolver = async (observation) => {
    calls.push(observation.discoveryUrl);
    return {
      status: 'verification',
      discoveryUrl: observation.discoveryUrl,
      evidence: { resolver: 'test-resolver' },
    };
  };
  const plans = buildSourcePlans({
    config: {
      sources: {
        atsWarm: { boards: [] }, atsBatch1: { boards: [] }, atsBatch2: { boards: [] }, enterprise: { boards: [] },
        indeed: { enabled: true, inboxDir: '/tmp/does-not-need-to-run' },
        searxng: { enabled: true, endpoint: 'http://127.0.0.1:8080', queries: ['AI Engineer'] },
      },
    },
    transport: async () => ({ status: 200, body: JSON.stringify({ results: [] }) }),
    runAt: '2026-07-24T10:00:00.000Z',
    clock: { now: () => '2026-07-24T10:00:00.000Z' },
    schedule: 'morning',
    resolver,
  });

  assert.deepEqual(plans.map((plan) => plan.id), ['indeed-inbox', 'searxng-search', 'structured-career-pages']);
  assert.equal(plans.find((plan) => plan.id === 'indeed-inbox').capabilities.resolver, true);
  assert.equal(plans.find((plan) => plan.id === 'searxng-search').capabilities.discoveryUrl, true);
  assert.equal(calls.length, 0);
});

test('run resolver uses injected transport, preserves discoveryUrl, and fails closed', async () => {
  const requests = [];
  const resolve = createCrawlerRunResolver({
    config: { sources: { originalListingResolver: { maxRedirects: 1, maxBytes: 1234 } } },
    runAt: '2026-07-24T10:00:00.000Z',
    transport: async (url, options) => {
      requests.push({ url, options });
      throw new Error('offline fixture');
    },
  });

  const result = await resolve({ canonicalUrl: 'https://www.indeed.com/viewjob?id=1' });
  assert.equal(result.status, 'verification');
  assert.equal(result.discoveryUrl, 'https://www.indeed.com/viewjob?id=1');
  assert.equal(result.applicationResolution.status, 'Needs Verification');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.maxBytes, 1234);
  assert.equal(requests[0].options.purpose, 'original-listing-resolution');
});

test('run resolver forwards configured maxHosts and maxRequests', async () => {
  const requests = [];
  const resolve = createCrawlerRunResolver({
    config: { sources: { originalListingResolver: { maxRedirects: 1, maxHosts: 1, maxRequests: 1, maxBytes: 500 } } },
    runAt: '2026-07-24T10:00:00.000Z',
    transport: async (url) => {
      requests.push(url);
      return { status: 200, headers: { location: 'https://other.example/jobs/1' }, body: '' };
    },
  });
  await resolve({ canonicalUrl: 'https://www.indeed.com/viewjob?id=2' });
  assert.equal(requests.length, 1);
});

test('run resolver uses the configured registry for portal cross-matches', async () => {
  const detailUrl = 'https://boards.greenhouse.io/acme/jobs/123';
  const requests = [];
  const resolve = createCrawlerRunResolver({
    config: { boardRegistry: { boards: [{ provider: 'greenhouse', slug: 'acme', company: 'Acme Labs', enabled: true, probeStatus: 'verified' }] } },
    runAt: '2026-10-08T00:00:00.000Z',
    transport: async (url) => {
      requests.push(url);
      if (url.includes('boards-api.greenhouse.io') && !url.includes('/jobs/123')) return { status: 200, body: { jobs: [
        { id: 123, title: 'AI Engineer', absolute_url: detailUrl, location: { name: 'Pune, India' } },
      ] } };
      return { status: 200, body: { id: 123, title: 'AI Engineer', absolute_url: detailUrl,
        location: { name: 'Pune, India' }, content: '<p>Build AI services.</p>', first_published: '2026-10-08T00:00:00Z',
      } };
    },
  });
  const result = await resolve({ canonicalUrl: 'https://www.glassdoor.com/job-listing/ai-engineer',
    provider: 'glassdoor', company: 'Acme Labs', title: 'AI Engineer', location: 'Pune' });
  assert.equal(result.status, 'resolved');
  assert.equal(result.originalApplicationUrl, detailUrl);
  assert.equal(requests.length, 2);
});

test('operator resolver receives a deadline-aware signal and absolute deadline', async () => {
  const controller = new AbortController();
  const deadline = { deadlineMs: Date.now() + 10_000, remainingMs: 10_000 };
  const seen = [];
  const resolve = createCrawlerRunResolver({
    config: { sources: { originalListingResolver: { maxRequests: 1 } } },
    runAt: '2026-07-24T10:00:00.000Z', signal: controller.signal, deadline,
    transport: async (_url, options) => { seen.push(options); throw new Error('offline fixture'); },
  });
  await resolve({ canonicalUrl: 'https://www.indeed.com/viewjob?id=deadline' });
  assert.notEqual(seen[0].signal, controller.signal);
  assert.equal(seen[0].signal.aborted, false);
  assert.equal(seen[0].deadline, deadline);
  assert.ok(seen[0].remainingMs > 0);
  assert.ok(seen[0].remainingMs <= 10_000);
});

test('ordinary deadline requests preserve the parent signal and reject non-cooperative transports', async () => {
  const controller = new AbortController();
  let receivedSignal;
  await assert.rejects(
    () => requestWithDeadline(async (_url, options) => {
      receivedSignal = options.signal;
      return new Promise(() => {});
    }, 'https://example.test/slow', {}, {
      signal: controller.signal,
      deadline: { remainingMs: 10 },
    }),
    (error) => error.code === 'DAILY_DEADLINE_EXCEEDED',
  );
  assert.equal(receivedSignal, controller.signal);
});

test('enterprise operator forwards the derived DETAIL abort signal to the injected transport', async () => {
  const controller = new AbortController();
  const listUrl = 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs';
  let detailSignal;
  const plans = buildSourcePlans({
    config: {
      sources: {
        atsWarm: { boards: [] }, atsBatch1: { boards: [] }, atsBatch2: { boards: [] },
        enterprise: {
          boards: [{ provider: 'workday', company: 'Acme', url: listUrl }],
          enrichDetails: true, detailConcurrency: 1, maxDetailRequestsPerRun: 1,
        },
      },
    },
    transport: async (_url, options) => {
      if (!options.detail) return { status: 200, headers: {}, body: JSON.stringify({ total: 1, jobPostings: [{ jobReqId: 'PUNE', title: 'AI Engineer', externalPath: '/job/Pune/PUNE', locationsText: 'Pune' }] }) };
      detailSignal = options.signal;
      controller.abort(new Error('operator abort'));
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    },
    runAt: '2026-08-31T10:00:00.000Z', schedule: 'morning', signal: controller.signal,
  });
  const plan = plans.find(({ id }) => id === 'ats-enterprise');
  const result = await plan.fetch({ signal: controller.signal, deadline: { remainingMs: () => 10_000 }, checkpoint: async () => {} });

  assert.ok(plan);
  assert.notEqual(detailSignal, controller.signal);
  assert.equal(detailSignal.aborted, true);
  assert.equal(result.manifest.interrupted, true);
  assert.deepEqual(result.cursor.__cursor.Acme, { endpointUrl: listUrl, page: 0, workdayReceived: 0 });
});

test('portal resolution screens before network, caps candidates, checkpoints first, and preserves order', async () => {
  const resolverCalls = [];
  const checkpoints = [];
  const plans = buildSourcePlans({
    config: portalPlanConfig(),
    transport: async () => ({ status: 200, body: linkedinCards(25, { offTargetAt: 24 }) }),
    runAt: '2026-08-31T10:00:00.000Z',
    clock: { now: () => '2026-08-31T10:00:00.000Z' },
    schedule: 'morning',
    profile: { mode: 'normal' },
    portalCandidateScreen: (candidate) => ({ eligible: candidate.title === 'AI Engineer' }),
    resolver: async (candidate) => {
      resolverCalls.push(candidate.title);
      return {
        status: 'resolved',
        originalApplicationUrl: `https://jobs.lever.co/company-${candidate.jobId}/role`,
        patch: { description: `Verified ${candidate.title}`, applicationResolution: { status: 'Resolved Original' } },
      };
    },
  });
  const plan = plans.find(({ id }) => id === 'portal-discovery');
  assert.ok(plan);
  const result = await plan.fetch({ checkpoint: async (payload) => checkpoints.push({ payload, resolverCalls: resolverCalls.length }) });

  assert.equal(resolverCalls.length, 24);
  assert.equal(checkpoints[0].resolverCalls, 0);
  assert.equal(checkpoints[0].payload.observations.length, 25);
  assert.ok(checkpoints.length >= 25);
  assert.deepEqual(result.observations.map((candidate) => candidate.jobId), Array.from({ length: 25 }, (_, index) => `100${String(index).padStart(3, '0')}`));
  assert.equal(result.observations.at(-1).applicationResolution.status, 'Needs Verification');
  assert.equal(result.observations.at(-1).shortlistEligible, false);
  assert.equal(result.manifest.telemetry.candidatesFetched, 25);
  assert.equal(result.manifest.telemetry.targetScreened, 24);
  assert.equal(result.manifest.telemetry.resolutionCandidates, 24);
  assert.equal(result.manifest.telemetry.skippedByTargetScreen, 1);
  assert.equal(result.manifest.telemetry.resolved, 24);
  assert.equal(result.manifest.telemetry.unresolved, 1);
  assert.equal(result.manifest.telemetry.naturalTerminal, true);
});

test('portal root terminal state distinguishes constraints from ordinary unresolved leads', async (t) => {
  const runPlan = async ({ count = 2, config = {}, clock = {}, deadline = null, signal = null, resolver }) => {
    const plans = buildSourcePlans({
      config: { ...portalPlanConfig(), sources: { portals: { ...portalPlanConfig().sources.portals, ...config } } },
      transport: async () => ({ status: 200, body: linkedinCards(count) }),
      runAt: '2026-08-31T10:00:00.000Z', clock, schedule: 'morning', profile: { mode: 'normal' },
      signal, deadline, resolver,
    });
    return plans.find(({ id }) => id === 'portal-discovery').fetch({ signal, deadline });
  };

  await t.test('candidate cap', async () => {
    const result = await runPlan({ count: 25, config: { maxCandidates: 1 }, resolver: async () => ({ status: 'verification' }) });
    assert.equal(result.manifest.truncated, true);
    assert.equal(result.manifest.naturalTerminal, false);
  });
  await t.test('aggregate request budget', async () => {
    const result = await runPlan({ count: 2, config: { maxCandidates: 2, maxResolverRequests: 1 }, resolver: async (_candidate, { requestBudget }) => {
      requestBudget.claim();
      return { status: 'verification' };
    } });
    assert.equal(result.manifest.truncated, true);
    assert.equal(result.manifest.naturalTerminal, false);
  });
  await t.test('resolver deadline', async () => {
    const result = await runPlan({
      count: 1,
      clock: { now: () => '2026-08-31T10:00:00.000Z', monotonicNow: (() => { const values = [0, 60_000]; return () => values.shift() ?? 60_000; })() },
      resolver: async () => ({ status: 'verification' }),
    });
    assert.equal(result.manifest.truncated, true);
    assert.equal(result.manifest.naturalTerminal, false);
  });
  await t.test('abort with unresolved work', async () => {
    const controller = new AbortController();
    const result = await runPlan({ signal: controller.signal, resolver: async () => {
      controller.abort(new Error('operator abort'));
      return { status: 'verification' };
    } });
    assert.equal(result.manifest.truncated, true);
    assert.equal(result.manifest.naturalTerminal, false);
  });
  await t.test('ordinary unresolved target lead', async () => {
    const result = await runPlan({ resolver: async () => ({
      status: 'verification', originalApplicationUrl: null,
      applicationResolution: { status: 'Needs Verification', evidence: null },
      evidence: { resolution: { status: 'verification', reason: 'destination-intermediary' } },
    }) });
    assert.equal(result.manifest.truncated, false);
    assert.equal(result.manifest.naturalTerminal, true);
    assert.equal(result.observations[0].applicationResolution.status, 'Needs Verification');
    assert.equal(result.observations[0].shortlistEligible, false);
  });
});

test('portal discovery leaves time for employer details and retains capped verification reasons', async () => {
  let now = 0;
  const config = portalPlanConfig();
  config.sources.portals.maxCandidates = 1;
  config.boardRegistry = { boards: [{ provider: 'greenhouse', slug: 'acme', company: 'Acme Labs', enabled: true, probeStatus: 'verified' }] };
  const requests = [];
  const transport = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('linkedin.com')) {
      assert.equal(options.deadline.remainingMs(), 57_500);
      now = 57_500;
      return { status: 200, body: linkedinCards(3).replaceAll('Company 2', 'Acme Labs') };
    }
    assert.ok(options.deadline.remainingMs() > 0);
    if (url.includes('boards-api.greenhouse.io') && !url.includes('/jobs/123')) return { status: 200, body: { jobs: [{
      id: 123, title: 'AI Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/123', location: { name: 'Pune, Maharashtra, India' },
    }] } };
    return { status: 403, body: '<html>Access denied</html>' };
  };
  const checkpoints = [];
  const deadline = { remainingMs: () => 120_000 - now };
  const plans = buildSourcePlans({ config, transport, runAt: '2026-10-13T10:00:00.000Z',
    clock: { monotonicNow: () => now }, schedule: 'morning', profile: { mode: 'normal' },
    resolver: createCrawlerRunResolver({ config, transport, runAt: '2026-10-13T10:00:00.000Z' }),
  });
  const result = await plans.find(({ id }) => id === 'portal-discovery').fetch({ deadline, checkpoint: async (value) => checkpoints.push(value) });
  assert.equal(requests.filter(({ url }) => url.includes('linkedin.com')).length, 1);
  assert.equal(requests.filter(({ url }) => !url.includes('linkedin.com')).length, 2);
  assert.equal(result.manifest.telemetry.resolutionReserveMs, 57_500);
  assert.equal(result.manifest.telemetry.resolutionRequests, 2);
  assert.equal(result.manifest.telemetry.skippedByCandidateCap, 2);
  assert.deepEqual(result.manifest.telemetry.verificationReasonCounts, { 'candidate-cap-exceeded': 2, blocked: 1 });
  assert.deepEqual(checkpoints.at(-1).manifestDelta.telemetry.verificationReasonCounts, result.manifest.telemetry.verificationReasonCounts);
  assert.equal(result.observations[2].company, 'Acme Labs');
  assert.equal(result.observations[2].originalApplicationUrl, null);
  assert.equal(result.verificationQueue.length, 3);
  for (const candidate of result.observations) assert.equal(applicationReadiness(candidate, candidate.eligibility).ready, false);
});

test('browser search shares the reserved discovery deadline and closes before HTTP resolution', async () => {
  const config = portalPlanConfig();
  config.sources.portals.http.providers = [];
  config.sources.portals.linkedin.enabled = false;
  config.sources.portals.browser = { enabled: true, providers: ['instahyre'] };
  config.sources.portals.instahyre = { queries: [{ url: 'https://www.instahyre.com/search/' }] };
  let closed = false;
  let received;
  const plans = buildSourcePlans({ config, transport: async () => { throw new Error('unexpected HTTP search'); },
    runAt: '2026-10-13T10:00:00.000Z', clock: { monotonicNow: () => 0 }, schedule: 'morning', profile: { mode: 'normal' },
    renderedFetcherFactory: () => ({
      fetchRendered: async (_url, options) => {
        received = options;
        return '<div class="employer-block"><a href="/job-123456-ai-engineer-at-acme/"></a><div class="employer-job-name" title="Acme - AI Engineer"></div><span>Job available in Pune</span></div>';
      },
      close: async () => { closed = true; },
    }),
    resolver: async () => {
      assert.equal(closed, true);
      return { status: 'verification', evidence: { resolution: { reason: 'original-listing-not-found' } } };
    },
  });
  const result = await plans.find(({ id }) => id === 'portal-discovery').fetch({ deadline: { remainingMs: () => 120_000 } });
  assert.equal(received.deadline.remainingMs(), 57_500);
  assert.equal(received.timeoutMs, 45_000);
  assert.equal(received.signal.aborted, false);
  assert.equal(closed, true);
  assert.equal(result.observations.length, 1);
  assert.deepEqual(result.manifest.telemetry.verificationReasonCounts, { 'original-listing-not-found': 1 });
});

test('rendered discovery clamps custom page caps and smaller source allowances', async (t) => {
  for (const [pageCap, sourceMs, expectedTimeout] of [[8000, 120000, 8000], [45000, 20000, 7500]]) await t.test(`${pageCap}/${sourceMs}`, async () => {
    const config = portalPlanConfig();
    config.sources.portals.http.providers = [];
    config.sources.portals.linkedin.enabled = false;
    config.sources.portals.browser = { enabled: true, providers: ['instahyre'], timeoutMs: pageCap };
    config.sources.portals.instahyre = { queries: [{ url: 'https://www.instahyre.com/search/' }] };
    let received;
    const plans = buildSourcePlans({ config, transport: async () => { throw new Error('unexpected HTTP search'); },
      runAt: '2026-10-13T10:00:00.000Z', clock: { monotonicNow: () => 0 }, schedule: 'morning', profile: { mode: 'normal' },
      renderedFetcherFactory: () => ({ fetchRendered: async (_url, options) => { received = options; return '<html>No matching jobs found</html>'; }, close: async () => {} }),
    });
    await plans.find(({ id }) => id === 'portal-discovery').fetch({ deadline: { remainingMs: () => sourceMs } });
    assert.equal(received.timeoutMs, expectedTimeout);
  });
});

test('portal resolution retries retained deadline failures and preserves fresh exhausted reasons', async () => {
  const config = portalPlanConfig();
  const runAt = '2026-10-13T10:00:00.000Z';
  const retained = { ...((await import('../../job-pull/candidate.mjs')).normalizeCandidate({
    title: 'AI Engineer', company: 'Company 0', location: 'Pune, India', url: 'https://www.linkedin.com/jobs/view/100000', provider: 'linkedin-jobs',
  }, { runAt })), evidence: { resolution: { reason: 'deadline-exceeded' } } };
  let called = 0;
  const plans = buildSourcePlans({ config, transport: async () => ({ status: 200, body: linkedinCards(1) }),
    runAt, clock: { monotonicNow: () => 0 }, schedule: 'morning', profile: { mode: 'normal' },
    resolver: async () => { called += 1; return { status: 'verification', evidence: { resolution: { reason: 'deadline-exceeded' } } }; },
  });
  const result = await plans.find(({ id }) => id === 'portal-discovery').fetch({ cursor: { completedDetails: [retained] } });
  assert.equal(called, 1);
  assert.deepEqual(result.manifest.telemetry.verificationReasonCounts, { 'deadline-exceeded': 1 });
  assert.equal(result.manifest.telemetry.deadlineExhausted, true);
  assert.equal(result.manifest.truncated, true);

  const heldLeads = ['123456', '234567', '345678'].map((jobId) => ({
    provider: 'linkedin-jobs', jobId, providerJobId: jobId, company: 'Acme', title: 'AI Engineer',
    discoveryUrl: `https://www.linkedin.com/jobs/view/${jobId}`, canonicalUrl: `https://www.linkedin.com/jobs/view/${jobId}`,
  }));
  const callsByLead = new Map();
  const recoveryOptions = {
    config: { sources: { portals: { enabled: false, maxCandidates: 10, maxResolverRequests: 30 } } },
    transport: async () => { throw new Error('held recovery must not search portals'); },
    runAt, clock: { monotonicNow: () => 0, currentTime: () => runAt }, schedule: 'morning', heldPortalLeads: heldLeads,
    resolver: async (candidate) => {
      const calls = (callsByLead.get(candidate.jobId) ?? 0) + 1;
      callsByLead.set(candidate.jobId, calls);
      if (candidate.jobId === '234567') return {
        status: 'resolved', originalApplicationUrl: 'https://boards.greenhouse.io/acme/jobs/123',
        telemetry: { requests: 1 }, patch: {
          company: 'Acme', title: 'AI Engineer', location: 'Pune, India',
          description: 'Build Python APIs.', employment: { type: 'full-time' },
          experience: { minYears: 0, maxYears: 1, evidence: 'original employer detail' },
          salary: { min: 100000, currency: 'INR' }, postedAt: '2026-10-20', liveness: { status: 'Active' },
          evidence: { fieldSources: { company: 'original-employer-detail', title: 'original-employer-detail',
            location: 'original-employer-detail', description: 'original-employer-detail', employment: 'original-employer-detail',
            experience: 'original-employer-detail', salary: 'original-employer-detail', postedAt: 'original-employer-detail',
            liveness: 'original-employer-detail' } },
        },
      };
      return { status: 'verification', telemetry: { requests: 1 }, evidence: { resolution: {
        reason: candidate.jobId === '345678' && calls > 1 ? 'original-listing-not-found'
          : candidate.jobId === '345678' ? 'deadline-exceeded' : 'original-listing-not-found',
      } } };
    },
  };
  let checkpointCursor;
  const firstRecovery = await buildSourcePlans(recoveryOptions).find(({ id }) => id === 'portal-discovery').fetch({
    checkpoint: async ({ cursor: value }) => { checkpointCursor = value; },
  });
  assert.equal(firstRecovery.manifest.telemetry.heldLeadRecovery.missing, 1);
  assert.equal(firstRecovery.manifest.telemetry.heldLeadRecovery.recovered, 1);
  assert.equal(firstRecovery.manifest.telemetry.heldLeadRecovery.blocked, 1);
  assert.equal(checkpointCursor.completedDetails.length, 3);
  const firstSuccess = firstRecovery.manifest.telemetry.heldLeadRecovery.outcomes.find(({ lead }) => lead === '234567');
  assert.equal(firstSuccess.attemptCount, 1, 'a successful resolver request counts as an attempt');
  assert.equal(firstSuccess.reason, 'original-employer-detail');

  const glassdoorLead = {
    provider: 'glassdoor', providerJobId: 'r2-503', jobId: 'r2-503', company: 'Acme', title: 'AI Engineer',
    discoveryUrl: 'https://www.glassdoor.com/job-listing/r2-503', canonicalUrl: 'https://www.glassdoor.com/job-listing/r2-503',
  };
  let glassdoorCalls = 0;
  let glassdoorCursor;
  let glassdoorNow = '2026-10-13T10:20:00.000Z';
  const glassdoorOptions = {
    ...recoveryOptions,
    clock: { monotonicNow: () => 0, currentTime: () => glassdoorNow },
    heldPortalLeads: [glassdoorLead],
    resolver: async () => {
      glassdoorCalls += 1;
      return glassdoorCalls < 3
        ? { status: 'verification', telemetry: { requests: 1 }, evidence: { httpStatus: 503, resolution: { reason: 'detail-http-503' } } }
        : { status: 'resolved', telemetry: { requests: 1 }, originalApplicationUrl: 'https://boards.greenhouse.io/acme/jobs/r2-503', patch: {
          company: 'Acme', title: 'AI Engineer', location: 'Pune, India', description: 'Build Python APIs.',
          employment: { type: 'full-time' }, experience: { minYears: 0, maxYears: 1 }, postedAt: '2026-10-20',
          liveness: { status: 'Active' },
        } };
    },
  };
  const failedGlassdoor = await buildSourcePlans(glassdoorOptions).find(({ id }) => id === 'portal-discovery').fetch({
    checkpoint: async ({ cursor: value }) => { glassdoorCursor = value; },
  });
  assert.equal(failedGlassdoor.manifest.telemetry.heldLeadRecovery.continuation, true);
  assert.equal(failedGlassdoor.manifest.telemetry.heldLeadRecovery.outcomes[0].recoveryState, 'pending');
  const firstCursorRecovery = glassdoorCursor.completedDetails[0].evidence.recovery;
  assert.equal(firstCursorRecovery.attemptCount, 1);
  assert.equal(firstCursorRecovery.attemptedAt, '2026-10-13T10:20:00.000Z');
  assert.equal(firstCursorRecovery.nextEligibleAt, '2026-10-13T11:20:00.000Z');
  glassdoorNow = '2026-10-13T11:20:00.000Z';
  const secondFailure = await buildSourcePlans({ ...glassdoorOptions, runAt: '2026-10-13T11:20:00.000Z' })
    .find(({ id }) => id === 'portal-discovery').fetch({ cursor: glassdoorCursor,
      checkpoint: async ({ cursor: value }) => { glassdoorCursor = value; } });
  const secondCursorRecovery = glassdoorCursor.completedDetails[0].evidence.recovery;
  assert.equal(secondFailure.manifest.telemetry.heldLeadRecovery.outcomes[0].attemptCount, 2);
  assert.equal(secondCursorRecovery.attemptedAt, '2026-10-13T11:20:00.000Z');
  assert.equal(secondCursorRecovery.nextEligibleAt, '2026-10-13T13:20:00.000Z');
  glassdoorNow = '2026-10-13T13:20:00.000Z';
  const resumedGlassdoor = await buildSourcePlans({ ...glassdoorOptions, runAt: '2026-10-13T13:20:00.000Z' })
    .find(({ id }) => id === 'portal-discovery').fetch({ cursor: glassdoorCursor,
      checkpoint: async ({ cursor: value }) => { glassdoorCursor = value; } });
  assert.equal(glassdoorCalls, 3, 'non-LinkedIn retryable details must resume from the provider identity checkpoint');
  assert.equal(resumedGlassdoor.manifest.telemetry.heldLeadRecovery.recovered, 1);
  const successfulCursorRecovery = glassdoorCursor.completedDetails[0].evidence.recovery;
  assert.equal(successfulCursorRecovery.attemptCount, 3);
  assert.equal(successfulCursorRecovery.nextEligibleAt, null);
  glassdoorNow = '2026-10-13T14:20:00.000Z';
  const successfulResume = await buildSourcePlans({ ...glassdoorOptions, runAt: '2026-10-13T14:20:00.000Z' })
    .find(({ id }) => id === 'portal-discovery').fetch({ cursor: glassdoorCursor });
  assert.equal(glassdoorCalls, 3, 'a successful checkpoint must be reused without another employer request');
  assert.equal(successfulResume.manifest.telemetry.heldLeadRecovery.reused, 1);

  let actualResolverRequests = 0;
  const actualResolver = createOriginalListingResolver({ transport: async (url) => {
    actualResolverRequests += 1;
    if (new URL(url).hostname === 'www.glassdoor.com') return {
      status: 302, headers: { location: 'https://boards.greenhouse.io/acme/jobs/ats-987' }, body: '',
    };
    const posting = {
      '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
      hiringOrganization: { name: 'Acme' },
      description: 'Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience.',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
      datePosted: '2026-10-12', employmentType: 'FULL_TIME', identifier: { name: 'Acme', value: 'ats-987' },
    };
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(posting)}</script>` };
  } });
  const actualGlassdoorLead = {
    provider: 'glassdoor', providerJobId: 'portal-123', jobId: 'portal-123', company: 'Acme', title: 'AI Engineer',
    discoveryUrl: 'https://www.glassdoor.com/job-listing/portal-123', canonicalUrl: 'https://www.glassdoor.com/job-listing/portal-123',
  };
  const actualOptions = { ...glassdoorOptions, heldPortalLeads: [actualGlassdoorLead], resolver: actualResolver };
  const actualFirst = await buildSourcePlans(actualOptions).find(({ id }) => id === 'portal-discovery').fetch({
    checkpoint: async ({ cursor: value }) => { glassdoorCursor = value; },
  });
  assert.equal(actualFirst.manifest.telemetry.heldLeadRecovery.recovered, 1);
  assert.equal(glassdoorCursor.completedDetails[0].provider, 'greenhouse');
  assert.equal(glassdoorCursor.completedDetails[0].jobId, 'portal-123');
  assert.equal(glassdoorCursor.completedDetails[0].evidence.recovery.providerRequisitionKey, 'glassdoor|portal 123');
  const actualResumed = await buildSourcePlans(actualOptions).find(({ id }) => id === 'portal-discovery').fetch({
    cursor: glassdoorCursor,
  });
  assert.equal(actualResolverRequests, 2, 'a saved success after provider change must reuse the original held lead with no more GETs');
  assert.equal(actualResumed.manifest.telemetry.heldLeadRecovery.reused, 1);

  const fairRequests = [];
  const fairResolver = createOriginalListingResolver({ runAt, transport: async (url) => {
    const parsed = new URL(url);
    fairRequests.push(url);
    const id = parsed.pathname.split('/').at(-1).replace(/\.html$/, '');
    if (parsed.hostname === 'www.glassdoor.com') return {
      status: 302, headers: { location: `https://boards.greenhouse.io/acme/jobs/${id}` }, body: '',
    };
    if (parsed.hostname === 'www.linkedin.com') return {
      status: 302, headers: { location: `https://boards.greenhouse.io/acme/jobs/${id}` }, body: '',
    };
    const posting = {
      '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
      hiringOrganization: { name: 'Acme' },
      description: 'Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience.',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
      datePosted: '2026-10-12', employmentType: 'FULL_TIME', identifier: { name: 'Acme', value: id },
    };
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(posting)}</script>` };
  } });
  const fairConfig = portalPlanConfig();
  fairConfig.sources.portals.maxResolverRequests = 30;
  fairConfig.sources.portals.resolverConcurrency = 1;
  const fairPass = await buildSourcePlans({ ...actualOptions, config: fairConfig, heldPortalLeads: [actualGlassdoorLead],
    transport: async () => ({ status: 200, body: linkedinCards(1) }), resolver: fairResolver })
    .find(({ id }) => id === 'portal-discovery').fetch();
  assert.equal(fairPass.manifest.telemetry.heldLeadRecovery.recovered, 1);
  assert.equal(fairPass.observations.length, 2);
  assert.equal(fairPass.observations.filter(({ evidence }) => evidence?.recovery?.kind === 'held-lead-recovery').length, 1);
  assert.equal(fairRequests.length, 4, 'ordinary discovery and one held lead both receive resolver requests');

  const cursorLeads = Array.from({ length: 11 }, (_, index) => ({
    provider: 'glassdoor', providerJobId: `cursor-success-${index}`, jobId: `cursor-success-${index}`,
    company: 'Acme', title: 'AI Engineer',
    discoveryUrl: `https://www.glassdoor.com/job-listing/cursor-success-${index}`,
    canonicalUrl: `https://www.glassdoor.com/job-listing/cursor-success-${index}`,
  }));
  const cursorCalls = new Map();
  const cursorResolver = createOriginalListingResolver({ transport: async (url) => {
    const parsed = new URL(url);
    const id = parsed.pathname.split('/').at(-1).replace(/\.html$/, '');
    cursorCalls.set(id, (cursorCalls.get(id) ?? 0) + 1);
    if (parsed.hostname === 'www.glassdoor.com') return {
      status: 302, headers: { location: `https://boards.greenhouse.io/acme/jobs/${id}` }, body: '',
    };
    const posting = {
      '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
      hiringOrganization: { name: 'Acme' },
      description: 'Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience.',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
      datePosted: '2026-10-12', employmentType: 'FULL_TIME', identifier: { name: 'Acme', value: id },
    };
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(posting)}</script>` };
  } });
  let successCursor;
  const cursorConfig = portalPlanConfig();
  cursorConfig.sources.portals.enabled = false;
  cursorConfig.sources.portals.maxCandidates = 24;
  cursorConfig.sources.portals.maxResolverRequests = 48;
  cursorConfig.sources.portals.resolverConcurrency = 1;
  const cursorOptions = { ...actualOptions, heldPortalLeads: cursorLeads, resolver: cursorResolver,
    transport: async () => { throw new Error('cursor resume must not search portals'); }, config: cursorConfig };
  const firstSuccessPass = await buildSourcePlans(cursorOptions).find(({ id }) => id === 'portal-discovery').fetch({
    checkpoint: async ({ cursor: value }) => { successCursor = value; },
  });
  assert.equal(firstSuccessPass.manifest.telemetry.heldLeadRecovery.attempted, 10,
    JSON.stringify(firstSuccessPass.manifest.telemetry.heldLeadRecovery));
  assert.equal(successCursor.completedDetails.length, 10);
  assert.equal(cursorLeads.reduce((sum, { jobId }) => sum + (cursorCalls.get(jobId) ?? 0), 0), 20);
  const resumedSuccessPass = await buildSourcePlans(cursorOptions).find(({ id }) => id === 'portal-discovery').fetch({
    cursor: successCursor, checkpoint: async ({ cursor: value }) => { successCursor = value; },
  });
  assert.equal(cursorLeads.reduce((sum, { jobId }) => sum + (cursorCalls.get(jobId) ?? 0), 0), 22);
  assert.equal(resumedSuccessPass.manifest.telemetry.heldLeadRecovery.reused, 10);
  assert.equal(resumedSuccessPass.manifest.telemetry.heldLeadRecovery.attempted, 1);
  assert.ok(cursorLeads.slice(0, 10).every(({ jobId }) => cursorCalls.get(jobId) === 2),
    'the ten successful details must be reused without another request');
  assert.equal(cursorCalls.get(cursorLeads[10].jobId), 2, 'the eleventh held lead must use its resolver slot');

  const rateLimitedLead = { ...cursorLeads[0], providerJobId: 'cursor-429', jobId: 'cursor-429',
    discoveryUrl: 'https://www.glassdoor.com/job-listing/cursor-429', canonicalUrl: 'https://www.glassdoor.com/job-listing/cursor-429' };
  let rateLimitedRequests = 0;
  const rateLimitedResolver = createOriginalListingResolver({ runAt, now: () => runAt, transport: async (url) => {
    rateLimitedRequests += 1;
    if (rateLimitedRequests === 1) return { status: 429, headers: { 'Retry-After': '86400' }, body: 'slow down' };
    if (new URL(url).hostname === 'www.glassdoor.com') return {
      status: 302, headers: { location: 'https://boards.greenhouse.io/acme/jobs/cursor-429' }, body: '',
    };
    const posting = {
      '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
      hiringOrganization: { name: 'Acme' },
      description: 'Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience.',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
      datePosted: '2026-10-12', employmentType: 'FULL_TIME', identifier: { name: 'Acme', value: 'cursor-429' },
    };
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(posting)}</script>` };
  } });
  let rateLimitCursor;
  const rateLimitOptions = { ...cursorOptions, heldPortalLeads: [rateLimitedLead], resolver: rateLimitedResolver };
  const rateLimitedPass = await buildSourcePlans(rateLimitOptions).find(({ id }) => id === 'portal-discovery').fetch({
    checkpoint: async ({ cursor: value }) => { rateLimitCursor = value; },
  });
  const retained429 = rateLimitCursor.completedDetails[0].evidence.recovery;
  assert.equal(retained429.attemptCount, 1);
  assert.equal(retained429.nextEligibleAt, '2026-10-14T10:00:00.000Z');
  const earlyRateLimitedPass = await buildSourcePlans(rateLimitOptions).find(({ id }) => id === 'portal-discovery').fetch({
    cursor: rateLimitCursor, checkpoint: async ({ cursor: value }) => { rateLimitCursor = value; },
  });
  assert.equal(rateLimitedRequests, 1, 'a cursor resume must respect the retained Retry-After deadline');
  assert.equal(earlyRateLimitedPass.manifest.telemetry.heldLeadRecovery.waiting, 1);
  assert.equal(earlyRateLimitedPass.manifest.telemetry.heldLeadRecovery.continuation, true);
  assert.equal(earlyRateLimitedPass.manifest.telemetry.heldLeadRecovery.outcomes[0].attemptCount, 1);
  assert.equal(earlyRateLimitedPass.manifest.telemetry.heldLeadRecovery.outcomes[0].nextEligibleAt, retained429.nextEligibleAt);
  assert.equal(rateLimitCursor.completedDetails[0].evidence.recovery.attemptCount, 1);
  assert.equal(rateLimitCursor.completedDetails[0].evidence.recovery.nextEligibleAt, retained429.nextEligibleAt);

  const rediscoveryConfig = portalPlanConfig();
  rediscoveryConfig.sources.portals.enabled = true;
  const rediscoveryLead = { provider: 'linkedin-jobs', providerJobId: '100000', jobId: '100000', company: 'Acme',
    title: 'AI Engineer', location: 'Pune, India', discoveryUrl: 'https://www.linkedin.com/jobs/view/100000',
    canonicalUrl: 'https://www.linkedin.com/jobs/view/100000' };
  let rediscoveryCalls = 0;
  const rediscoveryRequests = [];
  const rediscoveryResolver = createOriginalListingResolver({ runAt, now: () => runAt, transport: async (url) => {
    rediscoveryCalls += 1;
    rediscoveryRequests.push(url);
    const parsed = new URL(url);
    if (parsed.hostname === 'www.linkedin.com') return {
      status: 302, headers: { location: `https://boards.greenhouse.io/acme/jobs/${parsed.pathname.split('/').at(-1)}` }, body: '',
    };
    if (parsed.pathname.endsWith('/100000') && rediscoveryCalls === 2) {
      return { status: 429, headers: { 'Retry-After': '86400' }, body: 'rate limited' };
    }
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
        hiringOrganization: { name: 'Company 1' }, description: 'Full-time AI Engineer in Pune, India. Build Python systems. 0-1 years experience.',
        jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } }, datePosted: '2026-10-12',
        employmentType: 'FULL_TIME', identifier: { name: 'Company 1', value: '100001' },
      })}</script>` };
  } });
  const rediscoverySearchConfig = portalPlanConfig();
  rediscoverySearchConfig.sources.portals.enabled = false;
  const rediscoveryOptions = { ...rateLimitOptions, config: rediscoverySearchConfig, heldPortalLeads: [rediscoveryLead], resolver: rediscoveryResolver };
  let rediscoveryCursor;
  const rediscoveryFailure = await buildSourcePlans(rediscoveryOptions).find(({ id }) => id === 'portal-discovery').fetch({
    checkpoint: async ({ cursor: value }) => { rediscoveryCursor = value; },
  });
  assert.equal(rediscoveryFailure.manifest.telemetry.heldLeadRecovery.outcomes[0].reason, 'blocked');
  const rediscoveryPending = rediscoveryCursor.completedDetails[0].evidence.recovery;
  assert.equal(rediscoveryPending.attemptCount, 1);
  assert.equal(rediscoveryPending.nextEligibleAt, '2026-10-14T10:00:00.000Z');
  const rediscoverySearch = async () => ({ status: 200, body: linkedinCards(2) });
  const rediscoveryRun = await buildSourcePlans({ ...rediscoveryOptions, config: rediscoveryConfig,
    heldPortalLeads: [], heldPortalRecoveryWaiting: 1, heldPortalRecoveryWaitingCandidates: rediscoveryCursor.completedDetails,
    transport: rediscoverySearch, runAt: '2026-10-13T10:00:00.000Z' })
    .find(({ id }) => id === 'portal-discovery').fetch({ cursor: rediscoveryCursor });
  assert.equal(rediscoveryCalls, 4, 'ordinary discovery may resolve the unrelated role while the held role waits');
  assert.equal(rediscoveryRequests.filter((url) => url.endsWith('/100000')).length, 2,
    `the held LinkedIn detail and employer detail are not requested again before Retry-After: ${rediscoveryRequests.join(', ')}`);
  assert.equal(rediscoveryRun.manifest.telemetry.heldLeadRecovery.waiting, 1);
  assert.equal(rediscoveryRun.manifest.telemetry.heldLeadRecovery.continuation, true);
  assert.equal(rediscoveryRun.manifest.telemetry.heldLeadRecovery.outcomes[0].attemptCount, 1);
  assert.equal(rediscoveryRun.manifest.telemetry.heldLeadRecovery.outcomes[0].nextEligibleAt, rediscoveryPending.nextEligibleAt);
  assert.equal(rediscoveryRequests.filter((url) => url.endsWith('/100001')).length, 2,
    'the unrelated ordinary requisition must still resolve');

  const distinctAliasWaiting = { ...rediscoveryLead, providerJobId: '100002', jobId: '100002',
    discoveryUrl: 'https://www.linkedin.com/jobs/view/100002', canonicalUrl: 'https://www.linkedin.com/jobs/view/100002',
    evidence: { recovery: { kind: 'held-lead-recovery',
      identityUrl: 'requisition:linkedin jobs|100000', outcome: 'pending', nextEligibleAt: '2026-10-14T10:00:00.000Z' } } };
  const distinctAliasPass = await buildSourcePlans({ ...rediscoveryOptions, config: rediscoveryConfig, heldPortalLeads: [],
    heldPortalRecoveryWaiting: 1, heldPortalRecoveryWaitingCandidates: [distinctAliasWaiting],
    transport: async () => ({ status: 200, body: linkedinCards(1) }),
    resolver: createOriginalListingResolver({ transport: async () => ({ status: 302,
      headers: { location: 'https://boards.greenhouse.io/acme/jobs/100001' }, body: '' }) }) })
    .find(({ id }) => id === 'portal-discovery').fetch();
  assert.equal(distinctAliasPass.manifest.telemetry.resolutionRequests, 2,
    'a matching persisted alias cannot override different requisitions from the same provider');
  assert.equal(distinctAliasPass.manifest.telemetry.heldLeadRecovery.waiting, 1);
  const dueRateLimitedPass = await buildSourcePlans({ ...rateLimitOptions, runAt: retained429.nextEligibleAt })
    .find(({ id }) => id === 'portal-discovery').fetch({
      cursor: rateLimitCursor, checkpoint: async ({ cursor: value }) => { rateLimitCursor = value; },
    });
  assert.equal(rateLimitedRequests, 3);
  assert.equal(dueRateLimitedPass.manifest.telemetry.heldLeadRecovery.recovered, 1);
  assert.equal(dueRateLimitedPass.manifest.telemetry.heldLeadRecovery.outcomes[0].attemptCount, 2);

  const budgetConfig = portalPlanConfig();
  budgetConfig.sources.portals.enabled = false;
  budgetConfig.sources.portals.maxCandidates = 12;
  budgetConfig.sources.portals.maxResolverRequests = 4;
  budgetConfig.sources.portals.resolverConcurrency = 1;
  const budgetLeads = Array.from({ length: 10 }, (_, index) => ({
    provider: 'glassdoor', providerJobId: `cursor-budget-${index}`, jobId: `cursor-budget-${index}`,
    company: 'Acme', title: 'AI Engineer',
    discoveryUrl: `https://www.glassdoor.com/job-listing/cursor-budget-${index}`,
    canonicalUrl: `https://www.glassdoor.com/job-listing/cursor-budget-${index}`,
  }));
  const budgetCalls = new Map();
  const budgetResolver = createOriginalListingResolver({ transport: async (url) => {
    const parsed = new URL(url);
    const id = parsed.pathname.split('/').at(-1).replace(/\.html$/, '');
    budgetCalls.set(id, (budgetCalls.get(id) ?? 0) + 1);
    if (parsed.hostname === 'www.glassdoor.com') {
      if ((id === 'cursor-budget-1' || id === 'cursor-budget-2') && budgetCalls.get(id) === 1) {
        return { status: 503, body: 'temporary failure' };
      }
      return { status: 302, headers: { location: `https://boards.greenhouse.io/acme/jobs/${id}` }, body: '' };
    }
    const posting = {
      '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
      hiringOrganization: { name: 'Acme' },
      description: 'Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience.',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
      datePosted: '2026-10-12', employmentType: 'FULL_TIME', identifier: { name: 'Acme', value: id },
    };
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(posting)}</script>` };
  } });
  let budgetCursor;
  const budgetOptions = { config: budgetConfig, runAt, clock: { monotonicNow: () => 0, currentTime: () => runAt }, schedule: 'morning',
    profile: { mode: 'normal' }, heldPortalLeads: budgetLeads, resolver: budgetResolver,
    transport: async () => { throw new Error('budget cursor recovery must not search portals'); } };
  const firstBudgetPass = await buildSourcePlans(budgetOptions).find(({ id }) => id === 'portal-discovery').fetch({
    checkpoint: async ({ cursor: value }) => { budgetCursor = value; },
  });
  assert.equal(firstBudgetPass.manifest.telemetry.heldLeadRecovery.recovered, 1);
  assert.equal(firstBudgetPass.manifest.telemetry.heldLeadRecovery.attempted, 3);
  const budgetPending = firstBudgetPass.manifest.telemetry.heldLeadRecovery.outcomes
    .filter(({ lead }) => Number(lead.split('-').at(-1)) >= 3);
  assert.equal(budgetPending.length, 7);
  assert.ok(budgetPending.every(({ recoveryState, reason, attemptCount, attemptedAt, nextEligibleAt }) =>
    recoveryState === 'pending' && reason === 'request-budget-exhausted'
      && attemptCount === 0 && attemptedAt === null && nextEligibleAt === null));
  assert.equal(budgetCursor.completedDetails.length, 3);
  assert.equal(budgetCursor.completedDetails.find(({ jobId }) => jobId === 'cursor-budget-0')
    .evidence.recovery.outcome, 'recovered');

  budgetConfig.sources.portals.maxResolverRequests = 30;
  const resumedBudgetPass = await buildSourcePlans({ ...budgetOptions, runAt: '2026-10-13T11:00:00.000Z' })
    .find(({ id }) => id === 'portal-discovery').fetch({ cursor: budgetCursor,
      checkpoint: async ({ cursor: value }) => { budgetCursor = value; } });
  assert.equal(resumedBudgetPass.manifest.telemetry.heldLeadRecovery.recovered, 10,
    JSON.stringify(resumedBudgetPass.manifest.telemetry.heldLeadRecovery.outcomes));
  assert.equal(resumedBudgetPass.manifest.telemetry.heldLeadRecovery.reused, 1);
  assert.equal(budgetCalls.get('cursor-budget-0'), 2, 'checkpoint success reuse must not request the completed lead again');
  assert.ok(budgetLeads.slice(3).every(({ jobId }) => budgetCalls.get(jobId) === 2),
    'cursor resume must retry each unattempted budget lead');

  const chainBound = await buildSourcePlans({ ...budgetOptions, heldPortalLeads: [budgetLeads[0]],
    resolver: createOriginalListingResolver({ maxRedirects: 0, transport: async () => ({
      status: 302, headers: { location: 'https://boards.greenhouse.io/acme/jobs/chain-bound' }, body: '',
    }) }) })
    .find(({ id }) => id === 'portal-discovery').fetch();
  assert.equal(chainBound.manifest.telemetry.heldLeadRecovery.outcomes[0].reason, 'redirect-limit-exceeded');
  assert.equal(chainBound.manifest.telemetry.heldLeadRecovery.outcomes[0].requests, 1);
  assert.equal(chainBound.manifest.telemetry.heldLeadRecovery.outcomes[0].recoveryState, 'unresolved',
    'an actual resolver chain bound remains terminal when no operator budget claim failed');

  const resumedRecovery = await buildSourcePlans({ ...recoveryOptions, runAt: '2026-10-13T11:00:00.000Z' })
    .find(({ id }) => id === 'portal-discovery').fetch({ cursor: checkpointCursor });
  const recovery = resumedRecovery.manifest.telemetry.heldLeadRecovery;
  assert.equal(callsByLead.get('123456'), 1);
  assert.equal(callsByLead.get('234567'), 1);
  assert.equal(callsByLead.get('345678'), 2);
  assert.equal(recovery.attempted, 1);
  assert.equal(recovery.reused, 2);
  assert.equal(recovery.missing, 2);
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.blocked, 0);
  assert.equal(recovery.unattempted, 0);
  assert.deepEqual(recovery.outcomes.map(({ lead, outcome, reason, requests }) => ({ lead, outcome, reason, requests })), [
    { lead: '123456', outcome: 'missing', reason: 'original-listing-not-found', requests: 0 },
    { lead: '234567', outcome: 'recovered', reason: 'original-employer-detail', requests: 0 },
    { lead: '345678', outcome: 'missing', reason: 'original-listing-not-found', requests: 1 },
  ]);
  const resumedSuccess = resumedRecovery.observations.find(({ jobId }) => jobId === '234567');
  assert.equal(resumedSuccess.company, 'Acme');
  assert.equal(resumedSuccess.title, 'AI Engineer');
  assert.equal(resumedSuccess.location, 'Pune, India');
  assert.equal(resumedSuccess.description, 'Build Python APIs.');
  assert.deepEqual(resumedSuccess.employment, { type: 'full-time' });
  assert.deepEqual(resumedSuccess.experience, { minYears: 0, maxYears: 1, evidence: 'original employer detail' });
  assert.deepEqual(resumedSuccess.salary, { min: 100000, currency: 'INR' });
  assert.equal(resumedSuccess.postedAt, '2026-10-20');
  assert.deepEqual(resumedSuccess.liveness, { status: 'Active' });
  assert.deepEqual(resumedRecovery.observations.find(({ jobId }) => jobId === '123456').evidence.resolution, { reason: 'original-listing-not-found' });
  assert.equal(resumedSuccess.evidence.recovery.kind, 'held-lead-recovery');
  assert.equal(resumedSuccess.evidence.recovery.originalDiscoveryUrl, 'https://www.linkedin.com/jobs/view/234567');
});

test('portal shared request cap retains every unverified lead and its cap reason', async () => {
  const config = portalPlanConfig();
  config.sources.portals.maxResolverRequests = 1;
  config.boardRegistry = { boards: [{ provider: 'greenhouse', slug: 'acme', company: 'Acme Labs', enabled: true, probeStatus: 'verified' }] };
  let detailRequests = 0;
  const transport = async (url) => {
    if (url.includes('linkedin.com')) return { status: 200, body: linkedinCards(2).replaceAll(/Company \d/g, 'Acme Labs') };
    detailRequests += 1;
    return { status: 200, body: { jobs: [{ id: 123, title: 'AI Engineer', location: { name: 'Pune, Maharashtra, India' },
      absolute_url: 'https://boards.greenhouse.io/acme/jobs/123' }] } };
  };
  const plans = buildSourcePlans({ config, transport, runAt: '2026-10-13T10:00:00.000Z',
    clock: { monotonicNow: () => 0 }, schedule: 'morning', profile: { mode: 'normal' },
    resolver: createCrawlerRunResolver({ config, transport, runAt: '2026-10-13T10:00:00.000Z' }),
  });
  const result = await plans.find(({ id }) => id === 'portal-discovery').fetch();
  assert.equal(detailRequests, 1);
  assert.equal(result.manifest.telemetry.resolutionRequests, 1);
  assert.equal(result.manifest.telemetry.requestBudgetExhausted, true);
  assert.deepEqual(result.manifest.telemetry.verificationReasonCounts, { 'request-budget-exhausted': 2 });
  assert.equal(result.verificationQueue.length, 2);
  assert.ok(result.observations.every((candidate) => candidate.originalApplicationUrl === null));
});

test('portal discovery cutoff remains truncated even when every fetched lead resolves', async () => {
  let now = 0;
  const config = portalPlanConfig();
  config.sources.portals.linkedin.queries.push({ keywords: 'Backend Engineer', location: 'Pune' });
  const plans = buildSourcePlans({ config, transport: async () => { now = 57_500; return { status: 200, body: linkedinCards(1) }; },
    runAt: '2026-10-13T10:00:00.000Z', clock: { monotonicNow: () => now }, schedule: 'morning', profile: { mode: 'normal' },
    resolver: async () => ({ status: 'resolved', originalApplicationUrl: 'https://boards.greenhouse.io/acme/jobs/123',
      patch: { title: 'AI Engineer', description: 'Build Python APIs.', location: 'Pune', employment: { type: 'full-time' }, liveness: { status: 'Active' } } }),
  });
  const result = await plans.find(({ id }) => id === 'portal-discovery').fetch({ deadline: { remainingMs: () => 120_000 - now } });
  assert.equal(result.manifest.telemetry.resolved, 1);
  assert.equal(result.manifest.telemetry.unresolved, 0);
  assert.equal(result.manifest.telemetry.discoveryDeadlineExhausted, true);
  assert.equal(result.manifest.truncated, true);
  assert.equal(result.manifest.naturalTerminal, false);
});

test('resumed cached guest search retains its discovery cutoff after details resolve', async () => {
  let now = 0;
  const config = portalPlanConfig();
  config.sources.portals.linkedin.queries.push({ keywords: 'Backend Engineer', location: 'Pune' });
  const runAt = '2026-10-13T10:00:00.000Z';
  let cursor;
  const common = { config, runAt, clock: { monotonicNow: () => now }, schedule: 'morning', profile: { mode: 'normal' } };
  const first = buildSourcePlans({ ...common,
    transport: async () => { now = 57_500; return { status: 200, body: linkedinCards(1) }; },
    resolver: async () => ({ status: 'verification', telemetry: { requests: 1 }, evidence: { resolution: { reason: 'deadline-exceeded' } } }),
  }).find(({ id }) => id === 'portal-discovery');
  await first.fetch({ deadline: { remainingMs: () => 120_000 - now }, checkpoint: async (value) => { cursor = value.cursor; } });
  assert.equal(cursor.discoveryDeadlineExhausted, true);
  now = 0;
  let searches = 0;
  const resumed = buildSourcePlans({ ...common, transport: async () => { searches += 1; throw new Error('cached search must be reused'); },
    resolver: async () => ({ status: 'resolved', originalApplicationUrl: 'https://boards.greenhouse.io/acme/jobs/123',
      patch: { title: 'AI Engineer', description: 'Build Python APIs.', location: 'Pune', employment: { type: 'full-time' }, liveness: { status: 'Active' } } }),
  }).find(({ id }) => id === 'portal-discovery');
  const result = await resumed.fetch({ cursor, deadline: { remainingMs: () => 120_000 - now } });
  assert.equal(searches, 0);
  assert.equal(result.manifest.telemetry.unresolved, 0);
  assert.equal(result.manifest.telemetry.discoveryDeadlineExhausted, true);
  assert.equal(result.manifest.truncated, true);
  assert.equal(result.manifest.naturalTerminal, false);
});

test('all verified-board leads precede unsupported leads across provider allocation', async () => {
  const config = portalPlanConfig();
  config.sources.portals.maxCandidates = 2;
  config.sources.portals.browser = { enabled: true, providers: ['instahyre'] };
  config.sources.portals.instahyre = { queries: [{ url: 'https://www.instahyre.com/search/' }] };
  config.boardRegistry = { boards: [{ provider: 'greenhouse', slug: 'acme', company: 'Acme Labs', enabled: true, probeStatus: 'verified' }] };
  const resolved = [];
  const plans = buildSourcePlans({ config, transport: async () => ({ status: 200, body: linkedinCards(1) }),
    runAt: '2026-10-13T10:00:00.000Z', clock: { monotonicNow: () => 0 }, schedule: 'morning', profile: { mode: 'normal' },
    renderedFetcherFactory: () => ({ fetchRendered: async () => [1, 2].map((id) => `<div class="employer-block"><a href="/job-${id}-ai-engineer-at-acme/"></a><div class="employer-job-name" title="Acme Labs - AI Engineer"></div><span>Job available in Pune</span></div>`).join(''), close: async () => {} }),
    resolver: async (candidate) => { resolved.push(candidate.company); return { status: 'verification' }; },
  });
  const result = await plans.find(({ id }) => id === 'portal-discovery').fetch();
  assert.deepEqual(resolved, ['Acme Labs', 'Acme Labs']);
  assert.equal(result.observations[0].evidence.resolution.reason, 'candidate-cap-exceeded');
});

test('mapProviderSafe preserves order, bounds global concurrency, and serializes each host', async () => {
  let active = 0;
  let maximum = 0;
  const activeByHost = new Map();
  let sameHostMaximum = 0;
  const items = Array.from({ length: 9 }, (_, index) => ({ index, host: `host-${index % 3}` }));
  const result = await mapProviderSafe(items, { concurrency: 3, providerKey: (item) => item.host }, async (item) => {
    active += 1;
    activeByHost.set(item.host, (activeByHost.get(item.host) ?? 0) + 1);
    maximum = Math.max(maximum, active);
    sameHostMaximum = Math.max(sameHostMaximum, activeByHost.get(item.host));
    await Promise.resolve();
    active -= 1;
    activeByHost.set(item.host, activeByHost.get(item.host) - 1);
    return item.index;
  });
  assert.deepEqual(result, items.map((item) => item.index));
  assert.equal(maximum, 3);
  assert.equal(sameHostMaximum, 1);
});

test('operator runs a configured career-site discovery into durable SQLite', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-operator-'));
  const config = {
    schemaVersion: 'LaunchpadCrawlerConfigV1',
    databasePath: path.join(root, 'crawler.sqlite'),
    sources: {
      atsBatch1: { boards: [] },
      atsBatch2: { boards: [] },
      enterprise: { boards: [] },
      careerSites: [{ company: 'Acme', websiteUrl: 'https://acme.example/' }],
      brave: { enabled: false },
      indeed: { enabled: false },
      indiaStartup: { enabled: false },
      commercialRescue: { enabled: false },
    },
  };
  const result = await runCrawlerOperator({
    config,
    runId: 'operator-run-1',
    schedule: 'morning',
    transport: async (url) => {
      if (url.endsWith('/robots.txt')) return { status: 200, headers: {}, body: 'User-agent: *\nAllow: /' };
      if (url === 'https://acme.example/') return {
        status: 200,
        headers: {},
        body: '<script type="application/ld+json">{"@type":"JobPosting","title":"AI Engineer","url":"https://acme.example/jobs/1","datePosted":"2026-07-23","description":"Pune full-time AI Engineer role for 0-1 years.","hiringOrganization":{"name":"Acme"},"jobLocation":{"address":{"addressLocality":"Pune","addressCountry":"IN"}}}</script>',
      };
      return { status: 200, headers: {}, body: '' };
    },
    clock: { now: () => '2026-07-23T10:00:00.000Z', sleep: async () => {} },
  });

  assert.equal(result.run.status, 'completed');
  assert.equal(result.observations.length, 1);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.sourceYield.totals.fetched, 1);
  assert.equal(result.sourceYield.totals.targetTitle, 1);
  assert.equal(result.plannedDownstreamHandoff.noAutoApply, true);
});

test('structured career-page source uses only eligible registry employers and discovers JobPosting roles', async () => {
  const config = {
    boardRegistry: { schemaVersion: 'BoardRegistryV1', boards: [
      { provider: 'custom', company: 'Structured Co', careerPageUrl: 'https://structuredco.io/', probe: { jobPostingJsonLd: true } },
      { provider: 'greenhouse', company: 'ATS Co', careerPageUrl: 'https://ats.example/', probe: { jobPostingJsonLd: true } },
      { provider: 'custom', company: 'Unverified Co', careerPageUrl: 'https://unverified.example/', probe: { jobPostingJsonLd: false } },
      { provider: 'custom', company: 'No URL Co', probe: { jobPostingJsonLd: true } },
    ] },
    sources: { careerPageDiscovery: { hostLimiterOptions: { minSpacingMs: 0 }, retry: { maxAttempts: 1 } } },
  };
  const calls = [];
  const plans = buildSourcePlans({ config, runAt: '2026-10-08T07:45:00+05:30', schedule: 'morning', transport: async (url) => {
    calls.push(url);
    if (url === 'https://structuredco.io/robots.txt') return { status: 200, headers: {}, body: 'User-agent: *\nAllow: /\nSitemap: https://structuredco.io/sitemap-jobs.xml' };
    if (url === 'https://structuredco.io/') return { status: 200, headers: { 'content-type': 'text/html' }, body: '<a href="/careers">Careers</a>' };
    if (url === 'https://structuredco.io/careers') return { status: 200, headers: { 'content-type': 'text/html' }, body: '' };
    if (url === 'https://structuredco.io/sitemap-jobs.xml') return { status: 200, headers: { 'content-type': 'application/xml' }, body: '<urlset><url><loc>https://structuredco.io/jobs/1</loc></url></urlset>' };
    if (url === 'https://structuredco.io/sitemap.xml') return { status: 200, headers: { 'content-type': 'application/xml' }, body: '<urlset></urlset>' };
    if (url === 'https://structuredco.io/jobs/1') return { status: 200, headers: { 'content-type': 'text/html' }, body: '<script type="application/ld+json">{"@type":"JobPosting","title":"AI Engineer","url":"https://structuredco.io/jobs/1","datePosted":"2026-10-07","description":"Pune AI Engineer","hiringOrganization":{"name":"Structured Co"},"jobLocation":{"address":{"addressLocality":"Pune","addressCountry":"IN"}}}</script>' };
    return { status: 200, headers: {}, body: '' };
  } });
  const plan = plans.find(({ id }) => id === 'structured-career-pages');

  assert.ok(plan);
  const result = await plan.fetch();
  assert.ok(calls.length > 0);
  assert.ok(calls.every((url) => new URL(url).hostname === 'structuredco.io'));
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].company, 'Structured Co');
  assert.equal(result.manifest.status, 'ok');
});

test('structured career-page source ends empty with a reason when registry has no eligible employers', async () => {
  const plans = buildSourcePlans({
    config: { boardRegistry: { schemaVersion: 'BoardRegistryV1', boards: [
      { provider: 'greenhouse', company: 'ATS Co', careerPageUrl: 'https://ats.example/', probe: { jobPostingJsonLd: true } },
      { provider: 'custom', company: 'Unknown Co', careerPageUrl: 'https://unknown.example/' },
    ] }, sources: {} },
    runAt: '2026-10-08T07:45:00+05:30', schedule: 'morning', transport: async () => assert.fail('empty registry lane must not fetch'),
  });
  const plan = plans.find(({ id }) => id === 'structured-career-pages');

  assert.ok(plan);
  const result = await plan.fetch();
  assert.deepEqual(result.observations, []);
  assert.equal(result.manifest.status, 'empty');
  assert.equal(result.manifest.reason, 'no-registry-employers-with-unsupported-ats-and-jobposting-jsonld');
});

test('operator invokes a configured commercial records feed only after free-lane shortfall', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-commercial-'));
  const recordsFile = path.join(root, 'commercial.json');
  writeFileSync(recordsFile, JSON.stringify([{
    url: 'https://commercial.example/careers/1',
    canonicalUrl: 'https://commercial.example/careers/1',
    company: 'Commercial Co',
    title: 'AI Engineer',
    location: 'Pune, India',
    description: 'Pune full-time AI Engineer role for 0-1 years.',
    postedAt: '2026-07-23T08:00:00.000Z',
    applicationReady: true,
    applicationResolution: { status: 'Resolved Original', evidence: 'commercial original listing' },
    liveness: { status: 'Active', evidence: 'commercial feed' },
  }]));
  const config = {
    schemaVersion: 'LaunchpadCrawlerConfigV1',
    databasePath: path.join(root, 'crawler.sqlite'),
    sources: {
      atsBatch1: { boards: [] }, atsBatch2: { boards: [] }, enterprise: { boards: [] },
      careerSites: [], brave: { enabled: false }, indeed: { enabled: false }, indiaStartup: { enabled: false },
      commercialRescue: { enabled: true, recordsFile, targetReserve: 12, maxRecords: 100, maxCostUsd: 5 },
    },
  };

  const result = await runCrawlerOperator({
    config,
    runId: 'commercial-run',
    clock: { now: () => '2026-07-23T10:00:00.000Z', sleep: async () => {} },
  });

  assert.equal(result.commercialRescue.invoked, true);
  assert.equal(result.commercialRescue.records.length, 1);
  assert.equal(result.jobs.length, 1);
});

test('remote-mode buildSourcePlans wires real fetchJson/fetchText into all five native providers and yields real candidates', async () => {
  const requestedUrls = [];
  const transport = async (url, options) => {
    requestedUrls.push(url);
    if (url.startsWith(HIMALAYAS_SEARCH_URL)) {
      if (url.includes('country=IN')) {
        return { status: 200, body: JSON.stringify({ jobs: [{ title: 'AI Engineer', companyName: 'Himalayas Co', applicationLink: 'https://himalayas.app/companies/h/jobs/1', pubDate: 1782538666, locationRestrictions: ['India'] }] }) };
      }
      return { status: 200, body: JSON.stringify({ jobs: [] }) };
    }
    if (url === JOBICY_FEED_URL) {
      return { status: 200, body: JSON.stringify({ jobs: [{ jobTitle: 'ML Engineer', companyName: 'Jobicy Co', jobGeo: 'Worldwide', jobType: ['Full-Time'], url: 'https://jobicy.com/jobs/1', pubDate: '2026-07-23T01:00:00Z' }] }) };
    }
    if (url === REMOTIVE_FEED_URL) {
      return { status: 200, body: JSON.stringify({ jobs: [{ title: 'Backend Engineer', company_name: 'Remotive Co', url: 'https://remotive.com/remote-jobs/1', candidate_required_location: 'Worldwide', job_type: 'full_time', publication_date: '2026-07-20T00:00:00Z' }] }) };
    }
    if (url === WWR_FEED_URL) {
      assert.equal(options?.redirect, 'error');
      return { status: 200, body: '<rss><channel><item><title><![CDATA[Full Stack Engineer]]></title><link>https://weworkremotely.com/remote-jobs/1</link><region>Worldwide</region><type>Full-Time</type><pubDate>Thu, 23 Jul 2026 01:00:00 GMT</pubDate></item></channel></rss>' };
    }
    if (url === REMOTEOK_FEED_URL) {
      return { status: 200, body: JSON.stringify([{ last_updated: 1, legal: 'https://remoteok.com/legal' }, { id: '9', position: 'Platform Engineer', company: 'Remoteok Co', location: 'Worldwide', date: '2026-07-22T00:00:00Z', url: 'https://remoteok.com/remote-jobs/9' }]) };
    }
    throw new Error(`unexpected transport call: ${url}`);
  };

  const plans = buildSourcePlans({
    config: { sources: {} },
    transport,
    runAt: '2026-07-24T10:00:00.000Z',
    clock: { now: () => '2026-07-24T10:00:00.000Z' },
    schedule: 'morning',
    resolver: undefined,
    profile: { mode: 'remote' },
  });

  const remotePlan = plans.find((plan) => plan.id === 'remote-mode');
  assert.ok(remotePlan, 'remote-mode plan should be registered');
  const result = await remotePlan.fetch({});

  assert.ok(requestedUrls.some((url) => url === WWR_FEED_URL));
  assert.ok(requestedUrls.some((url) => url === JOBICY_FEED_URL));
  assert.ok(requestedUrls.some((url) => url === REMOTIVE_FEED_URL));
  assert.ok(requestedUrls.some((url) => url === REMOTEOK_FEED_URL));
  assert.ok(requestedUrls.some((url) => url.startsWith(HIMALAYAS_SEARCH_URL)));

  const companies = result.observations.map((observation) => observation.company);
  assert.ok(companies.includes('Himalayas Co'));
  assert.ok(companies.includes('Jobicy Co'));
  assert.ok(companies.includes('Remotive Co'));
  assert.ok(companies.includes('Remoteok Co'));
  assert.ok(result.observations.some((observation) => observation.title === 'Full Stack Engineer'));

  const laneManifests = result.manifest.telemetry.lanes;
  for (const provider of ['himalayas', 'jobicy', 'weworkremotely', 'remotive', 'remoteok']) {
    const laneManifest = laneManifests.find((manifest) => manifest.sourceId === provider);
    assert.equal(laneManifest.status, 'ok', `${provider} lane should not be unavailable/failed`);
  }
});

test('startup-mode buildSourcePlans wires yc and vc-portfolio-boards lanes with a fake SearXNG transport and resolver, returning real candidates', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-operator-startup-'));
  const watchlistPath = path.join(root, 'vc-watchlist.json');
  writeFileSync(watchlistPath, JSON.stringify({
    schemaVersion: 'VcPortfolioWatchlistV1',
    funds: [{
      fund: 'Test Fund',
      sourceUrl: 'https://example.com/portfolio',
      verifiedAt: '2026-07-24',
      companies: [{ name: 'Acme' }, { name: 'Beta Co' }],
    }],
  }));

  const searxngRequests = [];
  const transport = async (url) => {
    searxngRequests.push(url);
    const q = new URL(url).searchParams.get('q') || '';
    if (/ycombinator\.com\/jobs/i.test(q)) {
      return { status: 200, body: JSON.stringify({ results: [{ url: 'https://www.ycombinator.com/companies/acme/jobs/abc123-engineer', title: 'AI Engineer at Acme' }] }) };
    }
    return { status: 200, body: JSON.stringify({ results: [{ url: 'https://boards.greenhouse.io/betaco/jobs/999', title: 'Backend Engineer' }] }) };
  };

  const resolver = async (observation) => ({
    status: 'resolved',
    url: observation.canonicalUrl,
    company: observation.company,
  });

  const plans = buildSourcePlans({
    config: {
      sources: {
        searxng: {
          enabled: true,
          endpoint: 'http://127.0.0.1:8080',
          queries: ['site:ycombinator.com/jobs India ("software engineer" OR "AI engineer")'],
          perQueryResultCap: 10,
        },
        startup: { vcPortfolioWatchlistPath: watchlistPath, vcPortfolioLimit: 5 },
      },
    },
    transport,
    runAt: '2026-07-24T10:00:00.000Z',
    clock: { now: () => '2026-07-24T10:00:00.000Z' },
    schedule: 'morning',
    resolver,
    profile: { mode: 'startup' },
  });

  const startupPlan = plans.find((plan) => plan.id === 'startup-mode');
  assert.ok(startupPlan, 'startup-mode plan should be registered');
  const result = await startupPlan.fetch({});

  assert.ok(searxngRequests.length >= 2, 'both yc and vc-portfolio-boards queries should hit the fake SearXNG transport');
  assert.ok(result.observations.length > 0, 'startup-mode should yield real candidates, not an empty manifest');

  const laneManifests = result.manifest.telemetry.lanes;
  const ycManifest = laneManifests.find((manifest) => manifest.sourceId === 'yc');
  const vcManifest = laneManifests.find((manifest) => manifest.sourceId === 'vc-portfolio-boards');
  assert.equal(ycManifest.status, 'ok');
  assert.notEqual(ycManifest.status, 'unavailable');
  assert.equal(vcManifest.status, 'ok');
  assert.notEqual(vcManifest.status, 'unavailable');
});

test('startup daily source plan crawls configured company career pages and returns Startup roles', async () => {
  const requests = [];
  const transport = async (url) => {
    requests.push(url);
    if (url.endsWith('/robots.txt')) return { status: 200, body: 'User-agent: *\nAllow: /' };
    if (url === 'https://careers.example.test/') return {
      status: 200,
      body: `<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting',
        title: 'AI Engineer',
        datePosted: '2026-07-23',
        description: 'Full-time AI Engineer role in Pune for 0-1 years using Python.',
        hiringOrganization: { name: 'Career Site Startup' },
        jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
        sameAs: 'https://careers.example.test/jobs/ai-engineer',
      })}</script>`,
    };
    if (url === 'https://careers.example.test/sitemap.xml') return { status: 404, body: '' };
    throw new Error(`unexpected career request: ${url}`);
  };
  const plans = buildSourcePlans({
    config: { sources: { startup: { companyCareers: [{ company: 'Career Site Startup', websiteUrl: 'https://careers.example.test/' }] } } },
    transport,
    runAt: '2026-07-24T10:00:00.000Z',
    schedule: 'morning',
    profile: { mode: 'startup' },
  });

  const result = await plans.find(({ id }) => id === 'startup-mode').fetch({});
  const lane = result.manifest.telemetry.lanes.find(({ sourceId }) => sourceId === 'startup-company-careers');

  assert.ok(requests.length >= 2);
  assert.equal(lane.status, 'ok');
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].startupLaneId, 'startup-company-careers');
  assert.equal(result.observations[0].company, 'Career Site Startup');

  const emptyPlans = buildSourcePlans({
    config: { sources: { startup: { companyCareers: [] } } },
    transport,
    runAt: '2026-07-24T10:00:00.000Z',
    schedule: 'morning',
    profile: { mode: 'normal' },
  });
  const emptyResult = await emptyPlans.find(({ id }) => id === 'startup-company-careers').fetch({});
  assert.equal(emptyResult.manifest.status, 'empty');
  assert.equal(emptyResult.manifest.reason, 'no-company-career-sites-configured');
});

test('india-startup lane requests include ATS-domain, role-family, geography, and entry-level dimensions', () => {
  const requests = buildIndiaStartupLaneRequests({
    indiaStartup: {
      requests: [],
      queryBudget: 20,
      dimensionQueryBudget: 12,
      roles: ['AI Engineer'],
      geographies: ['Pune', 'India'],
      experiences: ['fresher'],
      ats: ['boards.greenhouse.io', 'jobs.lever.co'],
      career: ['careers'],
      startup: ['startup'],
      vc: ['Peak XV portfolio'],
      watchlist: 'config/vc-portfolio-watchlist.json',
    },
  });
  const queries = requests.map((request) => request.query);
  assert.ok(queries.some((query) => /site:boards\.greenhouse\.io|site:jobs\.lever\.co|site:myworkdayjobs\.com|site:jobs\.ashbyhq\.com/.test(query)));
  assert.ok(queries.some((query) => /AI Engineer|ML Engineer|Backend Engineer|Software Engineer/.test(query)));
  assert.ok(queries.some((query) => /\bPune\b|\bIndia\b/.test(query)));
  assert.ok(queries.some((query) => /fresher|0-2|new grad|careers/.test(query)));
});

test('dormant sources.brave.queries expands into a real brave-search workflow plan from dimensions', async () => {
  const previous = process.env.BRAVE_SEARCH_API_KEY;
  process.env.BRAVE_SEARCH_API_KEY = 'test-key-not-real';
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-brave-lane-'));
  try {
    const braveConfig = {
      enabled: true,
      apiKeyEnv: 'BRAVE_SEARCH_API_KEY',
      dailyBudget: 3,
      perQueryResultCap: 5,
      country: 'IN',
      roles: ['AI Engineer'],
      geographies: ['India'],
      experiences: ['fresher'],
      ats: ['boards.greenhouse.io'],
      career: ['careers'],
      startup: ['startup'],
      vc: ['Peak XV portfolio'],
      queries: [],
    };
    const queries = listBraveQueries(braveConfig);
    assert.ok(queries.length > 0);
    assert.ok(queries.some((query) => /site:boards\.greenhouse\.io/.test(query)));
    assert.ok(queries.some((query) => /AI Engineer/.test(query)));
    assert.ok(queries.some((query) => /India|fresher/.test(query)));

    const transportCalls = [];
    const store = openCrawlerStore(path.join(root, 'crawler.sqlite'));
    try {
      const result = await crawlWorkflow({
        store,
        runId: 'brave-lane-test',
        schedule: 'morning',
        config: { sources: { brave: braveConfig } },
        clock: { now: () => '2026-07-24T10:00:00.000Z' },
        sourcePlans: [],
        brave: { ...braveConfig, queries },
        braveOptions: { country: 'IN' },
        braveTransport: async (query, meta = {}) => {
          transportCalls.push({ query, country: meta.country });
          return {
            status: 200,
            body: { web: { results: [{ title: 'AI Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1' }] } },
          };
        },
      });
      assert.ok(transportCalls.length > 0, 'brave-search plan must execute when enabled');
      assert.ok(transportCalls.every((call) => call.country === 'IN'));
      assert.ok(queries.every((query) => typeof query === 'string' && query.length > 0));
      assert.ok(result.observations.length >= 0);
    } finally {
      store.close();
    }
  } finally {
    if (previous === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = previous;
  }
});

test('SearXNG transport preserves unresponsive_engines so zero-result degradation is observable', async () => {
  const plans = buildSourcePlans({
    config: {
      sources: {
        searxng: {
          enabled: true,
          endpoint: 'http://127.0.0.1:8080',
          queries: ['AI Engineer India fresher'],
          perQueryResultCap: 10,
          dailyBudget: 1,
        },
        indiaStartup: { enabled: false },
        brave: { enabled: false },
      },
    },
    transport: async () => ({
      status: 200,
      body: JSON.stringify({
        results: [],
        unresponsive_engines: [['brave', 'too many requests'], ['duckduckgo', 'timeout']],
      }),
    }),
    runAt: '2026-07-24T10:00:00.000Z',
    schedule: 'morning',
    resolver: async () => null,
  });

  const searxPlan = plans.find((plan) => plan.id === 'searxng-search');
  assert.ok(searxPlan);
  const result = await searxPlan.fetch({});
  assert.equal(result.receipts[0].status, 'degraded');
  assert.equal(result.manifest.telemetry.engineHealth, 'degraded');
  assert.deepEqual(result.manifest.telemetry.unresponsiveEngines, [
    ['brave', 'too many requests'],
    ['duckduckgo', 'timeout'],
  ]);
});

test('bounded planner state is retained in the crawler source record after a completed pass', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-planner-'));
  const config = {
    schemaVersion: 'LaunchpadCrawlerConfigV1',
    databasePath: path.join(root, 'crawler.sqlite'),
    sourcePlanner: { enabled: true, maxBoards: 1, priorityShare: 0.8, explorationShare: 0.2 },
    sources: {
      atsWarm: { boards: [] },
      atsBatch1: { boards: [
        { provider: 'workable', slug: 'explore-a', company: 'Explore A', sourceTier: 'exploration' },
        { provider: 'workable', slug: 'explore-b', company: 'Explore B', sourceTier: 'exploration' },
      ] },
    },
  };
  const selectedBoardIds = (boardPlan) => (boardPlan?.decisions ?? [])
    .filter((decision) => ['selected', 'resumed'].includes(decision.action))
    .map((decision) => decision.boardId);
  const transport = async () => ({ status: 200, body: { jobs: [] } });
  let partialBudgetChecks = 0;
  const partial = await runCrawlerOperator({
    config,
    runId: 'planner-durable-state',
    transport,
    clock: { now: () => '2026-08-21T10:00:00.000Z' },
    deadline: { remainingMs: () => partialBudgetChecks++ === 0 ? 10_000 : 0 },
  });
  assert.equal(partial.run.status, 'partial');
  const firstPlan = partial.sourceTelemetry['ats-warm'].boardPlan;
  assert.deepEqual(selectedBoardIds(firstPlan), ['workable:explore-a']);

  const resumed = await runCrawlerOperator({
    config,
    runId: 'planner-durable-state',
    transport,
    clock: { now: () => '2026-08-21T10:00:00.000Z' },
    deadline: { remainingMs: () => 10_000 },
  });
  assert.equal(resumed.run.status, 'completed');
  assert.deepEqual(selectedBoardIds(resumed.sourceTelemetry['ats-warm'].boardPlan), ['workable:explore-a']);

  const later = await runCrawlerOperator({
    config,
    runId: 'planner-durable-state-next',
    transport,
    clock: { now: () => '2026-08-22T10:00:00.000Z' },
    deadline: { remainingMs: () => 10_000 },
  });
  assert.equal(later.run.status, 'completed');
  assert.deepEqual(selectedBoardIds(later.sourceTelemetry['ats-warm'].boardPlan), ['workable:explore-b']);
  const plan = later.sourceTelemetry['ats-warm'].boardPlan;
  assert.equal(plan.noWrite, true);
  const row = later.sourceTelemetry['ats-warm'].sourcePlanState;
  assert.equal(row.schemaVersion, 'BoundedBoardPlanStateV1');
  assert.deepEqual(row.trackedAts.coverage.selectedBoardIds, []);
  assert.equal(row.trackedAts.rotation.cursor, 0);
});

// Exercise the morning inbox through the source-plan and real resolver interfaces.
test('morning reads pasted hiring posts and resolves employer links like connector leads', async () => {
  const inboxDir = mkdtempSync(path.join(os.tmpdir(), 'launchpad-hiring-posts-'));
  const file = path.join(inboxDir, 'hiring-posts.md');
  const postUrl = 'https://www.linkedin.com/posts/acme-ai-hiring';
  const employerUrl = 'https://boards.greenhouse.io/acme/jobs/123';
  const pastedText = `Company: Acme Labs\nTitle: AI Engineer\nLocation: Pune, India\nWe are hiring early-career engineers. Apply: ${employerUrl}`;
  writeFileSync(file, `${postUrl}\n\n${pastedText}\n\n---\nhttps://x.com/founder/status/456\n\nWe are hiring. DM for details.\n`);
  const runAt = '2026-10-08T02:15:00.000Z';
  const requests = [];
  const transport = async (url, options) => {
    requests.push({ url, options });
    assert.equal(url, employerUrl);
    return { status: 200, body: { title: 'AI Engineer', company: 'Acme Labs', location: 'Pune, India',
      description: 'Full-time AI engineering. Build Python services. 0-1 years of experience.',
      employmentType: 'FULL_TIME', datePosted: '2026-10-07', active: true } };
  };
  const config = { sources: { connectorInbox: { enabled: false, inboxDir } } };
  const resolver = createCrawlerRunResolver({ config, transport, runAt });
  const plansFor = (schedule) => buildSourcePlans({ config, transport, resolver, runAt, schedule });
  const plan = plansFor('morning').find((item) => item.id === 'connector-inbox');
  assert.ok(plan, 'morning includes the local Markdown inbox even when JSON connectors are disabled');
  const result = await plan.fetch();
  assert.equal(result.observations.length, 2);
  const [resolved, held] = result.observations;
  assert.equal(resolved.originalApplicationUrl, employerUrl);
  assert.equal(resolved.discoveryUrl, postUrl);
  assert.equal(resolved.applicationResolution.status, 'Resolved Original');
  assert.equal(resolved.classification, 'direct');
  assert.equal(resolved.evidence.hiringPost.pastedText, pastedText);
  assert.match(resolved.description, /Build Python services/);
  assert.equal(held.applicationResolution.status, 'Needs Verification');
  assert.equal(held.shortlistEligible, false);
  assert.equal(held.originalApplicationUrl, null);
  assert.deepEqual(requests.map((request) => request.url), [employerUrl]);
  assert.equal(plansFor('midday').some((item) => item.id === 'connector-inbox'), false);
  // Unchanged entries are reverified on the next morning, not lost to file receipts.
  assert.equal((await plan.fetch()).observations.length, 2);
});

// Preserve the no-login option at the actual HTTP boundary without live network.
test('HTTP transport omits credentials when resolving pasted hiring posts', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response('Public employer detail', { status: 200 });
  });
  const result = await defaultHttpTransport('https://boards.greenhouse.io/acme/jobs/123', { credentials: 'omit', redirect: 'manual' });
  assert.equal(result.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.equal(requests[0].options.headers, undefined);
});

const heldOverlapLead = {
  provider: 'linkedin-jobs', providerJobId: '765433', jobId: '765433', company: 'Acme Labs', title: 'AI Engineer',
  location: 'Pune, India', discoveryUrl: 'https://www.linkedin.com/jobs/view/765433', canonicalUrl: 'https://www.linkedin.com/jobs/view/765433',
};
const heldOverlapCard = '<li><h3 class="base-search-card__title">AI Engineer</h3><h4 class="base-search-card__subtitle"><a>Acme Labs</a></h4><span class="job-search-card__location">Pune, India</span><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/765433"></a><time datetime="2026-10-20"></time></li>';

test('an ordinary 429 on a due held lead keeps its Retry-After backoff for the next reopened run', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'held-ordinary-backoff-'));
  const config = { schemaVersion: 'LaunchpadCrawlerConfigV1', databasePath: path.join(root, 'crawler.sqlite'),
    opportunityLedgerPath: path.join(root, 'absent-ledger.tsv'),
    sources: { portals: { enabled: false, maxResolverRequests: 30, resolverConcurrency: 1 } } };
  const clockAt = (now) => ({ now: () => now, sleep: async () => {} });
  await runCrawlerOperator({ config, schedule: 'morning', runId: 'held-503', heldPortalLeads: [heldOverlapLead],
    clock: clockAt('2026-10-20T08:00:00.000Z'), transport: async () => ({ status: 503, body: 'temporary failure' }) });
  config.sources.portals = { enabled: true, maxResolverRequests: 30, resolverConcurrency: 1,
    http: { providers: ['linkedin-jobs'] }, linkedin: { queries: [{ keywords: 'AI Engineer', location: 'Pune' }] } };
  await runCrawlerOperator({ config, schedule: 'morning', runId: 'ordinary-429', clock: clockAt('2026-10-20T10:00:00.000Z'),
    transport: async (url) => {
      if (url.includes('jobs-guest')) return { status: 200, body: heldOverlapCard };
      if (new URL(url).hostname === 'www.linkedin.com') return { status: 302, headers: { location: 'https://boards.greenhouse.io/acme/jobs/765433' }, body: '' };
      return { status: 429, headers: { 'Retry-After': '86400' }, body: 'rate limited' };
    } });
  config.sources.portals.enabled = false;
  const requests = [];
  await runCrawlerOperator({ config, schedule: 'morning', runId: 'held-one-minute-later', clock: clockAt('2026-10-20T10:01:00.000Z'),
    transport: async (url) => {
      requests.push(url);
      if (new URL(url).hostname === 'www.linkedin.com') return { status: 302, headers: { location: 'https://boards.greenhouse.io/acme/jobs/765433' }, body: '' };
      return { status: 503, body: 'temporary failure' };
    } });
  assert.deepEqual(requests, [], 'an ordinary attempt Retry-After must hold the held lead back');
});

const retainedRateLimitedLead = {
  provider: 'linkedin-jobs', providerJobId: '765433', jobId: '765433', company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India',
  discoveryUrl: 'https://www.linkedin.com/jobs/view/765433', canonicalUrl: 'https://www.linkedin.com/jobs/view/765433',
  evidence: { httpStatus: 429, retryAfterAt: '2026-10-20T09:00:00.000Z',
    portalDetail: { status: 'extracted', applicationTargets: ['https://boards.greenhouse.io/acme/jobs/765433'] },
    recovery: { kind: 'held-lead-recovery', outcome: 'pending', attemptCount: 1, nextEligibleAt: '2026-10-20T09:00:00.000Z' } },
};

async function retryRetainedHeldLead(response) {
  const result = await buildSourcePlans({ config: { sources: { portals: { enabled: false } } }, runAt: '2026-10-20T10:00:00.000Z',
    schedule: 'morning', clock: { currentTime: () => '2026-10-20T10:00:00.000Z' }, heldPortalLeads: [retainedRateLimitedLead],
    transport: async () => { throw new Error('unexpected discovery'); },
    resolver: createOriginalListingResolver({ transport: async () => response }) })
    .find(({ id }) => id === 'portal-discovery').fetch();
  return result.observations[0];
}

test('a fresh 403 after a retained 429 is policy-rejected instead of pending', async () => {
  const row = await retryRetainedHeldLead({ status: 403, body: 'access denied' });
  assert.equal(row.evidence.httpStatus, 403);
  assert.equal(row.evidence.recovery.outcome, 'policy-rejected');
});

test('a fresh 503 after a retained 429 stays pending with a new backoff deadline', async () => {
  const row = await retryRetainedHeldLead({ status: 503, body: 'temporary failure' });
  assert.equal(row.evidence.httpStatus, 503);
  assert.equal(row.evidence.recovery.outcome, 'pending');
  assert.equal(row.evidence.recovery.attemptCount, 2);
  assert.ok(Date.parse(row.evidence.recovery.nextEligibleAt) > Date.parse('2026-10-20T10:00:00.000Z'));
});

test('slow held-lead recovery leaves ordinary discovery its share of the resolver phase', async () => {
  const runAt = '2026-10-20T10:00:00.000Z';
  let monotonic = 0;
  const resolverUrls = [];
  const posting = (id) => `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
    hiringOrganization: { name: 'Acme Labs' },
    description: 'Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience.',
    jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
    datePosted: '2026-10-19', employmentType: 'FULL_TIME', identifier: { name: 'Acme Labs', value: id },
  })}</script>`;
  const resolver = createOriginalListingResolver({ runAt, transport: async (url) => {
    const parsed = new URL(url);
    const id = parsed.pathname.split('/').at(-1);
    resolverUrls.push(url);
    if (id === 'slow-1') monotonic += 31_000;
    if (parsed.hostname === 'www.glassdoor.com' || parsed.hostname === 'www.linkedin.com') {
      return { status: 302, headers: { location: `https://boards.greenhouse.io/acme/jobs/${id}` }, body: '' };
    }
    return { status: 200, body: posting(id) };
  } });
  const heldLead = (id) => ({ provider: 'glassdoor', providerJobId: id, jobId: id, company: 'Acme Labs', title: 'AI Engineer',
    discoveryUrl: `https://www.glassdoor.com/job-listing/${id}`, canonicalUrl: `https://www.glassdoor.com/job-listing/${id}` });
  const config = { sources: { portals: { enabled: true, maxCandidates: 12, maxResolverRequests: 30, resolverConcurrency: 1,
    resolverMaxDurationMs: 60_000, http: { providers: ['linkedin-jobs'] }, linkedin: { queries: [{ keywords: 'AI Engineer', location: 'Pune' }] } } } };
  const result = await buildSourcePlans({ config, runAt, schedule: 'morning', clock: { monotonicNow: () => monotonic, currentTime: () => runAt },
    transport: async (url) => url.includes('jobs-guest') ? { status: 200, body: heldOverlapCard } : { status: 500, body: '' },
    resolver, heldPortalLeads: [heldLead('slow-1'), heldLead('slow-2')] })
    .find(({ id }) => id === 'portal-discovery').fetch();
  const ordinary = result.observations.find(({ jobId }) => jobId === '765433');
  assert.ok(resolverUrls.some((url) => url.includes('/765433')), 'ordinary discovery must get a resolver request');
  assert.notEqual(ordinary.evidence.resolution.reason, 'deadline-exceeded', JSON.stringify(ordinary.evidence.resolution));
  assert.match(ordinary.originalApplicationUrl ?? '', /765433/, JSON.stringify(ordinary.evidence.resolution));
  assert.equal(resolverUrls.some((url) => url.includes('slow-2')), false, 'a held lead not started within the recovery share must wait');
  const heldTelemetry = result.manifest.telemetry.heldLeadRecovery;
  assert.equal(heldTelemetry.unattempted, 1);
  assert.equal(heldTelemetry.failed, 0);
  assert.equal(heldTelemetry.continuation, true);
  assert.equal(heldTelemetry.outcomes.find(({ lead }) => lead === 'slow-2').recoveryState, 'pending');
});
