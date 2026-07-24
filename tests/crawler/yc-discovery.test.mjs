import test from 'node:test';
import assert from 'node:assert/strict';
import { extractYcJobListings, discoverYcJobs } from '../../crawler/yc-discovery.mjs';
import { createOriginalListingResolver } from '../../crawler/original-listing-resolver.mjs';

const YC_QUERY = 'site:ycombinator.com/jobs India ("software engineer" OR "AI engineer" OR "ML engineer")';

const jsonLdPage = (posting) => ({
  status: 200,
  body: `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    ...posting,
  })}</script>`,
});

test('extractYcJobListings keeps only real per-job YC URLs, deduplicated, with a derived company', () => {
  const rows = [
    { url: 'https://www.ycombinator.com/companies/signoz/jobs/el80mDr-ex-founders', title: 'Founding Engineer at SigNoz | Y Combinator' },
    { url: 'https://www.ycombinator.com/companies/signoz/jobs/el80mDr-ex-founders?utm_source=x', title: 'duplicate' },
    { url: 'https://www.ycombinator.com/jobs/role/all/india', title: 'YC India jobs' },
    { url: 'https://www.ycombinator.com/companies/spenmo/jobs/TwStO6u-software-engineer', title: 'Software Engineer at Spenmo' },
    { url: 'https://www.ycombinator.com/blog/some-post', title: 'Not a job page' },
    { url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'not YC at all' },
  ];

  const listings = extractYcJobListings(rows);
  assert.equal(listings.length, 2);
  assert.deepEqual(listings.map((row) => row.companySlug), ['signoz', 'spenmo']);
  assert.equal(listings[0].company, 'SigNoz');
  assert.equal(listings[1].company, 'Spenmo');
});

test('resolves a YC lead to its real employer ATS page and classifies it direct', async () => {
  const runAt = '2026-07-24T08:00:00.000Z';
  const ycUrl = 'https://www.ycombinator.com/companies/signoz/jobs/el80mDr-ex-founders';
  const atsUrl = 'https://jobs.ashbyhq.com/signoz/1';
  const resolveOriginalListing = createOriginalListingResolver({
    runAt,
    transport: async (url) => {
      if (url === ycUrl) return { status: 302, headers: { location: atsUrl } };
      return jsonLdPage({
        title: 'Founding Engineer',
        description: '<p>Build observability tooling in Bengaluru.</p>',
        jobLocation: { address: { addressLocality: 'Bengaluru' } },
        employmentType: 'FULL_TIME',
        datePosted: '2026-07-20',
      });
    },
  });

  const result = await discoverYcJobs({
    runAt,
    queries: [YC_QUERY],
    resolveOriginalListing,
    transport: async (query) => {
      assert.equal(query, YC_QUERY);
      return { status: 200, body: { results: [{ url: ycUrl, title: 'Founding Engineer at SigNoz | Y Combinator' }] } };
    },
  });

  assert.equal(result.observations.length, 1);
  const [observation] = result.observations;
  assert.equal(observation.classification, 'direct');
  assert.equal(observation.originalApplicationUrl, atsUrl);
  assert.equal(observation.applicationResolution.status, 'Resolved Original');
  assert.equal(result.verificationQueue.length, 0);
  assert.equal(result.manifest.telemetry.resolved, 1);
  assert.equal(result.manifest.telemetry.unresolved, 0);
});

test('keeps an unresolved YC lead classified as a lead and queues it for verification instead of marking it ready', async () => {
  const runAt = '2026-07-24T08:00:00.000Z';
  const ycUrl = 'https://www.ycombinator.com/companies/unknownco/jobs/abc123-engineer';
  const result = await discoverYcJobs({
    runAt,
    queries: [YC_QUERY],
    resolveOriginalListing: async () => ({
      status: 'verification',
      applicationResolution: { status: 'Needs Verification', evidence: null },
      evidence: { resolver: 'test', resolution: { status: 'verification', reason: 'original-listing-not-found' } },
    }),
    transport: async () => ({ status: 200, body: { results: [{ url: ycUrl, title: 'Engineer at Unknown Co' }] } }),
  });

  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].classification, 'lead');
  assert.equal(result.observations[0].originalApplicationUrl, null);
  assert.equal(result.verificationQueue.length, 1);
  assert.equal(result.verificationQueue[0].reason, 'original-listing');
  assert.equal(result.manifest.telemetry.resolved, 0);
  assert.equal(result.manifest.telemetry.unresolved, 1);
});

test('requires an injected transport, resolver, and a real YC query so it cannot silently run or promote unresolved leads', async () => {
  await assert.rejects(
    discoverYcJobs({ queries: [YC_QUERY], resolveOriginalListing: async () => ({}) }),
    /requires injected transport/,
  );
  await assert.rejects(
    discoverYcJobs({ queries: [YC_QUERY], transport: async () => ({ status: 200, body: { results: [] } }) }),
    /requires an injected original-listing resolver/,
  );
  await assert.rejects(
    discoverYcJobs({
      queries: ['"AI Engineer" Pune fresher jobs'],
      transport: async () => ({ status: 200, body: { results: [] } }),
      resolveOriginalListing: async () => ({}),
    }),
    /requires at least one site:ycombinator\.com\/jobs query/,
  );
});
