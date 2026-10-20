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
import { openCrawlerStore, crawlRun } from '../../crawler/run.mjs';
import { buildDailyReceipt } from '../../crawler/daily-receipt.mjs';
import { candidateDedupKey, normalizeCandidate } from '../../job-pull/candidate.mjs';
import { loadConfig as loadJobPullConfig } from '../../job-pull/config.mjs';
import { NORMAL_SOURCE_LANES } from '../../job-pull/normal-sources.mjs';
import { readOpportunityLedger, recordSurfaced } from '../../job-pull/opportunity-ledger.mjs';
import { createFakeTransactionalGateway } from '../../job-pull/normal-transaction.mjs';
import { renderLocalDailyHtmlReport, renderLocalLeadReport, writeLocalDailyHtmlReport } from '../../crawler/local-lead-report.mjs';

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

});

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
