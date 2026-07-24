import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSourcePlans,
  buildCrawlerHelp,
  createCrawlerRunResolver,
  runCrawlerOperator,
  validateCrawlerConfig,
} from '../../crawler/operator.mjs';
import { HIMALAYAS_SEARCH_URL } from '../../job-pull/remote-adapters/himalayas.mjs';
import { JOBICY_FEED_URL } from '../../job-pull/remote-adapters/jobicy.mjs';
import { WWR_FEED_URL } from '../../job-pull/remote-adapters/weworkremotely.mjs';
import { REMOTIVE_FEED_URL } from '../../job-pull/remote-adapters/remotive.mjs';

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

test('remote-mode buildSourcePlans wires real fetchJson/fetchText into all four native providers and yields real candidates', async () => {
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
  assert.ok(requestedUrls.some((url) => url.startsWith(HIMALAYAS_SEARCH_URL)));

  const companies = result.observations.map((observation) => observation.company);
  assert.ok(companies.includes('Himalayas Co'));
  assert.ok(companies.includes('Jobicy Co'));
  assert.ok(companies.includes('Remotive Co'));
  assert.ok(result.observations.some((observation) => observation.title === 'Full Stack Engineer'));

  const laneManifests = result.manifest.telemetry.lanes;
  for (const provider of ['himalayas', 'jobicy', 'weworkremotely', 'remotive']) {
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
