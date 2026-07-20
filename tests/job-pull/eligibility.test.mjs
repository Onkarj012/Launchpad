import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, loadConversionPlan } from '../../job-pull/config.mjs';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { classifyCandidate } from '../../job-pull/eligibility.mjs';

const config = loadConfig();
const conversionPolicy = { ...config, salaryFloorLpa: loadConversionPlan().salaryFloorLpa };

function candidate(overrides = {}) {
  return normalizeCandidate({
    url: 'https://example.test/jobs/1',
    source: 'fixture',
    provider: 'fixture',
    id: '1',
    company: 'Example',
    title: 'AI Engineer',
    location: 'Pune, Maharashtra, India',
    postedAt: '2026-07-14T08:00:00.000Z',
    employment: { type: 'full-time', paid: null },
    experience: { minYears: 0, maxYears: 1, evidence: '0-1 years' },
    liveness: { status: 'Active', checkedAt: '2026-07-14T09:00:00.000Z', evidence: 'fixture' },
    ...overrides,
  });
}

test('Pune metro onsite/hybrid passes while other cities fail', () => {
  assert.equal(classifyCandidate(candidate(), config).eligible, true);
  assert.equal(classifyCandidate(candidate({ location: 'Hinjewadi, Pune', workMode: 'hybrid' }), config).geo.code, 'GEO_PUNE_METRO');
  assert.equal(classifyCandidate(candidate({ location: 'Bangalore, India', workMode: 'onsite' }), config).geo.pass, false);
  assert.equal(classifyCandidate(candidate({ location: 'Mumbai, India', workMode: 'hybrid' }), config).geo.pass, false);
  assert.equal(classifyCandidate(candidate({ location: 'Hyderabad, India', workMode: 'onsite' }), config).geo.pass, false);
});

test('remote scope must explicitly include India-compatible geography', () => {
  assert.equal(classifyCandidate(candidate({ location: 'Remote - India' }), config).geo.pass, true);
  assert.equal(classifyCandidate(candidate({ location: 'Remote - APAC' }), config).geo.pass, true);
  assert.equal(classifyCandidate(candidate({ location: 'Worldwide remote' }), config).geo.pass, true);
  assert.equal(classifyCandidate(candidate({ location: 'Remote' }), config).geo.code, 'GEO_REMOTE_SCOPE_UNCLEAR');
  assert.equal(classifyCandidate(candidate({ location: 'Remote' }), config).tier, null);
  assert.equal(classifyCandidate(candidate({ location: 'Remote - US only' }), config).geo.pass, false);
  assert.equal(classifyCandidate(candidate({ location: 'Remote worldwide, excluding India' }), config).geo.pass, false);
  assert.equal(classifyCandidate(candidate({ location: 'Remote', remoteEligibility: { status: 'eligible', evidence: 'India permitted' } }), config).geo.pass, true);
});

test('missing work mode and location never pass the India eligibility gate', () => {
  const result = classifyCandidate(candidate({ location: null, workMode: null, description: 'Build reliable AI systems.' }), config);
  assert.equal(result.geo.pass, false);
  assert.equal(result.geo.code, 'GEO_NOT_VERIFIED');
  assert.equal(result.eligible, false);
});

test('expanded target titles pass as strict roles', () => {
  for (const title of ['Software Development Engineer', 'GenAI Developer']) {
    const result = classifyCandidate(candidate({ title }), config);
    assert.equal(result.tier, 'strict', title);
  }
});

test('country-only India location is strict remote while US-only remains rejected', () => {
  assert.equal(classifyCandidate(candidate({ location: 'India' }), config).geo.mode, 'remote');
  assert.equal(classifyCandidate(candidate({ location: 'India' }), config).tier, 'strict');
  assert.equal(classifyCandidate(candidate({ location: 'Remote - US only' }), config).geo.code, 'GEO_REMOTE_REGION_RESTRICTED');
});

test('employment and pay gates allow full-time and explicitly paid internships only', () => {
  assert.equal(classifyCandidate(candidate({ employment: { type: 'full-time', paid: null } }), config).employment.pass, true);
  assert.equal(classifyCandidate(candidate({ title: 'AI Engineering Intern', employment: { type: 'internship', paid: true } }), config).employment.pass, true);
  assert.equal(classifyCandidate(candidate({ title: 'AI Engineering Intern', employment: { type: 'internship', paid: null } }), config).employment.code, 'INTERNSHIP_PAY_NOT_EXPLICIT');
  assert.equal(classifyCandidate(candidate({ employment: { type: 'internship', paid: false } }), config).employment.code, 'EMPLOYMENT_UNPAID');
  assert.equal(classifyCandidate(candidate({ employment: { type: 'full-time', paid: false } }), config).employment.code, 'EMPLOYMENT_UNPAID');
  assert.equal(classifyCandidate(candidate({ employment: {} }), config).employment.code, 'EMPLOYMENT_FULL_TIME_NOT_VERIFIED');
});

test('adjacent engineering stays fallback and off-target roles stay rejected', () => {
  assert.equal(classifyCandidate(candidate({ title: 'Platform Engineer' }), config).tier, 'relaxed');
  assert.equal(classifyCandidate(candidate({ title: 'Application Engineer' }), config).tier, 'relaxed');
  assert.equal(classifyCandidate(candidate({ title: 'QA Engineer' }), config).eligible, false);
});

test('experience separates strict, relaxed, and hard rejection', () => {
  const strict = classifyCandidate(candidate({ experience: { minYears: 0, maxYears: 1, evidence: '0-1 years' } }), config);
  const relaxed = classifyCandidate(candidate({ experience: { minYears: 2, maxYears: 2, evidence: '2 years' } }), config);
  const rejected = classifyCandidate(candidate({ experience: { minYears: 3, maxYears: null, evidence: '3+ years' } }), config);
  assert.equal(strict.tier, 'strict');
  assert.equal(relaxed.tier, 'relaxed');
  assert.deepEqual(relaxed.relaxations, ['experience-up-to-2-years']);
  assert.equal(rejected.eligible, false);
  assert.equal(rejected.experience.code, 'EXPERIENCE_HARD_MIN_3_PLUS');
});

test('unknown evidence stays visible while only confirmed expiry fails liveness', () => {
  const unknown = normalizeCandidate({
    url: 'https://example.test/jobs/unknown', company: 'Example', title: 'AI Engineer', location: 'Pune',
    postedAt: '2026-07-14T08:00:00.000Z', employment: { type: 'full-time' },
  });
  assert.equal(unknown.experience.minYears, null);
  assert.equal(unknown.liveness.status, 'Not Verified');
  const classified = classifyCandidate(unknown, config);
  assert.equal(classified.eligible, true);
  assert.equal(classified.tier, 'relaxed');
  assert.equal(classified.experience.code, 'EXPERIENCE_NOT_STATED_MANUAL_REVIEW');
  assert.deepEqual(classified.relaxations, ['experience-not-stated']);
  assert.equal(classified.liveness.code, 'LIVENESS_NOT_VERIFIED');
});

test('region-qualified global wording does not grant remote eligibility', () => {
  const result = classifyCandidate(candidate({ location: 'Remote', description: 'Work remotely anywhere within Europe.' }), config);
  assert.equal(result.geo.pass, false);
  assert.equal(result.geo.code, 'GEO_REMOTE_SCOPE_UNCLEAR');
});

test('foreign work authorization hard-fails despite generic remote scope', () => {
  const result = classifyCandidate(candidate({ location: 'Remote worldwide', description: 'Candidates must be authorized to work in the US.' }), config);
  assert.equal(result.geo.pass, false);
  assert.equal(result.geo.code, 'GEO_REMOTE_REGION_RESTRICTED');
  assert.match(result.geo.evidence, /authorized to work in the US/i);
});

test('structured India location remains compatible with stray geo wording', () => {
  const result = classifyCandidate(candidate({ location: 'India', description: 'Remote anywhere within Germany. Work authorization in India is accepted.' }), config);
  assert.equal(result.geo.pass, true);
  assert.equal(result.geo.mode, 'remote');
});

test('fresher evidence makes missing experience strict', () => {
  const result = classifyCandidate(candidate({ experience: {}, description: 'This role welcomes freshers.' }), config);
  assert.equal(result.experience.code, 'EXPERIENCE_FRESHER_EVIDENCE');
  assert.equal(result.experience.evidence, 'freshers');
  assert.equal(result.tier, 'strict');
});

test('missing experience without fresher evidence requires manual review', () => {
  const result = classifyCandidate(candidate({ experience: {}, description: 'Build production services with Python.' }), config);
  assert.equal(result.experience.code, 'EXPERIENCE_NOT_STATED_MANUAL_REVIEW');
  assert.equal(result.experience.manualReview, true);
  assert.equal(result.tier, 'relaxed');
  assert.deepEqual(result.relaxations, ['experience-not-stated']);
});

test('seniority markers hard-reject otherwise targeted titles', () => {
  const result = classifyCandidate(candidate({ title: 'Senior AI Engineer' }), config);
  assert.equal(result.eligible, false);
  assert.equal(result.title.code, 'TITLE_SENIORITY_REJECT');
});

test('graduate titles with a seniority phrase use the graduate exception', () => {
  const result = classifyCandidate(candidate({ title: 'Graduate Engineer - Team Lead track' }), config);
  assert.equal(result.title.pass, true);
  assert.equal(result.title.code, 'TITLE_TARGET');
  assert.equal(result.tier, 'strict');
});

test('annual INR salary below the configured floor is a hard rejection with evidence', () => {
  const result = classifyCandidate(candidate({ salary: { minimum: 600000, maximum: 700000, currency: 'INR', period: 'annual', evidence: '₹6-7 lakh per annum' } }), conversionPolicy);
  assert.equal(result.salary.pass, false);
  assert.equal(result.salary.code, 'SALARY_BELOW_FLOOR');
  assert.equal(result.salary.evidence, '₹6-7 lakh per annum');
  assert.ok(result.reasons.includes('SALARY_BELOW_FLOOR'));
});

test('missing or ambiguous salary data passes through without invented evidence', () => {
  const missing = classifyCandidate(candidate({ salary: {} }), conversionPolicy);
  const ambiguous = classifyCandidate(candidate({ salary: { maximum: 700000, currency: 'USD', period: 'annual' } }), conversionPolicy);
  assert.equal(missing.salary.pass, true);
  assert.equal(missing.salary.evidence, null);
  assert.equal(ambiguous.salary.pass, true);
  assert.equal(ambiguous.salary.evidence, null);
});

test('explicit training fee or employment bond language is rejected with the matched evidence', () => {
  const result = classifyCandidate(candidate({ description: 'Genuine payment required before joining and a service agreement bond of 2 years.' }), config);
  assert.equal(result.employment.pass, false);
  assert.equal(result.employment.code, 'EMPLOYMENT_TRAINING_FEE_OR_BOND');
  assert.match(result.employment.evidence, /payment required before/i);
  assert.ok(result.evidenceCodes.includes('EMPLOYMENT_TRAINING_FEE_OR_BOND'));
});

test('ordinary verification and notice language does not trigger the fee or bond filter', () => {
  const result = classifyCandidate(candidate({ description: 'A background check may be completed during the notice period.' }), config);
  assert.equal(result.employment.pass, true);
  assert.notEqual(result.employment.code, 'EMPLOYMENT_TRAINING_FEE_OR_BOND');
});

test('new AI title families classify as strict AI roles', () => {
  for (const title of [
    'AI Product Engineer', 'Applied AI Engineer', 'AI Software Engineer', 'LLM Application Engineer',
    'AI Automation Engineer', 'AI Integration Engineer', 'Junior AI Engineer', 'AI Solutions Engineer',
  ]) {
    const result = classifyCandidate(candidate({ title }), config);
    assert.equal(result.tier, 'strict', title);
    assert.equal(result.roleFamily, 'ai-llm-agentic', title);
  }
  const fullStack = classifyCandidate(candidate({ title: 'AI-Native Full Stack Engineer' }), config);
  assert.equal(fullStack.tier, 'strict');
  assert.equal(fullStack.roleFamily, 'full-stack-ai');
});

test('SDE I variants and Software Engineer I classify as general new-grad SWE', () => {
  for (const title of ['SDE I', 'SDE-I', 'Software Engineer I']) {
    const result = classifyCandidate(candidate({ title }), config);
    assert.equal(result.tier, 'strict', title);
    assert.equal(result.roleFamily, 'general-new-grad-swe', title);
  }
});

test('Founding Engineer and Product Engineer use AI context for family bucketing', () => {
  for (const title of ['Founding Engineer', 'Product Engineer']) {
    assert.equal(classifyCandidate(candidate({ title }), config).roleFamily, 'general-new-grad-swe', title);
    assert.equal(classifyCandidate(candidate({ title, description: 'Build an LLM product for customers.' }), config).roleFamily, 'ai-llm-agentic', title);
  }
});

test('seniority still rejects contextual new title families', () => {
  for (const title of ['Senior Product Engineer', 'Founding Engineer - Lead']) {
    const result = classifyCandidate(candidate({ title }), config);
    assert.equal(result.eligible, false, title);
    assert.equal(result.title.code, 'TITLE_SENIORITY_REJECT', title);
  }
});
