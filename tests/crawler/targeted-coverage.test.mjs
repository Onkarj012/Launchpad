import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBoardRegistry, normalizeRegistryBoard, planBoardRotation, planBoundedSources } from '../../crawler/board-registry.mjs';
import { buildSourcePlans, crawlerDiscoveryPlan } from '../../crawler/operator.mjs';

// Keep all equally relevant Pune employers reachable under a one-board budget.
test('bounded Pune priority rotates rather than selecting the same first employer', () => {
  const boards = ['a', 'b', 'c'].map((slug) => normalizeRegistryBoard({ provider: 'ashby', slug, puneRelevant: true, indiaRelevant: true }));
  let state = {};
  const seen = [];
  for (let day = 0; day < 3; day += 1) {
    const plan = planBoundedSources({ boardsByLane: { atsWarm: boards }, maxBoards: 1, state });
    assert.equal(plan.boardPlan.boardsSelected, 1);
    seen.push(plan.boardsByLane.atsWarm[0].boardId);
    state = plan.state;
  }
  assert.deepEqual(seen, ['ashby:a', 'ashby:b', 'ashby:c']);
});

// India evidence must survive the legacy rotation before generic remote inventory.
test('legacy rotation prioritizes retained India relevance and rotates peers', () => {
  const boards = ['a-global', 'b-india', 'c-india'].map((slug) => normalizeRegistryBoard({ provider: 'ashby', slug, indiaRelevant: slug.endsWith('india') }));
  const first = planBoardRotation({ boards, maxBoards: 1 });
  const second = planBoardRotation({ boards, maxBoards: 1, state: first.state });
  assert.deepEqual([first.boards[0].slug, second.boards[0].slug], ['b-india', 'c-india']);
});

// Quota and fallback picks must not skip unvisited provider peers.
test('legacy provider quotas and fallback reach every equal peer under a shared cap', () => {
  const boards = [
    ...['a', 'b', 'c'].map((slug) => normalizeRegistryBoard({ provider: 'ashby', slug })),
    ...['d', 'e', 'f'].map((board) => normalizeRegistryBoard({ provider: 'greenhouse', board })),
  ];
  let state = {};
  for (let window = 0; window < 3; window += 1) {
    const seen = new Set();
    for (let day = 0; day < 4; day += 1) {
      const plan = planBoardRotation({ boards, maxBoards: 3, providerQuotas: { ashby: 1, greenhouse: 1 }, state });
      assert.equal(plan.boards.length, 3);
      assert.ok(plan.boards.some(({ provider }) => provider === 'ashby'));
      assert.ok(plan.boards.some(({ provider }) => provider === 'greenhouse'));
      plan.boards.forEach(({ rotationBoardId }) => seen.add(rotationBoardId));
      state = plan.state;
    }
    assert.deepEqual([...seen].sort(), ['ashby:a', 'ashby:b', 'ashby:c', 'greenhouse:d', 'greenhouse:e', 'greenhouse:f']);
  }
});

// India lanes should get their requests before a generic ATS lane can consume time.
test('scheduled source order puts retained India boards before generic ATS', () => {
  const config = { boardRegistry: { boards: [
    normalizeRegistryBoard({ provider: 'ashby', slug: 'global' }),
    normalizeRegistryBoard({ provider: 'workday', tenant: 'india', instance: 'wd1', site: 'External', indiaRelevant: true }),
  ] }, sources: {} };
  const plans = buildSourcePlans({ config, schedule: 'morning', runAt: '2026-10-13T02:15:00.000Z', transport: async () => assert.fail('plan must not fetch') });
  assert.ok(plans.findIndex(({ id }) => id === 'ats-enterprise') < plans.findIndex(({ id }) => id === 'ats-warm'));
});

// Registry verification describes metadata; only real source ownership is scheduled coverage.
test('discovery plan distinguishes custom career ownership, unscheduled and disabled boards', () => {
  const custom = normalizeRegistryBoard({ provider: 'custom', slug: 'supported', careerPageUrl: 'https://supported.example/jobs/1', probeStatus: 'verified', probe: { jobPostingJsonLd: true } });
  const unsupported = normalizeRegistryBoard({ provider: 'custom', slug: 'unscheduled', probeStatus: 'verified' });
  const disabled = normalizeRegistryBoard({ provider: 'custom', slug: 'disabled', enabled: false, careerPageUrl: 'https://disabled.example/careers', probe: { jobPostingJsonLd: true } });
  const ats = normalizeRegistryBoard({ provider: 'workday', tenant: 'co', instance: 'wd1', site: 'External' });
  const config = { boardRegistry: { boards: [custom, unsupported, disabled, ats] }, sources: {} };
  const morning = crawlerDiscoveryPlan(config).sourceCoverage.boards;
  assert.deepEqual(morning.map(({ boardId, state, sourceId }) => [boardId, state, sourceId]), [
    ['custom:supported', 'scheduled', 'structured-career-pages'],
    ['custom:unscheduled', 'unscheduled', null],
    ['custom:disabled', 'disabled', null],
    ['workday:co|wd1|External', 'scheduled', 'ats-enterprise'],
  ]);
  assert.equal(morning[1].reason, 'no-supported-scheduled-adapter');
  assert.equal(crawlerDiscoveryPlan(config, { schedule: 'midday' }).sourceCoverage.boards[3].state, 'excluded-by-schedule');
});

// Current production metadata must name the already wired structured-career owner.
test('retained custom JobPosting boards have explicit structured-career ownership', () => {
  const registry = loadBoardRegistry();
  for (const key of ['custom:botric', 'custom:anantax-technologies']) {
    assert.equal(registry.boards.find(({ id }) => id === key).scheduleLane, 'structuredCareerPages');
  }
});

// Search discovery and missing dedicated adapters are different coverage claims.
test('portal coverage reports configured Cutshort and Peerlist search without inventing adapters', () => {
  const config = { sources: { searxng: { enabled: true, endpoint: 'http://127.0.0.1:8080', queries: ['site:cutshort.io/job backend Pune', 'site:peerlist.io/company AI India'] }, indeed: { enabled: false }, connectorInbox: { enabled: false } } };
  const morning = crawlerDiscoveryPlan(config).sourceCoverage.portalDiscovery;
  for (const name of ['cutshort', 'peerlist']) {
    assert.equal(morning[name].dedicatedAdapter, 'unavailable');
    assert.equal(morning[name].searchDiscovery, 'scheduled');
    assert.equal(crawlerDiscoveryPlan(config, { schedule: 'midday' }).sourceCoverage.portalDiscovery[name].searchDiscovery, 'excluded-by-schedule');
  }
  for (const name of ['naukri', 'foundit', 'hirist', 'indeed']) assert.equal(morning[name].searchDiscovery, 'not-configured');
  assert.equal(morning.indeed.inboxImport, 'disabled');
});

// Rotation applies to enterprise Pune inventory as well as the tracked ATS lane.
test('Pune rotation advances enterprise peers under the same global cap', () => {
  const boards = ['a', 'b'].map((tenant) => normalizeRegistryBoard({ provider: 'workday', tenant, instance: 'wd1', site: 'Careers', puneRelevant: true }));
  const first = planBoundedSources({ boardsByLane: { enterprise: boards }, maxBoards: 1 });
  const second = planBoundedSources({ boardsByLane: { enterprise: boards }, maxBoards: 1, state: first.state });
  assert.equal(first.boardsByLane.enterprise[0].tenant, 'a');
  assert.equal(second.boardsByLane.enterprise[0].tenant, 'b');
});

// Relevance and verification order the priority pool without raising its cap.
test('verified India inventory precedes unverified India and generic inventory', () => {
  const boards = [
    normalizeRegistryBoard({ provider: 'ashby', slug: 'a-warm', indiaRelevant: true, probeStatus: 'warm' }),
    normalizeRegistryBoard({ provider: 'ashby', slug: 'b-verified', indiaRelevant: true, probeStatus: 'verified' }),
    normalizeRegistryBoard({ provider: 'ashby', slug: 'c-global' }),
  ];
  const plan = planBoundedSources({ boardsByLane: { atsWarm: boards }, maxBoards: 1 });
  assert.equal(plan.boardsByLane.atsWarm[0].slug, 'b-verified');
});

// A configured portal query outside the search cap does not imply scheduled coverage.
test('portal coverage exposes query-cap deferrals instead of claiming every query runs', () => {
  const config = { sources: { searxng: { enabled: true, endpoint: 'http://127.0.0.1:8080', dailyBudget: 1,
    queries: ['site:cutshort.io/job Pune', 'site:peerlist.io/company India'] } } };
  const coverage = crawlerDiscoveryPlan(config).sourceCoverage.portalDiscovery;
  assert.equal(coverage.cutshort.searchDiscovery, 'scheduled');
  assert.equal(coverage.peerlist.searchDiscovery, 'deferred-by-query-cap');
});

// Priority rotation must advance when India enterprise supply owns the cap.
test('India enterprise peers rotate through completed planner state', () => {
  const boards = ['a', 'b'].map((tenant) => normalizeRegistryBoard({ provider: 'workday', tenant, instance: 'wd1', site: 'Careers', indiaRelevant: true }));
  let state = {};
  const selected = [];
  for (let day = 0; day < 4; day += 1) {
    const result = planBoundedSources({ boardsByLane: { enterprise: boards }, maxBoards: 1, state });
    selected.push(result.boardsByLane.enterprise[0].tenant);
    state = result.state;
  }
  assert.deepEqual(selected, ['a', 'b', 'a', 'b']);
});

// Use the runtime's first occurrence of case-insensitive duplicates under the query cap.
test('portal query coverage agrees with runtime case-insensitive deduplication', () => {
  const config = { sources: { searxng: { enabled: true, endpoint: 'http://127.0.0.1:8080', dailyBudget: 1,
    queries: ['site:cutshort.io/job Pune', 'SITE:CUTSHORT.IO/JOB Pune', 'site:peerlist.io/company India'] } } };
  const coverage = crawlerDiscoveryPlan(config).sourceCoverage.portalDiscovery;
  assert.equal(coverage.cutshort.searchDiscovery, 'scheduled');
  assert.equal(coverage.cutshort.queryCount, 1);
  assert.equal(coverage.peerlist.searchDiscovery, 'deferred-by-query-cap');
});

// Coverage includes alternate public search lanes using their existing request builders.
test('portal coverage includes India-startup and Brave requests with schedule exclusions', () => {
  const config = { sources: {
    searxng: { enabled: true, endpoint: 'http://127.0.0.1:8080', queries: [] },
    indiaStartup: { enabled: true, queryBudget: 1, dimensionQueryBudget: 0, vcPortfolioLimit: 0,
      requests: [{ id: 'naukri', query: 'site:naukri.com backend Pune' }] },
    brave: { enabled: true, dailyBudget: 1, queries: ['site:foundit.in backend India'] },
  } };
  const morning = crawlerDiscoveryPlan(config).sourceCoverage.portalDiscovery;
  assert.equal(morning.naukri.searchDiscovery, 'scheduled');
  assert.equal(morning.naukri.searchLanes[0].sourceId, 'india-startup');
  assert.equal(morning.foundit.searchDiscovery, 'scheduled');
  const midday = crawlerDiscoveryPlan(config, { schedule: 'midday' }).sourceCoverage.portalDiscovery;
  assert.equal(midday.naukri.searchDiscovery, 'excluded-by-schedule');
  assert.equal(midday.foundit.searchDiscovery, 'excluded-by-schedule');
});

// Higher-ranked Pune selections must not move the cursor of the remaining India pool.
test('mixed priority groups rotate every India peer without reducing Pune priority', () => {
  for (const [puneCount, peerCount, cap] of [[1, 3, 2], [3, 2, 4]]) {
    const pune = Array.from({ length: puneCount }, (_, i) => normalizeRegistryBoard({ provider: 'workday', tenant: `pune${i}`, instance: 'wd1', site: 'Careers', puneRelevant: true, indiaRelevant: true }));
    const peers = Array.from({ length: peerCount }, (_, i) => normalizeRegistryBoard({ provider: 'workday', tenant: `india${i}`, instance: 'wd1', site: 'Careers', indiaRelevant: true }));
    const generic = normalizeRegistryBoard({ provider: 'workday', tenant: 'global', instance: 'wd1', site: 'Careers' });
    let state = {};
    const seen = [];
    for (let day = 0; day < peerCount * 2; day += 1) {
      const plan = planBoundedSources({ boardsByLane: { enterprise: [...pune, ...peers, generic] }, maxBoards: cap, state });
      assert.equal(plan.boardPlan.boardsSelected, cap);
      assert.equal(plan.boardsByLane.enterprise.filter((board) => board.puneRelevant).length, puneCount);
      seen.push(plan.boardsByLane.enterprise.find((board) => !board.puneRelevant).tenant);
      state = plan.state;
    }
    assert.deepEqual(seen, [...peers, ...peers].map((board) => board.tenant));
  }
});

// Generated search dimensions must appear in coverage exactly as they do in request plans.
test('portal coverage includes generated SearXNG queries', () => {
  const coverage = crawlerDiscoveryPlan({ sources: { searxng: {
    enabled: true, endpoint: 'http://127.0.0.1:8080', queries: [], dailyBudget: 2,
    dimensions: { roles: ['AI Engineer'], geographies: ['Pune'], experiences: ['entry level'], ats: ['cutshort.io'], career: [], startup: [], vc: [] },
  } } }).sourceCoverage.portalDiscovery;
  assert.equal(coverage.cutshort.searchDiscovery, 'scheduled');
  assert.equal(coverage.cutshort.queryCount, 1);
});

// The legacy path must also rotate India peers independently of mandatory Pune slots.
test('legacy mixed Pune and India ranking reaches all equal peers with a two-board cap', () => {
  const boards = [
    normalizeRegistryBoard({ provider: 'ashby', slug: 'pune', puneRelevant: true, indiaRelevant: true }),
    ...['india-a', 'india-b'].map((slug) => normalizeRegistryBoard({ provider: 'ashby', slug, indiaRelevant: true })),
    normalizeRegistryBoard({ provider: 'ashby', slug: 'generic' }),
  ];
  let state = {};
  const seen = [];
  for (let day = 0; day < 4; day += 1) {
    const plan = planBoardRotation({ boards, maxBoards: 2, state });
    assert.equal(plan.boards[0].slug, 'pune');
    seen.push(plan.boards[1].slug);
    state = plan.state;
  }
  assert.deepEqual(seen, ['india-a', 'india-b', 'india-a', 'india-b']);
});

// Excluded midday lanes must not consume the cap or advance unexecuted board rotations.
test('midday planner leaves the bounded cap for scheduled ATS lanes', async () => {
  const boards = [
    ...['a', 'b'].map((tenant) => normalizeRegistryBoard({ provider: 'workday', tenant, instance: 'wd1', site: 'Careers', puneRelevant: true })),
    normalizeRegistryBoard({ provider: 'ashby', slug: 'india', indiaRelevant: true }),
  ];
  const config = { boardRegistry: { boards }, sourcePlanner: { enabled: true, maxBoards: 1 }, sources: {} };
  const plans = buildSourcePlans({ config, schedule: 'midday', runAt: '2026-10-13T07:00:00.000Z', transport: async () => ({ status: 200, body: { jobs: [] } }) });
  const result = await plans.find(({ id }) => id === 'ats-warm').fetch();
  assert.equal(result.manifest.boardPlan.boardsSelected, 1);
  assert.deepEqual(result.manifest.boardPlan.decisions.filter(({ action }) => action === 'selected').map(({ boardId }) => boardId), ['ashby:india']);
  assert.equal(result.manifest.boardPlan.decisions.some(({ sourceLane }) => sourceLane === 'enterprise'), false);
});

// Planning accepts the scalar query shape supported by the existing search adapter.
test('portal coverage normalizes scalar SearXNG queries', () => {
  for (const queries of [{ queries: 'site:cutshort.io/job Pune' }, { searchConfig: { queries: 'site:cutshort.io/job Pune' } }]) {
    const coverage = crawlerDiscoveryPlan({ sources: { searxng: { enabled: true, endpoint: 'http://127.0.0.1:8080', ...queries } } }).sourceCoverage.portalDiscovery;
    assert.equal(coverage.cutshort.searchDiscovery, 'scheduled');
    assert.equal(coverage.cutshort.queryCount, 1);
  }
});

// Preserve the enterprise peer cursor while a midday plan excludes that entire lane.
test('midday does not reset morning enterprise rotation state', () => {
  const enterprise = ['a', 'b'].map((tenant) => normalizeRegistryBoard({ provider: 'workday', tenant, instance: 'wd1', site: 'Careers', puneRelevant: true }));
  const warm = [normalizeRegistryBoard({ provider: 'ashby', slug: 'india', indiaRelevant: true })];
  let state = {};
  const seen = [];
  for (let day = 0; day < 4; day += 1) {
    const morning = planBoundedSources({ boardsByLane: { enterprise, atsWarm: warm }, maxBoards: 1, state });
    seen.push(morning.boardsByLane.enterprise[0].tenant);
    state = planBoundedSources({ boardsByLane: { atsWarm: warm }, maxBoards: 1, state: morning.state }).state;
  }
  assert.deepEqual(seen, ['a', 'b', 'a', 'b']);
});
