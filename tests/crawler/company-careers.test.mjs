import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCompanyCareers } from '../../crawler/company-careers.mjs';
import { responses, employerPages } from '../fixtures/crawler-careers/company-careers.mjs';

import { classifyFreshness } from '../../job-pull/freshness.mjs';
import { classifyCandidate } from '../../job-pull/eligibility.mjs';
import { loadConfig } from '../../job-pull/config.mjs';

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

// Exercise only injected responses so fixtures never crawl the named employers.
async function discoverFixture(company, websiteUrl, pages = employerPages) {
  const calls = [];
  const result = await discoverCompanyCareers({ company, websiteUrl, robots: [], runAt: '2026-10-13T00:00:00.000Z',
    hostLimiterOptions: { minSpacingMs: 0 }, retry: { maxAttempts: 1 }, transport: async (url) => {
      calls.push(url);
      return { status: pages[url] == null ? 404 : 200, headers: {}, body: pages[url] || '' };
    } });
  return { ...result, calls };
}

test('Birlasoft hostname does not turn marketing, query text, assets or foreign sitemap entries into jobs', async () => {
  const result = await discoverFixture('Birlasoft', 'https://jobs.birlasoft.com/');
  assert.deepEqual(result.observations.map((row) => row.title), ['AI Engineer', 'Backend Engineer']);
  assert.equal(result.calls.some((url) => /about|services|static|images|unrelated/.test(url)), false);
  assert.deepEqual(result.discoveredBoards, []);
  const html = result.observations[0];
  assert.equal(html.location, 'Pune, Maharashtra, India');
  assert.match(html.description, /Required experience: 0-1 years/);
  assert.equal(html.employment.type, null);
  assert.equal(html.postedAt, null);
  assert.equal(html.evidence.detailUrl, html.canonicalUrl);
  assert.equal(html.evidence.fieldSources.description, 'job-detail-html');
  assert.equal(html.liveness.status, 'Not Verified');
  assert.equal(classifyFreshness(html, { now: '2026-10-13T00:00:00Z' }).window, 'VerifyQueue');
  assert.equal(result.verificationQueue[0].reason, 'undated');
  const structured = result.observations[1];
  assert.equal(structured.employment.type, 'full-time');
  assert.equal(structured.evidence.employmentType, 'FULL_TIME');
  assert.equal(structured.evidence.fieldSources.employmentType, 'JobPosting');
  assert.equal(structured.postedAt, '2026-10-12T00:00:00.000Z');
  assert.equal(structured.evidence.modifiedAt, '2026-10-13T00:00:00.000Z');
  assert.equal(classifyCandidate(structured, { ...loadConfig(), now: '2026-10-13T00:00:00Z' }).employment.pass, true);
});

test('Cybage linked HTML role keeps explicit fields, remains undated, and excludes general sitemap marketing', async () => {
  const result = await discoverFixture('Cybage Software', 'https://www.cybage.com/');
  assert.equal(result.observations.length, 1);
  const row = result.observations[0];
  assert.equal(row.title, 'Python Developer');
  assert.equal(row.location, 'Pune');
  assert.equal(row.description, 'Build backend services. Required experience: 0-1 years.');
  assert.equal(row.company, 'Cybage Software');
  assert.equal(row.provider, 'company-careers');
  assert.equal(row.employment.type, null);
  assert.equal(row.postedAt, null);
  assert.equal(row.evidence.sourceUrl, 'https://www.cybage.com/careers/open-positions');
  assert.equal(result.calls.some((url) => /services|industries|blog/.test(url)), false);
  const policy = classifyCandidate(row, { ...loadConfig(), now: '2026-10-13T00:00:00Z' });
  assert.equal(policy.employment.code, 'EMPLOYMENT_FULL_TIME_NOT_VERIFIED');
  assert.equal(classifyFreshness(row).eligible, false);
});

test('sitemap modification and JSON-LD creation dates never prove publication or expiry', async () => {
  const result = await discoverFixture('Dates', 'https://dates.example/', {
    'https://dates.example/': '<a href="/jobs/role">Role</a>',
    'https://dates.example/sitemap.xml': '<urlset><url><loc>/jobs/role</loc><lastmod>2025-01-01</lastmod></url></urlset>',
    'https://dates.example/jobs/role': '<script type="application/ld+json">{"@type":"JobPosting","title":"AI Engineer","dateCreated":"2026-10-12","dateModified":"2026-10-12","employmentType":"PART_TIME"}</script>',
  });
  const row = result.observations[0];
  assert.equal(row.postedAt, null);
  assert.equal(row.liveness.status, 'Not Verified');
  assert.equal(row.evidence.dateCreated, '2026-10-12T00:00:00.000Z');
  assert.equal(row.employment.type, 'part-time');
  assert.equal(classifyCandidate(row, loadConfig()).employment.pass, false);
});

test('career feed publication and modification dates remain separate; marketing feed entries are ignored', async () => {
  const result = await discoverFixture('Feeds', 'https://feeds.example/', {
    'https://feeds.example/': '<link rel="alternate" href="/jobs.atom"><link href="/jobs.rss">',
    'https://feeds.example/jobs.atom': '<feed><entry><title>AI Engineer</title><link href="/jobs/ai"/><published>2026-10-12</published><updated>2026-10-13</updated><summary>Build AI</summary></entry><entry><title>Backend Engineer</title><link href="/jobs/backend"/><updated>2026-10-12</updated></entry><entry><title>Marketing</title><link href="/about"/><published>2026-10-12</published></entry></feed>',
    'https://feeds.example/jobs.rss': '<rss><channel><item><title>Software Engineer</title><link>/jobs/software</link><pubDate>Mon, 12 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>',
  });
  assert.equal(result.observations.length, 3);
  assert.equal(result.observations[0].postedAt, '2026-10-12T00:00:00.000Z');
  assert.equal(result.observations[0].evidence.modifiedAt, '2026-10-13T00:00:00.000Z');
  assert.equal(result.observations[1].postedAt, null);
  assert.equal(result.observations[1].evidence.modifiedAt, '2026-10-12T00:00:00.000Z');
  assert.equal(classifyFreshness(result.observations[1]).window, 'VerifyQueue');
  assert.equal(result.observations[2].postedAt, '2026-10-12T00:00:00.000Z');
});

test('partial HTML evidence and a URL slug never synthesize a role', async () => {
  const result = await discoverFixture('Partial', 'https://partial.example/', {
    'https://partial.example/': '<a href="/jobs/python">Python</a>',
    'https://partial.example/sitemap.xml': '<urlset><url><loc>/jobs/arbitrary</loc><lastmod>2026-10-12</lastmod></url></urlset>',
    'https://partial.example/jobs/python': '<h1>Python Developer</h1><p>Location: Pune</p><p>Our story</p>',
    'https://partial.example/jobs/arbitrary': '<h1>Marketing</h1>',
  });
  assert.deepEqual(result.observations, []);
});


test('RSS and Atom XML URLs retain explicit publication evidence', async () => {
  const result = await discoverFixture('XML Feeds', 'https://xml-feeds.example/', {
    'https://xml-feeds.example/': '<link type="application/rss+xml" href="/jobs/rss.xml"><link type="application/atom+xml" href="/jobs/atom.xml">',
    'https://xml-feeds.example/jobs/rss.xml': '<?xml version="1.0"?><!-- Generated career feed --><rss><channel><item><title>AI Engineer</title><link>/jobs/ai</link><pubDate>Mon, 12 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>',
    'https://xml-feeds.example/jobs/atom.xml': '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Backend Engineer</title><link href="/jobs/backend"/><published>2026-10-12</published><updated>2026-10-13</updated></entry></feed>',
  });
  assert.deepEqual(result.observations.map((row) => row.title), ['AI Engineer', 'Backend Engineer']);
  assert.deepEqual(result.observations.map((row) => row.postedAt), Array(2).fill('2026-10-12T00:00:00.000Z'));
});

test('nested HTML and subordinate JD headings retain hard requirements for shared policy', async () => {
  const result = await discoverFixture('Requirements', 'https://requirements.example/', {
    'https://requirements.example/': '<a href="/jobs/nested">Nested</a><a href="/jobs/headings">Headings</a><a href="/jobs/oversized">Oversized</a>',
    'https://requirements.example/jobs/nested': '<h1>AI Engineer</h1><p>Location: Pune</p><div class="job-description"><div>Build APIs.</div><p>Required experience: 5 years.</p><p>Employment type: Part-time</p></div>',
    'https://requirements.example/jobs/headings': '<h1>AI Engineer</h1><p>Location: Pune</p><h2>Job Description</h2><p>Build APIs.</p><h3>Requirements</h3><p>Required experience: 5 years.</p><h2>About Company</h2><p>Not JD</p>',
    'https://requirements.example/jobs/oversized': '<h1>AI Engineer</h1><p>Location: Pune</p><div class="job-description">' + 'a'.repeat(16_001) + '</div>',
  });
  assert.equal(result.observations.length, 2);
  for (const row of result.observations) {
    assert.match(row.description, /Required experience: 5 years/);
    assert.doesNotMatch(row.description, /Not JD/);
    assert.equal(row.experience.minYears, 5);
    assert.equal(classifyCandidate(row, loadConfig()).eligible, false);
  }
  assert.equal(classifyCandidate(result.observations[0], loadConfig()).employment.pass, false);
});


test('validThrough still expires a dated job independently of a recent sitemap modification', async () => {
  const result = await discoverFixture('Expired', 'https://expired.example/', {
    'https://expired.example/': '',
    'https://expired.example/sitemap.xml': '<urlset><url><loc>/jobs/expired</loc><lastmod>2026-10-12</lastmod></url></urlset>',
    'https://expired.example/jobs/expired': '<script type="application/ld+json">{"@type":"JobPosting","title":"AI Engineer","datePosted":"2026-10-12","validThrough":"2026-10-12"}</script>',
  });
  const row = result.observations[0];
  assert.equal(row.liveness.status, 'Expired');
  assert.equal(row.liveness.evidence, 'validThrough');
  assert.equal(row.evidence.sitemapLastmod, '2026-10-12T00:00:00.000Z');
  assert.equal(result.verificationQueue[0].reason, 'expired');
});


test('HTML location retains restrictions after nested markup for shared geo policy', async () => {
  const result = await discoverFixture('Location', 'https://location.example/', {
    'https://location.example/': '<a href="/jobs/remote">Remote</a>',
    'https://location.example/jobs/remote': '<h1>AI Engineer</h1><p><strong>Location:</strong> <span>Remote</span> - United States only</p><div class="job-description">Build Python APIs. Required experience: 0-1 years.</div>',
  });
  const row = result.observations[0];
  assert.equal(row.location, 'Remote - United States only');
  assert.equal(row.evidence.fieldSources.location, 'job-detail-html');
  assert.equal(classifyCandidate(row, loadConfig()).geo.pass, false);
});


test('commented HTML cannot create roles or terminate visible job requirements', async () => {
  const result = await discoverFixture('Comments', 'https://comments.example/', {
    'https://comments.example/': '<a href="/jobs/hidden">Hidden</a><a href="/jobs/visible">Visible</a>',
    'https://comments.example/jobs/hidden': '<!-- <h1>AI Engineer</h1><p>Location: Pune</p><div class="job-description">Build APIs.</div> --><p>No current openings.</p>',
    'https://comments.example/jobs/visible': '<h1>AI Engineer</h1><p>Location: Pune</p><h2>Job Description</h2><p>Build APIs.</p><!-- <h2>Old section</h2> --><p>Required experience: 5 years.</p>',
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].canonicalUrl, 'https://comments.example/jobs/visible');
  assert.equal(result.observations[0].experience.minYears, 5);
  assert.equal(classifyCandidate(result.observations[0], loadConfig()).eligible, false);
});


test('career listings cannot combine a page heading with individual job cards into a role', async () => {
  const result = await discoverFixture('Listings', 'https://listings.example/', {
    'https://listings.example/': '<a href="/careers/listing">Careers</a><a href="/careers/team">Team</a>',
    'https://listings.example/careers/listing': '<h1>Current openings</h1><article><h2>AI Engineer</h2><p>Location: Pune</p><div class="job-description">Build APIs. Required experience: 0-1 years.</div><a href="/jobs/ai">Details</a></article><article><h2>Backend Engineer</h2><p>Location: Pune</p><div class="job-description">Build backend.</div></article>',
    'https://listings.example/careers/team': '<h1>Our team</h1><p>Location: Pune</p><div class="job-description">Build APIs.</div><div class="job-description">Build models.</div>',
    'https://listings.example/jobs/ai': '<h1>AI Engineer</h1><p>Location: Pune</p><div class="job-description">Build APIs. Required experience: 0-1 years.</div>',
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].canonicalUrl, 'https://listings.example/jobs/ai');
  assert.equal(result.observations[0].title, 'AI Engineer');
});

test('commented JSON-LD cannot fabricate dated jobs or override visible detail evidence', async () => {
  const commented = '<!-- <script type="application/ld+json">{"@type":"JobPosting","title":"Old Engineer","datePosted":"2026-10-12","employmentType":"FULL_TIME","description":"Required experience: 0-1 years."}</script> -->';
  const result = await discoverFixture('Structured comments', 'https://structured-comments.example/', {
    'https://structured-comments.example/': '<a href="/jobs/hidden">Hidden</a><a href="/jobs/visible">Visible</a>',
    'https://structured-comments.example/jobs/hidden': commented + '<p>No current openings.</p>',
    'https://structured-comments.example/jobs/visible': commented + '<h1>AI Engineer</h1><p>Location: Pune</p><div class="job-description">Build APIs. Required experience: 5 years.</div>',
  });
  assert.equal(result.observations.length, 1);
  const row = result.observations[0];
  assert.equal(row.title, 'AI Engineer');
  assert.equal(row.postedAt, null);
  assert.equal(row.employment.type, null);
  assert.equal(row.experience.minYears, 5);
  assert.equal(classifyCandidate(row, loadConfig()).eligible, false);
});


test('peer-level requirements and responsibilities stay inside a supported HTML JD', async () => {
  const result = await discoverFixture('Peer headings', 'https://peer-headings.example/', {
    'https://peer-headings.example/': '<a href="/jobs/ai">AI Engineer</a>',
    'https://peer-headings.example/jobs/ai': '<h1>AI Engineer</h1><p>Location: Pune</p><h2>Job Description</h2><p>Build APIs.</p><h2>Requirements</h2><p>Required experience: 5 years.</p><h2>Key Responsibilities</h2><p>Build backend systems.</p><h2>About Company</h2><p>Marketing.</p>',
  });
  const row = result.observations[0];
  assert.match(row.description, /Build backend systems/);
  assert.doesNotMatch(row.description, /Marketing/);
  assert.equal(row.experience.minYears, 5);
  assert.equal(classifyCandidate(row, loadConfig()).eligible, false);
});

test('career feeds preserve recognized ATS detail links but reject board roots and marketing', async () => {
  const urls = [
    'https://jobs.lever.co/acme/123', 'https://jobs.ashbyhq.com/acme/456',
    'https://job-boards.greenhouse.io/acme/jobs/789', 'https://jobs.lever.co/acme',
    'https://marketing.example/about', 'https://jobs.lever.co/asset/jobs.css',
  ];
  const result = await discoverFixture('ATS Feed', 'https://ats-feed.example/', {
    'https://ats-feed.example/': '<link href="/jobs.rss">',
    'https://ats-feed.example/jobs.rss': '<rss><channel>' + urls.map((url) => '<item><title>AI Engineer</title><link>' + url + '</link><pubDate>Mon, 12 Oct 2026 00:00:00 GMT</pubDate><description>Build AI.</description></item>').join('') + '</channel></rss>',
  });
  assert.deepEqual(result.observations.map((row) => row.canonicalUrl), urls.slice(0, 3));
  for (const row of result.observations) {
    assert.equal(row.postedAt, '2026-10-12T00:00:00.000Z');
    assert.equal(row.evidence.classification, 'lead');
    assert.equal(row.source, 'https://ats-feed.example/jobs.rss');
  }
});


test('explicit JD fields retain external peer requirements without counting company-description as another role', async () => {
  const result = await discoverFixture('Field and sections', 'https://field-sections.example/', {
    'https://field-sections.example/': '<a href="/jobs/heading">Heading</a><a href="/jobs/field">Field</a>',
    'https://field-sections.example/jobs/heading': '<h1>AI Engineer</h1><p>Location: Pune</p><div class="job-description"><h2>Job Description</h2><p>Build APIs.</p></div><h2>Requirements</h2><p>Required experience: 5 years.</p><h2>About Company</h2><div class="company-description">Marketing.</div>',
    'https://field-sections.example/jobs/field': '<h1>AI Engineer</h1><p>Location: Pune</p><div class="job-description">Build APIs.</div><h2>Requirements</h2><p>Required experience: 5 years.</p><h2>About Company</h2><div class="company-description">Marketing.</div>',
  });
  assert.equal(result.observations.length, 2);
  for (const row of result.observations) {
    assert.match(row.description, /Build APIs/);
    assert.doesNotMatch(row.description, /Marketing/);
    assert.equal(row.experience.minYears, 5);
    assert.equal(classifyCandidate(row, loadConfig()).eligible, false);
  }
});
