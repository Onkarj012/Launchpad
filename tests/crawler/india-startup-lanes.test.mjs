import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INDIA_STARTUP_LANES,
  buildIndiaStartupRequests,
  discoverIndiaStartupLanes,
} from '../../crawler/india-startup-lanes.mjs';
import {
  loadVcPortfolioWatchlist,
  buildVcWatchlistRequests,
} from '../../crawler/vc-portfolio-watchlist.mjs';

const runAt = '2026-07-23T10:00:00Z';

test('builds stable, bounded requests for configured Indian and startup lanes', () => {
  const requests = buildIndiaStartupRequests({
    roles: ['AI Engineer', 'Backend Engineer'],
    geographies: ['India'],
    experiences: ['fresher'],
    sources: ['naukri', 'yc', 'yc'],
    queryBudget: 3,
    sourceBudgets: { naukri: 2, yc: 1 },
  });

  assert.deepEqual(requests.map(({ source, query }) => ({ source, query })), [
    { source: 'naukri', query: 'AI Engineer India fresher' },
    { source: 'naukri', query: 'Backend Engineer India fresher' },
    { source: 'yc', query: 'AI Engineer India fresher' },
  ]);
  assert.equal(INDIA_STARTUP_LANES.naukri.input, 'search');
  assert.equal(INDIA_STARTUP_LANES.yc.input, 'search');
});

test('normalizes injected records, deduplicates them, and distinguishes direct listings from leads', async () => {
  const calls = [];
  const result = await discoverIndiaStartupLanes({
    runAt,
    sources: ['cutshort', 'vc'],
    queries: ['AI Engineer India fresher'],
    transport: async (request) => {
      calls.push(request);
      return {
        status: 200,
        body: { results: [
          { title: 'AI Engineer', company: 'Acme', url: 'https://jobs.lever.co/acme/42', location: 'Pune', description: 'Build AI systems.' },
          { title: 'AI Engineer', company: 'Acme', url: 'https://jobs.lever.co/acme/42?utm_source=vc', description: 'duplicate' },
          { title: 'Founding Engineer', company: 'Seed Co', url: 'https://vc.example/portfolio/seed-co', description: 'Portfolio hiring lead.' },
        ] },
      };
    },
    queryBudget: 2,
    perRequestResultCap: 10,
  });

  assert.equal(calls.length, 2);
  assert.equal(result.observations.length, 2);
  assert.equal(result.observations[0].classification, 'direct');
  assert.equal(result.observations[0].sourceKind, 'ats-direct');
  assert.equal(result.observations[1].classification, 'lead');
  assert.equal(result.observations[1].evidence.verified, false);
  assert.ok(result.manifest.telemetry.duplicateRecords >= 1);
  assert.ok(result.verificationQueue.some((item) => item.reason === 'original-listing'));
});

test('accepts safe feed and connector inputs without using live network access', async () => {
  const calls = [];
  const result = await discoverIndiaStartupLanes({
    runAt,
    sources: [
      { id: 'hirist', input: 'feed', url: 'https://feed.example/jobs.xml' },
      { id: 'peerlist', input: 'connector', connector: 'peerlist-fixture' },
    ],
    transport: async (request) => {
      calls.push(request);
      return request.kind === 'feed'
        ? { status: 200, body: '<rss><item><title>ML Engineer</title><link>https://careers.acme.example/jobs/ml</link><description>India role</description></item></rss>' }
        : { status: 200, records: [{ title: 'Agent Engineer', company: 'Peer Co', url: 'https://peerlist.io/jobs/agent' }] };
    },
  });

  assert.deepEqual(calls.map((call) => call.kind), ['feed', 'connector']);
  assert.deepEqual(result.observations.map((row) => row.title), ['ML Engineer', 'Agent Engineer']);
  assert.equal(result.observations[0].classification, 'direct');
  assert.equal(result.observations[1].classification, 'lead');
  assert.equal(result.manifest.sources[0].input, 'feed');
  assert.equal(result.manifest.sources[1].input, 'connector');
});

test('records explicit unavailable and failed outcomes with source provenance', async () => {
  const result = await discoverIndiaStartupLanes({
    runAt,
    sources: [
      { id: 'instahyre', input: 'search' },
      { id: 'foundit', input: 'search' },
      { id: 'naukri', input: 'feed', url: 'https://feed.example/naukri.xml' },
    ],
    transport: async (request) => request.source === 'naukri'
      ? { status: 503, body: '' }
      : null,
    retry: { maxAttempts: 1 },
  });

  assert.equal(result.observations.length, 0);
  assert.equal(result.manifest.sources.find((source) => source.source === 'instahyre').status, 'unavailable');
  assert.equal(result.manifest.sources.find((source) => source.source === 'foundit').status, 'unavailable');
  assert.equal(result.manifest.sources.find((source) => source.source === 'naukri').status, 'retryable');
  assert.equal(result.manifest.telemetry.unavailable, 2);
  assert.equal(result.manifest.telemetry.retryable, 1);
  assert.ok(result.verificationQueue.every((item) => item.source));
});

test('rejects an omitted transport so this adapter cannot silently perform live network access', async () => {
  await assert.rejects(
    discoverIndiaStartupLanes({ sources: ['yc'] }),
    /requires injected transport/,
  );
});

test('consumes the live-verified VC portfolio watchlist as bounded vc-lane requests, seeding employer pages rather than fund pages', async () => {
  const watchlist = loadVcPortfolioWatchlist('config/vc-portfolio-watchlist.json');
  const vcRequests = buildVcWatchlistRequests(watchlist, { limit: 3 });
  const requests = buildIndiaStartupRequests({ requests: vcRequests });

  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.source, 'vc');
    assert.equal(request.kind, INDIA_STARTUP_LANES.vc.input);
    assert.ok(request.query);
  }

  const calls = [];
  const result = await discoverIndiaStartupLanes({
    runAt,
    requests: vcRequests,
    transport: async (request) => {
      calls.push(request.query);
      return { status: 200, body: { results: [
        { title: 'Backend Engineer', company: vcRequests[0].evidence.company, url: 'https://jobs.ashbyhq.com/portfolio-co/1', location: 'Pune' },
      ] } };
    },
  });

  assert.equal(calls.length, 3);
  assert.equal(result.observations[0].classification, 'direct');
  assert.ok(calls.every((query) => !query.includes(vcRequests[0].evidence.fundSourceUrl)));
});
