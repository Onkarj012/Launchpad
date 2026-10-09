import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activateBoard,
  applyPromotionProposals,
  BOARD_REGISTRY_SCHEMA,
  defaultCapabilities,
  emptyHealth,
  findBoard,
  loadBoardRegistry,
  migrateFromLegacySources,
  normalizeRegistryBoard,
  probeRegistryBoard,
  saveBoardRegistry,
  projectLaneBoards,
  projectTrackedBoards,
  projectTrackedWarmSet,
  planBoundedSources,
  planBoardRotation,
  withRegistryProjectedBoards,
  PROVIDER_LANES,
  workdayCxsUrl,
} from '../../crawler/board-registry.mjs';
import { buildBoardPromotionProposals } from '../../crawler/board-promotion.mjs';
import { buildSourcePlans, loadCrawlerConfig, runCrawlerOperator } from '../../crawler/operator.mjs';
import { trackedBoards, runDailyNormal } from '../../crawler/daily-runner.mjs';
import { loadWarmSet, warmSetSize, WARM_ATS } from '../../job-pull/warm-set.mjs';

const crawlerConfig = JSON.parse(fs.readFileSync('config/crawler-v2.json', 'utf8'));
const reverseWarmSet = JSON.parse(fs.readFileSync('config/reverse-warm-set.json', 'utf8'));

function legacyBoardKeys(crawler, warm) {
  const keys = new Set();
  for (const lane of ['atsWarm', 'atsBatch1', 'atsBatch2', 'enterprise']) {
    for (const board of crawler.sources?.[lane]?.boards ?? []) {
      const provider = String(board.provider).toLowerCase();
      if (provider === 'workday') keys.add(`workday:${board.tenant}|${board.instance}|${board.site}`);
      else keys.add(`${provider}:${board.slug || board.board}`);
    }
    for (const board of crawler.sources?.[lane]?.disabledBoards ?? []) {
      const provider = String(board.provider).toLowerCase();
      const id = board.slug || board.board || (board.company ? `unverified:${String(board.company).toLowerCase().replace(/\s+/g, '-')}` : null);
      if (id) keys.add(`${provider}:${id}`);
    }
  }
  for (const provider of WARM_ATS) {
    for (const slug of warm.boards?.[provider] ?? []) keys.add(`${provider}:${slug}`);
  }
  return keys;
}

test('migration imports every board from both legacy sources with zero coverage loss', () => {
  const { registry, counts } = migrateFromLegacySources({
    crawlerConfig,
    reverseWarmSet,
    runAt: '2026-07-24T12:00:00.000Z',
  });

  const expectedKeys = legacyBoardKeys(crawlerConfig, reverseWarmSet);
  const actualKeys = new Set(registry.boards.map((board) => board.id));

  assert.equal(counts.before.crawler, 47);
  assert.equal(counts.before.reverseWarm, 217);
  assert.equal(registry.boards.length, counts.after);
  assert.equal(actualKeys.size, expectedKeys.size);
  for (const key of expectedKeys) {
    assert.ok(actualKeys.has(key), `missing migrated board ${key}`);
  }
  // Union with dedupe: every legacy key survives; total equals |union|.
  assert.equal(counts.after, expectedKeys.size);
  assert.ok(counts.after < counts.before.crawler + counts.before.reverseWarm);
});

test('Finastra Workday board is active in the unified registry with enterprise URL', () => {
  const registry = loadBoardRegistry('config/board-registry.json');
  const finastra = findBoard(registry, 'workday:finastra|wd3|finc');
  assert.ok(finastra, 'Finastra must exist in production board-registry.json');
  assert.equal(finastra.enabled, true);
  assert.equal(finastra.activationState, 'enabled');
  assert.equal(finastra.probeStatus, 'verified');
  assert.equal(finastra.provider, 'workday');
  assert.equal(finastra.tenant, 'finastra');
  assert.equal(finastra.instance, 'wd3');
  assert.equal(finastra.site, 'finc');
  assert.equal(finastra.company, 'Finastra');
  assert.equal(finastra.url, workdayCxsUrl('finastra', 'wd3', 'finc'));
  assert.equal(finastra.scheduleLane, 'enterprise');
  assert.match(finastra.evidenceRef || '', /daily-run-2026-07-24|finastra/i);
});

test('scheduled operator source plan includes Finastra from the unified registry', async () => {
  const { config } = loadCrawlerConfig('config/crawler-v2.json');
  assert.equal(config.boardRegistryPath, 'config/board-registry.json');

  const enterprise = config.sources.enterprise.boards;
  assert.equal(config.sources.enterprise.maxDetailRequestsPerRun, 200);
  assert.ok(Array.isArray(config.sources.enterprise.excludedLocationKeywords));
  assert.ok(enterprise.some((board) => board.tenant === 'finastra' && board.site === 'finc' && board.enabled !== false));

  const plans = buildSourcePlans({
    config,
    transport: async () => ({ status: 200, body: '{}' }),
    runAt: '2026-07-24T10:00:00.000Z',
    clock: { now: () => '2026-07-24T10:00:00.000Z' },
    schedule: 'morning',
  });
  const enterprisePlan = plans.find((plan) => plan.id === 'ats-enterprise');
  assert.ok(enterprisePlan, 'ats-enterprise plan must be present when registry has Workday boards');

  const finastraBoard = enterprise.find((board) => board.tenant === 'finastra');
  assert.equal(finastraBoard.url, 'https://finastra.wd3.myworkdayjobs.com/wday/cxs/finastra/finc/jobs');
});

test('trackedBoards from the registry covers every reverse-warm-set board', () => {
  const registry = loadBoardRegistry('config/board-registry.json');
  const fromRegistry = projectTrackedBoards(registry);
  const warm = loadWarmSet('config/reverse-warm-set.json');
  const projectedSet = projectTrackedWarmSet(registry);

  for (const provider of WARM_ATS) {
    for (const slug of warm.boards[provider]) {
      assert.ok(
        projectedSet.boards[provider].includes(slug),
        `tracked projection missing ${provider}:${slug}`,
      );
    }
  }

  // Manual path via daily-runner.trackedBoards with registry wired.
  const viaRunner = trackedBoards({ boardRegistry: registry });
  assert.equal(viaRunner.length, fromRegistry.length);
  assert.ok(viaRunner.some((board) => board.provider === 'workday' && board.slug === 'finastra|wd3|finc'));

  // Legacy reverse-warm-set path still works without a registry.
  const viaLegacy = trackedBoards({ reverseWarmSetPath: 'config/reverse-warm-set.json' });
  assert.equal(viaLegacy.length, warmSetSize(warm));
});

test('newly proposed boards stay proposal-only until manually activated', () => {
  let state = {};
  const discovery = {
    provider: 'greenhouse',
    company: 'NewCo India',
    url: 'https://boards.greenhouse.io/newcoindia',
  };
  ({ state } = buildBoardPromotionProposals([{ ...discovery, discoveredAt: '2026-07-20T00:00:00Z' }], state, { runAt: '2026-07-20T00:00:00Z' }));
  ({ state } = buildBoardPromotionProposals([{ ...discovery, discoveredAt: '2026-07-21T00:00:00Z' }], state, { runAt: '2026-07-21T00:00:00Z' }));
  const third = buildBoardPromotionProposals([{ ...discovery, discoveredAt: '2026-07-22T00:00:00Z' }], state, { runAt: '2026-07-22T00:00:00Z' });
  assert.equal(third.proposals.length, 1);
  assert.equal(third.proposals[0].suggestedBoard.enabled, false);
  assert.equal(third.proposals[0].suggestedBoard.activationState, 'proposed');
  assert.equal(third.proposals[0].noAutoApply, true);

  const base = { schemaVersion: BOARD_REGISTRY_SCHEMA, updatedAt: null, boards: [] };
  const { registry, added } = applyPromotionProposals(base, third.proposals, { runAt: '2026-07-22T00:00:00Z' });
  assert.equal(added.length, 1);
  assert.equal(added[0].enabled, false);
  assert.equal(added[0].activationState, 'proposed');
  assert.equal(projectLaneBoards(registry, 'atsWarm').length, 0);

  const activated = activateBoard(registry, added[0].id, { runAt: '2026-07-23T00:00:00Z' });
  const live = projectLaneBoards(activated, 'atsWarm');
  assert.equal(live.length, 1);
  assert.equal(live[0].slug, 'newcoindia');
});

test('Personio and Comeet resolve to batch-2 with complete default capabilities', () => {
  for (const provider of ['personio', 'comeet']) {
    assert.equal(PROVIDER_LANES[provider], 'atsBatch2');
    assert.deepEqual(defaultCapabilities(provider), {
      listingEnumeration: true,
      detailRetrieval: true,
      dateEvidence: true,
      liveness: true,
      applicationUrl: true,
    });
  }
});

test('discovered Personio and Comeet tenants remain disabled proposal-only boards', () => {
  for (const [provider, host] of [['personio', 'acme.jobs.personio.com'], ['comeet', 'www.comeet.com']]) {
    let state = {};
    const discovery = { provider, company: `${provider} Acme`, url: `https://${host}/jobs/acme`, discoveredAt: '2026-07-20T00:00:00Z' };
    ({ state } = buildBoardPromotionProposals([discovery], state, { runAt: '2026-07-20T00:00:00Z' }));
    ({ state } = buildBoardPromotionProposals([{ ...discovery, discoveredAt: '2026-07-21T00:00:00Z' }], state, { runAt: '2026-07-21T00:00:00Z' }));
    const result = buildBoardPromotionProposals([{ ...discovery, discoveredAt: '2026-07-22T00:00:00Z' }], state, { runAt: '2026-07-22T00:00:00Z' });
    assert.equal(result.proposals.length, 1, provider);
    const suggested = result.proposals[0].suggestedBoard;
    assert.equal(suggested.scheduleLane, 'atsBatch2');
    assert.equal(suggested.enabled, false);
    assert.equal(suggested.activationState, 'proposed');
    assert.equal(suggested.probeStatus, 'proposed');
    assert.equal(result.proposals[0].noAutoApply, true);
  }
});

test('registry health metadata defaults exist and recordBoardHealth updates them', async () => {
  const { recordBoardHealth } = await import('../../crawler/board-registry.mjs');
  const board = normalizeRegistryBoard({
    provider: 'greenhouse',
    slug: 'healthco',
    company: 'Health Co',
    enabled: true,
  });
  assert.deepEqual(board.health, emptyHealth());
  assert.equal(board.health.lastSuccessfulFetchAt, null);
  assert.equal(board.health.recentFreshEligibleYield, 0);
  assert.equal(board.health.recentReadyRoleYield, 0);
  assert.equal(board.health.repeatedFailureCount, 0);

  const registry = { schemaVersion: BOARD_REGISTRY_SCHEMA, updatedAt: null, boards: [board] };
  const afterFail = recordBoardHealth(registry, board.id, { failure: true });
  assert.equal(findBoard(afterFail, board.id).health.repeatedFailureCount, 1);
  const afterOk = recordBoardHealth(afterFail, board.id, {
    success: true,
    at: '2026-07-24T08:00:00.000Z',
    freshEligible: 3,
    readyRoles: 1,
  });
  const health = findBoard(afterOk, board.id).health;
  assert.equal(health.lastSuccessfulFetchAt, '2026-07-24T08:00:00.000Z');
  assert.equal(health.recentFreshEligibleYield, 3);
  assert.equal(health.recentReadyRoleYield, 1);
  assert.equal(health.repeatedFailureCount, 0);
});

test('provider families carry typed identity, evidence, geography, capabilities, activation, and health', () => {
  const registry = loadBoardRegistry('config/board-registry.json');
  const samples = {
    greenhouse: findBoard(registry, (b) => b.provider === 'greenhouse' && b.slug === 'phonepe'),
    lever: findBoard(registry, (b) => b.provider === 'lever' && b.slug === 'meesho'),
    ashby: findBoard(registry, (b) => b.provider === 'ashby' && b.slug === 'uipath'),
    smartrecruiters: findBoard(registry, (b) => b.provider === 'smartrecruiters'),
    workable: findBoard(registry, (b) => b.provider === 'workable'),
    recruitee: findBoard(registry, (b) => b.provider === 'recruitee'),
    pinpoint: findBoard(registry, (b) => b.provider === 'pinpoint' && b.slug === 'infor'),
    workday: findBoard(registry, 'workday:finastra|wd3|finc'),
  };

  for (const [family, board] of Object.entries(samples)) {
    assert.ok(board, `missing sample for ${family}`);
    assert.equal(typeof board.id, 'string');
    assert.equal(typeof board.provider, 'string');
    assert.equal(typeof board.company, 'string');
    assert.equal(typeof board.enabled, 'boolean');
    assert.ok(['enabled', 'proposed', 'disabled', 'rejected'].includes(board.activationState));
    assert.equal(typeof board.probeStatus, 'string');
    assert.equal(typeof board.indiaFirst, 'boolean');
    assert.equal(typeof board.indiaRelevant, 'boolean');
    assert.equal(typeof board.puneRelevant, 'boolean');
    assert.equal(typeof board.capabilities, 'object');
    for (const key of ['listingEnumeration', 'detailRetrieval', 'dateEvidence', 'liveness', 'applicationUrl']) {
      assert.equal(typeof board.capabilities[key], 'boolean', `${family}.${key}`);
    }
    assert.equal(typeof board.health, 'object');
    assert.equal(typeof board.health.repeatedFailureCount, 'number');
    assert.deepEqual(
      Object.keys(defaultCapabilities(board.provider)).sort(),
      Object.keys(board.capabilities).sort(),
    );
  }

  assert.equal(samples.greenhouse.slug, 'phonepe');
  assert.equal(samples.greenhouse.indiaFirst, true);
  assert.equal(samples.workable.board, 'blue-altair');
  assert.ok(samples.workable.endpoint);
  assert.equal(samples.workday.tenant, 'finastra');
  assert.ok(samples.workday.url.includes('/wday/cxs/finastra/finc/jobs'));
});

test('registry normalization preserves a seed tier', () => {
  const board = normalizeRegistryBoard({ provider: 'ashby', slug: 'seeded', registryTier: 'india-ai-devtools' });
  assert.equal(board.registryTier, 'india-ai-devtools');
});

test('registry normalization retains structured career-page URL and JSON-LD probe evidence', () => {
  const board = normalizeRegistryBoard({
    provider: 'custom', company: 'Structured Co', careerPageUrl: 'https://structured.example/careers',
    probe: { jobPostingJsonLd: true },
  });

  assert.equal(board.careerPageUrl, 'https://structured.example/careers');
  assert.equal(board.probe.jobPostingJsonLd, true);
});

test('locationPreset pune ranks pune-relevant boards ahead of others in a lane', () => {
  const registry = {
    boards: [
      { scheduleLane: 'atsWarm', enabled: true, activationState: 'enabled', provider: 'greenhouse', slug: 'remote-co', company: 'Remote Co', indiaRelevant: false, puneRelevant: false },
      { scheduleLane: 'atsWarm', enabled: true, activationState: 'enabled', provider: 'greenhouse', slug: 'pune-co', company: 'Pune Co', indiaRelevant: true, puneRelevant: true },
      { scheduleLane: 'atsWarm', enabled: true, activationState: 'enabled', provider: 'greenhouse', slug: 'india-co', company: 'India Co', indiaRelevant: true, puneRelevant: false },
    ],
  };
  const boards = projectLaneBoards(registry, 'atsWarm', { locationPreset: 'pune' });
  assert.deepEqual(boards.map((board) => board.slug), ['pune-co', 'india-co', 'remote-co']);
});

test('operator location presets project Pune and India priority without changing provider lanes', () => {
  const registry = {
    boards: [
      { scheduleLane: 'atsWarm', enabled: true, activationState: 'enabled', provider: 'greenhouse', slug: 'global-co', company: 'Global Co' },
      { scheduleLane: 'atsWarm', enabled: true, activationState: 'enabled', provider: 'greenhouse', slug: 'india-co', company: 'India Co', indiaRelevant: true },
      { scheduleLane: 'atsWarm', enabled: true, activationState: 'enabled', provider: 'greenhouse', slug: 'pune-co', company: 'Pune Co', puneRelevant: true, indiaRelevant: true },
    ],
  };
  const config = { boardRegistry: registry, sources: { atsWarm: {} } };
  assert.deepEqual(withRegistryProjectedBoards(config, { locationPreset: 'pune' }).sources.atsWarm.boards.map((board) => board.slug), ['pune-co', 'india-co', 'global-co']);
  assert.deepEqual(withRegistryProjectedBoards(config, { locationPreset: 'india' }).sources.atsWarm.boards.map((board) => board.slug), ['pune-co', 'india-co', 'global-co']);
});

test('bounded source planning is deterministic, explains all outcomes, and resumes productive work', () => {
  const inputs = {
    atsWarm: [
      { provider: 'greenhouse', slug: 'core', company: 'Core', puneRelevant: true, health: { recentReadyRoleYield: 2 } },
      { provider: 'greenhouse', slug: 'resume', company: 'Resume', health: { recentReadyRoleYield: 1 } },
    ],
    atsBatch1: [
      { provider: 'greenhouse', slug: 'resume', company: 'Resume alias' },
      { provider: 'workable', board: 'explore', company: 'Explore' },
    ],
    enterprise: [{ provider: 'workday', tenant: 'acme', instance: 'wd1', site: 'Careers', company: 'Acme', indiaRelevant: true }],
  };
  const options = { boardsByLane: inputs, locationPreset: 'pune', maxBoards: 3, runAt: '2026-08-21T00:00:00.000Z', sourceBudgetMs: 720_000 };
  const first = planBoundedSources(options);
  const second = planBoundedSources(options);
  assert.deepEqual(first.boardPlan, second.boardPlan);
  assert.equal(first.boardPlan.sourcePhaseWithinBudget, true);
  assert.equal(first.boardPlan.noWrite, true);
  assert.equal(first.boardPlan.retainedReadyYield, 3);
  assert.ok(first.boardPlan.decisions.every((decision) => decision.reason));
  assert.ok(first.boardPlan.decisions.some((decision) => decision.reason === 'duplicate-board-alias'));

  const resumed = planBoundedSources({ ...options, state: { boards: { 'greenhouse:resume': { cursor: { page: 2 }, status: 'interrupted' } } } });
  const resumedDecision = resumed.boardPlan.decisions.find((decision) => decision.boardId === 'greenhouse:resume' && decision.sourceLane === 'atsWarm');
  assert.equal(resumedDecision.action, 'resumed');
  assert.equal(resumedDecision.reason, 'continuation-measured-priority');
  for (const manifest of [first.boardPlan, second.boardPlan, resumed.boardPlan]) {
    assert.equal(manifest.noWrite, true);
    assert.ok(manifest.sourcePhaseBudgetMs <= 720_000);
    assert.ok(manifest.retainedReadyYield >= 0);
  }
});

test('bounded source planning advances deferred exploration from durable state while preserving tracked ATS coverage', () => {
  const boardsByLane = {
    atsWarm: [
      { provider: 'greenhouse', slug: 'priority-a', sourceTier: 'daily-core' },
      { provider: 'greenhouse', slug: 'priority-b', sourceTier: 'daily-core' },
      { provider: 'greenhouse', slug: 'priority-c', sourceTier: 'daily-core' },
      { provider: 'greenhouse', slug: 'priority-d', sourceTier: 'daily-core' },
    ],
    atsBatch1: [
      { provider: 'workable', slug: 'explore-a', sourceTier: 'exploration' },
      { provider: 'workable', slug: 'explore-b', sourceTier: 'exploration' },
      { provider: 'workable', slug: 'explore-c', sourceTier: 'exploration' },
    ],
  };
  const options = { boardsByLane, maxBoards: 5, runAt: '2026-08-21T00:00:00.000Z' };
  const first = planBoundedSources(options);
  const sameState = planBoundedSources({ ...options, state: first.state });
  const sameStateAgain = planBoundedSources({ ...options, state: first.state });
  const second = planBoundedSources({ ...options, runAt: '2026-08-22T00:00:00.000Z', state: first.state });

  assert.deepEqual(sameState.boardPlan, sameStateAgain.boardPlan);
  assert.notDeepEqual(
    second.boardsByLane.atsBatch1.map((board) => board.boardId),
    first.boardsByLane.atsBatch1.map((board) => board.boardId),
  );
  assert.equal(first.boardsByLane.atsBatch1[0].boardId, 'workable:explore-a');
  assert.equal(second.boardsByLane.atsBatch1[0].boardId, 'workable:explore-b');
  assert.deepEqual(first.boardPlan.trackedAts.coverage.selectedBoardIds, first.boardsByLane.atsWarm.map((board) => board.boardId));
  assert.equal(first.state.explorationCursor, 1);
  assert.equal(first.state.trackedAts.rotation.cursor, 0);
  assert.ok(first.boardPlan.decisions.every((decision) => decision.reason));
});

// Prove that one public feed supplies geography and retained probe evidence.
test('one public board GET sets relevance and a probe record that survives registry storage', async () => {
  const registry = { schemaVersion: BOARD_REGISTRY_SCHEMA, boards: [normalizeRegistryBoard({
    provider: 'greenhouse', slug: 'probe-co', company: 'Probe Co', evidenceRef: 'https://probe.example/careers',
  })] };
  const calls = [];
  const result = await probeRegistryBoard(registry, 'greenhouse:probe-co', {
    runAt: '2026-10-08T02:15:00.000Z',
    foundVia: 'employer-careers-link',
    transport: async (url, options) => {
      calls.push({ url, method: options.method });
      return { status: 200, body: { jobs: [
        { id: 1, title: 'Software Engineer', location: { name: 'Pune, India' } },
        { id: 2, title: 'Backend Engineer', location: { name: 'Bengaluru, India' } },
        { id: 3, title: 'Software Engineer', location: { name: 'Boston, United States' } },
      ] } };
    },
  });
  assert.deepEqual(calls, [{ url: 'https://boards-api.greenhouse.io/v1/boards/probe-co/jobs?content=true', method: 'GET' }]);
  const board = findBoard(result, 'greenhouse:probe-co');
  assert.equal(board.puneRelevant, true);
  assert.equal(board.indiaRelevant, true);
  assert.deepEqual(board.probe, {
    probedAt: '2026-10-08T02:15:00.000Z', foundVia: 'employer-careers-link',
    sourceUrl: calls[0].url, jobCount: 3, indiaJobCount: 2, usOnly: false, complete: true, zeroIndiaSince: null,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-registry-'));
  try {
    const file = path.join(dir, 'boards.json');
    saveBoardRegistry(file, result);
    assert.deepEqual(findBoard(loadBoardRegistry(file), board.id).probe, board.probe);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Each feed uses its own location shape, including structured country evidence.
test('public probes use provider feeds and clear stale relevance without guessing unknown locations', async () => {
  const samples = [
    { provider: 'lever', slug: 'lever-co', body: [{ categories: { location: 'Bengaluru, India' } }], expected: [false, true, 1] },
    { provider: 'ashby', slug: 'ashby-co', body: { jobs: [{ location: 'Pune, India' }, { location: 'New York, United States' }] }, expected: [true, true, 1] },
    { provider: 'smartrecruiters', board: 'sr-co', body: { content: [{ location: { city: 'Pune', country: 'in' } }] }, expected: [true, true, 1] },
    { provider: 'workday', tenant: 'us-co', instance: 'wd1', site: 'External', endpoint: 'https://us-co.example/jobs', body: { jobPostings: [{ locationsText: 'Boston, United States' }] }, expected: [false, false, 0] },
    { provider: 'workable', board: 'workable-co', body: { jobs: [{ location: { city: 'Pune', country: 'India' } }] }, expected: [true, true, 1] },
    { provider: 'teamtailor', board: 'team-co', body: { data: [{ attributes: { location: 'Pune, India' } }] }, expected: [true, true, 1] },
    { provider: 'recruitee', board: 'recruit-co', body: { offers: [{ location: 'Bengaluru, India' }] }, expected: [false, true, 1] },
    { provider: 'breezy', slug: 'breezy-co', body: [{ location: { city: 'Pune', country: 'India' } }], expected: [true, true, 1] },
    { provider: 'bamboohr', slug: 'bamboo-co', body: { result: [{ location: 'Pune, India' }] }, expected: [true, true, 1] },
    { provider: 'personio', slug: 'personio-co', body: '<workzag-jobs><position><id>1</id><office>Pune, India</office></position></workzag-jobs>', expected: [true, true, 1] },
    { provider: 'comeet', slug: 'comeet-co', body: { positions: [{ location: 'Pune, India' }] }, expected: [true, true, 1] },
    { provider: 'pinpoint', slug: 'pinpoint-co', body: { data: [{ location: { city: 'Pune', country: 'India' } }] }, expected: [true, true, 1] },
    { provider: 'rippling', slug: 'rippling-co', body: { jobs: [{ location: 'Pune, India' }] }, expected: [true, true, 1] },
    { provider: 'greenhouse', slug: 'unknown-co', body: { jobs: [{ location: { name: 'Remote' } }] }, expected: [false, false, 0] },
  ];
  for (const sample of samples) {
    const board = normalizeRegistryBoard({ ...sample, puneRelevant: true, indiaRelevant: true });
    let requests = 0;
    const registry = await probeRegistryBoard({ schemaVersion: BOARD_REGISTRY_SCHEMA, boards: [board] }, board.id, {
      runAt: '2026-10-08T02:15:00.000Z', transport: async (url, options) => {
        requests += 1;
        assert.equal(options.method, 'GET');
        if (sample.provider === 'lever') assert.equal(url, 'https://api.lever.co/v0/postings/lever-co');
        if (sample.provider === 'ashby') assert.equal(url, 'https://api.ashbyhq.com/posting-api/job-board/ashby-co?includeCompensation=true');
        if (sample.provider === 'smartrecruiters') assert.match(url, /api.smartrecruiters.com\/v1\/companies\/sr-co\/postings/);
        return { status: 200, body: sample.body };
      },
    });
    assert.equal(requests, 1);
    const probed = findBoard(registry, board.id);
    assert.deepEqual([probed.puneRelevant, probed.indiaRelevant, probed.probe.indiaJobCount], sample.expected);
    assert.equal(probed.probe.usOnly, sample.provider === 'workday');
  }
});

// A failed response cannot erase known evidence or start a zero-yield streak.
test('failed or malformed public probes leave registry evidence unchanged', async () => {
  const board = normalizeRegistryBoard({ provider: 'greenhouse', slug: 'known', puneRelevant: true, indiaRelevant: true });
  const registry = { schemaVersion: BOARD_REGISTRY_SCHEMA, boards: [board] };
  for (const response of [{ status: 429, body: {} }, { status: 200, body: { error: 'unavailable' } }]) {
    await assert.rejects(probeRegistryBoard(registry, board.id, { transport: async () => response }));
    assert.equal(board.probe, null);
    assert.equal(board.puneRelevant, true);
  }
});

// Keep the production registry inside the next-phase seed contract.
test('production registry contains 250 to 400 probed employers', () => {
  const registry = loadBoardRegistry('config/board-registry.json');
  const employers = new Set(registry.boards.filter((board) => board.probeStatus === 'verified').map((board) => board.company.toLowerCase()));
  assert.ok(employers.size >= 250 && employers.size <= 400);
});

test('registry seed retains one verified India probe for each added Ashby employer', () => {
  const registry = loadBoardRegistry('config/board-registry.json');
  const expected = new Map([
    ['Avoca', [26, 2]],
    ['Reo.Dev', [3, 3]],
    ['Blitzy', [34, 3]],
    ['Plotline', [15, 12]],
  ]);

  for (const [company, [jobCount, indiaJobCount]] of expected) {
    const board = registry.boards.find((item) => item.company === company);
    assert.ok(board, `${company} must be in the registry`);
    assert.equal(board.provider, 'ashby');
    assert.equal(board.probeStatus, 'verified');
    assert.equal(board.indiaRelevant, true);
    assert.equal(board.probe.complete, true);
    assert.equal(board.probe.jobCount, jobCount);
    assert.equal(board.probe.indiaJobCount, indiaJobCount);
    assert.equal(board.probe.sourceUrl, `https://api.ashbyhq.com/posting-api/job-board/${board.slug}?includeCompensation=true`);
  }
});

test('next-phase seed adds at least 25 probed employers and retains verified structured career pages', () => {
  const registry = loadBoardRegistry('config/board-registry.json');
  const employers = new Set(registry.boards.filter((board) => board.probeStatus === 'verified').map((board) => board.company.toLowerCase()));
  const careerPages = registry.boards.filter((board) => board.provider === 'custom'
    && board.careerPageUrl && board.probe?.jobPostingJsonLd === true);

  assert.ok(employers.size >= 275);
  assert.ok(careerPages.length >= 2);
});

test('production registry includes all four employer tiers', () => {
  const registry = loadBoardRegistry('config/board-registry.json');
  const tiers = new Set(registry.boards.map((board) => board.registryTier).filter(Boolean));
  assert.deepEqual([...tiers].sort(), ['india-ai-devtools', 'pune-gcc-captive', 'pune-product', 'services-major']);
});

test('production registry does not include Capgemini', () => {
  const registry = loadBoardRegistry('config/board-registry.json');
  assert.ok(registry.boards.every((board) => !/capgemini/i.test(board.company)));
});

test('every production registry board has a retained public probe record', () => {
  const registry = loadBoardRegistry('config/board-registry.json');
  assert.ok(registry.boards.every((board) => board.probe?.probedAt));
  assert.ok(registry.boards.every((board) => board.probe?.sourceUrl || board.probe?.failureReason));
});

// Daily defaults and both rotation planners must spend the first request on Pune.
test('Pune boards lead default production projection and rotated request budgets', async () => {
  const registry = { boards: ['a-global', 'z-pune'].map((slug) => normalizeRegistryBoard({
    provider: 'ashby', slug, company: slug, puneRelevant: slug === 'z-pune', indiaRelevant: slug === 'z-pune',
  })) };
  const projected = withRegistryProjectedBoards({ boardRegistry: registry, sources: { atsWarm: {} } });
  assert.equal(projected.sources.atsWarm.boards[0].slug, 'z-pune');
  const rotated = planBoardRotation({ boards: projected.sources.atsWarm.boards, maxBoards: 1, state: { cursor: 1 } });
  assert.equal(rotated.boards[0].slug, 'z-pune');
  const bounded = planBoundedSources({
    boardsByLane: { atsWarm: projected.sources.atsWarm.boards }, maxBoards: 1,
    state: { boards: { 'ashby:a-global': { cursor: { page: 2 }, status: 'interrupted' } } },
  });
  assert.equal(bounded.boardsByLane.atsWarm[0].slug, 'z-pune');
  const calls = [];
  const plans = buildSourcePlans({
    config: { boardRegistry: registry, sources: { atsWarm: { maxBoards: 1, rotation: { enabled: true }, rotationState: { cursor: 1 } } } },
    transport: async (_url, options) => { calls.push(options.board.slug); return { status: 200, body: { jobs: [] } }; },
    runAt: '2026-10-08T02:15:00.000Z', schedule: 'morning',
  });
  await plans.find((plan) => plan.id === 'ats-warm').fetch({});
  assert.deepEqual(calls, ['z-pune']);
});

// The scheduled seam persists probe history and stops spending requests after seven days.
test('production pauses a proven US-only tenant after seven days of zero India jobs', async () => {
  const board = normalizeRegistryBoard({ provider: 'workday', tenant: 'us-only', instance: 'wd1', site: 'External' });
  const registry = { schemaVersion: BOARD_REGISTRY_SCHEMA, boards: [board] };
  let state = {};
  const requests = [];
  for (let day = 1; day <= 8; day += 1) {
    const runAt = `2026-10-${String(day).padStart(2, '0')}T02:15:00.000Z`;
    const plans = buildSourcePlans({
      config: { boardRegistry: registry, sourcePlanner: { enabled: true, maxBoards: 5, state }, sources: { enterprise: { maxPages: 1, enrichDetails: false } } },
      runAt, schedule: 'morning', onSourcePlanState: (next) => { state = next; },
      transport: async () => {
        requests.push(day);
        return { status: 200, body: { total: 1, jobPostings: [
          { title: 'Software Engineer', externalPath: '/job/Boston/Software-Engineer_R123', locationsText: 'Boston, United States', postedOn: 'Posted Today' },
        ] } };
      },
    });
    const result = await plans.find((plan) => plan.id === 'ats-enterprise').fetch({});
    if (day === 8) assert.ok(result.manifest.boardPlan.decisions.some((decision) => decision.boardId === 'workday:us-only|wd1|external' && decision.reason === 'us-only-zero-india-yield-7-days'));
  }
  assert.deepEqual(requests, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(state.boards['workday:us-only|wd1|external'].probe.indiaJobCount, 0);
  assert.equal(state.boards['workday:us-only|wd1|external'].probe.zeroIndiaSince, '2026-10-01T02:15:00.000Z');
});

// Partial or unknown locations cannot prove US-only coverage, and India breaks the streak.
test('partial probes stay active and an India job restarts a US-only zero-yield streak', async () => {
  const board = normalizeRegistryBoard({ provider: 'workday', tenant: 'mixed', instance: 'wd1', site: 'External' });
  let registry = { schemaVersion: BOARD_REGISTRY_SCHEMA, boards: [board] };
  const probe = async (runAt, total, locations) => {
    registry = await probeRegistryBoard(registry, board.id, { runAt,
      transport: async () => ({ status: 200, body: { total, jobPostings: locations.map((locationsText) => ({ locationsText })) } }),
    });
  };
  await probe('2026-10-01T02:15:00.000Z', 30, ['Boston, United States']);
  await probe('2026-10-08T02:15:00.000Z', 30, ['Boston, United States']);
  let plan = planBoundedSources({ boardsByLane: { enterprise: projectLaneBoards(registry, 'enterprise') }, maxBoards: 1, runAt: '2026-10-08T02:15:00.000Z' });
  assert.equal(plan.boardsByLane.enterprise.length, 1);
  await probe('2026-10-09T02:15:00.000Z', 1, ['Boston, United States']);
  await probe('2026-10-10T02:15:00.000Z', 1, ['Pune, India']);
  assert.equal(findBoard(registry, board.id).probe.zeroIndiaSince, null);
  await probe('2026-10-11T02:15:00.000Z', 1, ['Boston, United States']);
  assert.equal(findBoard(registry, board.id).probe.zeroIndiaSince, '2026-10-11T02:15:00.000Z');
  plan = planBoardRotation({ boards: projectLaneBoards(registry, 'enterprise'), maxBoards: 1, runAt: '2026-10-18T02:15:00.000Z' });
  assert.equal(plan.boards.length, 0);
  assert.equal(plan.telemetry.omissions[0].reason, 'us-only-zero-india-yield-7-days');
});

// The legacy tracked pass must retain Pune priority and honor the same saved pause.
test('tracked registry projection retains relevance and honors durable pause evidence', () => {
  const registry = { boards: [
    normalizeRegistryBoard({ provider: 'ashby', slug: 'a-us', probe: { complete: true, usOnly: true, indiaJobCount: 0, zeroIndiaSince: '2026-10-01T02:15:00.000Z' } }),
    normalizeRegistryBoard({ provider: 'ashby', slug: 'z-pune', puneRelevant: true, indiaRelevant: true }),
  ] };
  const projected = projectTrackedBoards(registry);
  const plan = planBoardRotation({ boards: projected, maxBoards: 1, runAt: '2026-10-08T02:15:00.000Z' });
  assert.equal(plan.boards[0].slug, 'z-pune');
  assert.ok(plan.telemetry.omissions.some((entry) => entry.reason === 'us-only-zero-india-yield-7-days'));
});

// Reload a file-backed registry each run and prove the default production path keeps history.
test('production reads registry files and persists US-only pauses without the bounded planner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-registry-run-'));
  const file = path.join(dir, 'boards.json');
  const configFile = path.join(dir, 'crawler.json');
  const requests = [];
  try {
    saveBoardRegistry(file, { schemaVersion: BOARD_REGISTRY_SCHEMA, boards: [
      normalizeRegistryBoard({ provider: 'ashby', slug: 'file-only' }),
    ] });
    fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 'LaunchpadCrawlerConfigV1',
      databasePath: path.join(dir, 'crawler.sqlite'), boardRegistryPath: file,
      sources: { atsWarm: { boards: [{ provider: 'ashby', slug: 'stale-inline' }] } },
    }));
    for (const day of [1, 7, 8]) {
      const at = `2026-10-${String(day).padStart(2, '0')}T02:15:00.000Z`;
      const { config } = loadCrawlerConfig(configFile);
      const result = await runCrawlerOperator({ config, runId: `registry-${day}`, schedule: 'morning',
        clock: { now: () => at },
        transport: async (url) => {
          requests.push(url);
          return { status: 200, body: { jobs: [{ id: '1', title: 'Software Engineer', jobUrl: 'https://jobs.ashbyhq.com/file-only/1', location: 'Boston, United States', descriptionPlain: 'Software engineering', publishedAt: at }] } };
        },
      });
      assert.match(result.run.status, /^completed/);
    }
    assert.deepEqual(requests, [
      'https://api.ashbyhq.com/posting-api/job-board/file-only?includeCompensation=true',
      'https://api.ashbyhq.com/posting-api/job-board/file-only?includeCompensation=true',
    ]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A later tracked pass must not re-fetch a board skipped by the scheduled pass.
test('daily production keeps a US-only pause across both ATS passes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-registry-daily-'));
  const file = path.join(dir, 'boards.json');
  const calls = [];
  try {
    saveBoardRegistry(file, { schemaVersion: BOARD_REGISTRY_SCHEMA, boards: [normalizeRegistryBoard({ provider: 'ashby', slug: 'daily-us' })] });
    const config = { schemaVersion: 'LaunchpadCrawlerConfigV1', boardRegistryPath: file,
      databasePath: path.join(dir, 'crawler.sqlite'), opportunityLedgerPath: path.join(dir, 'opportunities.tsv'),
      dailyShortlistBudgetPath: path.join(dir, 'budget.json'),
      sources: { atsWarm: { boards: [] } },
    };
    for (const day of [1, 7, 8]) {
      const at = `2026-10-${String(day).padStart(2, '0')}T02:15:00.000Z`;
      await runDailyNormal({ config, runId: `daily-registry-${day}`, clock: { now: () => at },
        historicalV4Rows: [], ledgerRows: [], opportunityLedgerRows: [], scores: [],
        transport: async () => { calls.push(day); return { status: 200, body: { jobs: [{ id: 'us', title: 'Software Engineer', jobUrl: 'https://jobs.ashbyhq.com/daily-us/us', location: 'Boston, United States', descriptionPlain: 'Software engineering', publishedAt: at }] } }; },
      });
    }
    assert.deepEqual(calls, [1, 7]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Production must reuse observed flags on the next run, even before the registry is saved.
test('production prioritizes Pune evidence retained by the previous run', async () => {
  const registry = { boards: ['a-global', 'z-local'].map((slug) => normalizeRegistryBoard({ provider: 'ashby', slug })) };
  let state = {};
  const requests = [];
  const run = async (day, maxBoards) => {
    const plans = buildSourcePlans({ config: { boardRegistry: registry, sourcePlanner: { enabled: true, maxBoards, state }, sources: { atsWarm: {} } },
      runAt: `2026-10-0${day}T02:15:00.000Z`, schedule: 'morning', onSourcePlanState: (next) => { state = next; },
      transport: async (_url, options) => { requests.push(options.board.slug); return { status: 200, body: { jobs: [{ location: options.board.slug === 'z-local' ? 'Pune, India' : 'Remote' }] } }; },
    });
    await plans.find((plan) => plan.id === 'ats-warm').fetch({});
  };
  await run(1, 2);
  requests.length = 0;
  await run(2, 1);
  assert.deepEqual(requests, ['z-local']);
});

// Registry updates remain authoritative over stale config projections and pause history.
test('a registry file update takes effect on the next production projection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-registry-refresh-'));
  try {
    const file = path.join(dir, 'boards.json');
    saveBoardRegistry(file, { boards: [normalizeRegistryBoard({ provider: 'ashby', slug: 'old' })] });
    const config = withRegistryProjectedBoards({ boardRegistryPath: file, sources: {} });
    saveBoardRegistry(file, { boards: [normalizeRegistryBoard({ provider: 'ashby', slug: 'new', puneRelevant: true })] });
    assert.deepEqual(withRegistryProjectedBoards(config).sources.atsWarm.boards.map((board) => board.slug), ['new']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Put a Pune-relevant provider lane first when all other ATS supply is elsewhere.
test('Pune-relevant boards are requested before other ATS lanes', async () => {
  const registry = { boards: [
    normalizeRegistryBoard({ provider: 'ashby', slug: 'global' }),
    normalizeRegistryBoard({ provider: 'workday', tenant: 'pune', instance: 'wd1', site: 'External', puneRelevant: true }),
  ] };
  const calls = [];
  const plans = buildSourcePlans({ config: { boardRegistry: registry, sources: {} }, schedule: 'morning', runAt: '2026-10-08T02:15:00.000Z',
    transport: async (_url, options) => { calls.push(options.provider); return { status: 200, body: options.provider === 'workday' ? { total: 0, jobPostings: [] } : { jobs: [] } }; },
  });
  for (const plan of plans) await plan.fetch({});
  assert.deepEqual(calls, ['workday', 'ashby']);
});

// A paginated daily crawl retains the first probe rather than overwriting it with another page.
test('production records one public listing response per board', async () => {
  const board = normalizeRegistryBoard({ provider: 'workday', tenant: 'paged', instance: 'wd1', site: 'External' });
  let state;
  let calls = 0;
  const plans = buildSourcePlans({ config: { boardRegistry: { boards: [board] }, sources: { enterprise: { maxPages: 2, maxJobsPerBoard: 2, enrichDetails: false } } },
    runAt: '2026-10-08T02:15:00.000Z', schedule: 'morning', onSourcePlanState: (next) => { state = next; },
    transport: async () => { calls += 1; return { status: 200, body: { total: 2, jobPostings: [{ title: 'Software Engineer', externalPath: `/job/Engineer_R${calls}`, locationsText: calls === 1 ? 'Pune, India' : 'Boston, United States' }] } }; },
  });
  await plans.find((plan) => plan.id === 'ats-enterprise').fetch({});
  assert.equal(calls, 2);
  assert.equal(state.boards['workday:paged|wd1|external'].probe.indiaJobCount, 1);
  assert.equal(state.boards['workday:paged|wd1|external'].puneRelevant, true);
});

// Provider quotas must not consume a tight budget before the Pune board is reached.
test('Pune priority survives provider quotas under a one-board cap', () => {
  const plan = planBoardRotation({ maxBoards: 1, providerQuotas: { ashby: 1, greenhouse: 1 },
    boards: [{ provider: 'ashby', slug: 'global' }, { provider: 'greenhouse', slug: 'pune', puneRelevant: true }],
  });
  assert.equal(plan.boards[0].slug, 'pune');
});

// Two sites under one tenant must retain evidence against their own registry identity.
test('production probe records distinguish sites on the same Workday tenant', async () => {
  let state;
  const registry = { boards: ['India', 'US'].map((site) => normalizeRegistryBoard({ provider: 'workday', tenant: 'shared', instance: 'wd1', site })) };
  const plans = buildSourcePlans({ config: { boardRegistry: registry, sources: { enterprise: { maxPages: 1 } } }, schedule: 'morning',
    runAt: '2026-10-08T02:15:00.000Z', onSourcePlanState: (next) => { state = next; },
    transport: async (url) => ({ status: 200, body: { total: 1, jobPostings: [{ locationsText: url.includes('/India/') ? 'Pune, India' : 'Boston, United States' }] } }),
  });
  await plans.find((plan) => plan.id === 'ats-enterprise').fetch({});
  assert.equal(state.boards['workday:shared|wd1|india'].probe.indiaJobCount, 1);
  assert.equal(state.boards['workday:shared|wd1|us'].probe.indiaJobCount, 0);
});

// A location mentioning US together with another country or global scope is not US-only.
test('mixed-country and global locations never start a US-only pause', async () => {
  for (const location of ['United States or Canada', 'Global remote, United States', 'United States and Germany']) {
    const board = normalizeRegistryBoard({ provider: 'ashby', slug: 'mixed-scope' });
    const registry = await probeRegistryBoard({ boards: [board] }, board.id, {
      runAt: '2026-10-01T02:15:00.000Z', transport: async () => ({ status: 200, body: { jobs: [{ location }] } }),
    });
    assert.equal(findBoard(registry, board.id).probe.usOnly, false);
    assert.equal(planBoardRotation({ boards: projectLaneBoards(registry, 'atsWarm'), maxBoards: 1, runAt: '2026-10-08T02:15:00.000Z' }).boards.length, 1);
  }
});
