import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichWorkdayCandidates } from '../../job-pull/workday-enrichment.mjs';

test('Workday enrichment spends its detail budget on India-located rows first', async () => {
  const candidates = [
    { provider: 'workday', canonicalUrl: 'https://acme.wd1.myworkdayjobs.com/Careers/job/United-States/Engineer_US', url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/United-States/Engineer_US', location: 'United States', postedAt: null, evidence: {} },
    { provider: 'workday', canonicalUrl: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_Pune', location: 'Pune, India', postedAt: null, evidence: {} },
    { provider: 'workday', canonicalUrl: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Mumbai/Engineer_Mumbai', url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Mumbai/Engineer_Mumbai', location: 'Mumbai, India', postedAt: null, evidence: {} },
  ];
  const calls = [];
  await enrichWorkdayCandidates(candidates, {
    maxRequests: 2,
    ctx: { fetchJson: async (url) => { calls.push(url); return { startDate: null, jobDescription: null }; } },
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/Pune\//);
  assert.match(calls[1], /\/Mumbai\//);
  assert.equal(candidates[0].evidence.detailHydration.reason, 'budget-exhausted');
});
