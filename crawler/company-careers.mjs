import { fetchIncrementally } from './incremental-fetch.mjs';
import { createHostLimiter, parseRobotsTxt } from './http-policy.mjs';
import { normalizeCandidate } from '../job-pull/candidate.mjs';

const CAREER_RE = /(?:career|careers|jobs|job|work[- ]?with[- ]?us|join[- ]?us|opportunit)/i;
const BOARD_RE = /(?:greenhouse|lever|ashby|workday|workable|smartrecruiters|breezy|recruitee|boards?\.|jobs?\.)/i;
const XML_RE = /(?:\.xml(?:$|[?#])|sitemap|\.rss(?:$|[?#])|\.atom(?:$|[?#]))/i;

function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function absolute(value, base) { try { return new URL(value, base).toString(); } catch { return null; } }
function canonical(value) {
  const url = absolute(value, 'https://invalid.example');
  if (!url || url.startsWith('https://invalid.example')) return null;
  const parsed = new URL(url);
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|source$|ref$)/i.test(key)) parsed.searchParams.delete(key);
  parsed.protocol = parsed.protocol.toLowerCase(); parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) parsed.port = '';
  parsed.pathname = parsed.pathname.replace(/\/+/g, '/');
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/$/, '');
  return parsed.toString();
}
function host(value) { try { return new URL(value).hostname; } catch { return ''; } }
function sameSite(a, b) { return host(a) === host(b); }
function parseDate(value) { const n = value == null ? NaN : Date.parse(String(value)); return Number.isNaN(n) ? null : new Date(n).toISOString(); }
function titleFromUrl(url) { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'Open role').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
function bodyOf(response) { return typeof response?.body === 'string' ? response.body : ''; }
function attr(tag, name) { return tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)`, 'i'))?.[1] ?? null; }

function linksFromHtml(body, base) {
  return [...String(body).matchAll(/<(?:a|link)\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((m) => absolute(m[1], base)).filter(Boolean);
}

function jsonLdBlocks(body) {
  const blocks = [];
  for (const match of String(body).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { blocks.push(JSON.parse(match[1].trim())); } catch { blocks.push({ __malformed: true }); }
  }
  return blocks;
}
function jobPostingNodes(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(jobPostingNodes);
  if (value.__malformed) return [];
  const own = String(value['@type'] ?? '').split(/\s*,\s*/).some((type) => type.toLowerCase() === 'jobposting');
  return (own ? [value] : []).concat(Array.isArray(value['@graph']) ? value['@graph'].flatMap(jobPostingNodes) : []);
}
function locationOf(node) {
  const location = Array.isArray(node.jobLocation) ? node.jobLocation[0] : node.jobLocation;
  const address = location?.address;
  return text(typeof address === 'string' ? address : [address?.addressLocality, address?.addressRegion, address?.addressCountry].filter(Boolean).join(', ')) || text(location?.name);
}
function xmlValues(body, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...String(body).matchAll(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'gi'))].map((m) => m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim());
}
function sitemapEntries(body, base) {
  const entries = [];
  for (const match of String(body).matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    const loc = xmlValues(match[1], 'loc')[0]; if (loc) entries.push({ url: canonical(absolute(loc, base)), lastmod: parseDate(xmlValues(match[1], 'lastmod')[0]) });
  }
  for (const match of String(body).matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
    const loc = xmlValues(match[1], 'loc')[0]; if (loc) entries.push({ url: canonical(absolute(loc, base)), lastmod: parseDate(xmlValues(match[1], 'lastmod')[0]), sitemap: true });
  }
  return entries.filter((entry) => entry.url);
}
function feedEntries(body, base) {
  const records = [];
  for (const match of String(body).matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const chunk = match[2];
    const linkTag = chunk.match(/<link\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/i);
    const link = linkTag?.[1] || xmlValues(chunk, 'link')[0] || xmlValues(chunk, 'guid')[0];
    if (!link) continue;
    records.push({ url: canonical(absolute(link, base)), title: text(xmlValues(chunk, 'title')[0]), description: text(xmlValues(chunk, 'description')[0] || xmlValues(chunk, 'summary')[0] || xmlValues(chunk, 'content')[0]), postedAt: parseDate(xmlValues(chunk, 'pubDate')[0] || xmlValues(chunk, 'published')[0] || xmlValues(chunk, 'updated')[0]) });
  }
  return records.filter((record) => record.url);
}

async function request(url, options) {
  return fetchIncrementally({ url, transport: options.transport, state: options.conditionalState?.[canonical(url)] ?? {}, robots: options.robots, userAgent: options.userAgent ?? 'Launchpad-Company-Careers/1.0', limiter: options.limiter, hostLimiterOptions: options.hostLimiterOptions, retry: options.retry, maxBytes: options.maxBytes ?? 2_000_000, timeoutMs: options.timeoutMs ?? 30_000, maxRedirects: options.maxRedirects ?? 0, maxHosts: options.maxHosts ?? 1, maxRequests: options.maxRequestsPerPage ?? (Number(options.maxRedirects ?? 0) + 1), signal: options.signal, clock: options.clock });
}

function candidateFrom(node, { company, url, sourceUrl, runAt, sitemapLastmod = null, classification = 'lead', feed = null, expiryGraceDays = 30 } = {}) {
  const rawUrl = node.url || url;
  const canonicalUrl = canonical(absolute(rawUrl, sourceUrl || url));
  if (!canonicalUrl) return null;
  const application = node.sameAs || node.potentialAction?.target || node.directApply === true && node.url || null;
  const postedAt = parseDate(node.datePosted || node.dateCreated || feed?.postedAt || sitemapLastmod);
  const validThrough = parseDate(node.validThrough);
  const staleBySitemap = sitemapLastmod && Date.parse(sitemapLastmod) < Date.parse(runAt) - (expiryGraceDays * 86_400_000);
  const expired = (validThrough && Date.parse(validThrough) < Date.parse(runAt)) || staleBySitemap;
  return normalizeCandidate({
    url: canonicalUrl, company: text(node.hiringOrganization?.name) || company, title: text(node.title) || feed?.title || titleFromUrl(canonicalUrl), location: locationOf(node), description: text(node.description) || feed?.description,
    datePosted: postedAt, postedAt, discoveredAt: runAt, crawledAt: runAt, validThrough, sameAs: application, applicationUrl: application,
    source: sourceUrl, provider: 'company-careers', sourceKind: application || classification === 'direct' ? 'ats-direct' : 'aggregator',
    liveness: expired ? { status: 'Expired', checkedAt: runAt, evidence: validThrough ? 'validThrough' : 'sitemap-lastmod' } : { status: postedAt ? 'Active' : 'Not Verified', checkedAt: runAt, evidence: postedAt ? 'career-site-observation' : null },
    evidence: { classification, sourceUrl, sitemapLastmod: sitemapLastmod || null, validThrough: validThrough || null, applicationUrl: application || null },
  }, { runAt });
}

export async function discoverCompanyCareers({ companies = [], company, websiteUrl, transport, runAt = new Date().toISOString(), conditionalState = {}, robots, ...options } = {}) {
  if (typeof transport !== 'function') throw new TypeError('discoverCompanyCareers requires injected transport');
  const inputs = companies.length ? companies : [{ company, websiteUrl }];
  const observations = []; const seen = new Set(); const discoveredBoards = []; const boardSeen = new Set(); const verificationQueue = []; const sources = []; const next = [];
  const state = { ...conditionalState }; const telemetry = { attempted: 0, succeeded: 0, changed: 0, unchanged: 0, notModified: 0, retryable: 0, failed: 0, disallowed: 0, malformedJsonLd: 0, duplicateUrls: 0, extracted: 0, cappedCompanies: 0 };
  const limiter = options.limiter ?? createHostLimiter({ ...(options.hostLimiterOptions ?? {}), clock: options.clock });
  const maxPagesPerCompany = Math.max(1, Number(options.maxPagesPerCompany ?? 100));
  const addBoard = (url, companyName, sourceUrl) => { const value = canonical(url); if (!value || sameSite(value, sourceUrl) || boardSeen.has(value)) return; boardSeen.add(value); discoveredBoards.push({ url: value, company: companyName, classification: 'lead', sourceUrl, evidence: 'career-page-link' }); };
  const addObservation = (candidate) => { if (!candidate) return; if (seen.has(candidate.canonicalUrl)) { telemetry.duplicateUrls += 1; return; } seen.add(candidate.canonicalUrl); observations.push(candidate); telemetry.extracted += 1; };
  for (const input of inputs) {
    const companyName = text(input.company ?? input.name) || 'Unknown Company'; const root = canonical(input.websiteUrl || input.url || input.careerUrl); if (!root) continue;
    const manifest = { company: companyName, rootUrl: root, status: 'pending', fetched: [], discoveredCareerUrls: [], pagesFetched: 0, capped: false }; sources.push(manifest);
    const robotsUrl = `${new URL(root).origin}/robots.txt`;
    let effectiveRobots = robots;
    if (effectiveRobots == null) {
      telemetry.attempted += 1;
      const robotsResult = await request(robotsUrl, { ...options, transport, conditionalState: state, robots: [], limiter });
      if (robotsResult.state) state[robotsUrl] = robotsResult.state;
      manifest.fetched.push({ url: robotsUrl, classification: robotsResult.classification, status: robotsResult.status ?? null });
      if (['changed', 'unchanged'].includes(robotsResult.classification)) {
        effectiveRobots = parseRobotsTxt(robotsResult.body || '');
        telemetry.succeeded += 1;
        telemetry[robotsResult.classification] += 1;
      } else if (robotsResult.classification === 'not-modified') {
        effectiveRobots = state[robotsUrl]?.rules ?? [];
        telemetry.notModified += 1;
      } else {
        effectiveRobots = [];
      }
      state[robotsUrl] = { ...(state[robotsUrl] ?? {}), rules: effectiveRobots };
    }
    const queue = [{ url: root, kind: 'page', sourceUrl: root }]; const queued = new Set([root]);
    while (queue.length && manifest.pagesFetched < maxPagesPerCompany) {
      const item = queue.shift(); if (!item?.url) continue; if (item.kind === 'job' && seen.has(item.url)) { telemetry.duplicateUrls += 1; continue; }
      manifest.pagesFetched += 1;
      telemetry.attempted += 1; const result = await request(item.url, { ...options, transport, conditionalState: state, robots: effectiveRobots, limiter });
      if (result.state) state[item.url] = result.state;
      manifest.fetched.push({ url: item.url, classification: result.classification, status: result.status ?? null });
      if (result.classification === 'retryable') telemetry.retryable += 1;
      if (result.classification === 'disallowed') telemetry.disallowed += 1;
      if (result.classification === 'terminal' || result.classification === 'retryable' || result.classification === 'disallowed') {
        telemetry.failed += 1;
        if (item.url === root) manifest.status = result.classification;
        if (item.url === root) verificationQueue.push({ company: companyName, url: item.url, reason: 'career-page-fetch', evidence: result.reason });
        continue;
      }
      telemetry.succeeded += 1; if (result.classification === 'changed') telemetry.changed += 1; if (result.classification === 'unchanged') telemetry.unchanged += 1; if (result.classification === 'not-modified') telemetry.notModified += 1;
      const body = result.body || ''; manifest.status = 'succeeded';
      const nodes = jsonLdBlocks(body); telemetry.malformedJsonLd += nodes.filter((node) => node.__malformed).length;
      for (const node of nodes.flatMap(jobPostingNodes)) addObservation(candidateFrom(node, { company: companyName, url: item.url, sourceUrl: item.sourceUrl || item.url, runAt, sitemapLastmod: item.lastmod, classification: sameSite(node.url || item.url, root) ? 'direct' : 'lead', expiryGraceDays: options.expiryGraceDays ?? 30 }));
      if (item.kind === 'feed') for (const record of feedEntries(body, item.url)) addObservation(candidateFrom(record, { company: companyName, url: record.url, sourceUrl: item.url, runAt, classification: 'lead', feed: record, expiryGraceDays: options.expiryGraceDays ?? 30 }));
      if (item.kind === 'sitemap') for (const entry of sitemapEntries(body, item.url)) { if (entry.sitemap) { if (!queued.has(entry.url)) { queued.add(entry.url); queue.push({ ...entry, kind: 'sitemap', sourceUrl: item.url }); } } else if (!queued.has(entry.url)) { queued.add(entry.url); queue.push({ ...entry, kind: 'job', sourceUrl: item.url }); } }
      for (const link of linksFromHtml(body, item.url)) {
        if (!sameSite(link, root) && (CAREER_RE.test(link) || BOARD_RE.test(link))) { addBoard(link, companyName, item.url); continue; }
        if (sameSite(link, root) && (CAREER_RE.test(link) || XML_RE.test(link)) && !queued.has(canonical(link))) { const normalized = canonical(link); queued.add(normalized); queue.push({ url: normalized, kind: XML_RE.test(normalized) ? (normalized.includes('rss') || normalized.includes('atom') ? 'feed' : 'sitemap') : 'page', sourceUrl: item.url }); manifest.discoveredCareerUrls.push(normalized); }
      }
      if (item.kind === 'page' && item.url === root) {
        const fallback = `${new URL(root).origin}/sitemap.xml`;
        if (!queued.has(fallback)) { queued.add(fallback); queue.push({ url: fallback, kind: 'sitemap', sourceUrl: root }); }
      }
      if (item.kind === 'job' && !nodes.flatMap(jobPostingNodes).length) addObservation(candidateFrom({}, { company: companyName, url: item.url, sourceUrl: item.sourceUrl || item.url, runAt, sitemapLastmod: item.lastmod, classification: 'direct', expiryGraceDays: options.expiryGraceDays ?? 30 }));
    }
    if (queue.length) {
      manifest.capped = true;
      manifest.status = 'capped';
      telemetry.cappedCompanies += 1;
    }
  }
  for (const row of observations) { if (!row.postedAt) verificationQueue.push({ company: row.company, url: row.canonicalUrl, reason: 'undated', evidence: row.evidence }); else if (row.liveness.status === 'Expired') verificationQueue.push({ company: row.company, url: row.canonicalUrl, reason: 'expired', evidence: row.evidence }); }
  return { observations, discoveredBoards, manifest: { schemaVersion: 'CompanyCareersManifestV1', runAt, sources, telemetry }, verificationQueue, conditionalState: state, telemetry };
}

export const discoverCompanyCareerSites = discoverCompanyCareers;
