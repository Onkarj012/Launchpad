import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateDedupKey, candidateMatchesLedgerRow, candidateRequisitionKey, companiesCompatible, companyTitleLocationKey, normalizeCandidate, normalizeRequisitionId } from '../../job-pull/candidate.mjs';

test('candidate normalization retains discovery, application, remote, and work-condition evidence', () => {
  const candidate = normalizeCandidate({
    url: 'https://boards.example.test/jobs/1?utm_source=search',
    originalApplicationUrl: 'https://jobs.example.test/openings/1?utm_source=search',
    company: 'Example', title: 'AI Engineer', location: 'Remote - India',
    postedAt: '2026-07-14T08:00:00.000Z', discoveredAt: '2026-07-14T09:00:00.000Z', crawledAt: '2026-07-14T09:05:00.000Z',
    remoteEligibility: { status: 'eligible', evidence: 'India' },
    salary: { min: 800000, max: 1200000, currency: 'INR', period: 'annual', evidence: '₹8–12 LPA' },
    timezoneOverlap: { hours: 4, evidence: 'IST overlap' }, eor: { available: true }, equipment: { available: false },
    sourceKind: 'aggregator', liveness: { status: 'Active' },
  });
  assert.equal(candidate.discoveredAt, '2026-07-14T09:00:00.000Z');
  assert.equal(candidate.crawledAt, '2026-07-14T09:05:00.000Z');
  assert.equal(candidate.originalApplicationUrl, 'https://jobs.example.test/openings/1');
  assert.equal(candidate.applicationResolution.status, 'Resolved Original');
  assert.equal(candidate.remoteEligibility.status, 'India Eligible');
  assert.equal(candidate.salary.minimum, 800000);
  assert.equal(candidate.timezoneOverlap.minimumHours, 4);
  assert.equal(candidate.eor.available, true);
  assert.equal(candidate.equipment.available, false);
});

test('durable identity prefers provider and requisition over company title location', () => {
  const first = normalizeCandidate({
    url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_R1',
    company: 'Acme', title: 'Software Engineer', location: 'Pune',
    postedAt: '2026-07-14T08:00:00.000Z', provider: 'workday', jobId: 'R1',
    employment: { type: 'full-time' }, liveness: { status: 'Active' },
  });
  const second = normalizeCandidate({
    url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/Engineer_R2',
    company: 'Acme', title: 'Software Engineer', location: 'Pune',
    postedAt: '2026-07-14T08:00:00.000Z', provider: 'workday', jobId: 'R2',
    employment: { type: 'full-time' }, liveness: { status: 'Active' },
  });
  assert.equal(companyTitleLocationKey(first), companyTitleLocationKey(second));
  assert.equal(candidateRequisitionKey(first), 'workday|r1');
  assert.notEqual(candidateDedupKey(first), candidateDedupKey(second));
});


test('candidate normalization retains stored first-seen separately from posting dates', () => {
  const raw = {
    url: 'https://jobs.example.test/1', company: 'Acme', title: 'AI Engineer', postedAt: '2026-10-15',
    first_seen_at: '2026-09-01T12:00:00.000Z', provider: 'greenhouse', providerJobId: 'REQ-42',
    identityAliases: ['naukri|portal-9'], originalPublicationDate: '2026-10-15',
    sourcePublicationDate: '2026-10-20T09:00:00+05:30', catalogFirstSeenAt: '2026-10-18T12:00:00Z',
    updatedAt: '2026-10-19T10:00:00Z', observedAt: '2026-10-20T09:05:00+05:30',
  };
  const candidate = normalizeCandidate(raw);
  assert.equal(candidate.firstSeenAt, raw.first_seen_at);
  assert.equal(candidate.jobId, 'REQ-42');
  assert.equal(candidateDedupKey(candidate), 'greenhouse|req 42');
  assert.deepEqual(candidate.identityAliases, ['naukri|portal-9']);
  assert.equal(candidate.postedAt, '2026-10-15');
  assert.equal(candidate.dateEvidence.originalPublication.value, '2026-10-15');
  assert.equal(candidate.dateEvidence.originalPublication.precision, 'date');
  assert.equal(candidate.dateEvidence.sourcePublication.value, '2026-10-20T09:00:00+05:30');
  assert.equal(candidate.dateEvidence.sourcePublication.timezone, '+05:30');
  assert.equal(candidate.dateEvidence.catalogFirstSeen.value, '2026-10-18T12:00:00Z');
  assert.equal(candidate.dateEvidence.updatedAt.value, '2026-10-19T10:00:00Z');
  assert.equal(candidate.dateEvidence.lastObservation.value, '2026-10-20T09:05:00+05:30');
  assert.deepEqual(candidate.dateEvidence.conflicts, ['originalPublication differs from sourcePublication']);
  const providerAndEmployerIds = normalizeCandidate({
    url: 'https://boards.greenhouse.io/acme/jobs/123', provider: 'greenhouse', jobId: '123', requisitionId: 'REQ-42',
    company: 'Acme', title: 'AI Engineer', postedAt: '2026-10-20',
  });
  assert.equal(providerAndEmployerIds.jobId, '123');
  assert.equal(providerAndEmployerIds.employerRequisitionId, 'REQ-42');
  assert.equal(candidateDedupKey(providerAndEmployerIds), 'greenhouse|123');
  const renormalizedIds = normalizeCandidate(providerAndEmployerIds);
  assert.equal(renormalizedIds.jobId, '123');
  assert.equal(renormalizedIds.employerRequisitionId, 'REQ-42');
  const refreshed = normalizeCandidate({ ...raw, originalPublicationDate: '2026-10-01', sourcePublicationDate: '2026-10-20T09:00:00Z', postedAt: '2026-10-20T09:00:00Z' });
  assert.equal(refreshed.postedAt, '2026-10-01');
  assert.equal(refreshed.dateEvidence.sourcePublication.value, '2026-10-20T09:00:00Z');
  const nestedOriginal = normalizeCandidate({
    url: 'https://boards.greenhouse.io/acme/jobs/123', company: 'Acme', title: 'AI Engineer', provider: 'greenhouse', jobId: '123',
    postedAt: '2026-10-20T08:00:00Z', dateEvidence: {
      originalPublication: { value: '2026-09-01', source: 'original-employer-detail', precision: 'date' },
      sourcePublication: { value: '2026-10-20T08:00:00Z', source: 'catalog' },
    },
  });
  assert.equal(nestedOriginal.postedAt, '2026-09-01');
  const unresolvedOriginal = normalizeCandidate({ ...nestedOriginal, postedAt: '2026-10-20T08:00:00Z', dateEvidence: { originalPublication: null } });
  assert.equal(unresolvedOriginal.postedAt, null);
  const numericPublication = normalizeCandidate({
    url: 'https://jobs.lever.co/acme/123', company: 'Acme', title: 'AI Engineer', provider: 'lever',
    firstPublished: 1792483200000,
  });
  assert.equal(numericPublication.postedAt, new Date(1792483200000).toISOString());
  assert.equal(numericPublication.dateEvidence.originalPublication.value, 1792483200000);
  const datePublication = normalizeCandidate({
    url: 'https://jobs.lever.co/acme/124', company: 'Acme', title: 'AI Engineer', provider: 'lever',
    firstPublished: new Date('2026-10-20T08:00:00Z'),
  });
  assert.equal(datePublication.postedAt, '2026-10-20T08:00:00.000Z');
  const ambiguousPublication = normalizeCandidate({
    url: 'https://jobs.lever.co/acme/125', company: 'Acme', title: 'AI Engineer', provider: 'lever',
    firstPublished: '2026-10-20 08:00:00',
  });
  assert.equal(ambiguousPublication.postedAt, null);
  assert.equal(ambiguousPublication.dateEvidence.originalPublication.value, '2026-10-20 08:00:00');
  for (const value of ['2026-02-30', '2025-02-29', '2026-02-30T08:00:00Z']) {
    const impossiblePublication = normalizeCandidate({
      url: 'https://jobs.lever.co/acme/126', company: 'Acme', title: 'AI Engineer', provider: 'lever',
      firstPublished: value,
    });
    assert.equal(impossiblePublication.postedAt, null, value);
    assert.equal(impossiblePublication.dateEvidence.originalPublication.value, value);
  }
  assert.equal(normalizeCandidate({ ...raw, postedAt: '2024-02-29', originalPublicationDate: '2024-02-29' }).postedAt, '2024-02-29');
  assert.equal(normalizeCandidate({ ...raw, postedAt: '2026-10-20T09:00:00+05:30', originalPublicationDate: '2026-10-20T09:00:00+05:30' }).postedAt, '2026-10-20T09:00:00+05:30');
  assert.doesNotThrow(() => normalizeCandidate({ ...raw, originalPublicationDate: 'yesterday' }));
  const differentReq = { provider: 'workday', jobId: 'R-2', identityAliases: ['workday|R-1'], company: 'Acme' };
  assert.equal(candidateMatchesLedgerRow(differentReq, { provider: 'workday', job_id: 'R-1', company: 'Acme' }), false);
  assert.throws(() => normalizeCandidate({ ...raw, firstSeenAt: 'yesterday' }), /firstSeenAt/);
});

test('Workday normalization accepts only requisition-shaped suffixes', () => {
  for (const [value, expected] of [
    ['Senior Engineer 2', 'Senior Engineer 2'],
    ['Software-Engineer_JR284401', 'JR284401'],
    ['Analyst_R-12345-1', 'R-12345'],
    ['Engineer_2026', 'Engineer_2026'],
    ['engineer 2026', 'engineer 2026'],
    ['software engineer jr284401', 'jr284401'],
    ['analyst r 12345 1', 'r 12345'],
    ['JR284401', 'JR284401'], ['R-12345', 'R-12345'],
    ['REQ1234', 'REQ1234'], ['R0012345', 'R0012345'],
    ['REQ1234 2', 'REQ1234'], ['12345-1', '12345'], ['12345 1', '12345'],
    ['Engineer_12345-2', '12345'], ['Engineer_R12', 'Engineer_R12'],
    ['Engineer_ABCDE12345', 'Engineer_ABCDE12345'],
  ]) {
    assert.equal(normalizeRequisitionId('workday', value), expected, value);
    assert.equal(normalizeRequisitionId('greenhouse', value), value, value);
  }
});

test('ledger identity matches require compatible company names', () => {
  const item = { provider: 'greenhouse', jobId: '123', company: 'Snowflake', identityAliases: ['naukri|portal 9'] };
  for (const company of ['Snowflake Inc.', 'Snowflake Technologies India Pvt. Ltd.', 'Snowflake Data', '', null]) {
    assert.equal(companiesCompatible(item.company, company), true, company);
    for (const row of [{ dedup_key: 'greenhouse|123', company }, { provider: 'greenhouse', job_id: '123', company }, { dedup_key: 'naukri|portal 9', company }]) {
      assert.equal(candidateMatchesLedgerRow(item, row), true);
    }
  }
  for (const row of [{ dedup_key: 'greenhouse|123', company: 'Globex' }, { provider: 'greenhouse', job_id: '123', company: 'Globex' }, { dedup_key: 'naukri|portal 9', company: 'Globex' }]) {
    assert.equal(candidateMatchesLedgerRow(item, row), false);
  }
  assert.equal(candidateMatchesLedgerRow({ ...item, company: null }, { dedup_key: 'greenhouse|123', company: 'Globex' }), true);
});
