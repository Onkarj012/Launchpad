import fs from 'node:fs';
import path from 'node:path';

export const VC_PORTFOLIO_WATCHLIST_SCHEMA_VERSION = 'VcPortfolioWatchlistV1';

const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateWatchlist(payload) {
  const errors = [];
  if (!isObject(payload)) return ['watchlist must be an object'];
  if (payload.schemaVersion !== VC_PORTFOLIO_WATCHLIST_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${VC_PORTFOLIO_WATCHLIST_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(payload.funds)) errors.push('funds must be an array');
  return errors;
}

/**
 * Flattens the operator-curated, live-verified VC portfolio watchlist into a
 * `{ company, fund, fundSourceUrl, verifiedAt }` list. This function performs
 * no network access; it only reshapes already-loaded, already-verified data.
 * The watchlist itself (config/vc-portfolio-watchlist.json) exists to
 * prioritize which employer career/ATS pages get checked — it is never used
 * as a job-data source and a VC's own marketing page is never scraped for
 * postings.
 */
export function parseVcPortfolioWatchlist(payload) {
  const errors = validateWatchlist(payload);
  if (errors.length) throw new Error(`invalid VC portfolio watchlist: ${errors.join('; ')}`);
  const companies = [];
  for (const fund of payload.funds) {
    const fundName = clean(fund?.fund);
    const fundSourceUrl = clean(fund?.sourceUrl);
    const fundVerifiedAt = clean(fund?.verifiedAt);
    if (!fundName || !Array.isArray(fund?.companies)) continue;
    for (const entry of fund.companies) {
      const name = clean(typeof entry === 'string' ? entry : entry?.name);
      if (!name) continue;
      companies.push({
        company: name,
        fund: fundName,
        fundSourceUrl,
        verifiedAt: clean(entry?.verifiedAt) || fundVerifiedAt,
      });
    }
  }
  return { schemaVersion: VC_PORTFOLIO_WATCHLIST_SCHEMA_VERSION, companies, funds: payload.funds };
}

/** Reads and parses the watchlist file. The only filesystem I/O in this module. */
export function loadVcPortfolioWatchlist(file = 'config/vc-portfolio-watchlist.json') {
  const resolved = path.resolve(file);
  const payload = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return parseVcPortfolioWatchlist(payload);
}

/**
 * Builds bounded `vc`-lane requests (matching `INDIA_STARTUP_LANES.vc` from
 * crawler/india-startup-lanes.mjs) that seed a search for each watchlisted
 * company's own employer/ATS career page. The query deliberately targets
 * known ATS hosts and never the VC's portfolio page itself, so this can
 * never become a source of fabricated or VC-marketing-derived job data —
 * every result still needs original-listing resolution and the normal
 * eligibility gates like any other lead.
 */
export function buildVcWatchlistRequests(watchlist, { limit } = {}) {
  const companies = Array.isArray(watchlist?.companies)
    ? watchlist.companies
    : Array.isArray(watchlist) ? watchlist : [];
  const bounded = limit != null ? companies.slice(0, Math.max(0, Number(limit))) : companies;
  return bounded
    .filter((entry) => clean(entry?.company))
    .map((entry) => ({
      id: 'vc',
      query: `"${entry.company}" careers (site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com OR site:apply.workable.com) India`,
      evidence: {
        company: entry.company,
        fund: entry.fund,
        fundSourceUrl: entry.fundSourceUrl,
        verifiedAt: entry.verifiedAt,
        watchlistOnly: true,
      },
    }));
}

export default loadVcPortfolioWatchlist;
