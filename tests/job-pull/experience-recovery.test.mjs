import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractExperienceRequirements, extractExperienceYears, normalizeCandidate } from '../../job-pull/candidate.mjs';
import { classifyExperience } from '../../job-pull/eligibility.mjs';
import { parseLinkedInJobDetail } from '../../job-pull/portal-adapters/linkedin.mjs';

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
  for (const [description, minimum] of [
    ['Our company has\n30 years of experience. Minimum 1 year of software experience required.', 1],
    ['<p>Our company has</p><p>30 years of experience.</p><p>Minimum 1 year of software experience required.</p>', 1],
    ['Our company has\n30 years of experience. Minimum 5 years of software experience required.', 5],
    ['<p>Our company has</p><p>30 years of experience.</p><p>Minimum 5 years of software experience required.</p>', 5],
  ]) assert.equal(extractExperienceYears(description)?.minYears, minimum, description);
  assert.equal(classifyExperience({ description: 'Our company has\n30 years of experience. Minimum 1 year of software experience required.' }, policy).code, 'EXPERIENCE_STRICT_0_1');
  assert.equal(classifyExperience({ description: 'Bachelor\'s degree in CS or\n4 years of software experience. Minimum 1 year overall experience required.' }, policy).code, 'EXPERIENCE_STRICT_0_1');
  assert.equal(classifyExperience({ description: 'Bachelor\'s degree in CS or\n4 years of software experience. Must have 5 years of AWS experience.' }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');

  const recoveredEvidence = 'Minimum 5 years of software experience required. Python preferred.';
  const sourceEvidenceCandidate = { title: 'AI Engineer', company: 'Synthetic Example', canonicalUrl: 'https://example.com/jobs/synthetic', description: 'Full-time Pune role.' };
  for (const scalarMinimum of [null, 0, 1, 2, 5]) {
    for (const candidate of [
      normalizeCandidate({ ...sourceEvidenceCandidate, experience: { minYears: scalarMinimum, evidence: recoveredEvidence } }),
      normalizeCandidate({ ...sourceEvidenceCandidate, minYears: scalarMinimum, experienceEvidence: recoveredEvidence }),
    ]) {
      assert.equal(candidate.experience.minYears, 5);
      assert.equal(candidate.experience.sourceMinYears, 5);
      assert.equal(classifyExperience(candidate, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
      assert.equal(classifyExperience(normalizeCandidate(candidate), policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
    }
  }
  const derivedPreference = normalizeCandidate({
    ...sourceEvidenceCandidate,
    experience: { minYears: 5, evidence: recoveredEvidence, sourceMinYears: null, sourceMaxYears: null },
  });
  assert.equal(derivedPreference.experience.sourceMinYears, null);
  assert.equal(classifyExperience(derivedPreference, policy).code, 'EXPERIENCE_NOT_STATED_MANUAL_REVIEW');

  const mismatchedTrack = {
    title: 'AI Engineer', company: 'Synthetic Example', canonicalUrl: 'https://example.com/jobs/synthetic',
    description: 'This opening is for the junior track. Entry-level track: 5 years experience. Senior track: 8 years experience.',
    experience: null,
  };
  for (const candidate of [mismatchedTrack, normalizeCandidate(mismatchedTrack), normalizeCandidate(normalizeCandidate(mismatchedTrack))]) {
    const decision = classifyExperience(candidate, policy);
    assert.equal(decision.code, 'EXPERIENCE_NOT_VERIFIED_CONFLICT');
    assert.equal(decision.pass, false);
    assert.equal(decision.verificationRequired, true);
    assert.equal(decision.selectedTrack, 'junior');
    assert.deepEqual([...new Set(decision.requirements.map((item) => item.track).filter(Boolean))], ['entry-level', 'senior']);
    assert.match(decision.evidence, /does not match stated requirement tracks/);
  }
});

test('explicit applicant experience strings preserve Unicode range bounds and eligibility', () => {
  for (const experience of ['2–5 years', '2—5 years', '2 to 5 years']) {
    const candidate = normalizeCandidate({ ...captured[0], experience });
    assert.equal(candidate.experience.minYears, 2);
    assert.equal(candidate.experience.maxYears, 5);
    assert.equal(classifyExperience(candidate, policy).code, 'EXPERIENCE_RELAXED_UP_TO_2');
  }
});

test('standalone role-tenure qualifications require a complete, mandatory, or approved example ending', () => {
  for (const description of [
    '5+ years in a customer-facing role.',
    'Five years in a similar position.',
    '3–5 years in a technical role.',
    '5+ years in a role is required.',
    '5+ years in a role are mandatory.',
    '5+ years in a technical customer-facing role (Solutions Engineering, Forward Deployed Engineering, Implementation Engineering, Technical Consulting, Technical PM, or similar).',
  ]) {
    const expected = description.startsWith('3') ? 3 : 5;
    const candidate = normalizeCandidate({ ...captured[0], description, experience: {} });
    assert.equal(candidate.experience.minYears, expected, description);
    assert.equal(classifyExperience(candidate, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS', description);
  }
  for (const description of [
    '- 5+ years in a customer-facing role.',
    '* [x] Five years in a similar position.',
    '<ul><li>3–5 years in a technical role</li></ul>',
  ]) assert.ok(extractExperienceYears(description), description);

  for (const description of [
    '5+ years in a similar role is strongly preferred.',
    '5+ years in a similar role is optional.',
    '5+ years in a similar role (optional).',
    '5+ years in a similar role is not a prerequisite.',
    '5+ years in a role, Python experience is not required.',
    '5+ years in a role with Python experience.',
    '5+ years in a role may be useful.',
    '5+ years in a role (preferred).',
    '5+ years in a role (Solutions Engineering, or preferred).',
  ]) assert.equal(extractExperienceYears(description), null, description);

  for (const description of [
    '5+ years in a customer-facing role\n(preferred, not required)',
    '5+ years in a customer-facing role\n(optional)',
    '5+ years in a customer-facing role\n(unclear qualification)',
    '<div>5+ years in a customer-facing role</div><div>(preferred, not required)</div>',
    '<p>5+ years in a customer-facing role</p><p>(preferred, not required)</p>',
    '<div>\n <section><p>5+ years in a customer-facing role</p></section> \n </div><div>\n <section><p>(preferred, not required)</p></section> \n </div>',
    '<ul><li>5+ years in a customer-facing role<br>(preferred, not required)</li></ul>',
    '5+ years in a customer-facing role\n(strongly preferred)',
    '5 years in a similar role\nis a nice to have.',
    '5 years in a similar role\nis not a prerequisite.',
    '5 years in a similar role\nextra context that does not mark a new item',
  ]) assert.equal(extractExperienceYears(description), null, description);
  assert.equal(extractExperienceYears('5+ years in a customer-facing role\n\n(preferred, not required)').minYears, 5);
  assert.equal(extractExperienceYears('<p>5 years in a similar role</p>\n\n<p>(preferred, not required)</p>'), null);
  assert.equal(extractExperienceYears('<ul><li><p>5 years in a similar role</p>\n\n<p>(preferred, not required)</p></li></ul>'), null);
  assert.equal(extractExperienceYears('<ul><li>5+ years in a customer-facing role<br>(preferred, not required)</li><li>3 years in a technical role</li></ul>').minYears, 3);
  assert.equal(extractExperienceYears('<ul><li>3+ years in a customer-facing role<br>(preferred, not required)</li><li>5 years in a technical role</li></ul>').minYears, 5);
  assert.equal(extractExperienceYears('<ul><li>5 years in a similar role<br>(optional)</li><li>3 years in a technical role.</li></ul>').minYears, 3);
  assert.equal(extractExperienceYears('<ul><li>3 years in a similar role<br>(optional)</li><li>5 years in a technical role.</li></ul>').minYears, 5);
  assert.equal(extractExperienceYears('<ul><li><p>5 years in a similar role</p><p>(preferred, not required)</p></li></ul>'), null);
  assert.equal(extractExperienceYears('<ul><li><p>5 years in a similar role</p><p>(preferred, not required)</p></li><li><p>3 years in a technical role.</p></li></ul>').minYears, 3);
  assert.equal(extractExperienceYears('<ul><li>5 years in a similar role<ul><li>preferred, not required</li></ul></li></ul>'), null);
  assert.equal(extractExperienceYears('<ul><li>5 years in a similar role<ul><li>preferred, not required</li></ul></li></ul><p>Minimum 2 years of Python experience required.</p>').minYears, 2);
  for (const description of [
    'Preferred qualifications:\n5+ years in a customer-facing role.',
    'Preferred qualifications include:\n5+ years in a customer-facing role.',
    'Preferred qualifications includes:\n5+ years in a customer-facing role.',
    '<h3>Preferred qualifications</h3><ul><li>5+ years in a customer-facing role.</li></ul>',
    '<h3><strong>Preferred qualifications include:</strong></h3><ul><li>5+ years in a customer-facing role.</li></ul>',
    '<h3><strong>Preferred qualifications includes:</strong></h3><ul><li>5+ years in a customer-facing role.</li></ul>',
  ]) assert.equal(extractExperienceYears(description), null, description);
  for (const heading of ['Optional qualifications:', 'Preferred Qualifications & Skills:']) {
    assert.equal(extractExperienceYears(`${heading}\n5 years in a similar role.`), null, heading);
    assert.equal(extractExperienceYears(`${heading}\n5 years in a similar role.\nRequired qualifications:\n3 years in a technical role.`).minYears, 3, heading);
  }
  assert.equal(extractExperienceYears('Qualifications (preferred):\n5 years in a similar role.'), null);
  for (const description of [
    'Preferred qualifications:\nQualifications:\nMust have 5 years AWS experience.',
    'Preferred qualifications:\n# Qualifications\nMust have 5 years AWS experience.',
    'Preferred qualifications:\n**Qualifications:**\nMust have 5 years AWS experience.',
    '<h3>Preferred qualifications</h3><h3>Qualifications</h3><p>Must have 5 years AWS experience.</p>',
    '<ul><li>Preferred qualifications</li><li>Qualifications:</li><li>Must have 5 years AWS experience.</li></ul>',
    'Junior track:\n0-1 years experience\nSenior track:\n6+ years experience\nQualifications:\nMust have 5 years AWS experience.',
    '<h3>Junior track</h3><p>0-1 years experience</p><h3>Senior track</h3><p>6+ years experience</p><h3>Qualifications</h3><p>Must have 5 years AWS experience.</p>',
  ]) {
    const parsed = extractExperienceRequirements(description).requirements;
    assert.ok(parsed.some((item) => item.minYears === 5 && item.track === null), description);
    if (/Senior track/.test(description)) assert.ok(parsed.some((item) => item.minYears === 6 && item.track === 'senior'), description);
    else assert.equal(extractExperienceYears(description)?.minYears, 5, description);
  }
  assert.equal(extractExperienceYears('Preferred qualifications:\n5 years backend experience.\nQualifications:\nMinimum 1 year overall experience required.')?.minYears, 1);
  assert.equal(extractExperienceYears('<h3>Skills and experience (optional)</h3><p>5 years in a similar role.</p>'), null);
  assert.equal(extractExperienceYears('Qualifications (preferred):\n5 years in a similar role.\nRequired qualifications:\n3 years in a technical role.').minYears, 3);
  assert.equal(extractExperienceYears('Strongly preferred:\n5+ years in a customer-facing role.'), null);
  assert.equal(extractExperienceYears('Strongly preferred:\n- 5+ years in a customer-facing role.'), null);
  assert.equal(extractExperienceYears('Preferred qualifications:\n- Basic Python knowledge\n- 5 years in a similar role.'), null);
  assert.equal(extractExperienceYears('Requirements:\n- AWS certification preferred\n- 5 years in a similar role.')?.minYears, 5);
  assert.equal(extractExperienceYears('Preferred qualifications:\nQualifications:\n5 years in a similar role.')?.minYears, 5);
  assert.equal(extractExperienceYears('Preferred qualifications:\nQualifications:\n5 years in a similar role.\nRequired qualifications:\n3 years in a technical role.')?.minYears, 5);
  for (const [description, expected] of [
    ['Optional requirements\n- 5 years in a similar role.', null],
    ['Preferred requirements\n- 5 years in a similar role.', null],
    ['Basic and preferred qualifications\n- 5 years in a similar role.', null],
    ['Preferred qualifications and skills and experience\n- 5 years in a similar role.', null],
    ['# Preferred qualifications\n- 5 years in a similar role.', null],
    ['- Preferred qualifications:\n- 5 years in a similar role.', null],
    ['- Strongly preferred:\n- 5 years in a similar role.', null],
    ['Preferred qualifications:\n- Basic skills\n- 5 years in a similar role.', null],
    ['Requirements:\n- Preferred skills\n- 5 years in a similar role.', 5],
    ['Requirements:\n- AWS certification preferred:\n- 5 years in a similar role.', 5],
    ['Preferred qualifications:\n# Required qualifications\n- 5 years in a similar role.', 5],
  ]) assert.equal(extractExperienceYears(description)?.minYears ?? null, expected, description);
  assert.equal(extractExperienceYears('You will spend\n5 years in a rotational position.'), null);
  assert.equal(extractExperienceYears('<p>You will spend</p><p>5 years in a rotational position.</p>'), null);
  assert.equal(extractExperienceYears('<p>You will spend<br>5 years in a rotational position.</p>'), null);
  assert.equal(extractExperienceYears('You will spend\n5 years in a rotational position\n- 3 years in a technical role.')?.minYears, 3);
  for (const heading of [
    '**Preferred qualifications:**',
    'Preferred',
    'Preferred qualifications include',
    'Strongly preferred:',
  ]) assert.equal(extractExperienceYears(`${heading}\n- 5 years in a similar role.`), null, heading);
  assert.equal(extractExperienceYears('Qualifications:\n5+ years in a customer-facing role.')?.minYears, 5);
  assert.equal(extractExperienceYears('Preferred qualifications:\n- Basic skills\n- 5 years in a similar role.'), null);
  assert.equal(extractExperienceYears('Requirements:\n- Preferred skills\n- 5 years in a similar role.')?.minYears, 5);
  assert.equal(extractExperienceYears('<h3>Required qualifications</h3><p>Python proficiency.</p><p>5 years in a similar role.</p>')?.minYears, 5);
  assert.equal(extractExperienceYears('Required qualifications:\nPython proficiency.\n5 years in a similar role.')?.minYears, 5);
  assert.equal(extractExperienceYears('Qualifications:\n**Python proficiency.**\n5 years in a similar role.')?.minYears, 5);
  assert.equal(extractExperienceYears('Qualifications:\n*Python proficiency.*\n5 years in a similar role.')?.minYears, 5);
  for (const [description, expected] of [
    ['5 years in a similar role\n(optional)\n- 3 years in a technical role.', 3],
    ['5 years in a similar role\n(preferred)\n- 3 years in a technical role.', 3],
    ['<p>5 years in a similar role</p><p>(optional)</p><ul><li>3 years in a technical role.</li></ul>', 3],
    ['<p>5 years in a similar role</p><p>(preferred)</p><ul><li>3 years in a technical role.</li></ul>', 3],
    ['- **Preferred qualifications**\n- 5 years in a similar role.', null],
    ['<ul><li><strong>Preferred qualifications</strong></li><li>5 years in a similar role.</li></ul>', null],
    ['<ul><li><b>Preferred qualifications</b></li><li>5 years in a similar role.</li></ul>', null],
    ['Preferred qualifications:\n- Requirements\n- 5 years in a similar role.', null],
    ['<h3>Preferred qualifications</h3><ul><li>Basic skills</li><li>5 years in a similar role.</li></ul>', null],
    ['Preferred qualifications:\n- Basic skills\n- 5 years in a similar role.', null],
    ['<h3>Requirements</h3><ul><li>Preferred skills</li><li>5 years in a similar role.</li></ul>', 5],
    ['Requirements:\n- Preferred skills\n- 5 years in a similar role.', 5],
    ['<ul><li><strong>5 years in a similar role</strong></li></ul>', 5],
    ['<ul><li><strong>5</strong> years in a similar role</li></ul>', 5],
    ['<ul><li><b>5 years in a similar role</b></li></ul>', 5],
    ['<ul><li><b>5</b> years in a similar role</li></ul>', 5],
    ['<ul><li>5 years in a similar role.</li></ul><p>Python proficiency.</p>', 5],
    ['<h3>Qualifications</h3><p>Python proficiency</p><p>5 years in a similar role.</p>', 5],
    ['Experience with our preferred cloud provider:\n- AWS\n- 5 years in a similar role.', 5],
    ['- 5 years in a similar role.', 5],
    ['- ~~5 years in a similar role.~~', null],
    ['<p>You will spend</p><p>5 years in a rotational position.</p>', null],
    ['<h3>Optional qualifications</h3><p>Python proficiency</p><p>5 years in a similar role.</p>', null],
    ['<h3>Requirements</h3><p>You will spend</p><p>5 years in a rotational position.</p>', null],
    ['<h3>Requirements</h3><p>Your role will require</p><p>5 years in a similar role.</p>', 5],
    ['<h3>Minimum qualifications</h3><p>You will spend</p><p>5 years in a rotational position.</p>', null],
    ['<h3>Minimum qualifications</h3><p>Candidates should have</p><p>5 years in a similar role.</p>', 5],
    ['<h3>Requirements</h3><p>Python proficiency.</p><p>5 years in a similar role.</p>', 5],
    ['<p>Python proficiency.</p><p>5 years in a similar role.</p>', 5],
    ['<h3>Minimum qualifications</h3><p>You will spend</p><p>5 years in a rotational position.</p><ul><li>3 years in a technical role.</li></ul>', 3],
  ]) assert.equal(extractExperienceYears(description)?.minYears ?? null, expected, description);
  for (const description of [
    '<h3>Requirements</h3><p>Python proficiency.</p><p>5 years in a similar role.</p>',
    '<p>Python proficiency.</p><p>5 years in a similar role.</p>',
  ]) assert.equal(classifyExperience({ description }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS', description);
  for (const description of [
    'Requirements: Candidates must have 5 years in a similar role.',
    'Requirements: You must have 5 years in a technical role.',
    'Required: You should have 5 years in a similar role.',
  ]) assert.equal(extractExperienceYears(description)?.minYears, 5, description);
  assert.equal(extractExperienceYears('You will spend 5 years in a rotational position.'), null);
  assert.equal(classifyExperience({ description: '<ul><li><p>5 years in a similar role.</p></li></ul>' }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.equal(classifyExperience({ description: 'Requirements: Candidates must have 5 years in a similar role.' }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.equal(classifyExperience({ description: '<h3>Qualifications</h3><p>Python proficiency</p><p>5 years in a similar role.</p>' }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.equal(extractExperienceYears('Qualifications:\nPython proficiency\n5 years in a similar role.'), null);
  assert.equal(classifyExperience({ description: '<ul><li><strong>5 years in a similar role</strong></li></ul>' }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  for (const [description, expected] of [
    ['You will spend\n**5 years in a rotational position.**', null],
    ['You will spend\n*5 years in a rotational position.*', null],
    ['- **5 years in a technical role.**', 5],
    ['You will spend\n<b>5 years in a rotational position.</b>', null],
    ['- **Required qualifications**\n- 5 years in a similar role.', 5],
    ['Preferred qualifications:\n- __Required qualifications__\n- 5 years in a similar role.', 5],
    ['Preferred qualifications:\n- __Preferred qualifications__\n- 5 years in a similar role.', null],
  ]) assert.equal(extractExperienceYears(description)?.minYears ?? null, expected, description);
  assert.equal(extractExperienceYears('Bachelor’s degree or\n5 years in a similar role.'), null);
  assert.equal(extractExperienceYears('Bachelor\'s degree in CS or\n4 years of software experience.'), null);
  assert.equal(extractExperienceYears('Bachelor\'s degree in CS or\n4 years of software experience. Minimum 1 year overall experience required.')?.minYears, 1);
  assert.equal(extractExperienceYears('Bachelor\'s degree in CS or\n4 years of software experience. Must have 5 years of AWS experience.')?.minYears, 5);
  assert.equal(extractExperienceYears('<h3>Qualifications</h3><p>Bachelor\'s degree or</p><p>5 years in a similar role.</p>'), null);
  assert.equal(extractExperienceYears('<p>Bachelor\'s degree in CS or</p><p>4 years of software experience.</p>'), null);
  assert.equal(extractExperienceYears('<p>Bachelor\'s degree in CS or</p><p>4 years of software experience.</p><p>Minimum 1 year overall experience required.</p>')?.minYears, 1);
  assert.equal(extractExperienceYears('<p>Bachelor\'s degree in CS or</p><p>4 years of software experience.</p><p>Must have 5 years of AWS experience.</p>')?.minYears, 5);
  assert.equal(extractExperienceYears('<h3>Qualifications</h3><p>Bachelor\'s degree or</p><p>5 years in a similar role.</p><ul><li>3 years in a technical role.</li></ul>').minYears, 3);
  assert.equal(extractExperienceYears('Bachelor\'s degree or\n- 3 years in a similar role.').minYears, 3);
  assert.equal(extractExperienceYears('<h3>Requirements</h3><p>Python proficiency</p><p>5 years in a similar role.</p>')?.minYears, 5);
  assert.equal(classifyExperience({ description: '<h3>Requirements</h3><p>Python proficiency</p><p>5 years in a similar role.</p>' }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.equal(extractExperienceYears('<h3>Qualifications</h3><p>Python proficiency</p><p>5 years in a similar role.</p>')?.minYears, 5);
  assert.equal(extractExperienceYears('Preferred qualifications:\n5+ years in a customer-facing role.\nRequired qualifications:\n3 years in a technical role.').minYears, 3);
  const preferredHeadingCase = extractExperienceYears('1 year in a technical role\nPreferred qualifications:\n5 years in a customer-facing role.');
  assert.equal(preferredHeadingCase.minYears, 1);
  assert.equal(classifyExperience({ experience: preferredHeadingCase }, policy).pass, true);
  assert.equal(extractExperienceYears('5 years in a similar role\nRequirements:\n1 year in a technical role.').minYears, 5);
  assert.equal(extractExperienceYears('5 years in a similar role\n3 years in a technical role.').minYears, 5);
  assert.equal(extractExperienceYears('**Preferred qualifications:**\n5+ years in a customer-facing role.\n# **Required qualifications:**\n3 years in a technical role.').minYears, 3);
  for (const heading of ['Preferred:', 'Preferred skills:', 'Nice to have:', 'Nice-to-have:']) {
    assert.equal(extractExperienceYears(`${heading}\n5+ years in a customer-facing role.`), null, heading);
    assert.equal(extractExperienceYears(`${heading}\n5+ years in a customer-facing role.\nRequirements:\n3 years in a technical role.`).minYears, 3, heading);
  }
  assert.equal(extractExperienceYears('<h3>Nice to have</h3><ul><li>5+ years in a customer-facing role.</li></ul><h3>Required qualifications</h3><ul><li>3 years in a technical role.</li></ul>').minYears, 3);
  assert.equal(extractExperienceYears('No prior experience required. You will be working remotely for at least three years in this position.').minYears, 3);
  assert.equal(extractExperienceYears('Minimum 3 years of Python experience required. You will spend five years in a rotational position.').minYears, 3);
  for (const sentence of [
    'You will spend five years in a rotational position.',
    'You must spend five years in a rotational position.',
    'You need to spend five years in a rotational position.',
    'You will have five years in a rotational position.',
    'You will bring five years in a customer-facing role.',
    'You will have five years in a customer-facing role.',
    'You will possess five years in a customer-facing role.',
    'You do not need five years in a similar position.',
    'You do not need to have five years in a similar position.',
  ]) assert.equal(extractExperienceYears(sentence), null, sentence);
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
  const hidden = 'Requirements: 7-10+ years building production backend systems; 5+ years hands-on with AWS. Junior team environment with mentoring responsibilities.';
  for (const minimum of [1, 2]) {
    for (const requirement of [
      'Requirements: 3-5 years of backend experience required.',
      'Requirements: 5+ years of backend experience required.',
      'Requirements: 6+ years of backend experience required.',
    ]) {
      const candidate = normalizeCandidate({ ...captured[0], description: requirement, experience: { minYears: minimum, maxYears: minimum, evidence: `${minimum} years from source` } });
      assert.equal(classifyExperience(candidate, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS', `${minimum} source years, ${requirement}`);
    }
    const candidate = normalizeCandidate({ ...captured[0], description: hidden, experience: { minYears: minimum, maxYears: minimum, evidence: `${minimum} years from source` } });
    const first = classifyExperience(candidate, policy);
    const repeated = classifyExperience(normalizeCandidate(candidate), policy);
    assert.equal(first.code, 'EXPERIENCE_HARD_MIN_3_PLUS');
    assert.equal(repeated.code, first.code);
    assert.match(first.evidence, /7-10\+ years building production backend systems/);
    assert.match(first.evidence, /5\+ years hands-on with AWS/);
    assert.equal(first.requirements.some((item) => item.minYears === 5), true);
  }
  const oneToTwo = normalizeCandidate({ ...captured[0], description: '1-2 years of backend development experience required.', experience: {} });
  assert.equal(classifyExperience(oneToTwo, policy).code, 'EXPERIENCE_STRICT_0_1');

  const preferred = normalizeCandidate({ ...captured[0], description: 'Preferred experience: 5+ years AWS preferred. Minimum 1 year overall experience.', experience: {} });
  const preferredResult = classifyExperience(preferred, policy);
  assert.equal(preferredResult.code, 'EXPERIENCE_STRICT_0_1');
  assert.deepEqual(preferredResult.requirements.map((item) => item.minYears), [1]);
  assert.equal(classifyExperience({ description: 'Preferred qualifications:\n5+ years in a customer-facing role.' }, policy).code, 'EXPERIENCE_NOT_STATED_MANUAL_REVIEW');
  for (const description of [
    'Preferred qualifications:\n5+ years of backend experience.\nMinimum 1 year overall experience.',
    '<h3>Preferred qualifications</h3><p>5+ years backend experience.</p><p>Minimum 1 year overall experience.</p>',
    '<ul><li>Preferred qualifications</li><li>5+ years backend experience</li></ul><p>Requirements</p><p>Minimum 1 year overall experience.</p>',
  ]) {
    const decision = classifyExperience({ description }, policy);
    assert.equal(decision.code, 'EXPERIENCE_STRICT_0_1', description);
    assert.deepEqual(decision.requirements.map((item) => item.minYears), [1]);
  }
  for (const description of [
    'Minimum 1 year overall experience.\nPreferred qualifications:\n5 years backend experience required.',
    '<p>Minimum 1 year overall experience.</p><h3>Preferred qualifications</h3><p>5 years backend experience required.</p>',
    '<ul><li>Minimum 1 year overall experience.</li><li>Preferred qualifications</li><li>5 years backend experience required.</li></ul>',
  ]) {
    const decision = classifyExperience({ description }, policy);
    assert.equal(decision.code, 'EXPERIENCE_HARD_MIN_3_PLUS', description);
    assert.equal(decision.requirements.some((item) => item.minYears === 5 && /required/.test(item.excerpt)), true, description);
  }
  const headedTracks = [
    'This opening is for the junior track.\nJunior track:\n0-1 years experience\nSenior track:\n6+ years experience',
    '<h3>This opening is for the junior track.</h3><h4>Junior track:</h4><p>0-1 years experience</p><h4>Senior track:</h4><p>6+ years experience</p>',
    '<ul><li>This opening is for the junior track.</li><li>Junior track:</li><li>0-1 years experience</li><li>Senior track:</li><li>6+ years experience</li></ul>',
  ];
  for (const description of headedTracks) {
    const decision = classifyExperience({ description, experience: { minYears: 1, maxYears: 1 } }, policy);
    assert.equal(decision.code, 'EXPERIENCE_STRICT_0_1', description);
    assert.equal(decision.selectedTrack, 'junior');
    const requirements = extractExperienceRequirements(description).requirements;
    assert.equal(requirements.find((item) => item.minYears === 6)?.track, 'senior');
    assert.equal(requirements.find((item) => item.minYears === 0)?.track, 'junior');
  }
  for (const description of [
    'This opening is for the junior track.\nJunior track:\n0-1 years experience\nSenior track:\n6+ years experience\nRequirements:\nAll candidates must have 5+ years of AWS experience.',
    '<h3>This opening is for the junior track.</h3><h4>Junior track:</h4><p>0-1 years experience</p><h4>Senior track:</h4><p>6+ years experience</p><h3>Requirements</h3><p>All candidates must have 5+ years of AWS experience.</p>',
  ]) assert.equal(classifyExperience({ description, experience: { minYears: 1, maxYears: 1 } }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS', description);
  const inlineUniversal = 'This opening is for the junior track. Junior track: 1 year experience; Senior track: 6 years experience, but all candidates must have 5 years of AWS experience.';
  const inlineUniversalRequirements = extractExperienceRequirements(inlineUniversal).requirements;
  assert.equal(inlineUniversalRequirements.find((item) => item.minYears === 5)?.track, null);
  assert.equal(classifyExperience({ description: inlineUniversal, experience: { minYears: 1, maxYears: 1 } }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  const universalAfterQuantity = 'This opening is for the junior track.\nJunior track:\n1 year experience\nSenior track:\n6 years experience\n5 years AWS experience required for all candidates.';
  const universalAfterRequirements = extractExperienceRequirements(universalAfterQuantity).requirements;
  assert.equal(universalAfterRequirements.find((item) => item.minYears === 6)?.track, 'senior');
  assert.equal(universalAfterRequirements.find((item) => item.minYears === 5)?.track, null);
  assert.equal(classifyExperience({ description: universalAfterQuantity, experience: { minYears: 1, maxYears: 1 } }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.equal(classifyExperience({ description: 'Preferred qualifications:\nAWS knowledge\nRequirements:\n5+ years of backend experience required.' }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.equal(classifyExperience({ description: 'Preferred qualifications:\n5 years in a similar role.\nPython experience required.' }, policy).code, 'EXPERIENCE_NOT_STATED_MANUAL_REVIEW');
  for (const description of [
    'Python preferred. 5+ years of backend experience required.',
    'Requirements: Python preferred. Must have 5+ years of backend experience.',
  ]) {
    assert.equal(classifyExperience({ description }, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS', description);
  }

  const alternative = 'Junior track requires 0-1 years experience. Senior track requires 6+ years experience.';
  const conditionalSelection = 'This opening is for the junior track or senior track depending on interview performance. Junior track: 1 year experience. Senior track: 6 years experience.';
  const conditionalDecision = classifyExperience({ description: conditionalSelection, experience: { minYears: 1, maxYears: 1 } }, policy);
  assert.equal(conditionalDecision.code, 'EXPERIENCE_NOT_VERIFIED_CONFLICT');
  assert.equal(conditionalDecision.selectedTrack, null);
  const conditionalAssignment = 'This opening is for the junior track if selected after interview. Junior track: 1 year experience. Senior track: 6 years experience.';
  const conditionalAssignmentDecision = classifyExperience({ description: conditionalAssignment, experience: { minYears: 1, maxYears: 1 } }, policy);
  assert.equal(conditionalAssignmentDecision.code, 'EXPERIENCE_NOT_VERIFIED_CONFLICT');
  assert.equal(conditionalAssignmentDecision.selectedTrack, null);
  const unresolvedDescription = '0-1 or 6+ depending on level; no assignment.';
  assert.equal(classifyExperience({ description: unresolvedDescription, experience: { minYears: 1, maxYears: 1 } }, policy).code, 'EXPERIENCE_NOT_VERIFIED_CONFLICT');
  const unresolved = normalizeCandidate({ ...captured[0], description: unresolvedDescription, experience: { minYears: 1, maxYears: 1, evidence: '1 year from source' } });
  assert.equal(classifyExperience(unresolved, policy).code, 'EXPERIENCE_NOT_VERIFIED_CONFLICT');
  const unresolvedAgain = classifyExperience(normalizeCandidate(unresolved), policy);
  assert.equal(unresolvedAgain.code, 'EXPERIENCE_NOT_VERIFIED_CONFLICT');
  assert.match(unresolvedAgain.evidence, /depending on level/);
  const negatedSelection = normalizeCandidate({ ...captured[0], description: alternative, experience: { minYears: 1, maxYears: 1, evidence: 'not selected as junior track' } });
  assert.equal(classifyExperience(negatedSelection, policy).code, 'EXPERIENCE_NOT_VERIFIED_CONFLICT');
  const hardRequirementAndConflict = normalizeCandidate({ ...captured[0], description: 'At least 3 years of backend experience is required. A junior applicant may have 0-1 or 6+ depending on level; no assignment.', experience: { minYears: 1, maxYears: 1, evidence: '1 year from source' } });
  assert.equal(classifyExperience(hardRequirementAndConflict, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  const structuredMinimumAndConflict = normalizeCandidate({ ...captured[0], description: 'Junior track: 1 year experience. Senior track: 6 years experience.', experience: { minYears: 5, maxYears: null, sourceMinYears: 5, sourceMaxYears: null, sourceMaxUnbounded: true, evidence: 'JobPosting.experienceRequirements.monthsOfExperience=60' } });
  const structuredConflictDecision = classifyExperience(structuredMinimumAndConflict, policy);
  assert.equal(structuredConflictDecision.code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.equal(structuredConflictDecision.minYears, 5);
  assert.equal(structuredConflictDecision.maxYears, null);
  assert.match(structuredConflictDecision.evidence, /monthsOfExperience=60/);

  const linkedInDescription = 'This opening is for the junior track. Junior track requires 0-1 years experience. Senior track requires 6+ years experience.';
  const linkedInUrl = 'https://www.linkedin.com/jobs/view/4473136187';
  const linkedInHtml = (experienceRequirements = undefined) => `<link rel="canonical" href="${linkedInUrl}"><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', identifier: { value: '4473136187' }, title: 'Software Engineer - NLP/LLM Reasoning', hiringOrganization: { name: 'woodfrog' }, description: linkedInDescription, ...(experienceRequirements ? { experienceRequirements } : {}) })}</script>`;
  const linkedInPatch = parseLinkedInJobDetail(linkedInHtml(), { requestedUrl: linkedInUrl, title: 'Software Engineer - NLP/LLM Reasoning', company: 'woodfrog' }).patch;
  const linkedInJunior = normalizeCandidate({ ...captured[0], ...linkedInPatch, experience: linkedInPatch.experience });
  assert.equal(linkedInJunior.experience.minYears, 6);
  assert.equal(linkedInJunior.experience.sourceMinYears, null);
  assert.equal(classifyExperience(linkedInJunior, policy).code, 'EXPERIENCE_STRICT_0_1');
  const linkedInStructuredPatch = parseLinkedInJobDetail(linkedInHtml({ monthsOfExperience: 60 }), { requestedUrl: linkedInUrl, title: 'Software Engineer - NLP/LLM Reasoning', company: 'woodfrog' }).patch;
  const linkedInStructured = normalizeCandidate({ ...captured[0], ...linkedInStructuredPatch, experience: linkedInStructuredPatch.experience });
  assert.equal(linkedInStructured.experience.minYears, 6);
  assert.equal(linkedInStructured.experience.sourceMinYears, 5);
  assert.equal(classifyExperience(linkedInStructured, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.equal(classifyExperience(linkedInStructured, policy).maxYears, null);

  const selected = normalizeCandidate({ ...captured[0], description: alternative, experience: { minYears: 1, maxYears: 1, evidence: '1 year from source; applicable track is junior' } });
  const result = classifyExperience(selected, policy);
  assert.equal(result.code, 'EXPERIENCE_STRICT_0_1');
  assert.equal(result.selectedTrack, 'junior');
  assert.equal(result.requirements.filter((item) => item.track === 'junior').every((item) => item.minYears < 3), true);
  const selectedWithoutSource = { title: 'AI Engineer', description: `This opening is for the junior track. ${alternative}`, experience: null };
  for (const candidate of [selectedWithoutSource, normalizeCandidate({ ...captured[0], ...selectedWithoutSource }), normalizeCandidate(normalizeCandidate({ ...captured[0], ...selectedWithoutSource }))]) {
    const decision = classifyExperience(candidate, policy);
    assert.equal(decision.code, 'EXPERIENCE_STRICT_0_1');
    assert.equal(decision.minYears, 0);
    assert.equal(decision.selectedTrack, 'junior');
  }
  const titleMinimum = normalizeCandidate({ ...captured[0], title: 'Python Developer - 5 years experience', description: 'Full-time Pune role.', experience: {} });
  const titleMinimumDecision = classifyExperience(titleMinimum, policy);
  assert.equal(titleMinimumDecision.code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.equal(titleMinimumDecision.requirements.some((item) => item.minYears === 5 && item.source === 'title' && /5 years experience/.test(item.excerpt)), true);
  assert.equal(titleMinimumDecision.requirements.find((item) => item.source === 'title')?.track, null);
  const universal = normalizeCandidate({ ...captured[0], description: `This opening is for the junior track. ${alternative} All candidates must have 5+ years of AWS experience.`, experience: { minYears: 1, maxYears: 1, evidence: '1 year source minimum' } });
  assert.equal(classifyExperience(universal, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  for (const description of [
    'This opening is for the junior track.\nJunior track: 0-1 years experience\nSenior track: 6+ years experience\nAll candidates must have 5+ years of AWS experience.',
    '<p>This opening is for the junior track.</p><ul><li>Junior track: 0-1 years experience</li><li>Senior track: 6+ years experience</li></ul><p>All candidates must have 5+ years of AWS experience.</p>',
    '<p>This opening is for the junior track.</p><p>Junior track: 0-1 years experience</p><p>Senior track: 6+ years experience</p><p>All candidates must have 5+ years of AWS experience.</p>',
  ]) {
    const resultForBoundary = classifyExperience(normalizeCandidate({ ...captured[0], description, experience: { minYears: 1, maxYears: 1, evidence: '1 year source minimum' } }), policy);
    assert.equal(resultForBoundary.code, 'EXPERIENCE_HARD_MIN_3_PLUS', description);
    assert.match(resultForBoundary.evidence, /All candidates must have 5\+ years of AWS experience/);
  }
  const stale = normalizeCandidate({ ...captured[0], description: 'Full-time AI role. Minimum 1 year of software experience required.', experience: { minYears: 1, maxYears: 1 } });
  stale.description = 'Full-time AI role. Minimum 6 years of software experience required.';
  assert.equal(classifyExperience(stale, policy).code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  const loneTrack = classifyExperience({ title: 'AI Engineer', description: 'Senior track requires 6+ years experience.', experience: { minYears: 1, maxYears: 1 } }, policy);
  assert.equal(loneTrack.code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.match(loneTrack.evidence, /Senior track requires 6\+ years experience/);
  const repeatedTrackRequirements = normalizeCandidate({ ...captured[0], description: 'Junior track requires 1 year of experience. Senior track requires 1 year of experience.', experience: null });
  assert.deepEqual(repeatedTrackRequirements.experience.requirements.requirements.map(({ track }) => track), ['junior', 'senior']);
  const scalarRange = normalizeCandidate({ ...captured[0], experience: { minYears: 1, maxYears: 2, evidence: '1-2 years from source' }, description: '' });
  assert.deepEqual([classifyExperience(scalarRange, policy).minYears, classifyExperience(scalarRange, policy).maxYears], [1, 2]);
  const onePlus = normalizeCandidate({ ...captured[0], description: 'Minimum 1+ years experience required.', experience: null });
  assert.equal(classifyExperience(onePlus, policy).minYears, 1);
  assert.equal(classifyExperience(onePlus, policy).maxYears, null);
});
