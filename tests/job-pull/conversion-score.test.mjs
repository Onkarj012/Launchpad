import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConversionPlan, validateConversionPlan } from '../../job-pull/config.mjs';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { conversionTier, scoreConversion, withConversionScore } from '../../job-pull/conversion-score.mjs';

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
  assert.deepEqual(validateConversionPlan({ ...conversionPlan, salaryFloorLpa: null }), []);
  assert.deepEqual(validateConversionPlan({ ...conversionPlan, salaryFloorLpa: 8 }), []);
  assert.match(validateConversionPlan({ ...conversionPlan, salaryFloorLpa: -1 }).join('; '), /salaryFloorLpa/);
  assert.match(validateConversionPlan({ ...conversionPlan, salaryFloorLpa: '8' }).join('; '), /salaryFloorLpa/);
});

test('conversion score exposes the seven plan factors and never implies auto-apply', () => {
  const scored = scoreConversion(candidate(), { freshnessWindow: 'Hot', eligibility: strictIndiaEligibility, policy: conversionPlan.conversionScore });
  assert.deepEqual(scored.factors, {
    responsibilitiesAndStack: 25, experienceEligibility: 20, indiaLocationEligibility: 15, projectConnection: 15,
    directOrVcSource: 10, humanContact: 10, postingFreshness: 5,
  });
  assert.equal(scored.score, 100);
  assert.equal(scored.tier, 'strong');
  assert.equal(scored.applicationReady, true);
});

test('conversion tier bands are inclusive and preserve the default fallback', () => {
  assert.equal(conversionTier(75, conversionPlan.conversionScore.bands), 'strong');
  assert.equal(conversionTier(65, conversionPlan.conversionScore.bands), 'inspect');
  assert.equal(conversionTier(64, conversionPlan.conversionScore.bands), 'skip');
  assert.equal(conversionTier(64), 'skip');
});

test('score conversion wires policy bands to the returned tier', () => {
  const scored = scoreConversion(candidate({ matchScore: 70, sourceKind: 'aggregator', sourceCategory: 'aggregator', conversionSignals: {} }), {
    policy: {
      weights: {
        responsibilitiesAndStack: 100, experienceEligibility: 0, indiaLocationEligibility: 0,
        projectConnection: 0, directOrVcSource: 0, humanContact: 0, postingFreshness: 0,
      },
      bands: conversionPlan.conversionScore.bands,
    },
  });
  assert.equal(scored.score, 70);
  assert.equal(scored.tier, 'inspect');
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

test('recomputing after final Match Score changes the conversion tier', () => {
  const low = withConversionScore(candidate({
    matchScore: 40,
    sourceKind: 'aggregator',
    sourceCategory: 'aggregator',
    conversionSignals: {},
  }), {
    freshnessWindow: 'Hot',
    eligibility: strictIndiaEligibility,
    policy: conversionPlan.conversionScore,
  });
  const high = withConversionScore({ ...low, matchScore: 100 }, {
    freshnessWindow: 'Hot',
    eligibility: strictIndiaEligibility,
    policy: conversionPlan.conversionScore,
  });
  assert.equal(low.conversionTier, 'skip');
  assert.equal(high.conversionTier, 'inspect');
  assert.ok(high.conversionScore > low.conversionScore);
  assert.equal(high.conversionInputs.matchScore, 100);
});
