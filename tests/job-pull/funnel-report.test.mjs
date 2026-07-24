import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../job-pull/config.mjs';
import { candidateDedupKey, normalizeCandidate } from '../../job-pull/candidate.mjs';
import { classifyCandidate } from '../../job-pull/eligibility.mjs';
import { annotateFreshness } from '../../job-pull/freshness.mjs';
import { runPipeline } from '../../job-pull/run.mjs';
import {
  assignFirstFailure,
  buildFunnelReport,
  formatFunnelNarrative,
} from '../../job-pull/funnel-report.mjs';

const config = loadConfig();
const now = '2026-07-24T12:00:00.000Z';

function base(index, overrides = {}) {
  return normalizeCandidate({
    url: `https://jobs.example.test/${index}`,
    source: 'greenhouse-full',
    sourceKind: 'ats-direct',
    provider: 'greenhouse',
    id: String(index),
    company: `Company ${index}`,
    title: 'AI Engineer',
    location: 'Pune',
    postedAt: '2026-07-24T08:00:00.000Z',
    employment: { type: 'full-time' },
    experience: { minYears: 0, maxYears: 1, evidence: '0-1 years' },
    liveness: { status: 'Active', evidence: 'fixture' },
    ...overrides,
  });
}

function classified(candidate, { suppression = null, selected = false, historicalSuppressed = false } = {}) {
  const freshness = annotateFreshness(candidate, {
    now,
    hotMaximumHours: config.freshness.hotMaximumHours,
    activeMaximumDays: config.freshness.activeMaximumDays,
    backfillMaximumDays: config.freshness.backfillMaximumDays,
  }).freshness;
  const eligibility = classifyCandidate(candidate, { ...config, salaryFloorLpa: null });
  return {
    candidate,
    freshness,
    eligibility,
    suppression,
    selected,
    historicalSuppressed,
    ready: selected,
  };
}

test('mutually exclusive first-failure counts sum exactly to normalized observations', () => {
  const observations = [
    classified(base(1, { location: 'Bangalore, India', workMode: 'onsite' })),
    classified(base(2, { title: 'Senior AI Engineer' })),
    classified(base(3, { experience: { minYears: 5, evidence: '5+ years' } })),
    classified(base(4, { employment: { type: 'internship', paid: false } })),
    classified(base(5, { postedAt: null })),
    classified(base(6, { postedAt: '2026-06-01T08:00:00.000Z' })),
    classified(base(7), { selected: true }),
    classified(base(8), {
      suppression: { suppressed: true, code: 'SUPPRESSED_COOLDOWN_7D' },
    }),
  ];
  const report = buildFunnelReport({ observations });
  assert.equal(report.reconciliation.normalized, observations.length);
  assert.equal(report.reconciliation.firstFailureTotal, observations.length);
  assert.equal(report.reconciliation.ok, true);
  assert.equal(report.firstFailures.geo, 1);
  assert.equal(report.firstFailures.title, 1);
  assert.equal(report.firstFailures.experience, 1);
  assert.equal(report.firstFailures.employment, 1);
  assert.equal(report.firstFailures.verifyQueue, 1);
  assert.equal(report.firstFailures.freshnessRejected, 1);
  assert.equal(report.firstFailures.selected, 1);
  assert.equal(report.firstFailures.suppressedCooldown, 1);
});

test('overlapping gate evidence is reported separately from first-failure totals', () => {
  // Fails geography first and also has a senior title — first-failure is geo only.
  const entry = classified(base(10, {
    location: 'Bangalore, India',
    workMode: 'onsite',
    title: 'Senior AI Engineer',
  }));
  const assignment = assignFirstFailure(entry);
  assert.equal(assignment.bucket, 'geo');
  assert.ok(assignment.alsoFailed.some((item) => item.bucket === 'title'));

  const report = buildFunnelReport({ observations: [entry] });
  assert.equal(report.firstFailures.geo, 1);
  assert.equal(report.firstFailures.title, 0);
  assert.equal(report.alsoFailed.byBucket.title, 1);
  assert.equal(report.alsoFailed.total, 1);
  assert.match(report.narrative, /Also failed \(overlapping evidence, not in first-failure totals\): title=1/);
  assert.match(report.narrative, /First-failure exits \(mutually exclusive, sum=1\): geo=1\./);
  assert.doesNotMatch(report.narrative, /First-failure exits[^\\n]*title=/);
});

test('Workday uncorroborated dates route to verification-queue funnel counts', () => {
  const workday = classified(base(20, {
    provider: 'workday',
    postedAt: '2026-07-24T08:00:00.000Z',
    evidence: { freshness: { kind: 'workday-postedOn' } },
  }));
  assert.equal(workday.freshness.window, 'VerifyQueue');
  assert.equal(workday.freshness.code, 'FRESHNESS_WORKDAY_UNCORROBORATED_VERIFY_QUEUE');
  assert.equal(workday.freshness.workdayUncorroborated, true);

  const report = buildFunnelReport({ observations: [workday] });
  assert.equal(report.firstFailures.verifyQueue, 1);
  assert.equal(report.lifecycle.workdayUncorroboratedVerifyQueue, 1);
  assert.equal(report.lifecycle.verifyQueue, 1);
  assert.equal(report.firstFailures.selected, 0);
  assert.match(report.narrative, /Workday uncorroborated 1/);
});

test('null salary floor rejects nothing; explicit floor still rejects below-floor roles', () => {
  const lowPay = {
    salary: { minimum: 600000, maximum: 700000, currency: 'INR', period: 'annual', evidence: '₹6-7 LPA' },
  };
  const withNullFloor = classifyCandidate(base(30, lowPay), { ...config, salaryFloorLpa: null });
  assert.equal(withNullFloor.salary.pass, true);
  assert.equal(withNullFloor.salary.code, 'SALARY_FLOOR_DISABLED');
  assert.equal(withNullFloor.eligible, true);

  const withExplicitFloor = classifyCandidate(base(31, lowPay), { ...config, salaryFloorLpa: 8 });
  assert.equal(withExplicitFloor.salary.pass, false);
  assert.equal(withExplicitFloor.salary.code, 'SALARY_BELOW_FLOOR');
  assert.equal(withExplicitFloor.eligible, false);
});

test('2026-07-24 regression: two stale survivors, four previously-observed backfills, zero cooldown', () => {
  // Six eligibility survivors as on the production day. Correct explanation:
  // 2 stale freshness rejects + 4 previously-observed backfill suppressions.
  // The prior report incorrectly claimed 7-day cooldown suppressions.
  const staleA = classified(base(100, {
    company: 'StaleCo A',
    postedAt: '2026-07-01T08:00:00.000Z',
  }));
  const staleB = classified(base(101, {
    company: 'StaleCo B',
    postedAt: '2026-07-02T08:00:00.000Z',
  }));
  const backfillRows = [102, 103, 104, 105].map((index) => classified(base(index, {
    company: `Backfill Co ${index}`,
    postedAt: '2026-07-14T08:00:00.000Z',
  }), {
    suppression: { suppressed: true, code: 'SUPPRESSED_BACKFILL_ALREADY_SEEN' },
  }));

  const survivors = [staleA, staleB, ...backfillRows];
  for (const entry of survivors) {
    assert.equal(entry.eligibility.eligible, true, entry.candidate.company);
  }
  assert.equal(staleA.freshness.window, 'Rejected');
  assert.equal(staleB.freshness.window, 'Rejected');
  for (const entry of backfillRows) {
    assert.equal(entry.freshness.window, 'Backfill');
    assert.equal(entry.freshness.backfill, true);
  }

  const report = buildFunnelReport({
    observations: survivors,
    lifecycle: {
      fetched: 6,
      sourceFiltered: 6,
      eligible: 6,
      suppressedCooldown: 0,
      suppressedBackfillAlreadySeen: 4,
      newlyActionable: null,
    },
  });

  assert.equal(report.firstFailures.freshnessRejected, 2);
  assert.equal(report.firstFailures.suppressedBackfillAlreadySeen, 4);
  assert.equal(report.firstFailures.suppressedCooldown, 0);
  assert.equal(report.lifecycle.suppressedCooldown, 0);
  assert.equal(report.lifecycle.suppressedBackfillAlreadySeen, 4);
  assert.equal(report.reconciliation.ok, true);
  assert.equal(report.reconciliation.firstFailureTotal, 6);

  const narrative = formatFunnelNarrative(report);
  assert.match(narrative, /cooldown suppressions 0/);
  assert.match(narrative, /previously-observed backfill suppressions 4/);
  assert.doesNotMatch(narrative, /cooldown suppressions [1-9]/);
  assert.equal(narrative, report.narrative);
});

test('runPipeline funnel distinguishes backfill-already-seen from cooldown and exposes Workday verify queue', () => {
  const backfillCandidate = base(201, {
    company: 'Backfill Seen',
    postedAt: '2026-07-14T08:00:00.000Z',
    url: 'https://jobs.example.test/backfill-seen',
    id: 'backfill-seen',
  });
  const candidates = [
    base(200, { company: 'Hot Co', postedAt: '2026-07-24T08:00:00.000Z' }),
    backfillCandidate,
    base(202, {
      company: 'Stale Seen',
      postedAt: '2026-07-01T08:00:00.000Z',
      url: 'https://jobs.example.test/stale',
      id: 'stale',
    }),
    base(203, {
      provider: 'workday',
      company: 'Workday Co',
      postedAt: '2026-07-24T08:00:00.000Z',
      url: 'https://company.myworkdayjobs.com/en-US/job/203',
      id: 'wd-203',
    }),
  ];
  const opportunityRows = [{
    dedup_key: candidateDedupKey(backfillCandidate),
    action_state: 'none',
    last_surfaced_at: '2026-07-16T12:00:00.000Z',
  }];
  const result = runPipeline({
    config,
    conversionPlan: { salaryFloorLpa: null, conversionScore: {
      weights: {
        responsibilitiesAndStack: 25, experienceEligibility: 20, indiaLocationEligibility: 15,
        projectConnection: 15, directOrVcSource: 10, humanContact: 10, postingFreshness: 5,
      },
      bands: { readyForManualReview: 75, manualInspect: 65 },
    } },
    now,
    runId: 'funnel-regression',
    opportunityLedgerRows: opportunityRows,
    sources: [{
      candidates,
      manifest: {
        sourceId: 'reverse-ats', kind: 'reverse-ats', errors: [],
        fetched: candidates.length, dated: 0, active: 0, notVerified: 0,
        eligible: 0, duplicate: 0, failed: 0, selected: 0,
      },
    }],
  });

  assert.ok(result.funnel);
  assert.equal(result.funnel.reconciliation.ok, true);
  assert.equal(result.funnel.reconciliation.firstFailureTotal, result.funnel.lifecycle.normalized);
  assert.equal(result.funnel.firstFailures.suppressedCooldown, 0);
  assert.equal(result.counts.suppressedByCode.SUPPRESSED_COOLDOWN_7D, 0);
  assert.equal(result.counts.suppressedByCode.SUPPRESSED_BACKFILL_ALREADY_SEEN, 1);
  assert.equal(result.funnel.firstFailures.suppressedBackfillAlreadySeen, 1);
  assert.equal(result.funnel.lifecycle.workdayUncorroboratedVerifyQueue, 1);
  assert.equal(result.counts.workdayUncorroboratedVerifyQueue, 1);
  assert.match(result.funnel.narrative, /cooldown suppressions 0/);
  assert.match(result.funnel.narrative, /Workday uncorroborated 1/);
});
