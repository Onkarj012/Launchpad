import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyOriginalListingUrl,
  createOriginalListingResolver,
} from '../../crawler/original-listing-resolver.mjs';

const jsonLdPage = (posting) => ({
  status: 200,
  body: `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    ...posting,
  })}</script>`,
});

const observation = (url) => ({
  canonicalUrl: url,
  discoveryUrl: url,
  title: 'AI Engineer',
});

test('classifies supported ATS hosts with stable provider names', () => {
  const supported = [
    ['greenhouse', 'https://boards.greenhouse.io/acme/jobs/1'],
    ['lever', 'https://jobs.lever.co/acme/1'],
    ['ashby', 'https://jobs.ashbyhq.com/acme/1'],
    ['smartrecruiters', 'https://jobs.smartrecruiters.com/acme/1'],
    ['workable', 'https://apply.workable.com/acme/j/1'],
    ['recruitee', 'https://acme.recruitee.com/o/ai-engineer'],
    ['workday', 'https://acme.myworkdayjobs.com/en-US/careers/job/1'],
  ];

  for (const [provider, url] of supported) {
    assert.deepEqual(classifyOriginalListingUrl(url), {
      kind: 'ats',
      provider,
      host: new URL(url).hostname,
      url,
    });
  }
});

test('follows a safe redirect from an aggregator to an ATS detail page', async () => {
  const calls = [];
  const discoveryUrl = 'https://www.indeed.com/viewjob?jk=abc';
  const applicationUrl = 'https://boards.greenhouse.io/acme/jobs/1';
  const resolve = createOriginalListingResolver({
    runAt: '2026-07-24T08:00:00.000Z',
    transport: async (url) => {
      calls.push(url);
      if (url === discoveryUrl) return {
        status: 302,
        headers: { location: applicationUrl },
      };
      return jsonLdPage({
        title: 'AI Engineer',
        description: '<p>Build useful systems in Pune.</p>',
        jobLocation: { address: { addressLocality: 'Pune' } },
        employmentType: 'FULL_TIME',
        datePosted: '2026-07-23',
      });
    },
  });

  const result = await resolve(observation(discoveryUrl));

  assert.equal(result.status, 'resolved');
  assert.equal(result.discoveryUrl, discoveryUrl);
  assert.equal(result.originalApplicationUrl, applicationUrl);
  assert.equal(result.patch.provider, 'greenhouse');
  assert.equal(result.patch.title, 'AI Engineer');
  assert.equal(result.patch.location, 'Pune');
  assert.deepEqual(calls, [discoveryUrl, applicationUrl]);
});

test('fails closed on redirect loops and unsupported redirect hosts', async (t) => {
  await t.test('redirect loop', async () => {
    const discoveryUrl = 'https://www.indeed.com/viewjob?jk=loop';
    const resolve = createOriginalListingResolver({
      transport: async () => ({
        status: 302,
        headers: { location: discoveryUrl },
      }),
    });

    const result = await resolve(observation(discoveryUrl));

    assert.equal(result.status, 'verification');
    assert.equal(result.originalApplicationUrl, null);
    assert.equal(result.evidence.resolution.reason, 'redirect-loop');
  });

  await t.test('unsupported redirect host', async () => {
    const discoveryUrl = 'https://www.indeed.com/viewjob?jk=unsupported';
    const resolve = createOriginalListingResolver({
      transport: async () => ({
        status: 302,
        headers: { location: 'https://malicious.example/jobs/1' },
      }),
    });

    const result = await resolve(observation(discoveryUrl));

    assert.equal(result.status, 'verification');
    assert.equal(result.originalApplicationUrl, null);
    assert.equal(result.evidence.resolution.reason, 'redirect-to-unsupported-host');
  });
});

test('extracts JSON-LD details while keeping missing experience as verification data', async () => {
  const applicationUrl = 'https://jobs.lever.co/acme/1';
  const resolve = createOriginalListingResolver({
    transport: async () => jsonLdPage({
      title: 'Backend Engineer',
      description: '<p>Work on APIs.</p>',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'IN' } },
      employmentType: 'FULL_TIME',
      datePosted: '2026-07-23',
    }),
  });

  const result = await resolve(observation(applicationUrl));

  assert.equal(result.status, 'resolved');
  assert.equal(result.patch.description, 'Work on APIs.');
  assert.deepEqual(result.patch.experience, {
    minYears: null,
    maxYears: null,
    evidence: null,
  });
  assert.equal(result.patch.evidence.resolution.experience, false);
});

test('uses Workday startDate as freshness evidence and postedAt', async () => {
  const applicationUrl = 'https://acme.myworkdayjobs.com/en-US/careers/job/1';
  const resolve = createOriginalListingResolver({
    transport: async () => jsonLdPage({
      title: 'ML Engineer',
      description: 'Join the applied ML team.',
      startDate: '2026-07-22',
    }),
  });

  const result = await resolve(observation(applicationUrl));

  assert.equal(result.status, 'resolved');
  assert.equal(result.patch.postedAt, '2026-07-22T00:00:00.000Z');
  assert.deepEqual(result.patch.evidence.freshness, { kind: 'workday-startDate' });
});

test('keeps malformed job detail in verification', async () => {
  const applicationUrl = 'https://jobs.ashbyhq.com/acme/1';
  const resolve = createOriginalListingResolver({
    transport: async () => ({
      status: 200,
      body: '<html><script type="application/ld+json">{not valid json}</script></html>',
    }),
  });

  const result = await resolve(observation(applicationUrl));

  assert.equal(result.status, 'verification');
  assert.equal(result.originalApplicationUrl, null);
  assert.equal(result.evidence.resolution.reason, 'job-detail-not-found');
});
