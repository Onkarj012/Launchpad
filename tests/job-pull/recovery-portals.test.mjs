import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runPortalSourcePlan, runNormalSourcePlan } from '../../job-pull/normal-sources.mjs';
import { fetchLinkedIn } from '../../job-pull/portal-adapters/linkedin.mjs';
import { fetchGlassdoor, fetchInstahyre, fetchWellfound, parseGlassdoorCards, parseWellfoundCards } from '../../job-pull/portal-adapters/browser-portals.mjs';

const fixture = fs.readFileSync('tests/fixtures/portals/linkedin-guest-pune.html', 'utf8');
test('normalization failures add to provider-reported counts without double-counting mirrored adapter errors', async () => {
  const [row] = await runNormalSourcePlan({ sourceFunctions: { 'tracked-ats': () => ({
    records: [{}], manifest: { failed: 5, errors: ['provider failure'] }, telemetry: { errors: ['provider failure'] },
  }) } });
  assert.equal(row.manifest.failed, 6);
  assert.equal(row.manifest.errors.length, 2);
  assert.equal(row.manifest.status, 'failed');
});
async function linkedInLane(fetchText, queries = [{ keywords: 'AI', location: 'Pune' }]) {
  return (await runPortalSourcePlan({
    providerFetchers: { 'linkedin-jobs': { fetchText } },
    laneInputs: { 'linkedin-jobs': { queries, maxPagesPerQuery: 1 } },
  })).find((row) => row.manifest.provider === 'linkedin-jobs');
}
test('HTTP 429 is a failed lane and healthy cards plus a failed query are degraded', async () => {
  const fail = async () => { throw new Error('HTTP 429'); };
  const failed = await linkedInLane(fail);
  assert.equal(failed.manifest.status, 'failed');
  assert.equal(failed.manifest.failed, 1);
  assert.match(failed.manifest.errors[0], /HTTP 429/);
  const partial = await linkedInLane(async (url) => url.includes('Broken') ? fail() : fixture,
    [{ keywords: 'AI', location: 'Pune' }, { keywords: 'AI', location: 'Broken' }]);
  assert.equal(partial.manifest.status, 'degraded');
  assert.ok(partial.candidates.length > 0);
  assert.equal(partial.manifest.failed, 1);
});

test('HTTP 200 login, challenge, and unknown markup cannot masquerade as empty jobs', async () => {
  for (const html of ['<h1>Sign in to view jobs</h1>', '<h1>Access denied</h1>', '<title>Just a moment</title>', '<div id="app">New layout</div>']) {
    assert.equal((await linkedInLane(async () => html)).manifest.status, 'failed', html);
    for (const adapter of [fetchGlassdoor, fetchInstahyre, fetchWellfound]) {
      const result = await adapter({ fetchRendered: async () => html, queries: [{ url: 'https://example.test/search' }] });
      assert.equal(result.telemetry.errors.length, 1, html);
      assert.equal(result.telemetry.requests, 1);
    }
  }
  for (const html of ['', '<h1>No matching jobs found</h1>', '<p>0 results</p>']) {
    assert.equal((await linkedInLane(async () => html)).manifest.status, 'empty', html);
  }
  const empty = await fetchWellfound({ fetchRendered: async () => '<h1>No jobs found</h1>', queries: [{ url: 'https://wellfound.com/search' }] });
  assert.deepEqual(empty.telemetry.errors, []);
});

test('top-level LinkedIn week window reaches every request, with per-query override', async () => {
  const urls = [];
  await fetchLinkedIn({ fetchText: async (url) => { urls.push(new URL(url)); return ''; }, timeWindow: 'week',
    queries: [{ keywords: 'AI', location: 'Pune' }, { keywords: 'ML', location: 'India', timeWindow: 'day' }] });
  assert.deepEqual(urls.map((url) => url.searchParams.get('f_TPR')), ['r604800', 'r86400']);
});

test('Glassdoor preserves listing IDs while tracking variants dedupe', async () => {
  const card = (id, tracking) => `<li data-test="jobListing"><a data-test="job-title" href="/partner/jobListing.htm?jobListingId=${id}&amp;utm_source=${tracking}">AI Engineer</a></li>`;
  const html = card('123', 'one') + card('124', 'two') + card('123', 'three');
  const parsed = parseGlassdoorCards(html);
  assert.deepEqual(parsed.map((x) => x.jobId), ['123', '124', '123']);
  const result = await fetchGlassdoor({ fetchRendered: async () => html, queries: [{ path: '/search' }] });
  assert.equal(result.records.length, 2);
  assert.equal(result.telemetry.duplicatesDropped, 1);
  assert.match(result.records[0].url, /jobListingId=123/);
});

test('Wellfound part-time and contract card evidence stays disallowed', () => {
  for (const type of ['Part-time', 'Contract']) {
    const [row] = parseWellfoundCards(`<a href="/company/acme">Acme</a><a href="/jobs/123-ai?utm_source=x">AI Engineer</a><span>${type}</span><span>Pune</span>`);
    assert.equal(row.employment.type, type.toLowerCase());
    assert.doesNotMatch(row.url, /utm_source/);
  }
});
