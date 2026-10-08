import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPromotionProposals, loadBoardRegistry, normalizeRegistryBoard, saveBoardRegistry } from './board-registry.mjs';
import { fetchWarmAts } from './ats-warm.mjs';
import { buildSourceYieldReport } from './source-yield.mjs';
import { classifyGeo } from '../job-pull/eligibility.mjs';
import { loadConfig } from '../job-pull/config.mjs';

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
        ...(isObject(entry?.board) ? { board: { ...entry.board } } : {}),
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
        ...(entry.board ? { board: { ...entry.board } } : {}),
      },
    }));
}

// Converts an instant to its calendar date in IST for the weekly cadence.
function istDay(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time + 19_800_000).toISOString().slice(0, 10) : null;
}

// Accepts public HTTPS evidence URLs without credentials.
function publicUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

// Checks that an employer board URL names the supplied supported ATS tenant.
function verifiedBoard(entry) {
  const board = entry?.board;
  const hosts = { ashby: 'jobs.ashbyhq.com', lever: 'jobs.lever.co', greenhouse: 'boards.greenhouse.io' };
  const url = publicUrl(board?.url);
  const sourceUrl = publicUrl(board?.sourceUrl);
  if (!clean(entry?.company) || !url || !sourceUrl || !hosts[board?.provider] || !/^[\w-]+$/.test(board?.slug || '')) return null;
  const parsed = new URL(url);
  const hostMatches = parsed.hostname === hosts[board.provider]
    || board.provider === 'greenhouse' && parsed.hostname === 'job-boards.greenhouse.io';
  if (!hostMatches || parsed.pathname.replace(/\/$/, '') !== `/${board.slug}`) return null;
  return normalizeRegistryBoard({ provider: board.provider, slug: board.slug, url, company: entry.company,
    startupTagged: true, enabled: false, activationState: 'proposed', probeStatus: 'proposed',
    evidenceRef: [entry.sourceUrl, sourceUrl].filter(Boolean).join('; ') });
}

// Summarizes retained daily source funnels for the trial's seven IST calendar dates.
function trialYield(state, dailyRuns, runAt) {
  const startDay = istDay(state.trialStartedAt);
  const endDay = new Date(Date.parse(startDay) + 7 * 86_400_000).toISOString().slice(0, 10);
  const summaries = new Map((state.dailyYield || []).map((run) => [run.runId, run]));
  const boardIds = new Set(state.boardIds || []);
  for (const run of dailyRuns) {
    const runId = clean(run?.runId || run?.run?.run_id);
    const day = istDay(run?.runAt || run?.startedAt || run?.run?.started_at);
    if (!runId || !day || day < startDay || day >= endDay || day > istDay(runAt) || summaries.has(runId)) continue;
    const rows = (run.sourceYield?.sources || []).filter((row) => boardIds.has(row.sourceId));
    if (!boardIds.size || [...boardIds].some((id) => !rows.some((row) => row.sourceId === id))
      || rows.some((row) => !Number.isInteger(row.applicationReady) || row.applicationReady < 0)) continue;
    summaries.set(runId, { runId, day, sources: rows.map(({ sourceId, fetched, indiaBased, applicationReady }) => ({
      sourceId, fetched: Number.isFinite(fetched) && fetched >= 0 ? fetched : null,
      indiaBased: Number.isFinite(indiaBased) && indiaBased >= 0 ? indiaBased : null, applicationReady,
    })) });
  }
  const days = new Set();
  const sources = new Map();
  for (const run of summaries.values()) {
    days.add(run.day);
    for (const row of run.sources) {
      const total = sources.get(row.sourceId) || { sourceId: row.sourceId, fetched: 0, indiaBased: 0, applicationReady: 0 };
      for (const field of ['fetched', 'indiaBased', 'applicationReady']) total[field] = total[field] === null || row[field] === null ? null : total[field] + row[field];
      sources.set(row.sourceId, total);
    }
  }
  const totals = { fetched: 0, indiaBased: 0, applicationReady: 0 };
  for (const row of sources.values()) for (const field of Object.keys(totals)) totals[field] = totals[field] === null || row[field] === null ? null : totals[field] + row[field];
  const complete = days.size === 7 && istDay(runAt) >= endDay;
  return { dailyYield: [...summaries.values()], report: {
    schemaVersion: 'VcFundingTrialYieldV1', timezone: 'Asia/Kolkata', startDay, endDayExclusive: endDay,
    status: complete ? 'complete' : 'incomplete', daysObserved: days.size,
    missingDays: Array.from({ length: 7 }, (_, index) => new Date(Date.parse(startDay) + index * 86_400_000).toISOString().slice(0, 10)).filter((day) => !days.has(day)),
    sources: [...sources.values()], totals, probeRequests: state.probeRequests || 0,
    decision: complete ? totals.applicationReady > 0 ? 'keep' : 'drop' : 'pending',
    automaticDecision: false,
  } };
}

// Adds evidenced funding and portfolio boards as proposals once per seven IST dates.
export async function runVcFundingWatch({ registry, fundingEvents = [], watchlist = null, state = {}, dailyRuns = [], transport, runAt = new Date().toISOString() } = {}) {
  const day = istDay(runAt);
  if (!day) throw new TypeError('funding watch requires a valid runAt');
  if (!Array.isArray(fundingEvents)) throw new TypeError('fundingEvents must be an array');
  if (!Array.isArray(dailyRuns)) throw new TypeError('dailyRuns must be an array');
  const nextState = { ...state, trialStartedAt: state.trialStartedAt || runAt };
  const lastDay = istDay(state.lastWeeklyAt);
  const weeklyDue = !lastDay || Date.parse(day) - Date.parse(lastDay) >= 7 * 86_400_000;
  if (!weeklyDue) {
    const yieldResult = trialYield(nextState, dailyRuns, runAt);
    return { registry, state: { ...nextState, dailyYield: yieldResult.dailyYield }, yieldReport: yieldResult.report, added: [], held: [], weeklyDue };
  }
  const proposals = [];
  const held = [];
  for (const event of fundingEvents) {
    const fundedAt = clean(event?.fundedAt);
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(fundedAt || '')
      && Number.isFinite(Date.parse(fundedAt))
      && new Date(fundedAt).toISOString().slice(0, 10) === fundedAt;
    const ageDays = validDate ? (Date.parse(day) - Date.parse(fundedAt)) / 86_400_000 : NaN;
    const board = verifiedBoard(event);
    if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays >= 7 || !publicUrl(event?.sourceUrl) || !board) {
      held.push({ company: clean(event?.company), reason: 'funding-or-board-evidence-not-verified' });
      continue;
    }
    proposals.push(board);
  }
  for (const company of watchlist?.companies || []) {
    const board = verifiedBoard({ ...company, sourceUrl: company.fundSourceUrl });
    if (board && company.verifiedAt) proposals.push(board);
  }
  const result = applyPromotionProposals(registry, proposals, { runAt });
  const policy = loadConfig();
  for (const board of result.added) {
    let sourceUrl = null;
    let locations = [];
    const fetched = await fetchWarmAts({ boards: [board], runAt,
      transport: async (url, options) => {
        sourceUrl = url;
        const response = await transport(url, options);
        if (response.status >= 200 && response.status < 300) {
          const body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
          const rows = board.provider === 'lever' ? body : body?.jobs;
          if (Array.isArray(rows)) locations = rows.map((row) => ({ location:
            board.provider === 'greenhouse' ? row?.location?.name : board.provider === 'lever' ? row?.categories?.location : row?.location }));
        }
        return response;
      }, maxJobsPerBoard: 0, maxDetailRequests: 0 });
    const source = fetched.manifest.sources[0];
    const puneJobCount = locations.filter((job) => classifyGeo({ location: job.location, workMode: 'onsite' }, policy).pass).length;
    const indiaJobCount = buildSourceYieldReport(locations).totals.indiaBased;
    board.probedAt = runAt;
    board.probeStatus = source ? 'verified' : 'failed';
    board.puneRelevant = Boolean(source && puneJobCount > 0);
    board.indiaRelevant = Boolean(source && (indiaJobCount > 0 || puneJobCount > 0));
    board.probe = {
      checkedAt: runAt, foundVia: board.evidenceRef.split('; ')[0], method: 'GET', sourceUrl,
      status: source ? 'verified' : 'Not Verified',
      jobCount: source?.fetched ?? null, indiaJobCount: source ? indiaJobCount : null,
      puneJobCount: source ? puneJobCount : null,
      reason: fetched.failures[0]?.code ?? null,
    };
  }
  nextState.lastWeeklyAt = runAt;
  const withinTrial = Date.parse(day) - Date.parse(istDay(nextState.trialStartedAt)) < 7 * 86_400_000;
  nextState.boardIds = [...new Set([...(state.boardIds || []), ...(withinTrial ? result.added.map((board) => board.id) : [])])];
  nextState.probeRequests = (state.probeRequests || 0) + (withinTrial ? result.added.length : 0);
  const yieldResult = trialYield(nextState, dailyRuns, runAt);
  return { ...result, held, weeklyDue, yieldReport: yieldResult.report, state: { ...nextState, dailyYield: yieldResult.dailyYield } };
}

// Runs the weekly intake and writes only the caller's local registry, state and report files.
export async function runVcFundingWatchFiles({ inputPath, registryPath, statePath, reportPath,
  watchlistPath = 'config/vc-portfolio-watchlist.json', transport, runAt } = {}) {
  if (![inputPath, registryPath, statePath, reportPath].every(clean)) throw new TypeError('input, registry, state and report paths are required');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (!isObject(input) || !Array.isArray(input.fundingEvents) || !Array.isArray(input.dailyRuns)) throw new TypeError('input requires fundingEvents and dailyRuns arrays');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  const result = await runVcFundingWatch({ ...input, registry: loadBoardRegistry(registryPath), state,
    watchlist: loadVcPortfolioWatchlist(watchlistPath), transport, runAt });
  if (result.added.length) saveBoardRegistry(registryPath, result.registry);
  for (const [file, payload] of [[statePath, result.state], [reportPath, {
    schemaVersion: 'VcFundingWatchReportV1', runAt: runAt || new Date().toISOString(),
    weeklyDue: result.weeklyDue, added: result.added, held: result.held, yieldReport: result.yieldReport,
  }]]) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  }
  return result;
}

// Exposes a manual local command; scheduling and live tracker writes are outside this command.
async function main(args) {
  if (args[0] !== 'weekly') throw new Error('usage: node crawler/vc-portfolio-watchlist.mjs weekly --input FILE --registry FILE --state FILE --report FILE [--watchlist FILE] [--run-at ISO]');
  const option = (name) => args[args.indexOf(name) + 1];
  const required = ['--input', '--registry', '--state', '--report'];
  if (required.some((name) => !args.includes(name) || !option(name) || option(name).startsWith('--'))) throw new Error('weekly requires --input, --registry, --state and --report');
  const { defaultHttpTransport } = await import('./operator.mjs');
  const result = await runVcFundingWatchFiles({ inputPath: option('--input'), registryPath: option('--registry'),
    statePath: option('--state'), reportPath: option('--report'),
    watchlistPath: args.includes('--watchlist') ? option('--watchlist') : undefined,
    runAt: args.includes('--run-at') ? option('--run-at') : undefined, transport: defaultHttpTransport });
  process.stdout.write(`${JSON.stringify({ added: result.added.length, held: result.held.length, trial: result.yieldReport.status })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

export default loadVcPortfolioWatchlist;
