import { normalizeCandidate } from '../job-pull/candidate.mjs';
import { isDeadlineCancellation, requestWithDeadline, throwIfNetworkWorkDisallowed } from './deadline.mjs';
import { applyOriginalListingResolution } from './original-listing-resolver.mjs';

export const YC_DISCOVERY_MANIFEST_VERSION = 'YcDiscoveryManifestV1';

// Verified live against https://www.ycombinator.com/jobs/role/all/india on
// 2026-07-24: individual job listings resolve to
// /companies/<slug>/jobs/<jobId>-<title-slug>.
const YC_JOB_PATH = /^\/companies\/([a-z0-9][a-z0-9-]*)\/jobs\/([A-Za-z0-9_-]+)/;
const YC_HOSTS = new Set(['ycombinator.com', 'www.ycombinator.com']);

const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const list = (value) => Array.isArray(value) ? value.map(clean).filter(Boolean) : clean(value) ? [clean(value)] : [];

function canonical(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|source$|ref$)/i.test(key)) url.searchParams.delete(key);
    url.protocol = url.protocol.toLowerCase(); url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    url.pathname = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    return url.toString();
  } catch { return null; }
}
function host(value) { try { return new URL(value).hostname; } catch { return ''; } }
function responseBody(response) {
  if (typeof response?.body === 'string') { try { return JSON.parse(response.body); } catch { return null; } }
  return response?.body ?? response?.json ?? null;
}
function resultRows(body) { return body?.web?.results ?? body?.results ?? (Array.isArray(body) ? body : []); }
function retryableStatus(status) { return [408, 425, 429].includes(status) || status >= 500; }

function humanizeSlug(slug) {
  return slug.split('-').filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(' ');
}

function companyFromTitle(titleText) {
  const match = clean(titleText)?.match(/\bat\s+([A-Z][\w.&' -]{1,60}?)\s*(?:[|–-].*)?$/);
  return clean(match?.[1]);
}

/**
 * Filters raw search-result rows down to real, individual YC job-listing URLs
 * (ycombinator.com/companies/<slug>/jobs/<id>), deduplicated. Non-job YC pages
 * (search/role/company index pages, blog posts, etc.) are dropped.
 */
export function extractYcJobListings(rows = []) {
  const seen = new Set();
  const listings = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = canonical(row?.url ?? row?.link);
    if (!url || !YC_HOSTS.has(host(url))) continue;
    let pathname;
    try { pathname = new URL(url).pathname; } catch { continue; }
    const match = YC_JOB_PATH.exec(pathname);
    if (!match || seen.has(url)) continue;
    seen.add(url);
    listings.push({
      url,
      companySlug: match[1],
      title: clean(row?.title),
      description: clean(row?.description ?? row?.content),
      company: companyFromTitle(row?.title) || humanizeSlug(match[1]),
    });
  }
  return listings;
}

function observationFrom(listing, query, runAt) {
  const candidate = normalizeCandidate({
    url: listing.url,
    company: listing.company || 'Unknown Company',
    title: listing.title || 'Unresolved YC job lead',
    description: listing.description,
    discoveredAt: runAt,
    crawledAt: runAt,
    source: query,
    provider: 'yc-discovery',
    sourceKind: 'aggregator',
    liveness: { status: 'Not Verified', checkedAt: runAt, evidence: 'yc-search-observation' },
    evidence: {
      classification: 'lead',
      sourceQuery: query,
      ycListingUrl: listing.url,
      ycCompanySlug: listing.companySlug,
      companyEvidence: companyFromTitle(listing.title) ? 'yc-listing-title' : 'yc-slug-derived',
      verified: false,
    },
  }, { runAt, provider: 'yc-discovery', sourceCategory: 'startup-board' });
  candidate.classification = 'lead';
  candidate.discoveryUrl = candidate.canonicalUrl;
  return candidate;
}

/**
 * Discovers YC India job leads from already-configured
 * `site:ycombinator.com/jobs` SearXNG queries (see config/crawler-v2.json
 * sources.searxng.queries) through injected search transport, then resolves
 * every discovered listing to its real employer/ATS page via
 * crawler/original-listing-resolver.mjs before it can be treated as direct.
 *
 * Per project policy, a YC listing is never marked ready without resolving to
 * the original employer page: unresolved leads stay classified `lead` and are
 * pushed onto the verification queue instead of being promoted.
 *
 * No built-in network fallback: both `transport` and `resolveOriginalListing`
 * must be injected, matching the contract used by
 * crawler/india-startup-lanes.mjs.
 */
export async function discoverYcJobs({
  transport,
  queries,
  resolveOriginalListing,
  runAt = new Date().toISOString(),
  dailyBudget,
  perQueryResultCap = 10,
  retry = {},
  signal = null,
  deadline = null,
} = {}) {
  if (typeof transport !== 'function') throw new TypeError('discoverYcJobs requires injected transport');
  if (typeof resolveOriginalListing !== 'function') {
    throw new TypeError('discoverYcJobs requires an injected original-listing resolver so no YC lead is marked ready unresolved');
  }
  const configuredQueries = list(queries).filter((query) => /ycombinator\.com\/jobs/i.test(query));
  if (!configuredQueries.length) throw new Error('discoverYcJobs requires at least one site:ycombinator.com/jobs query');
  const budget = Math.max(0, Number(dailyBudget ?? configuredQueries.length));
  const activeQueries = configuredQueries.slice(0, budget);
  const observations = [];
  const verificationQueue = [];
  const receipts = [];
  const seen = new Set();
  const telemetry = {
    queriesGenerated: configuredQueries.length, budgetRequested: budget, budgetUsed: 0,
    resultCount: 0, duplicateResults: 0, extracted: 0, resolved: 0, unresolved: 0,
    malformedResponses: 0, retryable: 0, terminal: 0,
  };
  const maxAttempts = Math.max(1, Number(retry.maxAttempts ?? 1));

  for (const query of activeQueries) {
    try { throwIfNetworkWorkDisallowed(signal, deadline); } catch { break; }
    telemetry.budgetUsed += 1;
    let response; let outcome = 'terminal'; let reason = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try { response = await requestWithDeadline(transport, query, { endpoint: 'yc-discovery', runAt, attempt }, { signal, deadline }); }
      catch (error) {
        reason = error?.message || 'transport-error';
        if (isDeadlineCancellation(error, signal, deadline)) { outcome = 'interrupted'; break; }
        if (error?.retryable && attempt < maxAttempts) continue;
        outcome = error?.retryable ? 'retryable' : 'terminal';
        break;
      }
      const status = Number(response?.status ?? 200);
      if (status >= 200 && status < 300) { outcome = 'success'; break; }
      reason = `http-${status}`;
      if (retryableStatus(status) && attempt < maxAttempts) continue;
      outcome = retryableStatus(status) ? 'retryable' : 'terminal';
      break;
    }
    if (outcome === 'interrupted') break;
    if (outcome !== 'success') {
      telemetry[outcome] += 1;
      receipts.push({ query, status: outcome, reason });
      continue;
    }
    const body = responseBody(response);
    const rows = body ? resultRows(body) : null;
    if (!Array.isArray(rows)) {
      telemetry.malformedResponses += 1;
      receipts.push({ query, status: 'malformed', reason: 'results-not-array' });
      continue;
    }
    telemetry.resultCount += Math.min(rows.length, perQueryResultCap);
    const listings = extractYcJobListings(rows.slice(0, perQueryResultCap));
    let extractedForQuery = 0;
    for (const listing of listings) {
      try { throwIfNetworkWorkDisallowed(signal, deadline); } catch { outcome = 'interrupted'; break; }
      if (seen.has(listing.url)) { telemetry.duplicateResults += 1; continue; }
      seen.add(listing.url);
      let observation = observationFrom(listing, query, runAt);
      telemetry.extracted += 1; extractedForQuery += 1;
      let resolution;
      try { resolution = await resolveOriginalListing(observation, { signal, deadline }); }
      catch (error) { resolution = { status: 'verification', evidence: { resolver: 'yc-discovery', reason: error?.message || 'resolver-error' } }; }
      observation = applyOriginalListingResolution(observation, resolution);
      if (observation.classification === 'direct') {
        telemetry.resolved += 1;
      } else {
        telemetry.unresolved += 1;
        observation.classification = 'lead';
        verificationQueue.push({
          url: observation.canonicalUrl,
          company: observation.company,
          ycUrl: listing.url,
          reason: 'original-listing',
          evidence: observation.evidence,
        });
      }
      observations.push(observation);
    }
    if (outcome === 'interrupted') break;
    receipts.push({ query, status: 'succeeded', results: Math.min(rows.length, perQueryResultCap), extracted: extractedForQuery });
  }

  return {
    observations,
    verificationQueue,
    receipts,
    manifest: {
      schemaVersion: YC_DISCOVERY_MANIFEST_VERSION,
      runAt,
      queries: activeQueries,
      telemetry,
      noAutoApply: true,
    },
    telemetry,
  };
}

export default discoverYcJobs;
