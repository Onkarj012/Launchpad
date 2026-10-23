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
import { applicationReadiness } from '../../job-pull/normal-readiness.mjs';
import { classifyCandidate } from '../../job-pull/eligibility.mjs';
import { loadConfig } from '../../job-pull/config.mjs';

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
  assert.equal(result.patch.requisitionId, undefined);
  assert.equal(result.providerFingerprint.requisitionId, '12345');
  assert.equal(result.evidence.fieldSources.description, 'original-employer-detail');
  assert.equal(result.shortlistEligible, true);
  assert.equal(result.telemetry.requests, 1);
  assert.ok(result.telemetry.budget.maxRequests >= 1);
});

test('ordinary direct ATS resolution carries closing evidence without changing resolution', async (t) => {
  for (const [name, closing, outcome, reason] of [
    ['open', {}, null, null],
    ['closed', { isClosed: true }, 'confirmed-closed', 'source-closed-flag'],
    ['expired', { validThrough: '2000-01-01' }, 'expired', 'valid-through-past'],
  ]) await t.test(name, async () => {
    const url = 'https://boards.greenhouse.io/acme/jobs/12345';
    const resolve = createOriginalListingResolver({ transport: async () => jsonLdPage({
      title: 'AI Engineer', description: 'Build Python services.', ...closing,
    }) });
    const result = await resolve(observation(url));
    assert.equal(result.status, 'resolved');
    assert.equal(result.originalApplicationUrl, url);
    assert.equal(result.shortlistEligible, true);
    assert.equal(result.patch.liveness.status, outcome ? 'Expired' : 'Active');
    if (outcome) {
      assert.equal(result.evidence.closingState?.outcome, outcome);
      assert.equal(result.evidence.closingState.reason, reason);
      assert.deepEqual(result.patch.evidence.closingState, result.evidence.closingState);
    } else assert.equal(result.evidence.closingState, undefined);
  });
});

test('portal leads cross-match the registry board by employer, title, location, and requisition', async () => {
  const boardUrl = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true';
  const detailUrl = 'https://boards.greenhouse.io/acme/jobs/123';
  const requests = [];
  const resolve = createOriginalListingResolver({
    config: { boardRegistry: { boards: [{ provider: 'greenhouse', slug: 'acme', company: 'Acme Labs', enabled: true, probeStatus: 'verified' }] } },
    transport: async (url) => {
      requests.push(url);
      if (url === boardUrl) return { status: 200, body: { jobs: [
        { id: 122, title: 'AI Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/122', location: { name: 'Bengaluru, India' } },
        { id: 123, title: 'AI Engineer', absolute_url: detailUrl, location: { name: 'Pune, India' } },
      ] } };
      assert.equal(url, 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/123');
      return { status: 200, body: { id: 123, title: 'AI Engineer', absolute_url: detailUrl,
        location: { name: 'Pune, India' }, content: '<p>Build AI services.</p>' } };
    },
  });
  const result = await resolve(observation('https://www.linkedin.com/jobs/view/456', {
    provider: 'linkedin-jobs', company: 'Acme Labs', title: 'AI Engineer', location: 'Pune', requisitionId: '123',
  }));
  assert.equal(result.status, 'resolved');
  assert.equal(result.originalApplicationUrl, detailUrl);
  assert.deepEqual(requests, [boardUrl, 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/123']);
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
  const cachedResult = await resolve(observation(linkedinUrl, {
    provider: 'linkedin-jobs', company: 'Acme Labs', title: 'AI Engineer', location: 'Pune',
  }));
  assert.deepEqual(requests, [linkedinUrl]);
  assert.deepEqual(cachedResult.portalPatch, result.portalPatch);
  assert.equal(cachedResult.telemetry.requests, 0);
  assert.equal(cachedResult.telemetry.cacheHits, 1);
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
      config: { boardRegistry: { boards: [{ provider: 'greenhouse', slug: 'acme', company: 'Acme Labs', enabled: true, probeStatus: 'verified' }] } },
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
    config: { boardRegistry: { boards: [{ provider: 'workday', tenant: 'acme', instance: 'wd3', site: 'External', company: 'Acme Labs', enabled: true, probeStatus: 'verified' }] } },
    transport: async (url, options) => {
      requests.push({ url, options });
      if (url === listUrl) return { status: 200, body: { jobPostings: [
        { title: 'AI Engineer', jobReqId: 'JR123', location: { descriptor: 'Pune, India' }, externalPath: '/job/Pune/AI-Engineer_JR123' },
      ] } };
      assert.equal(url, 'https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/job/Pune/AI-Engineer_JR123');
      return { status: 200, body: { jobPostingInfo: { title: 'AI Engineer', jobReqId: 'JR123',
        location: 'Pune, India', timeType: 'Full time', jobDescription: '<p>Build AI services.</p>', startDate: '2026-10-12', canApply: true } } };
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

test('Instahyre visible external application links resolve without private portal requests', async () => {
  const portalUrl = 'https://www.instahyre.com/job-123456-ai-engineer-at-acme/';
  const employerUrl = 'https://acme.com/application/123';
  const requests = [];
  const resolve = createOriginalListingResolver({
    transport: async (url, options) => {
      requests.push({ url, options });
      if (url === portalUrl.slice(0, -1)) return { status: 200, body: `<a href="${employerUrl}">Apply on company website</a>` };
      return jsonLdPage({ title: 'AI Engineer', hiringOrganization: { name: 'Acme' },
        jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } }, description: 'Build AI tools.' });
    },
  });
  const result = await resolve(observation(portalUrl, { provider: 'instahyre', company: 'Acme', title: 'AI Engineer', location: 'Pune' }));
  assert.equal(result.status, 'resolved');
  assert.equal(result.originalApplicationUrl, employerUrl);
  assert.deepEqual(requests.map(({ url }) => url), [portalUrl.slice(0, -1), employerUrl]);
  assert.ok(requests.every(({ options }) => options.method === 'GET'));
});

test('Wellfound visible external application links resolve without private portal requests', async () => {
  const portalUrl = 'https://wellfound.com/jobs/123-acme-ai-engineer';
  const employerUrl = 'https://acme.com/application/456';
  const requests = [];
  const resolve = createOriginalListingResolver({
    transport: async (url, options) => {
      requests.push({ url, options });
      if (url === portalUrl) return { status: 200, body: `<a href="${employerUrl}">Apply externally</a>` };
      return jsonLdPage({ title: 'AI Engineer', hiringOrganization: { name: 'Acme' },
        jobLocation: { address: { addressLocality: 'Remote', addressCountry: 'India' } }, description: 'Build AI tools.' });
    },
  });
  const result = await resolve(observation(portalUrl, { provider: 'wellfound', company: 'Acme', title: 'AI Engineer', location: 'Remote India' }));
  assert.equal(result.status, 'resolved');
  assert.equal(result.originalApplicationUrl, employerUrl);
  assert.deepEqual(requests.map(({ url }) => url), [portalUrl, employerUrl]);
  assert.ok(requests.every(({ options }) => options.method === 'GET'));
});

test('Instahyre login links stay in verification without fetching the login route', async () => {
  const portalUrl = 'https://www.instahyre.com/job-123456-ai-engineer-at-acme/';
  const loginUrl = 'https://acme.com/login/application/123';
  const requests = [];
  const resolve = createOriginalListingResolver({
    transport: async (url) => {
      requests.push(url);
      return { status: 200, body: `<a href="${loginUrl}">Apply on company website</a>` };
    },
  });
  const result = await resolve(observation(portalUrl, { provider: 'instahyre', company: 'Acme', title: 'AI Engineer' }));
  assert.equal(result.status, 'verification');
  assert.deepEqual(requests, [portalUrl.slice(0, -1)]);
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
  assert.equal(result.patch.postedAt, '2026-07-22');
  assert.equal(result.patch.evidence.dateEvidence.originalPublication.value, '2026-07-22');
  assert.equal(result.patch.evidence.dateEvidence.originalPublication.precision, 'date');
  assert.deepEqual(result.patch.evidence.freshness, { kind: 'workday-startDate' });
  const missingDateResolver = createOriginalListingResolver({ transport: async () => jsonLdPage({
    title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Acme' },
  }) });
  const missingDate = await missingDateResolver(observation('https://boards.greenhouse.io/acme/jobs/123', {
    provider: 'greenhouse', jobId: '123', company: 'Acme', title: 'AI Engineer', postedAt: '2026-10-20',
    dateEvidence: { originalPublication: { value: '2026-10-20T08:00:00Z', source: 'employer-detail' } },
  }));
  assert.equal(missingDate.status, 'resolved');
  assert.equal(missingDate.patch.postedAt, null);
  assert.equal(missingDate.patch.dateEvidence.originalPublication, null);
  assert.equal(missingDate.patch.dateEvidence.originalPublicationAlternates[0].value, '2026-10-20T08:00:00Z');
  const mismatchedPageResolver = createOriginalListingResolver({ transport: async () => jsonLdPage({
    title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Other Employer' },
    identifier: { value: '456' }, datePosted: '2026-10-20',
  }) });
  const mismatchedPage = await mismatchedPageResolver(observation('https://boards.greenhouse.io/acme/jobs/123', {
    provider: 'greenhouse', jobId: '123', company: 'Acme', title: 'AI Engineer',
  }));
  assert.equal(mismatchedPage.status, 'verification');
  assert.equal(mismatchedPage.evidence.resolution.reason, 'destination-employer-identity-mismatch');
  const genericIdentifierResolver = createOriginalListingResolver({ transport: async () => jsonLdPage({
    title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Acme' }, identifier: { value: 456 },
  }) });
  const genericIdentifier = await genericIdentifierResolver(observation('https://boards.greenhouse.io/acme/jobs/123', {
    provider: 'greenhouse', jobId: '123', company: 'Acme', title: 'AI Engineer',
  }));
  assert.equal(genericIdentifier.status, 'resolved');
  assert.equal(genericIdentifier.patch.jobId, '123');
  assert.deepEqual(genericIdentifier.patch.evidence.resolution.destinationIdentifier, { value: '456', namespace: 'unknown' });
  const knownEmployerReqResolver = createOriginalListingResolver({ transport: async () => jsonLdPage({
    title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Acme' }, jobReqId: 'REQ-99',
  }) });
  const knownEmployerReqMismatch = await knownEmployerReqResolver(observation('https://boards.greenhouse.io/acme/jobs/123', {
    provider: 'greenhouse', jobId: '123', employerRequisitionId: 'REQ-42', company: 'Acme', title: 'AI Engineer',
  }));
  assert.equal(knownEmployerReqMismatch.status, 'verification');
  assert.equal(knownEmployerReqMismatch.evidence.resolution.reason, 'destination-role-identity-mismatch');
  const retainedDates = normalizeCandidate({
    url: 'https://boards.greenhouse.io/acme/jobs/123', provider: 'greenhouse', jobId: '123', company: 'Acme', title: 'AI Engineer',
    postedAt: '2026-10-20T08:00:00Z', dateEvidence: {
      originalPublication: { value: '2026-09-01', source: 'original-employer-detail', precision: 'date' },
      sourcePublication: { value: '2026-10-20T08:00:00Z', source: 'catalog' },
      catalogFirstSeen: { value: '2026-01-01T00:00:00Z', source: 'catalog-first-seen' },
      updatedAt: { value: '2026-10-19T00:00:00Z', source: 'source-update' },
      conflicts: ['retained conflict'],
    },
  });
  const retainedResolver = createOriginalListingResolver({ transport: async () => jsonLdPage({
    title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Acme' }, datePosted: '2026-10-15',
  }) });
  const retainedResult = await retainedResolver(retainedDates, { runAt: '2026-10-20T09:00:00Z' });
  assert.equal(retainedResult.patch.dateEvidence.catalogFirstSeen.value, '2026-01-01T00:00:00Z');
  assert.equal(retainedResult.patch.dateEvidence.updatedAt.value, '2026-10-19T00:00:00Z');
  assert.equal(retainedResult.patch.dateEvidence.sourcePublication.value, '2026-10-20T08:00:00Z');
  assert.ok(retainedResult.patch.dateEvidence.conflicts.includes('retained conflict'));
  assert.ok(retainedResult.patch.dateEvidence.conflicts.some((item) => item.includes('2026-09-01') && item.includes('2026-10-15')));
  assert.deepEqual(retainedResult.patch.dateEvidence.originalPublicationAlternates.map((item) => item.value), ['2026-09-01', '2026-10-15']);
  assert.deepEqual(retainedResult.patch.dateEvidence, retainedResult.patch.evidence.dateEvidence);
  assert.equal(normalizeCandidate(retainedResult.patch).postedAt, '2026-09-01');
  const reverseDates = normalizeCandidate({
    url: 'https://boards.greenhouse.io/acme/jobs/123', provider: 'greenhouse', jobId: '123', company: 'Acme', title: 'AI Engineer',
    postedAt: '2026-10-15', dateEvidence: { originalPublication: { value: '2026-10-15', source: 'original-employer-detail', precision: 'date' } },
  });
  const reverseResolver = createOriginalListingResolver({ transport: async () => jsonLdPage({
    title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Acme Inc.' }, datePosted: '2026-09-01',
  }) });
  const reverseResult = await reverseResolver(reverseDates, { runAt: '2026-10-20T09:00:00Z' });
  assert.equal(reverseResult.status, 'resolved');
  assert.equal(applyOriginalListingResolution(reverseDates, reverseResult).applicationResolution.status, 'Resolved Original');
  assert.equal(normalizeCandidate(reverseResult.patch).postedAt, '2026-09-01');
  assert.deepEqual(reverseResult.patch.dateEvidence.originalPublicationAlternates.map((item) => item.value), ['2026-10-15', '2026-09-01']);
  const numericLeverResolver = createOriginalListingResolver({ transport: async () => jsonLdPage({
    title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Acme' }, datePosted: 1792483200000,
  }) });
  const numericLever = await numericLeverResolver(observation('https://jobs.lever.co/acme/123', { provider: 'lever', jobId: '123', company: 'Acme' }));
  assert.equal(numericLever.status, 'resolved');
  assert.equal(numericLever.patch.dateEvidence.originalPublication.value, 1792483200000);
  assert.equal(normalizeCandidate(numericLever.patch).postedAt, new Date(1792483200000).toISOString());
  const ambiguousLeverResolver = createOriginalListingResolver({ transport: async () => jsonLdPage({
    title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Acme' }, datePosted: '2026-10-20 08:00:00',
  }) });
  const ambiguousLever = await ambiguousLeverResolver(observation('https://jobs.lever.co/acme/124', { provider: 'lever', jobId: '124', company: 'Acme' }));
  assert.equal(ambiguousLever.patch.postedAt, null);
  assert.equal(ambiguousLever.patch.dateEvidence.originalPublication, null);
  assert.equal(ambiguousLever.patch.dateEvidence.originalPublicationAlternates[0].value, '2026-10-20 08:00:00');
  assert.equal(normalizeCandidate(ambiguousLever.patch).postedAt, null);
  for (const datePosted of ['2026-02-30', '2025-02-29', '2026-02-30T08:00:00Z']) {
    const impossibleDateResolver = createOriginalListingResolver({ transport: async () => jsonLdPage({
      title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Acme' }, datePosted,
    }) });
    const impossibleDate = await impossibleDateResolver(observation('https://jobs.lever.co/acme/125', { provider: 'lever', jobId: '125', company: 'Acme' }));
    assert.equal(impossibleDate.patch.postedAt, null, datePosted);
    assert.equal(impossibleDate.patch.dateEvidence.originalPublication, null, datePosted);
    assert.equal(impossibleDate.patch.dateEvidence.originalPublicationAlternates[0].value, datePosted);
  }
  const leapDayResolver = createOriginalListingResolver({ transport: async () => jsonLdPage({
    title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Acme' }, datePosted: '2024-02-29',
  }) });
  const leapDay = await leapDayResolver(observation('https://jobs.lever.co/acme/126', { provider: 'lever', jobId: '126', company: 'Acme' }));
  assert.equal(leapDay.patch.postedAt, '2024-02-29');
  const lead = observation('https://boards.greenhouse.io/acme/jobs/123', {
    provider: 'greenhouse', requisitionId: '123', company: 'Acme Labs', title: 'AI Engineer',
  });
  const applied = applyOriginalListingResolution(lead, {
    status: 'resolved', originalApplicationUrl: 'https://boards.greenhouse.io/acme/jobs/456',
    shortlistEligible: true,
    patch: { provider: 'greenhouse', jobId: '456', company: 'Acme Labs', title: 'AI Engineer', description: 'Build AI services.' },
  });
  assert.equal(applied.shortlistEligible, false);
  assert.equal(applied.originalApplicationUrl, null);
  assert.equal(applied.evidence.resolution.reason, 'destination-role-identity-mismatch');
  const mismatchedRedirect = createOriginalListingResolver({
    transport: async (url) => url === 'https://boards.greenhouse.io/acme/jobs/123'
      ? { status: 302, headers: { location: 'https://boards.greenhouse.io/acme/jobs/456' } }
      : jsonLdPage({ title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Acme Labs' }, identifier: { value: '456' } }),
  });
  const redirected = await mismatchedRedirect(lead);
  assert.equal(redirected.status, 'verification');
  assert.equal(redirected.evidence.resolution.reason, 'destination-role-identity-mismatch');
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
        title: 'ML Engineer', hiringOrganization: { name: 'Acme Labs' },
        description: '<p>Train models in Pune.</p>',
        jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'IN' } },
        employmentType: 'FULL_TIME',
        datePosted: '2026-07-22',
      });
    },
  });

  const lead = observation(discoveryUrl, {
    title: 'ML Engineer', company: 'Acme Labs',
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
  const exhausted = results.find((result) => result.evidence.resolution.reason === 'request-budget-exhausted');
  assert.equal(Boolean(exhausted), true);
  assert.equal(exhausted.evidence.requestBudgetExhausted, true);
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
  const exhausted = results.find((result) => result.evidence.resolution.reason === 'request-budget-exhausted');
  assert.equal(Boolean(exhausted), true);
  assert.equal(exhausted.evidence.requestBudgetExhausted, true);
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

// Model public provider payloads without browser HTML or authenticated endpoints.
function crossMatchFixture(provider) {
  const uuid = '5ac21346-8e0c-4494-8e7a-3eb92ff77902';
  const board = { provider, company: 'Acme Labs', enabled: true, probeStatus: 'verified',
    ...(provider === 'workday' ? { tenant: 'acme', instance: 'wd3', site: 'External' } : { slug: 'acme' }) };
  const title = 'AI Engineer';
  const location = 'Pune, India';
  const description = '<p>Full-time engineering. Build Python APIs.</p>';
  if (provider === 'greenhouse') {
    const applyUrl = 'https://job-boards.greenhouse.io/acme/jobs/123';
    const row = { id: 123, title, location: { name: location }, absolute_url: applyUrl };
    return { board, applyUrl, id: '123', row, list: { jobs: [row] }, postedAt: '2026-10-12T08:00:00Z',
      listUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true',
      detailUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/123',
      detail: { ...row, content: description, first_published: '2026-10-12T08:00:00Z' } };
  }
  if (provider === 'lever') {
    const applyUrl = `https://jobs.eu.lever.co/acme/${uuid}`;
    board.url = 'https://jobs.eu.lever.co/acme';
    const row = { id: uuid, text: title, categories: { location, commitment: 'Full-time' }, hostedUrl: applyUrl };
    return { board, applyUrl, id: uuid, row, list: [row], postedAt: '2026-10-12T08:00:00.000Z', listUrl: 'https://api.eu.lever.co/v0/postings/acme',
      detailUrl: `https://api.eu.lever.co/v0/postings/acme/${uuid}`,
      detail: { ...row, categories: { ...row.categories }, descriptionPlain: 'Full-time engineering. Build Python APIs.',
        lists: [{ text: 'Requirements', content: '<li>0-1 years of experience</li>' }],
        additionalPlain: 'Work with our product team.', createdAt: Date.parse('2026-10-12T08:00:00Z') } };
  }
  if (provider === 'ashby') {
    const applyUrl = `https://jobs.ashbyhq.com/acme/${uuid}/application`;
    // The public Ashby feed does not promise an id field.
    const row = { title, location, jobUrl: applyUrl, isListed: true, employmentType: 'FullTime',
      descriptionHtml: description, publishedAt: '2026-10-12T08:00:00Z' };
    return { board, applyUrl, id: uuid, row, list: { apiVersion: '1', jobs: [row] }, postedAt: '2026-10-12T08:00:00Z',
      listUrl: 'https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true', detailUrl: null, detail: row };
  }
  const applyUrl = 'https://acme.wd3.myworkdayjobs.com/External/job/Pune/AI-Engineer_JR123';
  const row = { title, locationsText: location, postedOn: 'Posted Today', bulletFields: ['JR123'], externalPath: '/job/Pune/AI-Engineer_JR123' };
  return { board, applyUrl, id: 'JR123', row, list: { total: 1, jobPostings: [row] }, postedAt: '2026-10-12',
    listUrl: 'https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/jobs',
    detailUrl: 'https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/job/Pune/AI-Engineer_JR123',
    detail: { jobPostingInfo: { title, location, jobReqId: 'JR123', timeType: 'Full time',
      jobDescription: description, startDate: '2026-10-12', canApply: true } } };
}

// Resolve one injected registry fixture and capture every attempted public request.
async function resolveCrossMatch(fixture, options = {}, lead = {}) {
  const requests = [];
  const resolver = createOriginalListingResolver({ runAt: '2026-10-13T08:00:00Z',
    now: () => '2026-10-13T08:00:00Z',
    config: { boardRegistry: { boards: [fixture.board] } },
    transport: async (url, requestOptions) => {
      requests.push({ url, options: requestOptions });
      assert.ok([fixture.listUrl, fixture.detailUrl].includes(url), url);
      return { status: 200, body: url === fixture.listUrl ? fixture.list : fixture.detail };
    }, ...options });
  const result = await resolver(observation('https://www.glassdoor.com/job-listing/ai-engineer', {
    provider: 'glassdoor', company: 'Acme Labs', location: 'Pune', requisitionId: fixture.id, ...lead,
  }));
  return { result, requests };
}

test('public JSON cross-matches preserve employer routes and posting identities for each supported provider', async (t) => {
  for (const provider of ['greenhouse', 'lever', 'ashby', 'workday']) await t.test(provider, async () => {
    const fixture = crossMatchFixture(provider);
    const { result, requests } = await resolveCrossMatch(fixture);
    assert.equal(result.status, 'resolved', result.evidence.resolution.reason);
    assert.equal(result.originalApplicationUrl, fixture.applyUrl);
    assert.equal(result.patch.requisitionId, fixture.id);
    assert.equal(result.patch.company, 'Acme Labs');
    assert.equal(result.patch.liveness.status, 'Active');
    assert.match(result.patch.description, /Build Python APIs/);
    assert.equal(result.patch.evidence.fieldSources.description, 'original-employer-detail');
    assert.equal(result.patch.evidence.registryEmployer.probeStatus, 'verified');
    assert.equal(result.patch.postedAt, fixture.postedAt);
    assert.deepEqual(requests.map((request) => request.url), [fixture.listUrl, ...(fixture.detailUrl ? [fixture.detailUrl] : [])]);
    for (const request of requests) assert.equal(request.options.credentials, 'omit');
    assert.equal(result.telemetry.requests, requests.length);
    assert.equal(result.telemetry.budget.maxRequests, 8);
    if (provider === 'lever') assert.match(result.patch.description, /Requirements 0-1 years of experience Work with our product team/);
  });
});

test('provider detail identity, liveness, and summary-only failures stay closed', async (t) => {
  for (const provider of ['greenhouse', 'lever', 'ashby', 'workday']) {
    for (const failure of ['title', 'location', 'id', 'employer', 'summary', 'closed']) await t.test(`${provider} ${failure}`, async () => {
      const fixture = crossMatchFixture(provider);
      const detail = provider === 'workday' ? fixture.detail.jobPostingInfo : fixture.detail;
      if (failure === 'title') detail[provider === 'lever' ? 'text' : 'title'] = 'Backend Engineer';
      if (failure === 'location') {
        if (provider === 'lever') detail.categories.location = 'Bengaluru, India';
        else detail.location = provider === 'greenhouse' ? { name: 'Bengaluru, India' } : 'Bengaluru, India';
      }
      if (failure === 'id') {
        if (provider === 'ashby') detail.jobUrl = detail.jobUrl.replace(fixture.id, 'aabbccdd-1234-1234-1234-aabbccddeeff');
        else detail[provider === 'workday' ? 'jobReqId' : 'id'] = 'other';
      }
      if (failure === 'employer') detail.companyName = 'Other Labs';
      if (failure === 'summary') for (const key of ['content', 'descriptionPlain', 'descriptionHtml', 'lists', 'additionalPlain', 'jobDescription']) delete detail[key];
      if (failure === 'closed') detail.active = false;
      const { result } = await resolveCrossMatch(fixture);
      assert.equal(result.status, 'verification');
      assert.equal(result.originalApplicationUrl, null);
      assert.equal(isShortlistEligibleFromResolution(result), false);
    });
  }

  for (const mismatch of ['employer', 'title', 'requisition']) {
    const fixture = crossMatchFixture('greenhouse');
    fixture.detail.active = false;
    if (mismatch === 'employer') fixture.detail.companyName = 'Other Labs';
    if (mismatch === 'title') fixture.detail.title = 'Backend Engineer';
    if (mismatch === 'requisition') fixture.detail.jobReqId = 'different-req';
    const { result } = await resolveCrossMatch(fixture);
    assert.equal(result.status, 'verification', mismatch);
    assert.equal(result.evidence.resolution.reason, mismatch === 'employer'
      ? 'destination-employer-identity-mismatch' : 'destination-role-identity-mismatch', mismatch);
    assert.equal(result.evidence.closingState, undefined, `${mismatch} mismatch cannot close the held identity`);
    assert.equal(isShortlistEligibleFromResolution(result), false);
  }
});

test('Workday detail parsing never borrows LIST dates or infers employment from a schedule shell', async () => {
  const fixture = crossMatchFixture('workday');
  delete fixture.detail.jobPostingInfo.startDate;
  delete fixture.detail.jobPostingInfo.timeType;
  const { result } = await resolveCrossMatch(fixture);
  assert.equal(result.patch.postedAt, null);
  assert.equal(result.patch.employment.type, null);
  assert.equal(result.patch.evidence.freshness.kind, 'workday-unverified');
});

test('registry search and detail preserve blocked, deadline, abort, host, byte, and request limits', async (t) => {
  for (const phase of ['list', 'detail']) for (const reason of ['blocked', 'deadline-exceeded', 'aborted', 'response-too-large', 'transport-error']) {
    await t.test(`${phase} ${reason}`, async () => {
      const fixture = crossMatchFixture('greenhouse');
      let remaining = 1000;
      const controller = new AbortController();
      let calls = 0;
      const { result } = await resolveCrossMatch(fixture, {
        maxBytes: 2000, signal: controller.signal, deadline: { remainingMs: () => remaining },
        transport: async (url) => {
          calls += 1;
          if (url === (phase === 'list' ? fixture.listUrl : fixture.detailUrl)) {
            if (reason === 'blocked') return { status: 403, body: 'Access denied' };
            if (reason === 'deadline-exceeded') { remaining = 0; throw new Error('expired'); }
            if (reason === 'aborted') { controller.abort(); throw new Error('aborted'); }
            if (reason === 'response-too-large') return { status: 200, body: 'x'.repeat(2001) };
            throw new Error('offline');
          }
          return { status: 200, body: fixture.list };
        },
      });
      assert.equal(result.evidence.resolution.reason, reason);
      assert.equal(calls, phase === 'list' ? 1 : 2);
    });
  }
  for (const [options, reason, calls] of [
    [{ maxRequests: 0 }, 'request-budget-exceeded', 0],
    [{ maxRequests: 1 }, 'request-budget-exceeded', 1],
    [{ maxHosts: 0 }, 'host-budget-exceeded', 0],
    [{ sharedRequestBudget: { claim: () => false } }, 'request-budget-exhausted', 0],
  ]) await t.test(reason, async () => {
    const { result, requests } = await resolveCrossMatch(crossMatchFixture('greenhouse'), options);
    assert.equal(result.evidence.resolution.reason, reason);
    assert.equal(requests.length, calls);
  });

  let registryResponseAt = Date.parse('2026-10-13T08:00:00.000Z');
  const retryAfterBoard = await resolveCrossMatch(crossMatchFixture('greenhouse'), {
    now: () => registryResponseAt,
    transport: async () => {
      registryResponseAt += 5 * 60_000;
      return { status: 429, headers: { 'Retry-After': '86400', 'x-private': 'drop-me' }, body: 'rate limited' };
    },
  });
  assert.equal(retryAfterBoard.result.evidence.retryAfterAt, '2026-10-14T08:05:00.000Z');
  assert.equal(JSON.stringify(retryAfterBoard.result.evidence).includes('drop-me'), false);

  let detailResponseAt = Date.parse('2026-10-20T00:00:00.000Z');
  const delayedDetail = createOriginalListingResolver({
    runAt: '2026-10-20T00:00:00.000Z',
    now: () => detailResponseAt,
    transport: async () => {
      detailResponseAt += 5 * 60_000;
      return { status: 429, headers: { 'Retry-After': '7200' }, body: 'rate limited' };
    },
  });
  const delayedDetailResult = await delayedDetail(observation('https://boards.greenhouse.io/acme/jobs/429'));
  assert.equal(delayedDetailResult.evidence.retryAfterAt, '2026-10-20T02:05:00.000Z');

  let cachedResponseAt = Date.parse('2026-10-20T10:00:00.000Z');
  let cachedRequests = 0;
  const cachedRateLimit = createOriginalListingResolver({
    runAt: '2026-10-20T10:00:00.000Z',
    now: () => cachedResponseAt,
    transport: async () => {
      cachedRequests += 1;
      return { status: 429, headers: { 'Retry-After': '3600' }, body: 'rate limited' };
    },
  });
  const cachedRateLimitObservation = observation('https://www.linkedin.com/jobs/view/987654', {
    provider: 'linkedin-jobs',
  });
  const firstCachedRateLimit = await cachedRateLimit(cachedRateLimitObservation);
  assert.equal(firstCachedRateLimit.evidence.retryAfterAt, '2026-10-20T11:00:00.000Z');
  cachedResponseAt = Date.parse('2026-10-20T10:30:00.000Z');
  const beforeDeadlineReuse = await cachedRateLimit(cachedRateLimitObservation);
  assert.equal(beforeDeadlineReuse.evidence.retryAfterAt, '2026-10-20T11:00:00.000Z');
  cachedResponseAt = Date.parse('2026-10-20T12:00:00.000Z');
  const expiredReuse = await cachedRateLimit(cachedRateLimitObservation);
  assert.equal(expiredReuse.evidence.retryAfterAt, '2026-10-20T11:00:00.000Z');
  assert.notEqual(expiredReuse.evidence.retryAfterAt, '2026-10-20T13:00:00.000Z');
  assert.equal(expiredReuse.telemetry.requests, 0);
  assert.equal(expiredReuse.telemetry.cacheHits, 1);
  assert.equal(cachedRequests, 1);

  for (const [retryAfter, responseAt, expected] of [
    ['Wed, 21 Oct 2026 00:00:00 GMT', '2026-10-20T00:05:00.000Z', '2026-10-21T00:00:00.000Z'],
    ['not-a-date', undefined],
    ['Tue, 20 Oct 2026 00:04:00 GMT', '2026-10-20T00:05:00.000Z', undefined],
  ]) {
    const resolve = createOriginalListingResolver({ runAt: '2026-10-20T00:00:00.000Z',
      now: () => responseAt ?? '2026-10-20T00:05:00.000Z', transport: async () => ({
        status: 429, headers: { 'Retry-After': retryAfter }, body: 'rate limited',
      }) });
    const result = await resolve(observation('https://boards.greenhouse.io/acme/jobs/429'));
    assert.equal(result.evidence.retryAfterAt, expected);
  }
});

test('disabled, warm, unverified, unsafe, and ambiguous boards cannot establish an employer match', async (t) => {
  for (const change of [{ enabled: false }, { probeStatus: 'warm' }, { probeStatus: undefined },
    { endpoint: 'https://api.lever.co/v1/private' }]) await t.test(JSON.stringify(change), async () => {
    const fixture = crossMatchFixture('greenhouse');
    Object.assign(fixture.board, change);
    let calls = 0;
    const { result } = await resolveCrossMatch(fixture, { transport: async () => { calls += 1; return { status: 403 }; } });
    assert.equal(result.status, 'verification');
    assert.ok(calls <= 1);
  });
  const fixture = crossMatchFixture('greenhouse');
  fixture.list.jobs.push({ ...fixture.row });
  const { result, requests } = await resolveCrossMatch(fixture);
  assert.equal(result.status, 'verification');
  assert.equal(requests.length, 1);
});


test('summary-only feeds and expired or unlisted details never prove JD readiness', async (t) => {
  for (const provider of ['greenhouse', 'lever', 'ashby', 'workday']) await t.test(provider, async () => {
    const fixture = crossMatchFixture(provider);
    const detail = provider === 'workday' ? fixture.detail.jobPostingInfo : fixture.detail;
    for (const key of ['content', 'descriptionPlain', 'descriptionHtml', 'lists', 'additionalPlain', 'jobDescription']) delete detail[key];
    fixture.row.summary = 'Full-time engineering. Build Python APIs.';
    const { result } = await resolveCrossMatch(fixture, {}, { description: 'Portal description must not hydrate the JD.' });
    assert.equal(result.status, 'verification');
    assert.equal(result.originalApplicationUrl, null);
  });
  for (const [provider, field, value] of [['workday', 'canApply', false], ['ashby', 'isListed', false], ['greenhouse', 'validThrough', '2000-01-01'], ['greenhouse', 'isClosed', true]]) {
    const fixture = crossMatchFixture(provider);
    (provider === 'workday' ? fixture.detail.jobPostingInfo : fixture.detail)[field] = value;
    const { result } = await resolveCrossMatch(fixture);
    assert.equal(result.status, 'verification');
    assert.equal(result.evidence.resolution.reason, 'destination-liveness-unverified');
    if (provider === 'greenhouse') {
      assert.equal(result.evidence.closingState.outcome, field === 'validThrough' ? 'expired' : 'confirmed-closed');
      assert.equal(result.evidence.closingState.evidence.validThrough, field === 'validThrough' ? '2000-01-01T00:00:00.000Z' : undefined);
      assert.equal(result.originalApplicationUrl, null);
    }
  }
});

test('cross-match checks deadlines after successful transport and does not fetch another page', async (t) => {
  for (const phase of ['list', 'detail']) await t.test(phase, async () => {
    const fixture = crossMatchFixture('greenhouse');
    let remaining = 1000;
    let calls = 0;
    const { result } = await resolveCrossMatch(fixture, { deadline: { remainingMs: () => remaining }, transport: async (url) => {
      calls += 1;
      if (url === (phase === 'list' ? fixture.listUrl : fixture.detailUrl)) remaining = 0;
      return { status: 200, body: url === fixture.listUrl ? fixture.list : fixture.detail };
    } });
    assert.equal(result.evidence.resolution.reason, 'deadline-exceeded');
    assert.equal(calls, phase === 'list' ? 1 : 2);
  });
});

test('registry routes reject private redirects, conflicting boards, and substring-only locations', async (t) => {
  for (const phase of ['list', 'detail']) await t.test(`${phase} redirect`, async () => {
    const fixture = crossMatchFixture('greenhouse');
    let calls = 0;
    const { result } = await resolveCrossMatch(fixture, { transport: async (url) => {
      calls += 1;
      return url === (phase === 'list' ? fixture.listUrl : fixture.detailUrl)
        ? { status: 302, headers: { location: 'https://boards.greenhouse.io/users/sign_up' } }
        : { status: 200, body: fixture.list };
    } });
    assert.equal(result.evidence.resolution.reason, 'redirect-to-unsupported-host');
    assert.equal(calls, phase === 'list' ? 1 : 2);
  });
  const fixture = crossMatchFixture('greenhouse');
  fixture.detail.absolute_url = 'https://job-boards.greenhouse.io/other/jobs/123';
  assert.equal((await resolveCrossMatch(fixture)).result.status, 'verification');
  fixture.row.location.name = 'Puneri, India';
  assert.equal((await resolveCrossMatch(fixture)).requests.length, 1);
});

test('shared request budgets cover registry search and detail without replay', async () => {
  const fixture = crossMatchFixture('greenhouse');
  const shared = { used: 0, claim() { if (this.used >= 1) return false; this.used += 1; return true; } };
  const { result, requests } = await resolveCrossMatch(fixture, { sharedRequestBudget: shared });
  assert.equal(result.evidence.resolution.reason, 'request-budget-exhausted');
  assert.equal(requests.length, 1);
  assert.equal(shared.used, 1);
  assert.equal(result.telemetry.crossMatch.resolverRequests, 1);
});


test('Workday explicit list requisitions must agree with the browser route', async () => {
  const fixture = crossMatchFixture('workday');
  fixture.row.bulletFields = ['JR999'];
  const { result, requests } = await resolveCrossMatch(fixture);
  assert.equal(result.status, 'verification');
  assert.equal(requests.length, 1);
});

test('registry board searches share the original host and request caps', async (t) => {
  const greenhouse = crossMatchFixture('greenhouse');
  const lever = crossMatchFixture('lever');
  for (const [limits, reason] of [[{ maxHosts: 1 }, 'host-budget-exceeded'], [{ maxRequests: 1 }, 'request-budget-exceeded']]) {
    await t.test(reason, async () => {
      let calls = 0;
      const { result } = await resolveCrossMatch(greenhouse, { ...limits,
        config: { boardRegistry: { boards: [greenhouse.board, lever.board] } },
        transport: async (url) => { calls += 1; assert.equal(url, greenhouse.listUrl); return { status: 200, body: greenhouse.list }; },
      });
      assert.equal(result.evidence.resolution.reason, reason);
      assert.equal(calls, 1);
      assert.equal(result.telemetry.crossMatch.boardRequests, 1);
      assert.equal(result.telemetry.crossMatch.resolverRequests, 1);
    });
  }
});

test('retained portal details still try verified boards before a missing application target', async () => {
  const fixture = crossMatchFixture('greenhouse');
  const { result, requests } = await resolveCrossMatch(fixture, {}, {
    provider: 'linkedin-jobs', evidence: { portalDetail: { status: 'extracted', applicationTargets: [] } },
  });
  assert.equal(result.status, 'resolved');
  assert.equal(requests.length, 2);
});

// Keep portal fields separate when the employer leaves employment, date, or compensation unknown.
test('cross-matches clear portal-only readiness fields omitted by employer details', async () => {
  const fixture = crossMatchFixture('greenhouse');
  delete fixture.detail.first_published;
  fixture.detail.content = '<p>Build Python APIs.</p>';
  const { result } = await resolveCrossMatch(fixture, {}, {
    postedAt: '2026-10-12T08:00:00Z', employment: { type: 'full-time', evidence: 'portal card' },
    salary: { minimum: 800000, currency: 'INR', period: 'annual', evidence: 'portal card' },
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.patch.postedAt, null);
  assert.equal(result.patch.employment.type, null);
  assert.equal(result.patch.salary.minimum, null);
  assert.equal(applicationReadiness(result.patch, { eligible: true }).ready, false);
});

test('Workday nonpermanent evidence survives full-time hours through eligibility and readiness', async (t) => {
  for (const wording of ['fixed-term role for three months', 'Employment type: Fixed Term', 'three-month fixed-term contract', 'temporary position', 'contractual employment', 'freelance engagement', 'Employment type: Contractual', 'Employment type: Freelance', 'Job type: Contract', 'Type: Temporary']) await t.test(wording, async () => {
    const fixture = crossMatchFixture('workday');
    fixture.detail.jobPostingInfo.jobDescription = `<p>This is a ${wording}. Full-time hours. Duration: three months. Build Python APIs. 0-1 years of experience.</p>`;
    const { result } = await resolveCrossMatch(fixture);
    assert.equal(result.status, 'resolved');
    assert.equal(result.patch.employment.type, /temporary/i.test(wording) ? 'temporary' : 'contract');
    const candidate = applyOriginalListingResolution(normalizeCandidate({ company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India',
      url: 'https://www.glassdoor.com/job-listing/ai-engineer', provider: 'glassdoor' }, { runAt: '2026-10-13T08:00:00Z' }), result);
    const eligibility = classifyCandidate(candidate, loadConfig());
    const readiness = applicationReadiness(candidate, eligibility);
    assert.notEqual(eligibility.employment.code, 'EMPLOYMENT_FULL_TIME');
    assert.equal(readiness.ready, false);
    assert.ok(readiness.reasons.includes('EMPLOYMENT_NOT_VERIFIED'));
  });
});

test('Workday nonpermanent title labels cannot be overridden by full-time hours', async (t) => {
  for (const label of ['Freelance', 'Contractual', 'Fixed Term', 'Contract', 'Temporary']) await t.test(label, async () => {
    const fixture = crossMatchFixture('workday');
    const title = `AI Engineer (${label})`;
    fixture.row.title = fixture.detail.jobPostingInfo.title = title;
    fixture.detail.jobPostingInfo.jobDescription = '<p>Full-time hours. Duration: three months. Build Python APIs. 0-1 years of experience.</p>';
    const { result } = await resolveCrossMatch(fixture, {}, { title });
    assert.equal(result.patch.employment.type, label === 'Temporary' ? 'temporary' : 'contract');
    const candidate = applyOriginalListingResolution(normalizeCandidate({ company: 'Acme Labs', title, location: 'Pune, India',
      url: 'https://www.glassdoor.com/job-listing/ai-engineer', provider: 'glassdoor' }), result);
    const eligibility = classifyCandidate(candidate, loadConfig());
    assert.notEqual(eligibility.employment.code, 'EMPLOYMENT_FULL_TIME');
    assert.equal(applicationReadiness(candidate, eligibility).ready, false);
  });
});

test('fixed-term Workday internships and trainees retain the qualifying stipend and PPO lane', async (t) => {
  for (const title of ['AI Engineering Intern', 'AI Engineering Trainee']) await t.test(title, async () => {
    const fixture = crossMatchFixture('workday');
    fixture.row.title = fixture.detail.jobPostingInfo.title = title;
    fixture.detail.jobPostingInfo.jobDescription = '<p>Paid fixed-term role. Full-time hours for three months. Stipend: INR 40,000 per month. PPO based on performance. Build Python APIs.</p>';
    const { result } = await resolveCrossMatch(fixture, {}, { title });
    assert.equal(result.status, 'resolved');
    assert.equal(result.patch.employment.type, 'internship');
    const candidate = applyOriginalListingResolution(normalizeCandidate({ company: 'Acme Labs', title, location: 'Pune, India',
      url: 'https://www.glassdoor.com/job-listing/ai-engineering-intern', provider: 'glassdoor' }, { runAt: '2026-10-13T08:00:00Z' }), result);
    const eligibility = classifyCandidate(candidate, loadConfig());
    assert.equal(eligibility.employment.code, 'EMPLOYMENT_PAID_INTERNSHIP');
    assert.equal(eligibility.eligible, true);
    assert.equal(applicationReadiness(candidate, eligibility).ready, true);
  });
});

test('portal stipend evidence cannot fill a missing employer internship stipend', async () => {
  const fixture = crossMatchFixture('workday');
  fixture.row.title = fixture.detail.jobPostingInfo.title = 'AI Engineering Intern';
  fixture.detail.jobPostingInfo.jobDescription = '<p>Paid fixed-term internship. PPO based on performance. Build Python APIs.</p>';
  const { result } = await resolveCrossMatch(fixture, {}, { title: 'AI Engineering Intern',
    stipend: { amount: 50000, currency: 'INR', period: 'month', verified: true, evidence: 'portal card' } });
  assert.equal(result.patch.stipend.amount, null);
  const candidate = applyOriginalListingResolution(normalizeCandidate({ title: 'AI Engineering Intern', company: 'Acme Labs', location: 'Pune, India',
    url: 'https://www.glassdoor.com/job-listing/ai-engineering-intern', provider: 'glassdoor',
    stipend: { amount: 50000, currency: 'INR', period: 'month' } }), result);
  const eligibility = classifyCandidate(candidate, loadConfig());
  assert.equal(eligibility.employment.code, 'INTERNSHIP_PAY_NOT_EXPLICIT');
  assert.equal(applicationReadiness(candidate, eligibility).ready, false);
});

test('unposted Workday details remain closed even when the JD survives', async () => {
  const fixture = crossMatchFixture('workday');
  fixture.detail.jobPostingInfo.posted = false;
  const { result } = await resolveCrossMatch(fixture);
  assert.equal(result.status, 'verification');
  assert.equal(result.originalApplicationUrl, null);
  assert.equal(result.evidence.resolution.reason, 'destination-liveness-unverified');
});

test('public Workday title slugs can name internal tools, private cloud and authentication platforms', async (t) => {
  for (const slug of ['AI-Engineer-Internal-Tools', 'AI-Engineer-Private-Cloud', 'Software-Engineer-SSO-Platform', 'Software-Engineer-OAuth']) await t.test(slug, async () => {
    const fixture = crossMatchFixture('workday');
    fixture.list.jobPostings[0].externalPath = `/job/Pune/${slug}_JR123`;
    fixture.detailUrl = `https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/job/Pune/${slug}_JR123`;
    const { result } = await resolveCrossMatch(fixture);
    assert.equal(result.status, 'resolved');
    assert.equal(result.originalApplicationUrl, `https://acme.wd3.myworkdayjobs.com/External/job/Pune/${slug}_JR123`);
  });
});

test('visible portal fallback rejects conflicting employer details and signup routes', async (t) => {
  for (const provider of ['instahyre', 'wellfound']) await t.test(provider, async () => {
    const portalUrl = provider === 'instahyre' ? 'https://www.instahyre.com/job-123-ai-engineer-at-acme' : 'https://wellfound.com/jobs/123-acme-ai-engineer';
    for (const destination of ['https://other.com/application/1', 'https://acme.com/signup/application/1']) {
      const calls = [];
      const resolve = createOriginalListingResolver({ transport: async (url) => {
        calls.push(url);
        if (url === portalUrl) return { status: 200, body: `<a href="${destination}">Apply on company website</a>` };
        return jsonLdPage({ title: 'AI Engineer', hiringOrganization: { name: 'Other' }, description: 'Build Python APIs.' });
      } });
      const result = await resolve(observation(portalUrl, { provider, company: 'Acme', location: 'Pune' }));
      assert.equal(result.status, 'verification');
      assert.equal(result.originalApplicationUrl, null);
      assert.equal(calls.length, destination.includes('signup') ? 1 : 2);
    }
  });
});

test('Lever headings and equal-opportunity footer cannot establish a missing JD', async () => {
  const fixture = crossMatchFixture('lever');
  delete fixture.detail.descriptionPlain;
  fixture.detail.lists = [{ text: 'Requirements', content: '<p></p>' }];
  fixture.detail.additionalPlain = 'We are an equal opportunity employer.';
  const { result } = await resolveCrossMatch(fixture);
  assert.equal(result.status, 'verification');
  assert.equal(result.originalApplicationUrl, null);
  assert.equal(result.evidence.resolution.reason, 'job-detail-not-found');
});

test('Ashby disclosed compensation intervals reach the existing salary floor', async (t) => {
  for (const [interval, minimum, maximum, annualMinimum, expectedCode] of [
    ['1 YEAR', 300000, 400000, 300000, 'SALARY_BELOW_FLOOR'],
    ['1 MONTH', 25000, 30000, 300000, 'SALARY_BELOW_FLOOR'],
    ['1 YEAR', 600000, 700000, 600000, 'SALARY_FLOOR_MET'],
  ]) await t.test(interval + minimum, async () => {
    const fixture = crossMatchFixture('ashby');
    fixture.row.compensation = { interval, minValue: minimum, maxValue: maximum, currency: 'INR' };
    const { result } = await resolveCrossMatch(fixture);
    assert.equal(result.patch.salary.minimum, annualMinimum);
    assert.equal(result.patch.salary.period, 'annual');
    const candidate = applyOriginalListingResolution(normalizeCandidate({ title: 'AI Engineer', company: 'Acme Labs', location: 'Pune, India',
      url: 'https://www.glassdoor.com/job-listing/ai-engineer', provider: 'glassdoor' }), result);
    const eligibility = classifyCandidate(candidate, { ...loadConfig(), salaryFloorLpa: 5.5 });
    assert.equal(eligibility.salary.code, expectedCode);
    if (minimum < 600000) assert.equal(applicationReadiness(candidate, eligibility).ready, false);
  });
});

test('visible portal fallback cannot use portal-only or conflicting geography', async (t) => {
  for (const provider of ['instahyre', 'wellfound']) for (const location of [null, 'Bengaluru, India', 'Pune, India']) await t.test(`${provider} ${location}`, async () => {
    const portalUrl = provider === 'instahyre' ? 'https://www.instahyre.com/job-123-ai-engineer-at-acme' : 'https://wellfound.com/jobs/123-acme-ai-engineer';
    const destination = 'https://acme.com/careers/jobs/123';
    const resolve = createOriginalListingResolver({ transport: async (url) => url === portalUrl
      ? { status: 200, body: `<a href="${destination}">Apply on company website</a>` }
      : jsonLdPage({ title: 'AI Engineer', hiringOrganization: { name: 'Acme' }, description: 'Full-time engineering. Build Python APIs.', employmentType: 'FULL_TIME',
        ...(location ? { jobLocation: { address: { addressLocality: location } } } : {}) }) });
    const result = await resolve(observation(portalUrl, { provider, company: 'Acme', location: 'Pune' }));
    assert.equal(result.status, location === 'Pune, India' ? 'resolved' : 'verification');
    if (location !== 'Pune, India') {
      assert.equal(result.originalApplicationUrl, null);
      assert.equal(result.evidence.resolution.reason, 'destination-role-identity-mismatch');
    }
  });
});
