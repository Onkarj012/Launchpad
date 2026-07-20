import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConversionPlan, validateConversionPlan } from '../../job-pull/config.mjs';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { scoreConversion } from '../../job-pull/conversion-score.mjs';

const conversionPlan = loadConversionPlan();

function candidate(overrides = {}) {
  return normalizeCandidate({
    url: 'https://jobs.example.test/1', sourceKind: 'ats-direct', provider: 'greenhouse',
    company: 'Example', title: 'AI Engineer', location: 'Pune', postedAt: '2026-07-14T08:00:00.000Z',
    employment: { type: 'full-time' }, experience: { minYears: 0, maxYears: 1 },
    liveness: { status: 'Active' }, matchScore: 100,
    conversionSignals: { humanContact: true, projectConnection: true },
    ...overrides,
  });
}

const strictIndiaEligibility = {
  geo: { pass: true },
  experience: { pass: true, strict: true, manualReview: false },
};

test('conversion plan validates the single seven-factor source of truth', () => {
  assert.deepEqual(validateConversionPlan(conversionPlan), []);
  assert.match(validateConversionPlan({ ...conversionPlan, salaryFloorLpa: 7 }).join('; '), /salaryFloorLpa/);
});

test('conversion score exposes the seven plan factors and never implies auto-apply', () => {
  const scored = scoreConversion(candidate(), { freshnessWindow: 'Hot', eligibility: strictIndiaEligibility, policy: conversionPlan.conversionScore });
  assert.deepEqual(scored.factors, {
    responsibilitiesAndStack: 25, experienceEligibility: 20, indiaLocationEligibility: 15, projectConnection: 15,
    directOrVcSource: 10, humanContact: 10, postingFreshness: 5,
  });
  assert.equal(scored.score, 100);
  assert.equal(scored.applicationReady, true);
});

test('unverified unresolved aggregators receive no readiness points and are not apply-ready', () => {
  const scored = scoreConversion(candidate({
    sourceKind: 'aggregator', sourceCategory: 'aggregator',
    liveness: { status: 'Not Verified' }, originalApplicationUrl: null,
  }), { freshnessWindow: 'Hot', eligibility: strictIndiaEligibility, policy: conversionPlan.conversionScore });
  assert.equal(scored.applicationReady, false);
  assert.equal(scored.factors.directOrVcSource, 0);
  assert.equal(scored.applicationReadiness, 'Original Application Unresolved');
});
