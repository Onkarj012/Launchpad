import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERNSHIP_SCHEMA_FIELDS, runInternshipLane } from '../../job-pull/internship-lane.mjs';
import { createFakeTransactionalGateway } from '../../job-pull/normal-transaction.mjs';
import { INTERNSHIP_NOW, internshipFixture, remoteInternshipFixture } from '../fixtures/internship-lane.mjs';

const noWrite = { planWrites: ({ operations }) => ({ operations }) };

test('classifies exact monthly stipend boundaries without mixing the full-time lane', async () => {
  const amounts = [24999, 25000, 29999, 30000];
  const result = await runInternshipLane({
    clock: () => INTERNSHIP_NOW,
    records: [
      ...amounts.map((amount, index) => internshipFixture(index, { stipend: { amount, currency: 'INR', period: 'month', raw: `INR ${amount}/month`, evidence: `fixture ${amount}` } })),
      internshipFixture(5, { title: 'Software Engineer', employment: { type: 'full-time', paid: true, evidence: 'full-time' } }),
    ],
    notionGateway: noWrite,
  });
  assert.deepEqual(result.shortlist.map((record) => record.stipend.tier), ['Preferred', 'Lower-Stipend', 'Lower-Stipend']);
  assert.equal(result.counts.preferred, 1);
  assert.equal(result.counts.lowerStipend, 2);
  assert.equal(result.counts.rejected, 2);
  assert.equal(result.buckets.rejection.STIPEND_BELOW_25000_INR_MONTHLY, 1);
  assert.equal(result.buckets.rejection.EMPLOYMENT_CATEGORY_NOT_INTERNSHIP, 1);
  assert.equal(result.shortlist.every((record) => record.employmentCategory === 'Internship'), true);
});

test('routes missing, ambiguous, unverified, and unsafe-period stipend evidence to verification', async () => {
  const result = await runInternshipLane({
    clock: () => INTERNSHIP_NOW,
    records: [
      internshipFixture(1, { stipend: null }),
      internshipFixture(2, { stipend: { minimum: 25000, maximum: 30000, currency: 'INR', period: 'month', raw: 'INR 25,000-30,000/month' } }),
      internshipFixture(3, { stipend: { amount: 30000, currency: 'INR', period: 'semester', raw: 'INR 30,000 per semester', evidence: 'ambiguous period' } }),
      internshipFixture(4, { stipend: { amount: 30000, currency: 'INR', period: 'month', verified: false, raw: 'not verified' } }),
    ],
    notionGateway: noWrite,
  });
  assert.equal(result.counts.needsVerification, 4);
  assert.equal(result.counts.ready, 0);
  assert.equal(result.buckets.verification.STIPEND_MISSING, 1);
  assert.equal(result.buckets.verification.STIPEND_AMBIGUOUS, 1);
  assert.equal(result.buckets.verification.STIPEND_PERIOD_NOT_SAFE_TO_CONVERT, 1);
  assert.equal(result.buckets.verification.STIPEND_UNVERIFIED, 1);
});

test('accepts Pune metro variants and rejects non-Pune onsite or hybrid internships', async () => {
  const locations = ['Pune, India', 'Pimpri-Chinchwad, Maharashtra', 'PCMC', 'Hinjawadi', 'Hinjewadi'];
  const result = await runInternshipLane({
    clock: () => INTERNSHIP_NOW,
    records: [
      ...locations.map((location, index) => internshipFixture(index, { location, workMode: index % 2 ? 'hybrid' : 'onsite' })),
      internshipFixture(20, { location: 'Bengaluru, India', workMode: 'onsite' }),
      internshipFixture(21, { location: 'Mumbai, India', workMode: 'hybrid' }),
    ],
    notionGateway: noWrite,
  });
  assert.equal(result.counts.ready, 5);
  assert.equal(result.buckets.rejection.ONSITE_HYBRID_NOT_PUNE_METRO, 2);
});

test('requires positive India evidence for global remote and distinguishes eligible, ineligible, and unknown', async () => {
  const result = await runInternshipLane({
    clock: () => INTERNSHIP_NOW,
    records: [
      remoteInternshipFixture(1),
      remoteInternshipFixture(2, { remoteEligibility: { status: 'Not Eligible', evidence: 'US work authorization only' } }),
      remoteInternshipFixture(3, { remoteEligibility: null }),
    ],
    notionGateway: noWrite,
  });
  assert.equal(result.counts.ready, 1);
  assert.equal(result.buckets.rejection.REMOTE_NOT_ELIGIBLE_FOR_INDIA, 1);
  assert.equal(result.buckets.verification.REMOTE_INDIA_ELIGIBILITY_NOT_VERIFIED, 1);
});

test('reuses original-employer, liveness, and fee or bond evidence gates', async () => {
  const result = await runInternshipLane({
    clock: () => INTERNSHIP_NOW,
    records: [
      internshipFixture(1, { sourceKind: 'aggregator', originalApplicationUrl: null }),
      internshipFixture(2, { liveness: { status: 'Not Verified', evidence: 'not checked' } }),
      internshipFixture(3, { liveness: { status: 'Expired', evidence: 'closed' } }),
      internshipFixture(4, { feeBondEvidence: 'training fee required' }),
      internshipFixture(6, { employment: { type: 'internship', paid: false, evidence: 'unpaid internship' } }),
      internshipFixture(5, { sourceKind: 'aggregator', originalApplicationUrl: 'https://company.example/apply/5', originalApplicationEvidence: 'employer ATS resolution' }),
    ],
    notionGateway: noWrite,
  });
  assert.equal(result.counts.ready, 1);
  assert.equal(result.counts.needsVerification, 2);
  assert.equal(result.counts.rejected, 3);
  assert.equal(result.buckets.verification.ORIGINAL_APPLICATION_URL_MISSING, 1);
  assert.equal(result.buckets.verification.LIVENESS_NOT_VERIFIED, 1);
  assert.equal(result.buckets.rejection.LIVENESS_EXPIRED, 1);
  assert.equal(result.buckets.rejection.FEES_OR_BOND_CONCERN, 1);
  assert.equal(result.buckets.rejection.EMPLOYMENT_UNPAID, 1);
});

test('preserves stipend, freshness, provenance, readiness, and maps the integrated v5 schema', async () => {
  const result = await runInternshipLane({ clock: () => INTERNSHIP_NOW, runId: 'issue04-payload', records: [internshipFixture(1)], notionGateway: noWrite });
  const operation = result.plannedNotionOperations[0];
  assert.equal(operation.lane, 'internship');
  assert.equal(operation.payload.employmentCategory, 'Internship');
  assert.equal(operation.payload.stipendAmount, 30000);
  assert.equal(operation.payload.stipendCurrency, 'INR');
  assert.equal(operation.payload.stipendPeriod, 'month');
  assert.equal(operation.payload.stipendRaw, 'INR 30,000/month');
  assert.equal(operation.payload.stipendEvidence, 'Stipend: INR 30,000/month');
  assert.equal(operation.payload.stipendTier, 'Preferred');
  assert.equal(operation.payload.freshness.tier, 'strict-0-24h');
  assert.equal(operation.payload.readiness.status, 'Ready');
  assert.equal(operation.payload.provenance.originalApplicationUrl, 'https://jobs.example.test/internship/1');
  assert.equal(operation.payload.schemaIntegrationRequired, false);
  assert.deepEqual(operation.payload.missingFields, []);
});

test('supports annual safe conversion while preserving original amount and period', async () => {
  const result = await runInternshipLane({
    clock: () => INTERNSHIP_NOW,
    records: [internshipFixture(1, { stipend: { amount: 360000, currency: 'INR', period: 'per annum', raw: 'INR 3,60,000 per annum', evidence: 'annual stipend' } })],
    notionGateway: noWrite,
  });
  const stipend = result.shortlist[0].stipend;
  assert.equal(stipend.amount, 360000);
  assert.equal(stipend.period, 'per annum');
  assert.equal(stipend.monthlyAmount, 30000);
  assert.equal(stipend.tier, 'Preferred');
});

test('executes only through the self-contained fake transactional gateway', async () => {
  const gateway = createFakeTransactionalGateway();
  const result = await runInternshipLane({ clock: () => INTERNSHIP_NOW, records: [internshipFixture(1)], notionGateway: gateway, executeGateway: true });
  assert.equal(result.transaction.status, 'committed');
  assert.deepEqual(gateway.events.map((event) => event.stage), ['reserve', 'write', 'verify', 'commit']);
  assert.equal(gateway.committed.size, 1);
  const second = await gateway.executeWrites({ operations: result.plannedNotionOperations });
  assert.equal(second.status, 'noop');
  await assert.rejects(() => runInternshipLane({ clock: () => INTERNSHIP_NOW, records: [internshipFixture(2)], notionGateway: noWrite, executeGateway: true }), /fake gateway/);
});
