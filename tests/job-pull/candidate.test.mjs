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
  const raw = { url: 'https://jobs.example.test/1', company: 'Acme', title: 'AI Engineer', postedAt: null, first_seen_at: '2026-09-01T12:00:00.000Z' };
  const candidate = normalizeCandidate(raw);
  assert.equal(candidate.firstSeenAt, raw.first_seen_at);
  assert.equal(candidate.postedAt, null);
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
