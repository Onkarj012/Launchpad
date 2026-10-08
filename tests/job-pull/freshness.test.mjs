import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFreshness } from '../../job-pull/freshness.mjs';

const now = '2026-07-14T12:00:00.000Z';

test('freshness classifies the exact 72h edge as Hot and just older as Active', () => {
  assert.equal(classifyFreshness('2026-07-11T12:00:00.000Z', { now }).window, 'Hot');
  assert.equal(classifyFreshness('2026-07-11T11:59:59.999Z', { now }).code, 'FRESHNESS_ACTIVE_3_7D');
});

test('freshness classifies the exact 7d edge as Active and just older as Backfill', () => {
  assert.equal(classifyFreshness('2026-07-07T12:00:00.000Z', { now }).window, 'Active');
  const backfill = classifyFreshness('2026-07-07T11:59:59.999Z', { now });
  assert.equal(backfill.window, 'Backfill');
  assert.equal(backfill.backfill, true);
});

test('freshness classifies the exact 14d edge as Backfill and just older as Rejected', () => {
  assert.equal(classifyFreshness('2026-06-30T12:00:00.000Z', { now }).window, 'Backfill');
  const rejected = classifyFreshness('2026-06-30T11:59:59.999Z', { now });
  assert.equal(rejected.window, 'Rejected');
  assert.equal(rejected.eligible, false);
  assert.equal(rejected.code, 'FRESHNESS_OLDER_THAN_14D');
});

test('undated and future records are not eligible for selection', () => {
  const undated = classifyFreshness(null, { now });
  assert.equal(undated.eligible, false);
  assert.equal(undated.window, 'VerifyQueue');
  assert.equal(undated.verifyQueue, true);
  assert.equal(undated.code, 'FRESHNESS_UNDATED_VERIFY_QUEUE');
  assert.equal(undated.evidence, 'Not Verified');
  assert.equal(classifyFreshness('2026-07-14T12:00:00.001Z', { now }).code, 'FRESHNESS_FUTURE_POSTED_AT');
});

test('Workday without verified startDate evidence remains in VerifyQueue', () => {
  const result = classifyFreshness({
    provider: 'workday',
    postedAt: '2026-07-14T08:00:00.000Z',
    evidence: { freshness: { kind: 'workday-unverified' } },
  }, { now });
  assert.equal(result.window, 'VerifyQueue');
  assert.equal(result.eligible, false);
  assert.equal(result.code, 'FRESHNESS_WORKDAY_UNCORROBORATED_VERIFY_QUEUE');
  assert.equal(result.verifyQueue, true);
  assert.equal(result.workdayUncorroborated, true);
});

test('Workday source provenance cannot masquerade as a non-Workday provider', () => {
  const result = classifyFreshness({
    provider: 'workday',
    postedAt: '2026-07-14T08:00:00.000Z',
    evidence: null,
  }, { now });
  assert.equal(result.window, 'VerifyQueue');
  assert.equal(result.code, 'FRESHNESS_WORKDAY_UNCORROBORATED_VERIFY_QUEUE');
  assert.equal(result.verifyQueue, true);
  assert.equal(result.workdayUncorroborated, true);
});

test('bounded Workday postedOn evidence remains in VerifyQueue without detail corroboration', () => {
  const result = classifyFreshness({
    provider: 'workday',
    postedAt: '2026-07-14T11:00:00.000Z',
    evidence: { freshness: { kind: 'workday-postedOn', label: 'Posted Today' } },
  }, { now });
  assert.equal(result.window, 'VerifyQueue');
  assert.equal(result.eligible, false);
  assert.equal(result.verifyQueue, true);
  assert.equal(result.workdayUncorroborated, true);
});

test('undated Workday rows with unverified evidence still route to VerifyQueue', () => {
  const result = classifyFreshness({
    provider: 'workday',
    postedAt: null,
    evidence: { freshness: { kind: 'workday-unverified' } },
  }, { now });
  assert.equal(result.window, 'VerifyQueue');
  assert.equal(result.code, 'FRESHNESS_UNDATED_VERIFY_QUEUE');
  assert.equal(result.verifyQueue, true);
});

test('detail-hydrated Workday rows with startDate evidence are classified by their date', () => {
  const result = classifyFreshness({
    provider: 'workday',
    postedAt: '2026-07-14T08:00:00.000Z',
    evidence: { freshness: { kind: 'workday-startDate', detailUrl: 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/job/Pune/Engineer_Pune' } },
  }, { now });
  assert.equal(result.window, 'Hot');
  assert.equal(result.eligible, true);
  assert.equal(result.code, 'FRESHNESS_HOT_0_72H');
  assert.equal(result.verifyQueue, undefined);
});

test('detail-hydrated Workday rows retain normal Active and Backfill age classes', () => {
  const active = classifyFreshness({
    provider: 'workday',
    postedAt: '2026-07-10T12:00:00.000Z',
    evidence: { freshness: { kind: 'workday-startDate' } },
  }, { now });
  const backfill = classifyFreshness({
    provider: 'workday',
    postedAt: '2026-07-06T12:00:00.000Z',
    evidence: { freshness: { kind: 'workday-startDate' } },
  }, { now });
  assert.equal(active.window, 'Active');
  assert.equal(backfill.window, 'Backfill');
  assert.equal(backfill.backfill, true);
});

test('Workday rows with an unbounded postedOn label stay undated in VerifyQueue', () => {
  const result = classifyFreshness({
    provider: 'workday',
    postedAt: null,
    evidence: { freshness: { kind: 'workday-postedOn-unbounded', label: 'Posted 30+ Days Ago' } },
  }, { now });
  assert.equal(result.window, 'VerifyQueue');
  assert.equal(result.code, 'FRESHNESS_UNDATED_VERIFY_QUEUE');
  assert.equal(result.verifyQueue, true);
});
