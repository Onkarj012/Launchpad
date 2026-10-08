import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationReadiness } from '../../job-pull/normal-readiness.mjs';

function candidate(overrides = {}) {
  return {
    title: 'AI Engineer',
    description: 'Build Python AI services.',
    company: 'Ready Co',
    canonicalUrl: 'https://jobs.example.test/ready',
    originalApplicationUrl: 'https://jobs.example.test/ready/apply',
    applicationResolution: { status: 'Direct ATS' },
    sourceKind: 'ats-direct',
    liveness: { status: 'Active', evidence: 'fixture' },
    experience: { minYears: null, maxYears: null, evidence: null },
    employment: { type: 'full-time', paid: true, evidence: 'fixture' },
    ...overrides,
  };
}

test('daily readiness requires explicit accepted eligibility', () => {
  const result = applicationReadiness(candidate());
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ['POLICY_OR_EVIDENCE_INCOMPLETE']);
});

test('unstated experience manual review does not reject an otherwise eligible role', () => {
  const result = applicationReadiness(candidate(), {
    eligible: true,
    experience: { manualReview: true, code: 'EXPERIENCE_NOT_STATED_MANUAL_REVIEW' },
  });
  assert.equal(result.ready, true);
  assert.equal(result.reasons.length, 0);
  assert.equal(result.evidence.hardFailures.includes('EXPERIENCE_NOT_VERIFIED'), false);
});

test('other readiness failures remain hard failures', () => {
  const result = applicationReadiness(candidate({ liveness: { status: 'Expired' } }), { eligible: true });
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes('LIVENESS_EXPIRED'));
});

test('metadata-only direct postings stay in verification despite valid manual scores', () => {
  const result = applicationReadiness(candidate({ description: null, matchScore: 45, scoreOrigin: 'explicit-scored-input' }), { eligible: true });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ['JD_MISSING']);
});

test('unknown employment stays in verification despite unknown-experience manual review', () => {
  const result = applicationReadiness(candidate({ employment: { type: null, paid: null, evidence: null } }), {
    eligible: true, employment: { code: 'EMPLOYMENT_FULL_TIME_NOT_VERIFIED' }, experience: { manualReview: true },
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ['EMPLOYMENT_NOT_VERIFIED']);
});

test('direct ATS and cached resolution cannot claim an unnamed client as the employer', () => {
  for (const status of ['Direct ATS', 'Resolved Original']) {
    const result = applicationReadiness(candidate({ company: 'Leading Edge',
      description: 'Our client is looking for a talented Software Developer. Build Python services.',
      applicationResolution: { status, evidence: 'original-listing:employer-career-detail' },
    }), { eligible: true });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.includes('HIRING_EMPLOYER_NOT_VERIFIED'));
    assert.equal(result.evidence.resolution.employerIdentity.status, 'Not Verified');
  }
});

test('a direct employer describing software work for clients retains readiness', () => {
  for (const description of ['Join Ready Co. Build software for our clients and work with client teams.', 'You will be seeking technical solutions for our client.', 'Our client is looking for scalable technical solutions.']) {
    const result = applicationReadiness(candidate({ description }), { eligible: true });
    assert.equal(result.ready, true, description);
  }
});
