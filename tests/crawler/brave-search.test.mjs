import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverBraveSearch, buildBraveQueries } from '../../crawler/brave-search.mjs';

const brave = (results) => ({ status: 200, body: { web: { results } } });
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
