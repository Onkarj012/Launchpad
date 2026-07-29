import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichWorkdayCandidates } from '../../job-pull/workday-enrichment.mjs';

test('Workday enrichment fetches only selected Pune rows', async () => {
  const candidates = [
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://acme.wd1.myworkdayjobs.com/Careers/job/United-States/Engineer_US', url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/United-States/Engineer_US', location: 'United States', postedAt: null, evidence: {} },
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', location: 'Pune, India', postedAt: null, evidence: {} },
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Mumbai/Engineer_Mumbai', url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Mumbai/Engineer_Mumbai', location: 'Mumbai, India', postedAt: null, evidence: {} },
  ];
  const calls = [];
  await enrichWorkdayCandidates(candidates, {
    maxRequests: 2,
    ctx: { fetchJson: async (url) => { calls.push(url); return { startDate: null, jobDescription: null }; } },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/Pune\//);
  assert.equal(candidates[0].evidence.detailHydration.reason, 'location-excluded');
  assert.equal(candidates[2].evidence.detailHydration.reason, 'location-excluded');
  assert.equal(candidates[1].evidence.detailHydration.status, 'succeeded');
});

test('an already-described Pune Workday candidate is not hydrated again', async () => {
  const candidate = {
    provider: 'workday',
    title: 'Software Engineer',
    canonicalUrl: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune',
    url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune',
    location: 'Pune, India',
    description: 'Existing hydrated description.',
    evidence: { freshness: { kind: 'workday-startDate' }, detailHydration: { status: 'succeeded' } },
  };
  const originalDescription = candidate.description;
  const originalEvidence = structuredClone(candidate.evidence);
  const calls = [];

  await enrichWorkdayCandidates([candidate], {
    ctx: { fetchJson: async (url) => { calls.push(url); return {}; } },
  });

  assert.equal(calls.length, 0);
  assert.equal(candidate.description, originalDescription);
  assert.deepEqual(candidate.evidence, originalEvidence);
});

test('priority ordering keeps Pune first while sharing a small budget fairly across boards', async () => {
  const candidates = [
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://alpha.wd1.myworkdayjobs.com/Careers/job/Remote/Engineer_R', url: 'https://alpha.wd1.myworkdayjobs.com/Careers/job/Remote/Engineer_R', location: 'Remote India', evidence: {} },
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://alpha.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_A1', url: 'https://alpha.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_A1', location: 'Pune, India', evidence: {} },
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://beta.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_B1', url: 'https://beta.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_B1', location: 'Pune, India', evidence: {} },
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://alpha.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_A2', url: 'https://alpha.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_A2', location: 'Pune, India', evidence: {} },
  ];
  const calls = [];

  await enrichWorkdayCandidates(candidates, {
    maxRequests: 2,
    ctx: { fetchJson: async (url) => { calls.push(url); return { startDate: null, jobDescription: null }; } },
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0], /alpha\.wd1.*\/Pune\//);
  assert.match(calls[1], /beta\.wd1.*\/Pune\//);
  assert.equal(candidates[0].evidence.detailHydration.reason, 'budget-exhausted');
  assert.equal(candidates[3].evidence.detailHydration.reason, 'budget-exhausted');
});

test('budget-exhausted enrichment preserves the list-derived date and postedOn evidence', async () => {
  const candidates = [
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', location: 'Pune, India', postedAt: '2026-07-10T00:00:00.000Z', evidence: { freshness: { kind: 'workday-postedOn', label: 'Posted 4 Days Ago' } } },
  ];
  await enrichWorkdayCandidates(candidates, { maxRequests: 0 });
  assert.equal(candidates[0].postedAt, '2026-07-10T00:00:00.000Z');
  assert.deepEqual(candidates[0].evidence.freshness, { kind: 'workday-postedOn', label: 'Posted 4 Days Ago' });
  assert.deepEqual(candidates[0].evidence.detailHydration, { status: 'skipped', reason: 'budget-exhausted' });
});

test('a failing detail fetch preserves the list-derived date and records the error class', async () => {
  const candidates = [
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', location: 'Pune, India', postedAt: '2026-07-10T00:00:00.000Z', evidence: { freshness: { kind: 'workday-postedOn', label: 'Posted 4 Days Ago' } } },
  ];
  await enrichWorkdayCandidates(candidates, {
    maxRequests: 1,
    ctx: {
      fetchJson: async () => { throw new TypeError('socket hang up'); },
      sleep: async () => {},
    },
  });
  assert.equal(candidates[0].postedAt, '2026-07-10T00:00:00.000Z');
  assert.deepEqual(candidates[0].evidence.freshness, { kind: 'workday-postedOn', label: 'Posted 4 Days Ago' });
  assert.deepEqual(candidates[0].evidence.detailHydration, { status: 'failed', reason: 'TypeError' });
});

test('a detail payload without a start date preserves the list-derived date and records no freshness contribution', async () => {
  const candidates = [
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', location: 'Pune, India', postedAt: '2026-07-10T00:00:00.000Z', evidence: { freshness: { kind: 'workday-postedOn', label: 'Posted 4 Days Ago' } } },
  ];
  await enrichWorkdayCandidates(candidates, {
    maxRequests: 1,
    ctx: { fetchJson: async () => ({ jobPostingInfo: { startDate: null, jobDescription: null } }) },
  });
  assert.equal(candidates[0].postedAt, '2026-07-10T00:00:00.000Z');
  assert.deepEqual(candidates[0].evidence.freshness, { kind: 'workday-postedOn', label: 'Posted 4 Days Ago' });
  assert.deepEqual(candidates[0].evidence.detailHydration, { status: 'succeeded', freshnessContribution: 'none' });
});

test('enrichment never downgrades liveness across skipped, failed, and dateless outcomes', async () => {
  const activeLiveness = { status: 'Active', checkedAt: '2026-07-14T00:00:00.000Z', evidence: 'list-feed' };
  const candidates = [
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://alpha.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_A', url: 'https://alpha.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_A', location: 'Pune, India', postedAt: '2026-07-10T00:00:00.000Z', evidence: { freshness: { kind: 'workday-postedOn', label: 'Posted 4 Days Ago' } }, liveness: { ...activeLiveness } },
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://beta.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_B', url: 'https://beta.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_B', location: 'Pune, India', postedAt: '2026-07-10T00:00:00.000Z', evidence: { freshness: { kind: 'workday-postedOn', label: 'Posted 4 Days Ago' } }, liveness: { ...activeLiveness } },
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://gamma.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_G', url: 'https://gamma.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_G', location: 'Pune, India', postedAt: '2026-07-10T00:00:00.000Z', evidence: { freshness: { kind: 'workday-postedOn', label: 'Posted 4 Days Ago' } }, liveness: { ...activeLiveness } },
  ];
  await enrichWorkdayCandidates(candidates, {
    maxRequests: 2,
    ctx: {
      fetchJson: async (url) => {
        if (url.includes('alpha.wd1')) throw Object.assign(new Error('forbidden'), { status: 403 });
        return { jobPostingInfo: { startDate: null, jobDescription: null } };
      },
      sleep: async () => {},
    },
  });
  assert.equal(candidates[0].evidence.detailHydration.status, 'failed');
  assert.equal(candidates[1].evidence.detailHydration.status, 'succeeded');
  assert.equal(candidates[2].evidence.detailHydration.status, 'skipped');
  for (const candidate of candidates) {
    assert.deepEqual(candidate.liveness, activeLiveness);
  }
});

test('the detail budget is spread across boards instead of exhausting on the first', async () => {
  const candidates = [
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://alpha.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_A1', url: 'https://alpha.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_A1', location: 'Pune, India', postedAt: null, evidence: {} },
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://beta.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_B1', url: 'https://beta.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_B1', location: 'Pune, India', postedAt: null, evidence: {} },
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://gamma.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_G1', url: 'https://gamma.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_G1', location: 'Pune, India', postedAt: null, evidence: {} },
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://alpha.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_A2', url: 'https://alpha.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_A2', location: 'Pune, India', postedAt: null, evidence: {} },
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://beta.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_B2', url: 'https://beta.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_B2', location: 'Pune, India', postedAt: null, evidence: {} },
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://gamma.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_G2', url: 'https://gamma.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_G2', location: 'Pune, India', postedAt: null, evidence: {} },
  ];
  const calls = [];
  await enrichWorkdayCandidates(candidates, {
    maxRequests: 3,
    ctx: { fetchJson: async (url) => { calls.push(url); return { jobPostingInfo: { startDate: null, jobDescription: null } }; } },
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.some((url) => url.includes('alpha.wd1')));
  assert.ok(calls.some((url) => url.includes('beta.wd1')));
  assert.ok(calls.some((url) => url.includes('gamma.wd1')));
});

test('a detail payload with a start date still hydrates postedAt and startDate freshness', async () => {
  const candidates = [
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', location: 'Pune, India', postedAt: '2026-07-10T00:00:00.000Z', evidence: { freshness: { kind: 'workday-postedOn', label: 'Posted 4 Days Ago' } } },
  ];
  await enrichWorkdayCandidates(candidates, {
    maxRequests: 1,
    ctx: { fetchJson: async () => ({ jobPostingInfo: { startDate: '2026-07-13', jobDescription: '<p>Build agentic systems.</p>' } }) },
  });
  assert.equal(candidates[0].postedAt, '2026-07-13T00:00:00.000Z');
  assert.deepEqual(candidates[0].evidence.freshness, {
    kind: 'workday-startDate',
    detailUrl: 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/job/Pune/Engineer_Pune',
  });
});

test('a future Workday start date preserves list-derived date and freshness evidence', async () => {
  const liveness = { status: 'Active', evidence: 'list-feed' };
  const candidates = [
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', location: 'Pune, India', postedAt: '2026-07-10T00:00:00.000Z', evidence: { freshness: { kind: 'workday-postedOn', label: 'Posted 4 Days Ago' } }, liveness },
  ];
  await enrichWorkdayCandidates(candidates, {
    now: Date.parse('2026-07-13T00:00:00.000Z'),
    maxRequests: 1,
    ctx: { fetchJson: async () => ({ jobPostingInfo: { startDate: '2026-07-14', jobDescription: null } }) },
  });
  assert.equal(candidates[0].postedAt, '2026-07-10T00:00:00.000Z');
  assert.deepEqual(candidates[0].evidence.freshness, { kind: 'workday-postedOn', label: 'Posted 4 Days Ago' });
  assert.deepEqual(candidates[0].evidence.detailHydration, { status: 'succeeded', freshnessContribution: 'none' });
  assert.deepEqual(candidates[0].liveness, liveness);
  assert.notEqual(candidates[0].evidence.freshness.kind, 'workday-startDate');
});

test('a Workday start date at the run clock still dates the candidate with startDate freshness', async () => {
  const candidates = [
    { provider: 'workday', title: 'Software Engineer', canonicalUrl: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', location: 'Pune, India', postedAt: '2026-07-10T00:00:00.000Z', evidence: { freshness: { kind: 'workday-postedOn', label: 'Posted 4 Days Ago' } } },
  ];
  await enrichWorkdayCandidates(candidates, {
    now: Date.parse('2026-07-13T00:00:00.000Z'),
    maxRequests: 1,
    ctx: { fetchJson: async () => ({ jobPostingInfo: { startDate: '2026-07-13', jobDescription: null } }) },
  });
  assert.equal(candidates[0].postedAt, '2026-07-13T00:00:00.000Z');
  assert.deepEqual(candidates[0].evidence.freshness, {
    kind: 'workday-startDate',
    detailUrl: 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/job/Pune/Engineer_Pune',
  });
});
