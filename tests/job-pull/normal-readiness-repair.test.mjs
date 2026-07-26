import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { repairReadinessPool } from '../../job-pull/normal-readiness-repair.mjs';

const NOW = '2026-07-23T06:30:00.000Z';

function candidate(index, overrides = {}) {
  const normalized = normalizeCandidate({
    url: `https://jobs.example.test/${index}`,
    source: 'tracked-ats',
    sourceKind: 'ats-direct',
    provider: 'greenhouse',
    id: `req-${index}`,
    company: `Company ${index}`,
    title: 'AI Engineer',
    location: 'Pune, India',
    description: 'Build production AI systems with Python.',
    postedAt: NOW,
    employment: { type: 'full-time', evidence: 'full-time' },
    experience: { minYears: 0, maxYears: 1, evidence: '0-1 years' },
    liveness: { status: 'Active', checkedAt: NOW, evidence: 'employer page checked' },
    ...overrides,
  }, { runAt: NOW, source: 'tracked-ats', sourceKind: overrides.sourceKind || 'ats-direct', currentFeedIsLive: true });
  return {
    ...normalized,
    eligibility: overrides.eligibility || {
      eligible: true,
      strict: true,
      geo: { pass: true, code: 'GEO_PUNE_METRO', evidence: normalized.location },
      experience: { pass: true, strict: true, manualReview: false },
      reasons: [],
    },
    freshness: overrides.freshness || {
      eligible: true,
      window: 'Hot',
      ageHours: 0,
      code: 'FRESHNESS_HOT_0_72H',
    },
  };
}

test('every readiness rejection carries one or more named blockers', async () => {
  const unresolved = candidate(1, {
    sourceKind: 'aggregator',
    originalApplicationUrl: null,
    applicationResolution: { status: 'Unresolved', evidence: null },
    description: null,
    liveness: { status: 'Not Verified', evidence: null },
  });
  const result = await repairReadinessPool([unresolved], { maxRequests: 0, now: NOW });
  assert.equal(result.scorerPool.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.ok(result.rejected[0].blockers.length > 0);
  assert.ok(result.rejected[0].blockers.includes('JOB_DESCRIPTION_MISSING'));
  assert.ok(result.rejected[0].blockers.includes('ORIGINAL_APPLICATION_URL_MISSING'));
  assert.ok(result.rejected[0].blockers.every((blocker) => /^[A-Z][A-Z0-9_]+$/.test(blocker)));
});

test('the scorer pool contains no unrepairable readiness rows', async () => {
  const ready = candidate(2);
  const unresolved = candidate(3, {
    sourceKind: 'aggregator',
    originalApplicationUrl: null,
    applicationResolution: { status: 'Unresolved', evidence: null },
  });
  const result = await repairReadinessPool([unresolved, ready], { maxRequests: 0, now: NOW });
  assert.deepEqual(result.scorerPool.map((row) => row.canonicalUrl), [ready.canonicalUrl]);
  assert.equal(result.scorerPool.every((row) => row.readinessRepair.status === 'ready'), true);
  assert.equal(result.rejected.some((row) => row.canonicalUrl === unresolved.canonicalUrl), true);
});

test('a JD-absent direct role receives bounded hydration before burial', async () => {
  const thin = candidate(4, { description: null, id: null, jobId: null });
  const attempts = [];
  const result = await repairReadinessPool([thin], {
    maxRequests: 1,
    now: NOW,
    repairCandidate: async (row, context) => {
      attempts.push({ url: row.canonicalUrl, targets: context.targets });
      return {
        description: 'Hydrated employer JD for a Python AI engineering role.',
        jobId: 'REQ-4',
        repairEvidence: { source: 'employer-page-fixture', checkedAt: NOW },
      };
    },
  });
  assert.equal(attempts.length, 1);
  assert.ok(attempts[0].targets.includes('description'));
  assert.ok(attempts[0].targets.includes('requisitionId'));
  assert.equal(result.scorerPool.length, 1);
  assert.equal(result.scorerPool[0].description, 'Hydrated employer JD for a Python AI engineering role.');
  assert.equal(result.scorerPool[0].jobId, 'REQ-4');
  assert.equal(result.telemetry.attempted, 1);
});

test('readiness repair stops at the run deadline and queues remaining work', async () => {
  const first = candidate(5, { description: null });
  const second = candidate(6, { description: null });
  let calls = 0;
  const ticks = [1000, 1000, 1100, 1100];
  const result = await repairReadinessPool([first, second], {
    maxRequests: 2,
    now: NOW,
    deadlineAtMs: 1050,
    monotonicClock: () => ticks.shift() ?? 1100,
    repairCandidate: async () => {
      calls++;
      return { description: 'Hydrated before the deadline.' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.telemetry.deadlineExhausted, true);
  assert.equal(result.repairQueue.length, 1);
  assert.equal(result.repairQueue[0].queueReason, 'REPAIR_DEADLINE_EXHAUSTED');
});
