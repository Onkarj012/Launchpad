import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverBraveSearch,
  buildBraveQueries,
  DEFAULT_BRAVE_DIMENSIONS,
} from '../../crawler/brave-search.mjs';
import { resolveJobIdentity } from '../../crawler/identity.mjs';

const brave = (results) => ({ status: 200, body: { web: { results } } });
const searxng = (results, unresponsive_engines = []) => ({ status: 200, body: { results, unresponsive_engines } });
const results = [
  { title: 'AI Engineer - Acme', url: 'https://boards.greenhouse.io/acme/jobs/1', description: 'AI Engineer Pune' },
  { title: 'AI Engineer - Acme', url: 'https://boards.greenhouse.io/acme/jobs/1?utm_source=brave', description: 'duplicate' },
  { title: 'AI Engineer - Acme', url: 'https://acme.example/careers/ai-engineer', description: 'Apply on the company site' },
  { title: 'AI Engineer hiring post', url: 'https://www.linkedin.com/jobs/view/55', description: 'A hiring post snippet' },
  { title: 'AI Engineer listing', url: 'https://unknown.example/jobs/9', description: 'Unresolved result' },
];

test('builds bounded deterministic queries and enforces the daily budget', async () => {
  const calls = [];
  const result = await discoverBraveSearch({
    runAt: '2026-07-23T10:00:00Z',
    transport: async (query) => { calls.push(query); return brave(results.slice(0, 2)); },
    roles: ['AI Engineer'], geographies: ['Pune'], experiences: ['fresher'],
    ats: ['Greenhouse'], career: ['careers'], startup: ['startup'], vc: ['portfolio'],
    maxQueries: 2, dailyBudget: 2, perQueryResultCap: 1,
  });
  assert.equal(calls.length, 2);
  assert.equal(result.receipts.length, 2);
  assert.ok(result.receipts.every((receipt) => receipt.resultCap === 1));
  assert.equal(result.manifest.telemetry.budgetUsed, 2);
  assert.equal(new Set(result.receipts.map((receipt) => receipt.query)).size, 2);
});

test('deduplicates queries/results and classifies direct, LinkedIn, and unresolved leads', async () => {
  const result = await discoverBraveSearch({
    transport: async () => brave(results),
    queries: ['same query', 'same query'], dailyBudget: 1, perQueryResultCap: 10,
  });
  assert.equal(result.observations.length, 4);
  assert.equal(result.observations.find((row) => row.canonicalUrl.includes('greenhouse')).classification, 'direct');
  assert.equal(result.observations.find((row) => row.canonicalUrl.includes('linkedin')).classification, 'lead');
  assert.equal(result.observations.find((row) => row.canonicalUrl.includes('unknown')).classification, 'unresolved');
  assert.equal(result.manifest.telemetry.duplicateQueries, 1);
  assert.equal(result.manifest.telemetry.duplicateResults, 1);
  assert.ok(result.verificationQueue.some((item) => item.reason === 'unresolved-lead'));
  assert.equal(result.observations.find((row) => row.canonicalUrl.includes('unknown')).evidence.verified, false);
});

test('promotes a lead only when the injected resolver verifies an original listing and enriches entities', async () => {
  const result = await discoverBraveSearch({
    transport: async () => brave([{ title: 'Backend Engineer', url: 'https://search.example/r', description: 'snippet' }]),
    queries: ['backend'],
    resolveOriginalListing: async (observation) => observation.canonicalUrl.endsWith('/r')
      ? { url: 'https://jobs.lever.co/acme/2', company: 'Acme' } : null,
    enrichCompany: async () => ({ company: 'Acme', websiteUrl: 'https://acme.example' }),
    enrichBoard: async () => ({ board: 'Lever', url: 'https://jobs.lever.co/acme/2' }),
  });
  assert.equal(result.observations[0].classification, 'direct');
  assert.equal(result.observations[0].originalApplicationUrl, 'https://jobs.lever.co/acme/2');
  assert.equal(result.observations[0].applicationResolution.status, 'Resolved Original');
  assert.deepEqual(result.discoveredCompanies[0], { company: 'Acme', websiteUrl: 'https://acme.example' });
  assert.deepEqual(result.discoveredBoards[0], { board: 'Lever', url: 'https://jobs.lever.co/acme/2' });
});

test('records malformed responses and retryable/terminal transport outcomes without network access', async () => {
  const calls = [];
  const result = await discoverBraveSearch({
    queries: ['bad', 'retry', 'terminal'], dailyBudget: 3,
    transport: async (query) => {
      calls.push(query);
      if (query === 'bad') return { status: 200, body: { nope: true } };
      if (query === 'retry') return { status: 503, body: {} };
      throw Object.assign(new Error('offline'), { code: 'ENETUNREACH' });
    }, retry: { maxAttempts: 2 },
  });
  assert.equal(calls.length, 4);
  assert.equal(result.observations.length, 0);
  assert.equal(result.manifest.telemetry.malformedResponses, 1);
  assert.equal(result.manifest.telemetry.retryable, 1);
  assert.equal(result.manifest.telemetry.terminal, 1);
  assert.deepEqual(result.receipts.map((receipt) => receipt.status), ['malformed', 'retryable', 'terminal']);
});

test('returns serialization-friendly receipts and manifest telemetry', async () => {
  const result = await discoverBraveSearch({ transport: async () => brave([]), queries: ['one'] });
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(result.manifest.schemaVersion, 'BraveSearchManifestV1');
  assert.equal(result.receipts[0].observations, 0);
  assert.equal(buildBraveQueries({ queries: ['x', 'x'] }).length, 1);
});

test('marks an empty SearXNG response degraded and exposes the source status', async () => {
  const result = await discoverBraveSearch({
    provider: 'searxng',
    transport: async () => searxng([], [['brave', 'too many requests']]),
    queries: ['AI Engineer'],
  });
  assert.equal(result.receipts[0].status, 'degraded');
  assert.equal(result.manifest.status, 'degraded');
  assert.equal(result.manifest.telemetry.degradedQueries, 1);
});

test('preserves SearXNG engine and reason pairs in manifest telemetry', async () => {
  const unresponsive = [['brave', 'too many requests'], ['duckduckgo', 'CAPTCHA']];
  const result = await discoverBraveSearch({
    provider: 'searxng', transport: async () => searxng([], unresponsive), queries: ['AI Engineer'],
  });
  assert.deepEqual(result.manifest.telemetry.unresponsiveEngines, unresponsive);
  assert.deepEqual(result.receipts[0].unresponsiveEngines, unresponsive);
});

test('skips the remaining budget after a fully degraded first SearXNG query', async () => {
  const calls = [];
  const result = await discoverBraveSearch({
    provider: 'searxng', queries: ['one', 'two', 'three'], dailyBudget: 3,
    configuredEngines: ['brave', 'duckduckgo'],
    transport: async (query) => { calls.push(query); return searxng([], [['brave', 'too many requests'], ['duckduckgo', 'CAPTCHA']]); },
  });
  assert.deepEqual(calls, ['one']);
  assert.equal(result.manifest.telemetry.queriesSkipped, 2);
  assert.equal(result.manifest.telemetry.skippedReason, 'first-query-fully-degraded');
  assert.deepEqual(result.receipts.slice(1).map((receipt) => receipt.status), ['skipped', 'skipped']);
  assert.ok(result.receipts.slice(1).every((receipt) => receipt.reason === 'first-query-fully-degraded'));
});

test('leaves healthy SearXNG responses successful', async () => {
  const result = await discoverBraveSearch({
    provider: 'searxng', transport: async () => searxng(results.slice(0, 1), []), queries: ['AI Engineer'],
  });
  assert.equal(result.receipts[0].status, 'success');
  assert.equal(result.manifest.status, undefined);
  assert.equal(result.manifest.telemetry.degradedQueries, 0);
});

test('does not interpret unresponsive_engines on a Brave API response', async () => {
  const result = await discoverBraveSearch({
    transport: async () => ({ status: 200, body: { web: { results: [] }, unresponsive_engines: [['brave', 'too many requests']] } }),
    queries: ['AI Engineer'],
  });
  assert.equal(result.receipts[0].status, 'success');
  assert.equal(result.manifest.status, undefined);
  assert.equal(result.manifest.telemetry.degradedQueries, 0);
  assert.deepEqual(result.manifest.telemetry.unresponsiveEngines, []);
});

test('default Brave query dimensions cover ATS domain, role family, geography, and entry-level', () => {
  const queries = buildBraveQueries({ maxQueries: 20 });
  assert.ok(queries.some((query) => /site:boards\.greenhouse\.io|site:jobs\.lever\.co|site:myworkdayjobs\.com|site:jobs\.ashbyhq\.com/.test(query)));
  assert.ok(queries.some((query) => /AI Engineer|ML Engineer|Backend Engineer|Software Engineer/.test(query)));
  assert.ok(queries.some((query) => /\bPune\b|\bIndia\b/.test(query)));
  assert.ok(queries.some((query) => /fresher|0-2 years|new grad/.test(query)));
  assert.ok(queries.some((query) => /startup|portfolio/.test(query)));
  assert.ok(DEFAULT_BRAVE_DIMENSIONS.ats.includes('boards.greenhouse.io'));
});

test('search-derived page_age never becomes trusted postedAt; it only boosts discovery priority', async () => {
  const result = await discoverBraveSearch({
    transport: async () => brave([{
      title: 'AI Engineer',
      url: 'https://boards.greenhouse.io/acme/jobs/77',
      description: 'Build agents',
      page_age: '2026-07-20T00:00:00.000Z',
    }]),
    queries: ['AI Engineer India'],
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].postedAt, null);
  assert.equal(result.observations[0].evidence.searchAgeTrustedPostedAt, false);
  assert.equal(result.observations[0].evidence.searchAge, '2026-07-20T00:00:00.000Z');
  assert.equal(result.observations[0].discoveryPriorityAt, '2026-07-20T00:00:00.000Z');
});

test('Brave-sourced direct ATS hits create proposal-only board promotions when the threshold is met', async () => {
  const result = await discoverBraveSearch({
    transport: async () => brave([{
      title: 'Backend Engineer',
      url: 'https://boards.greenhouse.io/newcoindia/jobs/1',
      description: 'Pune role',
      company: 'NewCo India',
    }]),
    queries: ['Backend Engineer India'],
    boardPromotion: { minOccurrences: 1, minDistinctDates: 1 },
    runAt: '2026-07-24T10:00:00.000Z',
  });
  assert.equal(result.boardProposals.length, 1);
  const board = result.boardProposals[0].suggestedBoard;
  assert.equal(board.enabled, false);
  assert.equal(board.activationState, 'proposed');
  assert.equal(board.provider, 'greenhouse');
  assert.equal(board.slug, 'newcoindia');
  assert.equal(result.discoveredBoards.some((entry) => entry.activationState === 'proposed'), true);
});

test('Brave-search and direct-ATS observations of the same job converge on one identity', async () => {
  const braveResult = await discoverBraveSearch({
    transport: async () => brave([{
      title: 'AI Engineer',
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      description: 'Build reliable AI systems for customers.',
      company: 'Acme, Inc.',
    }]),
    queries: ['AI Engineer'],
    runAt: '2026-07-23T10:00:00.000Z',
  });
  const fromBrave = braveResult.observations[0];
  const fromDirectAts = {
    provider: 'Greenhouse',
    providerJobId: '123',
    canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/123',
    company: 'Acme, Inc.',
    title: 'AI Engineer',
    location: 'Pune, India',
    description: 'Build reliable AI systems for customers.',
    observedAt: '2026-07-23T11:00:00.000Z',
    postedAt: '2026-07-22T10:00:00.000Z',
    status: 'open',
  };
  const first = resolveJobIdentity(fromBrave, {});
  const second = resolveJobIdentity(fromDirectAts, {
    existingJobs: [{
      jobKey: first.identity.jobKey,
      provider: 'greenhouse',
      providerJobId: null,
      canonicalUrl: fromBrave.canonicalUrl,
      company: 'acme inc',
      title: 'ai engineer',
      location: 'pune, india',
      fingerprint: first.fingerprint,
      firstSeenAt: '2026-07-23T10:00:00.000Z',
      lastSeenAt: '2026-07-23T10:00:00.000Z',
    }],
  });
  assert.equal(first.code, 'NEW_TO_ME');
  assert.equal(second.identity.jobKey, first.identity.jobKey);
  assert.equal(second.evidence.matchType, 'canonical_url');
  assert.notEqual(second.code, 'NEW_TO_ME');
});

test('query budget, country localization, caching, and consumed-credits telemetry are visible', async () => {
  const cache = new Map();
  const calls = [];
  const transport = async (query, meta = {}) => {
    calls.push({ query, country: meta.country, offset: meta.offset });
    return brave(results.slice(0, 1));
  };
  const first = await discoverBraveSearch({
    transport, queries: ['one', 'two'], dailyBudget: 2, cache, country: 'IN', maxPages: 1,
  });
  const second = await discoverBraveSearch({
    transport, queries: ['one', 'two'], dailyBudget: 2, cache, country: 'IN', maxPages: 1,
  });
  assert.equal(first.manifest.telemetry.country, 'IN');
  assert.equal(first.manifest.telemetry.budgetUsed, 2);
  assert.equal(first.manifest.telemetry.consumedCredits, 2);
  assert.equal(first.manifest.telemetry.cacheMisses, 2);
  assert.equal(first.manifest.telemetry.pagesFetched, 2);
  assert.equal(second.manifest.telemetry.cacheHits, 2);
  assert.equal(second.manifest.telemetry.cacheMisses, 0);
  assert.ok(calls.every((call) => call.country === 'IN'));
  assert.equal(calls.length, 2);
});

test('SearXNG healthy-empty zero-result is distinct from unresponsive-engine degradation', async () => {
  const healthy = await discoverBraveSearch({
    provider: 'searxng',
    transport: async () => searxng([], []),
    queries: ['AI Engineer Pune'],
  });
  assert.equal(healthy.receipts[0].status, 'success');
  assert.equal(healthy.manifest.telemetry.engineHealth, 'healthy-empty');
  assert.equal(healthy.manifest.telemetry.degradedQueries, 0);
  assert.deepEqual(healthy.manifest.telemetry.unresponsiveEngines, []);

  const degraded = await discoverBraveSearch({
    provider: 'searxng',
    transport: async () => searxng([], [['google', 'timeout'], ['brave', 'too many requests']]),
    queries: ['AI Engineer Pune'],
  });
  assert.equal(degraded.receipts[0].status, 'degraded');
  assert.equal(degraded.manifest.telemetry.engineHealth, 'degraded');
  assert.equal(degraded.manifest.telemetry.degradedQueries, 1);
  assert.deepEqual(degraded.manifest.telemetry.unresponsiveEngines, [['google', 'timeout'], ['brave', 'too many requests']]);
});
