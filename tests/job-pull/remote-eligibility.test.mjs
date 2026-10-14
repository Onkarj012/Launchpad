import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../job-pull/config.mjs';
import { classifyCandidate, classifyGeo } from '../../job-pull/eligibility.mjs';
import { classifyRemoteEligibility, enrichRemoteCandidate } from '../../job-pull/remote-enrichment.mjs';
import { selectRemoteApplications } from '../../job-pull/remote-selection.mjs';
import { runRemoteMode } from '../../job-pull/remote-mode.mjs';
import { scoredFixture, withManualFixtureScores } from '../fixtures/manual-scores.mjs';
import { REMOTE_NOW, remoteJob } from '../fixtures/remote-mode.mjs';

const policy = loadConfig();
const globalScopes = [
  { location: 'Worldwide' },
  { location: 'Remote - Worldwide' },
  { location: 'Anywhere' },
  { location: 'Global remote' },
  { location: 'Remote', description: 'Work remotely from anywhere. Full-time role. 0-1 years.' },
  { location: 'Remote', description: 'We hire candidates worldwide. Full-time remote role. 0-1 years.' },
  { location: 'Remote', description: 'Work remotely from anywhere in the world. Full-time role. 0-1 years.' },
];

// Build a scored remote fixture without borrowing India evidence from the default JD.
function candidate(overrides = {}) {
  const scored = scoredFixture(remoteJob(1, {
    workMode: 'remote',
    description: 'Build Python AI services. Full-time role. 0-1 years.',
    ...overrides,
  }), { runAt: REMOTE_NOW, source: 'fixture', provider: 'fixture', sourceKind: 'niche-public', sourceCategory: 'broad-remote' });
  return { ...scored, ...(overrides.remoteEvidence ? { remoteEvidence: overrides.remoteEvidence } : {}) };
}

test('standalone remote enrichment accepts shared unrestricted global scope and preserves eligible status', () => {
  for (const overrides of globalScopes) {
    const original = candidate(overrides);
    assert.equal(classifyGeo(original, policy).pass, true, JSON.stringify(overrides));
    const enriched = enrichRemoteCandidate(original);
    assert.equal(enriched.remoteReady, true, JSON.stringify(overrides));
    assert.equal(enriched.remoteEligibilityDecision.classification, 'worldwide');
    assert.equal(enriched.remoteEligibilityDecision.code, 'REMOTE_WORLDWIDE');
    assert.equal(enriched.remoteEligibility.status, 'India Eligible');
    assert.ok(enriched.remoteEligibility.evidence);
    assert.deepEqual(classifyCandidate(enriched, policy).labels, ['Remote: worldwide, no country limit']);
  }
});

test('global scope cannot bypass country, India-exclusion, provider or foreign authorization rejects', () => {
  for (const description of [
    'US only', 'Canada only', 'EU only', 'UK only', 'LATAM only',
    'Worldwide remote excluding India.', 'Worldwide remote except India.',
    'India is not supported for payroll.',
    'Candidates must be authorized to work in the US.',
    'Candidates need Canada work authorization.',
    'Foreign work authorization is required.',
    'Candidates must be based in Austria.',
    'Payroll is available only in Germany.',
    'We offer optional relocation assistance. US only.',
    'Candidates must hold German citizenship.',
    'Candidates must hold a German work permit.',
    'Payroll is only available in Switzerland.',
    'We cannot hire candidates without work authorization in the US.',
    'We will not be able to hire candidates without work authorization in the US.',
    'We cannot hire candidates without German citizenship.',
    'Candidates without a valid German work permit will not be considered.',
    'We are unable to hire candidates without a valid German work permit.',
    'Candidates without a valid German work permit will be rejected.',
    'Candidates without German work authorization can never be hired.',
    'Candidates without German citizenship are ineligible.',
    'Candidates without US citizenship will not be considered.',
    'Candidates must have a valid German work permit.',
    'Candidates must hold valid German citizenship.',
    'German residents only.',
    'Germany residents only.',
  ]) {
    const result = enrichRemoteCandidate(candidate({ location: 'Worldwide', description }));
    assert.equal(result.remoteReady, false, description);
    assert.equal(result.remoteEligibilityDecision.status, 'Not Eligible', description);
    assert.equal(result.remoteEligibility.status, 'Not Eligible', description);
  }
  for (const field of ['country', 'citizenship', 'workAuthorization', 'payroll']) {
    const result = enrichRemoteCandidate(candidate({ location: 'Worldwide', remoteEvidence: { [field]: 'US only' } }));
    assert.equal(result.remoteReady, false, field);
    assert.equal(result.remoteEligibilityDecision.code, 'REMOTE_COUNTRY_CITIZENSHIP_AUTH_PAYROLL_RESTRICTED', field);
  }
  const providerReject = classifyRemoteEligibility(candidate({ location: 'Worldwide', remoteEligibility: { status: 'Not Eligible', evidence: 'Provider excludes India' } }));
  assert.equal(providerReject.code, 'REMOTE_PROVIDER_MARKED_INELIGIBLE');
  for (const location of ['Remote - India', 'Remote - APAC']) {
    const result = enrichRemoteCandidate(candidate({ location, description: 'Candidates must be based in Austria. India teams collaborate globally.' }));
    assert.equal(result.remoteReady, false, location);
    assert.equal(result.remoteEligibilityDecision.status, 'Not Eligible', location);
  }
});

test('bare remote, company-global wording and region-qualified anywhere stay unready', () => {
  for (const overrides of [
    { location: 'Remote' },
    { location: 'Remote', description: 'We are a global software company. Full-time remote role.' },
    { location: 'Remote', description: 'Work remotely anywhere within Germany.' },
    { location: 'Remote', description: 'Work remotely anywhere within Europe.' },
    { location: 'USA Remote', description: 'Worldwide remote engineering role.' },
  ]) {
    assert.equal(enrichRemoteCandidate(candidate(overrides)).remoteReady, false, JSON.stringify(overrides));
  }
});

test('India, APAC and India-available EOR classifications retain their existing decisions', () => {
  for (const [location, classification] of [['Remote - India', 'india'], ['Remote - APAC', 'apac']]) {
    const result = enrichRemoteCandidate(candidate({ location }));
    assert.equal(result.remoteReady, true);
    assert.equal(result.remoteEligibilityDecision.classification, classification);
    assert.equal(result.remoteEligibility.status, 'India Eligible');
  }
  const eor = enrichRemoteCandidate(candidate({
    location: 'Remote - India',
    employment: { type: 'contract', evidence: 'Full-time contractor, ongoing, regular salary through India payroll' },
    eor: { available: true, evidence: 'Employer of Record available in India' },
  }));
  assert.equal(eor.remoteReady, true);
  assert.equal(eor.remoteEligibilityDecision.classification, 'stable-eor');
  const unproven = enrichRemoteCandidate(candidate({
    location: 'Worldwide', eor: { available: true, evidence: 'Employer of Record' },
  }));
  assert.equal(unproven.remoteReady, false);
  assert.equal(unproven.remoteEligibilityDecision.code, 'REMOTE_EOR_INDIA_AVAILABILITY_UNPROVEN');
});

test('remote selection admits enriched worldwide rows while retaining freshness and employment gates', () => {
  const eligible = enrichRemoteCandidate(candidate({ location: 'Worldwide' }));
  const entry = { candidate: eligible, eligibility: classifyCandidate(eligible, policy), freshness: { eligible: true, window: 'Hot', ageHours: 2 } };
  const selection = selectRemoteApplications([entry]);
  assert.equal(selection.selected.length, 1);
  assert.deepEqual(selection.eligibilityClasses, { worldwide: 1 });
  assert.equal(selection.selected[0].remoteEligibility.status, 'India Eligible');
  assert.equal(selectRemoteApplications([{ ...entry, freshness: { eligible: false, window: 'VerifyQueue', ageHours: null } }]).selected.length, 0);
  const gig = enrichRemoteCandidate(candidate({ location: 'Worldwide', description: 'Worldwide remote freelance per-task gig.' }));
  assert.equal(gig.remoteReady, false);
  assert.equal(selectRemoteApplications([{ ...entry, candidate: gig }]).selected.length, 0);
});

test('remote enrichment leaves Pune onsite geography under the shared gate', () => {
  for (const [location, pass] of [['Kharadi', true], ['Pune, Chakan', false], ['Bengaluru', false]]) {
    const original = candidate({ location, workMode: 'onsite' });
    const enriched = enrichRemoteCandidate(original);
    assert.deepEqual(classifyGeo(enriched, policy), classifyGeo(original, policy));
    assert.equal(classifyGeo(enriched, policy).pass, pass, location);
    assert.equal(enriched.remoteReady, false, location);
  }
});

test('standalone remote mode selects global fixture rows without India wording or external writes', async () => {
  const result = await runRemoteMode(withManualFixtureScores({
    clock: () => REMOTE_NOW, runId: 'standalone-global-eligibility', ledgerRows: [], opportunityLedgerRows: [],
    sourceFixtures: { himalayas: { records: globalScopes.map((overrides, index) => remoteJob(index + 1, {
      description: 'Build Python AI services. Full-time role. 0-1 years.', ...overrides,
    })) } },
  }));
  assert.equal(result.outcome.fatal, false);
  assert.equal(result.shortlist.length, globalScopes.length);
  assert.equal(result.transaction, null);
  for (const row of result.shortlist) {
    assert.equal(row.remoteEligibilityDecision.classification, 'worldwide');
    assert.equal(row.remoteReady, true);
    assert.deepEqual(row.eligibility.labels, ['Remote: worldwide, no country limit']);
  }
});

// Foreign authorization and country limits must block both shared and standalone worldwide paths.
test('worldwide cannot override Germany permits, citizenship or country limits', () => {
  for (const description of ['Candidates must have a work permit for Germany.', 'Germany only.', 'German citizenship required.', 'Candidates require work authorization in Japan.', 'Candidates must have German citizenship.', 'A German work permit is required.', 'Japan only.', 'Singapore only.', 'Mexico only.', 'Mexican citizenship required.', 'No relocation support and German citizenship required.', 'We offer local payroll only in Switzerland.', 'Candidates must be German citizens.', 'Candidates must be a German citizen.']) {
    const role = candidate({ location: 'Worldwide', description });
    assert.equal(classifyGeo(role, policy).pass, false, description);
    assert.equal(enrichRemoteCandidate(role).remoteReady, false, description);
  }
  assert.equal(enrichRemoteCandidate(candidate({ location: 'Worldwide', description: 'Indian citizenship required. Full-time remote role.' })).remoteReady, true);
});

// Refusing candidates without foreign documents is a mandatory authorization gate.
test('shared and standalone eligibility reject refusal clauses with foreign documents', () => {
  const descriptions = [
    'Only German citizens may apply.',
    'German citizenship is a mandatory requirement.',
    'Candidates must have permanent residency in Germany.',
    'We provide assistance with work authorization in Germany, which is mandatory for employment.',
    'Applicants without German citizenship will be unsuccessful.',
    'No applicants without US work authorization can be considered.',
    'No applicants without German citizenship can be considered.',
    'Candidates must possess German citizenship.',
    'German citizenship is mandatory.',
    'Candidates must be eligible to work in the U.S.',
    'No applicants without work authorization in the US will be considered.',
    'Work remotely anywhere within Germany.',
    'Remote anywhere within Germany. Work authorization in India is accepted.',
    'Applicants without work authorization in the US cannot be hired.',
    'We offer optional assistance with relocation, but work authorization in the U.S. is required.',
    'Applicants are required to hold German citizenship.',
    'Applicants without US citizenship need not apply.',
    'Candidates without German citizenship cannot apply.',
    'You cannot apply without US citizenship.',
    'We will not be able to hire candidates without work authorization in the US.',
    'We cannot hire candidates without German citizenship.',
    'Candidates without a valid German work permit will not be considered.',
    'We are unable to hire candidates without a valid German work permit.',
    'Candidates without a valid German work permit will be rejected.',
    'Candidates without German work authorization can never be hired.',
    'Candidates without German citizenship are ineligible.',
  ];
  for (const location of ['Worldwide', 'Remote - India']) {
    for (const description of descriptions) {
      const role = candidate({ location, description });
      assert.equal(classifyGeo(role, policy).pass, false, description);
      assert.equal(enrichRemoteCandidate(role).remoteReady, false, description);
    }
  }
});

// Positive provider flags cannot override retained foreign residency evidence.
test('positive remote eligibility does not bypass foreign residency restrictions', () => {
  for (const [location, description] of [
    ['Remote - India', 'Candidates must be based in Austria.'],
    ['Worldwide', 'Candidates must reside in Germany.'],
    ['Worldwide', 'Anywhere within Germany.'],
  ]) {
    const role = candidate({ location, description, remoteEligibility: { status: 'India Eligible', evidence: 'Provider scope' } });
    assert.equal(enrichRemoteCandidate(role).remoteReady, false, description);
  }
});

// Generic or negated paperwork is not proof of a foreign employment restriction.
test('worldwide and India listings retain unrestricted wording and negated requirements', () => {
  for (const location of ['Worldwide', 'Remote - India']) {
    for (const description of [
      'No citizenship required.',
      'No work permit for Germany is required.',
      'German citizenship is not required.',
      'A work permit for Germany is not required.',
      'Candidates do not need work authorization in Germany.',
      'Candidates must be citizens of India.',
      'Candidates must have a work permit in their country of residence.',
      'Candidates must have citizenship in India.',
      'Candidates must be eligible to work in Singapore or India.',
      'Full-time worldwide remote. We offer optional assistance with work authorization in Germany.',
      'Candidates must have legal work authorization in their country of residence.',
      'Candidates do not need to be eligible to work in Germany.',
      'Candidates must be eligible to work in Singapore, Japan or India.',
      'Candidates do not need work authorization in the US.',
      'We offer optional assistance with work authorization in the UK.',
      'Candidates must be authorized to work in the US or India.',
      'Candidates must be eligible to work in Singapore, Japan, or India.',
      'Candidates must be German citizens or Indian citizens.',
      'A work permit for Germany is optional.',
      'Candidates do not have to be eligible to work in Germany.',
      'Proof of citizenship is required.',
      'Being authorized to work in the US is optional.',
      'Being eligible to work in Singapore is optional.',
      'Candidates do not need to hold German citizenship.',
      'Candidates do not need to hold a German work permit.',
      'Candidates must be eligible to work in their country of residence.',
      'Work remotely from anywhere in the world, including India.',
      'We cannot hire candidates without work authorization in the US or India.',
      'We cannot hire candidates without German citizenship or Indian citizenship.',
      'Existing work authorization is required in your country of residence.',
      'Work authorization in Germany is preferred but not required.',
      'Applicants with work authorization in Germany are welcome, but it is not required.',
      'Candidates must have a work permit for Germany or a work permit for India.',
      'You cannot apply without US citizenship or Indian citizenship.',
      'Work authorization in Germany is preferred.',
      'Applicants are not required to hold German citizenship.',
      'Applicants are required to hold German citizenship or Indian citizenship.',
      'Full-time remote in India. Our platform is global in scope.',
      'Candidates must have a work permit for India or a work permit for Germany.',
      'We sponsor work authorization in Germany, but it is not required.',
      'German citizenship is not mandatory.',
      'Candidates do not need to possess German citizenship.',
      'Candidates must possess German citizenship or Indian citizenship.',
      'No applicants without US work authorization or Indian work authorization can be considered.',
      'Work authorization in Germany or Japan or India is required.',
      'Our employer is based in Germany. Build services for global customers.',
      'Candidates must have legal authorization in their country of residence.',
    ]) {
      const role = candidate({ location, description });
      assert.equal(classifyGeo(role, policy).pass, true, description);
      assert.equal(enrichRemoteCandidate(role).remoteReady, true, description);
    }
  }
  assert.equal(enrichRemoteCandidate(candidate({ location: 'Worldwide', remoteEvidence: { country: 'Singapore only' } })).remoteReady, false);
});
