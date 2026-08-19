import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDailyReserve } from '../../crawler/reserve.mjs';

const base = (id, overrides = {}) => ({
  candidate: {
    canonicalUrl: `https://jobs.example.test/${id}`,
    company: `Company ${id}`,
    title: `AI Engineer ${id}`,
    postedAt: '2026-07-23T08:00:00.000Z',
    matchScore: 80,
    applicationReady: true,
    ...overrides.candidate,
  },
  eligibility: { eligible: true, strict: true, roleFamily: 'ai-llm-agentic', ...overrides.eligibility },
  freshness: { eligible: true, ageHours: 12, ...overrides.freshness },
  novelty: { newToMe: true, ...overrides.novelty },
});

const fullInventory = () => [
  ...Array.from({ length: 8 }, (_, i) => base(`strict-${i}`, { freshness: { eligible: true, ageHours: i + 1 } })),
  ...Array.from({ length: 3 }, (_, i) => base(`intern-${i}`, {
    candidate: { title: `Paid AI Intern ${i}`, employment: { type: 'internship', paid: true } },
    eligibility: { roleFamily: 'paid-internship' },
    freshness: { eligible: true, ageHours: 30 + i },
  })),
  ...Array.from({ length: 2 }, (_, i) => base(`reach-${i}`, {
    candidate: { title: `AI Engineer Reach ${i}` },
    eligibility: { strict: false, reach: true, reachMinimumYears: 2, exceptionalFit: true },
    freshness: { eligible: true, ageHours: 48 + i },
  })),
  ...Array.from({ length: 7 }, (_, i) => base(`backfill-${i}`, {
    freshness: { eligible: true, ageHours: 24 * 8 + i },
  })),
];

test('full inventory produces a 12–15-role durable reserve and a separate ten-role shortlist', () => {
  const result = selectDailyReserve(fullInventory(), { now: '2026-07-23T20:00:00.000Z' });

  assert.equal(result.reserve.length, 13);
  assert.equal(result.shortlist.length, 10);
  assert.equal(result.reserveQueue.length, 3);
  assert.equal(result.counts.minimum, 10);
  assert.equal(result.counts.preferred, 12);
  assert.equal(result.counts.maximum, 15);
  assert.equal(result.counts.newToMeWithin7Days, 13);
  assert.equal(result.composition.strictFullTime, 8);
  assert.equal(result.composition.paidInternshipOrFresher, 3);
  assert.equal(result.composition.controlledReaches, 2);
  assert.deepEqual(result.reserve.slice(0, 3).map((item) => item.freshnessTier), ['strict-0-24h', 'strict-0-24h', 'strict-0-24h']);
  assert.equal(result.shortfall.minimumMissing, 0);
  assert.equal(result.rescue.invoked, false);
});

test('shortfall is exact and does not manufacture a full reserve', () => {
  const result = selectDailyReserve(Array.from({ length: 4 }, (_, i) => base(`only-${i}`)));

  assert.equal(result.reserve.length, 4);
  assert.equal(result.shortlist.length, 4);
  assert.deepEqual(result.counts, {
    minimum: 10, preferred: 12, maximum: 15, reserve: 4, shortlist: 4,
    reserveQueue: 0, newToMeWithin7Days: 4, backfill: 0,
  });
  assert.equal(result.shortfall.minimumMissing, 6);
  assert.equal(result.shortfall.reservePreferredMissing, 8);
  assert.ok(result.shortfall.reasons.includes('MINIMUM_NEW_TO_ME_7D_SHORTFALL'));
  assert.ok(result.shortfall.reasons.includes('PREFERRED_RESERVE_SHORTFALL'));
});

test('stale and undated roles are suppressed even when they would fill the target', () => {
  const result = selectDailyReserve([
    base('fresh'),
    base('stale', { freshness: { eligible: false, ageHours: 336, window: 'Backfill' } }),
    base('undated', { freshness: { eligible: false, ageHours: null, window: null } }),
  ]);

  assert.deepEqual(result.reserve.map((item) => item.candidate.canonicalUrl), ['https://jobs.example.test/fresh']);
  assert.equal(result.excluded.stale, 1);
  assert.equal(result.excluded.undated, 1);
});

test('controlled reaches are capped at two and retain explicit reach facts', () => {
  const result = selectDailyReserve(Array.from({ length: 4 }, (_, i) => base(`reach-${i}`, {
    eligibility: { strict: false, reach: true, reachMinimumYears: 2, exceptionalFit: true },
  })));

  assert.equal(result.composition.controlledReaches, 2);
  assert.equal(result.reserve.length, 2);
  assert.equal(result.excluded.reachCap, 2);
});

test('controlled reaches keep the two strongest fits rather than the first two inputs', () => {
  const result = selectDailyReserve([
    base('reach-low', { candidate: { matchScore: 60 }, eligibility: { strict: false, reach: true, reachMinimumYears: 2, exceptionalFit: true } }),
    base('reach-mid', { candidate: { matchScore: 75 }, eligibility: { strict: false, reach: true, reachMinimumYears: 2, exceptionalFit: true } }),
    base('reach-best', { candidate: { matchScore: 95 }, eligibility: { strict: false, reach: true, reachMinimumYears: 2, exceptionalFit: true } }),
  ]);

  assert.deepEqual(result.reserve.map((item) => item.candidate.canonicalUrl), [
    'https://jobs.example.test/reach-best',
    'https://jobs.example.test/reach-mid',
  ]);
});

test('large strict inventory still preserves the preferred internship lane', () => {
  const result = selectDailyReserve([
    ...Array.from({ length: 20 }, (_, i) => base(`strict-overflow-${i}`, { candidate: { matchScore: 100 - i } })),
    ...Array.from({ length: 3 }, (_, i) => base(`intern-overflow-${i}`, {
      candidate: { employment: { type: 'internship', paid: true }, matchScore: 70 - i },
      eligibility: { roleFamily: 'paid-internship' },
    })),
  ]);

  assert.equal(result.reserve.length, 15);
  assert.equal(result.composition.paidInternshipOrFresher, 3);
  assert.equal(result.composition.strictFullTime, 12);
});

test('reserve queue supplies replacements in deterministic order without changing the shortlist', () => {
  const result = selectDailyReserve(Array.from({ length: 13 }, (_, i) => base(`replacement-${i}`, {
    candidate: { matchScore: 100 - i },
    freshness: { eligible: true, ageHours: i + 1 },
  })));

  assert.equal(result.shortlist.length, 10);
  assert.deepEqual(result.replacementOrder, result.reserveQueue);
  assert.equal(result.replacementOrder[0].candidate.canonicalUrl, 'https://jobs.example.test/replacement-10');
  assert.equal(result.reserve.length, 13);
});

test('shortfall never auto-rescues or invokes an injected rescue callback', () => {
  let calls = 0;
  const result = selectDailyReserve([], { rescue: () => { calls += 1; } });

  assert.equal(calls, 0);
  assert.deepEqual(result.rescue, { suggested: false, invoked: false });
  assert.equal(result.shortfall.minimumMissing, 10);
});
