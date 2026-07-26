import { fetchIncrementally } from './incremental-fetch.mjs';
import { createHostLimiter, decideRobots, parseRobotsTxt } from './http-policy.mjs';
import {
  classifyOriginalListingUrl,
  createOriginalListingResolver,
} from './original-listing-resolver.mjs';
import { normalizeCandidate } from '../job-pull/candidate.mjs';

export const CAREER_PAGE_DISCOVERY_VERSION = 'CareerPageDiscoveryV1';

export const DEFAULT_CAREER_PAGE_DISCOVERY_BUDGET = Object.freeze({
  maxRedirects: 3,
  maxHosts: 2,
  maxBytes: 2_000_000,
  maxRequests: 40,
  maxJobUrlsPerCompany: 50,
  maxPagesPerCompany: 20,
});

const USER_AGENT = 'Launchpad-Career-Page-Discovery/1.0';

/** Meaningful path segments that mark a careers landing or job inventory surface. */
const CAREERS_LANDING_PATH = /(?:^|\/)(careers?|jobs?|join[-_]?us|work[-_]?with[-_]?us|open[-_]?positions?|opportunit(?:y|ies)|current[-_]?openings?)(?:\/|$)/i;

/** Path segments that mark an individual role / vacancy page (not the listing index alone). */
const JOB_DETAIL_PATH = /(?:^|\/)(?:jobs?|careers?|vacanc(?:y|ies)|positions?|openings?|requisitions?)\/(?:current[-_]?openings?\/)?[^/]+/i;

/** Marketing / corporate pages that must never become job observations. */
const MARKETING_PATH = /(?:^|\/)(?:about(?:-us)?|blog|news|press|media|contact|privacy|terms|cookie|login|signin|register|products?|services?|solutions?|industries|customers?|case[-_]?stud|events?|resources?|insights?|partners?|investors?|legal|sitemap)(?:\/|$)/i;

const STATIC_EXT = /\.(?:css|js|mjs|cjs|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|mp4|webm|mp3|wav|json|xml|txt|csv|docx?|xlsx?|pptx?)$/i;

const JOB_SITEMAP_NAME = /(?:sitemap[-_]?(?:jobs?|careers?|vacanc|positions?|openings?)|(?:jobs?|careers?|vacanc|positions?|openings?)[-_]?sitemap)/i;

const CAREERS_CANDIDATE_PATHS = Object.freeze([
  '/careers',
  '/careers/',
  '/jobs',
  '/jobs/',
  '/careers/open-positions',
  '/careers/openings',
  '/join-us',
  '/work-with-us',
  '/current-openings',
]);

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

function absolute(value, base) {
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function canonical(value, base = null) {
  if (!text(value) && !base) return null;
  try {
    const url = new URL(value, base || undefined);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|source$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    url.pathname = url.pathname.replace(/\/+/g, '/');
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/$/, '');
    return url.toString();
  } catch {
    return null;
  }
}

function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function pathOf(value) {
  try {
    return new URL(value).pathname || '/';
  } catch {
    return '';
  }
}

function sameSite(a, b) {
  return hostOf(a) === hostOf(b);
}

function parseDate(value) {
  if (value == null || value === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function contentTypeOf(response) {
  const headers = response?.headers || {};
  const raw = typeof headers.get === 'function'
    ? headers.get('content-type')
    : headers['content-type'] ?? headers['Content-Type'] ?? null;
  return raw ? String(raw).toLowerCase() : '';
}

function isStaticAssetUrl(url) {
  const path = pathOf(url);
  if (!path || path === '/') return false;
  // Sitemap / feed XML must stay crawlable even though they end in .xml.
  if (/\.xml$/i.test(path) && /sitemap|rss|atom/i.test(path)) return false;
  if (STATIC_EXT.test(path)) return true;
  return false;
}

function isStaticContentType(contentType) {
  if (!contentType) return false;
  if (/^(image|audio|video|font)\//i.test(contentType)) return true;
  if (/javascript|css|font-woff|octet-stream/i.test(contentType) && !/html|xml|json/i.test(contentType)) return true;
  if (/pdf|zip|msword|spreadsheet|presentation/i.test(contentType)) return true;
  return false;
}

/**
 * Classify a same-site URL by meaningful PATH segments (never hostname alone).
 * Hostname substring matches (e.g. jobs.example.com/static/app.css) must not
 * promote static or marketing assets into the job queue.
 */
export function classifyCareerUrl(value, { base = null, title = null, hasJobPosting = false } = {}) {
  const url = canonical(value, base);
  if (!url) return { kind: 'invalid', url: null, reason: 'invalid-url' };
  if (isStaticAssetUrl(url)) return { kind: 'static-asset', url, reason: 'static-extension' };

  const path = pathOf(url);
  const pathLower = path.toLowerCase();

  if (MARKETING_PATH.test(path) && !JOB_DETAIL_PATH.test(path)) {
    return { kind: 'marketing', url, reason: 'marketing-path' };
  }

  if (JOB_SITEMAP_NAME.test(pathLower) || /sitemap[-_]?(?:index)?\.xml$/i.test(pathLower)) {
    const jobSitemap = JOB_SITEMAP_NAME.test(pathLower);
    return { kind: jobSitemap ? 'job-sitemap' : 'sitemap', url, reason: jobSitemap ? 'job-sitemap-name' : 'sitemap-name' };
  }

  if (hasJobPosting) return { kind: 'job', url, reason: 'json-ld-jobposting' };
  if (JOB_DETAIL_PATH.test(path)) return { kind: 'job', url, reason: 'job-detail-path' };
  if (CAREERS_LANDING_PATH.test(path)) return { kind: 'careers-landing', url, reason: 'careers-path' };

  if (title && /\b(apply\s+now|job\s+opening|we\s+are\s+hiring)\b/i.test(title) && !MARKETING_PATH.test(path)) {
    return { kind: 'job', url, reason: 'job-title-metadata' };
  }

  return { kind: 'other', url, reason: 'no-job-signal' };
}

export function isJobSitemapUrl(value) {
  const url = canonical(value);
  if (!url) return false;
  return JOB_SITEMAP_NAME.test(pathOf(url));
}

function xmlText(chunk, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...String(chunk).matchAll(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'gi'))]
    .map((match) => match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);
}

export function parseSitemapEntries(body, base) {
  const entries = [];
  for (const match of String(body).matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
    const loc = xmlText(match[1], 'loc')[0];
    if (!loc) continue;
    const url = canonical(absolute(loc, base));
    if (!url) continue;
    entries.push({
      url,
      lastmod: parseDate(xmlText(match[1], 'lastmod')[0]),
      isSitemapIndexEntry: true,
      isJobSitemap: isJobSitemapUrl(url),
    });
  }
  for (const match of String(body).matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    const loc = xmlText(match[1], 'loc')[0];
    if (!loc) continue;
    const url = canonical(absolute(loc, base));
    if (!url) continue;
    entries.push({
      url,
      lastmod: parseDate(xmlText(match[1], 'lastmod')[0]),
      isSitemapIndexEntry: false,
      isJobSitemap: false,
    });
  }
  return entries;
}

export function extractRobotsSitemaps(robotsText, origin) {
  const urls = [];
  for (const rawLine of String(robotsText || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key !== 'sitemap' || !value) continue;
    const url = canonical(absolute(value, origin));
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
}

function linksFromHtml(body, base) {
  const links = [];
  for (const match of String(body).matchAll(/<(?:a|link)\b([^>]*)>/gi)) {
    const attrs = match[1] || '';
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const url = canonical(absolute(href, base));
    if (url) links.push(url);
  }
  return links;
}

function discoverCareersLink(homepageHtml, rootUrl) {
  const origin = originOf(rootUrl);
  const ranked = [];
  for (const match of String(homepageHtml).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1] || '';
    const inner = text((match[2] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')) || '';
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const url = canonical(absolute(href, rootUrl));
    if (!url || !sameSite(url, rootUrl)) continue;
    const path = pathOf(url);
    const classified = classifyCareerUrl(url);
    if (classified.kind === 'static-asset' || classified.kind === 'marketing') continue;
    let rank = 100;
    if (classified.kind === 'careers-landing') rank = 10;
    if (CAREERS_LANDING_PATH.test(path)) rank = Math.min(rank, 15);
    if (/\b(careers?|jobs?|openings?|join\s+us|work\s+with\s+us)\b/i.test(inner)) rank = Math.min(rank, 5);
    if (rank < 100) ranked.push({ url, rank, why: inner || classified.reason });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.url.localeCompare(b.url));
  if (ranked[0]) return ranked[0].url;

  for (const path of CAREERS_CANDIDATE_PATHS) {
    const candidate = canonical(`${origin}${path}`);
    if (candidate) return candidate;
  }
  return null;
}

export function normalizeCareerPageDiscoveryBudget(input = {}) {
  const nested = input.careerPageDiscovery
    || input.sources?.careerPageDiscovery
    || input.budget
    || input;
  const defaults = DEFAULT_CAREER_PAGE_DISCOVERY_BUDGET;
  const number = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  return {
    maxRedirects: number(nested.maxRedirects ?? input.maxRedirects, defaults.maxRedirects),
    maxHosts: number(nested.maxHosts ?? input.maxHosts, defaults.maxHosts),
    maxBytes: number(nested.maxBytes ?? input.maxBytes, defaults.maxBytes),
    maxRequests: number(nested.maxRequests ?? input.maxRequests ?? nested.requestBudget ?? input.requestBudget, defaults.maxRequests),
    maxJobUrlsPerCompany: number(nested.maxJobUrlsPerCompany ?? input.maxJobUrlsPerCompany, defaults.maxJobUrlsPerCompany),
    maxPagesPerCompany: number(nested.maxPagesPerCompany ?? input.maxPagesPerCompany, defaults.maxPagesPerCompany),
  };
}

async function request(url, options) {
  return fetchIncrementally({
    url,
    transport: options.transport,
    state: options.conditionalState?.[canonical(url)] ?? {},
    robots: options.robots,
    userAgent: options.userAgent ?? USER_AGENT,
    limiter: options.limiter,
    hostLimiterOptions: options.hostLimiterOptions,
    retry: options.retry,
    maxBytes: options.maxBytes ?? DEFAULT_CAREER_PAGE_DISCOVERY_BUDGET.maxBytes,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxRedirects: options.maxRedirects ?? DEFAULT_CAREER_PAGE_DISCOVERY_BUDGET.maxRedirects,
    maxHosts: options.maxHosts ?? DEFAULT_CAREER_PAGE_DISCOVERY_BUDGET.maxHosts,
    maxRequests: options.maxRequests ?? DEFAULT_CAREER_PAGE_DISCOVERY_BUDGET.maxRequests,
    clock: options.clock,
  });
}

function emptyTelemetry(budget) {
  return {
    requests: 0,
    disallowed: 0,
    excludedStatic: 0,
    excludedMarketing: 0,
    excludedOther: 0,
    jobUrlsDiscovered: 0,
    jobPagesResolved: 0,
    jobPagesUnverified: 0,
    sitemapsFetched: 0,
    jobSitemapsFetched: 0,
    generalSitemapsSkipped: 0,
    budgetExhausted: false,
    cappedJobUrls: false,
    budget: { ...budget },
  };
}

function observationFromResolution({
  company,
  jobUrl,
  resolution,
  runAt,
  sitemapLastMod = null,
  sourceUrl = null,
}) {
  if (!resolution || resolution.status !== 'resolved') return null;
  const patch = resolution.patch || {};
  const title = text(patch.title);
  const description = text(patch.description);
  if (!title && !description) return null;

  // sitemapLastMod is page-modification evidence only — never postedAt / freshness.
  const postedAt = patch.postedAt ?? null;

  return normalizeCandidate({
    url: resolution.originalApplicationUrl || jobUrl,
    canonicalUrl: resolution.originalApplicationUrl || jobUrl,
    company,
    title: title || 'Open role',
    location: patch.location || null,
    description,
    postedAt,
    datePosted: postedAt,
    discoveredAt: runAt,
    crawledAt: runAt,
    employment: patch.employment || null,
    experience: patch.experience || null,
    salary: patch.salary || null,
    liveness: patch.liveness || { status: 'Active', checkedAt: runAt, evidence: 'career-page-jobposting' },
    provider: 'career-page-discovery',
    source: sourceUrl || jobUrl,
    sourceKind: 'ats-direct',
    originalApplicationUrl: resolution.originalApplicationUrl || jobUrl,
    applicationResolution: { status: 'Resolved Original', evidence: 'career-page-jsonld-jobposting' },
    evidence: {
      classification: 'direct',
      discovery: CAREER_PAGE_DISCOVERY_VERSION,
      sourceUrl: sourceUrl || null,
      sitemapLastMod: sitemapLastMod || null,
      pageModification: sitemapLastMod
        ? { kind: 'sitemap-lastmod', value: sitemapLastMod }
        : null,
      fieldSources: patch.evidence?.fieldSources || resolution.evidence?.fieldSources || {},
      resolver: resolution.evidence?.resolver || null,
      resolution: resolution.evidence?.resolution || null,
    },
  }, { runAt });
}

/**
 * Discover job URLs on a verified company career site via careers landing,
 * robots.txt, and job-specific sitemaps; hydrate only path/metadata-classified
 * job pages through original-listing JobPosting extraction.
 */
export async function discoverCareerPages({
  company,
  rootDomain,
  websiteUrl,
  companies = [],
  transport,
  runAt = new Date().toISOString(),
  conditionalState = {},
  robots: providedRobots = null,
  config,
  budget,
  maxRedirects,
  maxHosts,
  maxBytes,
  maxRequests,
  maxJobUrlsPerCompany,
  maxPagesPerCompany,
  hostLimiterOptions,
  limiter: providedLimiter,
  retry,
  clock,
  ...rest
} = {}) {
  if (typeof transport !== 'function') throw new TypeError('discoverCareerPages requires injected transport');

  const limits = normalizeCareerPageDiscoveryBudget({
    maxRedirects,
    maxHosts,
    maxBytes,
    maxRequests,
    maxJobUrlsPerCompany,
    maxPagesPerCompany,
    budget,
    ...(config || {}),
  });

  const inputs = companies.length
    ? companies
    : [{ company, websiteUrl: websiteUrl || rootDomain, rootDomain }];

  const observations = [];
  const seenJobs = new Set();
  const sources = [];
  const state = { ...conditionalState };
  const telemetry = emptyTelemetry(limits);
  const limiter = providedLimiter ?? createHostLimiter({
    minSpacingMs: hostLimiterOptions?.minSpacingMs ?? 1000,
    maxConcurrency: hostLimiterOptions?.maxConcurrency ?? 1,
    clock,
  });

  for (const input of inputs) {
    const companyName = text(input.company ?? input.name) || text(company) || 'Unknown Company';
    const root = canonical(input.websiteUrl || input.url || input.careerUrl || input.rootDomain || rootDomain || websiteUrl);
    if (!root) continue;

    const origin = originOf(root);
    const manifest = {
      company: companyName,
      rootUrl: root,
      status: 'pending',
      careersUrl: null,
      robotsUrl: null,
      sitemaps: { indexes: [], jobSitemaps: [], generalSitemaps: [] },
      jobUrls: [],
      fetched: [],
      pagesFetched: 0,
      capped: false,
    };
    sources.push(manifest);

    const companyTelemetry = emptyTelemetry(limits);
    const track = (key, n = 1) => {
      companyTelemetry[key] = (companyTelemetry[key] || 0) + n;
      telemetry[key] = (telemetry[key] || 0) + n;
    };

    const canFetch = ({ countPage = true } = {}) => {
      if (companyTelemetry.requests >= limits.maxRequests) {
        companyTelemetry.budgetExhausted = true;
        telemetry.budgetExhausted = true;
        return false;
      }
      if (countPage && manifest.pagesFetched >= limits.maxPagesPerCompany) {
        manifest.capped = true;
        return false;
      }
      return true;
    };

    // Counting-only transport for fetchIncrementally (which already owns the host limiter).
    const countingTransport = async (url, opts) => {
      track('requests');
      return transport(url, opts);
    };

    // Resolver does not use fetchIncrementally — apply host spacing here.
    const resolverTransport = async (url, opts) => {
      let host;
      try {
        host = new URL(url).host;
      } catch {
        host = 'invalid';
      }
      return limiter.run(host, async () => {
        track('requests');
        return transport(url, opts);
      });
    };

    const resolveJob = createOriginalListingResolver({
      transport: resolverTransport,
      runAt,
      maxRedirects: limits.maxRedirects,
      maxHosts: Math.max(1, limits.maxHosts),
      maxBytes: limits.maxBytes,
      maxRequests: Math.max(2, Math.min(4, limits.maxRequests)),
    });

    const fetchUrl = async (url, { respectRobots = true, robotsRules = [] } = {}) => {
      if (!canFetch()) return { classification: 'budget-exhausted', url };
      manifest.pagesFetched += 1;
      const result = await request(url, {
        transport: countingTransport,
        conditionalState: state,
        robots: respectRobots ? robotsRules : [],
        limiter,
        hostLimiterOptions,
        retry: retry ?? rest.retry ?? { maxAttempts: 3 },
        maxBytes: limits.maxBytes,
        maxRedirects: limits.maxRedirects,
        maxHosts: limits.maxHosts,
        maxRequests: limits.maxRequests,
        clock,
        userAgent: USER_AGENT,
      });
      if (result.classification === 'disallowed') track('disallowed');
      if (result.state) state[canonical(url)] = result.state;
      manifest.fetched.push({
        url: canonical(url) || url,
        classification: result.classification,
        status: result.status ?? null,
      });
      return result;
    };

    // 1) robots.txt
    const robotsUrl = `${origin}/robots.txt`;
    manifest.robotsUrl = robotsUrl;
    let robotsRules = providedRobots;
    let robotsBody = '';
    if (robotsRules == null) {
      const robotsResult = await fetchUrl(robotsUrl, { respectRobots: false });
      if (['changed', 'unchanged'].includes(robotsResult.classification)) {
        robotsBody = robotsResult.body || '';
        robotsRules = parseRobotsTxt(robotsBody);
      } else {
        robotsRules = [];
      }
    } else if (typeof robotsRules === 'string') {
      robotsBody = robotsRules;
      robotsRules = parseRobotsTxt(robotsRules);
    }

    const sitemapSeeds = extractRobotsSitemaps(robotsBody, origin);
    const defaultSitemap = canonical(`${origin}/sitemap.xml`);
    if (defaultSitemap) sitemapSeeds.push(defaultSitemap);

    // 2) homepage → careers landing
    let careersUrl = null;
    if (canFetch()) {
      const homeResult = await fetchUrl(root, { robotsRules });
      if (['changed', 'unchanged'].includes(homeResult.classification)) {
        const homeBody = homeResult.body || '';
        careersUrl = discoverCareersLink(homeBody, root);
        for (const link of linksFromHtml(homeBody, root)) {
          if (!sameSite(link, root)) continue;
          const kind = classifyCareerUrl(link).kind;
          if (kind === 'job-sitemap' || kind === 'sitemap') sitemapSeeds.push(link);
        }
      }
    }
    if (!careersUrl) {
      // Prefer a careers-shaped root (e.g. https://jobs.example.com/) as the landing.
      if (CAREERS_LANDING_PATH.test(pathOf(root)) || /^(?:jobs|careers)\./i.test(hostOf(root))) {
        careersUrl = root;
      } else {
        careersUrl = canonical(`${origin}/careers`);
      }
    }
    manifest.careersUrl = careersUrl;

    if (careersUrl && careersUrl !== root && canFetch()) {
      const careersResult = await fetchUrl(careersUrl, { robotsRules });
      if (['changed', 'unchanged'].includes(careersResult.classification)) {
        for (const link of linksFromHtml(careersResult.body || '', careersUrl)) {
          if (!sameSite(link, root)) continue;
          const kind = classifyCareerUrl(link).kind;
          if (kind === 'job-sitemap' || kind === 'sitemap') sitemapSeeds.push(link);
        }
      }
    }

    // 3) crawl sitemaps: prefer job sitemaps; still open indexes; skip general leaf sitemaps' URL fan-out unless named as jobs
    const sitemapQueue = [...new Set(sitemapSeeds.map((u) => canonical(u)).filter(Boolean))];
    const sitemapSeen = new Set();
    const jobUrlEntries = []; // { url, sitemapLastMod, sourceUrl }

    while (sitemapQueue.length && canFetch()) {
      const sitemapUrl = sitemapQueue.shift();
      if (!sitemapUrl || sitemapSeen.has(sitemapUrl)) continue;
      sitemapSeen.add(sitemapUrl);

      const isJobNamed = isJobSitemapUrl(sitemapUrl);

      const result = await fetchUrl(sitemapUrl, { robotsRules });
      if (!['changed', 'unchanged'].includes(result.classification)) continue;
      if (isStaticContentType(contentTypeOf(result)) && !/xml|html|text/i.test(contentTypeOf(result))) {
        track('excludedStatic');
        continue;
      }

      track('sitemapsFetched');
      const entries = parseSitemapEntries(result.body || '', sitemapUrl);
      const hasIndexEntries = entries.some((entry) => entry.isSitemapIndexEntry);

      if (hasIndexEntries) {
        manifest.sitemaps.indexes.push(sitemapUrl);
        for (const entry of entries.filter((e) => e.isSitemapIndexEntry)) {
          if (entry.isJobSitemap || isJobSitemapUrl(entry.url)) {
            manifest.sitemaps.jobSitemaps.push(entry.url);
            if (!sitemapSeen.has(entry.url)) sitemapQueue.push(entry.url);
          } else {
            manifest.sitemaps.generalSitemaps.push(entry.url);
            // Follow nested indexes; leave general leaf sitemaps unexpanded to avoid marketing fan-out.
            if (/sitemap[-_]?index/i.test(pathOf(entry.url)) && !sitemapSeen.has(entry.url)) {
              sitemapQueue.push(entry.url);
            } else {
              track('generalSitemapsSkipped');
            }
          }
        }
        continue;
      }

      // Leaf urlset
      if (!isJobNamed && !isJobSitemapUrl(sitemapUrl)) {
        // General sitemap: only accept URLs that already look like job detail paths.
        track('generalSitemapsSkipped');
        manifest.sitemaps.generalSitemaps.push(sitemapUrl);
        for (const entry of entries) {
          if (isStaticAssetUrl(entry.url)) {
            track('excludedStatic');
            continue;
          }
          const classified = classifyCareerUrl(entry.url);
          if (classified.kind === 'job') {
            jobUrlEntries.push({ url: entry.url, sitemapLastMod: entry.lastmod, sourceUrl: sitemapUrl });
          } else if (classified.kind === 'marketing') {
            track('excludedMarketing');
          } else if (classified.kind === 'static-asset') {
            track('excludedStatic');
          } else {
            track('excludedOther');
          }
        }
        continue;
      }

      track('jobSitemapsFetched');
      if (!manifest.sitemaps.jobSitemaps.includes(sitemapUrl)) manifest.sitemaps.jobSitemaps.push(sitemapUrl);
      for (const entry of entries) {
        if (isStaticAssetUrl(entry.url)) {
          track('excludedStatic');
          continue;
        }
        if (!sameSite(entry.url, root) && hostOf(entry.url) !== hostOf(root)) {
          // Allow known job subdomains of the same registrable host only when path classifies as job.
        }
        const classified = classifyCareerUrl(entry.url);
        if (classified.kind === 'static-asset') {
          track('excludedStatic');
          continue;
        }
        if (classified.kind === 'marketing') {
          track('excludedMarketing');
          continue;
        }
        // From a job-named sitemap, accept job-detail paths and careers-shaped job URLs;
        // reject bare marketing / other.
        if (classified.kind === 'job' || classified.kind === 'careers-landing') {
          // Careers landing in a job sitemap is usually a listing page — only keep detail paths.
          if (classified.kind === 'careers-landing' && !JOB_DETAIL_PATH.test(pathOf(entry.url))) {
            track('excludedOther');
            continue;
          }
          jobUrlEntries.push({ url: entry.url, sitemapLastMod: entry.lastmod, sourceUrl: sitemapUrl });
        } else if (isJobNamed) {
          // Job sitemap may list SuccessFactors-style /job/ID paths already covered by JOB_DETAIL_PATH.
          // Paths with no signal stay excluded.
          track('excludedOther');
        } else {
          track('excludedOther');
        }
      }
    }

    // De-dupe job URLs and drop robots-disallowed targets before any detail fetch.
    const uniqueJobs = [];
    const jobSeen = new Set();
    for (const entry of jobUrlEntries) {
      const url = canonical(entry.url);
      if (!url || jobSeen.has(url)) continue;
      const robotsDecision = decideRobots(url, robotsRules, USER_AGENT);
      if (!robotsDecision.allowed) {
        track('disallowed');
        continue;
      }
      jobSeen.add(url);
      uniqueJobs.push({ ...entry, url });
    }
    companyTelemetry.jobUrlsDiscovered = uniqueJobs.length;
    telemetry.jobUrlsDiscovered += uniqueJobs.length;
    manifest.jobUrls = uniqueJobs.map((row) => row.url);

    const jobBudget = Math.min(limits.maxJobUrlsPerCompany, uniqueJobs.length);
    if (uniqueJobs.length > limits.maxJobUrlsPerCompany) {
      companyTelemetry.cappedJobUrls = true;
      telemetry.cappedJobUrls = true;
    }

    for (let i = 0; i < jobBudget; i += 1) {
      if (companyTelemetry.requests >= limits.maxRequests) {
        companyTelemetry.budgetExhausted = true;
        telemetry.budgetExhausted = true;
        break;
      }
      const entry = uniqueJobs[i];
      if (seenJobs.has(entry.url)) continue;

      const pre = classifyCareerUrl(entry.url);
      if (pre.kind === 'static-asset') {
        track('excludedStatic');
        continue;
      }
      if (pre.kind === 'marketing') {
        track('excludedMarketing');
        continue;
      }
      if (pre.kind !== 'job') {
        track('excludedOther');
        continue;
      }

      const resolution = await resolveJob({
        canonicalUrl: entry.url,
        discoveryUrl: entry.url,
        url: entry.url,
        company: companyName,
      });

      if (resolution.status !== 'resolved') {
        track('jobPagesUnverified');
        continue;
      }

      const finalUrl = resolution.originalApplicationUrl || entry.url;
      const listingClass = classifyOriginalListingUrl(finalUrl);
      if (!['ats', 'employer-career'].includes(listingClass.kind)) {
        track('excludedOther');
        continue;
      }

      const candidate = observationFromResolution({
        company: companyName,
        jobUrl: finalUrl,
        resolution,
        runAt,
        sitemapLastMod: entry.sitemapLastMod,
        sourceUrl: entry.sourceUrl,
      });
      if (!candidate) {
        track('jobPagesUnverified');
        continue;
      }

      // postedAt only from JobPosting datePosted (resolver patch); never from sitemap lastmod.
      if (!resolution.patch?.postedAt) candidate.postedAt = null;

      if (seenJobs.has(candidate.canonicalUrl)) continue;
      seenJobs.add(candidate.canonicalUrl);
      observations.push(candidate);
      track('jobPagesResolved');
    }

    manifest.status = companyTelemetry.budgetExhausted
      ? 'budget-exhausted'
      : companyTelemetry.cappedJobUrls
        ? 'capped'
        : observations.some((row) => row.company === companyName)
          ? 'succeeded'
          : 'empty';
    manifest.telemetry = companyTelemetry;
  }

  return {
    observations,
    manifest: {
      schemaVersion: CAREER_PAGE_DISCOVERY_VERSION,
      runAt,
      sources,
      telemetry,
      truncated: sources.some((source) => source.status === 'capped' || source.status === 'budget-exhausted'),
      interrupted: sources.some((source) => source.status === 'budget-exhausted'),
      capHit: telemetry.budgetExhausted ? 'maxRequests' : telemetry.cappedJobUrls ? 'maxJobUrlsPerCompany' : null,
      recordsNotExamined: sources.reduce((sum, source) => sum + Math.max(0, Number(source.telemetry?.jobUrlsDiscovered ?? 0) - limits.maxJobUrlsPerCompany), 0) || null,
    },
    telemetry,
    conditionalState: state,
    hostLimiterSnapshot: typeof limiter.snapshot === 'function' ? limiter.snapshot() : null,
  };
}

export default discoverCareerPages;
