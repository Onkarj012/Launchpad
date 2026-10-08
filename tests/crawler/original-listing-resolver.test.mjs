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
import { normalizeConnectorEnvelope, parseHiringPostInbox } from '../../crawler/connector-inbox.mjs';
import { candidateDedupKey, candidateIdentityKeys, normalizeCandidate } from '../../job-pull/candidate.mjs';
import { deduplicateCandidates } from '../../job-pull/dedup.mjs';
import { createHostSerializedRunner } from '../../crawler/bounded-concurrency.mjs';

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

test('matching ATS JSON-LD organization cannot prove an unnamed client employer', async () => {
  const url = 'https://www.careers-page.com/leading-edge/job/937YX54Y';
  for (const description of [
    'Our client is looking for a talented Software Developer. 2+ years of professional software development experience.',
    'We are recruiting on behalf of our client for a Software Developer.',
    'We are hiring for a client. Build backend software.',
  ]) {
    const resolver = createOriginalListingResolver({ transport: async () => jsonLdPage({
      hiringOrganization: { name: 'Leading Edge', sameAs: 'https://www.leadingedge.plus' },
      title: 'Software Developer', description, employmentType: 'FULL_TIME',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } }, datePosted: '2026-10-06',
    }) });
    const result = await resolver(observation(url, { company: 'Leading Edge', title: 'Software Developer' }));
    assert.equal(result.status, 'verification');
    assert.equal(result.evidence.resolution.reason, 'destination-hiring-employer-unverified');
    assert.equal(result.originalApplicationUrl, null);
    assert.equal(result.applicationResolution.status, 'Needs Verification');
    assert.equal(isShortlistEligibleFromResolution(result), false);
  }
});

test('named employers can describe client work and share the corrected experience parser', async () => {
  const url = 'https://boards.greenhouse.io/acme/jobs/123';
  const resolver = createOriginalListingResolver({ transport: async () => jsonLdPage({
    hiringOrganization: { name: 'Acme' }, title: 'Software Developer',
    description: 'Build software for our clients. Minimum two year(s) of experience is required Educational Qualification : 15 years full time education.',
    employmentType: 'FULL_TIME',
  }) });
  const result = await resolver(observation(url, { company: 'Acme' }));
  assert.equal(result.status, 'resolved');
  assert.equal(result.patch.experience.minYears, 2);
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

test('portal leads cross-match the registry board by employer, title, location, and requisition', async () => {
  const boardUrl = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true';
  const detailUrl = 'https://boards.greenhouse.io/acme/jobs/123';
  const requests = [];
  const resolve = createOriginalListingResolver({
    config: { boardRegistry: { boards: [{ provider: 'greenhouse', slug: 'acme', company: 'Acme Labs', enabled: true }] } },
    transport: async (url) => {
      requests.push(url);
      if (url === boardUrl) return { status: 200, body: { jobs: [
        { id: 122, title: 'AI Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/122', location: { name: 'Bengaluru, India' } },
        { id: 123, title: 'AI Engineer', absolute_url: detailUrl, location: { name: 'Pune, India' } },
      ] } };
      return jsonLdPage({ title: 'AI Engineer', hiringOrganization: { name: 'Acme Labs' }, identifier: { value: '123' },
        jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } }, description: 'Build AI services.' });
    },
  });
  const result = await resolve(observation('https://www.linkedin.com/jobs/view/456', {
    provider: 'linkedin-jobs', company: 'Acme Labs', title: 'AI Engineer', location: 'Pune', requisitionId: '123',
  }));
  assert.equal(result.status, 'resolved');
  assert.equal(result.originalApplicationUrl, detailUrl);
  assert.deepEqual(requests, [boardUrl, detailUrl]);
  assert.deepEqual(result.telemetry.crossMatch, {
    attempted: true, boardRequests: 1, verifiedRoutes: 1, resolverRequests: 2, verifiedRoutesPerRequest: 0.5, budgetRaised: false,
  });
  assert.equal(result.telemetry.budget.maxRequests, 8);
});

test('LinkedIn detail lookup keeps its normal request when the employer has no supported registry board', async () => {
  const linkedinUrl = 'https://www.linkedin.com/jobs/view/123456';
  const requests = [];
  const resolve = createOriginalListingResolver({
    config: { boardRegistry: { boards: [{ provider: 'greenhouse', slug: 'other', company: 'Other Labs', enabled: true }] } },
    transport: async (url) => {
      requests.push(url);
      const page = jsonLdPage({ title: 'AI Engineer', hiringOrganization: { name: 'Acme Labs' },
        identifier: { value: '123456' }, description: 'Build AI services in Pune.' });
      return { ...page, body: `<link rel="canonical" href="${linkedinUrl}">${page.body}` };
    },
  });
  const result = await resolve(observation(linkedinUrl, {
    provider: 'linkedin-jobs', company: 'Acme Labs', title: 'AI Engineer', location: 'Pune',
  }));
  assert.deepEqual(requests, [linkedinUrl]);
  assert.equal(result.portalPatch.description, 'Build AI services in Pune.');
  assert.equal(result.telemetry.requests, 1);
});

test('portal cross-match misses and identity mismatches stay in verification', async (t) => {
  const boardUrl = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true';
  for (const scenario of [
    { name: 'no title match', row: { id: 123, title: 'Backend Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/123', location: { name: 'Pune, India' } } },
    { name: 'no location match', row: { id: 123, title: 'AI Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/123', location: { name: 'Bengaluru, India' } } },
    { name: 'requisition mismatch', row: { id: 124, title: 'AI Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/124', location: { name: 'Pune, India' } } },
  ]) await t.test(scenario.name, async () => {
    const requests = [];
    const resolve = createOriginalListingResolver({
      config: { boardRegistry: { boards: [{ provider: 'greenhouse', slug: 'acme', company: 'Acme Labs', enabled: true }] } },
      transport: async (url) => {
        requests.push(url);
        return { status: 200, body: { jobs: [scenario.row] } };
      },
    });
    const result = await resolve(observation('https://www.glassdoor.com/job-listing/ai-engineer', {
      provider: 'glassdoor', company: 'Acme Labs', title: 'AI Engineer', location: 'Pune', requisitionId: '123',
    }));
    assert.equal(result.status, 'verification');
    assert.equal(result.applicationResolution.status, 'Needs Verification');
    assert.equal(result.originalApplicationUrl, null);
    assert.deepEqual(requests, [boardUrl]);
  });
});

test('Workday cross-match searches with the portal title and records a verified route measurement', async () => {
  const listUrl = 'https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/jobs';
  const detailUrl = 'https://acme.wd3.myworkdayjobs.com/External/job/Pune/AI-Engineer_JR123';
  const requests = [];
  const resolve = createOriginalListingResolver({
    config: { boardRegistry: { boards: [{ provider: 'workday', tenant: 'acme', instance: 'wd3', site: 'External', company: 'Acme Labs', enabled: true }] } },
    transport: async (url, options) => {
      requests.push({ url, options });
      if (url === listUrl) return { status: 200, body: { jobPostings: [
        { title: 'AI Engineer', jobReqId: 'JR123', location: { descriptor: 'Pune, India' }, externalPath: '/job/Pune/AI-Engineer_JR123' },
      ] } };
      return jsonLdPage({ title: 'AI Engineer', hiringOrganization: { name: 'Acme Labs' },
        jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } }, description: 'Build AI services.' });
    },
  });
  const result = await resolve(observation('https://www.wellfound.com/jobs/456', {
    provider: 'wellfound', company: 'Acme Labs', title: 'AI Engineer', location: 'Pune',
  }));
  assert.equal(result.status, 'resolved');
  assert.equal(result.originalApplicationUrl, detailUrl);
  assert.equal(requests[0].url, listUrl);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(JSON.parse(requests[0].options.body).searchText, 'AI Engineer');
  assert.equal(result.telemetry.crossMatch.verifiedRoutesPerRequest, 0.5);
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

test('resolver claims an invocation shared request budget synchronously across concurrent candidates', async () => {
  let used = 0;
  const shared = {
    maxRequests: 2,
    claim() {
      if (used >= 2) return false;
      used += 1;
      return true;
    },
  };
  const calls = [];
  const resolve = createOriginalListingResolver({
    maxRequests: 8,
    requestBudget: shared,
    transport: async (url) => {
      calls.push(url);
      return { status: 200, body: '<script type="application/ld+json">{"@type":"JobPosting","title":"AI Engineer","description":"Pune role","datePosted":"2026-08-30"}</script>' };
    },
  });
  const results = await Promise.all([
    resolve(observation('https://boards.greenhouse.io/acme/jobs/1')),
    resolve(observation('https://boards.greenhouse.io/acme/jobs/2')),
    resolve(observation('https://boards.greenhouse.io/acme/jobs/3')),
  ]);
  assert.equal(used, 2);
  assert.equal(calls.length, 2);
  assert.equal(results.filter((result) => result.status === 'resolved').length, 2);
  assert.equal(results.filter((result) => result.evidence.resolution.reason === 'request-budget-exhausted').length, 1);
});

test('resolver accepts a function-valued injected deadline without using wall-clock math', async () => {
  let remaining = 20;
  let calls = 0;
  const resolve = createOriginalListingResolver({
    deadline: { remainingMs: () => remaining },
    transport: async () => {
      calls += 1;
      remaining = 0;
      return jsonLdPage({ title: 'AI Engineer', description: 'Pune role', datePosted: '2026-08-30' });
    },
  });
  const first = await resolve(observation('https://boards.greenhouse.io/acme/jobs/1'));
  const second = await resolve(observation('https://boards.greenhouse.io/acme/jobs/2'));
  assert.equal(calls, 1);
  assert.equal(first.status, 'resolved');
  assert.equal(second.evidence.resolution.reason, 'deadline-exceeded');
});

test('aggregate request budget counts every redirect transport and stops later requests', async () => {
  const shared = { maxRequests: 48, used: 0, claim() { if (this.used >= this.maxRequests) return false; this.used += 1; return true; } };
  const calls = [];
  const resolve = createOriginalListingResolver({ maxRedirects: 2, sharedRequestBudget: shared, hostLimiter: createHostSerializedRunner(), transport: async (url) => {
    calls.push(url);
    if (url.includes('indeed.com')) {
      const id = new URL(url).searchParams.get('jk');
      return { status: 302, headers: { location: `https://boards.greenhouse.io/acme/jobs/${id}` } };
    }
    return jsonLdPage({ title: 'AI Engineer', description: 'Pune role', datePosted: '2026-08-30' });
  } });

  const results = await Promise.all(Array.from({ length: 25 }, (_, index) => resolve(observation(`https://www.indeed.com/viewjob?jk=aggregate-${index}`))));
  assert.equal(shared.used, 48);
  assert.equal(calls.length, 48);
  assert.equal(results.filter((result) => result.status === 'resolved').length, 23);
  assert.equal(results.filter((result) => result.evidence.resolution.reason === 'request-budget-exhausted').length, 1);
});

test('different discovery hosts serialize requests after converging on one destination host', async () => {
  const destination = 'https://boards.greenhouse.io/acme/jobs/shared-host';
  const releases = [];
  let active = 0;
  let maximum = 0;
  const resolve = createOriginalListingResolver({
    hostLimiter: createHostSerializedRunner(),
    transport: async (url) => {
      if (url !== destination) return { status: 302, headers: { location: destination } };
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolveRelease) => releases.push(resolveRelease));
      active -= 1;
      return jsonLdPage({ title: 'AI Engineer', description: 'Pune role', datePosted: '2026-08-30' });
    },
  });
  const first = resolve(observation('https://www.indeed.com/viewjob?jk=shared-1'));
  const second = resolve(observation('https://www.glassdoor.com/job-listing/shared-2'));
  await new Promise((done) => setImmediate(done));
  assert.equal(maximum, 1);
  releases.shift()?.();
  await new Promise((done) => setImmediate(done));
  releases.shift()?.();
  await Promise.all([first, second]);
  assert.equal(maximum, 1);
});

test('resolver deadline aborts transport before releasing a same-host lock', async () => {
  let active = 0;
  let maximum = 0;
  let aborted = 0;
  const resolve = createOriginalListingResolver({
    hostLimiter: createHostSerializedRunner(),
    deadline: { deadlineMs: Date.now() + 15 },
    transport: async (_url, options) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => { active -= 1; aborted += 1; reject(options.signal.reason); }, { once: true });
      });
    },
  });
  const results = await Promise.all([
    resolve(observation('https://boards.greenhouse.io/acme/jobs/timeout-1')),
    resolve(observation('https://boards.greenhouse.io/acme/jobs/timeout-2')),
  ]);
  assert.equal(aborted, 1);
  assert.equal(maximum, 1);
  assert.ok(results.every((result) => result.evidence.resolution.reason === 'deadline-exceeded'));
});

test('employer fingerprints prefer case-insensitive query IDs and reject generic paths', () => {
  for (const key of ['jobId', 'job_id', 'jobid', 'reqId', 'req', 'requisitionId', 'career_job_req_id', 'jobReqId', 'gh_jid', 'id', 'job']) {
    assert.equal(extractProviderFingerprint(`https://careers.acme-corp.com/jobdetails?${key.toUpperCase()}=R-1001`).requisitionId, 'R-1001', key);
  }
  for (const segment of ['jobdetails', 'job-details', 'details', 'job', 'jobs', 'careers', 'apply', 'search', 'view', 'index', 'en', 'en-us', 'software-engineer']) {
    assert.equal(extractProviderFingerprint(`https://careers.acme-corp.com/${segment}`).requisitionId, null, segment);
  }
  assert.equal(extractProviderFingerprint('https://careers.acme-corp.com/job-details/R-1002').requisitionId, 'R-1002');
  assert.equal(extractProviderFingerprint('https://careers.acme-corp.com/job/123?jobId=R-1001&id=999').requisitionId, 'R-1001');
});

test('Workday fingerprints extract suffix requisitions and retain unrecognized slugs', () => {
  for (const [slug, id] of [['Software-Engineer_JR284401', 'JR284401'], ['Engineer_R-12345', 'R-12345'], ['Analyst_R-12345-1', 'R-12345'], ['Engineer_REQ1234-1', 'REQ1234'], ['Engineer_12345-2', '12345'], ['Engineer_Pune', 'Engineer_Pune'], ['Engineer%202026', 'Engineer 2026'], ['Senior%20Engineer%202', 'Senior Engineer 2'], ['Engineer_2026', 'Engineer_2026']]) {
    assert.equal(extractProviderFingerprint(`https://acme.myworkdayjobs.com/en-US/External/job/Pune/${slug}`).requisitionId, id);
  }
});

test('Lever and Ashby application URLs retain the posting UUID', () => {
  const id = '5ac21346-8e0c-4494-8e7a-3eb92ff77902';
  for (const host of ['jobs.lever.co', 'jobs.ashbyhq.com']) {
    for (const suffix of ['', '/apply', '/application', '/APPLICATION']) assert.equal(extractProviderFingerprint(`https://${host}/acme/${id}${suffix}`).requisitionId, id);
  }
});

test('challenge headers and markers block while real job text with generic phrases resolves', async () => {
  const url = 'https://boards.greenhouse.io/acme/jobs/123';
  for (const response of [
    { status: 200, headers: { 'cf-mitigated': 'challenge' }, body: '<html>Continue</html>' },
    { status: 503, headers: new Map([['cf-mitigated', 'challenge']]), body: '<html>Continue</html>' },
    { status: 200, headers: { 'CF-Mitigated': 'challenge' }, body: '<html>Continue</html>' },
    { status: 200, body: '<html>Just a moment</html>' },
    { status: 200, body: '<html>Access denied</html>' },
    { status: 200, body: '<html><h1>Attention required</h1></html>' },
    { status: 200, body: `<html><h1>Attention Required</h1>${'x'.repeat(5_000)}</html>` },
    { status: 200, body: `<html><h1>Access denied</h1>${'x'.repeat(5_000)}</html>` },
  ]) {
    const result = await createOriginalListingResolver({ transport: async () => response })(observation(url));
    assert.equal(result.evidence.resolution.reason, 'blocked');
  }
  for (const description of ['Responsibilities: handle access denied errors in our APIs. Qualifications: Python experience.', 'Attention required when reviewing changes.']) {
    const response = jsonLdPage({ title: 'AI Engineer', description });
    response.headers = { 'cf-mitigated': 'other' };
    const result = await createOriginalListingResolver({ transport: async () => response })(observation(url));
    assert.equal(result.status, 'resolved', description);
  }
});

test('resolved portal leads retain their identity alias without collapsing employer requisitions', async () => {
  const resolved = [];
  for (const id of ['R-1001', 'R-1002']) {
    const url = `https://careers.acme-corp.com/jobdetails?jobId=${id}`;
    const lead = observation(`https://www.naukri.com/job-listings-${id}`, { provider: 'naukri', jobId: `portal-${id}`, providerJobId: `portal-${id}`, company: 'Acme Corp' });
    const resolver = createOriginalListingResolver({ transport: async (target) => target === lead.canonicalUrl
      ? { status: 302, headers: { location: url } }
      : jsonLdPage({ title: 'AI Engineer', hiringOrganization: { name: 'Acme Corp' }, description: 'Build APIs.' }) });
    const resolution = await resolver(lead);
    assert.equal(resolution.status, 'resolved');
    const candidate = normalizeCandidate(applyOriginalListingResolution(lead, resolution));
    assert.equal(candidate.jobId, id);
    assert.equal(resolution.patch.providerJobId, id);
    assert.ok(candidateIdentityKeys(candidate).includes(candidateDedupKey(lead)));
    const dedup = deduplicateCandidates([candidate], { ledgerRows: [{ dedup_key: candidateDedupKey(lead), state: 'committed' }] });
    assert.equal(dedup.kept.length, 0);
    resolved.push(candidate);
  }
  assert.notEqual(candidateDedupKey(resolved[0]), candidateDedupKey(resolved[1]));
  assert.equal(deduplicateCandidates(resolved).kept.length, 2);
});

test('LinkedIn destination checks compare old and new Workday requisitions consistently', async () => {
  const leadUrl = 'https://www.linkedin.com/jobs/view/1234567890';
  const target = 'https://acme.myworkdayjobs.com/External/job/Pune/AI-Engineer_JR284401';
  const resolver = createOriginalListingResolver({ transport: async (url) => url === leadUrl
    ? { status: 302, headers: { location: target } }
    : jsonLdPage({ title: 'AI Engineer', hiringOrganization: { name: 'Acme' }, identifier: { value: 'JR284401' }, description: 'Build APIs.' }) });
  const result = await resolver(observation(leadUrl, { company: 'Acme', requisitionId: 'AI-Engineer_JR284401' }));
  assert.equal(result.status, 'resolved');
  assert.equal(result.patch.requisitionId, 'JR284401');
});

// Verify the public-only boundary with pasted posts and injected HTTP responses.
test('hiring-post resolution never fetches a post or an authenticated application route', async (t) => {
  const postUrl = 'https://www.linkedin.com/posts/acme-hiring';
  const publicUrl = 'https://boards.greenhouse.io/acme/jobs/123';
  for (const { name, target, response, expectedRequests } of [
    { name: 'post without an employer link', target: '', expectedRequests: [] },
    { name: 'login target', target: 'https://boards.greenhouse.io/users/sign_in', expectedRequests: [] },
    { name: 'embedded credentials', target: 'https://user:password@boards.greenhouse.io/acme/jobs/123', expectedRequests: [] },
    { name: 'login redirect', target: publicUrl, response: { status: 302, headers: { location: 'https://boards.greenhouse.io/users/sign_in' } }, expectedRequests: [publicUrl] },
    { name: 'authentication failure', target: publicUrl, response: { status: 401, body: 'Sign in to continue' }, expectedRequests: [publicUrl] },
  ]) {
    await t.test(name, async () => {
      const [envelope] = parseHiringPostInbox(`${postUrl}\n\nCompany: Acme Labs\nTitle: AI Engineer\nWe are hiring. Apply: ${target}`);
      const [lead] = normalizeConnectorEnvelope(envelope).observations;
      const requests = [];
      const requestOptions = [];
      const resolver = createOriginalListingResolver({ transport: async (url, options) => {
        requests.push(url);
        requestOptions.push(options);
        return response ?? jsonLdPage({ title: 'AI Engineer', hiringOrganization: { name: 'Acme Labs' }, description: 'Build AI services.' });
      } });
      const result = await resolver(lead);
      assert.equal(result.status, 'verification');
      assert.equal(result.applicationResolution.status, 'Needs Verification');
      assert.equal(result.originalApplicationUrl, null);
      assert.deepEqual(requests, expectedRequests);
      for (const options of requestOptions) assert.equal(options.credentials, 'omit');
    });
  }
});

// A pasted public apply link can supply fields that the post did not state.
test('hiring posts need only a URL and pasted text to resolve a verified employer job', async () => {
  const postUrl = 'https://x.com/founder/status/123';
  const employerUrl = 'https://boards.greenhouse.io/acme/jobs/123';
  const [envelope] = parseHiringPostInbox(`${postUrl}\n\nWe're hiring junior engineers. Apply at ${employerUrl}`);
  const [lead] = normalizeConnectorEnvelope(envelope).observations;
  const resolver = createOriginalListingResolver({ transport: async (url) => {
    assert.equal(url, employerUrl);
    return jsonLdPage({ title: 'AI Engineer', hiringOrganization: { name: 'Acme Labs' },
      description: 'Full-time AI engineering. Build Python services.', employmentType: 'FULL_TIME' });
  } });
  const result = applyOriginalListingResolution(lead, await resolver(lead));
  assert.equal(result.applicationResolution.status, 'Resolved Original');
  assert.equal(result.originalApplicationUrl, employerUrl);
  assert.equal(result.company, 'Acme Labs');
  assert.equal(result.title, 'AI Engineer');
  assert.equal(result.evidence.fieldSources.company, 'original-employer-detail');
  assert.equal(result.discoveryUrl, postUrl);
});
