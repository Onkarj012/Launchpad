import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crawlRun, openCrawlerStore, readCrawlerState, updateJobLifecycle } from '../../crawler/run.mjs';
import { crawlWorkflow } from '../../crawler/workflow.mjs';

function fixedClock(start = '2026-07-23T10:00:00.000Z') {
  let current = Date.parse(start);
  return {
    now: () => new Date(current).toISOString(),
    async sleep(milliseconds) { current += milliseconds; },
  };
}

function database() {
  return openCrawlerStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'launchpad-crawler-e2e-')), 'crawler.sqlite'));
}

function fixtureObservation(overrides = {}) {
  return {
    provider: 'fixture',
    providerJobId: overrides.providerJobId || overrides.company?.toLowerCase().replace(/\s+/g, '-') || 'fixture-1',
    canonicalUrl: 'https://jobs.example.test/fixture-1',
    company: 'Fixture Co',
    title: 'AI Engineer',
    location: 'Pune',
    description: 'Build AI systems.',
    postedAt: '2026-07-23T08:00:00.000Z',
    classification: 'direct',
    sourceKind: 'ats-direct',
    applicationReady: true,
    applicationResolution: { status: 'Resolved Original', evidence: 'fixture' },
    liveness: { status: 'Active', evidence: 'fixture' },
    ...overrides,
  };
}

async function runFixture({ runId, observation, prepareEntry, verificationQueue, historicalRows } = {}) {
  const store = database();
  const result = await crawlWorkflow({
    store,
    runId,
    clock: fixedClock(),
    sourcePlans: [{
      id: `fixture-${runId}`,
      lane: 'fixture',
      trustClass: 'direct',
      fetch: async () => ({ observations: [observation], verificationQueue }),
    }],
    prepareEntry,
    historicalRows,
  });
  store.close();
  return result;
}

const careerBody = `<html><script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting',
  title: 'AI Engineer',
  hiringOrganization: { name: 'Suppressed Co' },
  jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'IN' } },
  datePosted: '2026-07-23T08:00:00Z',
  description: 'Build AI systems.',
  url: 'https://suppressed.example/jobs/ai-engineer',
})}</script></html>`;

test('composes career, Brave, identity, incremental policy, reserve, and durable rerun state', async () => {
  const store = database();
  const clock = fixedClock();
  let careerCalls = 0;
  let braveCalls = 0;
  const sourcePlans = [];
  const priorJobs = [{
    jobKey: 'job-unchanged', provider: 'brave-search', providerJobId: null,
    canonicalUrl: 'https://jobs.example.com/unchanged', company: 'Existing Co',
    title: 'Backend Engineer', location: 'Pune',
    fingerprint: null, status: 'open',
  }];
  const priorLifecycleRows = [{
    canonicalUrl: 'https://suppressed.example/jobs/ai-engineer', state: 'applied',
  }];

  const result = await crawlWorkflow({
    store,
    runId: 'workflow-fixed-001',
    schedule: 'morning',
    clock,
    priorJobs,
    priorLifecycleRows,
    sourcePlans,
    careerSites: [{ company: 'Suppressed Co', websiteUrl: 'https://suppressed.example/' }],
    careerOptions: { hostLimiterOptions: { minSpacingMs: 0 }, retry: { maxAttempts: 1 } },
    careerTransport: async (url, options) => {
      careerCalls += 1;
      assert.ok(options.headers);
      if (url === 'https://suppressed.example/') return { status: 200, headers: { etag: '"career-v1"' }, body: careerBody };
      return { status: 200, headers: {}, body: '' };
    },
    brave: { queries: ['AI Engineer India fresher'] },
    braveOptions: {
      dailyBudget: 1,
      resolveOriginalListing: async (observation) => observation.company === 'Resolved Co'
        ? { url: 'https://jobs.lever.co/resolved/ai-engineer', company: 'Resolved Co' }
        : null,
    },
    braveTransport: async () => {
      braveCalls += 1;
      return { status: 200, body: { web: { results: [
        { url: 'https://linkedin.com/jobs/view/resolved', title: 'AI Engineer', profile: { name: 'Resolved Co' }, location: 'Pune', description: 'Build AI systems.' },
        { url: 'https://jobs.example.com/unchanged', title: 'Backend Engineer', profile: { name: 'Existing Co' }, location: 'Pune', description: 'Old description.' },
      ] } } };
    },
    prepareEntry: (candidate) => ({
      eligibility: { eligible: true, strict: true, roleFamily: 'ai-llm-agentic' },
      freshness: { eligible: true, ageHours: 2 },
      candidate: { ...candidate, applicationReady: candidate.applicationResolution?.status === 'Resolved Original' },
    }),
  });

  assert.equal(result.run.status, 'completed');
  assert.equal(result.stages.fetch.status, 'committed');
  assert.equal(result.stages.commit.status, 'committed');
  assert.equal(careerCalls > 0, true);
  assert.equal(braveCalls, 1);
  assert.equal(result.observations.length, 3);
  assert.ok(result.observations.some((row) => row._crawlerIdentity?.code === 'SUPPRESSED_APPLIED'));
  assert.ok(result.observations.some((row) => row._crawlerIdentity?.code === 'NEW_TO_ME' && row.applicationResolution?.status === 'Resolved Original'));
  assert.equal(result.observations.find((row) => row.company === 'Resolved Co').originalApplicationUrl,
    'https://jobs.lever.co/resolved/ai-engineer');
  assert.ok(result.observations.some((row) => row._crawlerIdentity?.code === 'UNCHANGED_DUPLICATE'));
  assert.equal(result.shortlist.length, 1);
  assert.equal(result.shortfall.minimumMissing, 9);
  assert.equal(result.plannedDownstreamHandoff.noAutoApply, true);
  assert.equal(result.plannedDownstreamHandoff.writesPlanned, false);
  assert.equal(readCrawlerState(store).observations.length, 3);

  const second = await crawlWorkflow({
    store,
    runId: 'workflow-fixed-001',
    clock: fixedClock(),
    priorJobs,
    priorLifecycleRows,
    careerSites: [{ company: 'Suppressed Co', websiteUrl: 'https://suppressed.example/' }],
    careerOptions: { hostLimiterOptions: { minSpacingMs: 0 }, retry: { maxAttempts: 1 } },
    careerTransport: async () => { throw new Error('idempotent rerun must not fetch career site'); },
    brave: { queries: ['AI Engineer India fresher'] },
    braveTransport: async () => { throw new Error('idempotent rerun must not query Brave'); },
    prepareEntry: (candidate) => ({
      eligibility: { eligible: true, strict: true, roleFamily: 'ai-llm-agentic' },
      freshness: { eligible: true, ageHours: 2 },
      candidate: { ...candidate, applicationReady: candidate.applicationResolution?.status === 'Resolved Original' },
    }),
  });

  assert.equal(second.idempotent, true);
  assert.deepEqual(second.observations, result.observations);
  assert.deepEqual(second.shortlist, result.shortlist);
  assert.deepEqual(second.shortfall, result.shortfall);
  assert.equal(careerCalls > 0, true);
  assert.equal(braveCalls, 1);
  store.close();
});

test('a new run automatically uses durable crawler history for novelty', async () => {
  const store = database();
  const observation = {
    provider: 'fixture',
    providerJobId: 'durable-1',
    canonicalUrl: 'https://jobs.example.test/durable-1',
    company: 'Durable Co',
    title: 'AI Engineer',
    location: 'Pune',
    description: 'Build durable AI systems.',
    postedAt: '2026-07-23T08:00:00.000Z',
    classification: 'direct',
    applicationReady: true,
    applicationResolution: { status: 'Resolved Original' },
  };
  const sourcePlan = () => ({
    id: 'durable-fixture',
    lane: 'ats-direct',
    trustClass: 'direct',
    fetch: async () => ({ observations: [observation] }),
  });
  const prepareEntry = (candidate) => ({
    candidate,
    eligibility: { eligible: true, strict: true },
    freshness: { eligible: true, ageHours: 2 },
  });

  const first = await crawlWorkflow({
    store,
    runId: 'durable-history-1',
    sourcePlans: [sourcePlan()],
    prepareEntry,
  });
  const second = await crawlWorkflow({
    store,
    runId: 'durable-history-2',
    sourcePlans: [sourcePlan()],
    prepareEntry,
  });

  assert.equal(first.observations[0]._crawlerIdentity.code, 'NEW_TO_ME');
  assert.equal(first.shortlist.length, 1);
  // Shortlist/reserve inclusion does not mutate SQLite lifecycle state.
  assert.equal(second.observations[0]._crawlerIdentity.code, 'UNCHANGED_DUPLICATE');
  assert.equal(second.shortlist.length, 0);
  assert.equal(second.jobs.length, 1);
  assert.notEqual(second.jobs[0].lifecycle, 'surfaced');
  assert.equal(second.jobs[0].lifecycleJson?.surfacedAt ?? null, null);
  store.close();
});

test('incomplete observation becoming application-ready surfaces once then cooldowns', async () => {
  const store = database();
  const incomplete = {
    provider: 'fixture',
    providerJobId: 'hydrate-1',
    canonicalUrl: 'https://jobs.example.test/hydrate-1',
    company: 'Hydrate Co',
    title: 'AI Engineer',
    location: 'Pune',
    description: 'Build AI systems.',
    postedAt: '2026-07-23T08:00:00.000Z',
    classification: 'direct',
    applicationReady: false,
    applicationResolution: { status: 'Unresolved' },
  };
  const ready = {
    ...incomplete,
    applicationReady: true,
    applicationResolution: { status: 'Resolved Original' },
  };
  const prepareEntry = (candidate) => ({
    candidate: { ...candidate, applicationReady: candidate.applicationReady === true },
    eligibility: { eligible: true, strict: true },
    freshness: { eligible: true, ageHours: 2 },
  });
  const sourcePlan = (observation) => ({
    id: 'hydrate-fixture',
    lane: 'ats-direct',
    trustClass: 'direct',
    fetch: async () => ({ observations: [observation] }),
  });

  const first = await crawlWorkflow({
    store,
    runId: 'hydrate-1',
    sourcePlans: [sourcePlan(incomplete)],
    prepareEntry,
  });
  assert.equal(first.shortlist.length, 0);
  assert.equal(first.observations[0]._crawlerIdentity.code, 'NEW_TO_ME');
  assert.equal(first.jobs[0].lifecycle, 'observed');

  const second = await crawlWorkflow({
    store,
    runId: 'hydrate-2',
    sourcePlans: [sourcePlan(ready)],
    prepareEntry,
  });
  assert.equal(second.observations[0]._crawlerIdentity.code, 'NEWLY_ACTIONABLE');
  assert.equal(second.shortlist.length, 1);
  assert.equal(second.counts.newlyActionable, 1);
  assert.equal(second.jobs[0].lifecycle, 'application-ready');

  const third = await crawlWorkflow({
    store,
    runId: 'hydrate-3',
    sourcePlans: [sourcePlan(ready)],
    prepareEntry,
  });
  assert.equal(third.observations[0]._crawlerIdentity.code, 'UNCHANGED_DUPLICATE');
  assert.equal(third.shortlist.length, 0);
  store.close();
});

test('workflow idempotent rerun does not double-surface or duplicate newly-actionable counts', async () => {
  const store = database();
  const observation = fixtureObservation({
    providerJobId: 'idempotent-surface',
    canonicalUrl: 'https://jobs.example.test/idempotent-surface',
    company: 'Idempotent Co',
  });
  const prepareEntry = (candidate) => ({
    candidate,
    eligibility: { eligible: true, strict: true },
    freshness: { eligible: true, ageHours: 2 },
  });
  const sourcePlans = [{
    id: 'idempotent-fixture',
    lane: 'fixture',
    trustClass: 'direct',
    fetch: async () => ({ observations: [observation] }),
  }];
  const first = await crawlWorkflow({ store, runId: 'idempotent-surface-1', sourcePlans, prepareEntry });
  const second = await crawlWorkflow({ store, runId: 'idempotent-surface-1', sourcePlans, prepareEntry });
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(first.shortlist.length, 1);
  assert.deepEqual(second.shortlist, first.shortlist);
  assert.equal(second.jobs[0].lifecycle, 'application-ready');
  assert.equal(second.jobs[0].lifecycleJson?.surfacedAt ?? null, null);
  assert.equal(Number(second.jobs[0].lifecycleJson?.timesSurfaced || 1), 1);
  store.close();
});

test('adds a verifiable reserve exclusion to verification without source self-reporting', async () => {
  const observation = fixtureObservation({
    canonicalUrl: 'https://jobs.example.test/unresolved-application',
    company: 'Needs Verification Co',
    applicationReady: false,
    applicationResolution: { status: 'Unresolved' },
  });
  const result = await runFixture({
    runId: 'verification-derived',
    observation,
    prepareEntry: (candidate) => ({
      candidate,
      eligibility: { eligible: true, strict: false, experience: { manualReview: true, code: 'EXPERIENCE_NOT_STATED_MANUAL_REVIEW' } },
      freshness: { eligible: true, ageHours: 2 },
    }),
  });

  assert.equal(result.verificationQueue.length, 1);
  assert.equal(result.verificationQueue[0].url, observation.canonicalUrl);
  assert.equal(result.verificationQueue[0].source, null);
  assert.ok(result.verificationQueue[0].reasons.includes('ORIGINAL_APPLICATION_NOT_RESOLVED'));
  assert.equal(result.verificationQueue[0].reasons.includes('EXPERIENCE_NOT_STATED_MANUAL_REVIEW'), false);
});

test('source VerifyQueue rows cannot enter the crawler shortlist', async () => {
  const observation = fixtureObservation({
    canonicalUrl: 'https://jobs.example.test/source-verify-queue',
    company: 'Verify Queue Co',
    applicationReady: true,
  });
  const result = await runFixture({
    runId: 'source-verify-queue',
    observation,
    verificationQueue: [{ url: observation.canonicalUrl, reason: 'freshness' }],
    prepareEntry: (candidate) => ({
      candidate: { ...candidate, applicationReady: true },
      eligibility: { eligible: true, strict: true },
      freshness: { eligible: true, ageHours: 2 },
    }),
  });

  assert.equal(result.shortlist.length, 0);
  assert.equal(result.verificationQueue.length, 1);
  assert.deepEqual(result.selectionInvariants, { selectedVerifyQueue: [] });
});

test('does not add a hard geography rejection to verification', async () => {
  const observation = fixtureObservation({
    canonicalUrl: 'https://jobs.example.test/foreign-role',
    company: 'Foreign Co',
    location: 'London',
    applicationReady: false,
    applicationResolution: { status: 'Unresolved' },
  });
  const result = await runFixture({
    runId: 'verification-hard-reject',
    observation,
    prepareEntry: (candidate) => ({
      candidate,
      eligibility: {
        eligible: false,
        reasons: ['GEO_ONSITE_NOT_PUNE', 'EXPERIENCE_NOT_STATED_MANUAL_REVIEW'],
        geo: { code: 'GEO_ONSITE_NOT_PUNE' },
        experience: { manualReview: true, code: 'EXPERIENCE_NOT_STATED_MANUAL_REVIEW' },
      },
      freshness: { eligible: true, ageHours: 2 },
    }),
  });

  assert.equal(result.verificationQueue.some((item) => item.url === observation.canonicalUrl), false);
  assert.equal(result.shortlist.length, 0);
  assert.equal(result.reserve.length, 0);
});

test('missing eligibility cannot become a shortlist fact after preparation', async () => {
  const result = await runFixture({
    runId: 'missing-eligibility',
    observation: fixtureObservation(),
    prepareEntry: (candidate) => ({
      candidate,
      freshness: { eligible: true, ageHours: 2 },
    }),
  });
  assert.equal(result.run.status, 'completed');
  assert.equal(result.observations.length, 1);
  assert.equal(result.shortlist.length, 0);
  assert.equal(result.reserve.length, 0);
  assert.equal(result.terminalEnvelope.rejectionCounts.ineligible, 1);
});

test('explicit unsupported source facts still fail the durable JSON boundary', async () => {
  const result = await runFixture({
    runId: 'explicit-undefined-fact',
    observation: fixtureObservation({ readiness: undefined }),
    prepareEntry: (candidate) => ({
      candidate,
      eligibility: { eligible: true, strict: true },
      freshness: { eligible: true, ageHours: 2 },
    }),
  });
  assert.equal(result.run.status, 'completed_with_failures');
  assert.equal(result.observations.length, 0);
  assert.equal(result.shortlist.length, 0);
  assert.match(result.failures[0].message, /readiness contains an unsupported undefined/);
});

test('moves an unresolved placeholder-company aggregator lead out of the primary queue', async () => {
  const observation = fixtureObservation({
    canonicalUrl: 'https://www.ycombinator.com/jobs/role/all/india',
    company: 'Unknown Company',
    title: 'Unresolved job lead',
    classification: 'lead',
    sourceKind: 'aggregator',
    applicationReady: false,
    applicationResolution: { status: 'Unresolved' },
  });
  const result = await runFixture({
    runId: 'placeholder-lead',
    observation,
    verificationQueue: [{ url: observation.canonicalUrl, company: observation.company, reason: 'original-listing' }],
    prepareEntry: (candidate) => ({
      candidate,
      eligibility: { eligible: true, strict: true },
      freshness: { eligible: true, ageHours: 2 },
    }),
  });

  assert.equal(result.verificationQueue.some((item) => item.url === observation.canonicalUrl), false);
  assert.equal(result.unresolvedLeads.some((item) => item.lowQuality === true && item.url === observation.canonicalUrl), true);
});

test('historical rows suppress a candidate before shortlist, reserve, and verification handoff', async () => {
  const observation = fixtureObservation({
    canonicalUrl: 'https://jobs.example.test/historical-role',
    company: 'Historical Co',
  });
  const result = await runFixture({
    runId: 'historical-suppression',
    observation,
    historicalRows: [{ company: observation.company, title: observation.title, location: observation.location, state: 'surfaced' }],
    prepareEntry: (candidate) => ({
      candidate,
      eligibility: { eligible: true, strict: true },
      freshness: { eligible: true, ageHours: 2 },
    }),
  });

  assert.equal(result.shortlist.length, 0);
  assert.equal(result.reserve.length, 0);
  assert.equal(result.plannedDownstreamHandoff.reserveQueue.length, 0);
  assert.equal(result.verificationQueue.length, 0);
  assert.equal(result.historicalSuppressions.length, 1);
  assert.equal(result.historicalSuppressions[0].code, 'SUPPRESSED_HISTORICAL');
  assert.equal(result.counts.historicalSuppressed, 1);
});

test('an explicit empty historicalRows list preserves the existing workflow result', async () => {
  const observation = fixtureObservation({
    canonicalUrl: 'https://jobs.example.test/default-history',
    company: 'Default History Co',
  });
  const prepareEntry = (candidate) => ({
    candidate,
    eligibility: { eligible: true, strict: true },
    freshness: { eligible: true, ageHours: 2 },
  });
  const withoutRows = await runFixture({ runId: 'history-default-a', observation, prepareEntry });
  const withEmptyRows = await runFixture({ runId: 'history-default-b', observation, prepareEntry, historicalRows: [] });

  assert.deepEqual(withEmptyRows.shortlist, withoutRows.shortlist);
  assert.deepEqual(withEmptyRows.reserve, withoutRows.reserve);
  assert.deepEqual(withEmptyRows.verificationQueue, withoutRows.verificationQueue);
  assert.deepEqual(withEmptyRows.shortfall, withoutRows.shortfall);
  assert.deepEqual(withEmptyRows.historicalSuppressions, withoutRows.historicalSuppressions);
  assert.deepEqual(withEmptyRows.counts, withoutRows.counts);
});

test('partial workflow reconstructs durable funnel state and labels source coverage', async () => {
  const store = database();
  const result = await crawlWorkflow({
    store,
    runId: 'workflow-partial-envelope',
    clock: fixedClock(),
    sourcePlans: [{
      id: 'enterprise-partial',
      lane: 'enterprise',
      trustClass: 'direct',
      fetch: async () => ({
        observations: [fixtureObservation({ providerJobId: 'partial-ready' })],
        cursor: { page: 1 },
        interrupted: true,
      }),
    }],
    prepareEntry: (candidate) => ({
      candidate: { ...candidate, applicationReady: true },
      eligibility: { eligible: true, strict: true },
      freshness: { eligible: true, ageHours: 2 },
    }),
  });
  assert.equal(result.terminalEnvelope.status, 'partial');
  assert.equal(result.terminalEnvelope.writesPlanned, false);
  assert.deepEqual(result.terminalEnvelope.sourceCoverage.interrupted, ['enterprise-partial']);
  assert.equal(result.terminalEnvelope.sourceCoverage.not_started.length, 0);
  assert.equal(result.terminalEnvelope.scorePendingReady.length, 1);
  assert.equal(result.observations.length, 1);
  store.close();
});

test('stored aliases preserve crawler history and first-seen across later portal observations', async () => {
  const store = database();
  try {
    const first = await crawlWorkflow({
      store, runId: 'stored-alias-first', clock: fixedClock('2026-07-01T10:00:00.000Z'),
      sourcePlans: [{ id: 'alias-fixture', lane: 'ats-direct', trustClass: 'direct', fetch: async () => ({ observations: [fixtureObservation({
        provider: 'greenhouse', providerJobId: '123', identityAliases: ['naukri|portal 9'], postedAt: null,
      })] }) }],
    });
    const jobKey = first.jobs[0].jobKey;
    updateJobLifecycle(store, jobKey, 'applied', { at: '2026-07-02T10:00:00.000Z' });
    const second = await crawlWorkflow({
      store, runId: 'stored-alias-second', clock: fixedClock(),
      sourcePlans: [{ id: 'alias-fixture', lane: 'ats-direct', trustClass: 'direct', fetch: async () => ({ observations: [fixtureObservation({
        provider: 'naukri', providerJobId: 'portal-9', canonicalUrl: 'https://portal.example.test/9', postedAt: null,
      })] }) }],
    });
    assert.equal(second.observations[0]._crawlerIdentity.code, 'SUPPRESSED_APPLIED');
    assert.equal(second.jobs.length, 1);
    assert.equal(second.jobs[0].jobKey, jobKey);
    assert.equal(second.observations[0].firstSeenAt, '2026-07-01T10:00:00.000Z');
    assert.equal(second.observations[0].postedAt, null);
    assert.deepEqual(second.jobs[0].identityAliases, ['naukri|portal 9']);
  } finally {
    store.close();
  }
});

function absenceJob(providerJobId, overrides = {}) {
  return {
    provider: 'greenhouse', providerJobId, canonicalUrl: `https://boards.example.test/fixture/${providerJobId}`,
    company: 'Fixture Co', title: `AI Engineer ${providerJobId}`, location: 'Pune, India', postedAt: '2026-10-19T00:00:00.000Z',
    classification: 'direct', sourceKind: 'ats-direct', ...overrides,
  };
}

function absenceSource(observations, manifest = {}) {
  return { id: 'absence-source', fetch: async () => ({ observations, manifest }) };
}

function jobRow(store, providerJobId) {
  return store.prepare('SELECT * FROM jobs WHERE provider_job_id = ?').get(providerJobId);
}

test('failed, truncated, or interrupted absence never closes a job seen in an earlier run', async () => {
  const scans = [
    { status: 'failed', manifest: { status: 'failed', errors: ['HTTP 503'] } },
    { status: 'truncated', manifest: { truncated: true } },
    { status: 'interrupted', manifest: { interrupted: true } },
  ];
  for (const scan of scans) {
    const store = database();
    try {
      await crawlRun({ store, runId: `${scan.status}-seen`, clock: fixedClock('2026-10-20T06:00:00.000Z'), sourcePlans: [absenceSource([absenceJob('kept')])] });
      const seen = jobRow(store, 'kept');
      const scanned = await crawlRun({ store, runId: `${scan.status}-absent`, clock: fixedClock('2026-10-21T06:00:00.000Z'), sourcePlans: [absenceSource([], scan.manifest)] });
      assert.equal(scanned.telemetry.sources['absence-source'].status, scan.status);
      assert.equal(jobRow(store, 'kept').closed_at, null, scan.status);
      assert.deepEqual(jobRow(store, 'kept'), seen, scan.status);
    } finally {
      store.close();
    }
  }
});

test('explicit employer closure sets closed_at while a transport failure does not', async () => {
  const store = database();
  try {
    await crawlRun({ store, runId: 'closure-seen', clock: fixedClock('2026-10-20T06:00:00.000Z'), sourcePlans: [absenceSource([
      absenceJob('closed-by-status'), absenceJob('closed-by-liveness'),
    ])] });
    await crawlRun({ store, runId: 'closure-transport-failure', clock: fixedClock('2026-10-21T06:00:00.000Z'), sourcePlans: [absenceSource([], { status: 'failed', errors: ['connection reset'] })] });
    assert.equal(jobRow(store, 'closed-by-status').closed_at, null, 'transport failure is not closure');
    assert.equal(jobRow(store, 'closed-by-liveness').closed_at, null, 'transport failure is not closure');
    const closed = await crawlRun({ store, runId: 'closure-explicit', clock: fixedClock('2026-10-22T06:00:00.000Z'), sourcePlans: [absenceSource([
      absenceJob('closed-by-status', { status: 'closed' }),
      absenceJob('closed-by-liveness', { liveness: { status: 'Expired', checkedAt: '2026-10-22T06:00:00.000Z', evidence: 'fixture' } }),
    ])] });
    assert.equal(closed.telemetry.sources['absence-source'].status, 'succeeded');
    assert.equal(jobRow(store, 'closed-by-status').closed_at, '2026-10-22T06:00:00.000Z');
    assert.equal(jobRow(store, 'closed-by-liveness').closed_at, '2026-10-22T06:00:00.000Z');
  } finally {
    store.close();
  }
});

test('a job from a completed run survives a failed run on a reopened store with its earlier last_seen_at', async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'launchpad-crawler-reopen-')), 'crawler.sqlite');
  let store = openCrawlerStore(file);
  await crawlRun({ store, runId: 'reopen-first', clock: fixedClock('2026-10-20T06:00:00.000Z'), sourcePlans: [absenceSource([absenceJob('reopened')])] });
  const seen = jobRow(store, 'reopened');
  store.close();
  store = openCrawlerStore(file);
  try {
    const failed = await crawlRun({ store, runId: 'reopen-failed', clock: fixedClock('2026-10-21T06:00:00.000Z'), sourcePlans: [absenceSource([], { status: 'failed', errors: ['HTTP 503'] })] });
    assert.equal(failed.telemetry.sources['absence-source'].status, 'failed');
    const after = jobRow(store, 'reopened');
    assert.equal(after.last_seen_at, '2026-10-20T06:00:00.000Z');
    assert.equal(after.closed_at, null);
    assert.deepEqual(after, seen);
  } finally {
    store.close();
  }
});
