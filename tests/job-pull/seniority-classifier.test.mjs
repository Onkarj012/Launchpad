import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { loadConfig } from '../../job-pull/config.mjs';
import { classifyCandidate } from '../../job-pull/eligibility.mjs';
import { mergeScoreRow } from '../../job-pull/match-scorer.mjs';
import { runNormalMode } from '../../job-pull/normal-mode.mjs';
import { NORMAL_SOURCE_LANES } from '../../job-pull/normal-sources.mjs';
import {
  adjudicateSeniority,
  classifySeniority,
} from '../../job-pull/seniority-classifier.mjs';
import {
  evaluateSeniorityGoldSet,
  validateSeniorityGoldSet,
} from '../../job-pull/seniority-gold-set.mjs';

const NOW = '2026-07-26T06:30:00.000Z';
const config = loadConfig();

function candidate(description) {
  return normalizeCandidate({
    url: 'https://jobs.example.test/roles/seniority',
    company: 'Example',
    title: 'AI Engineer',
    location: 'Pune, India',
    postedAt: NOW,
    description,
    employment: { type: 'full-time', evidence: 'full-time' },
    experience: {},
    liveness: { status: 'Active', checkedAt: NOW, evidence: 'fixture' },
    matchScore: 80,
  }, {
    runAt: NOW,
    source: 'tracked-ats',
    sourceKind: 'ats-direct',
    currentFeedIsLive: true,
  });
}

function sourceFunctions(records = []) {
  return Object.fromEntries(NORMAL_SOURCE_LANES.map((lane) => [
    lane.id,
    () => ({
      records: lane.id === 'tracked-ats'
        ? records.map((record) => ({ ...record, source: lane.id, sourceCategory: lane.category, provider: lane.provider }))
        : [],
    }),
  ]));
}

test('explicit total-professional minimum of three years rejects', () => {
  const row = candidate('Requirements: 3+ years developing production software.');
  const assessment = adjudicateSeniority(row, {
    seniorityDecision: 'eligible',
    requirementKind: 'total-professional',
    minimumYears: 3,
    evidenceQuote: '3+ years developing production software',
    confidence: 0.99,
    reasonCode: 'MODEL_ELIGIBLE',
  });
  assert.equal(assessment.seniorityDecision, 'ineligible');
  assert.equal(assessment.reasonCode, 'SENIORITY_TOTAL_MINIMUM_3_PLUS');
  const eligibility = classifyCandidate({ ...row, seniorityAssessment: assessment }, config);
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.experience.code, 'SENIORITY_TOTAL_MINIMUM_3_PLUS');
});

test('technology-specific three years abstains and cache keys include both versions', async () => {
  const row = candidate('You need 3 years of experience with Python for this role.');
  const cache = new Map();
  let calls = 0;
  const classifyModel = async () => {
    calls++;
    return {
      seniorityDecision: 'ineligible',
      requirementKind: 'technology-specific',
      minimumYears: 3,
      evidenceQuote: '3 years of experience with Python',
      confidence: 0.92,
      reasonCode: 'MODEL_TECH_REJECT',
    };
  };
  const first = await classifySeniority(row, {
    classifyModel,
    cache,
    promptVersion: 'prompt-test-v2',
    modelVersion: 'model-test-v3',
  });
  const second = await classifySeniority(row, {
    classifyModel,
    cache,
    promptVersion: 'prompt-test-v2',
    modelVersion: 'model-test-v3',
  });
  assert.equal(first.seniorityDecision, 'uncertain');
  assert.equal(first.reasonCode, 'SENIORITY_TECHNOLOGY_SPECIFIC_VERIFY');
  assert.match(first.cacheKey, /:prompt-test-v2:model-test-v3$/);
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);
});

test('ambiguous requirements stay visible and seed gold-set rates remain untrusted', async () => {
  const jd = 'We value 3 years delivering customer outcomes.';
  const result = await runNormalMode({
    clock: () => NOW,
    sourceFunctions: sourceFunctions([candidate(jd)]),
    seniorityClassifier: async () => ({
      seniorityDecision: 'uncertain',
      requirementKind: 'ambiguous',
      minimumYears: 3,
      evidenceQuote: '3 years delivering customer outcomes',
      confidence: 0.55,
      reasonCode: 'MODEL_AMBIGUOUS',
    }),
  });
  assert.equal(result.shortlist.length, 0);
  assert.equal(result.verificationQueue.length, 1);
  assert.ok(result.verificationQueue[0].reasons.includes('SENIORITY_AMBIGUOUS_VERIFY'));
  assert.equal(result.seniority.uncertain, 1);

  const goldSet = JSON.parse(readFileSync(new URL('./fixtures/seniority-gold-set.json', import.meta.url), 'utf8'));
  const validation = validateSeniorityGoldSet(goldSet);
  const evaluation = await evaluateSeniorityGoldSet(goldSet, async () => 'eligible');
  assert.equal(validation.valid, true);
  assert.equal(validation.reviewComplete, false);
  assert.equal(evaluation.trusted, false);
  assert.equal(evaluation.falsePositiveRate, null);
  assert.equal(evaluation.falseNegativeRate, null);
});

test('a non-literal evidence quote rejects the model row', () => {
  const row = candidate('Requirements: 2 years building production services.');
  const output = {
    seniorityDecision: 'eligible',
    requirementKind: 'total-professional',
    minimumYears: 2,
    evidenceQuote: 'two years building production services',
    confidence: 0.9,
    reasonCode: 'MODEL_ELIGIBLE',
  };
  const assessment = adjudicateSeniority(row, output);
  assert.equal(assessment.accepted, false);
  assert.equal(assessment.reasonCode, 'SENIORITY_EVIDENCE_QUOTE_NOT_IN_JD');
  const merged = mergeScoreRow(row, {
    canonicalUrl: row.canonicalUrl,
    matchScore: 80,
    responseLikelihood: 14,
    ...output,
  });
  assert.equal(merged.candidate.matchScore, null);
  assert.equal(merged.failure.reason, 'SENIORITY_EVIDENCE_QUOTE_NOT_IN_JD');
});
