import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, loadConversionPlan } from '../../job-pull/config.mjs';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { classifyCandidate } from '../../job-pull/eligibility.mjs';

const config = loadConfig();
const conversionPolicy = { ...config, salaryFloorLpa: loadConversionPlan().salaryFloorLpa };
const explicitFloorPolicy = { ...config, salaryFloorLpa: 8 };

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

test('classification carries labels beside reasons without changing an ordinary role', () => {
  const result = classifyCandidate(candidate({ description: 'Build production AI applications. Full-time, 0-1 years.' }), config);
  assert.deepEqual(result.labels, []);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.tier, 'strict');
});

test('India-eligible remote US, EU and overnight hours pass with a night-hours label', () => {
  for (const description of [
    'Full-time AI Engineer, remote from India. Must work US business hours only.',
    'Full-time AI Engineer, remote from India. Required overlap with EU hours.',
    'Full-time AI Engineer, remote from India. Working hours: 9am-5pm CET.',
    'Full-time AI Engineer, remote from India. Overnight shift only.',
    'Full-time AI Engineer, remote from India. US-hours-only overlap required.',
    'Full-time AI Engineer, remote from India. EU-hours-only overlap required.',
  ]) {
    const result = classifyCandidate(candidate({ location: 'Remote - India', description }), config);
    assert.equal(result.tier, 'strict', description);
    assert.deepEqual(result.reasons, [], description);
    assert.deepEqual(result.labels, ['Night hours (IST)'], description);
  }
  const structured = classifyCandidate(candidate({
    location: 'Remote - APAC',
    timezoneOverlap: { status: 'overnight', minimumHours: 0, evidence: 'Mandatory EST hours' },
  }), config);
  assert.equal(structured.eligible, true);
  assert.deepEqual(structured.labels, ['Night hours (IST)']);
});

test('Pune onsite and hybrid night or rotating shifts stay strict and labelled', () => {
  for (const workMode of ['onsite', 'hybrid']) {
    for (const description of [
      'Full-time AI Engineer. Night shift from our Pune office.',
      'Full-time AI Engineer. Rotating shifts from our Pune office.',
      'Full-time AI Engineer. Overnight shift from our Pune office.',
    ]) {
      const result = classifyCandidate(candidate({ workMode, description }), config);
      assert.equal(result.tier, 'strict', `${workMode}: ${description}`);
      assert.deepEqual(result.reasons, []);
      assert.deepEqual(result.labels, ['Night hours (IST)']);
    }
  }
});

test('immediate joiners stay eligible with a notice-risk label', () => {
  for (const description of [
    'Full-time AI Engineer. Immediate joiners only.',
    'Full-time AI Engineer. Looking for an immediate joiner.',
    'Full-time AI Engineer. Immediate joining required.',
    'Full-time AI Engineer. Candidates must join immediately.',
  ]) {
    const result = classifyCandidate(candidate({ description }), config);
    assert.equal(result.tier, 'strict', description);
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.labels, ['Notice risk'], description);
  }
});

test('notice of 30 days or less stays eligible and labelled while longer notice stays unlabelled', () => {
  for (const description of [
    'Full-time AI Engineer. Notice period: 30 days.',
    'Full-time AI Engineer. Notice period of 15 days or less preferred.',
    'Full-time AI Engineer. Maximum notice: 7 days.',
    'Full-time AI Engineer. 30-day notice period required.',
    'Full-time AI Engineer. Must join within 30 days.',
    'Full-time AI Engineer. Notice period: 0-30 days.',
    'Full-time AI Engineer. Notice period: 15 to 30 days.',
    '<p>Full-time AI Engineer.</p><p>Notice period: <strong>30</strong> days.</p>',
  ]) {
    const result = classifyCandidate(candidate({ description }), config);
    assert.equal(result.tier, 'strict', description);
    assert.deepEqual(result.reasons, [], description);
    assert.deepEqual(result.labels, ['Notice risk'], description);
  }
  for (const description of [
    'Full-time AI Engineer. Notice period: 31 days.',
    'Full-time AI Engineer. Notice period: 60-90 days.',
    'Full-time AI Engineer. 90-day notice period is accepted.',
    'Full-time AI Engineer. Notice period negotiable. 30 days of annual leave.',
  ]) {
    const result = classifyCandidate(candidate({ description }), config);
    assert.equal(result.eligible, true);
    assert.deepEqual(result.labels, [], description);
  }
});

test('labels alone never reject or demote a role and repeat mentions produce one label each', () => {
  const result = classifyCandidate(candidate({
    location: 'Remote - India',
    description: 'Full-time AI Engineer. US hours, night shift. Immediate joiners only. Notice period: 30 days.',
    timezoneOverlap: { status: 'overnight', minimumHours: 0, evidence: 'Required EST hours' },
  }), config);
  assert.deepEqual(result.labels, ['Night hours (IST)', 'Notice risk']);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.eligible, true);
  assert.equal(result.tier, 'strict');
  const fallback = classifyCandidate(candidate({
    description: 'Full-time AI Engineer. Night shift. Immediate joiners only.',
    experience: { minYears: 2, maxYears: 2, evidence: '2 years' },
  }), config);
  assert.deepEqual(fallback.labels, ['Night hours (IST)', 'Notice risk']);
  assert.deepEqual(fallback.reasons, []);
  assert.equal(fallback.tier, 'relaxed');
});

test('labelled roles still reject for the same geography, employment, salary, experience, title and liveness reasons', () => {
  const cases = [
    [{ location: 'Mumbai, India', workMode: 'onsite' }, 'GEO_ONSITE_NOT_PUNE'],
    [{ location: 'Remote - US only' }, 'GEO_REMOTE_REGION_RESTRICTED'],
    [{ employment: { type: 'full-time', paid: false } }, 'EMPLOYMENT_UNPAID'],
    [{ employment: { type: 'contract', evidence: 'Contract role' } }, 'EMPLOYMENT_TYPE_NOT_ALLOWED'],
    [{ salary: { maximum: 500000, currency: 'INR', period: 'annual' } }, 'SALARY_BELOW_FLOOR'],
    [{ experience: { minYears: 3, maxYears: 3, evidence: '3+ years' } }, 'EXPERIENCE_HARD_MIN_3_PLUS'],
    [{ title: 'QA Engineer' }, 'TITLE_OFF_TARGET'],
    [{ liveness: { status: 'Expired' } }, 'LIVENESS_EXPIRED'],
  ];
  for (const [overrides, reason] of cases) {
    const result = classifyCandidate(candidate({
      ...overrides,
      description: 'Night shift. Immediate joiners only. Notice period: 30 days.',
    }), conversionPolicy);
    assert.equal(result.eligible, false, reason);
    assert.deepEqual(result.reasons, [reason]);
    assert.deepEqual(result.labels, ['Night hours (IST)', 'Notice risk']);
  }
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
  assert.equal(conversionPolicy.salaryFloorLpa, 6);
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

test('undisclosed compensation remains Not Verified and is not rejected by the configured six-LPA floor', () => {
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
