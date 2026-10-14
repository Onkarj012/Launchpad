import { fetchIncrementally } from './incremental-fetch.mjs';
import { createHostLimiter, parseRobotsTxt } from './http-policy.mjs';
import { normalizeCandidate, stripHtmlToText } from '../job-pull/candidate.mjs';
import { remainingDeadlineMs, requestWithDeadline, throwIfNetworkWorkDisallowed } from './deadline.mjs';

const CAREER_RE = /(?:^|\/)(?:careers?|jobs?|work-with-us|join-us|opportunities)(?:[\/._-]|$)/i;
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
// Reject assets and non-web schemes before considering traversal or observations.
function isWebPage(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && !/\.(?:css|js|mjs|json|map|png|jpe?g|gif|svg|webp|ico|pdf|zip|woff2?|ttf|eot|mp4|webm|mp3)(?:$|\/)/i.test(decodeURIComponent(parsed.pathname));
  } catch { return false; }
}
// Match career paths independently of a jobs.* hostname or tracking query.
function isCareerUrl(url) {
  try { return isWebPage(url) && CAREER_RE.test(decodeURIComponent(new URL(url).pathname)); } catch { return false; }
}
// Keep explicit career-feed jobs whose recognized ATS detail paths omit career tokens.
function isAtsJobUrl(url) {
  if (!isWebPage(url)) return false;
  const parsed = new URL(url);
  if (/^(?:jobs\.lever\.co|jobs\.ashbyhq\.com|jobs\.smartrecruiters\.com)$/i.test(parsed.hostname)) return /^\/[^/]+\/[^/]+\/?$/.test(parsed.pathname);
  return /^(?:job-boards\.greenhouse\.io|boards(?:\.eu)?\.greenhouse\.io)$/i.test(parsed.hostname) && /^\/[^/]+\/jobs\/[^/]+\/?$/.test(parsed.pathname);
}
// Recognize sitemap/feed paths without matching unrelated query parameters.
function isXmlUrl(url) { return isWebPage(url) && XML_RE.test(new URL(url).pathname); }

// Retain the complete enclosing element so nested fields cannot drop restrictions.
function elementText(body, match) {
  const start = match.index + match[0].length;
  let depth = 1;
  for (const tag of body.slice(start).matchAll(new RegExp(`<\\/?${match[1]}\\b[^>]*>`, 'gi'))) {
    depth += /^<\//.test(tag[0]) ? -1 : /\/>$/.test(tag[0]) ? 0 : 1;
    if (!depth) return text(stripHtmlToText(body.slice(start, start + tag.index)));
  }
  return null;
}
// Match complete supported field tokens for extraction and single-role checks.
function htmlFields(body, property) {
  return [...body.matchAll(new RegExp(`<([a-z][\\w-]*)\\b[^>]*(?:\\s(?:itemprop|id)\\s*=\\s*["'](?:${property})["']|\\sclass\\s*=\\s*["'](?:[^"']*\\s)?(?:${property})(?:\\s[^"']*)?["'])[^>]*>`, 'gi'))];
}
// Read a small explicit HTML field, never the whole marketing page.
function htmlField(body, property) {
  const match = htmlFields(body, property)[0];
  return match ? elementText(body, match) : null;
}
// Keep the full labelled location, including restrictions after nested spans.
function labelledLocation(body) {
  for (const match of body.matchAll(/<(p|li|div|span)\b[^>]*>(?=\s*(?:<(?:strong|b|span)\b[^>]*>)?\s*(?:Job\s+)?Location\s*:)/gi)) {
    const value = elementText(body, match);
    if (/^(?:Job\s+)?Location\s*:/i.test(value || '')) return text(value.replace(/^(?:Job\s+)?Location\s*:\s*/i, ''));
  }
  return null;
}
// Keep job requirements and responsibilities, stopping at a non-job peer or parent section.
function descriptionSection(body) {
  const jobSection = /^(?:job\s+description|(?:(?:job|key|technical|minimum|preferred|desired)\s+)?(?:requirements?|qualifications?|responsibilities|skills|experience|eligibility))\b/i;
  const heading = [...body.matchAll(/<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].find((match) => jobSection.test(stripHtmlToText(match[2])));
  if (!heading) return null;
  const rest = body.slice(heading.index + heading[0].length);
  const next = [...rest.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].find((match) => {
    if (Number(match[1]) < Number(heading[1])) return true;
    if (Number(match[1]) > Number(heading[1])) return false;
    return !jobSection.test(stripHtmlToText(match[2]));
  });
  return text(stripHtmlToText(rest.slice(0, next?.index ?? rest.length)));
}
// Extract supported job-detail fields only when a role, location and JD are explicit.
function htmlJob(body) {
  const clean = String(body).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const headingTitle = text(stripHtmlToText(clean.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ''));
  const title = htmlField(clean, 'title|jobTitle') || headingTitle;
  if (/^(?:careers?|jobs?|current\s+openings|open\s+(?:positions|roles)|job\s+openings|opportunities|join\s+us)(?:\s|$)/i.test(headingTitle || title || '')) return null;
  const descriptions = htmlFields(clean, 'description|jobDescription|job-description');
  if (descriptions.length > 1 || [...clean.matchAll(/<h1\b/gi)].length > 1) return null;
  const location = htmlField(clean, 'jobLocation|job-location') || labelledLocation(clean);
  const fieldDescription = htmlField(clean, 'description|jobDescription|job-description');
  const sectionDescription = descriptionSection(clean);
  const description = fieldDescription && sectionDescription
    ? fieldDescription.includes(sectionDescription) ? fieldDescription : sectionDescription.includes(fieldDescription) ? sectionDescription : `${fieldDescription}\n${sectionDescription}`
    : fieldDescription || sectionDescription;
  if (!title || title.length > 200 || !location || location.length > 300 || !description || description.length > 16_000) return null;
  return { title, description, jobLocation: { name: location }, fieldSources: { title: 'job-detail-html', location: 'job-detail-html', description: 'job-detail-html' } };
}

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
    records.push({ url: canonical(absolute(link, base)), title: text(xmlValues(chunk, 'title')[0]), description: text(xmlValues(chunk, 'description')[0] || xmlValues(chunk, 'summary')[0] || xmlValues(chunk, 'content')[0]), postedAt: parseDate(xmlValues(chunk, 'pubDate')[0] || xmlValues(chunk, 'published')[0]), modifiedAt: parseDate(xmlValues(chunk, 'updated')[0]) });
  }
  return records.filter((record) => record.url);
}

async function request(url, options) {
  throwIfNetworkWorkDisallowed(options.signal, options.deadline);
  const endAt = Date.now() + (Number(options.timeoutMs) || 30_000);
  const requestDeadline = { remainingMs: () => Math.min(endAt - Date.now(), remainingDeadlineMs(options.deadline)) };
  return requestWithDeadline((_url, { signal }) => fetchIncrementally({
    url, signal,
    transport: (requestUrl, transportOptions) => requestWithDeadline(options.transport, requestUrl,
      { ...transportOptions, timeoutMs: options.timeoutMs ?? 30_000 },
      { signal, deadline: requestDeadline, abortOnDeadline: true }),
    state: options.conditionalState?.[canonical(url)] ?? {}, robots: options.robots,
    userAgent: options.userAgent ?? 'Launchpad-Company-Careers/1.0', limiter: options.limiter,
    hostLimiterOptions: options.hostLimiterOptions, retry: options.retry,
    maxBytes: options.maxBytes ?? 2_000_000, timeoutMs: options.timeoutMs ?? 30_000, clock: options.clock,
  }), url, {}, { signal: options.signal, deadline: requestDeadline, abortOnDeadline: true });
}

// Keep persisted progress small while retaining each company's stall location.
export function companyCareerProgress(sources = []) {
  return sources.map(({ company, rootUrl, status, currentUrl, pagesFetched, capped, error }) => ({
    company, rootUrl, status, currentUrl, pagesFetched, capped, ...(error ? { error } : {}),
  }));
}

// Normalize observed fields while keeping publication and modification evidence separate.
function candidateFrom(node, { company, url, sourceUrl, runAt, sitemapLastmod = null, classification = 'lead', feed = null } = {}) {
  const rawUrl = node.url || url;
  const canonicalUrl = canonical(absolute(rawUrl, sourceUrl || url));
  if (!canonicalUrl || !isWebPage(canonicalUrl) || !(text(node.title) || feed?.title)) return null;
  const application = node.sameAs || node.potentialAction?.target || node.directApply === true && node.url || null;
  const postedAt = parseDate(node.datePosted || feed?.postedAt);
  const validThrough = parseDate(node.validThrough);
  const expired = validThrough && Date.parse(validThrough) < Date.parse(runAt);
  return normalizeCandidate({
    url: canonicalUrl, company: text(node.hiringOrganization?.name) || company, title: text(node.title) || feed?.title, location: locationOf(node), description: text(node.description) || feed?.description,
    employmentType: typeof node.employmentType === 'string' ? node.employmentType.replace(/_/g, '-').toLowerCase() : null,
    employmentEvidence: text(node.employmentType),
    datePosted: postedAt, postedAt, discoveredAt: runAt, crawledAt: runAt, validThrough, sameAs: application, applicationUrl: application,
    source: sourceUrl, provider: 'company-careers', sourceKind: application || classification === 'direct' ? 'ats-direct' : 'aggregator',
    liveness: expired ? { status: 'Expired', checkedAt: runAt, evidence: 'validThrough' } : { status: postedAt ? 'Active' : 'Not Verified', checkedAt: runAt, evidence: postedAt ? 'career-site-observation' : null },
    evidence: { classification, sourceUrl, detailUrl: url, sitemapLastmod: sitemapLastmod || null, modifiedAt: parseDate(node.dateModified || feed?.modifiedAt), dateCreated: parseDate(node.dateCreated), datePosted: postedAt, employmentType: node.employmentType ?? null, fieldSources: node.fieldSources || { title: feed ? 'career-feed' : 'JobPosting', location: feed ? null : 'JobPosting', description: feed ? 'career-feed' : 'JobPosting', employmentType: node.employmentType ? 'JobPosting' : null, postedAt: postedAt ? (feed ? 'feed-publication' : 'JobPosting.datePosted') : null }, validThrough: validThrough || null, applicationUrl: application || null },
  }, { runAt });
}

export async function discoverCompanyCareers({ companies = [], company, websiteUrl, transport, runAt = new Date().toISOString(), conditionalState = {}, robots, signal = null, deadline = null, ...options } = {}) {
  if (typeof transport !== 'function') throw new TypeError('discoverCompanyCareers requires injected transport');
  const inputs = companies.length ? companies : [{ company, websiteUrl }];
  const observations = []; const seen = new Set(); const discoveredBoards = []; const boardSeen = new Set(); const verificationQueue = []; const sources = []; const next = [];
  const state = { ...conditionalState }; const telemetry = { attempted: 0, succeeded: 0, changed: 0, unchanged: 0, notModified: 0, retryable: 0, failed: 0, disallowed: 0, malformedJsonLd: 0, duplicateUrls: 0, extracted: 0, cappedCompanies: 0 };
  const limiter = options.limiter ?? createHostLimiter({ ...(options.hostLimiterOptions ?? {}), clock: options.clock });
  const maxPagesPerCompany = Math.max(1, Number(options.maxPagesPerCompany ?? 100));
  const addBoard = (url, companyName, sourceUrl) => { const value = canonical(url); if (!value || sameSite(value, sourceUrl) || boardSeen.has(value)) return; boardSeen.add(value); discoveredBoards.push({ url: value, company: companyName, classification: 'lead', sourceUrl, evidence: 'career-page-link' }); };
  const addObservation = (candidate) => { if (!candidate) return; if (seen.has(candidate.canonicalUrl)) { telemetry.duplicateUrls += 1; return; } seen.add(candidate.canonicalUrl); observations.push(candidate); telemetry.extracted += 1; };
  // Retain the current company and URL before work that can stall.
  async function progress() {
    if (typeof options.onProgress === 'function') await options.onProgress({ observations: [...observations], sources: structuredClone(sources), telemetry: { ...telemetry } });
  }
  for (const input of inputs) {
    try { throwIfNetworkWorkDisallowed(signal, deadline); } catch { break; }
    const companyName = text(input.company ?? input.name) || 'Unknown Company'; const root = canonical(input.websiteUrl || input.url || input.careerUrl); if (!root) continue;
    const manifest = { company: companyName, rootUrl: root, status: 'pending', currentUrl: null, fetched: [], discoveredCareerUrls: [], pagesFetched: 0, capped: false }; sources.push(manifest);
    const robotsUrl = `${new URL(root).origin}/robots.txt`;
    let effectiveRobots = robots;
    if (effectiveRobots == null) {
      telemetry.attempted += 1;
      manifest.currentUrl = robotsUrl;
      await progress();
      let robotsResult;
      try { robotsResult = await request(robotsUrl, { ...options, signal, deadline, transport, conditionalState: state, robots: [], limiter }); }
      catch (error) {
        const stopped = signal?.aborted || remainingDeadlineMs(deadline) <= 0;
        manifest.status = stopped ? 'interrupted' : 'terminal'; manifest.error = error.message; telemetry.failed++;
        await progress();
        if (stopped) break;
        continue;
      }
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
      try { throwIfNetworkWorkDisallowed(signal, deadline); } catch { manifest.status = 'interrupted'; break; }
      const item = queue.shift(); if (!item?.url) continue; if (item.kind === 'job' && seen.has(item.url)) { telemetry.duplicateUrls += 1; continue; }
      manifest.pagesFetched += 1;
      telemetry.attempted += 1; manifest.currentUrl = item.url;
      await progress();
      let result;
      try { result = await request(item.url, { ...options, signal, deadline, transport, conditionalState: state, robots: effectiveRobots, limiter }); }
      catch (error) {
        manifest.status = signal?.aborted || remainingDeadlineMs(deadline) <= 0 ? 'interrupted' : 'terminal';
        manifest.error = error.message; telemetry.failed++; break;
      }
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
      const body = (result.body || '').replace(/<!--[\s\S]*?(?:-->|$)/g, ' '); manifest.status = 'succeeded';
      const nodes = jsonLdBlocks(body); telemetry.malformedJsonLd += nodes.filter((node) => node.__malformed).length;
      for (const node of nodes.flatMap(jobPostingNodes)) addObservation(candidateFrom(node, { company: companyName, url: item.url, sourceUrl: item.sourceUrl || item.url, runAt, sitemapLastmod: item.lastmod, classification: sameSite(node.url || item.url, root) ? 'direct' : 'lead' }));
      const isFeed = item.kind === 'feed' || /^\s*(?:(?:<\?xml[^>]*>|<!--[\s\S]*?-->)\s*)*<(?:rss|feed)\b/i.test(body.slice(0, 4096));
      if (isFeed) for (const record of feedEntries(body, item.url)) { if (isCareerUrl(record.url) || isAtsJobUrl(record.url)) addObservation(candidateFrom(record, { company: companyName, url: record.url, sourceUrl: item.url, runAt, classification: 'lead', feed: record })); }
      if (item.kind === 'sitemap') for (const entry of sitemapEntries(body, item.url)) {
        if (!sameSite(entry.url, root) || !isWebPage(entry.url) || !(entry.sitemap ? isXmlUrl(entry.url) : isCareerUrl(entry.url)) || queued.has(entry.url)) continue;
        queued.add(entry.url); queue.push({ ...entry, kind: entry.sitemap ? 'sitemap' : 'job', sourceUrl: item.url });
      }
      for (const link of linksFromHtml(body, item.url)) {
        if (!isWebPage(link)) continue;
        if (!sameSite(link, root) && (isCareerUrl(link) || BOARD_RE.test(host(link)))) { addBoard(link, companyName, item.url); continue; }
        if (sameSite(link, root) && (isCareerUrl(link) || isXmlUrl(link)) && !queued.has(canonical(link))) { const normalized = canonical(link); queued.add(normalized); queue.push({ url: normalized, kind: isXmlUrl(normalized) ? (/\.(rss|atom)$/i.test(new URL(normalized).pathname) ? 'feed' : 'sitemap') : 'page', sourceUrl: item.url }); manifest.discoveredCareerUrls.push(normalized); }
      }
      if (item.kind === 'page' && item.url === root) {
        const fallback = `${new URL(root).origin}/sitemap.xml`;
        if (!queued.has(fallback)) { queued.add(fallback); queue.push({ url: fallback, kind: 'sitemap', sourceUrl: root }); }
      }
      if (isCareerUrl(item.url) && !nodes.flatMap(jobPostingNodes).length && !['feed', 'sitemap'].includes(item.kind)) {
        const job = htmlJob(body);
        if (job) addObservation(candidateFrom(job, { company: companyName, url: item.url, sourceUrl: item.sourceUrl || item.url, runAt, sitemapLastmod: item.lastmod, classification: 'direct' }));
      }
    }
    if (queue.length && manifest.pagesFetched >= maxPagesPerCompany && manifest.status !== 'interrupted') {
      manifest.capped = true;
      manifest.status = 'capped';
      telemetry.cappedCompanies += 1;
    }
    if (manifest.status !== 'interrupted') manifest.currentUrl = null;
    await progress();
  }
  for (const row of observations) { if (!row.postedAt) verificationQueue.push({ company: row.company, url: row.canonicalUrl, reason: 'undated', evidence: row.evidence }); else if (row.liveness.status === 'Expired') verificationQueue.push({ company: row.company, url: row.canonicalUrl, reason: 'expired', evidence: row.evidence }); }
  return { observations, discoveredBoards, manifest: { schemaVersion: 'CompanyCareersManifestV1', runAt, sources, telemetry }, verificationQueue, conditionalState: state, telemetry };
}

export const discoverCompanyCareerSites = discoverCompanyCareers;
