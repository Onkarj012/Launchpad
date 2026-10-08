import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractExperienceYears, normalizeCandidate } from '../../job-pull/candidate.mjs';
import { classifyExperience } from '../../job-pull/eligibility.mjs';

const captured = JSON.parse(readFileSync(new URL('../fixtures/portals/linkedin-details/live-trial-observations-2026-10-03.json', import.meta.url)));
const accenture = JSON.parse(readFileSync(new URL('../fixtures/experience/accenture-captured-2026-10-06.json', import.meta.url)));
const policy = { experience: { hardRejectMinimumYears: 3, relaxedMaximumYears: 2, strictMaximumYears: 1 } };

test('both saved NEC JDs ignore 122/30 years of company tenure and retain unknown applicant experience', () => {
  const nec = captured.filter((row) => row.company.startsWith('NEC') && row.description);
  assert.equal(nec.length, 2);
  for (const row of nec) {
    assert.match(row.description, /122 years of experience/);
    assert.equal(extractExperienceYears(row.description), null);
    const candidate = normalizeCandidate({ ...row, experience: {} });
    assert.equal(candidate.experience.minYears, null);
    const result = classifyExperience(candidate, policy);
    assert.equal(result.code, 'EXPERIENCE_NOT_STATED_MANUAL_REVIEW');
    assert.equal(result.manualReview, true);
  }
});

test('saved broad Python title rejects on its actual 3-5 range', () => {
  const row = captured.find((row) => row.jobId === '4472546196');
  assert.match(row.title, /3-5 Years experienced/);
  const result = classifyExperience(normalizeCandidate({ ...row, experience: {} }), policy);
  assert.equal(result.minYears, 3);
  assert.equal(result.maxYears, 5);
  assert.equal(result.code, 'EXPERIENCE_HARD_MIN_3_PLUS');
});

test('saved Cognologix description preserves the lower bound of its ASCII and Unicode ranges', () => {
  const html = readFileSync(new URL('../fixtures/portals/linkedin-details/linkedin-detail-4433878985.html', import.meta.url), 'utf8');
  const posting = JSON.parse(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]);
  const result = extractExperienceYears(posting.description);
  assert.equal(result.minYears, 3);
  assert.equal(result.maxYears, 5);
  assert.equal(classifyExperience({ description: posting.description }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
});

test('applicant ranges, activity requirements, and explicit 3+ still enforce the same gate', () => {
  for (const description of [
    'You must have 3+ years of Python experience.',
    'Requirements: 3-5 years of hands-on experience.',
    'Requirements: 3 – 5 years of hands-on experience.',
    'Requirements: 3 to 5 years building backend systems.',
    'Our ideal candidate has 3+ years of experience.',
    'We are seeking an engineer with 3-5 years of experience.',
    'Our company has 122 years of experience. You must have 3+ years developing software.',
    'We expect 3+ years of experience.',
    'Our ideal engineer has 3-5 years of experience.',
    'Our company requires 3-5 years of experience.',
    'Our team is looking for a developer with 3-5 years of experience.',
  ]) {
    const parsed = extractExperienceYears(description);
    assert.equal(parsed?.minYears, 3, description);
    assert.equal(classifyExperience({ description }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS', description);
  }
  assert.equal(extractExperienceYears('2–5 years of backend development').minYears, 2);
  for (const description of [
    'Our organisation has 122 years of experience in technology.',
    'We have more than 30 years of experience providing IT services.',
    'Our company requires software to be supported for 5 years.',
    '3-5 years of experience preferred.',
    'The company has 30 years of experience. Build backend systems.',
  ]) assert.equal(extractExperienceYears(description), null, description);
});

test('explicit applicant experience strings preserve Unicode range bounds and eligibility', () => {
  for (const experience of ['2–5 years', '2—5 years', '2 to 5 years']) {
    const candidate = normalizeCandidate({ ...captured[0], experience });
    assert.equal(candidate.experience.minYears, 2);
    assert.equal(candidate.experience.maxYears, 5);
    assert.equal(classifyExperience(candidate, policy).code, 'EXPERIENCE_RELAXED_UP_TO_2');
  }
});

test('saved Accenture minima survive parenthesized units and education years', () => {
  for (const minimum of [2, 3, 2, 2, 5]) {
    const description = `Minimum ${minimum} year(s) of experience is required Educational Qualification : 15 years full time education Summary : As a Custom Software Engineer`;
    const result = extractExperienceYears(description);
    assert.equal(result.minYears, minimum);
    assert.equal(classifyExperience({ description }, policy).pass, minimum < 3);
  }
  assert.equal(extractExperienceYears('Required educational qualification: 16 years of full time education.'), null);
  assert.equal(extractExperienceYears('Minimum 18 years schooling required.'), null);
  assert.equal(extractExperienceYears('Requires fifteen years of education.'), null);
  assert.equal(extractExperienceYears('Minimum 15 years of formal education.'), null);
  assert.equal(extractExperienceYears('Minimum 5 year(s) of experience is required Educational Qualification : 15 years full time education. c:Minimum 15 yrs. of full time educational is required. Qualification 15 years full time education').minYears, 5);
});

test('all five full captured Accenture JDs retain their actual applicant minima and policy tiers', () => {
  assert.deepEqual(accenture.map((row) => row.expectedMinimumYears), [2, 3, 2, 2, 5]);
  for (const row of accenture) {
    const experience = extractExperienceYears(row.description);
    assert.equal(experience.minYears, row.expectedMinimumYears, row.id);
    const candidate = normalizeCandidate({ ...row, experience: {}, employment: { type: 'full-time' } });
    assert.equal(candidate.experience.minYears, row.expectedMinimumYears, row.id);
    const result = classifyExperience(candidate, policy);
    assert.equal(result.code, row.expectedMinimumYears < 3 ? 'EXPERIENCE_RELAXED_UP_TO_2' : 'EXPERIENCE_HARD_MIN_3_PLUS', row.id);
  }
  assert.equal(extractExperienceYears('Minimum 3+ yrs. of professional software experience required.').minYears, 3);
  assert.equal(extractExperienceYears('Minimum 15 yrs. of full time educational is required.'), null);
});

test('number words and mixed required versus preferred clauses keep the strictest hard minimum', () => {
  for (const [description, minimum] of [
    ['Minimum two year(s) of experience is required. Fifteen years full time education.', 2],
    ['Three or more years of experience required.', 3],
    ['Requirements: two years of experience. Five years of experience preferred.', 2],
    ['Minimum 2 years of experience required. Requirements: 5 years of experience preferred.', 2],
    ['2 years of experience required; 5 years of experience nice to have.', 2],
    ['5 years of experience preferred. Minimum 3+ years of experience required.', 3],
    ['Minimum 2 years experience required, and 3+ years of Python experience required.', 3],
    ['3+ years of Python experience required, AWS knowledge preferred.', 3],
  ]) assert.equal(extractExperienceYears(description)?.minYears, minimum, description);
  for (const description of ['Five years of experience preferred.', 'Requirements: 5 years of experience preferred.', 'Requirements: 5 years of experience in Python preferred.', 'Nice to have: three years of experience.', 'Preferred: 5 year(s) of experience.', 'Requirements: preferred 5 years of experience.']) {
    assert.equal(extractExperienceYears(description), null, description);
  }
});

test('word numbers with parenthesized digits retain minimums and hard rejects', () => {
  for (const [description, minimum] of [
    ['Minimum two (2) years of experience.', 2],
    ['one (1) year of experience.', 1],
    ['three (3)+ years of experience required.', 3],
    ['Minimum three (3)+ years required.', 3],
  ]) {
    assert.equal(extractExperienceYears(description)?.minYears, minimum, description);
    if (minimum === 3) assert.equal(classifyExperience({ description }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  }
});

test('degree alternatives do not impose an experience minimum or weaken a separate requirement', () => {
  for (const description of [
    "Bachelor's degree or 4 years of experience.",
    'A bachelor degree, or equivalent 4 years experience.',
    'Required: an undergraduate degree or 4 years of software development experience.',
  ]) assert.equal(extractExperienceYears(description), null, description);
  for (const description of [
    "Bachelor's degree or 4 years of experience. Minimum 3+ years required.",
    "Bachelor's degree or 4 years of experience; 3+ years of Python experience required.",
    "Bachelor's degree required and 3+ years of experience required.",
    'Requires 3 years of relevant experience, or 2 years of experience with a Masters degree.',
  ]) {
    assert.equal(extractExperienceYears(description)?.minYears, 3, description);
    assert.equal(classifyExperience({ description }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  }
});

test('bachelor-level degree alternatives do not impose a hard minimum', () => {
  for (const degree of ["Bachelor's", 'bachelor', 'B.Tech', 'B.E.', 'BE', 'B.S.', 'BS', 'B.Sc', 'undergraduate', 'graduate']) {
    assert.equal(extractExperienceYears(`${degree} degree in CS or 4 years of experience`), null, degree);
  }
});

test('advanced and unspecified degree alternatives retain the experience minimum', () => {
  for (const degree of ["Master's", 'master', 'M.Tech', 'MS', 'M.S.', 'MBA', 'PhD', 'doctorate', 'a']) {
    assert.equal(extractExperienceYears(`${degree} degree or 5+ years required`)?.minYears, 5, degree);
  }
  for (const description of [
    "Bachelor's or Master's degree or 5+ years of experience required",
    'B.S. or M.S. degree or 5+ years required',
    "Bachelor's degree or 5+ years of experience with M.S. required",
    "Bachelor's degree or 5+ years required, master's preferred",
    'A degree, or equivalent 4 years experience.',
    'Required: a degree or 4 years of software development experience.',
  ]) assert.equal(extractExperienceYears(description)?.minYears, description.includes('5+') ? 5 : 4, description);
});
