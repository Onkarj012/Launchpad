import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { runNormalMode } from '../../job-pull/normal-mode.mjs';
import { NORMAL_SOURCE_LANES } from '../../job-pull/normal-sources.mjs';
import { selectNormalApplications } from '../../job-pull/normal-selection.mjs';
import { createFakeTransactionalGateway } from '../../job-pull/normal-transaction.mjs';
import { loadConfig } from '../../job-pull/config.mjs';

const NOW = '2026-07-23T06:30:00.000Z';
const config = loadConfig();

function raw(index, overrides = {}) {
  return {
    url: `https://portal.example.test/job/${index}`, company: `Company ${index}`, title: 'AI Engineer', location: 'Pune, India',
    postedAt: NOW, employment: { type: 'full-time', evidence: 'full-time' }, experience: { minYears: 0, maxYears: 1, evidence: '0-1 years' },
    liveness: { status: 'Active', checkedAt: NOW, evidence: 'employer page checked' }, matchScore: 80 - index,
    ...overrides,
  };
}

function sourceFunction(lane, records) { return () => ({ records: records.map((record) => ({ ...record, source: lane.id, sourceCategory: lane.category, provider: lane.provider })) }); }

function allFunctions(recordsByLane = {}) {
  return Object.fromEntries(NORMAL_SOURCE_LANES.map((lane) => [lane.id, sourceFunction(lane, recordsByLane[lane.id] || [])]));
}

test('Normal attempts every lane independently, records optional/unavailable/failure, and never performs live access', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('live access must not occur'); };
  try {
    const result = await runNormalMode({
      clock: () => NOW, runId: 'telemetry-run',
      sourceFunctions: {
        'tracked-ats': sourceFunction(NORMAL_SOURCE_LANES[0], [raw(1, { url: 'https://jobs.example.test/1', sourceKind: 'ats-direct' })]),
        'portal-naukri': () => { throw new Error('naukri fixture failed'); },
      },
    });
    assert.deepEqual(result.sourceManifests.map((manifest) => manifest.sourceId), NORMAL_SOURCE_LANES.map((lane) => lane.id));
    assert.equal(result.sourceManifests.find((manifest) => manifest.sourceId === 'portal-naukri').status, 'failed');
    assert.equal(result.sourceManifests.find((manifest) => manifest.sourceId === 'indeed').status, 'unavailable');
    assert.equal(result.outcome.status, 'degraded');
    assert.equal(result.sourceManifests.length, 12);
  } finally { globalThis.fetch = originalFetch; }
});

test('normalizes and preserves discovery/original evidence, while the readiness gate rejects unresolved portal leads', async () => {
  const result = await runNormalMode({
    clock: () => NOW, sourceFunctions: allFunctions({
      'portal-naukri': [raw(1, { discoveryUrl: 'https://naukri.example/job/1', originalApplicationUrl: 'https://acme.example/careers/1', originalApplicationEvidence: 'Acme ATS resolved from employer careers page', applicationResolution: { status: 'Resolved Original', evidence: 'Acme ATS resolved from employer careers page' }, evidence: { feesBonds: null, requirements: 'Python, FastAPI' } })],
      'portal-foundit': [raw(2, { discoveryUrl: 'https://foundit.example/job/2' })],
    }), notionGateway: { planWrites: ({ operations }) => ({ operations }) },
  });
  assert.equal(result.shortlist.length, 1);
  assert.equal(result.shortlist[0].discoveryUrl, 'https://naukri.example/job/1');
  assert.equal(result.shortlist[0].originalApplicationEvidence, 'Acme ATS resolved from employer careers page');
  assert.equal(result.verificationQueue.length, 1);
  assert.equal(result.verificationQueue[0].company, 'Company 2');
  assert.equal(result.verificationQueue[0].applicationResolution.status, 'Unresolved');
});

test('selection follows 24h, 72h, 3-7d, relaxed-fit, and relaxed-backfill waterfall without family quotas', () => {
  const posted = (hours) => new Date(Date.parse(NOW) - hours * 3600000).toISOString();
  const entries = [
    raw(1, { postedAt: posted(120), matchScore: 99, title: 'AI Engineer' }),
    raw(2, { postedAt: posted(12), matchScore: 60, title: 'AI Engineer' }),
    raw(3, { postedAt: posted(48), matchScore: 70, title: 'AI Engineer' }),
    raw(4, { postedAt: posted(12), matchScore: 95, title: 'AI Engineer', experience: { minYears: 2, maxYears: 2, evidence: '2 years' } }),
    raw(5, { postedAt: posted(12), matchScore: 90, title: 'Data Engineer' }),
  ].map((candidate) => normalizeCandidate(candidate, { runAt: NOW, source: 'fixture', sourceKind: 'ats-direct', currentFeedIsLive: true }));
  const enriched = entries.map((candidate) => ({ candidate, eligibility: { eligible: true, strict: candidate.title === 'AI Engineer' && candidate.experience.minYears !== 2, relaxed: true, experience: { relaxed: candidate.experience.minYears === 2 }, title: { relaxed: candidate.title === 'Data Engineer' }, relaxations: [] }, freshness: { eligible: true, ageHours: (Date.parse(NOW) - Date.parse(candidate.postedAt)) / 3600000, window: 'Active' } }));
  const result = selectNormalApplications(enriched, { maximumPerCompany: 10 });
  assert.deepEqual(result.selected.map((candidate) => candidate.canonicalUrl), [entries[1], entries[2], entries[0], entries[3], entries[4]].map((candidate) => candidate.canonicalUrl));
  assert.equal(result.selected[0].waterfallBand, 'strict-0-24h');
  assert.equal(result.selected[1].waterfallBand, 'strict-24-72h');
  assert.equal(result.familyCounts.unknown, 5);
});

test('normal selection keeps unscored ready candidates out of the waterfall', () => {
  const scored = normalizeCandidate(raw(1), { runAt: NOW, source: 'fixture', sourceKind: 'ats-direct', currentFeedIsLive: true });
  const unscored = normalizeCandidate(raw(2, { matchScore: undefined }), { runAt: NOW, source: 'fixture', sourceKind: 'ats-direct', currentFeedIsLive: true });
  const entries = [scored, unscored].map((candidate) => ({ candidate, eligibility: { eligible: true, strict: true }, freshness: { eligible: true, ageHours: 1, window: 'Hot' } }));
  const result = selectNormalApplications(entries, { minimum: 1, preferred: 1, maximum: 2, maximumPerCompany: 2 });
  assert.deepEqual(result.selected.map((candidate) => candidate.canonicalUrl), [scored.canonicalUrl]);
  assert.equal(result.scoringQueue.length, 1);
  assert.equal(result.scoringQueue[0].canonicalUrl, unscored.canonicalUrl);
  assert.equal(result.scoringQueue[0].scoringStatus, 'unscored');
  assert.equal(result.scoredCount, 1);
  assert.equal(result.unscoredCount, 1);
});

test('10/12/20 volume contract has truthful bounds and no hard role-family quota', () => {
  const records = Object.fromEntries(NORMAL_SOURCE_LANES.slice(0, 1).map((lane) => [lane.id, Array.from({ length: 20 }, (_, i) => raw(i + 1))]));
  return runNormalMode({ clock: () => NOW, sourceFunctions: allFunctions(records), notionGateway: { planWrites: ({ operations }) => ({ operations }) } }).then((result) => {
    assert.equal(result.shortlist.length, 20);
    assert.equal(result.shortfall.missing, 0);
    assert.equal(result.counts.minimum, 10);
    assert.equal(result.counts.preferred, 12);
    assert.equal(result.counts.maximum, 20);
    assert.equal(Object.keys(result.counts.familyCounts).length, 1);
  });
});

test('shortfall is exact, includes failed and empty lanes, and suggests but never invokes LinkedIn rescue at five short', async () => {
  const result = await runNormalMode({
    clock: () => NOW, sourceFunctions: {
      'tracked-ats': sourceFunction(NORMAL_SOURCE_LANES[0], [raw(1)]),
      'portal-naukri': sourceFunction(NORMAL_SOURCE_LANES[2], []),
      'portal-foundit': () => { throw new Error('broken fixture'); },
    }, notionGateway: { planWrites: ({ operations }) => ({ operations }) },
  });
  assert.equal(result.shortlist.length, 1);
  assert.equal(result.shortfall.missing, 9);
  assert.ok(result.shortfall.failedLanes.includes('portal-foundit'));
  assert.ok(result.shortfall.emptyLanes.includes('portal-naukri'));
  assert.equal(result.shortfall.linkedinRescueSuggestion.suggested, true);
  assert.equal(result.shortfall.linkedinRescueSuggestion.invoked, false);
});

test('fake gateway proves reserve-write-verify-commit, partial abort, and idempotency', async () => {
  const operations = [1, 2].map((index) => ({ operation: 'create', resource: 'application', dedupKey: `key-${index}`, payload: { 'Dedup Key': `key-${index}` } }));
  const gateway = createFakeTransactionalGateway({ failOn: 'key-2' });
  const planned = gateway.planWrites({ operations });
  const first = await gateway.executeWrites({ operations: planned.operations });
  assert.equal(first.status, 'partial');
  assert.deepEqual(gateway.events.map((event) => event.stage), ['reserve', 'write', 'verify', 'write', 'abort', 'commit']);
  assert.deepEqual([...gateway.committed.keys()], ['key-1']);
  const second = await gateway.executeWrites({ operations: [operations[0]] });
  assert.equal(second.status, 'noop');
  assert.deepEqual(gateway.events.map((event) => event.stage), ['reserve', 'write', 'verify', 'write', 'abort', 'commit', 'reserve']);
});

test('v4 historical identity match is suppressed before the shortlist/Notion-planning step', async () => {
  const readyCandidate = raw(1, {
    discoveryUrl: 'https://naukri.example/job/1',
    originalApplicationUrl: 'https://acme.example/careers/1',
    originalApplicationEvidence: 'Acme ATS resolved from employer careers page',
    applicationResolution: { status: 'Resolved Original', evidence: 'Acme ATS resolved from employer careers page' },
  });
  const historicalV4Rows = [{ company: 'Company 1', title: 'AI Engineer', location: 'Pune, India', state: 'applied' }];

  const suppressed = await runNormalMode({
    clock: () => NOW, sourceFunctions: allFunctions({ 'portal-naukri': [readyCandidate] }),
    notionGateway: { planWrites: ({ operations }) => ({ operations }) },
    historicalV4Rows,
  });
  assert.equal(suppressed.shortlist.length, 0);
  assert.equal(suppressed.plannedNotionOperations.length, 0);
  assert.equal(suppressed.historicalSuppressions.length, 1);
  assert.equal(suppressed.historicalSuppressions[0].company, 'Company 1');
  assert.deepEqual(suppressed.historicalSuppressions[0].matchTypes, ['company_title_location']);
  assert.equal(suppressed.counts.historicalSuppressed, 1);

  // Without historical rows the same candidate is unaffected: read-only, no side effects.
  const unsuppressed = await runNormalMode({
    clock: () => NOW, sourceFunctions: allFunctions({ 'portal-naukri': [readyCandidate] }),
    notionGateway: { planWrites: ({ operations }) => ({ operations }) },
  });
  assert.equal(unsuppressed.shortlist.length, 1);
  assert.equal(unsuppressed.historicalSuppressions.length, 0);
});

test('fatal core failure occurs before planning or transactional execution', async () => {
  const gateway = createFakeTransactionalGateway();
  const result = await runNormalMode({ clock: () => NOW, config: { schemaVersion: 'bad' }, notionGateway: gateway, sourceFunctions: {} });
  assert.equal(result.outcome.fatal, true);
  assert.equal(result.plannedNotionOperations.length, 0);
  assert.equal(gateway.plans.length, 0);
  assert.equal(gateway.events.length, 0);
});

test('fatal scoring gate surfaces the pipeline funnel report', async () => {
  const result = await runNormalMode({
    clock: () => NOW,
    sourceFunctions: { 'tracked-ats': () => ({ records: [
      raw(1, { matchScore: undefined }),
      raw(2, { provider: 'workday', postedAt: null, url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/REQ-VERIFY' }),
    ] }) },
    enrichmentBudget: 0,
  });
  assert.equal(result.outcome.fatal, true);
  assert.ok(result.funnel);
  assert.equal(result.funnel.reconciliation.ok, true);
});

test('fatal scoring gate preserves verification candidates', async () => {
  const result = await runNormalMode({
    clock: () => NOW,
    sourceFunctions: { 'tracked-ats': () => ({ records: [
      raw(1, { matchScore: undefined }),
      raw(2, { provider: 'workday', postedAt: null, url: 'https://acme.wd1.myworkdayjobs.com/Careers/job/Pune/REQ-VERIFY' }),
    ] }) },
    enrichmentBudget: 0,
  });
  assert.equal(result.outcome.fatal, true);
  assert.ok(result.verificationQueue.length > 0);
  assert.equal(result.counts.verificationQueue, result.verificationQueue.length);
});

test('healthy scorer with one failed row of twelve delivers a degraded shortlist and keeps the row in the scoring queue', async () => {
  const records = Array.from({ length: 12 }, (_, index) => raw(index + 1, { matchScore: undefined }));
  let attemptedRows = [];
  const scorer = async (rows) => {
    attemptedRows = rows;
    return {
      scored: rows.slice(1).map((candidate) => ({ ...candidate, matchScore: 70, rationale: 'fixture score', responseLikelihood: 15 })),
      failures: [{ canonicalUrl: rows[0].canonicalUrl, reason: 'SCORER_EXEC_FAILED' }],
      chunks: 1,
      degraded: false,
      reasonCode: null,
    };
  };
  const result = await runNormalMode({
    clock: () => NOW, scorer,
    sourceFunctions: allFunctions({ 'tracked-ats': records }),
    notionGateway: { planWrites: ({ operations }) => ({ operations }) },
  });
  assert.equal(result.outcome.fatal, false);
  assert.equal(result.outcome.status, 'degraded');
  assert.equal(result.outcome.degraded, true);
  assert.equal(attemptedRows.length, 12);
  assert.equal(result.shortlist.length, 11);
  assert.equal(result.scoringQueue.length, 1);
  assert.equal(result.scoringQueue[0].canonicalUrl, attemptedRows[0].canonicalUrl);
  assert.equal(result.scoringQueue[0].scoringStatus, 'unscored');
  // Counts and reconciliation stay internally consistent on the degraded path:
  // a non-zero shortlist now coexists with dropped scoring rows.
  assert.equal(result.counts.selected, result.shortlist.length);
  assert.equal(result.counts.unscored, result.scoringQueue.length);
  assert.equal(result.counts.scored + result.counts.unscored + result.counts.scoringFailed, result.counts.ready);
  const recon = result.reconciliation;
  assert.equal(recon.eligible, 12);
  assert.equal(recon.ready, 12);
  assert.equal(recon.scored, 11);
  assert.equal(recon.selected, 11);
  assert.equal(recon.scored + recon.causes.readyToScored.UNSCORED + recon.causes.readyToScored.SCORING_FAILED, recon.ready);
  assert.equal(recon.selected + recon.causes.scoredToSelected.SELECTION_RULES, recon.scored);
  assert.ok(recon.line.includes('selected=11'));
  assert.ok(recon.line.includes('readyToScored:UNSCORED=1'));
});

test('losing more than half the scoring batch is fatal even though the scorer responded', async () => {
  const records = Array.from({ length: 36 }, (_, index) => raw(index + 1, { matchScore: undefined }));
  const scorer = async (rows) => ({
    scored: rows.slice(0, 12).map((candidate) => ({ ...candidate, matchScore: 70, rationale: 'fixture score' })),
    // Two of three chunks failed: every row they carried lands in failures.
    failures: rows.slice(12).map((candidate) => ({ canonicalUrl: candidate.canonicalUrl, reason: 'SCORER_EXEC_FAILED' })),
    chunks: 3,
    degraded: false,
    reasonCode: null,
  });
  const result = await runNormalMode({
    clock: () => NOW, scorer,
    sourceFunctions: allFunctions({ 'tracked-ats': records }),
    notionGateway: { planWrites: ({ operations }) => ({ operations }) },
  });
  assert.equal(result.outcome.fatal, true);
  assert.equal(result.outcome.status, 'fatal');
  assert.equal(result.outcome.errors[0].stage, 'scoring');
  assert.equal(result.shortlist.length, 0);
  assert.equal(result.scoringQueue.length, 24);
  assert.equal(result.counts.unscored, 24);
  assert.equal(result.counts.selected, 0);
});

test('a degraded scorer with a broken reason code is fatal even at a low failure share', async () => {
  const records = Array.from({ length: 12 }, (_, index) => raw(index + 1, { matchScore: undefined }));
  const scorer = async (rows) => ({
    scored: rows.slice(0, 7).map((candidate) => ({ ...candidate, matchScore: 70, rationale: 'fixture score' })),
    failures: rows.slice(7).map((candidate) => ({ canonicalUrl: candidate.canonicalUrl, reason: 'SCORER_AUTH_FAILED' })),
    chunks: 1,
    degraded: true,
    reasonCode: 'SCORER_AUTH_FAILED',
  });
  const result = await runNormalMode({
    clock: () => NOW, scorer,
    sourceFunctions: allFunctions({ 'tracked-ats': records }),
    notionGateway: { planWrites: ({ operations }) => ({ operations }) },
  });
  assert.equal(result.outcome.fatal, true);
  assert.equal(result.outcome.errors[0].stage, 'scoring');
  assert.ok(result.outcome.errors[0].message.includes('SCORER_AUTH_FAILED'));
  assert.equal(result.shortlist.length, 0);
});

test('a fully timed-out scorer fails with its run-level timeout reason in the receipt', async () => {
  const records = Array.from({ length: 12 }, (_, index) => raw(index + 1, { matchScore: undefined }));
  const scorer = async (rows) => ({
    scored: [],
    failures: rows.map((candidate) => ({ canonicalUrl: candidate.canonicalUrl, reason: 'SCORER_TIMEOUT' })),
    chunks: 1,
    degraded: true,
    reasonCode: 'SCORER_TIMEOUT',
  });
  const result = await runNormalMode({
    clock: () => NOW, scorer,
    sourceFunctions: allFunctions({ 'tracked-ats': records }),
    notionGateway: { planWrites: ({ operations }) => ({ operations }) },
  });
  assert.equal(result.outcome.fatal, true);
  assert.match(result.outcome.errors[0].message, /reason-code=SCORER_TIMEOUT/);
  assert.doesNotMatch(result.outcome.errors[0].message, /reason-code=none/);
});

test('without a scorer an unscored row is still fatal (legacy all-or-nothing gate preserved)', async () => {
  const result = await runNormalMode({
    clock: () => NOW,
    sourceFunctions: allFunctions({ 'tracked-ats': [raw(1, { matchScore: undefined }), raw(2)] }),
    notionGateway: { planWrites: ({ operations }) => ({ operations }) },
  });
  assert.equal(result.outcome.fatal, true);
  assert.equal(result.outcome.status, 'fatal');
  assert.equal(result.outcome.errors[0].stage, 'scoring');
  assert.equal(result.shortlist.length, 0);
  assert.ok(result.scoring);
  assert.equal('scorer' in result.scoring, false);
});
