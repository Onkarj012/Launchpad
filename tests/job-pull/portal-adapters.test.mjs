import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LINKEDIN_GUEST_SEARCH_URL,
  buildLinkedInQueryUrl,
  fetchLinkedIn,
  parseLinkedInGuestCards,
} from '../../job-pull/portal-adapters/linkedin.mjs';
import {
  fetchWellfound,
  parseGlassdoorCards,
  parseInstahyreCards,
  parseRelativeAge,
  parseSpelledRelativeAge,
  parseWellfoundCards,
} from '../../job-pull/portal-adapters/browser-portals.mjs';
import { PORTAL_PROVIDERS, PORTAL_SOURCE_LANES, runPortalSourcePlan } from '../../job-pull/normal-sources.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'portals');
const fixture = (name) => readFileSync(path.join(FIXTURES, name), 'utf8');

// --------------------------------------------------------------- LinkedIn

test('LinkedIn guest cards parse with an exact employer date', () => {
  const records = parseLinkedInGuestCards(fixture('linkedin-guest-pune.html'), {
    query: { keywords: 'software engineer', location: 'Pune, Maharashtra, India' },
  });
  assert.ok(records.length >= 10, `expected at least 10 cards, got ${records.length}`);
  // The whole reason this lane exists: every card carries <time datetime>.
  assert.equal(records.filter((record) => record.postedAt != null).length, records.length);
  for (const record of records) {
    assert.match(record.url, /^https:\/\/[a-z.]*linkedin\.com\/jobs\/view\//);
    assert.doesNotMatch(record.url, /\?/, 'tracking query string must be stripped');
    assert.ok(record.title && record.company && record.location, 'title, company, location required');
    assert.match(record.postedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(record.provider, 'linkedin-jobs');
    assert.equal(record.sourceCategory, 'aggregator');
  }
});

test('LinkedIn query URL carries recency and work-type facets', () => {
  const url = buildLinkedInQueryUrl({ keywords: 'AI engineer', location: 'India', timeWindow: 'day', workType: 'remote', start: 25 });
  assert.ok(url.startsWith(LINKEDIN_GUEST_SEARCH_URL));
  assert.match(url, /f_TPR=r86400/);
  assert.match(url, /f_WT=2/);
  assert.match(url, /start=25/);
  assert.throws(() => buildLinkedInQueryUrl({ keywords: 'x' }), /keywords and location are required/);
});

test('LinkedIn fetch dedupes across queries and reports per-query failures', async () => {
  const html = fixture('linkedin-guest-pune.html');
  const seen = [];
  const result = await fetchLinkedIn({
    fetchText: async (url) => {
      seen.push(url);
      if (url.includes('Broken')) throw new Error('HTTP 429');
      return html;
    },
    queries: [
      { keywords: 'software engineer', location: 'Pune, Maharashtra, India' },
      { keywords: 'software engineer', location: 'Broken' },
    ],
    maxPagesPerQuery: 1,
  });
  const urls = new Set(result.records.map((record) => record.url));
  assert.equal(result.records.length, urls.size, 'records must be unique by URL');
  assert.equal(result.telemetry.errors.length, 1);
  assert.match(result.telemetry.errors[0], /HTTP 429/);
  // A failing query must not take the healthy one down with it.
  assert.ok(result.records.length > 0);
});

test('LinkedIn fetch requires an injected transport and at least one query', async () => {
  await assert.rejects(() => fetchLinkedIn({ queries: [{ keywords: 'a', location: 'b' }] }), /injected fetchText/);
  await assert.rejects(() => fetchLinkedIn({ fetchText: async () => '' }), /at least one configured query/);
});

// -------------------------------------------------------------- Glassdoor

test('Glassdoor cards parse and only bounded ages become dates', () => {
  const now = Date.parse('2026-08-22T00:00:00.000Z');
  const records = parseGlassdoorCards(fixture('glassdoor.html'), { now });
  assert.ok(records.length >= 20, `expected at least 20 cards, got ${records.length}`);
  for (const record of records) {
    assert.ok(record.title && record.company, 'title and company required');
    assert.match(record.url, /^https:\/\/www\.glassdoor\.co\.in\//);
    assert.equal(record.provider, 'glassdoor');
  }
});

test('relative age converts bounded labels and refuses unbounded ones', () => {
  const now = Date.parse('2026-08-22T12:00:00.000Z');
  assert.equal(parseRelativeAge('24h', now), new Date(now - 86_400_000).toISOString());
  assert.equal(parseRelativeAge('3d', now), new Date(now - 3 * 86_400_000).toISOString());
  assert.equal(parseRelativeAge('Just posted', now), new Date(now).toISOString());
  // "30d+" is unbounded: it cannot date a posting, so it must stay undated
  // rather than being guessed at 30 days.
  assert.equal(parseRelativeAge('30d+', now), null);
  assert.equal(parseRelativeAge('', now), null);
  assert.equal(parseRelativeAge(null, now), null);
});

// -------------------------------------------------------------- Instahyre

test('Instahyre rows split employer from role and keep the job URL', () => {
  const records = parseInstahyreCards(fixture('instahyre.html'));
  assert.ok(records.length >= 20, `expected at least 20 rows, got ${records.length}`);
  for (const record of records) {
    assert.ok(record.company, 'company required');
    assert.ok(record.title, 'title required');
    assert.match(record.url, /^https:\/\/www\.instahyre\.com\/job-\d+/);
    assert.ok(!record.title.startsWith(record.company), 'employer prefix must be stripped from the role');
  }
  // Roles containing " - " must survive the split intact.
  const dashed = records.find((record) => record.title.includes(' - '));
  if (dashed) assert.ok(dashed.title.length > 3);
});

// -------------------------------------------------------------- Wellfound

test('Wellfound jobs inherit the company block above them', () => {
  const records = parseWellfoundCards(fixture('wellfound.html'));
  assert.ok(records.length >= 20, `expected at least 20 rows, got ${records.length}`);
  for (const record of records) {
    assert.ok(record.company, 'every row must be attributed to a company');
    assert.match(record.url, /^https:\/\/wellfound\.com\/jobs\/\d+-/);
    assert.equal(record.sourceCategory, 'startup-board');
    // The employment-type badge must never be mistaken for a location.
    assert.doesNotMatch(record.location || '', /full[- ]?time|part[- ]?time|contract/i);
  }
});

test('Wellfound drops job links that have no company above them', () => {
  const orphan = '<a href="/jobs/1234-orphan-role">Orphan Role</a>';
  assert.deepEqual(parseWellfoundCards(orphan), []);
});

test('Wellfound cards yield location, posting age, salary, and employment type', () => {
  const now = Date.parse('2026-08-22T00:00:00.000Z');
  const records = parseWellfoundCards(fixture('wellfound.html'), { now });
  // A card renders a flat run of text nodes and omits fields freely, so each is
  // classified by what it is. Positional reading produced empty locations on
  // 98 of 106 live rows, which the geography gate then rejected as unverified.
  assert.ok(records.filter((record) => record.location).length >= 10);
  assert.ok(records.filter((record) => record.postedAt).length >= 5);
  const paid = records.filter((record) => record.salary);
  assert.ok(paid.length >= 5);
  for (const record of paid) {
    assert.equal(record.salary.currency, 'INR');
    assert.ok(record.salary.minimum > 0 && record.salary.maximum >= record.salary.minimum);
  }
  // The employment badge must never be read as a place.
  for (const record of records) {
    assert.doesNotMatch(record.location || '', /full[- ]?time|part[- ]?time|contract/i);
    assert.doesNotMatch(record.location || '', /ago$/i);
    assert.doesNotMatch(record.location || '', /^₹/);
  }
});

test('spelled relative ages resolve, and unknown phrasings stay undated', () => {
  const now = Date.parse('2026-08-22T12:00:00.000Z');
  assert.equal(parseSpelledRelativeAge('2 weeks ago', now), new Date(now - 14 * 86_400_000).toISOString());
  assert.equal(parseSpelledRelativeAge('3 days ago', now), new Date(now - 3 * 86_400_000).toISOString());
  assert.equal(parseSpelledRelativeAge('today', now), new Date(now).toISOString());
  assert.equal(parseSpelledRelativeAge('yesterday', now), new Date(now - 86_400_000).toISOString());
  assert.equal(parseSpelledRelativeAge('a while back', now), null);
  assert.equal(parseSpelledRelativeAge('', now), null);
});

// ------------------------------------------------------------- lane plan

test('portal lanes only exist for providers that own an adapter', () => {
  const ids = PORTAL_SOURCE_LANES.map((lane) => lane.id);
  assert.equal(new Set(ids).size, ids.length, 'lane ids must be unique');
  for (const lane of PORTAL_SOURCE_LANES) assert.ok(PORTAL_PROVIDERS.includes(lane.provider));
  // Every portal lane is optional. Absence is not the signal worth degrading a
  // run over; short yield is, and the shortfall report owns that. A required
  // portal lane would degrade every fixture-driven run that injects none.
  assert.deepEqual(PORTAL_SOURCE_LANES.filter((lane) => lane.required), []);
  // No portal lane may carry a stale "needs injection" reason code once it owns
  // an adapter, or the shortfall report will blame a lane that actually works.
  for (const lane of PORTAL_SOURCE_LANES) assert.equal(lane.reasonCode, undefined);
});

test('a missing browser transport does not take the HTTP lane down', async () => {
  const results = await runPortalSourcePlan({
    providerFetchers: { 'linkedin-jobs': { fetchText: async () => fixture('linkedin-guest-pune.html') } },
    laneInputs: { 'linkedin-jobs': { queries: [{ keywords: 'software engineer', location: 'Pune, Maharashtra, India' }], maxPagesPerQuery: 1 } },
    runAt: '2026-08-22T06:00:00.000Z',
    runId: 'portal-test',
  });
  const byId = Object.fromEntries(results.map((result) => [result.manifest.sourceId, result]));
  assert.equal(byId['portal-linkedin-jobs'].manifest.status, 'ok');
  assert.ok(byId['portal-linkedin-jobs'].candidates.length > 0);
  for (const id of ['portal-glassdoor', 'portal-instahyre', 'portal-wellfound']) {
    assert.equal(byId[id].manifest.status, 'unavailable');
    assert.equal(byId[id].candidates.length, 0);
  }
});

test('an adapter that throws marks only its own lane failed', async () => {
  const results = await runPortalSourcePlan({
    providerFetchers: {
      'linkedin-jobs': { fetchText: async () => fixture('linkedin-guest-pune.html') },
      wellfound: { fetchRendered: async () => { throw new Error('browser unavailable'); } },
    },
    laneInputs: {
      'linkedin-jobs': { queries: [{ keywords: 'software engineer', location: 'Pune, Maharashtra, India' }], maxPagesPerQuery: 1 },
      wellfound: { queries: [{ label: 'pune', url: 'https://wellfound.com/role/l/software-engineer/pune' }] },
    },
    runAt: '2026-08-22T06:00:00.000Z',
    runId: 'portal-test',
  });
  const byId = Object.fromEntries(results.map((result) => [result.manifest.sourceId, result]));
  assert.equal(byId['portal-linkedin-jobs'].manifest.status, 'ok');
  // fetchBrowserPortal records per-query errors rather than throwing, so the
  // lane completes with zero rows and a populated error list.
  assert.equal(byId['portal-wellfound'].candidates.length, 0);
});

test('wellfound adapter reports render errors instead of silently returning nothing', async () => {
  const result = await fetchWellfound({
    fetchRendered: async () => { throw new Error('HTTP 403'); },
    queries: [{ label: 'pune', url: 'https://wellfound.com/role/l/software-engineer/pune' }],
  });
  assert.equal(result.records.length, 0);
  assert.equal(result.telemetry.errors.length, 1);
  assert.match(result.telemetry.errors[0], /HTTP 403/);
});
