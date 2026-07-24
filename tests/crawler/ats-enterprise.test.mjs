import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverEnterpriseAts } from '../../crawler/ats-enterprise.mjs';

const runAt = '2026-07-23T10:00:00Z';

test('parses Workday postings, follows one bounded page, and preserves direct/lead provenance', async () => {
  // Real Workday CXS pagination: same endpoint URL every request, offset
  // advanced in the POST body, continuation driven by `total` vs items
  // fetched so far -- there is no next-link field in the live response.
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, options });
    const { offset } = JSON.parse(options.body);
    if (offset === 0) return { status: 200, headers: { etag: 'w1' }, body: JSON.stringify({
      total: 3,
      jobPostings: [
        { title: 'AI Engineer', externalPath: '/job/ai-engineer', locations: ['Pune'], postedOn: '2026-07-22', jobReqId: 'WD-1' },
        { title: 'Partner Engineer', externalPath: 'https://partner.example/jobs/2', locations: ['Remote'], postedOn: '2026-07-21', jobReqId: 'WD-2' },
      ],
    }) };
    return { status: 200, headers: {}, body: JSON.stringify({ total: 3, jobPostings: [{ title: 'Backend Engineer', externalPath: '/job/backend', postedOn: '2026-07-20', jobReqId: 'WD-3' }] }) };
  };

  const result = await discoverEnterpriseAts({
    boards: [{ provider: 'workday', company: 'Acme', url: 'https://acme.wd1.myworkdayjobs.com/jobs' }],
    transport, runAt, maxPages: 2,
  });

  assert.deepEqual(result.observations.map((row) => row.title), ['AI Engineer', 'Partner Engineer', 'Backend Engineer']);
  assert.equal(result.observations[0].classification, 'direct');
  assert.equal(result.observations[1].classification, 'lead');
  assert.equal(result.observations[0].provider, 'workday');
  assert.equal(result.observations[0].originalApplicationUrl, 'https://acme.wd1.myworkdayjobs.com/job/ai-engineer');
  assert.equal(JSON.parse(calls[0].options.body).offset, 0);
  assert.equal(JSON.parse(calls[1].options.body).offset, 2);
  assert.equal(result.manifest.sources[0].pagesFetched, 2);
  assert.equal(result.conditionalState['https://acme.wd1.myworkdayjobs.com/jobs'].etag, 'w1');
  assert.equal(result.observations[1].provenance.provider, 'workday');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].options.headers);
});

test('covers SuccessFactors, Phenom, iCIMS, Jobvite, and Oracle-like JSON feeds with JSON-LD fallback', async () => {
  const fixtures = new Map([
    ['https://sf.example/jobs', { d: { results: [{ jobTitle: 'SF ML Engineer', jobReqId: 'SF-1', externalCode: 'sf-1', careerSiteUrl: 'https://sf.example/job/sf-1', postingDate: '2026-07-22' }] } }],
    ['https://phenom.example/jobs', { jobs: [{ title: 'Phenom Agent Engineer', id: 'P-1', url: '/job/p-1', datePosted: '2026-07-22' }] }],
    ['https://icims.example/jobs', { results: [{ jobtitle: 'iCIMS Backend Engineer', requisitionid: 'I-1', applyurl: 'https://icims.example/job/i-1', posteddate: '2026-07-21' }] }],
    ['https://jobvite.example/jobs', { jobs: [{ title: 'Jobvite Software Engineer', id: 'J-1', jobUrl: 'https://jobvite.example/job/j-1', datePosted: '2026-07-21' }] }],
    ['https://oracle.example/jobs', { html: '<script type="application/ld+json">{"@type":"JobPosting","title":"Oracle Data Engineer","url":"https://oracle.example/job/o-1","datePosted":"2026-07-20","hiringOrganization":{"name":"Oracle Co"}}</script>' }],
  ]);
  const result = await discoverEnterpriseAts({
    boards: [
      { provider: 'successfactors', company: 'SF Co', url: 'https://sf.example/jobs' },
      { provider: 'phenom', company: 'Phenom Co', url: 'https://phenom.example/jobs' },
      { provider: 'icims', company: 'iCIMS Co', url: 'https://icims.example/jobs' },
      { provider: 'jobvite', company: 'Jobvite Co', url: 'https://jobvite.example/jobs' },
      { provider: 'oracle', company: 'Oracle Co', url: 'https://oracle.example/jobs' },
    ],
    transport: async (url) => ({ status: 200, headers: {}, body: JSON.stringify(fixtures.get(url) ?? {}) }), runAt,
  });
  assert.deepEqual(result.observations.map((row) => row.title), ['SF ML Engineer', 'Phenom Agent Engineer', 'iCIMS Backend Engineer', 'Jobvite Software Engineer', 'Oracle Data Engineer']);
  assert.ok(result.manifest.sources.every((source) => source.status === 'ok'));
  assert.equal(result.observations.every((row) => row.classification === 'direct'), true);
});

test('sends Workday requests as a POST with a JSON search body, since Workday CXS rejects GET', async () => {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, options });
    return { status: 200, headers: {}, body: JSON.stringify({ total: 1, jobPostings: [{ title: 'Workday POST Engineer', externalPath: '/job/1', postedOn: '2026-07-22', jobReqId: 'WD-9' }] }) };
  };

  const result = await discoverEnterpriseAts({
    boards: [{ provider: 'workday', company: 'Acme', url: 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/jobs' }],
    transport, runAt, maxPages: 1, maxJobsPerBoard: 20,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  const sentBody = JSON.parse(calls[0].options.body);
  assert.deepEqual(sentBody.appliedFacets, {});
  assert.equal(sentBody.offset, 0);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].title, 'Workday POST Engineer');
});

test('non-Workday enterprise providers are still fetched as a plain GET', async () => {
  const calls = [];
  const transport = async (url, options) => {
    calls.push(options);
    return { status: 200, headers: {}, body: JSON.stringify({ jobs: [{ title: 'Phenom Engineer', id: 'P-1', url: '/job/p-1', datePosted: '2026-07-22' }] }) };
  };
  await discoverEnterpriseAts({
    boards: [{ provider: 'phenom', company: 'Phenom Co', url: 'https://phenom.example/jobs' }],
    transport, runAt,
  });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, undefined);
});

test('unsupported and malformed boards degrade visibly without fabricated observations', async () => {
  let called = false;
  const result = await discoverEnterpriseAts({
    boards: [
      { provider: 'private-board', company: 'Private', url: 'https://private.example/jobs' },
      { provider: 'workday', company: 'Broken', url: 'https://broken.example/jobs' },
    ],
    transport: async () => { called = true; return { status: 200, headers: {}, body: '{not-json' }; }, runAt,
  });
  assert.equal(result.observations.length, 0);
  assert.equal(called, true);
  assert.deepEqual(result.failures.map((failure) => failure.code), ['UNSUPPORTED_PROVIDER', 'MALFORMED_PAYLOAD']);
  assert.equal(result.manifest.sources[0].status, 'degraded');
  assert.equal(result.manifest.sources[1].status, 'degraded');
  assert.ok(result.verificationQueue.every((item) => item.reason));
});

test('pagination is capped and a listing without a trustworthy URL is skipped', async () => {
  const calls = [];
  const result = await discoverEnterpriseAts({
    boards: [{ provider: 'oracle', company: 'Oracle', url: 'https://oracle.example/jobs' }], maxPages: 2, runAt,
    transport: async (url) => {
      calls.push(url);
      const page = calls.length;
      return { status: 200, headers: {}, body: JSON.stringify({
        items: [{ title: `Role ${page}`, id: String(page), url: page === 1 ? '/job/1' : null, datePosted: '2026-07-22' }],
        next: `https://oracle.example/jobs?page=${page + 1}`,
      }) };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.observations.length, 1);
  assert.equal(result.manifest.sources[0].pagesCapped, true);
  assert.ok(result.failures.some((failure) => failure.code === 'LISTING_URL_MISSING'));
  assert.ok(result.provenance.transportInjected);
});

test('Workday: large tenant paginates past the first 20 postings via offset, bounded by maxPages', async () => {
  const totalPostings = 55;
  const calls = [];
  const transport = async (url, options) => {
    calls.push(JSON.parse(options.body));
    const { offset, limit } = JSON.parse(options.body);
    const remaining = Math.max(0, totalPostings - offset);
    const pageSize = Math.min(limit, remaining);
    const jobPostings = Array.from({ length: pageSize }, (_, index) => ({
      title: `Engineer ${offset + index + 1}`,
      externalPath: `/job/${offset + index + 1}`,
      locations: ['Pune, India'],
      postedOn: '2026-07-22',
      jobReqId: `WD-${offset + index + 1}`,
    }));
    return { status: 200, headers: {}, body: JSON.stringify({ total: totalPostings, jobPostings }) };
  };

  const result = await discoverEnterpriseAts({
    boards: [{ provider: 'workday', company: 'BigCo', url: 'https://bigco.wd1.myworkdayjobs.com/wday/cxs/bigco/Careers/jobs' }],
    transport, runAt, maxPages: 5, maxJobsPerBoard: 200,
  });

  // Old behavior stalled at offset 0/limit 20 forever; the fix must advance
  // offset every request and keep going until `total` is exhausted or
  // maxPages is hit -- here maxPages(5) * limit(20) = 100 > total(55), so it
  // stops early on exhaustion, not on the page cap.
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((body) => body.offset), [0, 20, 40]);
  assert.equal(result.observations.length, totalPostings);
  assert.equal(result.manifest.sources[0].pagesCapped, false);
});
