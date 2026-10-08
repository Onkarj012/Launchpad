import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  projectLaneBoards,
  projectTrackedBoards,
  projectTrackedWarmSet,
  planBoundedSources,
  withRegistryProjectedBoards,
  PROVIDER_LANES,
  workdayCxsUrl,
} from '../../crawler/board-registry.mjs';
import { buildBoardPromotionProposals } from '../../crawler/board-promotion.mjs';
import { buildSourcePlans, loadCrawlerConfig } from '../../crawler/operator.mjs';
import { trackedBoards } from '../../crawler/daily-runner.mjs';
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

  assert.equal(counts.before.crawler, 29);
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
  assert.deepEqual(withRegistryProjectedBoards(config, { locationPreset: 'india' }).sources.atsWarm.boards.map((board) => board.slug), ['india-co', 'pune-co', 'global-co']);
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
