import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../job-pull/config.mjs';
import { candidateDedupKey, normalizeCandidate } from '../../job-pull/candidate.mjs';
import { classifyCandidate } from '../../job-pull/eligibility.mjs';
import { annotateFreshness } from '../../job-pull/freshness.mjs';
import { runPipeline } from '../../job-pull/run.mjs';
import { buildDailyReceipt } from '../../crawler/daily-receipt.mjs';
import { openCrawlerStore, crawlRun, finishCrawlRun, persistDailyReceipt } from '../../crawler/run.mjs';
import { renderLocalLeadReport } from '../../crawler/local-lead-report.mjs';
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

test('Workday list-evidence dates remain in the verification queue', () => {
  const workday = classified(base(20, {
    provider: 'workday',
    postedAt: '2026-07-24T08:00:00.000Z',
    evidence: { freshness: { kind: 'workday-unverified' } },
  }));
  assert.equal(workday.freshness.window, 'VerifyQueue');
  assert.equal(workday.freshness.code, 'FRESHNESS_WORKDAY_UNCORROBORATED_VERIFY_QUEUE');
  assert.equal(workday.freshness.workdayUncorroborated, true);

  const report = buildFunnelReport({ observations: [workday] });
  assert.equal(report.firstFailures.verifyQueue, 1);
  assert.equal(report.lifecycle.workdayUncorroboratedVerifyQueue, 1);
  assert.match(report.narrative, /Workday uncorroborated 1/);
});

test('a genuinely undated Workday row still routes to the verification queue', () => {
  // The guardrail that must survive the policy change: no date at all is still
  // no date. Only a bounded label became usable.
  const undated = classified(base(21, {
    provider: 'workday',
    postedAt: null,
    evidence: { freshness: { kind: 'workday-unverified' } },
  }));
  assert.equal(undated.freshness.window, 'VerifyQueue');
  assert.equal(undated.freshness.code, 'FRESHNESS_UNDATED_VERIFY_QUEUE');
  const report = buildFunnelReport({ observations: [undated] });
  assert.equal(report.lifecycle.verifyQueue, 1);
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

test('runPipeline funnel distinguishes backfill-already-seen from cooldown and exposes Workday verify queue', async () => {
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

  const repeated = base(220, { company: 'Same Identity', id: 'shared-220', url: 'https://jobs.example.test/shared-220' });
  const repeatedResult = runPipeline({
    config,
    now,
    runId: 'repeated-source-provenance',
    opportunityLedgerRows: [],
    sources: [
      { id: 'discovery-source', candidates: [repeated], manifest: { sourceId: 'discovery-source' } },
      { id: 'enrichment-source', candidates: [{ ...repeated, source: 'enrichment' }], manifest: { sourceId: 'enrichment-source' } },
    ],
  });
  const repeatedRow = repeatedResult.funnel.identityRows.find((row) => row.identity === `sha256:${createHash('sha256').update(candidateDedupKey(repeated)).digest('hex')}`);
  assert.equal(repeatedResult.funnel.lifecycle.normalized, 1);
  assert.deepEqual(repeatedRow.provenance.map((item) => item.sourceId).sort(), ['discovery-source', 'enrichment-source']);
  const repeatedReceipt = buildDailyReceipt({
    counts: { fetched: 2 }, funnel: repeatedResult.funnel,
    observations: [repeated, { ...repeated, source: 'enrichment', sourceId: 'enrichment-source' }], modes: {},
  });
  assert.equal(repeatedReceipt.scopes.uniqueRequisitions.count, 1);
  assert.equal(repeatedReceipt.scopes.historySuppression.count, 0);
  const mergedSources = ['first-source', 'second-source', 'third-source'].map((sourceId, index) => ({
    id: sourceId,
    candidates: [base(230 + index, {
      id: undefined, jobId: undefined, providerJobId: undefined, requisitionId: undefined,
      canonicalUrl: `https://jobs.example.test/distinct-${index}`,
      url: `https://jobs.example.test/distinct-${index}`,
      company: 'Merged Company', title: 'AI Engineer', location: 'Pune', source: sourceId,
    })],
    manifest: { sourceId },
  }));
  const mergedResult = runPipeline({ config, now, runId: 'deduped-source-provenance', opportunityLedgerRows: [], sources: mergedSources });
  const mergedRow = mergedResult.funnel.identityRows[0];
  assert.equal(mergedResult.funnel.lifecycle.normalized, 1);
  assert.equal(mergedResult.exclusionAudit.duplicate.some((row) => row.code === 'DEDUP_COMPANY_TITLE_LOCATION'), true);
  assert.deepEqual(mergedRow.provenance.map((item) => item.sourceId).sort(), ['first-source', 'second-source', 'third-source']);
  const ledgerCandidate = base(240, { id: 'ledger-240', url: 'https://jobs.example.test/ledger-240' });
  const secondLedgerCandidate = base(241, { id: 'ledger-241', url: 'https://jobs.example.test/ledger-241' });
  const ledgerSources = ['discovery-ledger', 'enrichment-ledger', 'mirror-ledger'].map((sourceId) => ({
    id: sourceId,
    candidates: [ledgerCandidate, secondLedgerCandidate].map((candidate) => ({ ...candidate, source: sourceId, sourceId })),
    manifest: { sourceId },
  }));
  const ledgerResult = runPipeline({
    config, now, runId: 'committed-ledger-suppression',
    ledgerRows: [ledgerCandidate, secondLedgerCandidate].map((candidate) => ({
      dedup_key: candidateDedupKey(candidate), state: 'committed', company: candidate.company,
    })),
    opportunityLedgerRows: [], sources: ledgerSources,
  });
  assert.equal(ledgerResult.counts.fetched, 6);
  assert.equal(ledgerResult.counts.deduped, 0);
  assert.equal(ledgerResult.funnel.lifecycle.normalized, 0);
  assert.equal(ledgerResult.funnel.identityRows.length, 0);
  assert.equal(ledgerResult.funnel.reconciliation.ok, true);
  assert.equal(ledgerResult.funnel.receiptLedgerSuppressions.length, 2);
  assert.ok(ledgerResult.funnel.receiptLedgerSuppressions.every((row) => row.code === 'DEDUP_EXISTING_LEDGER'));
  const ledgerModes = Object.fromEntries(['startup', 'normal', 'remote'].map((mode) => [mode, { results: [], shortlist: [] }]));
  const singleLedgerResult = runPipeline({
    config, now, runId: 'single-committed-ledger-suppression',
    ledgerRows: [{ dedup_key: candidateDedupKey(ledgerCandidate), state: 'committed', company: ledgerCandidate.company }],
    opportunityLedgerRows: [],
    sources: [{ id: 'single-source', candidates: [{ ...ledgerCandidate, sourceId: 'single-source' }], manifest: { sourceId: 'single-source' } }],
  });
  const singleLedgerReceipt = buildDailyReceipt({
    counts: { fetched: 1, selected: 0 }, funnel: singleLedgerResult.funnel,
    observations: [{ ...ledgerCandidate, sourceId: 'single-source' }], modes: ledgerModes,
  });
  assert.equal(singleLedgerReceipt.scopes.rawObservations.count, 1);
  assert.equal(singleLedgerReceipt.scopes.uniqueRequisitions.count, 1);
  assert.equal(singleLedgerReceipt.scopes.historySuppression.count, 1);
  assert.equal(singleLedgerReceipt.scopes.finalSelection.count, 0);
  const ledgerReceipt = buildDailyReceipt({
    runId: 'committed-ledger-suppression', counts: { fetched: 6, selected: 0 },
    funnel: ledgerResult.funnel, observations: ledgerSources.flatMap((source) => source.candidates), modes: ledgerModes,
  });
  assert.equal(ledgerReceipt.scopes.rawObservations.count, 6);
  assert.equal(ledgerReceipt.scopes.uniqueRequisitions.count, 2);
  assert.equal(ledgerReceipt.scopes.historySuppression.count, 2);
  assert.equal(ledgerReceipt.scopes.finalSelection.count, 0);
  assert.equal(ledgerReceipt.retained.identityRows.every((row) => row.reason === 'DEDUP_EXISTING_LEDGER' && !row.selected), true);
  for (const row of ledgerReceipt.retained.identityRows) {
    assert.deepEqual(row.provenance.map((item) => item.sourceId).sort(), ['discovery-ledger', 'enrichment-ledger', 'mirror-ledger']);
  }
  const database = path.join(mkdtempSync(path.join(tmpdir(), 'daily-source-provenance-')), 'crawler.sqlite');
  let store = openCrawlerStore(database);
  try {
    await crawlRun({ store, runId: 'source-provenance', sourcePlans: [] });
    finishCrawlRun(store, 'source-provenance', { telemetry: { workflow: { funnel: repeatedResult.funnel } } });
    const receipt = buildDailyReceipt({
      runId: 'source-provenance', runAt: now, counts: { fetched: 2 }, funnel: repeatedResult.funnel,
      observations: [], modes: {},
    });
    assert.equal(receipt.scopes.uniqueRequisitions.count, 1);
    assert.deepEqual(receipt.retained.identityRows[0].provenance.map((item) => item.sourceId).sort(), ['discovery-source', 'enrichment-source']);
    assert.equal(persistDailyReceipt(store, 'source-provenance', receipt), true);
    store.close();
    store = openCrawlerStore(database);
    const persisted = JSON.parse(store.prepare('SELECT telemetry_json FROM crawl_runs WHERE run_id = ?').get('source-provenance').telemetry_json);
    const report = renderLocalLeadReport({ dailyReceipt: persisted.workflow.dailyReceipt }, { now });
    assert.equal(persisted.workflow.dailyReceipt.scopes.uniqueRequisitions.count, 1);
    assert.deepEqual(persisted.workflow.dailyReceipt.retained.identityRows[0].provenance.map((item) => item.sourceId).sort(), ['discovery-source', 'enrichment-source']);
    assert.match(report, /discovery-source/);
    assert.match(report, /enrichment-source/);
    await crawlRun({ store, runId: 'committed-ledger-suppression', sourcePlans: [] });
    finishCrawlRun(store, 'committed-ledger-suppression', { telemetry: { workflow: { funnel: ledgerResult.funnel } } });
    assert.equal(persistDailyReceipt(store, 'committed-ledger-suppression', ledgerReceipt), true);
    store.close();
    store = openCrawlerStore(database);
    const ledgerPersisted = JSON.parse(store.prepare('SELECT telemetry_json FROM crawl_runs WHERE run_id = ?').get('committed-ledger-suppression').telemetry_json);
    assert.equal(ledgerPersisted.workflow.dailyReceipt.scopes.uniqueRequisitions.count, 2);
    assert.equal(ledgerPersisted.workflow.dailyReceipt.scopes.historySuppression.count, 2);
    assert.equal(ledgerPersisted.workflow.dailyReceipt.scopes.finalSelection.count, 0);
    assert.equal(ledgerPersisted.workflow.dailyReceipt.retained.identityRows.length, 2);
  } finally { store.close(); }
});

test('funnel reports freshness classes by provider and preserves global tallies', () => {
  const observations = [
    { candidate: { provider: 'greenhouse' }, freshness: { window: 'Hot' } },
    { candidate: { provider: 'greenhouse' }, freshness: { window: 'Active' } },
    { candidate: { provider: 'workday' }, freshness: { window: 'VerifyQueue', workdayUncorroborated: true } },
    { candidate: { provider: 'workday' }, freshness: { window: 'Rejected' } },
    { candidate: {}, freshness: { window: 'Backfill' } },
  ];
  const report = buildFunnelReport({ observations });

  assert.deepEqual(report.lifecycle.freshnessClassesByProvider, {
    greenhouse: { Hot: 1, Active: 1, Backfill: 0, VerifyQueue: 0, Rejected: 0, workdayUncorroborated: 0 },
    workday: { Hot: 0, Active: 0, Backfill: 0, VerifyQueue: 1, Rejected: 1, workdayUncorroborated: 1 },
    unknown: { Hot: 0, Active: 0, Backfill: 1, VerifyQueue: 0, Rejected: 0, workdayUncorroborated: 0 },
  });
  for (const key of Object.keys(report.lifecycle.freshnessClasses)) {
    const total = Object.values(report.lifecycle.freshnessClassesByProvider)
      .reduce((sum, classes) => sum + classes[key], 0);
    assert.equal(total, report.lifecycle.freshnessClasses[key], key);
  }
});

test('funnel counts distinct India hiring companies from eligible entries only', () => {
  const report = buildFunnelReport({ observations: [
    { candidate: { company: 'Acme Labs', location: 'Pune' }, eligibility: { eligible: true } },
    { candidate: { company: ' acme labs ', location: 'India' }, eligibility: { eligible: true } },
    { candidate: { company: 'India Only Ineligible', location: 'Bengaluru' }, eligibility: { eligible: false } },
    { candidate: { company: 'Foreign Co', location: 'London' }, eligibility: { eligible: true } },
  ] });

  assert.equal(report.lifecycle.indiaHiringCompanies, 1);
});

test('funnel report defaults new inputs without changing existing fields', () => {
  const report = buildFunnelReport({
    observations: [{
      candidate: { provider: 'greenhouse' },
      eligibility: { eligible: true },
      freshness: { window: 'Hot' },
      ready: true,
      selected: true,
    }],
  });
  const {
    freshnessClassesByProvider,
    indiaHiringCompanies,
    newlyDated,
    ...legacyLifecycle
  } = report.lifecycle;
  const { sourceHealth, identityRows, ...reportWithoutSourceHealth } = report;
  const legacyReport = { ...reportWithoutSourceHealth, lifecycle: legacyLifecycle };

  assert.equal(newlyDated, 0);
  assert.deepEqual(freshnessClassesByProvider, { greenhouse: {
    Hot: 1, Active: 0, Backfill: 0, VerifyQueue: 0, Rejected: 0, workdayUncorroborated: 0,
  } });
  assert.equal(indiaHiringCompanies, 0);
  assert.deepEqual(sourceHealth, {});
  assert.equal(identityRows.length, 1);
  assert.equal(identityRows[0].reason, 'SELECTED');
  assert.deepEqual(legacyReport, {
    schemaVersion: 'LaunchpadFunnelReportV1',
    lifecycle: {
      ...legacyLifecycle,
    },
    firstFailures: {
      geo: 0, title: 0, experience: 0, employment: 0, salary: 0, liveness: 0,
      verifyQueue: 0, freshnessRejected: 0, historicalSuppressed: 0,
      suppressedBackfillAlreadySeen: 0, suppressedCooldown: 0, suppressedActioned: 0,
      suppressedRejected: 0, notSelected: 0, selected: 1,
    },
    firstFailureCodes: { SELECTED: 1 },
    alsoFailed: {
      byBucket: {
        geo: 0, title: 0, experience: 0, employment: 0, salary: 0, liveness: 0,
        verifyQueue: 0, freshnessRejected: 0, historicalSuppressed: 0,
        suppressedBackfillAlreadySeen: 0, suppressedCooldown: 0, suppressedActioned: 0,
        suppressedRejected: 0, notSelected: 0, selected: 0,
      },
      byCode: {},
      total: 0,
    },
    reconciliation: { normalized: 1, firstFailureTotal: 1, ok: true, delta: 0 },
    narrative: 'Fetched 1 records; dated 0; source-filtered 1; normalized observations 1.\nEligible 1; verify-queue 0 (Workday uncorroborated 0); ready 1; selected 1.\nNewly actionable not yet tracked: 0.\nFirst-failure exits (mutually exclusive, sum=1): selected=1.\nAlso failed (overlapping evidence, not in first-failure totals): none.\nHistorical suppressions 0; cooldown suppressions 0; previously-observed backfill suppressions 0.\nReconciliation OK: first-failure total 1 equals normalized 1.',
  });
});

test('funnel report preserves natural exhaustion and truncation in source health', () => {
  const sourceHealth = {
    enterprise: {
      status: 'ok',
      naturalTerminal: true,
      truncated: false,
      capHit: null,
      recordsNotExamined: null,
      boards: [
        { board: 'Natural Board', provider: 'workday', status: 'ok', naturalTerminal: true, truncated: false, recordsNotExamined: null },
        { board: 'Truncated Board', provider: 'workday', status: 'ok', naturalTerminal: false, truncated: true, recordsNotExamined: 7 },
      ],
    },
  };
  const report = buildFunnelReport({ sourceHealth });

  assert.deepEqual(report.sourceHealth, sourceHealth);
  assert.equal(report.sourceHealth.enterprise.boards[0].naturalTerminal, true);
  assert.equal(report.sourceHealth.enterprise.boards[0].truncated, false);
  assert.equal(report.sourceHealth.enterprise.boards[1].naturalTerminal, false);
  assert.equal(report.sourceHealth.enterprise.boards[1].truncated, true);
  assert.equal(report.sourceHealth.enterprise.boards[1].recordsNotExamined, 7);
});

test('funnel reconciliation math remains exact for a fixed input', () => {
  const report = buildFunnelReport({ observations: [
    { eligibility: { geo: { pass: false, code: 'GEO_REJECTED' } }, freshness: { window: 'Hot' } },
    { candidate: base('receipt-1'), selected: true, freshness: { window: 'Active' } },
  ] });

  assert.deepEqual(report.reconciliation, {
    normalized: 2,
    firstFailureTotal: 2,
    ok: true,
    delta: 0,
  });
  assert.match(report.identityRows[1].identity, /^sha256:/);
  assert.equal(report.identityRows[1].bucket, 'selected');
  assert.equal(report.identityRows[1].reason, 'SELECTED');
});
