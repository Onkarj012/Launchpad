import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcePlans, fairPortalResolutionCandidates, runCrawlerOperator } from '../../crawler/operator.mjs';
import { crawlerLaneFixtures } from '../../crawler/daily-runner.mjs';
import { crawlRun, openCrawlerStore } from '../../crawler/run.mjs';
import { createOriginalListingResolver, applyOriginalListingResolution } from '../../crawler/original-listing-resolver.mjs';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { classifyCandidate } from '../../job-pull/eligibility.mjs';
import { loadConfig } from '../../job-pull/config.mjs';
import { applicationReadiness } from '../../job-pull/normal-readiness.mjs';
import { crawlWorkflow } from '../../crawler/workflow.mjs';

test('every configured source has an operator end state, including disabled sources and portal lanes', async () => {
  const store = openCrawlerStore(':memory:');
  try {
    const result = await crawlWorkflow({ store, runId: 'source-end-states', config: {
      sources: { brave: { enabled: false }, careerSites: [] },
    }, sourcePlans: [{ id: 'portal-discovery', fetch: async () => ({
      observations: [{ provider: 'linkedin-jobs', company: 'Fixture', title: 'AI Engineer', location: 'Pune',
        url: 'https://www.linkedin.com/jobs/view/1234567' }],
      manifest: { telemetry: { lanes: [
        { sourceId: 'portal-linkedin-jobs', status: 'ok', fetched: 1 },
        { sourceId: 'portal-instahyre', status: 'empty', fetched: 0 },
      ] } },
    }) }] });
    assert.deepEqual(Object.fromEntries(Object.entries(result.sourceEndStates).map(([id, value]) => [id, value.state])), {
      'portal-discovery': 'ok', 'portal-linkedin-jobs': 'ok', 'portal-instahyre': 'empty',
      'brave-search': 'disabled', 'career-sites': 'empty',
    });
    assert.equal(result.sourceEndStates['brave-search'].reason, 'disabled-in-config');
    assert.deepEqual(result.terminalEnvelope.sourceEndStates, result.sourceEndStates);
    const replay = await crawlWorkflow({ store, runId: 'source-end-states', sourcePlans: [] });
    assert.deepEqual(replay.sourceEndStates, result.sourceEndStates);
  } finally { store.close(); }
});

test('configured portal providers report the explicit disable decision when their parent lane is disabled', async () => {
  const store = openCrawlerStore(':memory:');
  try {
    const result = await runCrawlerOperator({ store, runId: 'disabled-portals', config: {
      schemaVersion: 'LaunchpadCrawlerConfigV1', databasePath: ':memory:',
      sources: { portals: { enabled: false, linkedin: { queries: [{ keywords: 'AI', location: 'Pune' }] } } },
    }, transport: async () => { throw new Error('disabled sources must not fetch'); } });
    assert.deepEqual(result.sourceEndStates['portal-linkedin-jobs'], { state: 'disabled', reason: 'disabled-in-config' });
  } finally { store.close(); }
});

test('source outcomes distinguish failures from empty results and missing configuration', async () => {
  const store = openCrawlerStore(':memory:');
  try {
    const result = await crawlWorkflow({ store, runId: 'source-empty-reasons', config: {
      sources: { careerSites: [], searxng: { enabled: true } },
    }, sourcePlans: [
      { id: 'failed', fetch: async () => { throw new Error('HTTP 503'); } },
      { id: 'zero', fetch: async () => ({ observations: [] }) },
      { id: 'portal-discovery', fetch: async () => ({ observations: [], manifest: { telemetry: { lanes: [
        { sourceId: 'portal-wellfound', status: 'unavailable', reasonCode: 'PORTAL_TRANSPORT_UNAVAILABLE' },
      ] } } }) },
    ] });
    assert.deepEqual(result.sourceEndStates.failed, { state: 'failed', reason: 'HTTP 503' });
    assert.deepEqual(result.sourceEndStates.zero, { state: 'empty', reason: 'no-records-returned' });
    assert.equal(result.sourceEndStates['career-sites'].reason, 'no-career-sites-configured');
    assert.equal(result.sourceEndStates['searxng-search'].reason, 'source-not-planned');
    assert.equal(result.sourceEndStates['portal-wellfound'].reason, 'PORTAL_TRANSPORT_UNAVAILABLE');
    assert.ok(Object.values(result.sourceEndStates).every((value) => value.state !== 'empty' || value.reason));
    assert.equal(result.sourceTelemetry.failed.status, 'failed', 'execution failure remains visible');
  } finally { store.close(); }
});

test('24 bounded candidates give every provider a turn without increasing requests or changing observation order', () => {
  const counts = { 'linkedin-jobs': 74, glassdoor: 26, instahyre: 40, wellfound: 107 };
  const input = Object.entries(counts).flatMap(([provider, count]) => Array.from({ length: count }, (_, jobId) => ({ candidate: { provider, jobId } })));
  const original = structuredClone(input);
  const picked = fairPortalResolutionCandidates(input, 24);
  assert.equal(picked.length, 24);
  for (const provider of Object.keys(counts)) {
    assert.deepEqual(picked.filter((x) => x.candidate.provider === provider).map((x) => x.candidate.jobId), [0, 1, 2, 3, 4, 5]);
  }
  assert.deepEqual(input, original);
  assert.equal(fairPortalResolutionCandidates(input, 0).length, 0);
  assert.equal(fairPortalResolutionCandidates(input.slice(0, 3), 24).length, 3);
});

test('card-only shell stays unresolved; public outbound link plus employer JD supplies evidence and preserves hard gates', async () => {
  const now = '2026-10-02T12:00:00Z';
  const lead = normalizeCandidate({ url: 'https://www.linkedin.com/jobs/view/1234567', company: 'Fixture', title: 'AI Engineer', location: 'Pune', postedAt: now, sourceKind: 'aggregator' });
  const shell = createOriginalListingResolver({ transport: async () => ({ status: 200, body: '<div id="app"></div>' }), runAt: now });
  const unresolved = applyOriginalListingResolution(lead, await shell(lead));
  assert.equal(applicationReadiness(unresolved, classifyCandidate(unresolved, loadConfig())).ready, false);
  const cases = [
    ['Python engineering. Freshers welcome.', 'FULL_TIME', true],
    ['Requires 3+ years of experience.', 'FULL_TIME', false],
    ['Unpaid AI engineering role.', 'FULL_TIME', false],
    ['Python engineering. Freshers welcome.', 'CONTRACTOR', false],
  ];
  for (const [description, employmentType, expectedReady] of cases) {
    const calls = [];
    const resolver = createOriginalListingResolver({ runAt: now, transport: async (url) => {
      calls.push(url);
      return url.includes('linkedin.com') ? { status: 200, body: `<link rel="canonical" href="${lead.canonicalUrl}"><a href="https://jobs.lever.co/fixture/123">Apply on company site</a>` }
        : { status: 200, body: `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'AI Engineer', description, employmentType, datePosted: now,
          hiringOrganization: { name: 'Fixture' }, jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'IN' } } })}</script>` };
    } });
    const row = applyOriginalListingResolution(lead, await resolver(lead));
    assert.equal(calls.length, 2);
    assert.equal(row.description, description);
    assert.equal(applicationReadiness(row, classifyCandidate(row, loadConfig())).ready, expectedReady, description);
  }
});

test('operator rejects transport HTTP 429 and SQLite plus the daily lane bridge retain the failure', async () => {
  const plans = buildSourcePlans({ config: { sources: { portals: { enabled: true, http: { providers: ['linkedin-jobs'] },
    linkedin: { queries: [{ keywords: 'AI', location: 'Pune' }] } } } },
    transport: async () => ({ status: 429, body: '' }), schedule: 'midday', runAt: '2026-10-02T00:00:00Z' });
  const portal = plans.find((x) => x.id === 'portal-discovery');
  const result = await portal.fetch({ runId: '429-persist' });
  assert.equal(result.manifest.status, 'failed');
  assert.equal(result.manifest.failed, 1);
  const store = openCrawlerStore(':memory:');
  try {
    const run = await crawlRun({ store, runId: '429-persist', sourcePlans: [portal] });
    assert.equal(run.telemetry.sources['portal-discovery'].status, 'failed');
    const fixtures = crawlerLaneFixtures({ sourceTelemetry: run.telemetry.sources, observations: [], failures: [] });
    assert.equal(fixtures['portal-linkedin-jobs'].manifest.status, 'failed');
    assert.match(fixtures['portal-linkedin-jobs'].manifest.errors[0], /HTTP 429/);
  } finally { store.close(); }
});

test('daily lane bridge preserves failed empty lanes and partial degraded lanes beside healthy peers', () => {
  const fixture = crawlerLaneFixtures({
    observations: [{ sourceId: 'portal-discovery', source: 'portal-glassdoor', title: 'AI Engineer' }], failures: [],
    sourceTelemetry: { 'portal-discovery': { status: 'succeeded', detail: { telemetry: { lanes: [
      { sourceId: 'portal-linkedin-jobs', attempted: true, status: 'failed', errors: ['HTTP 429'] },
      { sourceId: 'portal-glassdoor', attempted: true, status: 'degraded', errors: ['one query blocked'] },
      { sourceId: 'portal-instahyre', attempted: true, status: 'empty', errors: [] },
      { sourceId: 'portal-wellfound', attempted: false, status: 'unavailable', errors: [] },
    ] } } } },
  });
  assert.equal(fixture['portal-linkedin-jobs'].manifest.status, 'failed');
  assert.equal(fixture['portal-glassdoor'].manifest.status, 'degraded');
  assert.equal(fixture['portal-instahyre'].manifest.status, 'empty');
  assert.equal(fixture['portal-wellfound'], undefined);
});
