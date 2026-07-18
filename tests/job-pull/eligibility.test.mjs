import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../job-pull/config.mjs';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { classifyCandidate } from '../../job-pull/eligibility.mjs';

const config = loadConfig();

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
