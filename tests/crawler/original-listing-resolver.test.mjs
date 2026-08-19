import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOriginalListingResolution,
  classifyOriginalListingUrl,
  createOriginalListingResolver,
  extractProviderFingerprint,
  isShortlistEligibleFromResolution,
  normalizeOriginalListingResolverBudget,
} from '../../crawler/original-listing-resolver.mjs';

const jsonLdPage = (posting) => ({
  status: 200,
  body: `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    ...posting,
  })}</script>`,
});

const observation = (url, extra = {}) => ({
  canonicalUrl: url,
  discoveryUrl: url,
  title: 'AI Engineer',
  ...extra,
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

test('direct ATS URL resolves immediately with provider fingerprint', async () => {
  const applicationUrl = 'https://boards.greenhouse.io/acme/jobs/12345';
  const resolve = createOriginalListingResolver({
    runAt: '2026-07-24T08:00:00.000Z',
    transport: async () => jsonLdPage({
      title: 'AI Engineer',
      description: '<p>Build useful systems in Pune.</p>',
      jobLocation: { address: { addressLocality: 'Pune' } },
      employmentType: 'FULL_TIME',
      datePosted: '2026-07-23',
    }),
  });

  const result = await resolve(observation(applicationUrl));

  assert.equal(result.status, 'resolved');
  assert.equal(result.originalApplicationUrl, applicationUrl);
  assert.equal(result.patch.provider, 'greenhouse');
  assert.equal(result.patch.requisitionId, '12345');
  assert.equal(result.providerFingerprint.requisitionId, '12345');
  assert.equal(result.evidence.fieldSources.description, 'original-employer-detail');
  assert.equal(result.shortlistEligible, true);
  assert.equal(result.telemetry.requests, 1);
  assert.ok(result.telemetry.budget.maxRequests >= 1);
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
  assert.equal(result.patch.sourceKind, 'ats-direct');
  assert.deepEqual(calls, [discoveryUrl, applicationUrl]);
});

test('resolves intermediary apply-tracking page through outbound Apply link', async () => {
  const discoveryUrl = 'https://www.indeed.com/viewjob?jk=track';
  const trackingUrl = 'https://www.indeed.com/rc/clk?jk=track';
  const applicationUrl = 'https://jobs.lever.co/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const resolve = createOriginalListingResolver({
    transport: async (url) => {
      if (url === discoveryUrl) {
        return {
          status: 200,
          body: `<html><a href="${trackingUrl}">Apply</a></html>`,
        };
      }
      if (url === trackingUrl) {
        return {
          status: 200,
          body: `<html><a href="${applicationUrl}">Apply on company site</a></html>`,
        };
      }
      return jsonLdPage({
        title: 'Backend Engineer',
        description: '<p>Ship APIs.</p>',
        jobLocation: { address: { addressLocality: 'Bengaluru' } },
        employmentType: 'FULL_TIME',
        datePosted: '2026-07-20',
      });
    },
  });

  const result = await resolve(observation(discoveryUrl));

  assert.equal(result.status, 'resolved');
  assert.equal(result.originalApplicationUrl, applicationUrl);
  assert.equal(result.patch.provider, 'lever');
  assert.equal(result.providerFingerprint.requisitionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(result.telemetry.redirects >= 1, true);
});

test('resolves via canonical link tag on aggregator page', async () => {
  const discoveryUrl = 'https://www.glassdoor.com/job-listing/ai-engineer';
  const applicationUrl = 'https://jobs.ashbyhq.com/acme/11111111-2222-3333-4444-555555555555';
  const resolve = createOriginalListingResolver({
    transport: async (url) => {
      if (url === discoveryUrl) {
        return {
          status: 200,
          body: `<html><head><link rel="canonical" href="${applicationUrl}"></head><body>snippet only</body></html>`,
        };
      }
      return jsonLdPage({
        title: 'AI Engineer',
        description: '<p>Original employer page.</p>',
        jobLocation: { address: { addressLocality: 'Pune' } },
        employmentType: 'FULL_TIME',
        datePosted: '2026-07-21',
      });
    },
  });

  const result = await resolve(observation(discoveryUrl, {
    title: 'Snippet title from glassdoor',
    description: 'Search snippet — not employer verified',
  }));

  assert.equal(result.status, 'resolved');
  assert.equal(result.originalApplicationUrl, applicationUrl);
  assert.equal(result.patch.description, 'Original employer page.');
  assert.equal(result.evidence.fieldSources.description, 'original-employer-detail');
  assert.equal(result.evidence.leadOnly, false);
});

test('fails closed on redirect loops, unsupported hosts, blocked and malformed responses', async (t) => {
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
    assert.equal(result.shortlistEligible, false);
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

  await t.test('blocked response', async () => {
    const discoveryUrl = 'https://jobs.ashbyhq.com/acme/blocked';
    const resolve = createOriginalListingResolver({
      transport: async () => ({
        status: 403,
        body: '<html>Access denied captcha required</html>',
      }),
    });

    const result = await resolve(observation(discoveryUrl));

    assert.equal(result.status, 'verification');
    assert.equal(result.evidence.resolution.reason, 'blocked');
    assert.equal(result.shortlistEligible, false);
  });

  await t.test('malformed response', async () => {
    const discoveryUrl = 'https://jobs.ashbyhq.com/acme/broken';
    const resolve = createOriginalListingResolver({
      transport: async () => ({
        status: 200,
        body: '',
      }),
    });

    const result = await resolve(observation(discoveryUrl));

    assert.equal(result.status, 'verification');
    assert.equal(result.evidence.resolution.reason, 'malformed-response');
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

test('URL-only portal lead stays out of shortlist-ready state until hydration succeeds', async () => {
  const portalUrl = 'https://www.hirist.tech/j/ai-engineer-123';
  const resolve = createOriginalListingResolver({
    transport: async () => ({
      status: 200,
      body: '<html><title>AI Engineer</title><meta name="description" content="snippet only"></html>',
    }),
  });

  const result = await resolve(observation(portalUrl, {
    title: 'AI Engineer',
    company: 'Unknown Startup',
    // no description / location / postedAt — URL-only lead
  }));

  assert.equal(result.status, 'verification');
  assert.equal(result.evidence.resolution.reason, 'destination-intermediary');
  assert.equal(result.shortlistEligible, false);
  assert.equal(isShortlistEligibleFromResolution(result, observation(portalUrl)), false);

  const applied = applyOriginalListingResolution(observation(portalUrl, {
    title: 'AI Engineer',
    company: 'Unknown Startup',
    classification: 'lead',
    sourceKind: 'aggregator',
  }), result);

  assert.equal(applied.applicationResolution.status, 'Needs Verification');
  assert.equal(applied.originalApplicationUrl, null);
  assert.equal(applied.shortlistEligible, false);
  assert.notEqual(applied.classification, 'direct');
});

test('resolved aggregator lead becomes normal-eligible like a direct ATS candidate', async () => {
  const discoveryUrl = 'https://www.indeed.com/viewjob?jk=ready';
  const applicationUrl = 'https://boards.greenhouse.io/acme/jobs/999';
  const resolve = createOriginalListingResolver({
    runAt: '2026-07-24T08:00:00.000Z',
    transport: async (url) => {
      if (url === discoveryUrl) {
        return { status: 302, headers: { location: applicationUrl } };
      }
      return jsonLdPage({
        title: 'ML Engineer',
        description: '<p>Train models in Pune.</p>',
        jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'IN' } },
        employmentType: 'FULL_TIME',
        datePosted: '2026-07-22',
      });
    },
  });

  const lead = observation(discoveryUrl, {
    title: 'Indeed snippet title',
    description: 'Indeed search snippet only',
    classification: 'lead',
    sourceKind: 'aggregator',
  });
  const result = await resolve(lead);
  const applied = applyOriginalListingResolution(lead, result);

  assert.equal(result.status, 'resolved');
  assert.equal(isShortlistEligibleFromResolution(result, lead), true);
  assert.equal(applied.classification, 'direct');
  assert.equal(applied.sourceKind, 'ats-direct');
  assert.equal(applied.applicationResolution.status, 'Resolved Original');
  assert.equal(applied.originalApplicationUrl, applicationUrl);
  assert.equal(applied.description, 'Train models in Pune.');
  assert.equal(applied.location, 'Pune, IN');
  assert.equal(applied.shortlistEligible, true);
  assert.equal(applied.evidence.fieldSources.description, 'original-employer-detail');
  assert.equal(applied.evidence.leadOnly, false);
});

test('budget config is normalized and exposed in telemetry', () => {
  const budget = normalizeOriginalListingResolverBudget({
    originalListingResolver: { maxRedirects: 2, maxHosts: 3, maxBytes: 1000, maxRequests: 4 },
  });
  assert.deepEqual(budget, {
    maxRedirects: 2,
    maxHosts: 3,
    maxBytes: 1000,
    maxRequests: 4,
  });
  assert.equal(extractProviderFingerprint('https://boards.greenhouse.io/acme/jobs/42').requisitionId, '42');
});

test('resolver forwards and enforces redirect, host, request, byte, signal, and deadline budgets', async () => {
  const captured = [];
  const redirect = createOriginalListingResolver({
    maxRedirects: 0, maxHosts: 4, maxRequests: 8, maxBytes: 10,
    transport: async (url, options) => {
      captured.push({ url, options });
      return { status: 302, headers: { location: 'https://boards.greenhouse.io/acme/jobs/1' }, body: '' };
    },
  });
  const redirectResult = await redirect(observation('https://www.indeed.com/viewjob?id=budget'));
  assert.equal(redirectResult.evidence.resolution.reason, 'redirect-limit-exceeded');
  assert.equal(captured[0].options.maxBytes, 10);
  assert.equal(captured[0].options.budget.maxRedirects, 0);
  assert.equal(captured[0].options.budget.maxHosts, 4);
  assert.equal(captured[0].options.budget.maxRequests, 8);

  const hostLimited = createOriginalListingResolver({
    maxRedirects: 2, maxHosts: 1, maxRequests: 8, transport: async () => ({
      status: 302, headers: { location: 'https://boards.greenhouse.io/acme/jobs/1' }, body: '',
    }),
  });
  assert.equal((await hostLimited(observation('https://www.indeed.com/viewjob?id=host'))).evidence.resolution.reason, 'host-budget-exceeded');

  const requestLimited = createOriginalListingResolver({
    maxRedirects: 2, maxHosts: 4, maxRequests: 1, transport: async () => ({
      status: 302, headers: { location: 'https://boards.greenhouse.io/acme/jobs/1' }, body: '',
    }),
  });
  assert.equal((await requestLimited(observation('https://www.indeed.com/viewjob?id=request'))).evidence.resolution.reason, 'request-budget-exceeded');

  const byteLimited = createOriginalListingResolver({ maxBytes: 10, transport: async () => ({ status: 200, body: 'x'.repeat(11) }) });
  assert.equal((await byteLimited(observation('https://boards.greenhouse.io/acme/jobs/1'))).evidence.resolution.reason, 'response-too-large');

  const controller = new AbortController();
  controller.abort();
  let called = false;
  const aborted = createOriginalListingResolver({ signal: controller.signal, transport: async () => { called = true; } });
  assert.equal((await aborted(observation('https://boards.greenhouse.io/acme/jobs/1'))).evidence.resolution.reason, 'aborted');
  assert.equal(called, false);
});
