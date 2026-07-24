import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCrawlerStore, readCrawlerState } from '../../crawler/run.mjs';
import { crawlWorkflow } from '../../crawler/workflow.mjs';

function fixedClock() {
  let current = Date.parse('2026-07-23T10:00:00.000Z');
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
        ? { url: 'https://resolved.example/careers/ai-engineer', company: 'Resolved Co' }
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
  assert.equal(second.observations[0]._crawlerIdentity.code, 'UNCHANGED_DUPLICATE');
  assert.equal(second.shortlist.length, 0);
  assert.equal(second.jobs.length, 1);
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
  assert.ok(result.verificationQueue[0].reasons.includes('ORIGINAL_APPLICATION_NOT_RESOLVED'));
  assert.ok(result.verificationQueue[0].reasons.includes('EXPERIENCE_NOT_STATED_MANUAL_REVIEW'));
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
      eligibility: { eligible: false, reasons: ['GEO_ONSITE_NOT_PUNE'], geo: { code: 'GEO_ONSITE_NOT_PUNE' } },
      freshness: { eligible: true, ageHours: 2 },
    }),
  });

  assert.equal(result.verificationQueue.some((item) => item.url === observation.canonicalUrl), false);
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
