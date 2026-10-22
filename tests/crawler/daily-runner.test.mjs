import { withManualFixtureScores } from '../fixtures/manual-scores.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFocusedModeFixtures, createDailyExecution, crawlerLaneFixtures, retainDailyPhaseTargetRun, runDailyNormal as runDailyNormalActual, selectDailyModes } from '../../crawler/daily-runner.mjs';
import { computeCanaryVersion } from '../../crawler/canary-evaluator.mjs';
import { computeDeliveryInventoryIdentity, DELIVERY_CANARY_EVIDENCE_SCHEMA, DELIVERY_CANARY_SIDECAR_SCHEMA } from '../../crawler/delivery-canary.mjs';
import { loadBoardRotationState, saveBoardRotationState } from '../../crawler/board-rotation-state.mjs';
import { openCrawlerStore, crawlRun, readCrawlerRunData, readHeldLeadRecoveryState } from '../../crawler/run.mjs';
import { buildDailyReceipt } from '../../crawler/daily-receipt.mjs';
import { candidateDedupKey, candidateRequisitionKey, normalizeCandidate } from '../../job-pull/candidate.mjs';
import { classifyCandidate } from '../../job-pull/eligibility.mjs';
import { classifyFreshness } from '../../job-pull/freshness.mjs';
import { loadConfig as loadJobPullConfig } from '../../job-pull/config.mjs';
import { NORMAL_SOURCE_LANES } from '../../job-pull/normal-sources.mjs';
import { markAction, readOpportunityLedger, recordSurfaced } from '../../job-pull/opportunity-ledger.mjs';
import { createFakeTransactionalGateway } from '../../job-pull/normal-transaction.mjs';
import { renderLocalDailyHtmlReport, renderLocalLeadReport, writeLocalDailyHtmlReport } from '../../crawler/local-lead-report.mjs';
import { applyOriginalListingResolution, createOriginalListingResolver } from '../../crawler/original-listing-resolver.mjs';

const NOW = '2026-07-24T06:30:00.000Z';

test('a workflow handoff failure retains durable source coverage in the fatal daily report', async () => {
  const { config } = testConfig();
  let store = openCrawlerStore(config.databasePath);
  try {
    const runId = 'workflow-handoff-failure';
    const crawlerId = `${runId}-crawler-v2`;
    const retained = await crawlRun({ store, runId: crawlerId, sourcePlans: [{
      id: 'ats-warm', fetch: async () => ({ observations: [] }),
    }] });
    const telemetry = { ...retained.telemetry, workflow: { sourceTelemetry: { invalid: null } } };
    store.prepare('UPDATE crawl_runs SET telemetry_json = ? WHERE run_id = ?').run(JSON.stringify(telemetry), crawlerId);
    const { config: decoyConfig } = testConfig();
    const result = await runDailyNormalActual(runOptions(decoyConfig, () => { throw new Error('replay must not fetch'); }, { runId, store }));
    assert.equal(result.outcome.status, 'fatal');
    assert.deepEqual(result.terminalEnvelope.sourceCoverage.completed, ['ats-warm']);
    assert.equal(result.terminalEnvelope.sourceEndStates['ats-warm'].state, 'empty');
    assert.equal(result.terminalEnvelope.lastDurableSourceState['ats-warm'].status, 'succeeded');
    assert.equal(result.dailyReceipt.retained.identityRows, 'Not Verified');
    assert.equal(result.receiptPersistence, 'failed');
    assert.match(result.receiptPersistenceError, /sourceTelemetry\.invalid must be a plain object/);
    assert.equal(result.dailyReceipt.scopes.rawObservations.count, 'Not Verified');
    assert.equal(result.dailyReceipt.scopes.uniqueRequisitions.count, 'Not Verified');
    assert.equal(existsSync(decoyConfig.databasePath), false, 'a caller-owned store avoids opening the configured decoy database');
    store.close();
    store = null;
    const reopened = openCrawlerStore(config.databasePath);
    const persisted = JSON.parse(reopened.prepare('SELECT telemetry_json FROM crawl_runs WHERE run_id = ?').get(crawlerId).telemetry_json);
    reopened.close();
    assert.equal(persisted.workflow.dailyReceipt, undefined, 'malformed durable telemetry remains unchanged when receipt validation fails');
    assert.match(renderLocalLeadReport({ dailyReceipt: result.dailyReceipt }, { now: NOW }), /Daily stage-loss receipt/);
    const report = renderLocalDailyHtmlReport(result);
    assert.match(report, /Status: failed/);
    assert.match(report, /ats-warm: empty/);

    const { config: actualConfig } = testConfig();
    const { config: configuredDecoy } = testConfig();
    const actualStore = openCrawlerStore(actualConfig.databasePath);
    const fatalRun = await runDailyNormalActual(runOptions(configuredDecoy, () => { throw new Error('fixture transport must not be called'); }, {
      runId: 'fatal-scoring-receipt',
      store: actualStore,
      sourceFixtures: {
        ...emptyLegacyFixtures(),
        'portal-naukri': { candidates: [rawPortalJob(1978, { scoringFailed: true, scoringError: 'fixture scorer failed' })], manifest: { status: 'ok' } },
      },
    }));
    assert.equal(fatalRun.outcome.status, 'fatal');
    assert.equal(fatalRun.receiptPersistence, 'persisted', fatalRun.receiptPersistenceError);
    assert.equal(existsSync(configuredDecoy.databasePath), false, 'receipt persistence must not open the decoy database');
    assert.ok(actualStore.prepare('SELECT 1').get(), 'runDailyNormal leaves the caller-owned store open');
    actualStore.close();
    const fatalReopened = openCrawlerStore(actualConfig.databasePath);
    const fatalTelemetry = JSON.parse(fatalReopened.prepare('SELECT telemetry_json FROM crawl_runs WHERE run_id = ?').get('fatal-scoring-receipt-crawler-v2').telemetry_json);
    fatalReopened.close();
    assert.equal(fatalTelemetry.workflow.dailyReceipt.run.status, 'failed');
    assert.equal(fatalTelemetry.workflow.dailyReceipt.scopes.scoringFailure.count, 1);
  } finally { store?.close(); }
});

test('one daily crawl routes a Pune startup once and tags its other mode', async () => {
  const { config } = testConfig({ warmBoards: [{ slug: 'routing-startup', company: 'Routing Startup' }] });
  Object.assign(config.sources.atsWarm.boards[0], { startupTagged: true, evidenceRef: 'https://portfolio.example.test/routing-startup' });
  const calls = [];
  const result = await runDailyNormalActual(runOptions(config, fakeTransport({ 'routing-startup': [greenhouseJob(1801, 'routing-startup')] }, calls), {
    scorer: async (rows) => ({ scored: rows.map((row) => ({ ...row, matchScore: 80, responseLikelihood: 15, descriptionAvailable: true, rationale: 'Python overlap', strongestHook: 'Python skills', componentScores: { skillMatch: 30, domainRelevance: 15, seniorityFit: 10, locationFit: 10, responseLikelihood: 15 } })) }),
  }));
  assert.equal(result.outcome.fatal, false);
  assert.equal(result.sourceYieldScope, 'crawler-discovery');
  assert.equal(result.sourceYield.sources.length, 1);
  const roles = Object.values(result.modes).flatMap((mode) => mode.results);
  assert.equal(roles.length, 1);
  assert.equal(roles[0].primaryMode, 'startup');
  assert.deepEqual(roles[0].otherModes, ['normal']);
  assert.equal(result.modes.normal.results.length, 0);
  assert.equal(result.modes.startup.shortlist.length, 1);
  assert.equal(calls.length, 1);
});

test('primary mode follows Startup then Pune then Remote regardless of requested mode', async () => {
  for (const mode of ['normal', 'startup', 'remote']) {
    const { config } = testConfig();
    const roles = [
      rawPortalJob(1811, { company: 'Pune Remote Startup', workMode: 'remote', companyStage: 'Startup', startupStageEvidenceRef: 'https://portfolio.example.test/startup', description: 'Remote in India. Full-time AI Engineer for 0-1 years.' }),
      rawPortalJob(1812, { company: 'Pune Remote Enterprise', workMode: 'remote', description: 'Remote in India. Full-time AI Engineer for 0-1 years.' }),
      rawPortalJob(1813, { company: 'Remote Enterprise', location: 'Remote - India', description: 'Remote in India. Full-time AI Engineer for 0-1 years.' }),
      rawPortalJob(1814, { company: 'Unverified Startup Tag', companyStage: 'Startup' }),
    ];
    const result = await runDailyNormal(runOptions(config, fakeTransport({}), { mode, sourceFixtures: { ...emptyLegacyFixtures(), 'portal-naukri': { candidates: roles, manifest: { status: 'ok' } } } }));
    assert.equal(result.outcome.fatal, false);
    assert.deepEqual(result.modes.startup.results.map((role) => [role.company, role.primaryMode, role.otherModes]), [['Pune Remote Startup', 'startup', ['normal', 'remote']]]);
    assert.deepEqual(result.modes.normal.results.map((role) => [role.company, role.primaryMode, role.otherModes]), [['Pune Remote Enterprise', 'normal', ['remote']], ['Unverified Startup Tag', 'normal', []]]);
    assert.deepEqual(result.modes.remote.results.map((role) => [role.company, role.primaryMode, role.otherModes]), [['Remote Enterprise', 'remote', []]]);
    assert.deepEqual(result.shortlist, result.modes[mode].shortlist);
    assert.deepEqual(result.results, result.modes[mode].results);
  }
});

test('each mode keeps full results and caps one employer at two without using another modes company capacity', async () => {
  const roles = ['normal', 'startup', 'remote'].flatMap((mode, modeIndex) => [0, 1, 2].map((index) => rawPortalJob(1820 + modeIndex * 3 + index, {
    company: 'Shared Employer', provider: 'greenhouse', jobId: String(1820 + modeIndex * 3 + index),
    ...(mode === 'startup' ? { companyStage: 'Startup', startupStageEvidenceRef: 'https://portfolio.example.test/shared-employer' } : {}),
    ...(mode === 'remote' ? { location: 'Remote - India', description: 'Remote in India. Full-time AI Engineer for 0-1 years.' } : {}),
  })));
  const sourceFixtures = { ...emptyLegacyFixtures(), 'portal-naukri': { candidates: roles, manifest: { status: 'ok' } } };
  for (const mode of ['normal', 'startup', 'remote']) {
    const { config } = testConfig();
    const result = await runDailyNormal(runOptions(config, fakeTransport({}), { mode, runId: `mode-cap-${mode}`, sourceFixtures }));
    assert.equal(result.outcome.fatal, false);
    assert.equal(result.modes[mode].results.length, 3);
    assert.equal(result.modes[mode].shortlist.length, 2);
    assert.equal(result.shortlist.length, 2);
  }
});

test('EOR and long-term contract roles appear only in their separate daily lane', async () => {
  const { config } = testConfig();
  const roles = [
    rawPortalJob(1831, { company: 'Global EOR Employer', location: 'Remote - India', description: 'Remote in India. Full-time AI Engineer for 0-1 years at a US-based company, hired through an Employer of Record in India.' }),
    rawPortalJob(1832, { company: 'Direct Contract Employer', location: 'Remote - India', employment: { type: 'contract', evidence: 'Full-time contract, ongoing, fixed salary of INR 18 LPA, hired directly by the company.' }, description: 'Remote in India. AI Engineer for 0-1 years.' }),
    rawPortalJob(1834, { company: 'Unclear Contract Employer', location: 'Remote - India', employment: { type: 'contract', evidence: 'Contract role. Terms to be discussed.' }, description: 'Remote in India. AI Engineer for 0-1 years.' }),
    rawPortalJob(1833, { company: 'Ordinary Employer' }),
  ];
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: { ...emptyLegacyFixtures(), 'portal-naukri': { candidates: roles, manifest: { status: 'ok' } } },
  }));
  assert.equal(result.outcome.fatal, false);
  assert.deepEqual(result.modes.normal.results.map((role) => role.company), ['Ordinary Employer']);
  assert.deepEqual(result.modes.startup.results, []);
  assert.deepEqual(result.modes.remote.results, []);
  assert.deepEqual(result.modes.eorContract.results.map((role) => [role.company, role.labels]), [
    ['Global EOR Employer', ['EOR']],
    ['Direct Contract Employer', ['Contract']],
  ]);
  assert.deepEqual(result.modes.eorContract.shortlist.map((role) => role.company), [
    'Global EOR Employer',
    'Direct Contract Employer',
  ]);
  const fullTimeShortlists = ['normal', 'startup', 'remote'].flatMap((mode) => result.modes[mode].shortlist);
  assert.equal(fullTimeShortlists.some((role) => ['Global EOR Employer', 'Direct Contract Employer'].includes(role.company)), false);
  const report = renderLocalDailyHtmlReport(result);
  assert.match(report, /<section data-mode="eorContract"><h2>EOR \/ Contract<\/h2>/);
  assert.match(report, /Global EOR Employer/);
  assert.match(report, /Direct Contract Employer/);
  assert.match(report, new RegExp(`<li>Shortlisted: ${fullTimeShortlists.length}<\\/li>`));
  const targetReport = renderLocalLeadReport(result, { now: NOW });
  assert.match(targetReport, new RegExp(`\\| Pune \\(normal\\) \\| ${result.modes.normal.shortlist.length}\\/10 \\|`));
  assert.ok(result.verificationQueue.some((role) => role.company === 'Unclear Contract Employer'));
  assert.equal(result.modes.eorContract.results.some((role) => role.company === 'Unclear Contract Employer'), false);
});

test('stretch list keeps up to three exactly-three-year AI roles scoring 80+ from startup or remote listings outside mode targets', async () => {
  const { config } = testConfig();
  // Build normalized fixture roles with explicit exact-three-year evidence.
  const threeYears = (id, overrides) => rawPortalJob(id, { ...overrides, experience: { minYears: 3, maxYears: 3, evidence: '3 years required' } });
  const roles = [
    threeYears(1831, { company: 'Stretch Startup One', companyStage: 'Startup', startupStageEvidenceRef: 'https://portfolio.example.test/one', description: 'Full-time AI Engineer role requiring exactly 3 years of Python experience.' }),
    threeYears(1832, { company: 'Stretch Remote Two', location: 'Remote - India', title: 'AI-Native Full Stack Engineer', description: 'Full-time AI-native full stack engineer role requiring exactly 3 years of experience.' }),
    threeYears(1833, { company: 'Stretch Remote Three', location: 'Remote - India', title: 'Backend Engineer', description: 'Full-time Backend Engineer role requiring exactly 3 years of Python experience.' }),
    threeYears(1834, { company: 'Stretch Startup Four', companyStage: 'Startup', startupStageEvidenceRef: 'https://portfolio.example.test/four', description: 'Full-time Machine Learning Engineer role requiring exactly 3 years of experience.' }),
    threeYears(1835, { company: 'Stretch Low Score', location: 'Remote - India', description: 'Full-time AI Engineer role requiring exactly 3 years of experience.' }),
    rawPortalJob(1836, { company: 'Stretch Wrong Years', location: 'Remote - India', description: 'Full-time AI Engineer role requiring 4 years of experience.', experience: { minYears: 4, maxYears: 4, evidence: '4 years required' } }),
    threeYears(1837, { company: 'Stretch Wrong Listing', description: 'Full-time AI Engineer role requiring exactly 3 years of experience.' }),
  ];
  const sourceFixtures = { ...emptyLegacyFixtures(), 'portal-naukri': { candidates: roles, manifest: { status: 'ok' } } };
  const scorer = async (rows) => ({ scored: rows.map((row) => ({
      ...row,
      matchScore: row.company === 'Stretch Low Score' ? 79 : 85,
      responseLikelihood: 15,
      descriptionAvailable: true,
      rationale: 'Python overlap',
      strongestHook: 'Python skills',
      componentScores: { skillMatch: 30, domainRelevance: 15, seniorityFit: 10, locationFit: 10, responseLikelihood: 15 },
  })) });
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), { sourceFixtures, scorer }));
  const secondRun = await runDailyNormal(runOptions(config, fakeTransport({}), { runId: 'daily-stretch-second-run', sourceFixtures, scorer }));

  assert.equal(result.outcome.fatal, false);
  assert.deepEqual(result.stretch.map((role) => role.company), ['Stretch Startup One', 'Stretch Remote Two', 'Stretch Remote Three']);
  assert.deepEqual(secondRun.stretch, []);
  assert.equal(result.modes.normal.results.length + result.modes.startup.results.length + result.modes.remote.results.length, 0);
  assert.equal(result.modes.normal.shortlist.length + result.modes.startup.shortlist.length + result.modes.remote.shortlist.length, 0);
});

test('daily mode selection excludes EOR Stretch roles and keeps selected Stretch keys out of every mode', () => {
  const makeEntry = (company, lane = null) => {
    const candidate = {
      canonicalUrl: `https://jobs.example.test/${company.toLowerCase().replaceAll(' ', '-')}`,
      company, title: 'AI Engineer', location: 'Remote - India', matchScore: 85, responseLikelihood: 15, scoreOrigin: 'explicit-scored-input',
      roleFamily: 'ai-llm-agentic', employment: { type: 'full-time' },
      experience: { minYears: 3, maxYears: 3, evidence: '3 years required' },
    };
    return {
      candidate,
      eligibility: {
        eligible: true, strict: true, tier: 'strict', roleFamily: 'ai-llm-agentic', hardMinimumExactly3Years: true,
        geo: { mode: 'remote', code: 'GEO_REMOTE_INDIA_COMPATIBLE' },
        employment: { lane, labels: lane === 'eor-contract' ? ['EOR'] : [] },
      },
      freshness: { eligible: true, ageHours: 1, window: 'Hot' },
      readiness: { ready: true, evidence: {} },
    };
  };
  const entries = [makeEntry('Stretch Remote'), makeEntry('Stretch EOR', 'eor-contract')];
  const result = selectDailyModes(entries, {
    config: loadJobPullConfig(), maximum: 20, maximumPerCompany: 2, previousDailyCandidates: [],
  }, 'normal', { remaining: 3, otherKeys: [] });

  assert.deepEqual(result.stretch.map((role) => role.company), ['Stretch Remote']);
  assert.equal(result.modes.remote.results.some((role) => role.company === 'Stretch Remote'), false);
  assert.deepEqual(result.modes.eorContract.results.map((role) => role.company), ['Stretch EOR']);
  assert.equal(['normal', 'startup', 'remote'].some((mode) => result.modes[mode].results.some((role) => role.company === 'Stretch EOR')), false);
});

test('remote area names cannot route into Pune mode through partial alias matches', async () => {
  const { config } = testConfig();
  const roles = [
    rawPortalJob(1841, { company: 'Sussex Remote', location: 'Remote - Sussex', workMode: 'remote', description: 'Remote worldwide. Full-time AI Engineer for 0-1 years.' }),
    rawPortalJob(1842, { company: 'Maanchester Remote', location: 'Remote - Maanchester', workMode: 'remote', description: 'Remote worldwide. Full-time AI Engineer for 0-1 years.' }),
  ];
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: { ...emptyLegacyFixtures(), 'portal-naukri': { candidates: roles, manifest: { status: 'ok' } } },
  }));

  assert.equal(result.outcome.fatal, false);
  assert.deepEqual(result.modes.normal.results, []);
  assert.deepEqual(result.modes.remote.results.map((role) => role.company), ['Sussex Remote', 'Maanchester Remote']);
});

function greenhouseJob(id, companySlug, overrides = {}) {
  return {
    id,
    title: 'AI Engineer',
    absolute_url: `https://job-boards.greenhouse.io/${companySlug}/jobs/${id}`,
    location: { name: 'Pune, India' },
    content: 'Full-time AI Engineer role for 0-1 years building Python systems.',
    first_published: NOW,
    employment_type: 'Full-Time',
    ...overrides,
  };
}

function rawPortalJob(id, overrides = {}) {
  return {
    url: `https://naukri.example.test/job/${id}`,
    canonicalUrl: `https://naukri.example.test/job/${id}`,
    company: `Portal Company ${id}`,
    title: 'AI Engineer',
    location: 'Pune, India',
    description: 'Full-time AI Engineer role for 0-1 years building Python systems.',
    postedAt: NOW,
    employment: { type: 'full-time', evidence: 'full-time' },
    experience: { minYears: 0, maxYears: 1, evidence: '0-1 years' },
    liveness: { status: 'Active', checkedAt: NOW, evidence: 'employer page checked' },
    originalApplicationUrl: `https://company-${id}.example.test/careers/${id}`,
    originalApplicationEvidence: 'resolved employer careers posting',
    scoreOrigin: 'explicit-scored-input', responseLikelihood: 15,
    matchScore: 80,
    ...overrides,
  };
}

function writeWarmSet(root, boards = {}) {
  const file = path.join(root, 'reverse-warm-set.json');
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    updatedAt: NOW,
    boards: {
      greenhouse: boards.greenhouse ?? [],
      lever: boards.lever ?? [],
      ashby: boards.ashby ?? [],
      workday: boards.workday ?? [],
    },
  }));
  return file;
}

function testConfig({ warmBoards = [], trackedBoards = [] } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-daily-runner-'));
  const reverseWarmSetPath = writeWarmSet(root, { greenhouse: trackedBoards });
  return {
    root,
    config: {
      schemaVersion: 'LaunchpadCrawlerConfigV1',
      databasePath: path.join(root, 'crawler.sqlite'),
      opportunityLedgerPath: path.join(root, 'opportunity-ledger.tsv'),
      reverseWarmSetPath,
      sources: {
        atsWarm: {
          boards: warmBoards.map(({ slug, company }) => ({
            provider: 'greenhouse',
            slug,
            company,
            indiaFirst: true,
          })),
          maxBoards: 20,
          maxJobsPerBoard: 100,
        },
      },
    },
  };
}

function fakeTransport(jobsBySlug, calls = []) {
  return async (url) => {
    calls.push(url);
    const match = String(url).match(/\/boards\/([^/]+)\/jobs/);
    const slug = match ? decodeURIComponent(match[1]) : null;
    if (!slug || !Object.hasOwn(jobsBySlug, slug)) throw new Error(`unexpected transport call: ${url}`);
    return { status: 200, body: JSON.stringify({ jobs: jobsBySlug[slug] }) };
  };
}

function plannedOperations(shortlist, runId) {
  return shortlist.map((candidate) => {
    const canonicalUrl = candidate.canonicalUrl ?? candidate.url;
    const dedupKey = candidateDedupKey(candidate);
    return {
      operation: 'create',
      resource: 'application',
      dedupKey,
      payload: {
        name: `${candidate.title} — ${candidate.company}`,
        role: candidate.title,
        Company: candidate.company,
        jdLink: candidate.discoveryUrl || canonicalUrl,
        originalApplicationUrl: candidate.originalApplicationUrl,
        applicationResolution: candidate.applicationResolution?.status,
        applicationReady: true,
        postedDate: candidate.postedAt,
        discoveredAt: candidate.discoveredAt,
        crawledAt: candidate.crawledAt,
        freshnessTier: candidate.waterfallBand || candidate.freshnessWindow,
        status: 'Ready',
        makeResume: false,
        applied: false,
        resumeState: 'Not Started',
        employmentCategory: candidate.employment?.type === 'internship' ? 'Internship' : candidate.employment?.type === 'contract' ? 'Contractor/EOR' : 'Full-time',
        selectionTier: candidate.selectionTier,
        relaxation: candidate.relaxations || [],
        roleFamily: candidate.roleFamily || null,
        companyStage: candidate.companyStage || null,
        workMode: candidate.workMode ? candidate.workMode[0].toUpperCase() + candidate.workMode.slice(1) : null,
        location: candidate.location,
        matchScore: candidate.matchScore,
        conversionScore: candidate.conversionScore,
        responseLikelihood: candidate.responseLikelihood,
        source: candidate.source,
        provider: candidate.provider,
        sourceJobId: candidate.jobId,
        originalApplicationEvidence: candidate.originalApplicationEvidence || candidate.applicationResolution?.evidence || null,
        liveness: candidate.liveness?.status,
        requirementsEvidence: candidate.requirementsEvidence || candidate.evidence?.requirements || candidate.experience?.evidence || null,
        relaxationEvidence: candidate.readinessEvidence ?? null,
        rationale: candidate.rationale,
        hook: candidate.hook,
        runId,
        dedupKey,
        syncKey: dedupKey,
      },
      provenance: {
        discoveryUrl: candidate.discoveryUrl || canonicalUrl,
        discoverySource: candidate.discoverySource || candidate.evidence?.discovery?.source || candidate.source,
        discoveryCategory: candidate.discoveryCategory || candidate.evidence?.discovery?.category || candidate.sourceCategory,
        discoveryProvider: candidate.provider || candidate.evidence?.discovery?.provider,
        originalApplicationUrl: candidate.originalApplicationUrl,
        originalApplicationEvidence: candidate.originalApplicationEvidence || candidate.applicationResolution?.evidence || null,
        verifiedAt: candidate.verifiedAt || candidate.liveness?.checkedAt || null,
        postedAt: candidate.postedAt,
        discoveredAt: candidate.discoveredAt,
        crawledAt: candidate.crawledAt,
        location: candidate.location,
        citizenshipEvidence: candidate.citizenshipEvidence || candidate.remoteEligibility?.evidence || null,
        experience: candidate.experience,
        employment: candidate.employment,
        feesBonds: candidate.feeBondEvidence || null,
        liveness: candidate.liveness,
        score: candidate.matchScore,
        rationale: candidate.rationale,
        hook: candidate.hook,
        runId,
        dedupKey,
      },
    };
  });
}

function canaryEvidence(config, runId, shortlist = null) {
  return ({ shortlist: actualShortlist = shortlist ?? [], plannedNotionOperations = null, codeConfigVersion: actualVersion, inventoryIdentity: actualIdentity } = {}) => {
  const reportRoot = path.dirname(config.databasePath);
  const markdown = path.join(reportRoot, `${runId}-canary.md`);
  const json = path.join(reportRoot, `${runId}-canary.json`);
  const markdownBytes = `# Delivery canary ${runId}\n`;
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), encoding: 'utf8' }).trim();
  const codeConfigVersion = actualVersion ?? computeCanaryVersion({ config });
  const operations = plannedNotionOperations ?? plannedOperations(actualShortlist, runId);
  const inventoryIdentity = actualIdentity ?? computeDeliveryInventoryIdentity(actualShortlist, operations);
  writeFileSync(markdown, markdownBytes);
  writeFileSync(json, JSON.stringify({
    schemaVersion: DELIVERY_CANARY_SIDECAR_SCHEMA,
    runId,
    codeConfigVersion,
    revision,
    inventoryIdentity,
    markdownDigest: `sha256:${createHash('sha256').update(markdownBytes).digest('hex')}`,
  }));
  return {
    schemaVersion: DELIVERY_CANARY_EVIDENCE_SCHEMA,
    runId,
    codeConfigVersion,
    inventoryIdentity,
    engineering: {
      fatalScorerInfrastructureFailures: 0,
      sourceOutagesReportedHealthy: 0,
      selectedSuppressedRoles: 0,
      rolesSurfacedBeforeCommit: 0,
      duplicateRequisitionCollisions: 0,
      unattributedFunnelLoss: 0,
      durationMs: 1_000,
      reportComplete: true,
      reportPaths: { markdown, json },
      manualInventoryMatch: true,
    },
    reproducibility: { revision, clean: true, dirtyPaths: [] },
  };
  };
}

function runOptions(config, transport, overrides = {}) {
  const runId = overrides.runId === undefined
    ? `daily-${path.basename(path.dirname(config.databasePath))}`
    : overrides.runId;
  return {
    config,
    transport,
    clock: { now: () => NOW, sleep: async () => {} },
    runId,
    ledgerRows: [],
    opportunityLedgerRows: [],
    ...(runId && overrides.canaryEvidence === undefined ? {
      canaryEvidence: canaryEvidence(config, runId),
      canaryValidationOptions: { reportRoot: path.dirname(config.databasePath) },
    } : {}),
    ...overrides,
  };
}

function fakeWriteOptions(overrides = {}) {
  const gateway = overrides.gateway ?? createFakeTransactionalGateway();
  return {
    executeWrites: true,
    notionGatewayFactory: () => gateway,
    ...overrides,
  };
}

function emptyLegacyFixtures() {
  return Object.fromEntries(NORMAL_SOURCE_LANES.filter((lane) => lane.kind !== 'india-portal-search').map((lane) => [lane.id, { candidates: [], manifest: { status: 'empty' } }]));
}

test('crawler-v2 atsWarm observations feed reverse-ats-warm into the real Normal pipeline', async () => {
  const { config } = testConfig({
    warmBoards: [{ slug: 'crawler-board', company: 'Crawler Company' }],
  });
  const result = await runDailyNormal(runOptions(
    config,
    fakeTransport({ 'crawler-board': [greenhouseJob(101, 'crawler-board')] }),
  ));

  // Real crawler-sourced candidates carry no Match Score, so they correctly
  // land in the scoring queue rather than the shortlist (ticket 06).
  assert.deepEqual(result.scoringQueue.map((candidate) => candidate.company), ['Crawler Company']);
  assert.equal(result.scoringQueue[0].normalLaneId, 'reverse-ats-warm');
  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'reverse-ats-warm');
  assert.equal(manifest.fetched, 1);
  assert.equal(manifest.required, true);
  assert.equal(manifest.optional, false);
});

test('board rotation state round-trips through a temporary file', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-board-rotation-'));
  const file = path.join(root, 'nested', 'board-rotation-state.json');
  const state = {
    cursor: 2,
    providerCursors: { greenhouse: 3 },
    lastAttemptByBoard: { 'greenhouse:board-a': NOW },
  };

  const saved = saveBoardRotationState(file, state, NOW);

  assert.deepEqual(loadBoardRotationState(file), {
    schemaVersion: 1,
    updatedAt: NOW,
    ...state,
  });
  assert.deepEqual(saved, loadBoardRotationState(file));
});

test('consecutive daily runs rotate tracked warm boards using persisted state', async () => {
  const { config } = testConfig({ trackedBoards: ['board-a', 'board-b', 'board-c', 'board-d'] });
  const rotationStatePath = path.join(path.dirname(config.databasePath), 'rotation', 'state.json');
  config.sources.trackedAts = { maxBoards: 2, rotationStatePath };
  const calls = [];
  const transport = fakeTransport({
    'board-a': [],
    'board-b': [],
    'board-c': [],
    'board-d': [],
  }, calls);

  await runDailyNormal(runOptions(config, transport, { runId: 'rotation-first' }));
  const firstBoards = calls.splice(0).map((url) => url.match(/\/boards\/([^/]+)\/jobs/)?.[1]).filter(Boolean);
  await runDailyNormal(runOptions(config, transport, { runId: 'rotation-second' }));
  const secondBoards = calls.map((url) => url.match(/\/boards\/([^/]+)\/jobs/)?.[1]).filter(Boolean);

  assert.equal(firstBoards.length, 2);
  assert.equal(secondBoards.length, 2);
  assert.notDeepEqual(secondBoards, firstBoards);
  assert.equal(loadBoardRotationState(rotationStatePath).updatedAt, NOW);
});

test('runDailyNormal defaults the crawler discovery profile', async () => {
  const { config } = testConfig();
  const store = openCrawlerStore(config.databasePath);
  const runId = 'daily-default-profile';
  try {
    await runDailyNormal(runOptions(config, fakeTransport({}), { runId, store }));
    const row = store.prepare('SELECT schedule, config_json FROM crawl_runs WHERE run_id = ?').get(`${runId}-crawler-v2`);
    const profile = JSON.parse(row.config_json).discoveryProfile;
    assert.equal(row.schedule, 'morning');
    assert.equal(profile.schedule, 'morning');
    assert.equal(profile.mode, 'normal');
    assert.equal(profile.locationPreset, 'india');
  } finally {
    store.close();
  }
});

test('the scorer timeout keeps its floor when discovery leaves almost no time', async () => {
  const execution = createDailyExecution({ execution: { wholeRunDeadlineMs: 1 } }, NOW);
  try {
    assert.ok(execution.remainingMs() <= 1);
    assert.equal(Math.max(execution.scorerFloorMs, execution.remainingMs()), 300_000);
  } finally {
    execution.cleanup();
  }
});

test('the twenty-minute execution contract reserves discovery and handoff windows', () => {
  const execution = createDailyExecution({ execution: { wholeRunDeadlineMs: 1_200, downstreamReserveMs: 300 } }, NOW);
  try {
    assert.equal(execution.discoveryBudgetMs, 720);
    assert.equal(execution.handoffReserveMs, 180);
    assert.ok(execution.sourceBudget().deadlineMs <= execution.startedAt + 720);
    assert.ok(execution.downstreamRemainingMs() <= 1_020);
  } finally {
    execution.cleanup();
  }
});

test('tracked warm-set observations feed tracked-ats into the real Normal pipeline', async () => {
  const { config } = testConfig({ trackedBoards: ['tracked-board'] });
  const result = await runDailyNormal(runOptions(
    config,
    fakeTransport({ 'tracked-board': [greenhouseJob(201, 'tracked-board')] }),
  ));

  // Real crawler-sourced candidates carry no Match Score, so they correctly
  // land in the scoring queue rather than the shortlist (ticket 06).
  assert.deepEqual(result.scoringQueue.map((candidate) => candidate.company), ['tracked-board']);
  assert.equal(result.scoringQueue[0].normalLaneId, 'tracked-ats');
  assert.equal(result.sourceManifests.find(({ sourceId }) => sourceId === 'tracked-ats').fetched, 1);
});

test('bounded planner owns tracked ATS coverage without a second warm fetch', async () => {
  const { config } = testConfig({ warmBoards: [{ slug: 'one-owner', company: 'One Owner' }] });
  config.sourcePlanner = { enabled: true, legacyPlannerRollback: false, maxBoards: 1, priorityShare: 0.8, explorationShare: 0.2 };
  const calls = [];
  const result = await runDailyNormal(runOptions(config, fakeTransport({ 'one-owner': [greenhouseJob(777, 'one-owner')] }, calls), { runId: 'bounded-planner-owner' }));
  assert.equal(calls.length, 1);
  const tracked = result.sourceManifests.find(({ sourceId }) => sourceId === 'tracked-ats');
  assert.equal(tracked.firstPassOwner, 'ats-warm');
  assert.equal(tracked.duplicateFetches, 0);
  assert.equal(tracked.fetched, 0);
  assert.equal(result.crawlerV2Telemetry['ats-warm'].boardPlan.boardsSelected, 1);
});

test('legacy planner rollback filters tracked boards already owned by the first crawler pass', async () => {
  const configBefore = readFileSync(path.resolve('config/crawler-v2.json'), 'utf8');
  const { config } = testConfig({
    warmBoards: [{ slug: 'shared-board', company: 'Shared Board' }],
    trackedBoards: ['shared-board', 'legacy-only'],
  });
  config.sourcePlanner = { enabled: true, legacyPlannerRollback: true };
  const calls = [];
  const result = await runDailyNormal(runOptions(
    config,
    fakeTransport({ 'shared-board': [], 'legacy-only': [] }, calls),
    { runId: 'legacy-planner-dedupe' },
  ));

  const fetchedBoards = calls.map((url) => url.match(/\/boards\/([^/]+)\/jobs/)?.[1]).filter(Boolean);
  assert.deepEqual(fetchedBoards.sort(), ['legacy-only', 'shared-board']);
  const tracked = result.sourceManifests.find(({ sourceId }) => sourceId === 'tracked-ats');
  assert.equal(tracked.firstPassOwner, 'tracked-ats');
  assert.equal(tracked.duplicateFetches, 0);
  assert.deepEqual(tracked.deduplicatedBoardIds, ['greenhouse:shared-board']);
  assert.equal(readFileSync(path.resolve('config/crawler-v2.json'), 'utf8'), configBefore);
});

test('caller-supplied fixtures for other Normal lanes are preserved', async () => {
  const { config } = testConfig();
  const portalJob = rawPortalJob(301);
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      'portal-naukri': {
        candidates: [portalJob],
        manifest: { status: 'ok', fixture: 'caller-owned' },
      },
    },
  }));

  assert.deepEqual(result.shortlist.map((candidate) => candidate.company), ['Portal Company 301']);
  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'portal-naukri');
  assert.equal(manifest.fixture, 'caller-owned');
  assert.equal(manifest.fetched, 1);
});

test('crawlerV2Telemetry is diagnostic-only and leaves the shortlist unchanged', async () => {
  const firstSetup = testConfig({
    warmBoards: [{ slug: 'telemetry-board', company: 'Telemetry Company' }],
  });
  const first = await runDailyNormal(runOptions(
    firstSetup.config,
    fakeTransport({ 'telemetry-board': [greenhouseJob(401, 'telemetry-board')] }),
  ));
  const beforeInspection = first.shortlist.map(({ canonicalUrl, normalLaneId }) => ({ canonicalUrl, normalLaneId }));

  assert.ok(first.crawlerV2Telemetry['ats-warm']);
  JSON.stringify(first.crawlerV2Telemetry);
  assert.deepEqual(
    first.shortlist.map(({ canonicalUrl, normalLaneId }) => ({ canonicalUrl, normalLaneId })),
    beforeInspection,
  );
});

test('historicalV4Rows suppress crawler-fed duplicates before Normal shortlist planning', async () => {
  const { config } = testConfig({
    warmBoards: [{ slug: 'historical-board', company: 'Historical Company' }],
  });
  const result = await runDailyNormal(runOptions(
    config,
    fakeTransport({ 'historical-board': [greenhouseJob(501, 'historical-board')] }),
    {
      historicalV4Rows: [{
        company: 'Historical Company',
        title: 'AI Engineer',
        location: 'Pune, India',
        state: 'applied',
      }],
    },
  ));

  assert.equal(result.shortlist.length, 0);
  assert.equal(result.plannedNotionOperations.length, 0);
  assert.equal(result.historicalSuppressions.length, 1);
  assert.equal(result.counts.historicalSuppressed, 1);
  assert.equal(result.dailyReceipt.scopes.historySuppression.count, 1, JSON.stringify({ suppressions: result.historicalSuppressions, rows: result.dailyReceipt.retained.identityRows }));
  assert.equal(result.dailyReceipt.retained.identityRows.filter((row) => row.stage === 'historySuppression').length, 1);
});

test('lanes outside crawler-v2 and tracked ATS stay truthfully unavailable', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({})));
  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'portal-foundit');

  assert.equal(manifest.status, 'unavailable');
  assert.equal(manifest.attempted, false);
  assert.equal(manifest.reasonCode, 'PORTAL_REQUIRES_LIVE_INJECTION');
  assert.equal(result.shortfall.failedLanes.includes('portal-foundit'), false);
});

test('an empty tracked warm set produces an attempted empty lane without transport calls', async () => {
  const { config } = testConfig();
  const calls = [];
  const result = await runDailyNormal(runOptions(config, fakeTransport({}, calls)));
  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'tracked-ats');

  assert.equal(calls.length, 0);
  assert.equal(manifest.attempted, true);
  assert.equal(manifest.status, 'empty');
  assert.equal(manifest.fetched, 0);
});

test('unified daily mode exposes every new optional lane in the scored pool', async () => {
  const { config } = testConfig();
  const laneIds = ['expanded-ats', 'structured-career-pages', 'web-discovery', 'connector-inbox'];
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: Object.fromEntries(laneIds.map((laneId, index) => [laneId, {
      candidates: [rawPortalJob(700 + index, { company: `${laneId} company` })],
      manifest: { status: 'ok', source: 'unified-fixture' },
    }])),
  }));

  assert.equal(result.counts.scored, laneIds.length);
  for (const laneId of laneIds) {
    const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === laneId);
    assert.equal(manifest.fetched, 1);
    assert.equal(manifest.optional, true);
    assert.ok(result.shortlist.some((candidate) => candidate.normalLaneId === laneId));
  }
});

test('unconfigured unified crawler lanes remain optional without degrading an otherwise empty run', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: emptyLegacyFixtures(),
  }));

  assert.equal(result.outcome.status, 'ok');
  for (const laneId of ['expanded-ats', 'structured-career-pages', 'web-discovery', 'connector-inbox']) {
    const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === laneId);
    assert.equal(manifest.status, 'unavailable');
    assert.equal(manifest.optional, true);
    assert.equal(result.shortfall.failedLanes.includes(laneId), false);
  }
});

test('daily startup company careers source feeds Startup mode and reports a terminal state', async () => {
  const { config } = testConfig();
  config.sources.startup = { companyCareers: [{ company: 'Career Lane Startup', websiteUrl: 'https://startupcareers.example.test/' }] };
  const calls = [];
  const result = await runDailyNormal(runOptions(config, async (url) => {
    calls.push(url);
    if (url.endsWith('/robots.txt')) return { status: 200, body: 'User-agent: *\nAllow: /' };
    if (url === 'https://startupcareers.example.test/') return {
      status: 200,
      body: `<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting', title: 'AI Engineer', datePosted: NOW,
        description: 'Full-time AI Engineer role in Pune for 0-1 years using Python.',
        hiringOrganization: { name: 'Career Lane Startup' },
        jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
        sameAs: 'https://startupcareers.example.test/jobs/ai-engineer',
      })}</script>`,
    };
    if (url === 'https://startupcareers.example.test/sitemap.xml') return { status: 404, body: '' };
    throw new Error(`unexpected career request: ${url}`);
  }, {
    scorer: async (rows) => ({ scored: rows.map((row) => ({ ...row, matchScore: 80, responseLikelihood: 15, descriptionAvailable: true, rationale: 'Python overlap', strongestHook: 'Python skills', componentScores: { skillMatch: 30, domainRelevance: 15, seniorityFit: 10, locationFit: 10, responseLikelihood: 15 } })) }),
  }));

  assert.ok(calls.length >= 2);
  assert.equal(result.outcome.fatal, false, JSON.stringify(result.outcome));
  assert.equal(result.sourceManifests.find(({ sourceId }) => sourceId === 'startup-company-careers').status, 'ok');
  assert.deepEqual(result.modes.startup.results.map(({ company, primaryMode, otherModes }) => [company, primaryMode, otherModes]), [['Career Lane Startup', 'startup', ['normal']]]);
});

test('empty startup company careers source has a reason in the daily run', async () => {
  const { config } = testConfig();
  config.sources.startup = { companyCareers: [] };
  const result = await runDailyNormal(runOptions(config, fakeTransport({})));
  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'startup-company-careers');

  assert.equal(manifest.status, 'empty');
  assert.equal(manifest.reason, 'no-company-career-sites-configured');
});

test('a failing optional crawler lane reports its failure while another lane still delivers', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'structured-career-pages': {
        candidates: [rawPortalJob(801, { company: 'Career Page Company' })],
        manifest: { status: 'ok' },
      },
    },
    sourceFunctions: {
      'expanded-ats': () => { throw new Error('expanded ATS fixture failed'); },
    },
  }));

  const failed = result.sourceManifests.find(({ sourceId }) => sourceId === 'expanded-ats');
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.errors, ['expanded ATS fixture failed']);
  assert.ok(result.shortfall.failedLanes.includes('expanded-ats'));
  assert.deepEqual(result.shortlist.map((candidate) => candidate.company), ['Career Page Company']);
});

test('a partial optional lane does not degrade the run, but a failed optional lane does', async () => {
  const { config } = testConfig();
  const partial = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'structured-career-pages': {
        candidates: [rawPortalJob(802, { company: 'Partial Career Page Company' })],
        manifest: { status: 'degraded', errors: ['one source failed'] },
      },
    },
  }));
  assert.equal(partial.outcome.status, 'ok');
  assert.equal(partial.shortfall.failedLanes.includes('structured-career-pages'), false);
  assert.deepEqual(partial.sourceManifests.find(({ sourceId }) => sourceId === 'structured-career-pages').errors, ['one source failed']);

  const failed = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'structured-career-pages': {
        candidates: [],
        manifest: { status: 'failed', errors: ['all sources failed'] },
      },
    },
  }));
  assert.equal(failed.outcome.status, 'degraded');
  assert.ok(failed.shortfall.failedLanes.includes('structured-career-pages'));
});

test('degraded tracked ATS is terminal coverage, not a not-started source', async () => {
  const { config } = testConfig({ trackedBoards: ['tracked-good', 'tracked-timeout'] });
  const transport = async (url) => {
    if (url.includes('/boards/tracked-timeout/jobs')) throw new Error('warm transport timed out');
    if (url.includes('/boards/tracked-good/jobs')) {
      return { status: 200, body: JSON.stringify({ jobs: [greenhouseJob(901, 'tracked-good')] }) };
    }
    return { status: 200, body: JSON.stringify({ jobs: [] }) };
  };
  const result = await runDailyNormal(runOptions(config, transport, {
    scorer: async (candidates) => ({
      scored: candidates.map((candidate) => ({ ...candidate, matchScore: 80, responseLikelihood: 15, descriptionAvailable: true, rationale: 'Python overlap', strongestHook: 'Python skills', componentScores: { skillMatch: 30, domainRelevance: 15, seniorityFit: 10, locationFit: 10, responseLikelihood: 15 } })),
      failures: [],
      chunks: 1,
    }),
  }));

  assert.equal(result.sourceManifests.find(({ sourceId }) => sourceId === 'tracked-ats').status, 'degraded');
  assert.ok(
    result.terminalEnvelope.completedSources.includes('tracked-ats'),
    JSON.stringify(result.terminalEnvelope.sourceCoverage),
  );
  assert.equal(result.terminalEnvelope.notStartedSources.includes('tracked-ats'), false);
});

test('warm-ATS failure messages retain provider, board, and code provenance', async () => {
  const { config } = testConfig({ trackedBoards: ['warm-failure-board'] });
  const result = await runDailyNormal(runOptions(config, async () => {
    throw new Error('warm transport failed');
  }));

  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'tracked-ats');
  assert.deepEqual(manifest.errors, ['greenhouse: warm-failure-board: TRANSPORT_ERROR: warm transport failed']);
});

test('TheirStack maps to connector-inbox with provider and source telemetry retained', () => {
  const fixture = crawlerLaneFixtures({
    observations: [rawPortalJob(803, { company: 'TheirStack Company', provider: 'theirstack', sourceId: 'theirstack' })],
    failures: [],
    sourceTelemetry: { theirstack: { attempts: 1, fetched: 1, detail: { telemetry: { creditsUsed: 1 } } } },
  })['connector-inbox'];

  assert.ok(fixture);
  assert.equal(fixture.candidates[0].provider, 'theirstack');
  assert.equal(fixture.manifest.unmappedSourceIds, undefined);
  assert.deepEqual(fixture.manifest.telemetry.sourceIds, ['theirstack']);
  assert.equal(fixture.manifest.telemetry.sources.theirstack.fetched, 1);
  assert.equal(fixture.manifest.telemetry.sources.theirstack.detail.telemetry.creditsUsed, 1);
});

test('unmapped crawler source ids feed web-discovery and remain visible without stopping the run', async () => {
  const crawlerFixture = crawlerLaneFixtures({
    observations: [rawPortalJob(803, { company: 'Unmapped Source Company', sourceId: 'future-source' })],
    failures: [{ sourceId: 'future-source', message: 'future source failed' }],
    sourceTelemetry: { 'future-source': { attempts: 1, fetched: 1 } },
  })['web-discovery'];
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'web-discovery': crawlerFixture,
    },
  }));

  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'web-discovery');
  assert.deepEqual(manifest.unmappedSourceIds, ['future-source']);
  assert.equal(manifest.fetched, 1);
  assert.equal(result.outcome.status, 'ok');
});

test('re-running the unified run id against the same durable store is idempotent', async () => {
  const { config } = testConfig({
    warmBoards: [{ slug: 'idempotent-board', company: 'Idempotent Company' }],
  });
  const store = openCrawlerStore(config.databasePath);
  const calls = [];
  try {
    const options = runOptions(config, fakeTransport({ 'idempotent-board': [greenhouseJob(901, 'idempotent-board')] }, calls), {
      store,
      runId: 'daily-idempotent',
    });
    await runDailyNormal(options);
    await runDailyNormal(options);
    const observationCount = store.prepare('SELECT COUNT(*) AS count FROM job_observations WHERE run_id = ?').get('daily-idempotent-crawler-v2').count;
    assert.equal(observationCount, 1);
    assert.equal(calls.length, 1);
  } finally {
    store.close();
  }
});

test('an unscored eligible candidate fails the unified run before shortlist delivery', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      'portal-naukri': {
        candidates: [rawPortalJob(1001, { matchScore: undefined })],
        manifest: { status: 'ok' },
      },
    },
  }));

  assert.equal(result.outcome.status, 'fatal');
  assert.deepEqual(result.shortlist, []);
  assert.equal(result.scoringQueue[0].scoringStatus, 'unscored');
  assert.match(result.outcome.errors[0].message, /unscored=1/);
});

test('a scoring failure fails the unified run and surfaces its cause', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      'portal-naukri': {
        candidates: [rawPortalJob(1002, { scoringFailed: true, scoringError: 'rubric service unavailable' })],
        manifest: { status: 'ok' },
      },
    },
  }));

  assert.equal(result.outcome.status, 'fatal');
  assert.deepEqual(result.shortlist, []);
  assert.equal(result.scoringQueue[0].scoringStatus, 'scoring-failed');
  assert.equal(result.scoringQueue[0].scoringFailureReason, 'rubric service unavailable');
  assert.equal(result.dailyReceipt.scopes.scoringFailure.count, 1);
  assert.equal(result.dailyReceipt.retained.identityRows[0].reason, 'rubric service unavailable');
  assert.match(result.outcome.errors[0].message, /rubric service unavailable/);
});

test('the run maximum is applied after all candidates receive Match Score', async () => {
  const { config } = testConfig();
  const candidates = Array.from({ length: 21 }, (_, index) => rawPortalJob(1100 + index, {
    company: `Cap Company ${index}`,
    matchScore: index === 20 ? 99 : 60,
  }));
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      'portal-naukri': { candidates, manifest: { status: 'ok' } },
    },
  }));

  assert.equal(result.counts.eligible, 21);
  assert.equal(result.counts.scored, 21);
  assert.equal(result.counts.selected, 20);
  assert.ok(result.shortlist.some((candidate) => candidate.company === 'Cap Company 20' && candidate.matchScore === 99));
  assert.ok(result.shortlist.every((candidate) => Number.isFinite(candidate.matchScore) && Number.isFinite(candidate.conversionScore)));
});

test('reconciliation reports eligible, scored, ready, and selected counts with named causes', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      'portal-naukri': {
        candidates: [
          rawPortalJob(1201, { company: 'Reconciliation Scored' }),
          rawPortalJob(1202, { company: 'Reconciliation Unscored', matchScore: undefined }),
        ],
        manifest: { status: 'ok' },
      },
    },
  }));

  assert.deepEqual(
    {
      eligible: result.reconciliation.eligible,
      scored: result.reconciliation.scored,
      ready: result.reconciliation.ready,
      selected: result.reconciliation.selected,
    },
    { eligible: 2, scored: 1, ready: 2, selected: 0 },
  );
  assert.match(result.reconciliation.line, /eligible=2; scored=1; ready=2; selected=0/);
  assert.match(result.reconciliation.line, /readyToScored:UNSCORED=1/);
});

test('the unified run reads the v4 snapshot by default and suppresses matching roles', async () => {
  const { root, config } = testConfig({
    warmBoards: [{ slug: 'snapshot-board', company: 'Snapshot Company' }],
  });
  const snapshotPath = path.join(root, 'v4-history-snapshot.json');
  writeFileSync(snapshotPath, JSON.stringify({
    generatedAt: NOW,
    rows: [{ company: 'Snapshot Company', title: 'AI Engineer', location: 'Pune, India', state: 'applied' }],
  }));
  config.v4HistorySnapshotPath = snapshotPath;

  const result = await runDailyNormal(runOptions(
    config,
    fakeTransport({ 'snapshot-board': [greenhouseJob(1301, 'snapshot-board')] }),
  ));

  assert.equal(result.v4HistorySnapshot.status, 'loaded');
  assert.equal(result.shortlist.length, 0);
  assert.equal(result.historicalSuppressions.length, 1);
  assert.equal(result.counts.historicalSuppressed, 1);
});

test('snapshot status is surfaced in daily telemetry for loaded, missing, stale, and malformed files', async () => {
  const outcomes = [
    ['loaded', { generatedAt: NOW, rows: [] }],
    ['missing', null],
    ['stale', { generatedAt: '2026-01-01T00:00:00.000Z', rows: [] }],
    ['malformed', { notRows: true }],
  ];

  for (const [status, payload] of outcomes) {
    const { root, config } = testConfig();
    const snapshotPath = path.join(root, `${status}.json`);
    if (payload) writeFileSync(snapshotPath, JSON.stringify(payload));
    config.v4HistorySnapshotPath = snapshotPath;
    const result = await runDailyNormal(runOptions(config, fakeTransport({})));
    assert.equal(result.telemetry.v4HistorySnapshot.status, status);
  }
});

test('a stale snapshot warns and still supplies historical rows', async () => {
  const { root, config } = testConfig({
    warmBoards: [{ slug: 'stale-board', company: 'Stale Company' }],
  });
  const snapshotPath = path.join(root, 'stale.json');
  writeFileSync(snapshotPath, JSON.stringify({
    generatedAt: '2026-01-01T00:00:00.000Z',
    rows: [{ company: 'Stale Company', title: 'AI Engineer', location: 'Pune, India', state: 'rejected' }],
  }));
  config.v4HistorySnapshotPath = snapshotPath;

  const result = await runDailyNormal(runOptions(
    config,
    fakeTransport({ 'stale-board': [greenhouseJob(1302, 'stale-board')] }),
  ));

  assert.equal(result.v4HistorySnapshot.status, 'stale');
  assert.match(result.v4HistorySnapshot.warning, /stale/);
  assert.equal(result.historicalSuppressions.length, 1);
  assert.equal(result.outcome.fatal, false);
});

test('missing or malformed snapshots supply no history and do not fail the run', async () => {
  for (const payload of [null, '{not json']) {
    const { root, config } = testConfig();
    const snapshotPath = path.join(root, 'bad-snapshot.json');
    if (payload === null) {
      config.v4HistorySnapshotPath = snapshotPath;
    } else {
      writeFileSync(snapshotPath, payload);
      config.v4HistorySnapshotPath = snapshotPath;
    }

    const result = await runDailyNormal(runOptions(
      config,
      fakeTransport({}),
      {
        sourceFixtures: {
          'portal-naukri': {
            candidates: [rawPortalJob(1303, { company: 'New Company' })],
            manifest: { status: 'ok' },
          },
        },
      },
    ));

    assert.equal(result.v4HistorySnapshot.status, payload === null ? 'missing' : 'malformed');
    assert.equal(result.historicalSuppressions.length, 0);
    assert.equal(result.outcome.fatal, false);
  }
});

test('web discovery returns fixture leads after a partial first-query engine outage', async () => {
  const { config } = testConfig();
  config.sources.searxng = {
    enabled: true,
    endpoint: 'http://127.0.0.1:8080',
    dailyBudget: 2,
    perQueryResultCap: 10,
    queries: ['"AI Engineer" Pune fresher jobs', '"Backend Engineer" Python Pune graduate jobs'],
  };
  const result = await runDailyNormal(runOptions(config, async (url) => {
    const query = new URL(url).searchParams.get('q');
    return {
      status: 200,
      body: JSON.stringify(query === config.sources.searxng.queries[0]
        ? { results: [], unresponsive_engines: [['brave', 'timeout']] }
        : { results: [{
          title: 'Backend Engineer - Acme',
          url: 'https://jobs.lever.co/acme/backend-1',
          content: 'Full-time Backend Engineer in Pune, India, for 0-1 years building Python systems.',
        }], unresponsive_engines: [] }),
    };
  }));

  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'web-discovery');
  assert.equal(manifest.fetched, 1);
  assert.equal(manifest.telemetry.queryDiagnostics[1].status, 'success');
  assert.equal(manifest.telemetry.sources['searxng-search'].detail.telemetry.budgetUsed, 2);
  assert.equal(result.shortlist.length, 0, 'search snippets do not establish readiness');
});

test('empty web-discovery daily manifests explain budget, outage, and no-hit outcomes', async () => {
  const cases = [
    { reason: 'query-budget-zero', dailyBudget: 0, body: { results: [] } },
    { reason: 'search-engines-degraded', dailyBudget: 1, body: { results: [], unresponsive_engines: [['brave', 'timeout']] } },
    { reason: 'malformed-search-response', dailyBudget: 1, body: { error: 'invalid query' } },
    { reason: 'no-search-results', dailyBudget: 1, body: { results: [], unresponsive_engines: [] } },
  ];
  for (const { reason, dailyBudget, body } of cases) {
    const { config } = testConfig();
    config.sources.searxng = {
      enabled: true,
      endpoint: 'http://127.0.0.1:8080',
      dailyBudget,
      queries: ['"AI Engineer" Pune fresher jobs'],
    };
    const result = await runDailyNormal(runOptions(config, async () => ({ status: 200, body: JSON.stringify(body) })));
    const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'web-discovery');
    assert.equal(manifest.status, 'empty');
    assert.equal(manifest.reason, reason);
    assert.deepEqual(manifest.telemetry.emptyReasons, [{ sourceId: 'searxng-search', reason }]);
  }
});

test('unified daily run reports SearXNG health per query in the web-discovery lane', async () => {
  const { config } = testConfig();
  config.sources.searxng = {
    enabled: true,
    endpoint: 'http://127.0.0.1:8080',
    dailyBudget: 2,
    perQueryResultCap: 10,
    queries: ['healthy query', 'blocked query'],
  };
  const result = await runDailyNormal(runOptions(config, async (url) => {
    const query = new URL(url).searchParams.get('q');
    return query === 'blocked query'
      ? { status: 206, body: JSON.stringify({ results: [], unresponsive_engines: [['brave', 'timeout']] }) }
      : { status: 200, body: JSON.stringify({ results: [], unresponsive_engines: [] }) };
  }));

  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'web-discovery');
  assert.deepEqual(manifest.telemetry.queryDiagnostics.map(({ query, responseStatus, status, engineHealth, unresponsiveEngines }) => ({
    query, responseStatus, status, engineHealth, unresponsiveEngines,
  })), [
    { query: 'healthy query', responseStatus: 200, status: 'success', engineHealth: 'healthy-empty', unresponsiveEngines: [] },
    { query: 'blocked query', responseStatus: 206, status: 'degraded', engineHealth: 'degraded', unresponsiveEngines: [['brave', 'timeout']] },
  ]);
});

test('a capped enterprise source remains visibly truncated in the unified run', async () => {
  const { config } = testConfig();
  config.sources.enterprise = {
    boards: [{ provider: 'workday', company: 'Capped Enterprise', url: 'https://capped.wd1.myworkdayjobs.com/jobs' }],
    maxPages: 1,
    maxJobsPerBoard: 1,
  };
  const result = await runDailyNormal(runOptions(config, async (url, options) => {
    assert.equal(options.method, 'POST');
    return { status: 200, headers: {}, body: JSON.stringify({ total: 2, jobPostings: [
      { title: 'AI Engineer', externalPath: '/job/1', locations: ['Pune, India'], postedOn: NOW, jobReqId: 'WD-1' },
      { title: 'Backend Engineer', externalPath: '/job/2', locations: ['Pune, India'], postedOn: NOW, jobReqId: 'WD-2' },
    ] }) };
  }));

  const telemetry = result.crawlerV2Telemetry['ats-enterprise'];
  assert.equal(telemetry.status, 'truncated');
  assert.equal(telemetry.truncated, true);
  assert.equal(telemetry.naturalTerminal, false);
  assert.equal(telemetry.capHit, 'maxJobsPerBoard');
  assert.equal(telemetry.recordsNotExamined, 1);
});

test('enterprise deadline returns a no-write partial envelope and resumes the same run without duplicate observations', async () => {
  const { config } = testConfig();
  config.sources.enterprise = {
    boards: [
      { provider: 'workday', company: 'Resumable Enterprise', url: 'https://resumable.wd1.myworkdayjobs.com/jobs' },
    ],
    maxPages: 2,
    maxJobsPerBoard: 10,
    enrichDetails: false,
  };
  config.execution = {
    wholeRunDeadlineMs: 1_000,
    discoveryBudgetMs: 600,
    handoffReserveMs: 100,
    downstreamReserveMs: 100,
    perSourceMaxDurationMs: 600,
    minimumSourceStartAllocationMs: 1,
  };
  let calls = 0;
  let completed = false;
  const transport = async (url) => {
    calls += 1;
    if (calls === 2 && !completed) {
      const error = new Error('injected daily discovery deadline');
      error.code = 'DAILY_DEADLINE_EXCEEDED';
      throw error;
    }
    return { status: 200, headers: {}, body: JSON.stringify({ total: 2, jobPostings: [{ title: 'AI Engineer', externalPath: '/job/1', locations: ['Pune, India'], postedOn: NOW, jobReqId: 'WD-1' }] }) };
  };
  let prohibited = 0;
  let factoryCalls = 0;
  const gateway = createFakeTransactionalGateway();
  const options = runOptions(config, transport, {
    runId: 'daily-partial-resume',
    executeWrites: true,
    notionGatewayFactory: () => { factoryCalls += 1; return gateway; },
    opportunityLedgerWriter: () => { if (!completed) prohibited += 1; return { path: config.opportunityLedgerPath, rows: [] }; },
    notionGateway: { planWrites({ operations }) { if (!completed) prohibited += 1; return operations; } },
    scorer: async (rows) => ({ scored: rows.map((row) => ({ ...row, matchScore: 80, responseLikelihood: 15, descriptionAvailable: true, rationale: 'Python overlap', strongestHook: 'Python skills', componentScores: { skillMatch: 30, domainRelevance: 15, seniorityFit: 10, locationFit: 10, responseLikelihood: 15 } })) }),
  });
  const validCanaryEvidence = options.canaryEvidence;
  options.canaryEvidence = (...args) => {
    if (!completed) prohibited += 1;
    return validCanaryEvidence(...args);
  };
  const partial = await runDailyNormal(options);
  assert.equal(partial.terminalEnvelope.status, 'partial');
  assert.equal(partial.observations.length, 1);
  assert.equal(partial.terminalEnvelope.writesPlanned, false);
  assert.ok(partial.terminalEnvelope.interruptedSources.includes('ats-enterprise'));
  assert.equal(partial.terminalEnvelope.failedSources.length, 0);
  assert.equal(partial.surfaced, 0);
  assert.equal(partial.deliveryCanary, null);
  assert.equal(prohibited, 0);
  assert.equal(factoryCalls, 0);

  completed = true;
  const resumed = await runDailyNormal({ ...options, config: { ...config, execution: { ...config.execution, discoveryBudgetMs: 800 } } });
  assert.equal(resumed.terminalEnvelope.status, 'completed');
  assert.equal(resumed.terminalEnvelope.interruptedSources.length, 0);
  assert.equal(resumed.terminalEnvelope.runId, partial.terminalEnvelope.runId);
  const store = openCrawlerStore(config.databasePath);
  assert.equal(store.prepare('SELECT COUNT(*) AS count FROM job_observations').get().count, 1);
  store.close();
  assert.equal(factoryCalls, resumed.deliveryPlan.selectedCount > 0 ? 1 : 0);
  assert.ok(calls >= 3);
});

test('Indian portal lanes are optional and explain why each one produced nothing', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: emptyLegacyFixtures(),
  }));
  // Three groups, three honest explanations. A lane that owns a working adapter
  // must not keep claiming it is waiting on injection.
  const expected = {
    'portal-foundit': 'PORTAL_REQUIRES_LIVE_INJECTION',
    'portal-hirist': 'PORTAL_REQUIRES_LIVE_INJECTION',
    'portal-cutshort': 'PORTAL_REQUIRES_LIVE_INJECTION',
    'portal-peerlist': 'PORTAL_REQUIRES_LIVE_INJECTION',
    // Probed 2026-08-22: 406 recaptcha over HTTP, 403 + captcha in real Chromium.
    'portal-naukri': 'PORTAL_BLOCKED_REQUIRES_RESCUE',
    // These own adapters; with no transport injected they are simply unavailable.
    'portal-linkedin-jobs': 'OPTIONAL_SOURCE_UNAVAILABLE',
    'portal-glassdoor': 'OPTIONAL_SOURCE_UNAVAILABLE',
    'portal-instahyre': 'OPTIONAL_SOURCE_UNAVAILABLE',
    'portal-wellfound': 'OPTIONAL_SOURCE_UNAVAILABLE',
  };
  for (const [laneId, reasonCode] of Object.entries(expected)) {
    const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === laneId);
    assert.ok(manifest, `missing manifest for ${laneId}`);
    assert.equal(manifest.optional, true);
    assert.equal(manifest.required, false);
    assert.equal(manifest.reasonCode, reasonCode, laneId);
  }
});

test('unified daily result surfaces the Normal pipeline funnel report', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: emptyLegacyFixtures(),
  }));
  assert.ok(result.funnel);
  assert.equal(result.funnel.reconciliation.ok, true);
  assert.equal(result.dailyReceipt.schemaVersion, 'LaunchpadDailyFunnelReceiptV1');
  assert.equal(result.receiptPersistence, 'persisted', `${result.receiptPersistenceError}; runId=${result.terminalEnvelope.runId}; database=${config.databasePath}`);
  assert.equal(result.dailyReceipt.scopes.confirmedDelivery.count, 'Not Verified');
  assert.equal(result.dailyReceipt.provenance.releaseClaim, 'none; local working-tree evidence');
  assert.match(renderLocalLeadReport(result, { now: NOW }), /Daily stage-loss receipt/);
  assert.match(renderLocalDailyHtmlReport(result), /daily-stage-loss-receipt/);
  const repeated = normalizeCandidate(rawPortalJob(1299, { provider: 'fixture-provider', source: 'discovery' }));
  const repeatedIdentity = `sha256:${createHash('sha256').update(candidateDedupKey(repeated)).digest('hex')}`;
  const deduplicatedReceipt = buildDailyReceipt({
    counts: { fetched: 2, selected: 0 },
    funnel: { lifecycle: { normalized: 2 }, identityRows: [
      { identity: repeatedIdentity, bucket: 'notSelected', reason: 'NOT_SELECTED', provider: 'fixture-provider', source: 'discovery', postedAt: repeated.postedAt, evidenceHash: 'sha256:a' },
      { identity: repeatedIdentity, bucket: 'notSelected', reason: 'NOT_SELECTED', provider: 'fixture-provider', source: 'enrichment', postedAt: repeated.postedAt, evidenceHash: 'sha256:b' },
    ] },
    observations: [{ candidate: repeated }, { candidate: { ...repeated, source: 'enrichment' } }],
    modes: {},
  });
  assert.equal(deduplicatedReceipt.scopes.rawObservations.count, 2);
  assert.equal(deduplicatedReceipt.scopes.uniqueRequisitions.count, 1);
  assert.deepEqual([...new Set(deduplicatedReceipt.retained.identityRows[0].provenance.map((item) => item.source))].sort(), ['discovery', 'enrichment']);
  const hashInputs = {
    runId: 'receipt-hash-inputs',
    counts: { fetched: 2 },
    requestedCount: 2,
    outcome: { status: 'completed' },
    deliveryReconciliation: {
      status: 'completed', counts: { deliveredKeys: 1, surfacedCount: 1 },
      notification: { status: 'sent' }, canary: { status: 'completed' },
    },
  };
  const receiptHash = (overrides = {}) => buildDailyReceipt({ ...hashInputs, ...overrides }).provenance.retainedInputHash;
  const stableHash = receiptHash();
  assert.equal(receiptHash(), stableHash);
  assert.notEqual(receiptHash({ deliveryReconciliation: { ...hashInputs.deliveryReconciliation, counts: { deliveredKeys: 2, surfacedCount: 1 } } }), stableHash);
  assert.notEqual(receiptHash({ requestedCount: 3 }), stableHash);
  assert.notEqual(receiptHash({ outcome: { status: 'completed', fatalReason: 'fixture cause changed' } }), stableHash);
  const timestampedCandidate = {
    company: 'Acme', title: 'Engineer', canonicalUrl: 'https://example.com/jobs/1',
  };
  const flatObservation = (observedAt) => buildDailyReceipt({
    observations: [{ ...timestampedCandidate, observedAt }],
  });
  const flatFirst = flatObservation('2026-10-19T00:00:00Z');
  assert.equal(flatFirst.retained.observations[0].observedAt, '2026-10-19T00:00:00Z');
  assert.equal(flatObservation('2026-10-19T00:00:00Z').provenance.retainedInputHash, flatFirst.provenance.retainedInputHash);
  assert.notEqual(flatObservation('2026-10-20T00:00:00Z').provenance.retainedInputHash, flatFirst.provenance.retainedInputHash);
  const wrappedObservation = (observedAt) => buildDailyReceipt({
    observations: [{ candidate: timestampedCandidate, observedAt }],
  });
  const wrappedFirst = wrappedObservation('2026-10-19T00:00:00Z');
  assert.equal(wrappedFirst.retained.observations[0].observedAt, '2026-10-19T00:00:00Z');
  assert.equal(wrappedObservation('2026-10-19T00:00:00Z').provenance.retainedInputHash, wrappedFirst.provenance.retainedInputHash);
  assert.notEqual(wrappedObservation('2026-10-20T00:00:00Z').provenance.retainedInputHash, wrappedFirst.provenance.retainedInputHash);
  assert.equal(buildDailyReceipt({ observations: [{ candidate: timestampedCandidate }] }).retained.observations[0].observedAt, null);
  const inheritedSelection = buildDailyReceipt({
    funnel: { identityRows: [{ identity: repeatedIdentity, bucket: 'selected', selected: true, provider: repeated.provider, source: repeated.source }] },
    modes: {
      startup: { results: [repeated], shortlist: [] },
      normal: { results: [], shortlist: [] },
      remote: { results: [], shortlist: [] },
    },
  });
  assert.equal(inheritedSelection.scopes.finalSelection.count, 0);
  assert.equal(inheritedSelection.retained.identityRows[0].stage, 'eligible');
  const unavailableSelection = buildDailyReceipt({
    funnel: { identityRows: [{ identity: repeatedIdentity, bucket: 'selected', selected: true }] },
    modes: {},
  });
  assert.equal(unavailableSelection.scopes.finalSelection.count, 'Not Verified');
  assert.equal(unavailableSelection.retained.identityRows[0].stage, 'unknown');
  const historyBuckets = ['suppressedCooldown', 'suppressedBackfillAlreadySeen', 'suppressedActioned', 'suppressedRejected'];
  const suppressedReceipt = buildDailyReceipt({
    funnel: { identityRows: historyBuckets.map((bucket, index) => ({
      identity: `sha256:suppressed-${index}`, bucket, reason: `SUPPRESSED_FIXTURE_${index}`, provider: 'fixture-provider', source: 'fixture-source',
    })) },
    historicalSuppressions: [{ code: 'SUPPRESSED_V4_HISTORY' }],
    modes: { normal: { shortlist: [] } },
  });
  assert.equal(suppressedReceipt.scopes.historySuppression.count, historyBuckets.length);
  assert.deepEqual(suppressedReceipt.retained.identityRows.map((row) => row.reason), historyBuckets.map((_, index) => `SUPPRESSED_FIXTURE_${index}`));
  const reopened = openCrawlerStore(config.databasePath);
  const persisted = JSON.parse(reopened.prepare('SELECT telemetry_json FROM crawl_runs WHERE run_id = ?').get(`${result.runId}-crawler-v2`).telemetry_json);
  reopened.close();
  assert.equal(persisted.workflow.dailyReceipt.schemaVersion, result.dailyReceipt.schemaVersion);
  assert.equal(persisted.workflow.dailyReceipt.provenance.retainedInputHash, result.dailyReceipt.provenance.retainedInputHash);
  assert.match(renderLocalLeadReport({ ...result, dailyReceipt: persisted.workflow.dailyReceipt }, { now: NOW }), /Daily stage-loss receipt/);
});

test('no portal injection stays healthy but is reported as an empty lane', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: emptyLegacyFixtures(),
  }));
  // Missing portals must not degrade the run - they are optional.
  assert.equal(result.outcome.status, 'ok');
  assert.equal(result.outcome.degraded, false);
  assert.equal(result.shortfall.failedLanes.some((laneId) => laneId.startsWith('portal-')), false);
  // But they must be visible. Silently omitting an empty source is how a
  // zero-yield run came to look identical to a healthy one.
  assert.equal(result.shortfall.emptyLanes.includes('portal-linkedin-jobs'), true);
  assert.equal(result.shortfall.reasons.includes('SOURCE_EMPTY:portal-linkedin-jobs'), true);
  assert.equal(result.heldLeadRecovery == null, true);
  assert.doesNotMatch(renderLocalLeadReport(result, { now: NOW }), /Recovery of already known leads/);
});

test('live-injected portal candidates retain their portal manifest and verification handling', async () => {
  const { config } = testConfig();
  const unresolved = rawPortalJob(1301, {
    originalApplicationUrl: null,
    originalApplicationEvidence: null,
    applicationResolution: { status: 'Unresolved', evidence: null },
    sourceKind: 'aggregator',
  });
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-naukri': { candidates: [unresolved], manifest: { status: 'ok', fixture: 'live-injected' } },
    },
  }));
  const manifest = result.sourceManifests.find(({ sourceId }) => sourceId === 'portal-naukri');
  assert.equal(manifest.fixture, 'live-injected');
  assert.equal(manifest.fetched, 1);
  assert.equal(manifest.optional, true);
  assert.equal(result.verificationQueue[0].provider, 'naukri');
  assert.equal(result.shortlist.length, 0);
});

test('a resolved portal lead is scored in web-discovery with its surfacing provider retained', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-naukri': {
        candidates: [rawPortalJob(1302, {
          provider: 'greenhouse',
          sourceKind: 'ats-direct',
          originalApplicationUrl: 'https://boards.greenhouse.io/acme/jobs/1302',
          originalApplicationEvidence: 'resolved employer ATS listing',
          applicationResolution: { status: 'Resolved Original', evidence: 'resolved employer ATS listing' },
        })],
        manifest: { status: 'ok' },
      },
    },
  }));
  assert.equal(result.counts.scored, 1);
  assert.equal(result.shortlist.length, 1);
  assert.equal(result.shortlist[0].normalLaneId, 'web-discovery');
  assert.equal(result.shortlist[0].provider, 'naukri');
  assert.equal(result.shortlist[0].discoveryProvider, 'naukri');
  const selectedReceiptRow = result.dailyReceipt.retained.identityRows.find((row) => row.selected);
  assert.ok(selectedReceiptRow);
  assert.equal(selectedReceiptRow.stage, 'finalSelection');
  assert.equal(selectedReceiptRow.reason, 'SELECTED');
  const allModeShortlist = Object.values(result.modes).flatMap((mode) => mode.shortlist);
  const expectedSelected = [...new Set(allModeShortlist.map((role) => `sha256:${createHash('sha256').update(candidateDedupKey(role)).digest('hex')}`))].sort();
  const receiptSelected = result.dailyReceipt.retained.identityRows.filter((row) => row.selected).map((row) => row.identityHash).sort();
  assert.deepEqual(receiptSelected, expectedSelected);
  assert.equal(result.dailyReceipt.scopes.finalSelection.count, expectedSelected.length);
  assert.equal(result.plannedNotionOperations[0].payload.provider, 'naukri');
  assert.equal(result.sourceManifests.find(({ sourceId }) => sourceId === 'web-discovery').fetched, 1);

  const { config: duplicateConfig } = testConfig();
  const duplicateCandidate = rawPortalJob(1304, {
    provider: 'fixture-provider', source: 'discovery', jobId: undefined,
    canonicalUrl: 'https://fixture.example.test/jobs/shared-req-1304',
    url: 'https://fixture.example.test/jobs/shared-req-1304',
  });
  const duplicateRun = await runDailyNormal(runOptions(duplicateConfig, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-naukri': { candidates: [duplicateCandidate], manifest: { status: 'ok' } },
      'portal-foundit': { candidates: [{ ...duplicateCandidate, source: 'enrichment' }], manifest: { status: 'ok' } },
    },
  }));
  const duplicateIdentity = `sha256:${createHash('sha256').update(candidateDedupKey(duplicateCandidate)).digest('hex')}`;
  const duplicateRow = duplicateRun.dailyReceipt.retained.identityRows.find((row) => row.identityHash === duplicateIdentity);
  assert.equal(duplicateRun.dailyReceipt.scopes.uniqueRequisitions.count, 1);
  assert.deepEqual([...new Set(duplicateRow.provenance.map((item) => item.provider))].sort(), ['foundit', 'naukri']);
  const duplicateStore = openCrawlerStore(duplicateConfig.databasePath);
  const duplicateTelemetry = JSON.parse(duplicateStore.prepare('SELECT telemetry_json FROM crawl_runs WHERE run_id = ?').get(`${duplicateRun.runId}-crawler-v2`).telemetry_json);
  duplicateStore.close();
  const duplicateReport = renderLocalLeadReport({ ...duplicateRun, dailyReceipt: duplicateTelemetry.workflow.dailyReceipt }, { now: NOW });
  assert.equal(duplicateTelemetry.workflow.dailyReceipt.scopes.uniqueRequisitions.count, 1);
  assert.deepEqual([...new Set(duplicateTelemetry.workflow.dailyReceipt.retained.identityRows.find((row) => row.identityHash === duplicateIdentity).provenance.map((item) => item.provider))].sort(), ['foundit', 'naukri']);
  assert.match(duplicateReport, /Unique requisitions: 1/);

  const { config: ledgerConfig } = testConfig();
  const ledgerCandidate = rawPortalJob(1310, { provider: 'naukri', source: 'daily-discovery', jobId: 'ledger-1310' });
  const normalizedLedgerCandidate = normalizeCandidate(ledgerCandidate);
  const ledgerIdentity = candidateDedupKey(normalizedLedgerCandidate);
  const ledgerRun = await runDailyNormal(runOptions(ledgerConfig, fakeTransport({}), {
    runId: 'daily-ledger-suppression-receipt',
    ledgerRows: [{ dedup_key: ledgerIdentity, state: 'committed', company: normalizedLedgerCandidate.company }],
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-naukri': { candidates: [ledgerCandidate], manifest: { status: 'ok' } },
    },
  }));
  const suppressed = ledgerRun.dailyReceipt.retained.identityRows.find((row) => row.reason === 'DEDUP_EXISTING_LEDGER');
  assert.ok(suppressed, JSON.stringify(ledgerRun.dailyReceipt.retained.identityRows));
  assert.equal(ledgerRun.dailyReceipt.scopes.rawObservations.count, 1);
  assert.equal(ledgerRun.dailyReceipt.scopes.uniqueRequisitions.count, 1);
  assert.equal(ledgerRun.dailyReceipt.scopes.historySuppression.count, 1);
  assert.equal(ledgerRun.dailyReceipt.scopes.finalSelection.count, 0);
  assert.deepEqual(ledgerRun.plannedNotionOperations, []);
  assert.equal(suppressed.selected, false);
  assert.equal(suppressed.reason, 'DEDUP_EXISTING_LEDGER');
  const ledgerStore = openCrawlerStore(ledgerConfig.databasePath);
  const ledgerTelemetry = JSON.parse(ledgerStore.prepare('SELECT telemetry_json FROM crawl_runs WHERE run_id = ?').get(`${ledgerRun.runId}-crawler-v2`).telemetry_json);
  ledgerStore.close();
  const retainedSuppression = ledgerTelemetry.workflow.dailyReceipt.retained.identityRows.find((row) => row.reason === 'DEDUP_EXISTING_LEDGER');
  assert.deepEqual(retainedSuppression, suppressed);
  assert.equal(ledgerTelemetry.workflow.dailyReceipt.scopes.finalSelection.count, 0);
  await verifyDailyAliasDateReplay();
});

async function verifyDailyAliasDateReplay() {
  const { config } = testConfig();
  const missingDateResolver = createOriginalListingResolver({
    runAt: '2026-10-20T09:00:00Z',
    transport: async () => ({ status: 200, body: `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting', title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Current Detail Employer' },
    })}</script>` }),
  });
  const missingDateStore = openCrawlerStore(config.databasePath);
  await crawlRun({
    store: missingDateStore,
    runId: 'p03-current-detail-missing-date',
    clock: { now: () => '2026-10-20T09:00:00Z', sleep: async () => {} },
    sourcePlans: [{ id: 'p03-detail-date-fixture', fetch: async () => {
      const observation = normalizeCandidate({
        canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/123', provider: 'greenhouse', jobId: '123',
        company: 'Current Detail Employer', title: 'AI Engineer', postedAt: '2026-10-20',
        dateEvidence: { originalPublication: { value: '2026-10-20T08:00:00Z', source: 'prior-employer-detail' } },
      });
      const resolution = await missingDateResolver(observation);
      return { observations: [applyOriginalListingResolution(observation, resolution)] };
    } }],
  });
  missingDateStore.close();
  const missingDateReopened = openCrawlerStore(config.databasePath);
  const missingDateLifecycle = missingDateReopened.prepare('SELECT raw_json FROM job_observations').all()
    .map((row) => JSON.parse(row.raw_json)).find((row) => row.jobId === '123');
  missingDateReopened.close();
  assert.equal(missingDateLifecycle.postedAt, null);
  assert.equal(missingDateLifecycle.dateEvidence.originalPublication, null);
  assert.equal(missingDateLifecycle.evidence.dateEvidence.originalPublication, null);
  assert.equal(missingDateLifecycle.dateEvidence.originalPublicationAlternates[0].value, '2026-10-20T08:00:00Z');
  assert.equal(classifyFreshness(missingDateLifecycle, { now: '2026-10-20T09:00:00Z' }).window, 'VerifyQueue');
  const impossibleDate = rawPortalJob(124, {
    canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/124', url: 'https://boards.greenhouse.io/acme/jobs/124',
    originalApplicationUrl: 'https://boards.greenhouse.io/acme/jobs/124', provider: 'greenhouse', jobId: '124',
    company: 'Current Detail Employer', title: 'AI Engineer', postedAt: '2026-02-30',
    dateEvidence: { originalPublication: { value: '2026-02-30', source: 'original-employer-detail', precision: 'date' } },
  });
  const impossibleDateDailyConfig = testConfig();
  const impossibleDateDaily = await runDailyNormal(runOptions(impossibleDateDailyConfig.config, fakeTransport({}), {
    runId: 'p03-impossible-publication-date',
    clock: { now: () => '2026-03-02T12:00:00Z', sleep: async () => {} },
    sourceFixtures: { ...emptyLegacyFixtures(), 'portal-naukri': { candidates: [impossibleDate], manifest: { status: 'ok' } } },
  }));
  const impossibleDateRow = impossibleDateDaily.dailyReceipt.retained.identityRows.find((row) => row.dateEvidence?.originalPublication?.value === '2026-02-30');
  assert.ok(impossibleDateRow);
  assert.equal(impossibleDateRow.dateEvidence.originalPublication.value, '2026-02-30');
  const impossibleDateVerifyRole = impossibleDateDaily.verificationQueue.find((role) => role.discoveryUrl === 'https://boards.greenhouse.io/acme/jobs/124');
  assert.ok(impossibleDateVerifyRole);
  assert.equal(classifyFreshness(impossibleDateVerifyRole, { now: '2026-03-02T12:00:00Z' }).window, 'VerifyQueue');
  assert.equal(impossibleDateDaily.shortlist.some((role) => role.jobId === '124'), false);
  const missingDateReplayStore = openCrawlerStore(config.databasePath);
  await crawlRun({ store: missingDateReplayStore, runId: 'p03-current-detail-missing-date-replay',
    clock: { now: () => '2026-10-20T09:05:00Z', sleep: async () => {} },
    sourcePlans: [{ id: 'p03-detail-date-replay', fetch: async () => ({ observations: [missingDateLifecycle] }) }] });
  missingDateReplayStore.close();
  const missingDateReplayRead = openCrawlerStore(config.databasePath);
  const missingDateReplayed = JSON.parse(missingDateReplayRead.prepare('SELECT raw_json FROM job_observations ORDER BY rowid DESC LIMIT 1').get().raw_json);
  missingDateReplayRead.close();
  assert.equal(missingDateReplayed.postedAt, null);
  assert.equal(missingDateReplayed.dateEvidence.originalPublicationAlternates[0].value, '2026-10-20T08:00:00Z');
  const { config: dailyMissingConfig } = testConfig();
  const missingDateDaily = await runDailyNormal(runOptions(dailyMissingConfig, fakeTransport({}), {
    runId: 'p03-current-detail-missing-date-selection',
    sourceFixtures: { ...emptyLegacyFixtures(), 'portal-naukri': { candidates: [rawPortalJob(123, {
      provider: 'greenhouse', jobId: '123', url: 'https://boards.greenhouse.io/acme/jobs/123',
      canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/123', originalApplicationUrl: 'https://boards.greenhouse.io/acme/jobs/123',
      sourceKind: 'ats-direct', postedAt: missingDateLifecycle.postedAt,
      dateEvidence: missingDateLifecycle.dateEvidence, evidence: missingDateLifecycle.evidence,
    })], manifest: { status: 'ok' } } },
  }));
  assert.equal(missingDateDaily.shortlist.some((role) => role.jobId === '123'), false);
  assert.ok(missingDateDaily.verificationQueue.some((role) => role.discoveryUrl === 'https://boards.greenhouse.io/acme/jobs/123'), JSON.stringify({ shortlist: missingDateDaily.shortlist, verify: missingDateDaily.verificationQueue, pool: missingDateDaily.scoringQueue }));
  const publicPosting = normalizeCandidate({
    ...rawPortalJob(123, { company: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/123',
      canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/123', originalApplicationUrl: 'https://boards.greenhouse.io/acme/jobs/123',
      provider: 'greenhouse', jobId: '123', requisitionId: 'REQ-42', sourceKind: 'ats-direct', postedAt: '2026-10-20' }),
  });
  const publicDetailResolver = createOriginalListingResolver({ transport: async () => ({
    status: 200, body: `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting', title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Acme' },
      identifier: { name: 'Acme', value: 'REQ-42' }, datePosted: '2026-10-20',
    })}</script>`,
  }) });
  const publicDetail = await publicDetailResolver(publicPosting, { runAt: '2026-10-20T09:00:00Z' });
  assert.equal(publicDetail.status, 'resolved');
  const publicCandidate = { ...applyOriginalListingResolution(publicPosting, publicDetail),
    scoreOrigin: 'explicit-scored-input', matchScore: 80, responseLikelihood: 15 };
  assert.equal(publicCandidate.jobId, '123');
  assert.equal(publicCandidate.employerRequisitionId, 'REQ-42');
  const { config: publicConfig } = testConfig();
  const publicStore = openCrawlerStore(publicConfig.databasePath);
  await crawlRun({ store: publicStore, runId: 'p03-public-provider-id-persist',
    clock: { now: () => '2026-10-20T09:00:00Z', sleep: async () => {} },
    sourcePlans: [{ id: 'p03-public-provider-id', fetch: async () => ({ observations: [publicCandidate] }) }] });
  publicStore.close();
  const publicReplayStore = openCrawlerStore(publicConfig.databasePath);
  const publicPersisted = JSON.parse(publicReplayStore.prepare('SELECT raw_json FROM job_observations ORDER BY rowid DESC LIMIT 1').get().raw_json);
  publicReplayStore.close();
  assert.equal(publicPersisted.jobId, '123');
  assert.equal(publicPersisted.employerRequisitionId, 'REQ-42');
  const publicReplayWriteStore = openCrawlerStore(publicConfig.databasePath);
  await crawlRun({ store: publicReplayWriteStore, runId: 'p03-public-provider-id-replay',
    clock: { now: () => '2026-10-20T09:05:00Z', sleep: async () => {} },
    sourcePlans: [{ id: 'p03-public-provider-id-replay', fetch: async () => ({ observations: [publicPersisted] }) }] });
  publicReplayWriteStore.close();
  const publicReplayReadStore = openCrawlerStore(publicConfig.databasePath);
  const publicReplayed = JSON.parse(publicReplayReadStore.prepare('SELECT raw_json FROM job_observations ORDER BY rowid DESC LIMIT 1').get().raw_json);
  publicReplayReadStore.close();
  assert.equal(publicReplayed.jobId, '123');
  assert.equal(publicReplayed.employerRequisitionId, 'REQ-42');
  const publicSelectionCandidate = rawPortalJob(123, {
    provider: 'greenhouse', jobId: '123', requisitionId: 'REQ-42', postedAt: NOW,
    url: 'https://boards.greenhouse.io/acme/jobs/123', canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/123',
    originalApplicationUrl: 'https://boards.greenhouse.io/acme/jobs/123',
  });
  const publicSelection = await runDailyNormal(runOptions(publicConfig, fakeTransport({}), {
    runId: 'p03-public-provider-id-selection',
    sourceFixtures: { ...emptyLegacyFixtures(), 'portal-naukri': { candidates: [publicSelectionCandidate], manifest: { status: 'ok' } } },
  }));
  assert.ok(publicSelection.shortlist.some((role) => role.jobId === '123'));
  const refreshBase = normalizeCandidate({
    url: 'https://boards.greenhouse.io/acme/jobs/123', canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/123',
    provider: 'greenhouse', jobId: '123', company: 'Acme', title: 'AI Engineer', postedAt: '2026-10-20',
  });
  const initialDetailResolver = createOriginalListingResolver({ transport: async () => ({
    status: 200, body: `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting', title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Acme' }, datePosted: '2026-10-20',
    })}</script>`,
  }) });
  const initialResolution = await initialDetailResolver(refreshBase, { runAt: '2026-10-20T09:10:00Z' });
  assert.equal(initialResolution.status, 'resolved');
  assert.equal(initialResolution.patch.jobId, '123');
  assert.equal(initialResolution.patch.employerRequisitionId, undefined);
  assert.equal(initialResolution.patch.requisitionId, undefined);
  const initiallyResolved = applyOriginalListingResolution(refreshBase, initialResolution);
  const initialWriteStore = openCrawlerStore(publicConfig.databasePath);
  await crawlRun({ store: initialWriteStore, runId: 'p03-refresh-no-employer-id',
    clock: { now: () => '2026-10-20T09:10:00Z', sleep: async () => {} },
    sourcePlans: [{ id: 'p03-refresh-no-employer-id', fetch: async () => ({ observations: [initiallyResolved] }) }] });
  initialWriteStore.close();
  const initialReadStore = openCrawlerStore(publicConfig.databasePath);
  const initialPersisted = JSON.parse(initialReadStore.prepare('SELECT raw_json FROM job_observations ORDER BY rowid DESC LIMIT 1').get().raw_json);
  initialReadStore.close();
  assert.equal(initialPersisted.jobId, '123');
  assert.equal(initialPersisted.employerRequisitionId, undefined);
  const refreshDetailResolver = createOriginalListingResolver({ transport: async () => ({
    status: 200, body: `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting', title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Acme' },
      jobReqId: 'REQ-42', datePosted: '2026-10-20',
    })}</script>`,
  }) });
  const refreshedResolution = await refreshDetailResolver(normalizeCandidate(initialPersisted), { runAt: '2026-10-20T09:15:00Z' });
  assert.equal(refreshedResolution.status, 'resolved');
  const refreshedCandidate = applyOriginalListingResolution(normalizeCandidate(initialPersisted), refreshedResolution);
  assert.equal(refreshedCandidate.jobId, '123');
  assert.equal(refreshedCandidate.employerRequisitionId, 'REQ-42');
  const refreshWriteStore = openCrawlerStore(publicConfig.databasePath);
  await crawlRun({ store: refreshWriteStore, runId: 'p03-refresh-known-employer-id',
    clock: { now: () => '2026-10-20T09:15:00Z', sleep: async () => {} },
    sourcePlans: [{ id: 'p03-refresh-known-employer-id', fetch: async () => ({ observations: [refreshedCandidate] }) }] });
  refreshWriteStore.close();
  const refreshReadStore = openCrawlerStore(publicConfig.databasePath);
  const refreshedPersisted = JSON.parse(refreshReadStore.prepare('SELECT raw_json FROM job_observations ORDER BY rowid DESC LIMIT 1').get().raw_json);
  refreshReadStore.close();
  assert.equal(refreshedPersisted.jobId, '123');
  assert.equal(refreshedPersisted.employerRequisitionId, 'REQ-42');
  for (const [priorDate, currentDate] of [['2026-10-15', '2026-09-01'], ['2026-09-01', '2026-10-15']]) {
    const { config: conflictConfig } = testConfig();
    const original = normalizeCandidate({
      canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/123', provider: 'greenhouse', jobId: '123',
      company: 'Acme', title: 'AI Engineer', postedAt: priorDate,
      dateEvidence: { originalPublication: { value: priorDate, source: 'employer-detail', precision: 'date' } },
    });
    const firstStore = openCrawlerStore(conflictConfig.databasePath);
    await crawlRun({ store: firstStore, runId: `p03-date-prior-${priorDate}`, clock: { now: () => '2026-10-20T09:00:00Z', sleep: async () => {} },
      sourcePlans: [{ id: 'p03-date-prior', fetch: async () => ({ observations: [original] }) }] });
    firstStore.close();
    const replayStore = openCrawlerStore(conflictConfig.databasePath);
    const retained = JSON.parse(replayStore.prepare('SELECT raw_json FROM job_observations ORDER BY rowid DESC LIMIT 1').get().raw_json);
    const dateResolver = createOriginalListingResolver({ runAt: '2026-10-20T09:05:00Z', transport: async () => ({
      status: 200, body: `<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting', title: 'AI Engineer', description: 'Build APIs.', hiringOrganization: { name: 'Acme' }, datePosted: currentDate,
      })}</script>`,
    }) });
    const resolution = await dateResolver(retained, { runAt: '2026-10-20T09:05:00Z' });
    const replayedCandidate = applyOriginalListingResolution(retained, resolution);
    await crawlRun({ store: replayStore, runId: `p03-date-replay-${priorDate}`, clock: { now: () => '2026-10-20T09:05:00Z', sleep: async () => {} },
      sourcePlans: [{ id: 'p03-date-replay', fetch: async () => ({ observations: [replayedCandidate] }) }] });
    replayStore.close();
    const reopened = openCrawlerStore(conflictConfig.databasePath);
    const replayed = JSON.parse(reopened.prepare('SELECT raw_json FROM job_observations ORDER BY rowid DESC LIMIT 1').get().raw_json);
    reopened.close();
    assert.equal(normalizeCandidate(replayed).postedAt, '2026-09-01');
    assert.deepEqual(replayed.dateEvidence.originalPublicationAlternates.map((item) => item.value).sort(), ['2026-09-01', '2026-10-15']);
    const rendered = renderLocalDailyHtmlReport({ runAt: '2026-10-20T09:05:00Z', mode: 'normal',
      results: [replayed], shortlist: [], verificationQueue: [replayed] });
    assert.match(rendered, /originalPublication alternatives: .*2026-09-01.*2026-10-15/);
    assert.match(rendered, /Historical suppression evidence: Not Verified/);
  }
  const bridged = rawPortalJob('alias-1', {
    provider: 'greenhouse', jobId: undefined, providerJobId: 'REQ-1', identityAliases: ['foundit|portal-9'],
    company: 'Alias Employer', postedAt: '2026-10-15', originalPublicationDate: '2026-10-15',
    sourcePublicationDate: '2026-10-20T09:00:00+05:30', catalogFirstSeenAt: '2026-10-18T12:00:00Z',
    updatedAt: '2026-10-19T10:00:00Z', observedAt: '2026-10-20T09:05:00+05:30',
  });
  const portalDuplicate = rawPortalJob('alias-2', {
    provider: 'foundit', jobId: 'portal-9', company: 'Alias Employer', postedAt: '2026-10-15',
  });
  const distinct = rawPortalJob('alias-3', {
    provider: 'greenhouse', jobId: 'REQ-2', company: 'Alias Employer', postedAt: '2026-10-15',
  });
  const first = await runDailyNormal(runOptions(config, fakeTransport({}), {
    runId: 'p03-alias-first',
    clock: { now: () => '2026-10-20T06:30:00.000Z', sleep: async () => {} },
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-naukri': { candidates: [bridged, distinct], manifest: { status: 'ok' } },
      'portal-foundit': { candidates: [portalDuplicate], manifest: { status: 'ok' } },
    },
  }));
  assert.equal(first.dailyReceipt.scopes.rawObservations.count, 3);
  assert.equal(first.dailyReceipt.scopes.uniqueRequisitions.count, 2, JSON.stringify(first.dailyReceipt.retained.identityRows));
  assert.equal(first.dailyReceipt.retained.identityRows.length, 2);
  assert.equal(first.shortlist.some((role) => role.jobId === 'REQ-1'), true);
  const aliasRow = first.dailyReceipt.retained.identityRows.find((row) => row.dateEvidence?.originalPublication?.value === '2026-10-15');
  assert.equal(aliasRow.dateEvidence.originalPublication.value, '2026-10-15');
  assert.equal(aliasRow.dateEvidence.originalPublication.precision, 'date');
  assert.equal(aliasRow.dateEvidence.sourcePublication.timezone, '+05:30');
  assert.deepEqual(aliasRow.dateEvidence.conflicts, ['originalPublication differs from sourcePublication']);
  const report = renderLocalDailyHtmlReport(first);
  assert.match(report, /Discovery URL:/);
  assert.match(report, /employer detail URL:/);
  assert.match(report, /final apply URL:/);
  assert.match(report, /originalPublication: 2026-10-15/);
  assert.match(report, /conflicts: originalPublication differs from sourcePublication/);
  assert.match(report, /Historical suppression evidence: Not Verified/);
  assert.doesNotMatch(report, /originalPublication: 2026-10-15T00:00:00/);

  const store = openCrawlerStore(config.databasePath);
  await crawlRun({
    store,
    runId: 'p03-persist-alias',
    clock: { now: () => '2026-10-20T06:30:00.000Z', sleep: async () => {} },
    sourcePlans: [{ id: 'p03-alias-fixture', fetch: async () => ({ observations: [{
      provider: 'foundit', providerJobId: 'portal-9', identityAliases: ['foundit|portal-9', 'greenhouse|REQ-1'],
      canonicalUrl: 'https://foundit.example.test/jobs/portal-9', company: 'Alias Employer',
      title: 'AI Engineer', location: 'Pune', postedAt: '2026-10-15',
    }] }) }],
  });
  store.prepare("UPDATE jobs SET lifecycle_state = 'surfaced', lifecycle_json = json_set(lifecycle_json, '$.state', 'surfaced') WHERE provider_job_id = 'portal-9'").run();
  store.close();
  const reopened = openCrawlerStore(config.databasePath);
  const retained = reopened.prepare('SELECT lifecycle_json FROM jobs').all().map((row) => JSON.parse(row.lifecycle_json));
  reopened.close();
  assert.ok(retained.some((row) => row.identityAliases.includes('foundit|portal-9')), JSON.stringify(retained));
  recordSurfaced([normalizeCandidate(bridged)], { path: config.opportunityLedgerPath, now: '2026-10-20T06:30:00.000Z' });

  const now = '2026-10-21T06:30:00.000Z';
  const replay = await runDailyNormal(runOptions(config, fakeTransport({}), {
    runId: 'p03-alias-replay',
    clock: { now: () => now, sleep: async () => {} },
    opportunityLedgerRows: null,
    opportunityRows: null,
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-foundit': { candidates: [rawPortalJob('alias-replay', {
        provider: 'foundit', jobId: 'portal-9', identityAliases: ['greenhouse|REQ-1'], company: 'Alias Employer', postedAt: '2026-10-15',
      })], manifest: { status: 'ok' } },
    },
  }));
  assert.equal(replay.shortlist.length, 0);
  assert.equal(replay.dailyReceipt.scopes.historySuppression.count, 1);
  assert.ok(replay.dailyReceipt.retained.identityRows.some((row) => row.stage === 'historySuppression'));
  assert.ok(replay.dailyReceipt.retained.identityRows.some((row) => row.reason === 'SUPPRESSED_COOLDOWN_7D'));

  markAction({ key: 'greenhouse|REQ-1', state: 'applied', path: config.opportunityLedgerPath, now: '2026-10-21T06:30:00.000Z' });
  const actionReplay = await runDailyNormal(runOptions(config, fakeTransport({}), {
    runId: 'p03-alias-action-replay',
    clock: { now: () => '2026-10-21T07:30:00.000Z', sleep: async () => {} },
    opportunityLedgerRows: null,
    opportunityRows: null,
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-foundit': { candidates: [rawPortalJob('alias-action-replay', {
        provider: 'foundit', jobId: 'portal-9', identityAliases: ['greenhouse|REQ-1'], company: 'Alias Employer', postedAt: '2026-10-15',
      })], manifest: { status: 'ok' } },
    },
  }));
  assert.equal(actionReplay.shortlist.length, 0);
  assert.equal(actionReplay.dailyReceipt.scopes.historySuppression.count, 1);
  assert.ok(actionReplay.dailyReceipt.retained.identityRows.some((row) => row.reason === 'SUPPRESSED_ACTIONED'));
}

test('an unresolved portal lead stays in verification and cannot be selected', async () => {
  const { config } = testConfig();
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-foundit': {
        candidates: [rawPortalJob(1303, {
          originalApplicationUrl: null,
          originalApplicationEvidence: null,
          applicationResolution: { status: 'Unresolved', evidence: null },
          sourceKind: 'aggregator',
        })],
        manifest: { status: 'ok' },
      },
    },
  }));
  assert.equal(result.shortlist.length, 0);
  assert.equal(result.verificationQueue.length, 1);
  assert.equal(result.verificationQueue[0].provider, 'foundit');
  assert.equal(result.verificationQueue[0].applicationResolution.status, 'Unresolved');
  assert.equal(result.dailyReceipt.scopes.verification.count, 1);
  assert.equal(result.dailyReceipt.retained.identityRows.find((row) => row.identityHash === `sha256:${createHash('sha256').update(result.verificationQueue[0].dedupKey).digest('hex')}`)?.stage, 'verification');

  const { config: recoveryConfig } = testConfig();
  recoveryConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  const recoveredLeads = [
    ['good', 'AI Engineer', 'Acme Labs'], ['missing-date', 'AI Engineer', 'Acme Labs'],
    ['missing-employment', 'AI Engineer', 'Acme Labs'], ['mismatch', 'AI Engineer', 'Acme Labs'],
    ['unsupported', 'AI Engineer', 'Acme Labs'], ['forbidden', 'AI Engineer', 'Acme Labs'],
    ['missing-route', 'AI Engineer', 'Acme Labs'], ['thrown', 'AI Engineer', 'Acme Labs'],
    ['requisition-mismatch', 'AI Engineer', 'Acme Labs'], ['missing-current-facts', 'AI Engineer', 'Acme Labs'],
  ].map(([id, title, company]) => ({
    canonicalUrl: `https://www.glassdoor.com/job-listing/${id}`, discoveryUrl: `https://www.glassdoor.com/job-listing/${id}`,
    provider: id === 'requisition-mismatch' ? 'greenhouse' : 'glassdoor', discoveryProvider: 'glassdoor', source: 'portal-glassdoor', sourceId: 'portal-discovery', providerJobId: id,
    jobId: id, title: id === 'missing-current-facts' ? null : title, company: id === 'missing-current-facts' ? null : company,
    location: id === 'good' ? 'London, UK' : 'Pune, India', description: 'Index preview only.', postedAt: NOW,
    employment: { type: 'full-time', evidence: 'index preview' }, experience: { minYears: 0, maxYears: 1, evidence: 'index preview' },
    ...(id === 'good' || id === 'missing-date' ? {
      workMode: 'remote', work_mode: 'remote', remoteEligibility: { status: 'India Eligible', evidence: 'stale portal preview' },
      remoteEligible: true, remoteEligibilityEvidence: 'stale portal preview',
    } : {}),
    ...(['good', 'missing-employment', 'missing-current-facts'].includes(id) ? {
      companyName: 'Stale Alias Employer', role: 'Stale Alias Role', descriptionPlain: 'Remote from India. Full-time. 0-1 years experience.',
      jd: 'Remote from India. Full-time. 0-1 years experience.', body: 'Remote from India. Full-time. 0-1 years experience.',
      employmentType: 'full-time', type: 'full-time', employmentEvidence: 'stale alias employment', payEvidence: 'stale alias pay', paid: true,
      salaryMin: 900000, salaryMax: 1200000, salaryCurrency: 'INR', salaryPeriod: 'annual', salaryEvidence: 'stale alias salary',
      minYears: 0, minimumYears: 0, experienceMinYears: 0, maxYears: 1, maximumYears: 1, experienceMaxYears: 1,
      experienceEvidence: '0-1 years experience', sourceMinYears: 0, sourceMaxYears: 1,
    } : {}),
    ...(id === 'requisition-mismatch' ? { employerRequisitionId: 'EXPECTED-REQ' } : {}),
    ...(id === 'good' || id === 'missing-current-facts' ? { provider: 'greenhouse' } : {}),
  }));
  const recoveryRequests = [];
  const recoveryTransport = async (url) => {
    recoveryRequests.push(url);
    const parsedUrl = new URL(url);
    const sourceId = parsedUrl.hostname === 'www.glassdoor.com' ? parsedUrl.pathname.split('/').at(-1) : null;
    if (sourceId) {
      if (sourceId === 'forbidden') return { status: 403, body: 'blocked fixture' };
      if (sourceId === 'missing-route') return { status: 404, body: 'missing fixture' };
      if (sourceId === 'thrown') throw new Error('fixture transport failure');
      const destination = sourceId === 'unsupported' ? 'https://redirect.example.test/jobs/1'
      : `https://boards.greenhouse.io/acme/jobs/${sourceId}`;
      return { status: 302, headers: { location: destination }, body: '' };
    }
    const id = parsedUrl.pathname.split('/').at(-1);
    const posting = {
      '@context': 'https://schema.org', '@type': 'JobPosting', ...(id === 'missing-current-facts' ? {} : { title: 'AI Engineer' }),
      ...(id === 'missing-current-facts' ? {} : { hiringOrganization: { name: id === 'mismatch' ? 'Different Employer' : 'Acme Labs' } }),
      description: id === 'missing-current-facts'
        ? 'Build Python APIs.'
        : id === 'good'
        ? 'Remote from London, United Kingdom. Full-time AI Engineer. Build Python systems. 0-1 years experience.'
        : id === 'missing-date'
        ? 'AI Engineer in Pune, India. Full-time AI Engineer. Build Python systems. 0-1 years experience.'
        : id === 'missing-employment'
        ? 'Remote from India. AI Engineer. Build Python systems. 0-1 years experience.'
        : 'Full-time AI Engineer in Pune, India. Build Python systems. 0-1 years experience.',
      ...(id === 'missing-current-facts' ? {} : id === 'missing-date'
        ? { jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } } }
        : id === 'good'
        ? { jobLocation: { address: { addressLocality: 'London', addressCountry: 'UK' } } }
        : id === 'missing-employment'
        ? { jobLocation: { address: { addressCountry: 'India' } } }
        : { jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } } }),
      datePosted: '2026-07-23',
      ...(id === 'good' ? { baseSalary: { currency: 'INR', unitText: 'annual', value: { minValue: 800000, maxValue: 1000000 } } } : {}),
      ...(id === 'missing-current-facts' ? {} : { employmentType: 'FULL_TIME' }),
      identifier: { name: 'Acme Labs', value: id === 'requisition-mismatch' ? 'OTHER-REQ' : id },
      ...(id !== 'missing-date' ? {} : { datePosted: undefined }),
      ...(id !== 'missing-employment' ? {} : { employmentType: undefined }),
    };
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(posting)}</script>` };
  };
  const recoveryStore = openCrawlerStore(recoveryConfig.databasePath);
  const recoveryResult = await runDailyNormalActual(runOptions(recoveryConfig, recoveryTransport, {
    runId: 'p04-held-recovery-daily', store: recoveryStore, heldPortalLeads: recoveredLeads,
  }));
  recoveryStore.close();
  assert.ok(recoveryResult.heldLeadRecovery, JSON.stringify({ errors: recoveryResult.outcome.errors, telemetry: recoveryResult.crawlerV2Telemetry }));
  assert.equal(recoveryResult.sourceYield.totals.fetched, 0, 'known held leads must not count as new discovery');
  assert.equal(recoveryResult.sourceYield.sources.length, 0, 'recovery-only runs have no discovery-yield rows');
  assert.equal(recoveryResult.heldLeadRecovery.requested, recoveredLeads.length);
  assert.equal(recoveryResult.heldLeadRecovery.recovered, 4);
  assert.equal(recoveryResult.heldLeadRecovery.mismatched, 2);
  assert.equal(recoveryResult.heldLeadRecovery.blocked, 2);
  assert.equal(recoveryResult.heldLeadRecovery.failed, 1);
  assert.equal(recoveryResult.heldLeadRecovery.unattempted, 0);
  assert.equal(recoveryRequests.length, 16);
  assert.deepEqual(recoveryResult.heldLeadRecovery.outcomes.find((item) => item.lead === 'missing-date').missingFields, ['original-date']);
  assert.deepEqual(recoveryResult.heldLeadRecovery.outcomes.find((item) => item.lead === 'missing-employment').missingFields, ['employment']);
  const recoveredGood = recoveryResult.observations.find((lead) => lead.providerJobId === 'good');
  assert.equal(recoveredGood.company, 'Acme Labs');
  assert.equal(recoveredGood.title, 'AI Engineer');
  assert.equal(recoveredGood.companyName, null);
  assert.equal(recoveredGood.role, null);
  assert.equal(recoveredGood.employmentType, null);
  assert.equal(recoveredGood.salaryMin, undefined);
  assert.deepEqual(normalizeCandidate(recoveredGood).salary, {
    minimum: 800000, maximum: 1000000, currency: 'INR', period: 'annual', evidence: '800000-1000000',
  });
  assert.equal(recoveredGood.location, 'London, UK');
  assert.equal(recoveredGood.evidence.fieldSources.location, 'original-employer-detail');
  assert.equal(recoveredGood.employment.type, 'full-time');
  assert.match(recoveredGood.description, /Build Python systems/);
  assert.equal(recoveredGood.workMode, null);
  assert.equal(recoveredGood.remoteEligibility.status, 'Not Verified');
  assert.equal(recoveredGood.eligibility.geo.pass, false);
  assert.equal(recoveredGood.eligibility.geo.code, 'GEO_ONSITE_NOT_PUNE');
  const currentIndia = recoveryResult.observations.find((lead) => lead.providerJobId === 'missing-date');
  assert.ok(currentIndia);
  assert.equal(currentIndia.eligibility.geo.pass, true);
  assert.equal(currentIndia.eligibility.geo.mode, 'onsite');
  assert.equal(currentIndia.location, 'Pune, India');
  assert.equal(currentIndia.remoteEligibility.status, 'Not Verified');
  const currentRemote = recoveryResult.observations.find((lead) => lead.providerJobId === 'missing-employment');
  assert.equal(currentRemote.eligibility.geo.pass, true);
  assert.equal(currentRemote.eligibility.geo.mode, 'remote');
  assert.equal(currentRemote.remoteEligibility.status, 'Not Verified');
  assert.equal(recoveredGood.evidence.recovery.originalDiscoveryUrl, 'https://www.glassdoor.com/job-listing/good');
  const missingDate = recoveryResult.observations.find((lead) => lead.providerJobId === 'missing-date');
  const missingEmployment = recoveryResult.observations.find((lead) => lead.providerJobId === 'missing-employment');
  const missingCurrentFacts = recoveryResult.observations.find((lead) => lead.providerJobId === 'missing-current-facts');
  assert.equal(missingDate.postedAt, null);
  assert.equal(missingDate.dateEvidence.originalPublication, null);
  assert.equal(missingEmployment.employment?.type ?? null, null);
  assert.deepEqual(normalizeCandidate(missingEmployment).salary, {
    minimum: null, maximum: null, currency: null, period: null, evidence: null,
  });
  assert.equal(missingCurrentFacts.company, null);
  assert.equal(missingCurrentFacts.title, null);
  assert.equal(missingCurrentFacts.evidence.fieldSources.company, null);
  assert.equal(missingCurrentFacts.evidence.fieldSources.title, null);
  assert.equal(missingCurrentFacts.location, null);
  assert.equal(missingCurrentFacts.employment?.type ?? null, null);
  assert.equal(missingCurrentFacts.experience?.evidence ?? null, null);
  assert.equal(missingCurrentFacts.salary?.minimum ?? null, null);
  assert.equal(missingCurrentFacts.employment?.evidence ?? null, null);
  assert.equal(missingCurrentFacts.description, 'Build Python APIs.');
  for (const field of [
    'companyName', 'role', 'descriptionPlain', 'jd', 'body', 'employmentType', 'type', 'employmentEvidence', 'payEvidence', 'paid',
    'minYears', 'minimumYears', 'experienceMinYears', 'maxYears', 'maximumYears',
    'experienceMaxYears', 'experienceEvidence', 'sourceMinYears', 'sourceMaxYears',
  ]) assert.equal(missingCurrentFacts[field], null, `${field} must not restore a stale recovery fact`);
  for (const field of ['salaryMin', 'salaryMax', 'salaryCurrency', 'salaryPeriod', 'salaryEvidence']) {
    assert.equal(missingCurrentFacts[field], undefined, `${field} fallback must be absent after recovery`);
  }
  assert.deepEqual(recoveryResult.heldLeadRecovery.outcomes.find((item) => item.lead === 'missing-current-facts').missingFields,
    ['employer', 'role', 'location', 'employment', 'experience']);
  assert.equal(missingCurrentFacts.eligibility.eligible, false);
  assert.equal(recoveryResult.shortlist.some((lead) => lead.providerJobId === 'missing-current-facts'), false);
  assert.equal((recoveryResult.scoringQueue ?? []).some((lead) => (lead.candidate ?? lead).providerJobId === 'missing-current-facts'), false);
  assert.notEqual(missingDate.applicationReady, true);
  assert.notEqual(missingEmployment.applicationReady, true);
  assert.equal(recoveryResult.shortlist.length, 0);
  assert.equal(recoveryResult.shortlist.some((lead) => lead.providerJobId === 'good'), false);
  assert.equal(recoveryResult.dailyReceipt.historyEvidence.status, 'missing');
  assert.notEqual(recoveryResult.outcome.fatal, true);
  assert.ok(recoveryResult.verificationQueue.some((lead) => lead.discoveryUrl === 'https://www.glassdoor.com/job-listing/missing-date'));
  const missingEmploymentVerification = recoveryResult.verificationQueue.find((lead) => lead.discoveryUrl === 'https://www.glassdoor.com/job-listing/missing-employment');
  assert.ok(missingEmploymentVerification);
  assert.ok(missingEmploymentVerification.reasons.includes('EMPLOYMENT_NOT_VERIFIED'));
  const missingIdentityVerification = recoveryResult.verificationQueue.find((lead) => lead.discoveryUrl === 'https://www.glassdoor.com/job-listing/missing-current-facts');
  assert.deepEqual(missingIdentityVerification.reasons, ['EMPLOYER_NOT_VERIFIED', 'ROLE_NOT_VERIFIED']);
  assert.deepEqual(missingIdentityVerification.missingFields, ['employer', 'role', 'location', 'employment', 'experience']);
  const recoveryReport = renderLocalLeadReport(recoveryResult, { now: '2026-07-24T06:30:00Z' });
  assert.match(recoveryReport, /Recovery of already known leads/);
  assert.match(recoveryReport, /do not count as new discovery or new market supply/);
  assert.match(recoveryReport, /Historical V4 snapshot: missing/);
  assert.match(recoveryReport, /missing facts original-date/);
  assert.doesNotMatch(recoveryReport, /Stale Alias Employer|Stale Alias Role|900000|stale alias employment/);
  assert.match(recoveryReport, /missing facts employer, role, location, employment, experience/);
  assert.match(recoveryReport, /EMPLOYER_NOT_VERIFIED; ROLE_NOT_VERIFIED/);
  assert.match(recoveryReport, /GEO_ONSITE_NOT_PUNE/);
  const currentIndiaRecovery = recoveryResult.observations.find((lead) => lead.providerJobId === 'missing-date');
  const incompleteIdentityRecovery = recoveryResult.observations.find((lead) => lead.providerJobId === 'missing-current-facts');
  const incompleteReport = renderLocalLeadReport({ ...recoveryResult, observations: [
    incompleteIdentityRecovery,
    { ...currentIndiaRecovery, providerJobId: 'unknown-experience', description: 'Build Python APIs and machine learning tools with our engineering team.',
      experience: { minYears: null, maxYears: null, evidence: null } },
  ] }, { now: '2026-07-24T06:30:00Z' });
  assert.match(incompleteReport, /Needs verification: 2/);
  assert.match(incompleteReport, /Rejected: 0/);
  assert.match(incompleteReport, /ROLE_NOT_VERIFIED/);
  assert.match(incompleteReport, /EMPLOYER_NOT_VERIFIED/);
  assert.match(incompleteReport, /EXPERIENCE_NOT_STATED_MANUAL_REVIEW/);
  assert.equal(recoveryResult.dailyReceipt.historyEvidence.status, 'missing');
  const reopenedRecoveryStore = openCrawlerStore(recoveryConfig.databasePath);
  const persistedRecovery = JSON.parse(reopenedRecoveryStore.prepare('SELECT telemetry_json FROM crawl_runs WHERE run_id = ?').get('p04-held-recovery-daily-crawler-v2').telemetry_json);
  const reopenedRunData = readCrawlerRunData(reopenedRecoveryStore, 'p04-held-recovery-daily-crawler-v2');
  reopenedRecoveryStore.close();
  assert.deepEqual(persistedRecovery.workflow.sourceYield, recoveryResult.sourceYield);
  assert.equal(persistedRecovery.workflow.sourceYield.totals.fetched, 0);
  assert.deepEqual(persistedRecovery.workflow.dailyReceipt.recovery.heldLeads, recoveryResult.heldLeadRecovery);
  assert.deepEqual(persistedRecovery.workflow.dailyReceipt.recovery.heldLeads.outcomes
    .find((item) => item.lead === 'missing-current-facts').missingFields, ['employer', 'role', 'location', 'employment', 'experience']);
  assert.equal(persistedRecovery.workflow.dailyReceipt.historyEvidence.status, 'missing');
  assert.match(persistedRecovery.workflow.dailyReceipt.retained.observations.find((row) => row.source === 'portal-glassdoor')?.evidenceContentHash, /^sha256:/);
  const replayRecoveryStore = openCrawlerStore(recoveryConfig.databasePath);
  const replayedRecovery = await runDailyNormalActual(runOptions(recoveryConfig, () => {
    throw new Error('completed recovery replay must not fetch');
  }, { runId: 'p04-held-recovery-daily', store: replayRecoveryStore, heldPortalLeads: recoveredLeads }));
  replayRecoveryStore.close();
  assert.deepEqual(replayedRecovery.sourceYield, recoveryResult.sourceYield);
  assert.equal(replayedRecovery.sourceYield.totals.fetched, 0);
  assert.equal(replayedRecovery.heldLeadRecovery.requested, 10);
  assert.equal(replayedRecovery.heldLeadRecovery.recovered, 4);

  const { config: resumableConfig } = testConfig();
  resumableConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  const resumableLead = {
    provider: 'glassdoor', providerJobId: 'resume-429', jobId: 'resume-429', source: 'portal-glassdoor', sourceId: 'portal-discovery',
    discoveryUrl: 'https://www.glassdoor.com/job-listing/resume-429', canonicalUrl: 'https://www.glassdoor.com/job-listing/resume-429',
    company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India', description: 'Index preview.', postedAt: NOW,
  };
  let resumedRequests = 0;
  const transportFailure = async () => { resumedRequests += 1; throw new Error('ECONNRESET fixture'); };
  const firstRunStore = openCrawlerStore(resumableConfig.databasePath);
  const firstRun = await runDailyNormalActual(runOptions(resumableConfig, transportFailure, {
    runId: 'p05-recovery-first', store: firstRunStore, heldPortalLeads: [resumableLead],
    clock: { now: () => '2026-07-24T06:00:00.000Z', currentTime: () => '2026-07-24T06:20:00.000Z', sleep: async () => {} },
  }));
  firstRunStore.close();
  assert.equal(resumedRequests, 1);
  assert.equal(firstRun.dailyReceipt.recovery.heldLeads.outcomes[0].recoveryState, 'pending');
  assert.equal(firstRun.dailyReceipt.recovery.heldLeads.continuation, true,
    'a first-pass pending retry must remain visible as continuation work');
  assert.equal(firstRun.dailyReceipt.recovery.heldLeads.outcomes[0].reason, 'transport-error');
  assert.equal(firstRun.dailyReceipt.recovery.heldLeads.outcomes[0].attemptCount, 1);
  assert.equal(firstRun.dailyReceipt.recovery.heldLeads.outcomes[0].attemptedAt, '2026-07-24T06:20:00.000Z');
  assert.equal(firstRun.dailyReceipt.recovery.heldLeads.outcomes[0].nextEligibleAt, '2026-07-24T07:20:00.000Z');
  const firstRetainedStore = openCrawlerStore(resumableConfig.databasePath);
  const firstStoredRecovery = readCrawlerRunData(firstRetainedStore, 'p05-recovery-first-crawler-v2')
    .observations.find(({ raw }) => raw.evidence?.recovery?.kind === 'held-lead-recovery').raw.evidence.recovery;
  assert.equal(firstStoredRecovery.evaluatedAt, '2026-07-24T06:20:00.000Z');
  assert.equal(firstRetainedStore.prepare('SELECT started_at FROM crawl_runs WHERE run_id = ?')
    .get('p05-recovery-first-crawler-v2').started_at, '2026-07-24T06:00:00.000Z',
  'attempt time must not replace the fixed run timestamp');
  firstRetainedStore.close();

  const waitingStore = openCrawlerStore(resumableConfig.databasePath);
  const waitingRun = await runDailyNormalActual(runOptions(resumableConfig, transportFailure, {
    runId: 'p05-recovery-too-early', store: waitingStore,
    clock: { now: () => '2026-07-24T07:00:00.000Z', currentTime: () => '2026-07-24T07:00:00.000Z', sleep: async () => {} },
  }));
  waitingStore.close();
  assert.equal(resumedRequests, 1, 'the reopened daily run must not fetch before retry time');
  assert.equal(waitingRun.dailyReceipt.recovery.heldLeads.waiting, 1);
  assert.equal(waitingRun.dailyReceipt.recovery.heldLeads.continuation, true);
  assert.match(renderLocalLeadReport(waitingRun, { now: '2026-07-24T07:00:00.000Z' }), /Waiting for retry: 1/);

  const repeatedWaitingStore = openCrawlerStore(resumableConfig.databasePath);
  const repeatedWaiting = await runDailyNormalActual(runOptions(resumableConfig, transportFailure, {
    runId: 'p05-recovery-explicit-waiting', store: repeatedWaitingStore,
    clock: { now: () => '2026-07-24T07:00:00.000Z', currentTime: () => '2026-07-24T07:00:00.000Z', sleep: async () => {} },
    heldPortalLeads: [resumableLead],
  }));
  repeatedWaitingStore.close();
  assert.equal(resumedRequests, 1, 'repeated explicit input must not bypass persisted backoff');
  assert.equal(repeatedWaiting.dailyReceipt.recovery.heldLeads.waiting, 1);

  const repeatedFailureStore = openCrawlerStore(resumableConfig.databasePath);
  const rateLimitedTransport = async () => {
    resumedRequests += 1;
    return { status: 429, headers: { 'Retry-After': 'Fri, 24 Jul 2026 10:30:00 GMT' }, body: 'slow down' };
  };
  const repeatedFailure = await runDailyNormalActual(runOptions(resumableConfig, rateLimitedTransport, {
    runId: 'p05-recovery-repeat-429', store: repeatedFailureStore,
    clock: { now: () => '2026-07-24T07:20:00.000Z', currentTime: () => '2026-07-24T07:25:00.000Z', sleep: async () => {} },
  }));
  repeatedFailureStore.close();
  assert.equal(resumedRequests, 2);
  assert.equal(repeatedFailure.dailyReceipt.recovery.heldLeads.outcomes[0].attemptCount, 2);
  assert.equal(repeatedFailure.dailyReceipt.recovery.heldLeads.outcomes[0].attemptedAt, '2026-07-24T07:25:00.000Z');
  assert.equal(repeatedFailure.dailyReceipt.recovery.heldLeads.outcomes[0].nextEligibleAt, '2026-07-24T10:30:00.000Z',
    'the later server deadline must win over the two-hour local backoff from the actual second attempt');

  const localBackoffWaitingStore = openCrawlerStore(resumableConfig.databasePath);
  const localBackoffWaiting = await runDailyNormalActual(runOptions(resumableConfig, async () => {
    resumedRequests += 1;
    throw new Error('the second backoff must not retry early');
  }, {
    runId: 'p05-recovery-server-deadline-wait', store: localBackoffWaitingStore,
    clock: { now: () => '2026-07-24T09:25:00.000Z', currentTime: () => '2026-07-24T09:25:00.000Z', sleep: async () => {} },
  }));
  localBackoffWaitingStore.close();
  assert.equal(resumedRequests, 2, 'no detail request is allowed before the later server deadline');
  assert.equal(localBackoffWaiting.dailyReceipt.recovery.heldLeads.waiting, 1);
  assert.equal(localBackoffWaiting.dailyReceipt.recovery.heldLeads.outcomes[0].attemptedAt, '2026-07-24T07:25:00.000Z');
  assert.equal(localBackoffWaiting.dailyReceipt.recovery.heldLeads.outcomes[0].nextEligibleAt, '2026-07-24T10:30:00.000Z');

  const successTransport = async (url) => {
    resumedRequests += 1;
    if (new URL(url).hostname === 'www.glassdoor.com') return {
      status: 302, headers: { location: 'https://boards.greenhouse.io/acme/jobs/ats-987' }, body: '',
    };
    const posting = {
      '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
      hiringOrganization: { name: 'Acme Labs' },
      description: 'Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience.',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
      datePosted: '2026-07-23', employmentType: 'FULL_TIME', identifier: { name: 'Acme Labs', value: 'ats-987' },
    };
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(posting)}</script>` };
  };
  const retryStore = openCrawlerStore(resumableConfig.databasePath);
  const retryRun = await runDailyNormalActual(runOptions(resumableConfig, successTransport, {
    runId: 'p05-recovery-after-wait', store: retryStore,
    clock: { now: () => '2026-07-24T10:30:00.000Z', currentTime: () => '2026-07-24T10:35:00.000Z', sleep: async () => {} },
  }));
  retryStore.close();
  assert.equal(resumedRequests, 4);
  assert.equal(retryRun.dailyReceipt.recovery.heldLeads.attempted, 1);
  assert.equal(retryRun.dailyReceipt.recovery.heldLeads.recovered, 1);
  assert.equal(retryRun.dailyReceipt.recovery.heldLeads.outcomes[0].attemptCount, 3);
  assert.equal(retryRun.dailyReceipt.recovery.heldLeads.outcomes[0].attemptedAt, '2026-07-24T10:35:00.000Z');
  assert.equal(retryRun.dailyReceipt.recovery.heldLeads.outcomes[0].nextEligibleAt, null);
  assert.equal(retryRun.observations.filter((candidate) => candidate.evidence?.recovery?.kind === 'held-lead-recovery').length, 1);
  const noRepeatStore = openCrawlerStore(resumableConfig.databasePath);
  const noRepeatRun = await runDailyNormalActual(runOptions(resumableConfig, async () => {
    resumedRequests += 1;
    throw new Error('successful evidence must not be fetched again');
  }, {
    runId: 'p05-recovery-no-repeat', store: noRepeatStore,
    clock: { now: () => '2026-07-25T10:00:00.000Z', sleep: async () => {} },
    heldPortalLeads: [resumableLead],
  }));
  const firstRecoveryRow = readCrawlerRunData(noRepeatStore, 'p05-recovery-first-crawler-v2').observations
    .find(({ raw }) => raw.providerJobId === 'resume-429');
  const finalRecoveryRow = readCrawlerRunData(noRepeatStore, 'p05-recovery-after-wait-crawler-v2').observations
    .find(({ raw }) => raw.jobId === 'resume-429');
  const noRepeatRows = readCrawlerRunData(noRepeatStore, 'p05-recovery-no-repeat-crawler-v2').observations;
  assert.ok(firstRecoveryRow);
  assert.ok(finalRecoveryRow);
  assert.equal(finalRecoveryRow.raw.provider, 'greenhouse');
  assert.equal(finalRecoveryRow.raw.jobId, 'resume-429');
  assert.equal(finalRecoveryRow.jobKey, firstRecoveryRow.jobKey, 'recovery must preserve the durable job identity');
  assert.equal(finalRecoveryRow.raw.evidence.recovery.providerRequisitionKey, 'glassdoor|resume 429',
    'the successful provider change must retain the original provider-qualified identity');
  assert.equal(finalRecoveryRow.raw.evidence.recovery.identityUrl, 'requisition:glassdoor|resume 429');
  assert.ok(readHeldLeadRecoveryState(noRepeatStore, { now: '2026-07-25T10:00:00.000Z' })
    .terminalIdentities.includes('requisition:glassdoor|resume 429'),
  'the reopened store must index success under the original held-lead identity');
  assert.equal(noRepeatRows.some(({ raw }) => raw.providerJobId === 'resume-429'
    && raw.evidence?.recovery?.kind === 'held-lead-recovery'), false,
    'old success must not be surfaced as current liveness evidence');
  noRepeatStore.close();
  assert.equal(resumedRequests, 4, 'explicitly resubmitted successful leads must be suppressed from recovery');

  const { config: terminalConfig } = testConfig();
  terminalConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  const terminalLeads = ['expired', 'closed', 'unresolved', 'policy-rejected',
    'other-employer-expired', 'other-title-expired', 'other-requisition-expired', 'other-employer-closed',
    'other-title-closed', 'other-requisition-closed'].map((id) => ({
    provider: 'glassdoor', providerJobId: `terminal-${id}`, jobId: `terminal-${id}`,
    discoveryUrl: `https://www.glassdoor.com/job-listing/terminal-${id}`,
    canonicalUrl: `https://www.glassdoor.com/job-listing/terminal-${id}`,
    company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India',
    ...(['other-requisition-expired', 'other-requisition-closed'].includes(id)
      ? { requisitionId: 'expected-req', employerRequisitionId: 'expected-req' } : {}),
  }));
  const terminalStore = openCrawlerStore(terminalConfig.databasePath);
  let terminalDetailRequests = 0;
  const terminalRun = await runDailyNormalActual(runOptions(terminalConfig, async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'www.glassdoor.com') {
      const id = parsed.pathname.split('/').at(-1);
      if (id === 'terminal-policy-rejected') return { status: 403, body: 'access denied' };
      if (id === 'terminal-unresolved') return { status: 404, body: 'not found' };
      return { status: 302, headers: { location: `https://boards.greenhouse.io/acme/jobs/${id}` }, body: '' };
    }
    terminalDetailRequests += 1;
    const id = parsed.pathname.split('/').at(-1);
    const posting = {
      '@context': 'https://schema.org', '@type': 'JobPosting',
      title: ['terminal-other-title-expired', 'terminal-other-title-closed'].includes(id) ? 'Different Role' : 'AI Engineer',
      hiringOrganization: { name: ['terminal-other-employer-expired', 'terminal-other-employer-closed'].includes(id) ? 'Different Employer' : 'Acme Labs' },
      description: 'Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience.',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
      datePosted: '2026-07-23', employmentType: 'FULL_TIME', identifier: { name: 'Acme Labs', value: id },
      ...(['terminal-expired', 'terminal-other-employer-expired', 'terminal-other-title-expired', 'terminal-other-requisition-expired']
        .includes(id) ? { validThrough: '2026-07-23' } : {}),
      ...(id === 'terminal-other-requisition-expired' ? { jobReqId: 'different-req' } : {}),
      ...(['terminal-closed', 'terminal-other-employer-closed', 'terminal-other-title-closed', 'terminal-other-requisition-closed']
        .includes(id) ? { isClosed: true } : {}),
    };
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(posting)}</script>` };
  }, {
    runId: 'p05-recovery-terminal-states', store: terminalStore, heldPortalLeads: terminalLeads,
  }));
  const terminalRows = readCrawlerRunData(terminalStore, 'p05-recovery-terminal-states-crawler-v2').observations
    .map(({ raw }) => raw).filter((candidate) => candidate.evidence?.recovery?.kind === 'held-lead-recovery');
  terminalStore.close();
  assert.equal(terminalDetailRequests, terminalLeads.length - 2, '403 and 404 leads do not request employer detail');
  assert.equal(terminalRows.find((candidate) => candidate.jobId === 'terminal-expired')
    .evidence.closingState.reason, 'valid-through-past');
  assert.equal(terminalRows.find((candidate) => candidate.jobId === 'terminal-closed')
    .evidence.closingState.reason, 'source-closed-flag');
  for (const id of ['terminal-other-employer-expired', 'terminal-other-title-expired', 'terminal-other-requisition-expired',
    'terminal-other-employer-closed', 'terminal-other-title-closed', 'terminal-other-requisition-closed']) {
    const candidate = terminalRows.find((item) => item.jobId === id);
    assert.equal(candidate.evidence.closingState, undefined, `${id} cannot close a different held identity`);
    assert.equal(candidate.evidence.recovery.outcome, 'superseded');
    assert.notEqual(candidate.liveness?.status, 'Active', `${id} cannot become falsely active`);
  }
  assert.deepEqual(Object.fromEntries(terminalRows.map((candidate) => [candidate.jobId, candidate.evidence.recovery.outcome])), {
    'terminal-expired': 'expired', 'terminal-closed': 'confirmed-closed',
    'terminal-unresolved': 'unresolved',
    'terminal-policy-rejected': 'policy-rejected',
    'terminal-other-employer-expired': 'superseded', 'terminal-other-title-expired': 'superseded',
    'terminal-other-requisition-expired': 'superseded', 'terminal-other-employer-closed': 'superseded',
    'terminal-other-title-closed': 'superseded', 'terminal-other-requisition-closed': 'superseded',
  });
  assert.deepEqual(Object.fromEntries(terminalRun.dailyReceipt.recovery.heldLeads.outcomes
    .map(({ lead, recoveryState }) => [lead, recoveryState])), {
    'terminal-expired': 'expired', 'terminal-closed': 'confirmed-closed',
    'terminal-unresolved': 'unresolved',
    'terminal-policy-rejected': 'policy-rejected',
    'terminal-other-employer-expired': 'superseded', 'terminal-other-title-expired': 'superseded',
    'terminal-other-requisition-expired': 'superseded', 'terminal-other-employer-closed': 'superseded',
    'terminal-other-title-closed': 'superseded', 'terminal-other-requisition-closed': 'superseded',
  });
  assert.equal(terminalRun.shortlist.some((candidate) => terminalRows.some((terminal) => terminal.jobId === candidate.jobId)), false);
  assert.equal((terminalRun.scoringQueue ?? []).some((item) => terminalRows.some((terminal) => terminal.jobId === (item.candidate ?? item).jobId)), false);
  let terminalResumeRequests = 0;
  const terminalResumeStore = openCrawlerStore(terminalConfig.databasePath);
  await runDailyNormalActual(runOptions(terminalConfig, async () => {
    terminalResumeRequests += 1;
    throw new Error('terminal outcomes must not be retried');
  }, {
    runId: 'p05-recovery-terminal-no-retry', store: terminalResumeStore,
    clock: { now: () => '2026-07-25T09:32:00.000Z', sleep: async () => {} },
  }));
  terminalResumeStore.close();
  assert.equal(terminalResumeRequests, 0, 'policy rejection and terminal outcomes must not be retried on reopen');

  const { config: legacyConfig } = testConfig();
  legacyConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  const legacyLeads = ['legacy-transient-id', 'legacy-success-id'].map((id) => ({
    provider: 'glassdoor', providerJobId: id, jobId: id,
    discoveryUrl: `https://www.glassdoor.com/job-listing/${id}`,
    canonicalUrl: `https://www.glassdoor.com/job-listing/${id}`,
    company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India',
  }));
  const legacyStore = openCrawlerStore(legacyConfig.databasePath);
  const legacyInitial = await runDailyNormalActual(runOptions(legacyConfig, async (url) => {
    const parsed = new URL(url);
    const id = parsed.pathname.split('/').at(-1);
    if (parsed.hostname === 'www.glassdoor.com') return {
      status: 200, body: `<html><h1>AI Engineer</h1><a href="https://boards.greenhouse.io/acme/jobs/${id}">Apply</a></html>`,
    };
    if (id === 'legacy-transient-id') throw new Error('ECONNRESET legacy P04 fixture');
    const posting = {
      '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
      hiringOrganization: { name: 'Acme Labs' },
      description: 'Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience.',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
      datePosted: '2026-07-23', employmentType: 'FULL_TIME', identifier: { name: 'Acme Labs', value: id },
    };
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(posting)}</script>` };
  }, { runId: 'p05-legacy-p04-recovery', store: legacyStore, heldPortalLeads: legacyLeads }));
  assert.equal(legacyInitial.dailyReceipt.recovery.heldLeads.outcomes.length, 2);
  const legacyRows = legacyStore.prepare('SELECT observation_key, raw_json FROM job_observations WHERE run_id = ?')
    .all('p05-legacy-p04-recovery-crawler-v2');
  const legacyResolvedRows = new Map(legacyInitial.observations.map((candidate) => [candidate.jobId, candidate]));
  for (const { observation_key, raw_json } of legacyRows) {
    const raw = JSON.parse(raw_json);
    if (!['legacy-transient-id', 'legacy-success-id'].includes(raw.jobId)) continue;
    const resolved = legacyResolvedRows.get(raw.jobId);
    if (!resolved) continue;
    const legacyRow = { ...resolved, evidence: { ...resolved.evidence, recovery: {
      kind: 'held-lead-recovery', originalDiscoveryUrl: resolved.discoveryUrl,
    } } };
    if (raw.jobId === 'legacy-transient-id') {
      legacyRow.originalApplicationUrl = null;
      legacyRow.applicationResolution = { status: 'Needs Verification', evidence: null };
      legacyRow.evidence.portalDetail = { status: 'extracted', applicationTargets: [
        'https://boards.greenhouse.io/acme/jobs/legacy-transient-id',
      ] };
      legacyRow.evidence.resolution = { status: 'verification', reason: 'transport-error' };
    }
    legacyStore.prepare('UPDATE job_observations SET raw_json = ? WHERE observation_key = ?')
      .run(JSON.stringify(legacyRow), observation_key);
  }
  assert.deepEqual(readHeldLeadRecoveryState(legacyStore, { now: '2026-07-24T08:00:00.000Z' }).eligible
    .map(({ jobId }) => jobId), ['legacy-transient-id']);
  assert.equal(candidateRequisitionKey({ provider: 'glassdoor', jobId: 'legacy-transient-id' }), 'glassdoor|legacy transient id');
  legacyStore.close();
  const reopenedLegacyStore = openCrawlerStore(legacyConfig.databasePath);
  let legacyRetryRequests = 0;
  const legacyRetry = await runDailyNormalActual(runOptions(legacyConfig, async (url) => {
    legacyRetryRequests += 1;
    const parsed = new URL(url);
    const id = parsed.pathname.split('/').at(-1);
    if (parsed.hostname === 'www.glassdoor.com') return {
      status: 200, body: `<html><h1>AI Engineer</h1><a href="https://boards.greenhouse.io/acme/jobs/${id}">Apply</a></html>`,
    };
    const posting = {
      '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
      hiringOrganization: { name: 'Acme Labs' },
      description: 'Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience.',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
      datePosted: '2026-07-23', employmentType: 'FULL_TIME', identifier: { name: 'Acme Labs', value: id },
    };
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(posting)}</script>` };
  }, {
    runId: 'p05-legacy-p04-reopened', store: reopenedLegacyStore,
    clock: { now: () => '2026-07-24T08:00:00.000Z', sleep: async () => {} },
  }));
  reopenedLegacyStore.close();
  assert.equal(legacyRetryRequests, 1, 'only the failed employer target should be requested, without another discovery fetch');
  assert.equal(legacyRetry.dailyReceipt.recovery.heldLeads.requested, 1);
  assert.equal(legacyRetry.dailyReceipt.recovery.heldLeads.outcomes[0].lead, 'legacy-transient-id');
  assert.equal(legacyRetry.dailyReceipt.recovery.heldLeads.recovered, 1);
  const finalLegacyStore = openCrawlerStore(legacyConfig.databasePath);
  const finalLegacyState = readHeldLeadRecoveryState(finalLegacyStore, { now: '2026-07-25T08:00:00.000Z' });
  assert.deepEqual(finalLegacyState.eligible, [], 'a newer success must suppress the legacy transient failure after reopen');
  assert.ok(finalLegacyState.terminalIdentities.includes(`requisition:${candidateRequisitionKey(legacyLeads[0])}`));
  let legacySuccessRequests = 0;
  await runDailyNormalActual(runOptions(legacyConfig, async () => {
    legacySuccessRequests += 1;
    throw new Error('newer recovery success must suppress its legacy failure');
  }, {
    runId: 'p05-legacy-p04-success-no-repeat', store: finalLegacyStore,
    clock: { now: () => '2026-07-25T08:00:00.000Z', sleep: async () => {} },
    heldPortalLeads: [legacyLeads[0]],
  }));
  finalLegacyStore.close();
  assert.equal(legacySuccessRequests, 0, 'reopened successful recovery must not request the old failed lead again');

  const { config: overlapConfig } = testConfig();
  overlapConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  const overlapLead = {
    provider: 'linkedin-jobs', providerJobId: '765432', jobId: '765432',
    source: 'portal-linkedin-jobs', sourceId: 'portal-discovery',
    discoveryUrl: 'https://www.linkedin.com/jobs/view/765432', canonicalUrl: 'https://www.linkedin.com/jobs/view/765432',
    company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India',
  };
  const overlapStore = openCrawlerStore(overlapConfig.databasePath);
  let overlapFirstRequests = 0;
  await runDailyNormalActual(runOptions(overlapConfig, async () => {
    overlapFirstRequests += 1;
    return { status: 503, body: 'temporary failure' };
  }, {
    runId: 'p05-ordinary-overlap-failure', store: overlapStore, heldPortalLeads: [overlapLead],
    clock: { now: () => '2026-07-24T08:00:00.000Z', sleep: async () => {} },
  }));
  overlapStore.close();
  assert.equal(overlapFirstRequests, 1);
  overlapConfig.sources.portals = {
    enabled: true, maxCandidates: 12, maxResolverRequests: 30, resolverConcurrency: 1, resolverMaxDurationMs: 90_000,
    http: { providers: ['linkedin-jobs'] }, linkedin: { queries: [{ keywords: 'AI Engineer', location: 'Pune' }] },
  };
  const reopenedOverlapStore = openCrawlerStore(overlapConfig.databasePath);
  const overlapRequests = [];
  const overlapCard = '<li><h3 class="base-search-card__title">AI Engineer</h3><h4 class="base-search-card__subtitle"><a>Acme Labs</a></h4><span class="job-search-card__location">Pune, India</span><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/765432"></a><time datetime="2026-07-23"></time></li>';
  const overlapRun = await runDailyNormalActual(runOptions(overlapConfig, async (url) => {
    overlapRequests.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.includes('jobs-guest')) return { status: 200, body: overlapCard };
    if (parsed.hostname === 'www.linkedin.com') return {
      status: 302, headers: { location: 'https://boards.greenhouse.io/acme/jobs/765432' }, body: '',
    };
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
      hiringOrganization: { name: 'Acme Labs' },
      description: 'Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience.',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
      datePosted: '2026-07-23', employmentType: 'FULL_TIME', identifier: { name: 'Acme Labs', value: '765432' },
    })}</script>` };
  }, {
    runId: 'p05-ordinary-overlap-success', store: reopenedOverlapStore,
    clock: { now: () => '2026-07-24T10:00:00.000Z', sleep: async () => {} },
  }));
  assert.equal(overlapRun.heldLeadRecovery.alreadyDiscovered, 1);
  assert.equal(overlapRequests.filter((url) => url.includes('/jobs/view/765432')).length, 1,
    'ordinary discovery should resolve the overlapping lead once without a separate held-lead fetch');
  assert.equal(overlapRun.sourceYield.totals.fetched, 1, 'ordinary discovery remains in discovery yield');
  const overlapResolved = overlapRun.observations.find((candidate) => candidate.jobId === '765432');
  assert.equal(overlapResolved.provider, 'greenhouse');
  assert.ok(overlapResolved.identityAliases.includes('linkedin jobs|765432'),
    'the current resolver provider change must retain the original normalized provider identity');
  assert.equal(overlapRun.observations.some((candidate) => candidate.jobId === '765432'
    && candidate.evidence?.recovery?.kind === 'held-lead-recovery'), false);
  reopenedOverlapStore.close();
  const completedOverlapStore = openCrawlerStore(overlapConfig.databasePath);
  const completedOverlapState = readHeldLeadRecoveryState(completedOverlapStore, { now: '2026-07-24T10:01:00.000Z' });
  assert.deepEqual(completedOverlapState.eligible, []);
  assert.equal(completedOverlapState.waiting, 0);
  assert.ok(completedOverlapState.terminalIdentities.includes('requisition:linkedin jobs|765432'));
  completedOverlapStore.close();
  let overlapRepeatRequests = 0;
  const noRepeatOverlapStore = openCrawlerStore(overlapConfig.databasePath);
  await runDailyNormalActual(runOptions({ ...overlapConfig, sources: { ...overlapConfig.sources, portals: { enabled: false } } }, async () => {
    overlapRepeatRequests += 1;
    throw new Error('completed ordinary overlap must not be retried');
  }, {
    runId: 'p05-ordinary-overlap-no-repeat', store: noRepeatOverlapStore,
    clock: { now: () => '2026-07-24T10:02:00.000Z', sleep: async () => {} },
  }));
  noRepeatOverlapStore.close();
  assert.equal(overlapRepeatRequests, 0);

  const { config: failedOrdinaryConfig } = testConfig();
  failedOrdinaryConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  const failedOrdinaryLead = { ...overlapLead, providerJobId: '765433', jobId: '765433',
    discoveryUrl: 'https://www.linkedin.com/jobs/view/765433', canonicalUrl: 'https://www.linkedin.com/jobs/view/765433' };
  const failedOrdinaryStore = openCrawlerStore(failedOrdinaryConfig.databasePath);
  await runDailyNormalActual(runOptions(failedOrdinaryConfig, async () => ({ status: 503, body: 'temporary failure' }), {
    runId: 'p05-ordinary-overlap-failed-held', store: failedOrdinaryStore, heldPortalLeads: [failedOrdinaryLead],
    clock: { now: () => '2026-07-24T08:00:00.000Z', sleep: async () => {} },
  }));
  failedOrdinaryStore.close();
  failedOrdinaryConfig.sources.portals = {
    enabled: true, maxCandidates: 12, maxResolverRequests: 30, resolverConcurrency: 1, resolverMaxDurationMs: 90_000,
    http: { providers: ['linkedin-jobs'] }, linkedin: { queries: [{ keywords: 'AI Engineer', location: 'Pune' }] },
  };
  const reopenedFailedOrdinaryStore = openCrawlerStore(failedOrdinaryConfig.databasePath);
  const failedOrdinaryCard = '<li><h3 class="base-search-card__title">AI Engineer</h3><h4 class="base-search-card__subtitle"><a>Acme Labs</a></h4><span class="job-search-card__location">Pune, India</span><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/765433"></a><time datetime="2026-07-23"></time></li>';
  const failedOrdinaryRun = await runDailyNormalActual(runOptions(failedOrdinaryConfig, async (url) =>
    new URL(url).pathname.includes('jobs-guest')
      ? { status: 200, body: failedOrdinaryCard }
      : { status: 503, body: 'temporary failure' }, {
    runId: 'p05-ordinary-overlap-failed-current', store: reopenedFailedOrdinaryStore,
    clock: { now: () => '2026-07-24T10:00:00.000Z', sleep: async () => {} },
  }));
  assert.equal(failedOrdinaryRun.sourceYield.totals.fetched, 1);
  const failedOrdinaryState = readHeldLeadRecoveryState(reopenedFailedOrdinaryStore, { now: '2026-07-24T10:01:00.000Z' });
  assert.deepEqual(failedOrdinaryState.eligible, [],
    'a failed ordinary resolution must back off the held lead it overlaps, not leave it due');
  assert.equal(failedOrdinaryState.waiting, 1);
  assert.equal(failedOrdinaryState.identities.length, 1);
  const failedOrdinaryRows = readCrawlerRunData(reopenedFailedOrdinaryStore, 'p05-ordinary-overlap-failed-current-crawler-v2')
    .observations.map(({ raw }) => raw);
  assert.equal(failedOrdinaryRows.some((candidate) => candidate.jobId === '765433'
    && candidate.evidence?.recovery?.kind === 'held-lead-recovery'), false);
  reopenedFailedOrdinaryStore.close();

  const { config: retryAfterConfig } = testConfig();
  retryAfterConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  const retryAfterLead = { ...overlapLead, provider: 'glassdoor', providerJobId: 'retry-after', jobId: 'retry-after',
    discoveryUrl: 'https://www.glassdoor.com/job-listing/retry-after', canonicalUrl: 'https://www.glassdoor.com/job-listing/retry-after' };
  const retryAfterStore = openCrawlerStore(retryAfterConfig.databasePath);
  const retryAfterRun = await runDailyNormalActual(runOptions(retryAfterConfig, async () => ({
    status: 429, headers: { 'Retry-After': '172800', 'x-private': 'must-not-be-retained' }, body: 'rate limited',
  }), {
    runId: 'p05-retry-after-delta', store: retryAfterStore, heldPortalLeads: [retryAfterLead],
    clock: { now: () => '2026-07-24T06:30:00.000Z', sleep: async () => {} },
  }));
  const retryAfterOutcome = retryAfterRun.dailyReceipt.recovery.heldLeads.outcomes[0];
  assert.equal(retryAfterOutcome.nextEligibleAt, '2026-07-26T06:30:00.000Z');
  const retryAfterStored = readCrawlerRunData(retryAfterStore, 'p05-retry-after-delta-crawler-v2')
    .observations.find(({ raw }) => raw.jobId === 'retry-after').raw;
  assert.equal(retryAfterStored.evidence.retryAfterAt, '2026-07-26T06:30:00.000Z');
  assert.equal(JSON.stringify(retryAfterStored).includes('must-not-be-retained'), false);
  retryAfterStore.close();
  const pastRetryAfterStore = openCrawlerStore(retryAfterConfig.databasePath);
  const pastRetryAfterLead = { ...retryAfterLead, providerJobId: 'retry-after-past', jobId: 'retry-after-past',
    discoveryUrl: 'https://www.glassdoor.com/job-listing/retry-after-past', canonicalUrl: 'https://www.glassdoor.com/job-listing/retry-after-past' };
  const pastRetryAfterRun = await runDailyNormalActual(runOptions(retryAfterConfig, async () => ({
    status: 429, headers: { 'Retry-After': 'Wed, 22 Jul 2026 06:30:00 GMT' }, body: 'rate limited',
  }), {
    runId: 'p05-retry-after-past', store: pastRetryAfterStore, heldPortalLeads: [pastRetryAfterLead],
    clock: { now: () => '2026-07-24T06:30:00.000Z', sleep: async () => {} },
  }));
  assert.equal(pastRetryAfterRun.dailyReceipt.recovery.heldLeads.outcomes[0].nextEligibleAt, '2026-07-24T07:30:00.000Z');
  pastRetryAfterStore.close();

  const { config: reopenedRateLimitConfig } = testConfig();
  reopenedRateLimitConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  const reopenedRateLimitLead = { ...retryAfterLead, providerJobId: 'retry-after-reopened', jobId: 'retry-after-reopened',
    discoveryUrl: 'https://www.glassdoor.com/job-listing/retry-after-reopened',
    canonicalUrl: 'https://www.glassdoor.com/job-listing/retry-after-reopened' };
  let reopenedRateLimitRequests = 0;
  const reopenedRateLimitTransport = async () => {
    reopenedRateLimitRequests += 1;
    return { status: 429, headers: { 'Retry-After': '86400' }, body: 'rate limited' };
  };
  const reopenedRateLimitFirstStore = openCrawlerStore(reopenedRateLimitConfig.databasePath);
  const reopenedRateLimitFirst = await runDailyNormalActual(runOptions(reopenedRateLimitConfig, reopenedRateLimitTransport, {
    runId: 'p05-retry-after-store-first', store: reopenedRateLimitFirstStore,
    heldPortalLeads: [reopenedRateLimitLead],
    clock: { now: () => '2026-10-20T09:00:00.000Z', sleep: async () => {} },
  }));
  reopenedRateLimitFirstStore.close();
  const firstRetryOutcome = reopenedRateLimitFirst.dailyReceipt.recovery.heldLeads.outcomes[0];
  assert.equal(reopenedRateLimitRequests, 1);
  assert.equal(firstRetryOutcome.attemptCount, 1);
  assert.equal(firstRetryOutcome.nextEligibleAt, '2026-10-21T09:00:00.000Z');

  const reopenedRateLimitWaitingStore = openCrawlerStore(reopenedRateLimitConfig.databasePath);
  const reopenedRateLimitWaiting = await runDailyNormalActual(runOptions(reopenedRateLimitConfig, async () => {
    reopenedRateLimitRequests += 1;
    throw new Error('stored Retry-After must prevent an early request');
  }, {
    runId: 'p05-retry-after-store-waiting', store: reopenedRateLimitWaitingStore,
    heldPortalLeads: [reopenedRateLimitLead],
    clock: { now: () => '2026-10-21T08:59:59.000Z', sleep: async () => {} },
  }));
  assert.equal(reopenedRateLimitRequests, 1);
  assert.equal(reopenedRateLimitWaiting.dailyReceipt.recovery.heldLeads.waiting, 1);
  assert.equal(reopenedRateLimitWaiting.dailyReceipt.recovery.heldLeads.continuation, true);
  assert.equal(readHeldLeadRecoveryState(reopenedRateLimitWaitingStore, { now: '2026-10-21T08:59:59.000Z' }).eligible.length, 0);
  assert.equal(readHeldLeadRecoveryState(reopenedRateLimitWaitingStore, { now: '2026-10-21T08:59:59.000Z' }).waiting, 1);
  assert.equal(readHeldLeadRecoveryState(reopenedRateLimitWaitingStore, { now: '2026-10-21T08:59:59.000Z' })
    .waitingCandidates[0].evidence.recovery.nextEligibleAt, firstRetryOutcome.nextEligibleAt);
  const retainedRetryRow = reopenedRateLimitWaitingStore.prepare('SELECT raw_json FROM job_observations WHERE raw_json LIKE ? ORDER BY observed_at DESC LIMIT 1')
    .get('%retry-after-reopened%');
  const retainedRetry = JSON.parse(retainedRetryRow.raw_json).evidence.recovery;
  assert.equal(retainedRetry.attemptCount, 1);
  assert.equal(retainedRetry.attemptedAt, '2026-10-20T09:00:00.000Z');
  assert.equal(retainedRetry.nextEligibleAt, firstRetryOutcome.nextEligibleAt);
  reopenedRateLimitWaitingStore.close();

  const reopenedRateLimitDueStore = openCrawlerStore(reopenedRateLimitConfig.databasePath);
  const reopenedRateLimitDue = await runDailyNormalActual(runOptions(reopenedRateLimitConfig, reopenedRateLimitTransport, {
    runId: 'p05-retry-after-store-due', store: reopenedRateLimitDueStore,
    clock: { now: () => '2026-10-21T09:00:00.000Z', sleep: async () => {} },
  }));
  reopenedRateLimitDueStore.close();
  assert.equal(reopenedRateLimitRequests, 2, 'the store should retry at its saved Retry-After deadline');
  assert.equal(reopenedRateLimitDue.dailyReceipt.recovery.heldLeads.outcomes[0].attemptCount, 2);
  assert.equal(reopenedRateLimitDue.dailyReceipt.recovery.heldLeads.outcomes[0].attemptedAt, '2026-10-21T09:00:00.000Z');
  assert.equal(reopenedRateLimitDue.dailyReceipt.recovery.heldLeads.outcomes[0].nextEligibleAt, '2026-10-22T09:00:00.000Z');

  const { config: rediscoveredRateLimitConfig } = testConfig();
  rediscoveredRateLimitConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  const rediscoveredRateLimitLead = {
    provider: 'linkedin-jobs', providerJobId: '100000', jobId: '100000', source: 'portal-linkedin-jobs',
    sourceId: 'portal-discovery', discoveryUrl: 'https://www.linkedin.com/jobs/view/100000',
    canonicalUrl: 'https://www.linkedin.com/jobs/view/100000', company: 'Acme Labs', title: 'AI Engineer',
    location: 'Pune, India', description: 'Index text only.', liveness: { status: 'Active' }, postedAt: '2026-10-20',
  };
  let rediscoveredNow = Date.parse('2026-10-20T09:00:00.000Z');
  let employerDetailRequests = 0;
  const resolverDetailUrls = [];
  const rediscoveredTransport = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'www.linkedin.com' && parsed.pathname.includes('jobs-guest')) return { status: 200, body: '' };
    resolverDetailUrls.push(url);
    if (parsed.hostname === 'www.linkedin.com') return { status: 302,
      headers: { location: `https://boards.greenhouse.io/acme/jobs/${parsed.pathname.split('/').at(-1)}` }, body: '' };
    employerDetailRequests += 1;
    if (parsed.pathname.endsWith('/100000') && employerDetailRequests === 1) {
      rediscoveredNow += 5 * 60_000;
      return { status: 429, headers: { 'Retry-After': '7200' }, body: 'rate limited' };
    }
    const id = parsed.pathname.split('/').at(-1);
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
        hiringOrganization: { name: 'Acme Labs' },
        description: 'Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience.',
        jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
        datePosted: '2026-10-20', employmentType: 'FULL_TIME', identifier: { name: 'Acme Labs', value: id },
      })}</script>` };
  };
  const rediscoveredFirstStore = openCrawlerStore(rediscoveredRateLimitConfig.databasePath);
  const rediscoveredFirst = await runDailyNormalActual(runOptions(rediscoveredRateLimitConfig, rediscoveredTransport, {
    runId: 'p05-linkedIn-employer-host-429-first', store: rediscoveredFirstStore,
    heldPortalLeads: [rediscoveredRateLimitLead],
    clock: { now: () => new Date(rediscoveredNow).toISOString(), sleep: async () => {} },
  }));
  const rediscoveredFirstOutcome = rediscoveredFirst.dailyReceipt.recovery.heldLeads.outcomes[0];
  assert.equal(employerDetailRequests, 1);
  assert.equal(rediscoveredFirstOutcome.reason, 'blocked');
  assert.equal(rediscoveredFirstOutcome.attemptCount, 1);
  assert.equal(rediscoveredFirstOutcome.nextEligibleAt, '2026-10-20T11:05:00.000Z');
  const firstStoredCandidate = readCrawlerRunData(rediscoveredFirstStore, 'p05-linkedIn-employer-host-429-first-crawler-v2')
    .observations.map(({ raw }) => raw).find((candidate) => candidate.jobId === '100000');
  assert.equal(firstStoredCandidate.evidence.retryAfterAt, '2026-10-20T11:05:00.000Z');
  rediscoveredFirstStore.close();
  const firstHeldDetailUrls = resolverDetailUrls.filter((url) => url.endsWith('/100000'));
  assert.equal(firstHeldDetailUrls.length, 2);

  rediscoveredRateLimitConfig.sources.portals = {
    enabled: true, maxCandidates: 12, maxResolverRequests: 30, resolverConcurrency: 1, resolverMaxDurationMs: 90_000,
    http: { providers: ['linkedin-jobs'] }, linkedin: { queries: [{ keywords: 'AI Engineer', location: 'Pune' }] },
  };
  rediscoveredNow = Date.parse('2026-10-20T11:00:00.000Z');
  let ordinarySearches = 0;
  const rediscoveredCards = [100000, 100001].map((id) => `<li><h3 class="base-search-card__title">AI Engineer</h3><h4 class="base-search-card__subtitle"><a>Acme Labs</a></h4><span class="job-search-card__location">Pune, India</span><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/${id}"></a><time datetime="2026-10-20"></time></li>`).join('');
  const rediscoveredWaitingStore = openCrawlerStore(rediscoveredRateLimitConfig.databasePath);
  const rediscoveredScorerInputs = [];
  const rediscoveredWaiting = await runDailyNormalActual(runOptions(rediscoveredRateLimitConfig, async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.includes('jobs-guest')) {
      ordinarySearches += 1;
      return { status: 200, body: rediscoveredCards };
    }
    return rediscoveredTransport(url);
  }, {
    runId: 'p05-linkedIn-employer-host-429-waiting', store: rediscoveredWaitingStore,
    scorer: async (rows) => { rediscoveredScorerInputs.push(...rows); return { scored: [] }; },
    clock: { now: () => new Date(rediscoveredNow).toISOString(), sleep: async () => {} },
  }));
  assert.equal(ordinarySearches, 1, 'ordinary LinkedIn discovery still runs after reopening the SQLite store');
  assert.equal(employerDetailRequests, 2, 'only the unrelated ordinary requisition reaches employer detail');
  assert.deepEqual(resolverDetailUrls.filter((url) => url.endsWith('/100000')), firstHeldDetailUrls,
    'ordinary rediscovery makes no portal detail or employer detail GET for the waiting requisition');
  assert.equal(rediscoveredWaiting.sourceYield.totals.fetched, 2,
    'ordinary discovery yield still records both returned jobs while one waits');
  assert.equal(rediscoveredWaiting.dailyReceipt.recovery.heldLeads.waiting, 1);
  assert.equal(rediscoveredWaiting.dailyReceipt.recovery.heldLeads.continuation, true);
  assert.equal(rediscoveredWaiting.dailyReceipt.recovery.heldLeads.outcomes[0].attemptCount, 1);
  assert.equal(rediscoveredWaiting.dailyReceipt.recovery.heldLeads.outcomes[0].attemptedAt, '2026-10-20T09:00:00.000Z');
  assert.equal(rediscoveredWaiting.dailyReceipt.recovery.heldLeads.outcomes[0].nextEligibleAt, '2026-10-20T11:05:00.000Z');
  const waitingCandidate = rediscoveredWaiting.observations.find((candidate) => candidate.jobId === '100000');
  assert.notEqual(waitingCandidate.liveness?.status, 'Active', 'a retry wait cannot reuse stale Active liveness');
  assert.notEqual(waitingCandidate.evidence?.fieldSources?.liveness, 'original-employer-detail');
  assert.equal(rediscoveredScorerInputs.some(({ jobId }) => jobId === '100000'), false);
  assert.equal(rediscoveredWaiting.results.some(({ jobId }) => jobId === '100000'), false);
  assert.equal(rediscoveredWaiting.shortlist.some(({ jobId }) => jobId === '100000'), false);
  const waitingStoredState = readHeldLeadRecoveryState(rediscoveredWaitingStore, { now: '2026-10-20T11:00:00.000Z' });
  assert.equal(waitingStoredState.waiting, 1);
  assert.equal(waitingStoredState.waitingCandidates[0].evidence.recovery.attemptCount, 1);
  assert.equal(waitingStoredState.waitingCandidates[0].evidence.recovery.nextEligibleAt, '2026-10-20T11:05:00.000Z');
  assert.notEqual(waitingStoredState.waitingCandidates[0].liveness?.status, 'Active');
  rediscoveredWaitingStore.close();

  rediscoveredNow = Date.parse('2026-10-20T11:05:00.000Z');
  const rediscoveredDueStore = openCrawlerStore(rediscoveredRateLimitConfig.databasePath);
  const rediscoveredDue = await runDailyNormalActual(runOptions(rediscoveredRateLimitConfig, async (url) => {
    return new URL(url).pathname.includes('jobs-guest') ? { status: 200, body: rediscoveredCards } : rediscoveredTransport(url);
  }, {
    runId: 'p05-linkedIn-employer-host-429-due', store: rediscoveredDueStore,
    clock: { now: () => new Date(rediscoveredNow).toISOString(), sleep: async () => {} },
  }));
  assert.equal(employerDetailRequests, 4, 'at the deadline, the held requisition receives its current employer detail retry');
  assert.equal(resolverDetailUrls.filter((url) => url.endsWith('/100000')).length, 4,
    'the held portal and employer detail GETs are allowed at the saved deadline');
  assert.equal(rediscoveredDue.observations.some((candidate) => candidate.jobId === '100000'
    && candidate.provider === 'greenhouse' && candidate.originalApplicationUrl), true,
    'ordinary discovery must retain the successful due employer detail result');
  const rediscoveredDueState = readHeldLeadRecoveryState(rediscoveredDueStore, { now: '2026-10-20T11:06:00.000Z' });
  assert.deepEqual(rediscoveredDueState.eligible, []);
  assert.equal(rediscoveredDueState.waiting, 0);
  rediscoveredDueStore.close();

  const { config: urlFallbackConfig } = testConfig();
  urlFallbackConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  const urlOnlyLead = {
    provider: 'glassdoor', source: 'portal-glassdoor', sourceId: 'portal-discovery',
    discoveryUrl: 'https://boards.greenhouse.io/acme/jobs/url-only#portal',
    canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/url-only#portal',
    company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India',
  };
  const urlOnlyStore = openCrawlerStore(urlFallbackConfig.databasePath);
  let urlOnlyEmployerRequests = 0;
  const urlOnlyFailure = await runDailyNormalActual(runOptions(urlFallbackConfig, async (url) => {
    urlOnlyEmployerRequests += 1;
    return { status: 503, body: 'temporary employer detail failure' };
  }, {
    runId: 'p05-url-fallback-idless-failure', store: urlOnlyStore, heldPortalLeads: [urlOnlyLead],
    clock: { now: () => '2026-10-20T09:00:00.000Z', sleep: async () => {} },
  }));
  assert.equal(urlOnlyEmployerRequests, 1);
  assert.equal(urlOnlyFailure.dailyReceipt.recovery.heldLeads.outcomes[0].recoveryState, 'pending');
  assert.equal(urlOnlyFailure.dailyReceipt.recovery.heldLeads.outcomes[0].attemptCount, 1);
  const urlOnlyFailureRow = readCrawlerRunData(urlOnlyStore, 'p05-url-fallback-idless-failure-crawler-v2')
    .observations.map(({ raw }) => raw).find((candidate) => candidate.evidence?.recovery?.kind === 'held-lead-recovery');
  assert.equal(urlOnlyFailureRow.evidence.recovery.providerRequisitionKey, null);
  assert.equal(urlOnlyFailureRow.evidence.recovery.identityUrl, 'url:https://boards.greenhouse.io/acme/jobs/url-only');
  urlOnlyStore.close();

  const urlOnlyOrdinaryStore = openCrawlerStore(urlFallbackConfig.databasePath);
  const urlOnlyOrdinarySuccess = {
    provider: 'greenhouse', jobId: 'resolved-ordinary-id', providerJobId: 'resolved-ordinary-id',
    source: 'ordinary-discovery', sourceId: 'ordinary-discovery',
    discoveryUrl: 'https://boards.greenhouse.io/acme/jobs/url-only#ordinary',
    canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/url-only#ordinary',
    originalApplicationUrl: 'https://boards.greenhouse.io/acme/jobs/url-only#apply',
    applicationResolution: { status: 'Resolved Original' }, classification: 'direct',
    company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India',
    evidence: { fieldSources: { company: 'original-employer-detail' } },
  };
  await crawlRun({ store: urlOnlyOrdinaryStore, runId: 'p05-url-fallback-ordinary-success-crawler-v2',
    clock: { now: () => '2026-10-20T11:00:00.000Z', sleep: async () => {} },
    sourcePlans: [{ id: 'ordinary-discovery', fetch: async () => ({ observations: [urlOnlyOrdinarySuccess] }) }] });
  urlOnlyOrdinaryStore.close();

  const urlOnlyReopenedStore = openCrawlerStore(urlFallbackConfig.databasePath);
  const urlOnlyState = readHeldLeadRecoveryState(urlOnlyReopenedStore, { now: '2026-10-20T11:01:00.000Z' });
  assert.deepEqual(urlOnlyState.eligible, [], 'later employer-detail success retires an ID-less held failure by normalized URL');
  assert.equal(urlOnlyState.waiting, 0);
  assert.equal(urlOnlyState.terminalIdentities.includes('url:https://boards.greenhouse.io/acme/jobs/url-only'), true);
  let urlOnlyRedundantRequests = 0;
  const urlOnlyNoRepeat = await runDailyNormalActual(runOptions(urlFallbackConfig, async () => {
    urlOnlyRedundantRequests += 1;
    throw new Error('ordinary employer-detail success must suppress the old held URL retry');
  }, {
    runId: 'p05-url-fallback-success-no-repeat', store: urlOnlyReopenedStore,
    clock: { now: () => '2026-10-20T11:01:00.000Z', sleep: async () => {} },
  }));
  assert.equal(urlOnlyNoRepeat.dailyReceipt.recovery?.heldLeads?.requested ?? 0, 0);
  assert.equal(urlOnlyRedundantRequests, 0);
  urlOnlyReopenedStore.close();

  const urlControlStore = openCrawlerStore(urlFallbackConfig.databasePath);
  const urlHeldControl = (sourceRecordKey, options = {}) => ({
    sourceRecordKey, provider: 'glassdoor', source: 'portal-glassdoor', sourceId: 'portal-discovery',
    discoveryUrl: `https://example.org/jobs/${options.path ?? sourceRecordKey}#held`,
    canonicalUrl: `https://example.org/jobs/${options.path ?? sourceRecordKey}#held`,
    company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India',
    evidence: { recovery: { kind: 'held-lead-recovery', outcome: 'pending', reason: 'detail-http-503',
      originalDiscoveryUrl: `https://example.org/jobs/${options.path ?? sourceRecordKey}#held`, evaluatedAt: options.evaluatedAt,
      providerRequisitionKey: options.providerRequisitionKey ?? null,
      identityUrl: options.providerRequisitionKey ? `requisition:${options.providerRequisitionKey}`
        : `url:https://example.org/jobs/${options.path ?? sourceRecordKey}` } },
  });
  const urlControlObservations = [
    urlHeldControl('different-req', { path: 'url-control', providerRequisitionKey: 'glassdoor|different req', evaluatedAt: '2026-10-20T10:00:00.000Z' }),
    urlHeldControl('failed-ordinary', { path: 'failed-control', evaluatedAt: '2026-10-20T12:00:00.000Z' }),
    urlHeldControl('equal-failure', { path: 'equal-control', evaluatedAt: '2026-10-20T11:00:00.000Z' }),
  ];
  await crawlRun({ store: urlControlStore, runId: 'p05-url-fallback-controls',
    clock: { now: () => '2026-10-20T10:00:00.000Z', sleep: async () => {} },
    sourcePlans: [{ id: 'url-fallback-controls', fetch: async () => ({ observations: urlControlObservations }) }] });
  await crawlRun({ store: urlControlStore, runId: 'p05-url-fallback-ordinary-success',
    clock: { now: () => '2026-10-20T11:00:00.000Z', sleep: async () => {} },
    sourcePlans: [{ id: 'url-fallback-ordinary-success', fetch: async () => ({ observations: [
      { ...urlOnlyOrdinarySuccess, sourceRecordKey: 'url-control-success',
        discoveryUrl: 'https://example.org/jobs/url-control#success', canonicalUrl: 'https://example.org/jobs/url-control#success',
        originalApplicationUrl: 'https://example.org/jobs/url-control#apply' },
      { ...urlOnlyOrdinarySuccess, sourceRecordKey: 'older-success', discoveryUrl: 'https://example.org/jobs/older-control#success',
        canonicalUrl: 'https://example.org/jobs/older-control#success', originalApplicationUrl: 'https://example.org/jobs/older-control#apply' },
      { ...urlOnlyOrdinarySuccess, sourceRecordKey: 'equal-success', discoveryUrl: 'https://example.org/jobs/equal-control#success',
        canonicalUrl: 'https://example.org/jobs/equal-control#success', originalApplicationUrl: 'https://example.org/jobs/equal-control#apply' },
      { sourceRecordKey: 'failed-ordinary-row', provider: 'greenhouse', discoveryUrl: 'https://example.org/jobs/failed-control#success',
        canonicalUrl: 'https://example.org/jobs/failed-control#success', classification: 'direct',
        originalApplicationUrl: 'https://example.org/jobs/failed-control#apply', applicationResolution: { status: 'Resolved Original' },
        evidence: { fieldSources: { company: 'portal-index' } } },
    ] }) }] });
  await crawlRun({ store: urlControlStore, runId: 'p05-url-fallback-older-failure',
    clock: { now: () => '2026-10-20T12:00:00.000Z', sleep: async () => {} },
    sourcePlans: [{ id: 'url-fallback-older-failure', fetch: async () => ({ observations: [
      urlHeldControl('older-failure', { path: 'older-control', evaluatedAt: '2026-10-20T12:00:00.000Z' }),
    ] }) }] });
  const urlControls = readHeldLeadRecoveryState(urlControlStore, { now: '2026-10-20T13:00:00.000Z' });
  assert.deepEqual(urlControls.eligible.map(({ sourceRecordKey }) => sourceRecordKey).sort(),
    ['different-req', 'equal-failure', 'failed-ordinary', 'older-failure'].sort(),
    'URL evidence cannot override a different proven requisition, older or equal success, or failed ordinary evidence');
  urlControlStore.close();

  const { config: urlOrderConfig } = testConfig();
  const urlOrderStore = openCrawlerStore(urlOrderConfig.databasePath);
  const urlOrderHeld = (sourceRecordKey, discoveryUrl, canonicalUrl) => ({
    sourceRecordKey, provider: 'glassdoor', source: 'portal-glassdoor', sourceId: 'portal-discovery',
    discoveryUrl, canonicalUrl, company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India',
    evidence: { recovery: { kind: 'held-lead-recovery', outcome: 'pending', reason: 'transport-error',
      originalDiscoveryUrl: discoveryUrl, evaluatedAt: '2026-10-20T09:00:00.000Z' } },
  });
  await crawlRun({ store: urlOrderStore, runId: 'p05-url-order-old-success',
    clock: { now: () => '2026-10-20T08:00:00.000Z', sleep: async () => {} },
    sourcePlans: [{ id: 'url-order-old-success', fetch: async () => ({ observations: [
      { ...urlOnlyOrdinarySuccess, sourceRecordKey: 'url-order-old-success',
        discoveryUrl: 'https://example.org/jobs/old-route#success', canonicalUrl: 'https://example.org/jobs/old-route#success',
        originalApplicationUrl: 'https://example.org/jobs/old-route#apply' },
      { ...urlOnlyOrdinarySuccess, sourceRecordKey: 'url-order-reverse-current-success',
        discoveryUrl: 'https://example.org/jobs/reverse-current#success', canonicalUrl: 'https://example.org/jobs/reverse-current#success',
        originalApplicationUrl: 'https://example.org/jobs/reverse-current#apply' },
    ] }) }],
  });
  await crawlRun({ store: urlOrderStore, runId: 'p05-url-order-held',
    clock: { now: () => '2026-10-20T09:00:00.000Z', sleep: async () => {} },
    sourcePlans: [{ id: 'url-order-held', fetch: async () => ({ observations: [
      urlOrderHeld('old-first', 'https://example.org/jobs/old-route#held', 'https://example.org/jobs/current-route#held'),
      urlOrderHeld('current-first', 'https://example.org/jobs/reverse-current#held', 'https://example.org/jobs/reverse-old#held'),
    ] }) }],
  });
  await crawlRun({ store: urlOrderStore, runId: 'p05-url-order-current-success',
    clock: { now: () => '2026-10-20T11:00:00.000Z', sleep: async () => {} },
    sourcePlans: [{ id: 'url-order-current-success', fetch: async () => ({ observations: [
      { ...urlOnlyOrdinarySuccess, sourceRecordKey: 'url-order-current-success',
        discoveryUrl: 'https://example.org/jobs/current-route#success', canonicalUrl: 'https://example.org/jobs/current-route#success',
        originalApplicationUrl: 'https://example.org/jobs/current-route#apply' },
      { ...urlOnlyOrdinarySuccess, sourceRecordKey: 'url-order-reverse-old-success',
        discoveryUrl: 'https://example.org/jobs/reverse-old#success', canonicalUrl: 'https://example.org/jobs/reverse-old#success',
        originalApplicationUrl: 'https://example.org/jobs/reverse-old#apply' },
    ] }) }],
  });
  assert.deepEqual(readHeldLeadRecoveryState(urlOrderStore, { now: '2026-10-20T12:00:00.000Z' }).eligible, [],
    'a later canonical URL success retires the ID-less held lead regardless of URL key order');
  urlOrderStore.close();

  const reopenedGood = reopenedRunData.observations.find((row) => row.raw.providerJobId === 'good')?.raw;
  assert.match(reopenedGood.description, /Build Python systems/);
  assert.deepEqual(normalizeCandidate(reopenedGood).salary, {
    minimum: 800000, maximum: 1000000, currency: 'INR', period: 'annual', evidence: '800000-1000000',
  });
  assert.equal(reopenedGood.workMode, null);
  assert.equal(reopenedGood.remoteEligibility.status, 'Not Verified');
  const reopenedMissingCurrentFacts = reopenedRunData.observations.find((row) => row.raw.providerJobId === 'missing-current-facts')?.raw;
  assert.equal(reopenedMissingCurrentFacts.company, null);
  assert.equal(reopenedMissingCurrentFacts.title, null);
  assert.equal(reopenedMissingCurrentFacts.evidence.fieldSources.company, null);
  assert.equal(reopenedMissingCurrentFacts.evidence.fieldSources.title, null);
  assert.equal(reopenedMissingCurrentFacts.salary?.minimum ?? null, null);
  assert.equal(reopenedMissingCurrentFacts.employment?.type ?? null, null);
  assert.equal(reopenedMissingCurrentFacts.experience?.minYears ?? null, null);
  assert.equal(reopenedMissingCurrentFacts.description, 'Build Python APIs.');
  for (const field of ['companyName', 'role', 'employmentType', 'type', 'minYears', 'minimumYears', 'experienceMinYears']) {
    assert.equal(reopenedMissingCurrentFacts[field], null, `stored ${field} must remain cleared`);
  }
  for (const field of ['salaryMin', 'salaryMax', 'salaryCurrency', 'salaryPeriod', 'salaryEvidence']) {
    assert.equal(reopenedMissingCurrentFacts[field], undefined, `stored ${field} fallback must remain absent`);
  }
  const reopenedMissingEmployment = reopenedRunData.observations.find((row) => row.raw.providerJobId === 'missing-employment')?.raw;
  assert.deepEqual(normalizeCandidate(reopenedMissingEmployment).salary, {
    minimum: null, maximum: null, currency: null, period: null, evidence: null,
  });
  assert.equal(reopenedGood.eligibility.geo.pass, false);
  const reopenedIndia = reopenedRunData.observations.find((row) => row.raw.providerJobId === 'missing-date')?.raw;
  assert.equal(reopenedIndia.eligibility.geo.pass, true);
  assert.equal(reopenedIndia.location, 'Pune, India');
  const reopenedRemote = reopenedRunData.observations.find((row) => row.raw.providerJobId === 'missing-employment')?.raw;
  assert.equal(reopenedRemote.eligibility.geo.pass, true);
  assert.equal(reopenedRemote.eligibility.geo.mode, 'remote');
  assert.equal(reopenedRemote.remoteEligibility.status, 'Not Verified');
  assert.equal(reopenedIndia.remoteEligibility.status, 'Not Verified');
  assert.equal(reopenedGood.originalApplicationUrl, 'https://boards.greenhouse.io/acme/jobs/good');
  assert.equal(reopenedGood.evidence.recovery.originalDiscoverySource, 'portal-glassdoor');

  const { config: duplicateConfig } = testConfig();
  duplicateConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  const duplicateLead = {
    ...recoveredLeads[0], provider: 'greenhouse', jobId: 'duplicate-opening', providerJobId: 'duplicate-opening',
    discoveryUrl: 'https://www.glassdoor.com/job-listing/duplicate-opening',
    canonicalUrl: 'https://www.glassdoor.com/job-listing/duplicate-opening',
    identityAliases: ['glassdoor|old-shared'],
  };
  const distinctRequisitionLead = {
    ...duplicateLead,
    jobId: 'distinct-opening', providerJobId: 'distinct-opening',
    discoveryUrl: 'https://www.glassdoor.com/job-listing/distinct-opening',
    canonicalUrl: 'https://www.glassdoor.com/job-listing/distinct-opening',
    identityAliases: ['glassdoor|old-shared'],
  };
  const duplicateRequests = [];
  const duplicateResult = await runDailyNormalActual(runOptions(duplicateConfig, async (url) => {
    duplicateRequests.push(url);
    if (new URL(url).hostname === 'boards.greenhouse.io'
      && new URL(url).pathname.endsWith('/distinct-opening')) {
      return { status: 200, body: `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
        hiringOrganization: { name: 'Acme Labs' },
        description: 'Full-time AI Engineer in Pune, India. Build Python systems. 5 years experience.',
        jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
        datePosted: '2026-07-23', employmentType: 'FULL_TIME', identifier: { name: 'Acme Labs', value: 'distinct-opening' },
      })}</script>` };
    }
    return recoveryTransport(url);
  }, {
    runId: 'p04-held-recovery-duplicates', heldPortalLeads: [duplicateLead, duplicateLead, distinctRequisitionLead],
  }));
  assert.equal(duplicateRequests.length, 4);
  assert.equal(duplicateResult.heldLeadRecovery.requested, 3);
  assert.equal(duplicateResult.heldLeadRecovery.distinct, 2);
  assert.equal(duplicateResult.heldLeadRecovery.duplicates, 1);
  assert.equal(duplicateResult.heldLeadRecovery.recovered, 2);
  assert.equal(duplicateResult.heldLeadRecovery.outcomes.length, 2);
  assert.deepEqual(duplicateResult.heldLeadRecovery.outcomes.map((item) => item.lead), ['duplicate-opening', 'distinct-opening']);
  const distinctCurrent = duplicateResult.observations.find((lead) => lead.providerJobId === 'distinct-opening');
  assert.equal(distinctCurrent.experience.minYears, 5);
  assert.match(distinctCurrent.experience.evidence, /5 years experience/);
  assert.equal(distinctCurrent.eligibility.experience.strict, false);

  const { config: currentDiscoveryConfig } = testConfig();
  currentDiscoveryConfig.sources.portals = {
    enabled: true, maxCandidates: 24, maxResolverRequests: 30, resolverMaxDurationMs: 90_000,
    http: { providers: ['linkedin-jobs'] },
    linkedin: { queries: [{ keywords: 'AI Engineer', location: 'Pune' }] },
  };
  const linkedinDetail = '<li><h3 class="base-search-card__title">AI Engineer</h3><h4 class="base-search-card__subtitle"><a>Acme Labs</a></h4><span class="job-search-card__location">Pune, India</span><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/123456"></a><time datetime="2026-07-23"></time></li>';
  const currentDiscoveryRequests = [];
  const currentDiscoveryTransport = async (url) => {
    currentDiscoveryRequests.push(url);
    const parsed = new URL(url);
    if (parsed.hostname === 'www.linkedin.com' && parsed.pathname.includes('jobs-guest')) {
      return { status: 200, body: linkedinDetail };
    }
    if (parsed.hostname === 'www.glassdoor.com') {
      return { status: 302, headers: { location: 'https://boards.greenhouse.io/acme/jobs/different-requisition' }, body: '' };
    }
    if (parsed.hostname === 'www.linkedin.com') {
      return { status: 302, headers: { location: 'https://boards.greenhouse.io/acme/jobs/123456' }, body: '' };
    }
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
      hiringOrganization: { name: 'Acme Labs' },
      description: 'Full-time AI Engineer in Pune, India. Build Python systems. 0-1 years experience.',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
      datePosted: '2026-07-23', employmentType: 'FULL_TIME', identifier: { name: 'Acme Labs', value: '123456' },
    })}</script>` };
  };
  const retainedLinkedInLead = {
    canonicalUrl: 'https://www.linkedin.com/jobs/view/123456',
    discoveryUrl: 'https://www.linkedin.com/jobs/view/123456',
    provider: 'linkedin-jobs', jobId: '123456', providerJobId: '123456',
    identityAliases: ['linkedin-jobs|old-shared'],
    source: 'portal-linkedin-jobs', sourceId: 'portal-discovery',
    company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India',
  };
  const distinctRetainedLead = {
    ...retainedLinkedInLead,
    provider: 'linkedin-jobs',
    jobId: 'different-requisition',
    providerJobId: 'different-requisition',
    canonicalUrl: 'https://www.glassdoor.com/job-listing/different-requisition',
    discoveryUrl: 'https://www.glassdoor.com/job-listing/different-requisition',
  };
  const currentDiscoveryStore = openCrawlerStore(currentDiscoveryConfig.databasePath);
  const duplicateCurrentDiscovery = await runDailyNormalActual(runOptions(currentDiscoveryConfig, currentDiscoveryTransport, {
    store: currentDiscoveryStore,
    runId: 'p04-held-recovery-current-discovery',
    heldPortalLeads: [retainedLinkedInLead, retainedLinkedInLead, distinctRetainedLead],
  }));
  currentDiscoveryStore.close();
  assert.equal(duplicateCurrentDiscovery.heldLeadRecovery.rawRequested, 3);
  assert.equal(duplicateCurrentDiscovery.heldLeadRecovery.distinct, 2);
  assert.equal(duplicateCurrentDiscovery.heldLeadRecovery.duplicates, 1);
  assert.equal(duplicateCurrentDiscovery.heldLeadRecovery.alreadyDiscovered, 1);
  assert.equal(duplicateCurrentDiscovery.heldLeadRecovery.outcomes.length, 1);
  assert.equal(duplicateCurrentDiscovery.heldLeadRecovery.attempted, 1, 'recovery must make progress beside current discovery');
  assert.equal(duplicateCurrentDiscovery.heldLeadRecovery.recovered, 1);
  assert.equal(duplicateCurrentDiscovery.heldLeadRecovery.outcomes[0].lead, 'different-requisition');
  assert.equal(currentDiscoveryRequests.filter((url) => url.includes('/jobs/view/123456')).length, 1);
  assert.equal(duplicateCurrentDiscovery.sourceYield.totals.fetched, 1, 'known held leads must stay outside discovery yield');
  assert.equal(duplicateCurrentDiscovery.sourceYield.sources.reduce((sum, row) => sum + row.fetched, 0), 1);
  const reopenedCurrentDiscoveryStore = openCrawlerStore(currentDiscoveryConfig.databasePath);
  const persistedCurrentDiscovery = JSON.parse(reopenedCurrentDiscoveryStore.prepare(
    'SELECT telemetry_json FROM crawl_runs WHERE run_id = ?',
  ).get('p04-held-recovery-current-discovery-crawler-v2').telemetry_json);
  reopenedCurrentDiscoveryStore.close();
  assert.deepEqual(persistedCurrentDiscovery.workflow.sourceYield, duplicateCurrentDiscovery.sourceYield);
  assert.equal(persistedCurrentDiscovery.workflow.sourceYield.totals.fetched, 1);

  const { config: sharedBudgetConfig } = testConfig();
  sharedBudgetConfig.sources.portals = {
    enabled: true, maxCandidates: 12, maxResolverRequests: 4, resolverConcurrency: 2, resolverMaxDurationMs: 90_000,
    http: { providers: ['linkedin-jobs'] },
    linkedin: { queries: [{ keywords: 'AI Engineer', location: 'Pune' }] },
  };
  const budgetHeldLeads = Array.from({ length: 10 }, (_, index) => ({
    provider: index % 2 === 0 ? 'glassdoor' : 'wellfound', providerJobId: `shared-budget-${index}`, jobId: `shared-budget-${index}`,
    discoveryUrl: `https://${index % 2 === 0 ? 'www.glassdoor.com' : 'wellfound.com'}/job-listing/shared-budget-${index}`,
    canonicalUrl: `https://${index % 2 === 0 ? 'www.glassdoor.com' : 'wellfound.com'}/job-listing/shared-budget-${index}`,
    company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India',
  }));
  const budgetDailyStore = openCrawlerStore(sharedBudgetConfig.databasePath);
  const firstBudgetRequests = [];
  const firstBudgetTransport = async (url) => {
    firstBudgetRequests.push(url);
    const parsed = new URL(url);
    if (parsed.hostname === 'www.linkedin.com' && parsed.pathname.includes('jobs-guest')) {
      return { status: 200, body: linkedinDetail.replaceAll('123456', '765432') };
    }
    if (['www.glassdoor.com', 'wellfound.com'].includes(parsed.hostname)) return {
      status: 302, headers: { location: `https://boards.greenhouse.io/acme/jobs/${parsed.pathname.split('/').at(-1)}` }, body: '',
    };
    if (parsed.hostname === 'www.linkedin.com') return {
      status: 302, headers: { location: 'https://boards.greenhouse.io/acme/jobs/ordinary-budget' }, body: '',
    };
    const id = parsed.pathname.split('/').at(-1);
    const posting = {
      '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
      hiringOrganization: { name: 'Acme Labs' },
      description: 'Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience.',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
      datePosted: '2026-07-23', employmentType: 'FULL_TIME', identifier: { name: 'Acme Labs', value: id },
    };
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(posting)}</script>` };
  };
  const firstBudgetRun = await runDailyNormalActual(runOptions(sharedBudgetConfig, firstBudgetTransport, {
    runId: 'p05-recovery-shared-budget-first', store: budgetDailyStore, heldPortalLeads: budgetHeldLeads,
  }));
  assert.equal(firstBudgetRequests.filter((url) => new URL(url).hostname === 'boards.greenhouse.io').length, 1,
    'ordinary discovery should use the two requests left after the recovery reservation');
  assert.equal(firstBudgetRun.dailyReceipt.recovery.heldLeads.requested, 10);
  assert.equal(firstBudgetRun.dailyReceipt.recovery.heldLeads.attempted, 2);
  assert.equal(firstBudgetRun.dailyReceipt.recovery.heldLeads.continuation, true);
  assert.ok(firstBudgetRun.observations.some((candidate) =>
    candidate.originalApplicationUrl === 'https://boards.greenhouse.io/acme/jobs/ordinary-budget'),
  'the ordinary discovery candidate should still resolve beside held-lead recovery');
  const persistedBudgetRows = readCrawlerRunData(budgetDailyStore, 'p05-recovery-shared-budget-first-crawler-v2')
    .observations.map(({ raw }) => raw).filter((candidate) => candidate.evidence?.recovery?.kind === 'held-lead-recovery');
  for (const lead of budgetHeldLeads.slice(0, 2)) {
    const sourceHost = new URL(lead.discoveryUrl).hostname;
    const receiptOutcome = firstBudgetRun.dailyReceipt.recovery.heldLeads.outcomes
      .find(({ lead: id }) => id === lead.jobId);
    const returned = firstBudgetRun.observations.find((candidate) => candidate.jobId === lead.jobId);
    const persisted = persistedBudgetRows.find((candidate) => candidate.jobId === lead.jobId);
    assert.equal(receiptOutcome.requests, 1);
    assert.equal(firstBudgetRequests.filter((url) => new URL(url).hostname === sourceHost
      && new URL(url).pathname.endsWith(lead.jobId)).length, 1);
    assert.equal(receiptOutcome.recoveryState, 'pending');
    assert.equal(receiptOutcome.reason, 'request-budget-exhausted');
    assert.equal(receiptOutcome.attemptCount, 1);
    assert.equal(receiptOutcome.attemptedAt, '2026-07-24T06:30:00.000Z');
    assert.equal(receiptOutcome.nextEligibleAt, '2026-07-24T07:30:00.000Z');
    assert.equal(returned.evidence.recovery.outcome, receiptOutcome.recoveryState);
    assert.equal(returned.evidence.recovery.reason, receiptOutcome.reason);
    assert.equal(returned.evidence.recovery.attemptCount, receiptOutcome.attemptCount);
    assert.equal(returned.evidence.recovery.attemptedAt, receiptOutcome.attemptedAt);
    assert.equal(returned.evidence.recovery.nextEligibleAt, receiptOutcome.nextEligibleAt);
    assert.equal(persisted.evidence.recovery.outcome, receiptOutcome.recoveryState);
    assert.equal(persisted.evidence.recovery.reason, receiptOutcome.reason);
    assert.equal(persisted.evidence.recovery.attemptCount, receiptOutcome.attemptCount);
    assert.equal(persisted.evidence.recovery.attemptedAt, receiptOutcome.attemptedAt);
    assert.equal(persisted.evidence.recovery.nextEligibleAt, receiptOutcome.nextEligibleAt);
  }
  for (const lead of budgetHeldLeads.slice(2)) {
    const sourceHost = new URL(lead.discoveryUrl).hostname;
    const receiptOutcome = firstBudgetRun.dailyReceipt.recovery.heldLeads.outcomes
      .find(({ lead: id }) => id === lead.jobId);
    const returned = firstBudgetRun.observations.find((candidate) => candidate.jobId === lead.jobId);
    const persisted = persistedBudgetRows.find((candidate) => candidate.jobId === lead.jobId);
    assert.equal(receiptOutcome.recoveryState, 'pending');
    assert.equal(receiptOutcome.reason, 'request-budget-exhausted');
    assert.equal(receiptOutcome.requests, 0);
    assert.equal(receiptOutcome.attemptCount, 0);
    assert.equal(receiptOutcome.attemptedAt, null);
    assert.equal(receiptOutcome.nextEligibleAt, null);
    assert.equal(firstBudgetRequests.filter((url) => new URL(url).hostname === sourceHost
      && new URL(url).pathname.endsWith(lead.jobId)).length, 0);
    assert.equal(returned.evidence.recovery.outcome, receiptOutcome.recoveryState);
    assert.equal(returned.evidence.recovery.reason, receiptOutcome.reason);
    assert.equal(returned.evidence.recovery.attemptCount, receiptOutcome.attemptCount);
    assert.equal(returned.evidence.recovery.attemptedAt, undefined);
    assert.equal(returned.evidence.recovery.nextEligibleAt, null);
    assert.equal(persisted.evidence.recovery.outcome, receiptOutcome.recoveryState);
    assert.equal(persisted.evidence.recovery.reason, receiptOutcome.reason);
    assert.equal(persisted.evidence.recovery.attemptCount, receiptOutcome.attemptCount);
    assert.equal(persisted.evidence.recovery.attemptedAt, undefined);
    assert.equal(persisted.evidence.recovery.nextEligibleAt, null);
  }
  budgetDailyStore.close();
  const reopenedBudgetStore = openCrawlerStore(sharedBudgetConfig.databasePath);
  const dueBudgetState = readHeldLeadRecoveryState(reopenedBudgetStore, { now: '2026-07-24T07:31:00.000Z' });
  assert.deepEqual(new Set(dueBudgetState.eligible.map(({ jobId }) => jobId)),
    new Set(budgetHeldLeads.map(({ jobId }) => jobId)), 'budget exhaustion must keep every lead eligible after reopen');
  sharedBudgetConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  const retriedBudgetRequests = new Map();
  const reopenedBudgetRun = await runDailyNormalActual(runOptions(sharedBudgetConfig, async (url) => {
    const parsed = new URL(url);
    const id = parsed.pathname.split('/').at(-1);
    if (['www.glassdoor.com', 'wellfound.com'].includes(parsed.hostname)) {
      retriedBudgetRequests.set(id, (retriedBudgetRequests.get(id) ?? 0) + 1);
      return { status: 302, headers: { location: `https://boards.greenhouse.io/acme/jobs/${id}` }, body: '' };
    }
    const posting = {
      '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
      hiringOrganization: { name: 'Acme Labs' },
      description: 'Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience.',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
      datePosted: '2026-07-23', employmentType: 'FULL_TIME', identifier: { name: 'Acme Labs', value: id },
    };
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(posting)}</script>` };
  }, {
    runId: 'p05-recovery-shared-budget-reopened', store: reopenedBudgetStore,
    clock: { now: () => '2026-07-24T07:31:00.000Z', sleep: async () => {} },
  }));
  reopenedBudgetStore.close();
  assert.equal(retriedBudgetRequests.size, 10);
  assert.ok(budgetHeldLeads.every(({ jobId }) => retriedBudgetRequests.has(jobId)),
    'the reopened daily workflow must retry all budget-exhausted identities without terminal discard');
  assert.equal(reopenedBudgetRun.dailyReceipt.recovery.heldLeads.requested, 10);
  assert.equal(reopenedBudgetRun.dailyReceipt.recovery.heldLeads.recovered, 10);
  assert.ok(reopenedBudgetRun.dailyReceipt.recovery.heldLeads.outcomes
    .every(({ recoveryState, attemptCount }) => recoveryState === 'recovered' && attemptCount >= 1));

  const { config: requestConfig } = testConfig();
  requestConfig.sources.portals = { enabled: false, maxResolverRequests: 1, resolverMaxDurationMs: 90_000 };
  const requestLimited = await runDailyNormal(runOptions(requestConfig, recoveryTransport, {
    runId: 'p04-held-recovery-request-cap', heldPortalLeads: [recoveredLeads[0]],
  }));
  assert.equal(requestLimited.dailyReceipt.recovery.heldLeads.blocked, 1);
  assert.equal(requestLimited.dailyReceipt.recovery.heldLeads.outcomes[0].reason, 'request-budget-exhausted');
  assert.match(renderLocalLeadReport(requestLimited, { now: '2026-07-24T06:30:00Z' }), /Request budget exhausted: Yes/);

  const { config: deadlineConfig } = testConfig();
  deadlineConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  let monotonic = 0;
  const deadlineLimited = await runDailyNormal(runOptions(deadlineConfig, async (url) => {
    const response = await recoveryTransport(url);
    monotonic += 100_000;
    return response;
  }, {
    runId: 'p04-held-recovery-deadline-cap', clock: { now: () => NOW, monotonicNow: () => monotonic, sleep: async () => {} },
    heldPortalLeads: [recoveredLeads[0]],
  }));
  assert.equal(deadlineLimited.dailyReceipt.recovery.heldLeads.blocked, 1);
  assert.match(deadlineLimited.dailyReceipt.recovery.heldLeads.outcomes[0].reason, /deadline/);
  assert.match(renderLocalLeadReport(deadlineLimited, { now: '2026-07-24T06:30:00Z' }), /Deadline exhausted: Yes/);

  const { config: leadCapConfig } = testConfig();
  leadCapConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  const cappedLeads = Array.from({ length: 11 }, (_, index) => ({
    ...recoveredLeads[0],
    jobId: `cap-${index}`,
    providerJobId: `cap-${index}`,
    discoveryUrl: `https://www.glassdoor.com/job-listing/cap-${index}`,
    canonicalUrl: `https://www.glassdoor.com/job-listing/cap-${index}`,
  }));
  const leadCapped = await runDailyNormal(runOptions(leadCapConfig, recoveryTransport, {
    runId: 'p04-held-recovery-lead-cap', heldPortalLeads: cappedLeads,
  }));
  assert.equal(leadCapped.dailyReceipt.recovery.heldLeads.requested, 11);
  assert.equal(leadCapped.dailyReceipt.recovery.heldLeads.attempted, 10);
  assert.equal(leadCapped.dailyReceipt.recovery.heldLeads.unattempted, 1);
  assert.equal(leadCapped.crawlerV2Telemetry['portal-discovery'].detail.telemetry.resolutionRequests, 20);
  assert.match(renderLocalLeadReport(leadCapped, { now: '2026-07-24T06:30:00Z' }), /Unattempted: 1/);
  const leadCapResumeStore = openCrawlerStore(leadCapConfig.databasePath);
  const leadCapResume = await runDailyNormalActual(runOptions(leadCapConfig, recoveryTransport, {
    runId: 'p05-held-recovery-lead-cap-resume', store: leadCapResumeStore,
    clock: { now: () => '2026-07-24T07:30:00.000Z', sleep: async () => {} },
  }));
  leadCapResumeStore.close();
  assert.equal(leadCapResume.dailyReceipt.recovery.heldLeads.requested, 1);
  assert.equal(leadCapResume.dailyReceipt.recovery.heldLeads.attempted, 1);
  assert.equal(leadCapResume.dailyReceipt.recovery.heldLeads.recovered, 1);

  const { config: overflowConfig } = testConfig();
  overflowConfig.sources.portals = { enabled: false, maxResolverRequests: 30, resolverMaxDurationMs: 90_000 };
  const overflowLeads = Array.from({ length: 31 }, (_, index) => ({
    provider: 'glassdoor', providerJobId: `overflow-${index + 1}`, jobId: `overflow-${index + 1}`,
    discoveryUrl: `https://www.glassdoor.com/job-listing/overflow-${index + 1}`,
    canonicalUrl: `https://www.glassdoor.com/job-listing/overflow-${index + 1}`,
    company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India',
  }));
  const overflowStore = openCrawlerStore(overflowConfig.databasePath);
  const overflowRequested = [];
  let overflowNetworkRequests = 0;
  for (const [index, at] of ['2026-07-24T07:00:00.000Z', '2026-07-24T08:01:00.000Z',
    '2026-07-24T09:02:00.000Z', '2026-07-24T10:03:00.000Z'].entries()) {
    const overflowRun = await runDailyNormalActual(runOptions(overflowConfig, async (url) => {
      overflowNetworkRequests += 1;
      const parsed = new URL(url);
      const id = parsed.pathname.split('/').at(-1);
      if (parsed.hostname === 'www.glassdoor.com') return {
        status: 302, headers: { location: `https://boards.greenhouse.io/acme/jobs/${id}` }, body: '',
      };
      const posting = {
        '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer',
        hiringOrganization: { name: 'Acme Labs' },
        description: `Full-time AI Engineer in Pune, India. Build Python services. 0-1 years experience. ${id}`,
        jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'India' } },
        datePosted: '2026-07-23', employmentType: 'FULL_TIME', identifier: { name: 'Acme Labs', value: id },
      };
      return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(posting)}</script>` };
    }, {
      runId: `p05-recovery-overflow-${index + 1}`, store: overflowStore,
      clock: { now: () => at, sleep: async () => {} },
      ...(index === 0 ? { heldPortalLeads: overflowLeads } : {}),
    }));
    for (const outcome of overflowRun.dailyReceipt.recovery.heldLeads.outcomes) {
      if (outcome.requests > 0) overflowRequested.push(outcome.lead);
    }
    if (index === 0) {
      assert.equal(overflowRun.dailyReceipt.recovery.heldLeads.requested, 31);
      assert.equal(overflowRun.dailyReceipt.recovery.heldLeads.attempted, 10);
      assert.equal(overflowRun.dailyReceipt.recovery.heldLeads.unattempted, 21);
      assert.equal(overflowRun.dailyReceipt.recovery.heldLeads.continuation, true);
      const cappedLead = overflowLeads[10];
      const cappedRaw = overflowRun.observations.find(({ jobId }) => jobId === cappedLead.jobId);
      const cappedOutcome = overflowRun.dailyReceipt.recovery.heldLeads.outcomes
        .find(({ lead }) => lead === cappedLead.jobId);
      const storedCappedRaw = overflowStore.prepare('SELECT raw_json FROM job_observations WHERE run_id = ? AND raw_json LIKE ?')
        .all('p05-recovery-overflow-1-crawler-v2', `%${cappedLead.jobId}%`)
        .map(({ raw_json }) => JSON.parse(raw_json))
        .find((candidate) => candidate.evidence?.recovery?.kind === 'held-lead-recovery');
      assert.equal(cappedRaw.evidence.recovery.outcome, 'pending');
      assert.equal(cappedRaw.evidence.recovery.reason, 'candidate-cap-exceeded');
      assert.equal(cappedRaw.evidence.recovery.attemptedAt, undefined);
      assert.equal(cappedRaw.evidence.recovery.attemptCount, 0);
      assert.equal(cappedOutcome.recoveryState, 'pending');
      assert.equal(cappedOutcome.reason, 'candidate-cap-exceeded');
      assert.equal(cappedOutcome.attemptedAt, null);
      assert.equal(cappedOutcome.attemptCount, 0);
      assert.equal(storedCappedRaw.evidence.recovery.outcome, cappedRaw.evidence.recovery.outcome);
      assert.equal(storedCappedRaw.evidence.recovery.reason, cappedRaw.evidence.recovery.reason);
      assert.equal(storedCappedRaw.evidence.recovery.attemptCount, cappedRaw.evidence.recovery.attemptCount);
    }
  }
  const overflowRows = overflowStore.prepare('SELECT raw_json FROM job_observations').all()
    .map(({ raw_json }) => JSON.parse(raw_json))
    .filter((candidate) => candidate.evidence?.recovery?.kind === 'held-lead-recovery');
  overflowStore.close();
  assert.equal(new Set(overflowRows.map((candidate) => candidate.jobId)).size, 31,
    'all admitted leads must remain in the reopened observation history');
  assert.equal(overflowRequested.length, 31, 'bounded reopened runs must request each admitted lead once');
  assert.equal(new Set(overflowRequested).size, 31, 'each admitted lead must be requested in only one run');
  assert.equal(overflowNetworkRequests, 62, 'each lead should use one portal and one employer request across bounded runs');

  const { config: experienceConfig } = testConfig();
  const hidden = rawPortalJob(1961, {
    company: 'Hidden Senior Requirements',
    title: 'Junior AI Engineer',
    description: 'Full-time Pune AI role. Requirements: 7-10+ years building production backend systems; 5+ years hands-on with AWS. Junior team environment with mentoring responsibilities.',
    experience: { minYears: 1, maxYears: 1, evidence: '1 year source minimum' },
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
  });
  const ambiguous = rawPortalJob(1962, {
    company: 'Unassigned Experience Tracks',
    description: 'Full-time Pune AI role. Experience: 0-1 or 6+ years depending on level; no assignment.',
    experience: { minYears: 1, maxYears: 1, evidence: '1 year source minimum' },
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
  });
  const foreignAmbiguous = rawPortalJob(1977, {
    company: 'Foreign Ambiguous Experience',
    location: 'London, United Kingdom',
    description: 'Full-time AI role. Experience: 0-1 or 6+ years depending on level; no assignment.',
    experience: { minYears: 1, maxYears: 1, evidence: '1 year source minimum' },
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
  });
  const conditionalTrack = rawPortalJob(1970, {
    company: 'Conditional Track Selection',
    description: 'Full-time Pune AI role. This opening is for the junior track or senior track depending on interview performance. Junior track: 1 year experience. Senior track: 6 years experience.',
    experience: { minYears: 1, maxYears: 1, evidence: '1 year source minimum' },
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
  });
  const selectedJunior = rawPortalJob(1963, {
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
    experience: undefined,
    company: 'Selected Junior Track',
    description: 'Full-time Pune AI role. This opening is for the junior track.\nJunior track:\n0-1 years experience\nSenior track:\n6+ years experience',
  });
  const preferred = rawPortalJob(1964, {
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
    company: 'Preferred Five Years',
    description: 'Full-time Pune AI role. Preferred qualifications:\n5+ years with AWS.\nRequirements:\nMinimum 1 year overall experience.',
    experience: { minYears: 1, maxYears: 1, evidence: '1 year source minimum' },
  });
  const twoYears = rawPortalJob(1965, {
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
    company: 'Two Years Fallback',
    description: 'Full-time Pune AI role. 2-4 years of software development experience required.',
    experience: { minYears: 2, maxYears: 2, evidence: '2 years source minimum' },
  });
  const universalSenior = rawPortalJob(1966, {
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
    company: 'Universal Senior Requirement',
    description: 'Full-time Pune AI role. This opening is for the junior track. Junior track: 1 year experience; Senior track: 6 years experience, but all candidates must have 5 years of AWS experience.',
    experience: { minYears: 1, maxYears: 1, evidence: '1 year source minimum' },
  });
  const universalAfterTrackRequirements = rawPortalJob(1971, {
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
    company: 'Universal Requirement After Quantity',
    description: 'Full-time Pune AI role. This opening is for the junior track.\nJunior track:\n1 year experience\nSenior track:\n6 years experience\n5 years AWS experience required for all candidates.',
    experience: { minYears: 1, maxYears: 1, evidence: '1 year source minimum' },
  });
  const conditionalAssignment = rawPortalJob(1972, {
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
    company: 'Conditional Assignment After Interview',
    description: 'Full-time Pune AI role. This opening is for the junior track if selected after interview. Junior track: 1 year experience. Senior track: 6 years experience.',
    experience: { minYears: 1, maxYears: 1, evidence: '1 year source minimum' },
  });
  const structuredMinimumAndConflict = rawPortalJob(1973, {
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
    company: 'Structured Minimum with Unassigned Tracks',
    description: 'Full-time Pune AI role. Junior track: 1 year experience. Senior track: 6 years experience.',
    experience: { minYears: 5, maxYears: null, sourceMinYears: 5, sourceMaxYears: null, sourceMaxUnbounded: true, evidence: 'JobPosting.experienceRequirements.monthsOfExperience=60' },
  });
  const recoveredSourceMinimum = rawPortalJob(1975, {
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
    company: 'Recovered Source Minimum with Preference',
    description: 'Full-time Pune AI role.',
    experience: { minYears: 1, evidence: 'Minimum 5 years of software experience required. Python preferred.' },
  });
  const mismatchedSelectedTrack = rawPortalJob(1976, {
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
    company: 'Selected Track Has No Requirement',
    description: 'Full-time Pune AI role. This opening is for the junior track. Entry-level track: 5 years experience. Senior track: 8 years experience.',
    experience: null,
  });
  const linkedInJunior = rawPortalJob(1974, {
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
    company: 'LinkedIn Description Track Junior',
    description: 'Full-time Pune AI role. This opening is for the junior track. Junior track requires 0-1 years experience. Senior track requires 6+ years experience.',
    experience: { minYears: 6, maxYears: null, sourceMinYears: null, sourceMaxYears: null, evidence: '6+ years experience' },
  });
  const updatedCandidate = normalizeCandidate(rawPortalJob(1967, {
    company: 'Updated Senior Requirement',
    title: 'Junior AI Engineer',
    description: 'Full-time Pune AI role. Minimum 1 year of software experience required.',
    experience: { minYears: 1, maxYears: 1, evidence: '1 year source minimum' },
  }));
  updatedCandidate.description = 'Full-time Pune AI role. Minimum 6 years of software experience required.';
  const titleMinimum = rawPortalJob(1968, {
    company: 'Title Experience Minimum',
    title: 'Python Developer - 5 years experience',
    description: 'Full-time Pune role.',
    experience: undefined,
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
  });
  const seniorTitleMinimum = rawPortalJob(1969, {
    company: 'Senior Title Experience Minimum',
    title: 'Python Developer - 6 years experience',
    description: 'Full-time Pune role.',
    experience: undefined,
    matchScore: null, responseLikelihood: null, scoreOrigin: null,
  });
  const scored = [];
  const scorer = async (rows) => {
    scored.push(...rows.map((row) => row.company));
    return { scored: rows.map((row) => ({ ...row, matchScore: 80, responseLikelihood: 15, descriptionAvailable: true, rationale: 'Python overlap', strongestHook: 'Python skills', componentScores: { skillMatch: 30, domainRelevance: 15, seniorityFit: 10, locationFit: 10, responseLikelihood: 15 } })) };
  };
  const sourceFixtures = { ...emptyLegacyFixtures(), 'portal-naukri': { candidates: [hidden, ambiguous, foreignAmbiguous, selectedJunior, preferred, twoYears, universalSenior, conditionalTrack, universalAfterTrackRequirements, conditionalAssignment, structuredMinimumAndConflict, recoveredSourceMinimum, mismatchedSelectedTrack, linkedInJunior, updatedCandidate, titleMinimum, seniorTitleMinimum], manifest: { status: 'ok' } } };
  const experienceResult = await runDailyNormal(runOptions(experienceConfig, fakeTransport({}), { sourceFixtures, scorer }));
  const report = renderLocalLeadReport(experienceResult, { now: NOW });
  const htmlReport = renderLocalDailyHtmlReport(experienceResult);
  assert.equal(experienceResult.outcome.fatal, false);
  assert.equal(scored.includes(hidden.company), false);
  assert.equal(scored.includes(universalSenior.company), false);
  assert.equal(scored.includes(universalAfterTrackRequirements.company), false);
  assert.equal(scored.includes(conditionalTrack.company), false);
  assert.equal(scored.includes(conditionalAssignment.company), false);
  assert.equal(scored.includes(structuredMinimumAndConflict.company), false);
  assert.equal(scored.includes(recoveredSourceMinimum.company), false);
  assert.equal(scored.includes(mismatchedSelectedTrack.company), false);
  assert.equal(scored.includes(updatedCandidate.company), false);
  assert.equal(scored.includes(titleMinimum.company), false);
  assert.equal(scored.includes(seniorTitleMinimum.company), false);
  assert.equal(scored.includes(ambiguous.company), false);
  assert.ok(scored.includes(selectedJunior.company));
  assert.ok(scored.includes(linkedInJunior.company));
  assert.equal(experienceResult.results.find((item) => item.company === linkedInJunior.company)?.eligibility.experience.code, 'EXPERIENCE_STRICT_0_1');
  assert.equal(experienceResult.results.find((item) => item.company === selectedJunior.company)?.eligibility.experience.selectedTrack, 'junior');
  assert.equal(experienceResult.results.find((item) => item.company === selectedJunior.company)?.eligibility.experience.minYears, 0);
  assert.doesNotMatch(experienceResult.results.find((item) => item.company === selectedJunior.company)?.eligibility.experience.evidence || '', /Source:/);
  assert.ok(scored.includes(preferred.company));
  assert.ok(scored.includes(twoYears.company));
  assert.ok(experienceResult.verificationQueue.some((item) => item.company === ambiguous.company));
  const ambiguousIdentity = `sha256:${createHash('sha256').update(candidateDedupKey(ambiguous)).digest('hex')}`;
  assert.equal(experienceResult.dailyReceipt.retained.identityRows.find((row) => row.identityHash === ambiguousIdentity)?.stage, 'verification');
  const foreignAmbiguousIdentity = `sha256:${createHash('sha256').update(candidateDedupKey(foreignAmbiguous)).digest('hex')}`;
  const foreignAmbiguousReceipt = experienceResult.dailyReceipt.retained.identityRows.find((row) => row.identityHash === foreignAmbiguousIdentity);
  assert.equal(foreignAmbiguousReceipt?.stage, 'hardRejection');
  assert.equal(foreignAmbiguousReceipt?.reason, 'GEO_ONSITE_NOT_PUNE');
  assert.ok(foreignAmbiguousReceipt?.alsoFailed.some((item) => item.code === 'EXPERIENCE_NOT_VERIFIED_CONFLICT'));
  assert.ok(experienceResult.verificationQueue.some((item) => item.company === conditionalTrack.company));
  assert.ok(experienceResult.verificationQueue.some((item) => item.company === conditionalAssignment.company));
  assert.ok(experienceResult.verificationQueue.some((item) => item.company === mismatchedSelectedTrack.company));
  const recoveredSourceDecision = experienceResult.experienceDecisions.find(({ candidate }) => candidate.company === recoveredSourceMinimum.company)?.eligibility.experience;
  assert.equal(recoveredSourceDecision.code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  const recoveredSourceIdentity = `sha256:${createHash('sha256').update(candidateDedupKey(recoveredSourceMinimum)).digest('hex')}`;
  assert.equal(experienceResult.dailyReceipt.retained.identityRows.find((row) => row.identityHash === recoveredSourceIdentity)?.stage, 'hardRejection');
  assert.equal(recoveredSourceDecision.minYears, 5);
  assert.match(recoveredSourceDecision.evidence, /Minimum 5 years/);
  const mismatchedTrackDecision = experienceResult.experienceDecisions.find(({ candidate }) => candidate.company === mismatchedSelectedTrack.company)?.eligibility.experience;
  assert.equal(mismatchedTrackDecision.code, 'EXPERIENCE_NOT_VERIFIED_CONFLICT');
  assert.equal(mismatchedTrackDecision.selectedTrack, 'junior');
  assert.deepEqual([...new Set(mismatchedTrackDecision.requirements.map((item) => item.track).filter(Boolean))], ['entry-level', 'senior']);
  assert.equal(experienceResult.experienceDecisions.find(({ candidate }) => candidate.company === structuredMinimumAndConflict.company)?.eligibility.experience.code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.equal(experienceResult.experienceDecisions.find(({ candidate }) => candidate.company === structuredMinimumAndConflict.company)?.eligibility.experience.minYears, 5);
  assert.equal(experienceResult.experienceDecisions.find(({ candidate }) => candidate.company === universalSenior.company)?.eligibility.experience.code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.equal(experienceResult.experienceDecisions.find(({ candidate }) => candidate.company === universalAfterTrackRequirements.company)?.eligibility.experience.code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.equal(experienceResult.experienceDecisions.find(({ candidate }) => candidate.company === conditionalTrack.company)?.eligibility.experience.code, 'EXPERIENCE_NOT_VERIFIED_CONFLICT');
  assert.equal(experienceResult.experienceDecisions.find(({ candidate }) => candidate.company === conditionalAssignment.company)?.eligibility.experience.code, 'EXPERIENCE_NOT_VERIFIED_CONFLICT');
  assert.equal(experienceResult.shortlist.some((item) => [hidden.company, ambiguous.company, universalSenior.company, universalAfterTrackRequirements.company, conditionalTrack.company, conditionalAssignment.company, structuredMinimumAndConflict.company, recoveredSourceMinimum.company, mismatchedSelectedTrack.company, updatedCandidate.company, titleMinimum.company, seniorTitleMinimum.company].includes(item.company)), false);
  const titleDecision = experienceResult.experienceDecisions.find(({ candidate }) => candidate.company === titleMinimum.company)?.eligibility.experience;
  assert.equal(titleDecision.code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.equal(titleDecision.requirements.some((item) => item.source === 'title' && item.minYears === 5), true);
  const seniorTitleDecision = experienceResult.experienceDecisions.find(({ candidate }) => candidate.company === seniorTitleMinimum.company)?.eligibility.experience;
  assert.equal(seniorTitleDecision.code, 'EXPERIENCE_HARD_MIN_3_PLUS');
  assert.equal(seniorTitleDecision.requirements.some((item) => item.source === 'title' && item.minYears === 6), true);
  assert.match(report, /7-10\+ years building production backend systems/);
  assert.match(report, /5\+ years hands-on with AWS/);
  assert.match(report, /EXPERIENCE_HARD_MIN_3_PLUS/);
  assert.match(report, /Minimum 6 years of software experience required/);
  assert.match(report, /all candidates must have 5 years of AWS experience/i);
  assert.match(report, /depending on level/);
  assert.match(report, /EXPERIENCE_NOT_VERIFIED_CONFLICT/);
  assert.match(htmlReport, /EXPERIENCE_HARD_MIN_3_PLUS/);
  assert.match(htmlReport, /selected track: junior/);
  assert.match(htmlReport, /EXPERIENCE_NOT_VERIFIED_CONFLICT/);
  assert.match(htmlReport, /5\+ years hands-on with AWS/);
  const receiptDir = path.join(process.cwd(), '.local/p01-experience');
  mkdirSync(receiptDir, { recursive: true });
  writeFileSync(path.join(receiptDir, 'daily-report.html'), htmlReport);
  writeFileSync(path.join(receiptDir, 'results.json'), JSON.stringify({
    status: experienceResult.outcome.status,
    scored,
    hardRejections: experienceResult.experienceDecisions.filter(({ eligibility }) => eligibility.experience.code === 'EXPERIENCE_HARD_MIN_3_PLUS').map(({ candidate, eligibility }) => ({ company: candidate.company, title: candidate.title, code: eligibility.experience.code, evidence: eligibility.experience.evidence, requirements: eligibility.experience.requirements })),
    verificationQueue: experienceResult.verificationQueue.filter((item) => [ambiguous.company, conditionalTrack.company, conditionalAssignment.company, mismatchedSelectedTrack.company].includes(item.company)).map(({ company, reasons, evidence }) => ({ company, reasons, experienceDecision: evidence.experienceDecision })),
    selectedJunior: experienceResult.results.find((item) => item.company === selectedJunior.company)?.eligibility.experience,
    preferredFive: experienceResult.results.find((item) => item.company === preferred.company)?.eligibility.experience,
    twoYears: experienceResult.results.find((item) => item.company === twoYears.company)?.eligibility.experience,
  }, null, 2));
});

test('daily records the exact final shortlist before persisting a valid canary', async () => {
  const { config } = testConfig();
  const records = [];
  const events = [];
  const candidates = [rawPortalJob(1401), rawPortalJob(1402)];
  const runId = 'daily-ledger-before-canary';
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    runId,
    canaryEvidence: canaryEvidence(config, runId, candidates),
    canaryValidationOptions: { reportRoot: path.dirname(config.databasePath) },
    ...fakeWriteOptions(),
    canaryStore: {
      readRuns: () => records,
      append: (record) => { events.push('canary'); records.push(record); },
    },
    opportunityLedgerWriter: (shortlist, options) => {
      events.push('ledger');
      return recordSurfaced(shortlist, options);
    },
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-naukri': { candidates, manifest: { status: 'ok' } },
    },
  }));
  events.push('returned');

  assert.deepEqual(result.deliveryCanary.counts, {
    eligible: result.counts.eligible,
    scoredPool: result.counts.scored,
    ready: result.counts.ready,
    shortlist: result.counts.selected,
  });
  assert.deepEqual(events, ['ledger', 'canary', 'returned']);
  assert.equal(records.length, 1);
  assert.equal(records[0].runId, result.runId);
  assert.deepEqual(records[0].discoveryProfile, { schedule: 'morning', mode: 'normal', locationPreset: 'india' });
  assert.equal(records[0].valid, true, JSON.stringify(records[0].invalidReasons));
  assert.equal(result.deliveryCanary.persisted, true);
  assert.deepEqual(result.surfaced.rows.map((row) => row.canonical_url).sort(), result.shortlist.map((candidate) => candidate.canonicalUrl).sort());
});

test('partial transaction records only committed keys and degrades failed rows for retry', async () => {
  const { config } = testConfig();
  const candidates = [rawPortalJob(1406), rawPortalJob(1407)];
  const committedKey = candidateDedupKey(candidates[0]);
  const failedKey = candidateDedupKey(candidates[1]);
  const gateway = {
    async executeWrites() {
      return {
        status: 'partial',
        newlyCommitted: [committedKey],
        alreadyCommitted: [],
        failed: [{ key: failedKey, error: { code: 'INJECTED_FAILURE', message: 'retry me' } }],
        recovery: [],
        deliveredKeys: [committedKey],
      };
    },
  };
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    runId: 'partial-transaction',
    canaryEvidence: canaryEvidence(config, 'partial-transaction', candidates),
    canaryValidationOptions: { reportRoot: path.dirname(config.databasePath) },
    ...fakeWriteOptions({ gateway }),
    sourceFixtures: { ...emptyLegacyFixtures(), 'portal-naukri': { candidates, manifest: { status: 'ok' } } },
  }));

  assert.equal(result.outcome.status, 'degraded');
  assert.equal(result.transaction.status, 'partial');
  assert.deepEqual(result.surfaced.rows.map((row) => row.dedup_key), [committedKey]);
  assert.equal(readOpportunityLedger(config.opportunityLedgerPath).rows.some((row) => row.dedup_key === failedKey), false);
  assert.deepEqual(result.deliveryReconciliation.counts, {
    selected: 2,
    shortlist: 2,
    plannedV5Operations: 2,
    newlyCommitted: 1,
    alreadyCommitted: 0,
    failed: 1,
    recoveryBlocked: 0,
    deliveredKeys: 1,
    opportunityLedgerSurfaced: 1,
    opportunityLedgerRepaired: 0,
    canaryShortlist: 2,
    notification: null,
  });
  assert.ok(result.deliveryReconciliation.mismatchReasons.includes('TRANSACTION_PARTIAL'));
  assert.equal(result.deliveryCanary.valid, false);
});

test('replayed transaction repairs a missing ledger row at original commit time without new surfacing', async () => {
  const { config } = testConfig();
  const candidate = rawPortalJob(1408);
  const gateway = createFakeTransactionalGateway();
  await gateway.executeWrites({ operations: plannedOperations([candidate], 'seed-replay') });
  const committedAt = '2026-07-20T05:15:00.000Z';
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    runId: 'replay-repair',
    canaryEvidence: canaryEvidence(config, 'replay-repair', [candidate]),
    canaryValidationOptions: { reportRoot: path.dirname(config.databasePath) },
    transactionCommitTimeForKey: () => committedAt,
    ...fakeWriteOptions({ gateway }),
    sourceFixtures: { ...emptyLegacyFixtures(), 'portal-naukri': { candidates: [candidate], manifest: { status: 'ok' } } },
  }));

  assert.equal(result.transaction.status, 'replayed');
  assert.deepEqual(result.surfaced.rows, []);
  assert.equal(result.ledgerRepairs.rows.length, 1);
  assert.equal(result.ledgerRepairs.rows[0].first_surfaced_at, committedAt);
  assert.equal(result.ledgerRepairs.rows[0].last_surfaced_at, committedAt);
  assert.equal(result.deliveryReconciliation.counts.opportunityLedgerSurfaced, 0);
  assert.equal(result.deliveryReconciliation.counts.opportunityLedgerRepaired, 1);
});

test('malformed, preflight-unwritable, or conflicting canary stores degrade after committed rows reach the opportunity ledger', async () => {
  const cases = [
    ['malformed', { readRuns: () => { throw new SyntaxError('malformed canary store'); } }, null, /malformed canary store/],
    ['preflight-unwritable', { readRuns: () => [], preflight: () => { const error = new Error('canary store is unwritable'); error.code = 'EACCES'; throw error; } }, 'EACCES', /canary store is unwritable/],
    ['conflict', { readRuns: () => [{ runId: 'conflict', runAt: NOW, counts: { shortlist: 999 } }] }, 'CANARY_RUN_ID_CONFLICT', /different content/],
  ];
  for (const [runId, canaryStore, code, message] of cases) {
    const { config } = testConfig();
    const candidates = [rawPortalJob(`1403-${runId}`)];
    const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
      canaryStore,
      runId,
      canaryEvidence: canaryEvidence(config, runId, candidates),
      ...fakeWriteOptions(),
      sourceFixtures: { 'portal-naukri': { candidates, manifest: { status: 'ok' } } },
    }));
    assert.equal(result.outcome.status, 'degraded');
    assert.equal(result.canaryPersistenceError.stage, 'delivery-canary-preflight');
    assert.equal(result.canaryPersistenceError.code, code);
    assert.match(result.canaryPersistenceError.message, message);
    assert.equal(result.deliveryCanary, null);
    assert.equal(readOpportunityLedger(config.opportunityLedgerPath).rows.length, 1);
  }
});

test('ledger failure degrades delivery and leaves the canary store unchanged', async () => {
  const { config } = testConfig();
  const records = [];
  const runId = 'ledger-failure';
  const candidates = [rawPortalJob(1404)];
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    runId,
    canaryEvidence: canaryEvidence(config, runId, candidates),
    canaryValidationOptions: { reportRoot: path.dirname(config.databasePath) },
    ...fakeWriteOptions(),
    canaryStore: { readRuns: () => records, append: (record) => records.push(record) },
    opportunityLedgerWriter: () => { throw new Error('ledger write failed'); },
    sourceFixtures: { 'portal-naukri': { candidates, manifest: { status: 'ok' } } },
  }));
  assert.equal(result.outcome.status, 'degraded');
  assert.match(result.outcome.errors.at(-1).message, /ledger write failed/);
  assert.equal(result.deliveryCanary.valid, false);
  assert.equal(result.deliveryCanary.persisted, true);
  assert.equal(records.length, 1);
  assert.equal(records[0].valid, false);
});

test('canary append failure after ledger returns degraded delivery with shortlist and no valid record claim', async () => {
  const { config } = testConfig();
  const runId = 'canary-append-failure';
  const candidates = [rawPortalJob(1405)];
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    runId,
    canaryEvidence: canaryEvidence(config, runId, candidates),
    canaryValidationOptions: { reportRoot: path.dirname(config.databasePath) },
    ...fakeWriteOptions(),
    canaryStore: {
      readRuns: () => [],
      append: () => { const error = new Error('canary store is unwritable'); error.code = 'EACCES'; throw error; },
    },
    sourceFixtures: { ...emptyLegacyFixtures(), 'portal-naukri': { candidates, manifest: { status: 'ok' } } },
  }));

  assert.equal(result.outcome.status, 'degraded');
  assert.equal(result.outcome.fatal, false);
  assert.deepEqual(result.shortlist.map((candidate) => candidate.canonicalUrl), candidates.map((candidate) => candidate.url));
  assert.equal(result.deliveryCanary.valid, false);
  assert.equal(result.deliveryCanary.preparedValid, true);
  assert.equal(result.deliveryCanary.persisted, false);
  assert.equal(result.canaryPersistenceError.code, 'EACCES');
  assert.deepEqual(readOpportunityLedger(config.opportunityLedgerPath).rows.map((row) => row.canonical_url), candidates.map((candidate) => candidate.url));
});

test('scores supplied to the unified daily run merge before the scoring gate', async () => {
  const { config } = testConfig();
  const role = rawPortalJob(1501, { matchScore: undefined });
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-naukri': { candidates: [role], manifest: { status: 'ok' } },
    },
    scores: { scores: [{ canonicalUrl: role.url, matchScore: 80, responseLikelihood: 14 }] },
  }));

  assert.equal(result.outcome.status, 'ok');
  assert.equal(result.scoringQueue.length, 0);
  assert.equal(result.shortlist[0].canonicalUrl, role.url);
  assert.equal(result.shortlist[0].matchScore, 80);
});

test('a score for a canonical URL outside the unified pool is a no-op', async () => {
  const { config } = testConfig();
  const role = rawPortalJob(1502);
  const withoutScores = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-naukri': { candidates: [role], manifest: { status: 'ok' } },
    },
  }));
  const withUnmatchedScore = await runDailyNormal(runOptions(config, fakeTransport({}), {
    sourceFixtures: {
      ...emptyLegacyFixtures(),
      'portal-naukri': { candidates: [role], manifest: { status: 'ok' } },
    },
    scores: { scores: [{ canonicalUrl: 'https://not-in-the-pool.example.test/jobs/1', matchScore: 1 }] },
  }));

  assert.equal(withUnmatchedScore.outcome.status, 'ok');
  assert.deepEqual(withUnmatchedScore.shortlist, withoutScores.shortlist);
  assert.deepEqual(withUnmatchedScore.scoringQueue, withoutScores.scoringQueue);
});

test('omitting scores preserves the unified scoring gate without constructing the live gateway', async () => {
  const { config } = testConfig();
  let factoryCalls = 0;
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    executeWrites: true,
    notionGatewayFactory: () => { factoryCalls += 1; return createFakeTransactionalGateway(); },
    sourceFixtures: {
      'portal-naukri': { candidates: [rawPortalJob(1503, { matchScore: undefined })], manifest: { status: 'ok' } },
    },
  }));

  assert.equal(result.outcome.status, 'fatal');
  assert.equal(result.scoringQueue[0].scoringStatus, 'unscored');
  assert.match(result.outcome.errors[0].message, /unscored=1/);
  assert.equal(factoryCalls, 0);
});

test('completed no-write run stops before live gateway construction and ledger mutation', async () => {
  const { config } = testConfig();
  let factoryCalls = 0;
  const candidate = rawPortalJob(1504);
  const result = await runDailyNormal(runOptions(config, fakeTransport({}), {
    notionGatewayFactory: () => { factoryCalls += 1; return createFakeTransactionalGateway(); },
    sourceFixtures: {
      'portal-naukri': { candidates: [candidate], manifest: { status: 'ok' } },
    },
  }));

  assert.notEqual(result.outcome.status, 'fatal');
  assert.equal(result.deliveryReconciliation.status, 'no-write');
  assert.equal(result.deliveryReconciliation.ok, true);
  assert.deepEqual(result.deliveryReconciliation.mismatchReasons, []);
  assert.equal(result.transaction, null);
  assert.equal(result.deliveryCanary, null);
  assert.deepEqual(result.surfaced.rows, []);
  assert.equal(factoryCalls, 0);
  assert.deepEqual(readOpportunityLedger(config.opportunityLedgerPath).rows, []);
});

test('focused mode fixtures require independent stage evidence for shared Startup fallback without weakening native lanes', () => {
  const shared = { canonicalUrl: 'https://jobs.example.test/shared', company: 'Shared Co', title: 'AI Engineer', location: 'Pune, India', provider: 'greenhouse', sourceId: 'ats-warm', classification: 'direct' };
  const enterprise = { ...shared, canonicalUrl: 'https://jobs.example.test/enterprise', company: 'Enterprise Co', companyStage: 'Enterprise', companyStageEvidence: 'https://companies.example.test/enterprise' };
  const taggedStartup = { ...shared, canonicalUrl: 'https://jobs.example.test/tagged-startup', company: 'Tagged Startup', companyStage: 'Startup', companyStageEvidence: 'warm ATS board tagged startup: Tagged Startup', evidence: { startupTagged: true } };
  const evidenceBackedStartup = { ...shared, canonicalUrl: 'https://jobs.example.test/evidence-startup', company: 'Evidence Startup', companyStage: 'Startup', startupStageEvidenceRef: 'https://portfolio.example.test/evidence-startup', evidence: { startupTagged: true, startupStageEvidenceRef: 'https://portfolio.example.test/evidence-startup' } };
  const companyRecordStartup = { ...shared, canonicalUrl: 'https://jobs.example.test/company-record-startup', company: 'Company Record Startup', companyRecord: { stage: 'Scale-up', stageEvidence: 'https://companies.example.test/company-record-startup' } };
  const nativeStartup = { ...shared, startupLaneId: 'yc', sourceId: 'startup-mode', startupEvidence: 'yc board' };
  const nativeRemote = { ...shared, remoteLaneId: 'himalayas', sourceId: 'remote-mode', remoteEvidence: { country: 'India' } };
  const result = {
    observations: [shared, enterprise, taggedStartup, evidenceBackedStartup, companyRecordStartup, nativeStartup, nativeRemote],
    failures: [{ sourceId: 'ats-warm', provider: 'greenhouse', code: 'REQUEST_TIMEOUT' }],
    sourceTelemetry: { 'ats-warm': { attempts: 1, error: 'warm timeout' } },
  };

  const startup = buildFocusedModeFixtures(result, 'startup');
  assert.equal(startup.yc.candidates.length, 1);
  assert.deepEqual(startup['startup-employer-boards'].candidates.map((candidate) => candidate.company).sort(), ['Company Record Startup', 'Evidence Startup'].sort());
  assert.equal(startup['startup-employer-boards'].manifest.status, 'degraded');

  const remote = buildFocusedModeFixtures(result, 'remote');
  assert.equal(remote.himalayas.candidates.length, 1);
  assert.deepEqual(remote['remote-ats'].candidates.map((candidate) => candidate.company).sort(), ['Company Record Startup', 'Enterprise Co', 'Evidence Startup', 'Tagged Startup'].sort());
  assert.equal(remote['remote-ats'].manifest.status, 'degraded');
  assert.equal(remote.himalayas.candidates[0].remoteEvidence.country, 'India');
});

test('daily mode dispatch selects Startup and Remote with mode-specific run identity and no second source function fetch', async () => {
  const { root, config } = testConfig();
  config.opportunityLedgerPath = path.join(root, 'opportunity-ledger.tsv');
  const startupCandidate = rawPortalJob(1601, { company: 'Startup Dispatch Co' });
  const startupRunId = `daily-morning-startup-${NOW}`;
  const startup = await runDailyNormal(runOptions(config, fakeTransport({}), {
    mode: 'startup',
    runId: null,
    canaryEvidence: canaryEvidence(config, startupRunId, [startupCandidate]),
    canaryValidationOptions: { reportRoot: path.dirname(config.databasePath) },
    ...fakeWriteOptions(),
    sourceFunctions: { 'startup-employer-boards': () => { throw new Error('focused startup must use shared fixture'); } },
    sourceFixtures: Object.fromEntries([
      'startup-employer-boards', 'vc-portfolio-boards', 'yc', 'wellfound',
      'india-startup-directories', 'startup-watchlist', 'funding-hiring-signals',
    ].map((laneId) => [laneId, laneId === 'startup-employer-boards'
      ? { candidates: [startupCandidate], manifest: { status: 'ok' } }
      : { candidates: [], manifest: { status: 'empty' } }])),
  }));
  assert.equal(startup.mode, 'startup');
  assert.equal(startup.phaseTargetRollup.days[0].date, '2026-07-24');
  assert.equal(startup.phaseTargetRollup.days[0].modes.startup.roles, startup.modes.startup.shortlist.length);
  assert.match(startup.runId, /morning-startup/);
  assert.equal(startup.shortlist[0].company, 'Startup Dispatch Co');
  assert.deepEqual(startup.deliveryCanary.discoveryProfile, { schedule: 'morning', mode: 'startup', locationPreset: 'india' });
  assert.equal(startup.deliveryCanary.valid, false);
  assert.ok(startup.deliveryCanary.invalidReasons.some((reason) => /run outcome is degraded/.test(reason)));

  const remoteCandidate = rawPortalJob(1602, {
    company: 'Remote Dispatch Co',
    location: 'Remote - India',
    description: 'Worldwide remote including India. Full-time AI Engineer role for 0-1 years.',
  });
  const remoteRunId = `daily-morning-remote-${NOW}`;
  const remote = await runDailyNormal(runOptions(config, fakeTransport({}), {
    mode: 'remote',
    runId: null,
    canaryEvidence: canaryEvidence(config, remoteRunId, [remoteCandidate]),
    canaryValidationOptions: { reportRoot: path.dirname(config.databasePath) },
    ...fakeWriteOptions(),
    sourceFunctions: { 'remote-ats': () => { throw new Error('focused remote must use shared fixture'); } },
    sourceFixtures: Object.fromEntries([
      'remote-ats', 'yc', 'wellfound', 'bounded-remote-search',
      'himalayas', 'jobicy', 'weworkremotely', 'remotive', 'remoteok',
    ].map((laneId) => [laneId, laneId === 'remote-ats'
      ? { candidates: [remoteCandidate], manifest: { status: 'ok' } }
      : { candidates: [], manifest: { status: 'empty' } }])),
  }));
  assert.equal(remote.mode, 'remote');
  assert.match(remote.runId, /morning-remote/);
  assert.equal(remote.shortlist[0].company, 'Remote Dispatch Co');
  assert.deepEqual(remote.deliveryCanary.discoveryProfile, { schedule: 'morning', mode: 'remote', locationPreset: 'india' });
  assert.equal(remote.deliveryCanary.valid, false);
  assert.ok(remote.deliveryCanary.invalidReasons.some((reason) => /run outcome is degraded/.test(reason)));
  assert.deepEqual(Object.keys(remote.deliveryCanary).sort(), Object.keys(startup.deliveryCanary).sort());
});

test('unknown daily mode is rejected before any discovery transport call', async () => {
  const { config } = testConfig({ trackedBoards: ['must-not-fetch'] });
  let calls = 0;
  await assert.rejects(
    runDailyNormal(runOptions(config, async () => { calls += 1; throw new Error('discovery should not run'); }, { mode: 'sideways' })),
    /unknown daily mode: sideways/,
  );
  assert.equal(calls, 0);
});

// Route fixture totals through the explicit scoring input after the shared crawl.
function runDailyNormal(options) { return runDailyNormalActual(withManualFixtureScores(options)); }

test('daily run retains hiring challenges and off-campus drives as dated items outside role selection', async () => {
  const { root, config } = testConfig();
  config.hiringEventsPath = path.join(root, 'hiring-events.json');
  const items = [
    { kind: 'hiring-challenge', title: 'Acme Backend Hiring Challenge', company: 'Acme', url: 'https://acme.example.test/challenge', date: '2026-08-01', deadline: '2026-07-31T18:30:00Z' },
    { kind: 'off-campus-drive', title: 'Graduate Engineering Drive', company: 'Example Labs', url: 'https://labs.example.test/drive', date: '2026-08-02', deadline: '2026-07-30' },
  ];
  writeFileSync(config.hiringEventsPath, JSON.stringify({ items }));
  const result = await runDailyNormal(runOptions(config, fakeTransport({})));
  assert.deepEqual(result.hiringEvents, { items, quarantine: [] });
  assert.deepEqual(result.shortlist, []);
  assert.equal(result.funnel.lifecycle.normalized, 0);
  assert.deepEqual(JSON.parse(readFileSync(config.hiringEventsPath, 'utf8')), { items });
});

test('daily run holds undated or malformed hiring events instead of inventing dates', async () => {
  const { root, config } = testConfig();
  config.hiringEventsPath = path.join(root, 'hiring-events.json');
  const event = { kind: 'hiring-challenge', title: 'Backend Hiring Challenge', company: 'Acme', url: 'https://acme.example.test/challenge', date: '2026-08-01', deadline: null };
  const invalid = [
    { ...event, date: null },
    { ...event, date: '2026-02-30' },
    { ...event, deadline: '2026-07-31T23:59:00' },
    { ...event, deadline: '2026-02-30T23:59:00+05:30' },
    { ...event, url: 'javascript:alert(1)' },
    { ...event, kind: 'job' },
  ];
  writeFileSync(config.hiringEventsPath, JSON.stringify({ items: [...invalid, event] }));
  const result = await runDailyNormal(runOptions(config, fakeTransport({})));
  assert.deepEqual(result.hiringEvents.items, [event]);
  assert.deepEqual(result.hiringEvents.quarantine.map(({ index }) => index), [0, 1, 2, 3, 4, 5]);
  assert.ok(result.hiringEvents.quarantine.every(({ errors }) => errors.length > 0));
});

test('local report shows each hiring event date and deadline in IST without inventing missing deadline times', async () => {
  const { root, config } = testConfig();
  config.hiringEventsPath = path.join(root, 'hiring-events.json');
  writeFileSync(config.hiringEventsPath, JSON.stringify({ items: [
    { kind: 'hiring-challenge', title: 'Backend | Hiring Challenge', company: 'Acme', url: 'https://acme.example.test/challenge', date: '2026-08-02T00:30:00+05:30', deadline: '2026-07-31T18:30:00Z' },
    { kind: 'off-campus-drive', title: 'Graduate Drive', company: 'Example Labs', url: 'https://labs.example.test/drive', date: '2026-08-02', deadline: '2026-07-30' },
    { kind: 'hiring-challenge', title: 'Undisclosed Deadline', company: null, url: 'https://acme.example.test/next', date: '2026-08-03', deadline: null },
    { kind: 'off-campus-drive', title: 'Undated Drive', url: 'https://labs.example.test/next', date: null, deadline: null },
  ] }));
  const result = await runDailyNormal(runOptions(config, fakeTransport({})));
  const report = renderLocalLeadReport(result, { now: NOW });
  assert.match(report, /## Hiring challenges and off-campus drives/);
  assert.ok(report.includes('| Hiring challenge | Backend \\| Hiring Challenge | Acme | https://acme.example.test/challenge | 2026-08-02 00:30:00 IST | 2026-08-01 00:00:00 IST |'));
  assert.ok(report.includes('| Off-campus drive | Graduate Drive | Example Labs | https://labs.example.test/drive | 2026-08-02 | 2026-07-30 |'));
  assert.ok(report.includes('| Hiring challenge | Undisclosed Deadline | Not Verified | https://acme.example.test/next | 2026-08-03 | Not Verified |'));
  assert.match(report, /Date-only values have no verified time/);
  assert.match(report, /Held item 4: date must be a valid/);
  assert.doesNotMatch(report, /Undated Drive/);
});

test('local report shows per-mode target counts, cross-mode Strict count, verification, and shortfalls', () => {
  const role = (id, company, selectionTier = 'Strict') => ({ id, company, title: `${id} Engineer`, selectionTier });
  const normalRole = role('normal-1', 'Pune Labs');
  const startupRole = role('startup-1', 'Startup Labs', 'Fallback');
  const remoteRole = role('remote-1', 'Remote Labs');
  const result = {
    run: { startedAt: '2026-10-07T20:00:00.000Z' },
    modes: {
      normal: { results: [normalRole], shortlist: [normalRole] },
      startup: { results: [startupRole], shortlist: [startupRole] },
      remote: { results: [remoteRole], shortlist: [remoteRole, role('unverified-1', 'Unknown Labs', 'Fallback')] },
    },
  };

  result.dailyShortlistBudget = { date: '2026-10-08', selectedToday: 3, strictSelected: 2, remaining: 17, cumulativeCandidates: [
    { key: 'normal-1', company: 'Pune Labs', tier: 'Strict', primaryMode: 'normal' },
    { key: 'startup-1', company: 'Startup Labs', tier: 'Fallback', primaryMode: 'startup' },
    { key: 'remote-1', company: 'Remote Labs', tier: 'Strict', primaryMode: 'remote' },
  ] };
  const report = renderLocalLeadReport(result, { now: '2026-10-07T20:00:00.000Z' });

  assert.match(report, /## Per-mode daily targets \(IST 2026-10-08\)/);
  assert.match(report, /\| Pune \(normal\) \| 1\/10 \| 1\/6 \| 1 \| 9 roles, 5 employers \|/);
  assert.match(report, /\| Startup \| 1\/5 \| 1\/4 \| 0 \| 4 roles, 3 employers \|/);
  assert.match(report, /\| Remote \| 1\/5 \| 1\/4 \| 1 \| 4 roles, 3 employers \|/);
  assert.match(report, /Cumulative Strict across modes today: 2, phase target 2/);
  assert.match(report, /Cumulative all-mode roles today: 3\/20/);
  assert.match(report, /9 roles, 5 employers/);
  assert.match(report, /4 roles, 3 employers/);
});

test('daily phase targets accumulate unique same-day jobs and require two Strict across modes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'phase-target-rollup-'));
  const statePath = path.join(root, 'rollup.json');
  const role = (index, tier = 'Fallback') => ({ canonicalUrl: `https://jobs.example.test/${index}`, company: `Employer ${index}`, selectionTier: tier, applicationReady: true });
  const modes = (roles) => ({ normal: { shortlist: roles }, startup: { shortlist: [] }, remote: { shortlist: [] } });
  const history = { verified: true, status: 'loaded', scope: 'fixture' };
  retainDailyPhaseTargetRun(statePath, '2026-10-07T18:29:00Z', 'morning', modes(Array.from({ length: 6 }, (_, i) => role(i, i === 0 ? 'Strict' : 'Fallback'))), history);
  const cumulative = retainDailyPhaseTargetRun(statePath, '2026-10-07T18:29:30Z', 'midday', modes(Array.from({ length: 5 }, (_, i) => role(i + 5, i === 1 ? 'Strict' : 'Fallback'))), history);
  assert.equal(cumulative.days[0].date, '2026-10-07');
  assert.equal(cumulative.days[0].modes.normal.roles, 10);
  assert.equal(cumulative.days[0].modes.normal.employers, 10);
  assert.equal(cumulative.days[0].strict, 2);
  assert.equal(cumulative.days[0].modes.normal.met, true);
  const retry = retainDailyPhaseTargetRun(statePath, '2026-10-07T18:29:40Z', 'midday', modes([]), history);
  assert.equal(retry.days[0].modes.normal.roles, 10);
  const next = retainDailyPhaseTargetRun(statePath, '2026-10-07T18:30:00Z', 'next-day', modes([role(10)]), history);
  assert.equal(next.days[0].date, '2026-10-08');
  assert.equal(next.days[0].modes.normal.roles, 1);
  assert.equal(next.days[2].status, 'no run');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).schemaVersion, 'DailyPhaseTargetRollupV2');

  const phasePath = path.join(root, 'five-days.json');
  for (let day = 1; day <= 5; day += 1) {
    retainDailyPhaseTargetRun(phasePath, `2026-10-${String(day).padStart(2, '0')}T05:00:00Z`, `run-${day}`, modes(Array.from({ length: 10 }, (_, i) => role(i, i < 2 ? 'Strict' : 'Fallback'))), history);
  }
  const fiveOfSeven = retainDailyPhaseTargetRun(phasePath, '2026-10-07T05:00:00Z', 'empty', modes([]), history);
  assert.equal(fiveOfSeven.modes.normal.daysMet, 5);
  assert.equal(fiveOfSeven.modes.normal.phaseTargetMet, true);
  assert.equal(fiveOfSeven.phaseTargetMet, false);
});

test('daily HTML report writes locally with three mode lists, scorer evidence, labels, employer links, deduped mode tags, and funnel counts', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-html-report-'));
  const output = path.join(root, 'daily.html');
  const shared = {
    title: 'AI Engineer', company: 'Pune Startup', canonicalUrl: 'https://jobs.example.test/1',
    originalApplicationUrl: 'https://company.example.test/careers/1', primaryMode: 'startup', otherModes: ['normal', 'remote'],
    rationale: 'Python and LLM work match the role requirements.', labels: ['Night hours (IST)'],
    eligibility: { labels: ['Notice risk'] }, matchScore: 84, selectionTier: 'Strict',
  };
  const result = {
    runAt: NOW,
    modes: {
      normal: { results: [{ title: 'Fallback AI Engineer', company: 'Other', selectionTier: 'Fallback' }], shortlist: [] },
      startup: { results: [shared], shortlist: [shared] },
      remote: { results: [], shortlist: [] },
    },
    counts: { fetched: 9, eligible: 6, gatePassing: 5, ready: 4, scored: 3, selected: 1, strictSelected: 1 },
    funnel: { lifecycle: { fetched: 9, eligible: 6, ready: 4, scored: 3 } },
  };

  const written = writeLocalDailyHtmlReport(result, output);
  const html = readFileSync(output, 'utf8');
  assert.equal(written, output);
  assert.match(html, /<section[^>]*data-mode="normal"/);
  assert.match(html, /<section[^>]*data-mode="startup"/);
  assert.match(html, /<section[^>]*data-mode="remote"/);
  assert.match(html, /Full results/);
  assert.match(html, /Shortlist/);
  assert.match(html, /Python and LLM work match the role requirements\./);
  assert.match(html, /Selection tier: Fallback/);
  assert.match(html, /Night hours \(IST\)/);
  assert.match(html, /Notice risk/);
  assert.match(html, /https:\/\/company\.example\.test\/careers\/1/);
  assert.match(html, /Other modes: Pune, Remote/);
  assert.equal((html.match(/Pune Startup/g) ?? []).length, 2, 'the role is listed once in full results and once in its shortlist');
  for (const count of ['Fetched: 9', 'Eligible: 6', 'Passed gates: 5', 'Ready: 4', 'Scored: 3', 'Shortlisted: 1', 'Employers represented: 1', 'Strict: 1']) assert.ok(html.includes(count), count);
  assert.match(html, /Per-mode daily targets/);
  assert.match(html, /<th>Roles \/ target<\/th>/);
});

test('daily HTML report shows phase target status and explicit no-run days per mode', () => {
  const report = renderLocalDailyHtmlReport({
    runAt: '2026-10-08T06:00:00.000Z',
    phaseTargetRollup: {
      days: [{ date: '2026-10-08', status: 'run', modes: { normal: { roles: 10, employers: 6, strict: 2, met: true }, startup: { roles: 0, employers: 0, strict: 0, met: false }, remote: { roles: 0, employers: 0, strict: 0, met: false } } }, { date: '2026-10-07', status: 'no run', modes: {} }],
      modes: { normal: { daysMet: 1, phaseTargetMet: false }, startup: { daysMet: 0, phaseTargetMet: false }, remote: { daysMet: 0, phaseTargetMet: false } },
    },
    modes: { normal: { results: [], shortlist: [] }, startup: { results: [], shortlist: [] }, remote: { results: [], shortlist: [] } },
  });

  assert.match(report, /5 of 7 consecutive IST days/);
  assert.match(report, /Pune.*1\/7.*Phase target not met/);
  assert.match(report, /Startup.*0\/7.*Phase target not met/);
  assert.match(report, /2026-10-07.*no run/);
  assert.match(report, /Roles 10, employers 6, Strict 2/);
  assert.match(renderLocalDailyHtmlReport({
    phaseTargetRollup: { days: [], modes: { normal: { daysMet: 5, phaseTargetMet: true }, startup: { daysMet: 0, phaseTargetMet: false }, remote: { daysMet: 0, phaseTargetMet: false } } },
    modes: {},
  }), /Pune.*5\/7.*Phase target met/);
});

test('daily HTML report keeps Stretch and EOR roles separate and shows source yield and drift', () => {
  const report = renderLocalDailyHtmlReport({
    runAt: NOW,
    modes: {
      normal: { results: [], shortlist: [] },
      startup: { results: [], shortlist: [] },
      remote: { results: [], shortlist: [] },
      eorContract: { results: [{ title: 'EOR AI Engineer', company: 'Global Employer' }], shortlist: [{ title: 'EOR AI Engineer', company: 'Global Employer', labels: ['EOR'] }] },
    },
    stretch: [{ title: 'Stretch Backend Engineer', company: 'Startup' }],
    sourceYield: { sources: [{ sourceId: 'greenhouse:acme', provider: 'greenhouse', board: 'acme', applicationReady: 2 }] },
    sourceTelemetry: {
      'ats-warm': { requests: 4, detail: { telemetry: { requests: 4 }, sources: [{ provider: 'greenhouse', board: 'acme', requests: 4 }] } },
      'portal-linkedin-jobs': { status: 'failed', error: 'HTTP 429' },
      glassdoor: { status: 'failed', error: 'HTTP 403' },
      'ats-batch-1': { status: 'failed', failed: 1, detail: { failed: 1 } },
    },
    scorerVariance: [{ role: 'AI Engineer at Acme', previous: 72, current: 67 }],
  });

  assert.match(report, /<section[^>]*data-section="stretch"[^>]*><h2>Stretch/);
  assert.match(report, /Stretch Backend Engineer/);
  assert.match(report, /<section[^>]*data-mode="eorContract"[^>]*>[\s\S]*EOR AI Engineer/);
  assert.match(report, /Source yield per request/);
  assert.match(report, /greenhouse:acme/);
  assert.match(report, /2 application-ready roles \/ 4 requests/);
  assert.match(report, /Drift signals/);
  assert.match(report, /LinkedIn.*429/);
  assert.match(report, /Glassdoor.*403/);
  assert.match(report, /ats-batch-1.*board failure/i);
  assert.match(report, /72.*67/);
});

test('local report CLI writes HTML when given a local .html output path', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daily-html-cli-'));
  const input = path.join(root, 'run.json');
  const output = path.join(root, 'daily.html');
  writeFileSync(input, JSON.stringify({ runAt: NOW, modes: { normal: { results: [], shortlist: [] }, startup: { results: [], shortlist: [] }, remote: { results: [], shortlist: [] } } }));
  execFileSync(process.execPath, ['crawler/local-lead-report.mjs', input, output], { cwd: process.cwd() });
  assert.match(readFileSync(output, 'utf8'), /<!doctype html>/i);
});

test('held-lead recovery reads only recovery rows and their matching ordinary successes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'held-recovery-read-'));
  const store = openCrawlerStore(path.join(root, 'crawler.sqlite'));
  const clock = (now) => ({ now: () => now });
  const longDescription = 'Build Python services for a Pune team. '.repeat(300);
  const unrelated = Array.from({ length: 300 }, (_, index) => ({
    provider: 'greenhouse', providerJobId: `other-${index}`, jobId: `other-${index}`, company: `Other ${index}`, title: 'Engineer',
    location: 'Pune, India', discoveryUrl: `https://boards.greenhouse.io/other/jobs/${index}`,
    canonicalUrl: `https://boards.greenhouse.io/other/jobs/${index}`, description: longDescription,
  }));
  const held = (jobId, recovery) => ({
    provider: 'linkedin-jobs', providerJobId: jobId, jobId, company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India',
    discoveryUrl: `https://www.linkedin.com/jobs/view/${jobId}`, canonicalUrl: `https://www.linkedin.com/jobs/view/${jobId}`,
    evidence: { recovery: { kind: 'held-lead-recovery', providerRequisitionKey: `linkedin jobs|${jobId}`,
      identityUrl: `requisition:linkedin jobs|${jobId}`, attemptCount: 1, attemptedAt: '2026-10-20T08:00:00.000Z',
      evaluatedAt: '2026-10-20T08:00:00.000Z', ...recovery } },
  });
  await crawlRun({ store, runId: 'recovery-read-unrelated', clock: clock('2026-10-20T08:00:00.000Z'),
    sourcePlans: [{ id: 'ats-warm', fetch: async () => ({ observations: unrelated }) }] });
  await crawlRun({ store, runId: 'recovery-read-held', clock: clock('2026-10-20T08:00:00.000Z'),
    sourcePlans: [{ id: 'portal-discovery', fetch: async () => ({ observations: [
      held('1001', { outcome: 'pending', nextEligibleAt: '2026-10-20T09:00:00.000Z' }),
      held('1002', { outcome: 'pending', nextEligibleAt: '2026-10-21T09:00:00.000Z' }),
      held('1003', { outcome: 'pending', nextEligibleAt: '2026-10-20T09:00:00.000Z' }),
      held('1004', { outcome: 'policy-rejected', nextEligibleAt: null }),
    ] }) }] });
  await crawlRun({ store, runId: 'recovery-read-ordinary-success', clock: clock('2026-10-20T09:30:00.000Z'),
    sourcePlans: [{ id: 'ats-warm', fetch: async () => ({ observations: [{
      provider: 'greenhouse', providerJobId: 'gh-1003', jobId: '1003', identityAliases: ['linkedin jobs|1003'],
      company: 'Acme Labs', title: 'AI Engineer', location: 'Pune, India',
      discoveryUrl: 'https://www.linkedin.com/jobs/view/1003', canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/1003',
      originalApplicationUrl: 'https://boards.greenhouse.io/acme/jobs/1003', classification: 'direct',
      applicationResolution: { status: 'Resolved Original' }, evidence: { fieldSources: { company: 'original-employer-detail' } },
    }] }) }] });

  const prepared = [];
  const prepare = store.prepare.bind(store);
  store.prepare = (sql) => { prepared.push(sql); return prepare(sql); };
  const state = readHeldLeadRecoveryState(store, { now: '2026-10-20T10:00:00.000Z' });
  store.prepare = prepare;

  assert.deepEqual(state.eligible.map(({ jobId }) => jobId), ['1001']);
  assert.equal(state.waiting, 1);
  assert.deepEqual(state.identities.sort(), ['requisition:linkedin jobs|1001', 'requisition:linkedin jobs|1002',
    'requisition:linkedin jobs|1003', 'requisition:linkedin jobs|1004']);
  assert.deepEqual(state.terminalIdentities.sort(), ['requisition:linkedin jobs|1003', 'requisition:linkedin jobs|1004']);
  const unfilteredRowScans = prepared.filter((sql) => /raw_json/.test(sql) && /FROM job_observations/.test(sql) && !/\bWHERE\b/.test(sql));
  assert.deepEqual(unfilteredRowScans, [], 'recovery state must not parse every historical observation');
  store.close();
});
