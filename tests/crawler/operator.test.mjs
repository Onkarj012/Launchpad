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
  runCrawlerOperator,
  validateCrawlerConfig,
} from '../../crawler/operator.mjs';
import { crawlWorkflow } from '../../crawler/workflow.mjs';
import { openCrawlerStore } from '../../crawler/run.mjs';
import { HIMALAYAS_SEARCH_URL } from '../../job-pull/remote-adapters/himalayas.mjs';
import { JOBICY_FEED_URL } from '../../job-pull/remote-adapters/jobicy.mjs';
import { WWR_FEED_URL } from '../../job-pull/remote-adapters/weworkremotely.mjs';
import { REMOTIVE_FEED_URL } from '../../job-pull/remote-adapters/remotive.mjs';
import { REMOTEOK_FEED_URL } from '../../job-pull/remote-adapters/remoteok.mjs';

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

  assert.deepEqual(plans.map((plan) => plan.id), ['indeed-inbox', 'searxng-search']);
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

test('operator resolver receives the parent signal and absolute deadline', async () => {
  const controller = new AbortController();
  const deadline = { deadlineMs: Date.now() + 10_000, remainingMs: 10_000 };
  const seen = [];
  const resolve = createCrawlerRunResolver({
    config: { sources: { originalListingResolver: { maxRequests: 1 } } },
    runAt: '2026-07-24T10:00:00.000Z', signal: controller.signal, deadline,
    transport: async (_url, options) => { seen.push(options); throw new Error('offline fixture'); },
  });
  await resolve({ canonicalUrl: 'https://www.indeed.com/viewjob?id=deadline' });
  assert.equal(seen[0].signal, controller.signal);
  assert.equal(seen[0].deadline, deadline);
  assert.equal(seen[0].remainingMs, 10_000);
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
