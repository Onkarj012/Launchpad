import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VC_PORTFOLIO_WATCHLIST_SCHEMA_VERSION,
  parseVcPortfolioWatchlist,
  loadVcPortfolioWatchlist,
  buildVcWatchlistRequests,
  runVcFundingWatch,
  runVcFundingWatchFiles,
} from '../../crawler/vc-portfolio-watchlist.mjs';
import { emptyRegistry, loadBoardRegistry, saveBoardRegistry } from '../../crawler/board-registry.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Supplies a dated announcement and an employer-owned ATS route for weekly intake.
function fundingEvent(overrides = {}) {
  return {
    company: 'Composio', fundedAt: '2026-10-07',
    sourceUrl: 'https://composio.dev/blog/series-b',
    board: { provider: 'ashby', slug: 'composio', url: 'https://jobs.ashbyhq.com/composio', sourceUrl: 'https://composio.dev/careers' },
    ...overrides,
  };
}

// Returns a real-shaped public Ashby job board without accessing the network.
async function boardTransport() {
  return { status: 200, body: { jobs: [
    { id: '1', title: 'Backend Engineer', location: 'Pune, India', jobUrl: 'https://jobs.ashbyhq.com/composio/1', descriptionPlain: 'Full-time backend role, 0-1 years required.', publishedAt: '2026-10-08T01:00:00Z', employmentType: 'FullTime' },
    { id: '2', title: 'Senior Engineer', location: 'New York, United States', jobUrl: 'https://jobs.ashbyhq.com/composio/2' },
  ] } };
}

test('parses and flattens a valid watchlist into company/fund evidence rows', () => {
  const parsed = parseVcPortfolioWatchlist({
    schemaVersion: VC_PORTFOLIO_WATCHLIST_SCHEMA_VERSION,
    funds: [
      {
        fund: 'Peak XV Partners',
        sourceUrl: 'https://www.peakxv.com/our-companies',
        verifiedAt: '2026-07-24',
        companies: [{ name: 'CRED' }, { name: 'Razorpay' }],
      },
      {
        fund: 'Accel',
        sourceUrl: 'https://www.accel.com/relationships',
        verifiedAt: '2026-07-24',
        companies: [{ name: 'Bizongo' }],
      },
    ],
  });

  assert.equal(parsed.companies.length, 3);
  assert.deepEqual(parsed.companies[0], {
    company: 'CRED', fund: 'Peak XV Partners', fundSourceUrl: 'https://www.peakxv.com/our-companies', verifiedAt: '2026-07-24',
  });
  assert.equal(parsed.companies[2].fund, 'Accel');
});

test('rejects a watchlist with the wrong schema version or a missing funds array', () => {
  assert.throws(() => parseVcPortfolioWatchlist({ schemaVersion: 'wrong', funds: [] }), /schemaVersion must be/);
  assert.throws(() => parseVcPortfolioWatchlist({ schemaVersion: VC_PORTFOLIO_WATCHLIST_SCHEMA_VERSION }), /funds must be an array/);
});

test('loads and parses the real, live-verified project watchlist file', () => {
  const watchlist = loadVcPortfolioWatchlist('config/vc-portfolio-watchlist.json');
  assert.ok(watchlist.companies.length > 0);
  assert.ok(watchlist.funds.length >= 5);
  for (const entry of watchlist.companies) {
    assert.ok(entry.company);
    assert.ok(entry.fund);
    assert.ok(entry.fundSourceUrl);
  }
});

test('builds bounded vc-lane requests that target employer ATS hosts, never the fund page itself', () => {
  const watchlist = parseVcPortfolioWatchlist({
    schemaVersion: VC_PORTFOLIO_WATCHLIST_SCHEMA_VERSION,
    funds: [{
      fund: 'Blume Ventures', sourceUrl: 'https://blume.vc/portfolio', verifiedAt: '2026-07-24',
      companies: [{ name: 'Classplus' }, { name: 'Exotel' }, { name: 'Instamojo' }],
    }],
  });

  const requests = buildVcWatchlistRequests(watchlist, { limit: 2 });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.id, 'vc');
    assert.ok(request.query.includes('site:boards.greenhouse.io'));
    assert.ok(!request.query.includes('blume.vc'));
    assert.equal(request.evidence.watchlistOnly, true);
  }
  assert.match(requests[0].query, /"Classplus"/);
});

test('Lightspeed is present and Antler/a16z are empty, clearly-unverified placeholder funds', () => {
  const watchlist = loadVcPortfolioWatchlist('config/vc-portfolio-watchlist.json');
  const byFund = Object.fromEntries(watchlist.funds.map((fund) => [fund.fund, fund]));

  assert.ok(byFund['Lightspeed India Partners'], 'Lightspeed fund entry must exist');
  assert.ok(Array.isArray(byFund['Lightspeed India Partners'].companies));

  for (const name of ['Antler', 'a16z']) {
    assert.ok(byFund[name], `${name} fund entry must exist`);
    assert.deepEqual(byFund[name].companies, []);
    assert.match(
      String(byFund[name].verificationMethod || ''),
      /not yet verified|requires live portfolio-page fetch/i,
    );
  }

  // Placeholder funds must not invent flat company rows.
  assert.equal(watchlist.companies.filter((row) => row.fund === 'Antler').length, 0);
  assert.equal(watchlist.companies.filter((row) => row.fund === 'a16z').length, 0);
});

test('India-focused funds retain portfolio and employer board evidence for weekly intake', () => {
  const watchlist = loadVcPortfolioWatchlist();
  assert.ok(watchlist.funds.some((fund) => fund.fund === 'Nexus Venture Partners' && fund.indiaFocused));
  assert.ok(watchlist.funds.some((fund) => fund.fund === 'Together Fund' && fund.indiaFocused));
  const company = watchlist.companies.find((row) => row.company === 'Composio');
  assert.deepEqual(company.board, {
    provider: 'ashby', slug: 'composio', url: 'https://jobs.ashbyhq.com/composio',
    sourceUrl: 'https://composio.dev/careers', verifiedAt: '2026-10-08',
  });
  assert.equal(buildVcWatchlistRequests([company])[0].evidence.board.url, 'https://jobs.ashbyhq.com/composio');
});

test('weekly intake adds recent funding once, holds bad evidence, and leaves existing registry entries untouched', async () => {
  const registry = emptyRegistry();
  const snapshot = structuredClone(registry);
  const events = [fundingEvent(), fundingEvent(), fundingEvent({ fundedAt: '2026-09-01' }),
    fundingEvent({ fundedAt: '2026-10-09' }), fundingEvent({ sourceUrl: null }),
    fundingEvent({ fundedAt: '2026-99-99' }), fundingEvent({ fundedAt: '2026-02-30' }),
    fundingEvent({ board: { provider: 'ashby', slug: 'other', url: 'https://jobs.ashbyhq.com/composio' } })];
  const result = await runVcFundingWatch({ registry, fundingEvents: events, runAt: '2026-10-08T07:45:00+05:30', transport: boardTransport });
  assert.equal(result.added.length, 1);
  assert.equal(result.registry.boards[0].company, 'Composio');
  assert.equal(result.registry.boards[0].enabled, false);
  assert.equal(result.registry.boards[0].activationState, 'proposed');
  assert.equal(result.registry.boards[0].startupTagged, true);
  assert.equal(result.held.length, 6);
  assert.deepEqual(registry, snapshot);
  const replay = await runVcFundingWatch({ registry: result.registry, state: result.state, fundingEvents: events,
    runAt: '2026-10-09T07:45:00+05:30', transport: async () => assert.fail('weekly replay must not probe') });
  assert.equal(replay.weeklyDue, false);
  assert.equal(replay.added.length, 0);
  assert.deepEqual(replay.registry, result.registry);
  const nextWeek = await runVcFundingWatch({ registry: result.registry, state: result.state,
    fundingEvents: [fundingEvent({ fundedAt: '2026-10-14' })], runAt: '2026-10-15T07:45:00+05:30', transport: boardTransport });
  assert.equal(nextWeek.weeklyDue, true);
  assert.equal(nextWeek.added.length, 0);
  assert.deepEqual(nextWeek.registry.boards, result.registry.boards);
});

test('new boards retain one public GET probe, real location counts, and failed probes across registry reload', async (t) => {
  const requests = [];
  const result = await runVcFundingWatch({ registry: emptyRegistry(), runAt: '2026-10-08T07:45:00+05:30',
    fundingEvents: [fundingEvent(), fundingEvent({ company: 'Other', board: {
      provider: 'lever', slug: 'other', url: 'https://jobs.lever.co/other', sourceUrl: 'https://other.example/careers',
    } })], transport: async (url, options) => {
      requests.push({ url, method: options.method });
      if (url.includes('lever.co')) return { status: 429, body: {} };
      const response = await boardTransport();
      response.body.jobs.push({ location: 'Bengaluru, India' });
      return response;
    } });
  assert.deepEqual(requests, [
    { url: 'https://api.ashbyhq.com/posting-api/job-board/composio?includeCompensation=true', method: 'GET' },
    { url: 'https://api.lever.co/v0/postings/other', method: 'GET' },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  saveBoardRegistry(path.join(dir, 'registry.json'), result.registry);
  const registry = loadBoardRegistry(path.join(dir, 'registry.json'));
  const board = registry.boards.find((row) => row.company === 'Composio');
  assert.equal(board.indiaRelevant, true);
  assert.equal(board.puneRelevant, true);
  assert.equal(board.probeStatus, 'verified');
  assert.equal(board.probe.jobCount, 3);
  assert.equal(board.probe.indiaJobCount, 2);
  assert.equal(board.probe.sourceUrl, requests[0].url);
  assert.equal(board.probe.puneJobCount, 1);
  assert.equal(board.probe.checkedAt, '2026-10-08T07:45:00+05:30');
  assert.equal(board.probe.foundVia, 'https://composio.dev/blog/series-b');
  const failed = registry.boards.find((row) => row.company === 'Other');
  assert.equal(failed.probe.status, 'Not Verified');
  assert.equal(failed.probe.jobCount, null);
  assert.equal(failed.probe.reason, 'HTTP_429');
  assert.equal(failed.enabled, false);
});

test('one-week report attributes daily yield to watched boards, deduplicates runs, and waits for all seven IST dates', async () => {
  const first = await runVcFundingWatch({ registry: emptyRegistry(), fundingEvents: [fundingEvent()],
    runAt: '2026-10-08T07:45:00+05:30', transport: boardTransport });
  const runs = Array.from({ length: 7 }, (_, index) => ({
    runId: `day-${index}`, runAt: `2026-10-${String(8 + index).padStart(2, '0')}T07:45:00+05:30`,
    sourceYield: { schemaVersion: 'LaunchpadSourceYieldV1', sources: [
      { sourceId: 'ashby:composio', fetched: 4, indiaBased: 2, applicationReady: index === 0 ? 1 : 0 },
      { sourceId: 'ashby:unrelated', fetched: 100, indiaBased: 100, applicationReady: 100 },
    ] },
  }));
  const partial = await runVcFundingWatch({ registry: first.registry, state: first.state,
    dailyRuns: runs.slice(0, 6), runAt: '2026-10-14T13:15:00+05:30' });
  assert.equal(partial.yieldReport.status, 'incomplete');
  assert.equal(partial.yieldReport.decision, 'pending');
  const complete = await runVcFundingWatch({ registry: first.registry, state: first.state,
    fundingEvents: [fundingEvent({ company: 'Second week', fundedAt: '2026-10-14', board: {
      provider: 'ashby', slug: 'second', url: 'https://jobs.ashbyhq.com/second', sourceUrl: 'https://second.example/careers',
    } })], transport: boardTransport,
    dailyRuns: [...runs, runs[0], { ...runs[0], runId: 'outside', runAt: '2026-10-08T00:00:00+10:00' }],
    runAt: '2026-10-15T07:45:00+05:30' });
  assert.equal(complete.yieldReport.status, 'complete');
  assert.equal(complete.yieldReport.decision, 'keep');
  assert.equal(complete.yieldReport.daysObserved, 7);
  assert.equal(complete.yieldReport.totals.fetched, 28);
  assert.equal(complete.yieldReport.totals.indiaBased, 14);
  assert.equal(complete.yieldReport.totals.applicationReady, 1);
  assert.equal(complete.yieldReport.probeRequests, 1);
  assert.equal(complete.added.length, 1);
  const empty = await runVcFundingWatch({ registry: first.registry, state: first.state,
    dailyRuns: runs.map((run) => ({ ...run, sourceYield: { ...run.sourceYield, sources: [{ sourceId: 'ashby:composio', fetched: 4, applicationReady: 0 }] } })),
    runAt: '2026-10-15T07:45:00+05:30' });
  assert.equal(empty.yieldReport.decision, 'drop');
  const missingBoard = await runVcFundingWatch({ registry: first.registry,
    state: { ...first.state, boardIds: ['ashby:composio', 'lever:missing'] }, dailyRuns: runs,
    runAt: '2026-10-14T13:15:00+05:30' });
  assert.equal(missingBoard.yieldReport.daysObserved, 0);
  assert.equal(missingBoard.yieldReport.decision, 'pending');
});

test('local weekly command persists registry, replay state and yield report without requiring network on replay', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-weekly-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'input.json');
  const registryPath = path.join(dir, 'registry.json');
  const statePath = path.join(dir, 'state.json');
  const reportPath = path.join(dir, 'report.json');
  const watchlistPath = path.join(dir, 'watchlist.json');
  fs.writeFileSync(inputPath, JSON.stringify({ fundingEvents: [fundingEvent()], dailyRuns: [] }));
  fs.writeFileSync(watchlistPath, JSON.stringify({ schemaVersion: VC_PORTFOLIO_WATCHLIST_SCHEMA_VERSION, funds: [] }));
  saveBoardRegistry(registryPath, emptyRegistry());
  const options = { inputPath, registryPath, statePath, reportPath, watchlistPath, runAt: '2026-10-08T07:45:00+05:30' };
  await runVcFundingWatchFiles({ ...options, transport: boardTransport });
  assert.equal(loadBoardRegistry(registryPath).boards.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(reportPath)).yieldReport.status, 'incomplete');
  assert.equal(JSON.parse(fs.readFileSync(statePath)).probeRequests, 1);
  const before = fs.readFileSync(registryPath, 'utf8');
  await runVcFundingWatchFiles({ ...options, runAt: '2026-10-09T07:45:00+05:30', transport: async () => assert.fail('not due') });
  assert.equal(fs.readFileSync(registryPath, 'utf8'), before);
});
