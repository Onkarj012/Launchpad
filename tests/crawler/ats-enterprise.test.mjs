import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverEnterpriseAts,
  preselectWorkdayListRow,
  workdayDetailUrl,
} from '../../crawler/ats-enterprise.mjs';
import { resolveJobIdentity } from '../../crawler/identity.mjs';
import { classifyFreshness } from '../../job-pull/freshness.mjs';

const runAt = '2026-07-23T10:00:00Z';

const WORKDAY_DETAIL_OPTS = {
  enrichDetails: true,
  detailConcurrency: 2,
  maxDetailRequestsPerRun: 20,
};

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

test('Workday preselection keeps ambiguous list rows and only skips clearly irrelevant DETAIL fetches', () => {
  assert.equal(preselectWorkdayListRow({ title: 'Specialist', locationsText: '' }).selected, true);
  assert.equal(preselectWorkdayListRow({ title: 'Specialist', locationsText: '' }).reason, 'ambiguous');
  assert.equal(preselectWorkdayListRow({ title: 'Operations Specialist', locationsText: 'Pune India Office' }).selected, true);
  assert.equal(preselectWorkdayListRow({ title: 'Associate Software Engineer', locationsText: 'London' }).selected, true);
  assert.equal(preselectWorkdayListRow({ title: 'Staff Accountant', locationsText: 'London Office' }).selected, false);
  assert.equal(preselectWorkdayListRow({ title: 'Staff Accountant', locationsText: 'London Office' }).reason, 'not-plausible');
});

test('Workday DETAIL hydration populates JD, location, requisition ID, experience, liveness, and application URL', async () => {
  const listUrl = 'https://reliaquest.wd5.myworkdayjobs.com/wday/cxs/reliaquest/ReliaQuest_Careers/jobs';
  const detailUrl = 'https://reliaquest.wd5.myworkdayjobs.com/wday/cxs/reliaquest/ReliaQuest_Careers/job/Pune-India-Office/Associate-Software-Engineer_R15032';
  const transport = async (url, options) => {
    if (options?.detail || (options?.method === 'GET' && url.includes('/job/'))) {
      assert.equal(url, detailUrl);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          jobPostingInfo: {
            title: 'Associate Software Engineer',
            jobDescription: '<p>0-1 Years of Software Development experience in Java and Spring Boot.</p>',
            location: 'Pune India Office',
            jobReqId: 'R15032',
            canApply: true,
            posted: true,
            startDate: '2026-07-15',
            postedOn: 'Posted 9 Days Ago',
            externalUrl: 'https://reliaquest.wd5.myworkdayjobs.com/ReliaQuest_Careers/job/Pune-India-Office/Associate-Software-Engineer_R15032',
            jobRequisitionLocation: { descriptor: 'Pune India Office', country: { descriptor: 'India', alpha2Code: 'IN' } },
          },
          hiringOrganization: { name: 'ReliaQuest India Private Limited' },
        }),
      };
    }
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        total: 1,
        jobPostings: [{
          title: 'Associate Software Engineer',
          externalPath: '/job/Pune-India-Office/Associate-Software-Engineer_R15032',
          locationsText: 'Pune India Office',
          postedOn: 'Posted 9 Days Ago',
          bulletFields: ['R15032'],
        }],
      }),
    };
  };

  const result = await discoverEnterpriseAts({
    boards: [{ provider: 'workday', company: 'ReliaQuest', url: listUrl }],
    transport, runAt, maxPages: 1, ...WORKDAY_DETAIL_OPTS,
  });

  assert.equal(result.observations.length, 1);
  const candidate = result.observations[0];
  assert.match(candidate.description, /0-1 Years of Software Development/i);
  assert.match(candidate.location, /Pune/i);
  assert.equal(candidate.jobId, 'R15032');
  assert.equal(candidate.providerJobId, 'R15032');
  assert.equal(candidate.liveness.status, 'Active');
  assert.equal(
    candidate.originalApplicationUrl,
    'https://reliaquest.wd5.myworkdayjobs.com/ReliaQuest_Careers/job/Pune-India-Office/Associate-Software-Engineer_R15032',
  );
  assert.ok(candidate.experience?.evidence || candidate.experience?.minYears != null);
  assert.equal(candidate.evidence.detailHydration.status, 'succeeded');
  assert.equal(result.telemetry.workdayDetail.succeeded, 1);
  assert.equal(workdayDetailUrl(listUrl, '/job/Pune-India-Office/Associate-Software-Engineer_R15032'), detailUrl);
});

test('Workday requisition ID is preferred as primary identity over company-title-location fallback', async () => {
  const listUrl = 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs';
  const transport = async (url, options) => {
    if (options?.detail || options?.method === 'GET') {
      const req = url.includes('REQ_A') ? 'REQ_A' : 'REQ_B';
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          jobPostingInfo: {
            title: 'Associate Software Engineer',
            jobDescription: '<p>Entry level software role.</p>',
            location: 'Pune, India',
            jobReqId: req,
            canApply: true,
            posted: true,
            externalUrl: `https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/${req}`,
          },
        }),
      };
    }
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        total: 2,
        jobPostings: [
          { title: 'Associate Software Engineer', externalPath: '/job/Pune/Associate-Software-Engineer_REQ_A', locationsText: 'Pune, India', bulletFields: ['REQ_A'] },
          { title: 'Associate Software Engineer', externalPath: '/job/Pune/Associate-Software-Engineer_REQ_B', locationsText: 'Pune, India', bulletFields: ['REQ_B'] },
        ],
      }),
    };
  };

  const result = await discoverEnterpriseAts({
    boards: [{ provider: 'workday', company: 'Acme', url: listUrl }],
    transport, runAt, maxPages: 1, ...WORKDAY_DETAIL_OPTS,
  });
  assert.equal(result.observations.length, 2);
  const [a, b] = result.observations;
  assert.equal(a.jobId, 'REQ_A');
  assert.equal(b.jobId, 'REQ_B');

  const identityA = resolveJobIdentity(a);
  const identityB = resolveJobIdentity(b);
  assert.equal(identityA.identity.providerJobId, 'workday|req_a');
  assert.equal(identityB.identity.providerJobId, 'workday|req_b');
  assert.notEqual(identityA.identity.jobKey, identityB.identity.jobKey);

  // Same company/title/location would collapse without requisition preference.
  assert.equal(identityA.identity.companyTitleLocation, identityB.identity.companyTitleLocation);
  const match = resolveJobIdentity(a, { existingJobs: [{ ...b, jobKey: 'prior-b' }] });
  assert.notEqual(match.code, 'UNCHANGED_DUPLICATE');
  assert.equal(match.code, 'NEW_TO_ME');
});

test('Workday DETAIL failure keeps list evidence, sets verification reason, and fabricates nothing', async () => {
  const listUrl = 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs';
  const transport = async (url, options) => {
    if (options?.detail || options?.method === 'GET') {
      return { status: 404, headers: {}, body: 'not found' };
    }
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        total: 1,
        jobPostings: [{
          title: 'Backend Engineer',
          externalPath: '/job/Pune/Backend-Engineer_WD-9',
          locationsText: 'Pune, India',
          bulletFields: ['WD-9'],
        }],
      }),
    };
  };

  const result = await discoverEnterpriseAts({
    boards: [{ provider: 'workday', company: 'Acme', url: listUrl }],
    transport, runAt, maxPages: 1, ...WORKDAY_DETAIL_OPTS,
  });

  assert.equal(result.observations.length, 1);
  const candidate = result.observations[0];
  assert.equal(candidate.title, 'Backend Engineer');
  assert.equal(candidate.jobId, 'WD-9');
  assert.equal(candidate.description, null);
  assert.equal(candidate.evidence.detailHydration.status, 'failed');
  assert.equal(candidate.evidence.verificationReason, 'WORKDAY_DETAIL_NOT_FOUND');
  assert.ok(result.verificationQueue.some((item) => item.reason === 'workday-detail-failed'));
  assert.equal(result.telemetry.workdayDetail.failed, 1);
  assert.equal(result.telemetry.workdayDetail.succeeded, 0);
});

test('Workday DETAIL concurrency and per-run budget are respected and reported in telemetry', async () => {
  let inFlight = 0;
  let peak = 0;
  const transport = async (url, options) => {
    if (options?.detail || options?.method === 'GET') {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      const req = url.match(/REQ(\d+)/)?.[1] || '0';
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          jobPostingInfo: {
            title: `Software Engineer ${req}`,
            jobDescription: '<p>Build systems.</p>',
            location: 'Pune, India',
            jobReqId: `REQ${req}`,
            canApply: true,
            posted: true,
            externalUrl: `https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/REQ${req}`,
          },
        }),
      };
    }
    const jobPostings = Array.from({ length: 5 }, (_, index) => ({
      title: `Software Engineer ${index + 1}`,
      externalPath: `/job/Pune/Software-Engineer_REQ${index + 1}`,
      locationsText: 'Pune, India',
      bulletFields: [`REQ${index + 1}`],
    }));
    return { status: 200, headers: {}, body: JSON.stringify({ total: 5, jobPostings }) };
  };

  const result = await discoverEnterpriseAts({
    boards: [{ provider: 'workday', company: 'Acme', url: 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs' }],
    transport, runAt, maxPages: 1,
    enrichDetails: true,
    detailConcurrency: 2,
    maxDetailRequestsPerRun: 3,
  });

  assert.equal(result.observations.length, 5);
  assert.equal(result.telemetry.workdayDetail.attempted, 3);
  assert.equal(result.telemetry.workdayDetail.succeeded, 3);
  assert.equal(result.telemetry.workdayDetail.budgetExhausted, 2);
  assert.ok(peak <= 2, `peak concurrency ${peak} should respect limit 2`);
  const hydrated = result.observations.filter((row) => row.evidence?.detailHydration?.status === 'succeeded');
  const skippedBudget = result.observations.filter((row) => row.evidence?.detailHydration?.reason === 'budget-exhausted');
  assert.equal(hydrated.length, 3);
  assert.equal(skippedBudget.length, 2);
});

test('hydrated Workday candidate with only provider dates cannot reach Hot/Active freshness', async () => {
  const listUrl = 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs';
  const transport = async (url, options) => {
    if (options?.detail || options?.method === 'GET') {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          jobPostingInfo: {
            title: 'Software Engineer',
            jobDescription: '<p>Build services in Pune.</p>',
            location: 'Pune, India',
            jobReqId: 'REQ-HOT',
            canApply: true,
            posted: true,
            startDate: '2026-07-22',
            postedOn: '2026-07-22',
            externalUrl: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/REQ-HOT',
          },
        }),
      };
    }
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        total: 1,
        jobPostings: [{
          title: 'Software Engineer',
          externalPath: '/job/Pune/Software-Engineer_REQ-HOT',
          locationsText: 'Pune, India',
          postedOn: '2026-07-22',
          bulletFields: ['REQ-HOT'],
        }],
      }),
    };
  };

  const result = await discoverEnterpriseAts({
    boards: [{ provider: 'workday', company: 'Acme', url: listUrl }],
    transport, runAt, maxPages: 1, ...WORKDAY_DETAIL_OPTS,
  });
  const candidate = result.observations[0];
  assert.equal(candidate.evidence.freshness?.kind, 'workday-unverified');
  const freshness = classifyFreshness(candidate, { now: runAt });
  assert.equal(freshness.window, 'VerifyQueue');
  assert.equal(freshness.eligible, false);
  assert.notEqual(freshness.window, 'Hot');
  assert.notEqual(freshness.window, 'Active');
});

test('e2e: Pune Associate Software Engineer LIST preselects, hydrates DETAIL, and remains policy-evaluable', async () => {
  const listUrl = 'https://reliaquest.wd5.myworkdayjobs.com/wday/cxs/reliaquest/ReliaQuest_Careers/jobs';
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, method: options?.method, detail: options?.detail === true });
    if (options?.detail || options?.method === 'GET') {
      if (url.includes('GreyMatter-Specialist')) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            jobPostingInfo: {
              title: 'GreyMatter Specialist',
              jobDescription: '<p>Customer-facing GreyMatter platform specialist role in Dublin.</p>',
              location: 'Dublin',
              jobReqId: 'R14895',
              canApply: true,
              posted: true,
              externalUrl: 'https://reliaquest.wd5.myworkdayjobs.com/ReliaQuest_Careers/job/Dublin/GreyMatter-Specialist_R14895',
            },
          }),
        };
      }
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          jobPostingInfo: {
            title: 'Associate Software Engineer',
            jobDescription: '<p><b>Do you have what it takes?</b></p><ul><li><p>0-1 Years of Software Development experience in the following: Java, Spring Boot.</p></li></ul>',
            location: 'Pune India Office',
            jobReqId: 'R15032',
            canApply: true,
            posted: true,
            startDate: '2026-07-15',
            postedOn: 'Posted 9 Days Ago',
            externalUrl: 'https://reliaquest.wd5.myworkdayjobs.com/ReliaQuest_Careers/job/Pune-India-Office/Associate-Software-Engineer_R15032',
            country: { descriptor: 'India' },
            jobRequisitionLocation: { descriptor: 'Pune India Office', country: { descriptor: 'India', alpha2Code: 'IN' } },
          },
          hiringOrganization: { name: 'ReliaQuest India Private Limited' },
        }),
      };
    }
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        total: 3,
        jobPostings: [
          {
            title: 'Associate Software Engineer',
            externalPath: '/job/Pune-India-Office/Associate-Software-Engineer_R15032',
            locationsText: 'Pune India Office',
            postedOn: 'Posted 9 Days Ago',
            bulletFields: ['R15032'],
          },
          {
            title: 'Staff Accountant',
            externalPath: '/job/London-Office/Staff-Accountant_R15064',
            locationsText: 'London Office',
            postedOn: 'Posted 17 Days Ago',
            bulletFields: ['R15064'],
          },
          {
            // Ambiguous list row (no location text) must still receive DETAIL, not silent drop.
            title: 'GreyMatter Specialist',
            externalPath: '/job/Dublin/GreyMatter-Specialist_R14895',
            locationsText: '',
            postedOn: 'Posted 17 Days Ago',
            bulletFields: ['R14895'],
          },
        ],
      }),
    };
  };

  const result = await discoverEnterpriseAts({
    boards: [{ provider: 'workday', company: 'ReliaQuest', url: listUrl }],
    transport, runAt, maxPages: 1, ...WORKDAY_DETAIL_OPTS,
  });

  // All three LIST rows become observations; only preselected ones spend DETAIL budget.
  assert.equal(result.observations.length, 3);
  const ase = result.observations.find((row) => row.title === 'Associate Software Engineer');
  assert.ok(ase);
  assert.equal(ase.evidence.detailHydration.status, 'succeeded');
  assert.match(ase.description, /0-1 Years of Software Development/i);
  assert.match(ase.location, /Pune/i);
  assert.equal(ase.jobId, 'R15032');
  assert.equal(ase.liveness.status, 'Active');
  assert.equal(
    ase.originalApplicationUrl,
    'https://reliaquest.wd5.myworkdayjobs.com/ReliaQuest_Careers/job/Pune-India-Office/Associate-Software-Engineer_R15032',
  );

  const accountant = result.observations.find((row) => row.title === 'Staff Accountant');
  assert.equal(accountant.evidence.detailHydration.status, 'skipped');
  assert.equal(accountant.evidence.detailHydration.reason, 'not-plausible');
  assert.equal(accountant.description, null);

  // DETAIL requested only for preselected rows (ASE + ambiguous specialist), not accountant.
  const detailCalls = calls.filter((call) => call.method === 'GET' || call.detail);
  assert.equal(detailCalls.length, 2);
  assert.ok(detailCalls.some((call) => call.url.includes('Associate-Software-Engineer_R15032')));
  assert.ok(!detailCalls.some((call) => call.url.includes('Staff-Accountant')));

  assert.equal(result.telemetry.workdayDetail.preselected, 2);
  assert.equal(result.telemetry.workdayDetail.skipped, 1);
  assert.equal(result.telemetry.workdayDetail.succeeded, 2);

  // After hydration the candidate is evidence-rich enough for downstream policy,
  // and uncorroborated Workday dates still land in VerifyQueue (not Hot/Active).
  const freshness = classifyFreshness(ase, { now: runAt });
  assert.equal(freshness.window, 'VerifyQueue');
  const identity = resolveJobIdentity(ase);
  assert.equal(identity.identity.providerJobId, 'workday|r15032');
  assert.equal(identity.code, 'NEW_TO_ME');
});
