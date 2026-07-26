import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCompanyCareers } from '../../crawler/company-careers.mjs';
import { responses } from '../fixtures/crawler-careers/company-careers.mjs';

const transport = async (url) => responses[url] ?? { status: 404, headers: {}, body: '' };

test('discovers canonical links, sitemap metadata, feeds, JSON-LD variants, and enrichments deterministically', async () => {
  const result = await discoverCompanyCareers({
    companies: [{ company: 'Acme', websiteUrl: 'https://acme.example/' }],
    transport,
    runAt: '2026-07-23T10:00:00Z',
    expiryGraceDays: 0,
    hostLimiterOptions: { minSpacingMs: 0 },
  });

  assert.equal(result.observations.length, 4);
  assert.deepEqual(result.observations.map((row) => row.title), [
    'AI Engineer', 'Backend Engineer', 'Graph ML Engineer', 'RSS Lead',
  ]);
  const ai = result.observations.find((row) => row.title === 'AI Engineer');
  assert.equal(ai.schemaVersion, 'CandidateV1');
  assert.equal(ai.canonicalUrl, 'https://acme.example/jobs/ai-engineer');
  assert.equal(ai.originalApplicationUrl, 'https://jobs.acme.example/ai-engineer');
  assert.equal(ai.evidence.classification, 'direct');
  assert.equal(result.observations.find((row) => row.title === 'RSS Lead').evidence.classification, 'lead');
  assert.equal(result.discoveredBoards.length, 1);
  assert.equal(result.discoveredBoards[0].url, 'https://boards.example/acme/lead');
  assert.equal(result.discoveredBoards[0].classification, 'lead');
  assert.equal(result.manifest.sources[0].company, 'Acme');
  assert.ok(result.conditionalState['https://acme.example/']);
  assert.equal(result.telemetry.malformedJsonLd, 1);
  assert.equal(result.telemetry.duplicateUrls, 1);
});

test('tolerates transport errors and records explicit outcomes without network access', async () => {
  const result = await discoverCompanyCareers({
    companies: [{ company: 'Missing', websiteUrl: 'https://missing.example/' }],
    transport: async () => ({ status: 503, headers: {}, body: '' }),
    retry: { maxAttempts: 1 },
    runAt: '2026-07-23T10:00:00Z',
    hostLimiterOptions: { minSpacingMs: 0 },
  });
  assert.deepEqual(result.observations, []);
  assert.equal(result.telemetry.failed, 1);
  assert.equal(result.manifest.sources[0].status, 'retryable');
  assert.deepEqual(result.verificationQueue[0].reason, 'career-page-fetch');
});

test('discovers and enforces robots.txt before fetching disallowed job URLs', async () => {
  const calls = [];
  const result = await discoverCompanyCareers({
    company: 'Robots Co',
    websiteUrl: 'https://robots.example/',
    runAt: '2026-07-23T10:00:00.000Z',
    hostLimiterOptions: { minSpacingMs: 0 },
    transport: async (url) => {
      calls.push(url);
      if (url === 'https://robots.example/robots.txt') {
        return { status: 200, headers: {}, body: 'User-agent: *\nDisallow: /jobs' };
      }
      if (url === 'https://robots.example/sitemap.xml') {
        return { status: 200, headers: {}, body: '<urlset><url><loc>https://robots.example/jobs/private</loc><lastmod>2026-07-23</lastmod></url></urlset>' };
      }
      return { status: 200, headers: {}, body: '' };
    },
  });

  assert.equal(calls[0], 'https://robots.example/robots.txt');
  assert.equal(calls.includes('https://robots.example/jobs/private'), false);
  assert.equal(result.observations.length, 0);
  assert.ok(result.manifest.telemetry.disallowed >= 1);
});

test('caps page expansion per company and reports the truncated crawl', async () => {
  const calls = [];
  const result = await discoverCompanyCareers({
    company: 'Large Co',
    websiteUrl: 'https://large.example/',
    runAt: '2026-07-23T10:00:00.000Z',
    maxPagesPerCompany: 3,
    hostLimiterOptions: { minSpacingMs: 0 },
    transport: async (url) => {
      calls.push(url);
      if (url === 'https://large.example/robots.txt') {
        return { status: 200, headers: {}, body: 'User-agent: *\nAllow: /' };
      }
      if (url === 'https://large.example/') {
        return {
          status: 200,
          headers: {},
          body: Array.from({ length: 10 }, (_, index) =>
            `<a href="/jobs/role-${index + 1}">Role ${index + 1}</a>`).join(''),
        };
      }
      return { status: 200, headers: {}, body: '' };
    },
  });

  assert.equal(calls.length, 4);
  assert.equal(result.telemetry.cappedCompanies, 1);
  assert.equal(result.manifest.sources[0].capped, true);
  assert.equal(result.manifest.sources[0].pagesFetched, 3);
});
