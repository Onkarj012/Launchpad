import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VC_PORTFOLIO_WATCHLIST_SCHEMA_VERSION,
  parseVcPortfolioWatchlist,
  loadVcPortfolioWatchlist,
  buildVcWatchlistRequests,
} from '../../crawler/vc-portfolio-watchlist.mjs';

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
