import { withManualFixtureScores, scoredFixture } from '../fixtures/manual-scores.mjs';
// Keep fixture scores separate from discovery records.
function runStartupMode(options) { return runStartupModeActual(withManualFixtureScores(options)); }

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { enrichStartupSources, normalizeFundingSignal } from '../../job-pull/startup-enrichment.mjs';
import { runStartupMode as runStartupModeActual } from '../../job-pull/startup-mode.mjs';
import { STARTUP_SOURCE_LANES, runStartupSourcePlan } from '../../job-pull/startup-sources.mjs';
import { createFakeTransactionalGateway } from '../../job-pull/startup-transaction.mjs';
import { STARTUP_NOW, startupModeFixtures, startupSourceFunctions } from '../fixtures/startup-mode.mjs';

test('Startup source plan attempts and reports every startup lane with no live access', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('live access must not occur'); };
  try {
    const result = await runStartupSourcePlan({ clock: () => STARTUP_NOW, runAt: STARTUP_NOW, runId: 'startup-sources', sourceFunctions: {
      'startup-employer-boards': startupSourceFunctions()['startup-employer-boards'],
      wellfound: () => { throw new Error('Wellfound fixture unavailable'); },
    } });
    assert.deepEqual(result.map(({ manifest }) => manifest.sourceId), STARTUP_SOURCE_LANES.map((lane) => lane.id));
    assert.equal(result.find(({ manifest }) => manifest.sourceId === 'wellfound').manifest.status, 'failed');
    assert.equal(result.find(({ manifest }) => manifest.sourceId === 'yc').manifest.status, 'unavailable');
    assert.equal(result.find(({ manifest }) => manifest.sourceId === 'funding-hiring-signals').manifest.status, 'unavailable');
    assert.equal(result.length, 7);
  } finally { globalThis.fetch = originalFetch; }
});

test('Startup enrichment records stage, verified time, careers/ATS, funding windows, and never changes job freshness', async () => {
  const sourceResults = await runStartupSourcePlan({ runAt: STARTUP_NOW, runId: 'startup-enrichment', sourceFunctions: startupSourceFunctions() });
  const originalPostedAt = sourceResults[1].candidates[0].postedAt;
  const enriched = enrichStartupSources(sourceResults, { runAt: STARTUP_NOW });
  const candidate = enriched.sources.flatMap((source) => source.candidates).find((item) => item.company === 'Startup Co 2');
  assert.equal(candidate.postedAt, originalPostedAt);
  assert.equal(candidate.companyStage, 'Startup');
  assert.equal(candidate.companyVerifiedAt, STARTUP_NOW);
  assert.equal(candidate.fundingDate, '2026-05-10');
  assert.equal(candidate.fundingSignal.within18Months, true);
  assert.equal(candidate.fundingSignal.under6Months, true);
  assert.equal(candidate.hiringSignal.active, true);
  assert.equal(candidate.careerPageUrl, null);
  assert.equal(enriched.companyRecords.find((company) => company.name === 'Startup Co 1').atsProvider, 'greenhouse');
  assert.equal(enriched.companyRecords.find((company) => company.name === 'Startup Co 1').careerPageUrl, 'https://startupco1.example/careers');
  assert.equal(enriched.companyRecords.find((company) => company.name === 'Startup Co 9').fundingSignal.within18Months, false);
  assert.equal(enriched.companyRecords.find((company) => company.name === 'Startup Co 9').fundingSignal.under6Months, false);
});

test('Funding signal classification requires evidence and distinguishes six-month and eighteen-month windows', () => {
  const recent = normalizeFundingSignal({ company: 'Recent', fundingDate: '2026-02-01', fundingEvidence: 'round announcement', sourceUrl: 'https://funding.example/recent', verifiedAt: STARTUP_NOW }, { runAt: STARTUP_NOW });
  const older = normalizeFundingSignal({ company: 'Older', fundingDate: '2025-02-01', fundingEvidence: 'round announcement', sourceUrl: 'https://funding.example/older', verifiedAt: STARTUP_NOW }, { runAt: STARTUP_NOW });
  const unverified = normalizeFundingSignal({ company: 'Unknown', fundingDate: '2026-02-01', fundingEvidence: 'unconfirmed' }, { runAt: STARTUP_NOW });
  assert.equal(recent.within18Months, true);
  assert.equal(recent.under6Months, true);
  assert.equal(older.within18Months, true);
  assert.equal(older.under6Months, false);
  assert.equal(unverified.verified, false);
  assert.equal(unverified.within18Months, false);
});

test('Startup mode prioritizes startup signals but preserves original-application, liveness, freshness, eligibility, and dedup gates', async () => {
  const fixtures = startupModeFixtures();
  const result = await runStartupMode({
    clock: () => STARTUP_NOW,
    runId: 'startup-high-level',
    sourceFunctions: startupSourceFunctions(),
    notionGateway: { planWrites: ({ operations }) => ({ status: 'planned', operations }) },
  });
  assert.equal(result.mode, 'startup');
  assert.equal(result.schemaVersion, 'LaunchpadV5StartupModeV1');
  assert.equal(result.sourceManifests.length, 7);
  assert.ok(result.sourceManifests.every((manifest) => manifest.startupLane === true));
  assert.equal(result.counts.minimum, 10);
  assert.equal(result.counts.preferred, 12);
  assert.equal(result.counts.maximum, 20);
  assert.equal(result.shortlist.some((candidate) => candidate.company === 'Startup Co 2'), true);
  assert.equal(result.shortlist.filter((candidate) => candidate.canonicalUrl.includes('/duplicate')).length, 0);
  assert.ok(result.shortlist.every((candidate) => candidate.applicationReady === true && candidate.liveness.status === 'Active'));
  assert.ok(result.shortlist.every((candidate) => candidate.originalApplicationUrl));
  assert.ok(result.shortlist.every((candidate) => ['Startup', 'Scale-up', 'Mid-size', 'Enterprise'].includes(candidate.companyStage)));
  assert.ok(result.plannedNotionOperations.every((operation) => operation.resource === 'application' && operation.operation === 'create'));
  assert.ok(result.plannedNotionOperations.every((operation) => operation.payload.discoveryMode === 'Startup'));
  for (const { payload } of result.plannedNotionOperations) {
    for (const field of ['makeResume', 'applied', 'Make Resume', 'Applied?']) assert.equal(field in payload, false, field);
  }
  assert.ok(result.plannedNotionOperations.some((operation) => operation.payload.fundingSignal?.under6Months === true));
  assert.ok(result.plannedNotionOperations.every((operation) => operation.provenance.startup.company));
  assert.equal(result.outcome.fatal, false);
  assert.equal(fixtures['funding-hiring-signals'].signals[0].fundingDate, '2026-05-10');
});

test('Startup Notion operations carry the enriched company record at the top level', async () => {
  const result = await runStartupMode({
    clock: () => STARTUP_NOW,
    sourceFunctions: startupSourceFunctions(),
    notionGateway: { planWrites: ({ operations }) => ({ operations }) },
  });
  const candidate = result.shortlist.find((item) => item.company === 'Startup Co 1');
  const operation = result.plannedNotionOperations.find((item) => item.payload.Company === candidate.company);
  assert.ok(candidate.companyRecord.name);
  assert.ok(candidate.companyRecord.canonicalDomain);
  assert.deepEqual(operation.company, candidate.companyRecord);
});

test('Unresolved startup leads remain in verification and cannot satisfy the application-ready shortlist', async () => {
  const result = await runStartupMode({
    clock: () => STARTUP_NOW,
    sourceFunctions: { wellfound: () => ({ records: [{
      url: 'https://wellfound.example/unresolved', company: 'Needs Verify Startup', title: 'AI Engineer', location: 'Pune, India', postedAt: STARTUP_NOW,
      employment: { type: 'full-time' }, experience: { minYears: 0, maxYears: 1 }, liveness: { status: 'Active' },
    }] }) },
    notionGateway: { planWrites: ({ operations }) => ({ operations }) },
  });
  assert.equal(result.shortlist.some((candidate) => candidate.company === 'Needs Verify Startup'), false);
  assert.equal(result.verificationQueue.some((record) => record.company === 'Needs Verify Startup'), true);
});

test('v4 historical identity match is suppressed before the shortlist/Notion-planning step', async () => {
  const historicalV4Rows = [{ company: 'Startup Co 2', title: 'AI Engineer', location: 'Pune, India', state: 'applied' }];
  const result = await runStartupMode({
    clock: () => STARTUP_NOW,
    sourceFunctions: startupSourceFunctions(),
    notionGateway: { planWrites: ({ operations }) => ({ operations }) },
    historicalV4Rows,
  });
  assert.equal(result.shortlist.some((candidate) => candidate.company === 'Startup Co 2'), false);
  assert.ok(result.plannedNotionOperations.every((operation) => operation.payload.Company !== 'Startup Co 2'));
  assert.ok(result.historicalSuppressions.some((item) => item.company === 'Startup Co 2'));
  assert.equal(result.counts.historicalSuppressed, result.historicalSuppressions.length);
});

test('Startup transaction execution accepts only the injected fake gateway', async () => {
  const gateway = createFakeTransactionalGateway();
  const result = await runStartupMode({ clock: () => STARTUP_NOW, sourceFunctions: startupSourceFunctions(), notionGateway: gateway, executeGateway: true });
  assert.equal(result.outcome.fatal, false);
  assert.equal(result.transaction.status, 'committed');
  assert.equal(gateway.events[0].stage, 'reserve');
  assert.equal(gateway.events.at(-1).stage, 'commit');
});

test('Malformed startup policy fails before any Notion plan', async () => {
  const calls = [];
  const result = await runStartupMode({ clock: () => STARTUP_NOW, config: { schemaVersion: 'bad' }, sourceFunctions: {}, notionGateway: { planWrites(request) { calls.push(request); return request; } } });
  assert.equal(result.outcome.fatal, true);
  assert.deepEqual(calls, []);
});
