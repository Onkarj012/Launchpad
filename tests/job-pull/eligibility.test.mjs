import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig, loadConversionPlan } from '../../job-pull/config.mjs';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { classifyCandidate } from '../../job-pull/eligibility.mjs';

const config = loadConfig();
const conversionPolicy = { ...config, salaryFloorLpa: loadConversionPlan().salaryFloorLpa };
const explicitFloorPolicy = { ...config, salaryFloorLpa: 8 };

test('configured salary floor drops 5.4 LPA and keeps 5.5 LPA', () => {
  for (const [amount, eligible] of [[540000, false], [550000, true]]) {
    const result = classifyCandidate(candidate({
      salary: { minimum: amount, maximum: amount, currency: 'INR', period: 'annual', evidence: `INR ${amount} per annum` },
    }), conversionPolicy);
    assert.equal(result.eligible, eligible, String(amount));
    assert.equal(result.salary.code, eligible ? 'SALARY_FLOOR_MET' : 'SALARY_BELOW_FLOOR');
  }
});

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
  assert.equal(classifyCandidate(candidate({ location: 'Worldwide remote' }), config).geo.pass, false);
  assert.equal(classifyCandidate(candidate({ location: 'Worldwide remote', description: 'Worldwide remote including India.' }), config).geo.pass, true);
  assert.equal(classifyCandidate(candidate({ location: 'Remote' }), config).geo.code, 'GEO_REMOTE_SCOPE_UNCLEAR');
  assert.equal(classifyCandidate(candidate({ location: 'Remote' }), config).tier, null);
  assert.equal(classifyCandidate(candidate({ location: 'Remote - US only' }), config).geo.pass, false);
  assert.equal(classifyCandidate(candidate({ location: 'Remote worldwide, excluding India' }), config).geo.pass, false);
  assert.equal(classifyCandidate(candidate({ location: 'Remote', remoteEligibility: { status: 'eligible', evidence: 'India permitted' } }), config).geo.pass, true);
});

test('explicit foreign remote locations cannot borrow India or global wording from the description', () => {
  for (const location of ['USA, TN, Chattanooga, Remote', 'Remote - Lesser Poland, Poland', 'United Arab Emirates Remote', 'TR Remote', 'Remote: North America - East']) {
    const result = classifyCandidate(candidate({
      location,
      description: 'Our global company also has teams in India.',
    }), config);
    assert.equal(result.geo.pass, false, location);
    assert.equal(result.geo.code, 'GEO_REMOTE_REGION_RESTRICTED', location);
  }
  assert.equal(classifyCandidate(candidate({
    location: 'Remote',
    description: 'Backed by Tiger Global; serving customers around the world.',
  }), config).geo.code, 'GEO_REMOTE_SCOPE_UNCLEAR');
});

test('a global location cannot override an explicit foreign residency requirement', () => {
  const result = classifyCandidate(candidate({
    title: 'Applied AI Engineer (Austria)',
    location: 'Global',
    description: 'This role is remote, but candidates must be based in Austria.',
  }), config);
  assert.equal(result.geo.pass, false);
  assert.equal(result.geo.code, 'GEO_REMOTE_REGION_RESTRICTED');
  assert.match(result.geo.evidence, /must be based in Austria/i);
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

test('Back End Developer is a strict backend role, while unrelated titles stay off target', () => {
  const backend = classifyCandidate(candidate({ title: 'Back End Developer' }), config);
  assert.equal(backend.title.family, 'backend-python');
  assert.equal(backend.tier, 'strict');
  for (const title of ['Back End Recruiter', 'Back End Sales Manager']) {
    const result = classifyCandidate(candidate({ title }), config);
    assert.equal(result.title.pass, false, title);
  }
});

test('country-only India location is strict remote while US-only remains rejected', () => {
  assert.equal(classifyCandidate(candidate({ location: 'India' }), config).geo.mode, 'remote');
  assert.equal(classifyCandidate(candidate({ location: 'India' }), config).tier, 'strict');
  assert.equal(classifyCandidate(candidate({ location: 'Remote - US only' }), config).geo.code, 'GEO_REMOTE_REGION_RESTRICTED');
});

test('internships require a stated stipend of 40000 INR monthly and a PPO path', () => {
  assert.equal(classifyCandidate(candidate({ employment: { type: 'full-time', paid: null } }), config).employment.pass, true);
  for (const description of [
    'Paid internship with a PPO path.',
    'Stipend: INR 40,000 per month.',
    'Stipend: INR 39,999 per month. PPO based on performance.',
    'Stipend: INR 40,000 per month. No PPO offered.',
    'Stipend: INR 40,000 per month. PPO is not available.',
    'Stipend: INR 40,000-50,000 per month. PPO based on performance.',
  ]) {
    assert.equal(classifyCandidate(candidate({ title: 'AI Engineering Intern', employment: { type: 'internship', paid: true }, description }), conversionPolicy).eligible, false, description);
  }
  for (const description of [
    'Stipend: INR 40,000 per month. PPO based on performance.',
    'Stipend: ₹40k/month. Opportunity for a pre-placement offer.',
  ]) {
    const result = classifyCandidate(candidate({ title: 'AI Engineering Intern', employment: { type: 'internship', paid: null }, description }), conversionPolicy);
    assert.equal(result.eligible, true, description);
    assert.equal(result.employment.code, 'EMPLOYMENT_PAID_INTERNSHIP');
  }
  const structured = classifyCandidate(candidate({ title: 'AI Engineering Intern', employment: { type: 'internship', paid: true }, stipend: { amount: 40000, currency: 'INR', period: 'month' }, description: 'Path to a full-time offer after the internship.' }), conversionPolicy);
  assert.equal(structured.eligible, true);
  assert.equal(classifyCandidate(candidate({ title: 'AI Engineering Intern', employment: { type: 'full-time', paid: true }, description: 'Paid internship with a PPO path.' }), conversionPolicy).eligible, false);
  const annual = classifyCandidate(candidate({ title: 'AI Engineering Intern', employment: { type: 'internship', paid: true }, salary: { minimum: 480000, maximum: 480000, currency: 'INR', period: 'annual' }, description: 'PPO based on performance.' }), conversionPolicy);
  assert.equal(annual.eligible, true, 'annual stipend uses the internship floor');
  assert.equal(classifyCandidate(candidate({ employment: { type: 'internship', paid: false } }), config).employment.code, 'EMPLOYMENT_UNPAID');
  assert.equal(classifyCandidate(candidate({ employment: { type: 'full-time', paid: false } }), config).employment.code, 'EMPLOYMENT_UNPAID');
  assert.equal(classifyCandidate(candidate({ employment: {} }), config).employment.code, 'EMPLOYMENT_FULL_TIME_NOT_VERIFIED');
});

test('adjacent engineering stays fallback and off-target roles stay rejected', () => {
  assert.equal(classifyCandidate(candidate({ title: 'Platform Engineer' }), config).tier, 'relaxed');
  assert.equal(classifyCandidate(candidate({ title: 'Application Engineer' }), config).tier, 'relaxed');
  assert.equal(classifyCandidate(candidate({ title: 'QA Engineer' }), config).eligible, false);
});

test('generic maintenance junior engineers are off-target while software and language developers remain targeted', () => {
  for (const title of ['Junior Engineer II, SMT & THT Maintenance', 'Maintenance Junior Engineer - M/F/D']) {
    const result = classifyCandidate(candidate({ title }), config);
    assert.equal(result.eligible, false, title);
    assert.equal(result.title.code, 'TITLE_OFF_TARGET', title);
  }
  for (const title of ['Junior Software Engineer', 'Associate Software Engineer', 'Java Developer']) {
    assert.equal(classifyCandidate(candidate({ title }), config).title.pass, true, title);
  }
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

test('activity-worded experience requirements cannot bypass the hard minimum gate', () => {
  for (const description of [
    'What You Bring: 5-8 years building backend systems in Java.',
    'Requirements: 3+ years developing production software.',
  ]) {
    const result = classifyCandidate(candidate({ experience: {}, description }), config);
    assert.equal(result.eligible, false, description);
    assert.equal(result.experience.code, 'EXPERIENCE_HARD_MIN_3_PLUS', description);
  }
  const relaxed = classifyCandidate(candidate({
    experience: {},
    description: 'What experiences will help: 2-5 years of backend development with Python.',
  }), config);
  assert.equal(relaxed.experience.minYears, 2);
  assert.equal(relaxed.experience.code, 'EXPERIENCE_RELAXED_UP_TO_2');
  const unrelatedNumber = classifyCandidate(candidate({
    experience: {},
    description: 'Requirements: support at least 720p video output. Freshers welcome.',
  }), config);
  assert.equal(unrelatedNumber.experience.code, 'EXPERIENCE_FRESHER_EVIDENCE');
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

test('annual INR salary below an explicit floor is a hard rejection with evidence', () => {
  const result = classifyCandidate(candidate({ salary: { minimum: 600000, maximum: 700000, currency: 'INR', period: 'annual', evidence: '₹6-7 lakh per annum' } }), explicitFloorPolicy);
  assert.equal(result.salary.pass, false);
  assert.equal(result.salary.code, 'SALARY_BELOW_FLOOR');
  assert.equal(result.salary.evidence, '₹6-7 lakh per annum');
  assert.ok(result.reasons.includes('SALARY_BELOW_FLOOR'));
});

test('explicitly disabled salary floor rejects nothing regardless of compensation evidence', () => {
  const lowSalary = { minimum: 600000, maximum: 700000, currency: 'INR', period: 'annual', evidence: '₹6-7 lakh per annum' };
  for (const floor of [null, undefined]) {
    const result = classifyCandidate(candidate({ salary: lowSalary }), { ...config, salaryFloorLpa: floor });
    assert.equal(result.salary.pass, true, String(floor));
    assert.equal(result.salary.code, 'SALARY_FLOOR_DISABLED', String(floor));
    assert.equal(result.eligible, true, String(floor));
  }
  assert.equal(conversionPolicy.salaryFloorLpa, 5.5);
  assert.equal(classifyCandidate(candidate({ salary: lowSalary }), conversionPolicy).salary.pass, true);
});

test('missing or ambiguous salary data passes through without invented evidence', () => {
  const missing = classifyCandidate(candidate({ salary: {} }), explicitFloorPolicy);
  const ambiguous = classifyCandidate(candidate({ salary: { maximum: 700000, currency: 'USD', period: 'annual' } }), explicitFloorPolicy);
  assert.equal(missing.salary.pass, true);
  assert.equal(missing.salary.evidence, null);
  assert.equal(ambiguous.salary.pass, true);
  assert.equal(ambiguous.salary.evidence, null);
});

test('undisclosed compensation remains Not Verified and is not rejected by the configured floor', () => {
  const result = classifyCandidate(candidate({ salary: {} }), conversionPolicy);
  assert.equal(result.salary.code, 'SALARY_NOT_VERIFIED');
  assert.equal(result.salary.pass, true);
  assert.equal(result.eligible, true);
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

test('drops every prohibited employment type even when the feed says full-time and paid', () => {
  for (const description of [
    'Unpaid engineering role.',
    'Equity-only compensation.',
    'Commission-only compensation.',
    'Volunteer developer position.',
    'Part-time engineer role.',
    'Freelance developer paid per task.',
    'Training fee required before joining.',
    'Bonded employment for two years.',
    'Staffing agency hiring for an undisclosed client.',
    'Recruitment agency reselling this role, client not named.',
    'Staffing agency hiring an AI Engineer for our client.',
  ]) {
    const result = classifyCandidate(candidate({ description, employment: { type: 'full-time', paid: true } }), conversionPolicy);
    assert.equal(result.eligible, false, description);
    assert.equal(result.employment.pass, false, description);
  }
  assert.equal(classifyCandidate(candidate({
    description: 'Staffing agency hiring for named client Example Product Ltd.',
  }), conversionPolicy).employment.pass, true);
  assert.equal(classifyCandidate(candidate({ employment: { type: 'volunteer', paid: true } }), conversionPolicy).eligible, false);
});

test('master policy states the implemented salary, internship, and drop-list rules', () => {
  const policy = readFileSync(new URL('../../master_prompt.md', import.meta.url), 'utf8');
  assert.match(policy, /Minimum compensation filter:\*\* ₹5\.5 LPA/);
  assert.match(policy, /undisclosed compensation remains `Not Verified`/);
  assert.match(policy, /stipend ≥ ₹40k\/month with a stated PPO path/);
  assert.match(policy, /AICTE and NATS/);
  assert.match(policy, /Unpaid, equity-only, commission-only, volunteer, part-time, freelance per-task, training-fee, bonded, and agency-resale-without-named-client roles → drop/);
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

test('role-specific senior requirements reject generic titles without rejecting employer boilerplate', () => {
  const senior = candidate({ title: 'Java Developer', experience: { minYears: null, maxYears: null }, description: 'We are seeking a highly skilled Senior Java Developer to join our team.' });
  assert.equal(classifyCandidate(senior, config).eligible, false);
  assert.equal(classifyCandidate(senior, config).experience.code, 'EXPERIENCE_SENIOR_ROLE_REQUIREMENT');
  const boilerplate = candidate({ title: 'Java Developer', experience: { minYears: null, maxYears: null }, description: 'Our senior leaders support every developer. Build Java applications.' });
  assert.equal(classifyCandidate(boilerplate, config).experience.manualReview, true);
});
