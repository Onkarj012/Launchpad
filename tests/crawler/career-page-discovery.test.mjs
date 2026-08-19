import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCareerUrl,
  discoverCareerPages,
  isJobSitemapUrl,
  normalizeCareerPageDiscoveryBudget,
  parseSitemapEntries,
} from '../../crawler/career-page-discovery.mjs';

const RUN_AT = '2026-07-24T08:00:00.000Z';

// Avoid *.example / *.test / *.invalid hosts — original-listing-resolver treats those as reserved.
const jsonLdJob = (posting) => `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  ...posting,
})}</script>`;

const htmlPage = (body, title = 'Careers') => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
});

const xmlPage = (body) => ({
  status: 200,
  headers: { 'content-type': 'application/xml' },
  body,
});

function fixtureTransport(map) {
  return async (url) => map[url] ?? { status: 404, headers: {}, body: '' };
}

test('discovers careers landing link from homepage fixture', async () => {
  const transport = fixtureTransport({
    'https://acme.acmeco.io/robots.txt': {
      status: 200,
      headers: {},
      body: 'User-agent: *\nAllow: /\n',
    },
    'https://acme.acmeco.io/': htmlPage('<a href="/about">About</a><a href="/careers">Careers</a><a href="/blog">Blog</a>'),
    'https://acme.acmeco.io/careers': htmlPage('<p>Join Acme</p><a href="/sitemap-jobs.xml">Jobs sitemap</a>'),
    'https://acme.acmeco.io/sitemap.xml': xmlPage('<?xml version="1.0"?><urlset></urlset>'),
    'https://acme.acmeco.io/sitemap-jobs.xml': xmlPage('<?xml version="1.0"?><urlset></urlset>'),
  });

  const result = await discoverCareerPages({
    company: 'Acme',
    websiteUrl: 'https://acme.acmeco.io/',
    transport,
    runAt: RUN_AT,
    hostLimiterOptions: { minSpacingMs: 0, maxConcurrency: 1 },
    retry: { maxAttempts: 1 },
  });

  assert.equal(result.manifest.sources[0].careersUrl, 'https://acme.acmeco.io/careers');
});

test('respects robots.txt Disallow and never fetches blocked job URLs', async () => {
  const calls = [];
  const transport = async (url) => {
    calls.push(url);
    if (url === 'https://robots.acmeco.io/robots.txt') {
      return { status: 200, headers: {}, body: 'User-agent: *\nDisallow: /jobs/\nSitemap: https://robots.acmeco.io/sitemap-jobs.xml\n' };
    }
    if (url === 'https://robots.acmeco.io/' || url === 'https://robots.acmeco.io') {
      return htmlPage('<a href="/careers">Careers</a>');
    }
    if (url === 'https://robots.acmeco.io/careers') {
      return htmlPage('<a href="/sitemap-jobs.xml">sitemap</a>');
    }
    if (url === 'https://robots.acmeco.io/sitemap-jobs.xml') {
      return xmlPage(`<?xml version="1.0"?><urlset>
        <url><loc>https://robots.acmeco.io/jobs/secret-role</loc><lastmod>2026-07-20</lastmod></url>
      </urlset>`);
    }
    if (url === 'https://robots.acmeco.io/jobs/secret-role') {
      return htmlPage(jsonLdJob({ title: 'Secret', description: 'Hidden', datePosted: '2026-07-20' }), 'Secret');
    }
    return { status: 404, headers: {}, body: '' };
  };

  const result = await discoverCareerPages({
    company: 'Robots Co',
    websiteUrl: 'https://robots.acmeco.io/',
    transport,
    runAt: RUN_AT,
    hostLimiterOptions: { minSpacingMs: 0 },
    retry: { maxAttempts: 1 },
  });

  assert.equal(calls.includes('https://robots.acmeco.io/jobs/secret-role'), false);
  assert.equal(result.observations.length, 0);
  assert.ok(result.telemetry.disallowed >= 1);
  assert.equal(result.manifest.sources[0].jobUrls.includes('https://robots.acmeco.io/jobs/secret-role'), false);
});

test('follows sitemap index → job sitemap → individual job URL chain', async () => {
  const transport = fixtureTransport({
    'https://chain.acmeco.io/robots.txt': {
      status: 200,
      headers: {},
      body: 'User-agent: *\nAllow: /\nSitemap: https://chain.acmeco.io/sitemap-index.xml\n',
    },
    'https://chain.acmeco.io/': htmlPage('<a href="/careers">Careers</a>'),
    'https://chain.acmeco.io/careers': htmlPage('<p>Open roles</p>'),
    'https://chain.acmeco.io/sitemap-index.xml': xmlPage(`<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>https://chain.acmeco.io/sitemap-jobs.xml</loc></sitemap>
      <sitemap><loc>https://chain.acmeco.io/sitemap-pages.xml</loc></sitemap>
    </sitemapindex>`),
    'https://chain.acmeco.io/sitemap-jobs.xml': xmlPage(`<?xml version="1.0"?><urlset>
      <url><loc>https://chain.acmeco.io/jobs/ai-engineer</loc><lastmod>2026-07-21T00:00:00.000Z</lastmod></url>
    </urlset>`),
    'https://chain.acmeco.io/sitemap-pages.xml': xmlPage(`<?xml version="1.0"?><urlset>
      <url><loc>https://chain.acmeco.io/about</loc></url>
    </urlset>`),
    'https://chain.acmeco.io/sitemap.xml': xmlPage('<?xml version="1.0"?><urlset></urlset>'),
    'https://chain.acmeco.io/jobs/ai-engineer': htmlPage(jsonLdJob({
      title: 'AI Engineer',
      description: 'Build agents in Pune.',
      datePosted: '2026-07-21',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'IN' } },
      employmentType: 'FULL_TIME',
      url: 'https://chain.acmeco.io/jobs/ai-engineer',
    }), 'AI Engineer'),
  });

  const result = await discoverCareerPages({
    company: 'Chain Co',
    websiteUrl: 'https://chain.acmeco.io/',
    transport,
    runAt: RUN_AT,
    hostLimiterOptions: { minSpacingMs: 0 },
    retry: { maxAttempts: 1 },
  });

  const source = result.manifest.sources[0];
  assert.ok(source.sitemaps.indexes.includes('https://chain.acmeco.io/sitemap-index.xml'));
  assert.ok(source.sitemaps.jobSitemaps.includes('https://chain.acmeco.io/sitemap-jobs.xml'));
  assert.ok(source.jobUrls.includes('https://chain.acmeco.io/jobs/ai-engineer'));
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].title, 'AI Engineer');
  assert.equal(result.observations[0].location, 'Pune, IN');
});

test('distinguishes job sitemaps from general sitemaps by URL pattern', () => {
  assert.equal(isJobSitemapUrl('https://ex.acmeco.io/sitemap-jobs.xml'), true);
  assert.equal(isJobSitemapUrl('https://ex.acmeco.io/jobs-sitemap.xml'), true);
  assert.equal(isJobSitemapUrl('https://ex.acmeco.io/careers-sitemap.xml'), true);
  assert.equal(isJobSitemapUrl('https://ex.acmeco.io/sitemap.xml'), false);
  assert.equal(isJobSitemapUrl('https://ex.acmeco.io/sitemap-pages.xml'), false);
  assert.equal(isJobSitemapUrl('https://ex.acmeco.io/sitemap-index.xml'), false);

  const entries = parseSitemapEntries(`<?xml version="1.0"?><sitemapindex>
    <sitemap><loc>/sitemap-jobs.xml</loc></sitemap>
    <sitemap><loc>/sitemap.xml</loc></sitemap>
  </sitemapindex>`, 'https://ex.acmeco.io/');
  assert.equal(entries.find((e) => e.url.includes('sitemap-jobs')).isJobSitemap, true);
  assert.equal(entries.find((e) => e.url.endsWith('/sitemap.xml')).isJobSitemap, false);
});

test('excludes static asset URLs from job observations', async () => {
  assert.equal(classifyCareerUrl('https://jobs.staticco.acmeco.io/static/app.css').kind, 'static-asset');
  assert.equal(classifyCareerUrl('https://jobs.staticco.acmeco.io/assets/logo.png').kind, 'static-asset');
  assert.equal(classifyCareerUrl('https://jobs.staticco.acmeco.io/bundle.js').kind, 'static-asset');

  const transport = fixtureTransport({
    'https://jobs.staticco.acmeco.io/robots.txt': {
      status: 200,
      headers: {},
      body: 'User-agent: *\nAllow: /\nSitemap: https://jobs.staticco.acmeco.io/sitemap-jobs.xml\n',
    },
    'https://jobs.staticco.acmeco.io/': htmlPage('<link href="/assets/site.css" rel="stylesheet"><a href="/careers">Careers</a>'),
    'https://jobs.staticco.acmeco.io/careers': htmlPage('<script src="/js/app.js"></script>'),
    'https://jobs.staticco.acmeco.io/sitemap-jobs.xml': xmlPage(`<?xml version="1.0"?><urlset>
      <url><loc>https://jobs.staticco.acmeco.io/assets/site.css</loc></url>
      <url><loc>https://jobs.staticco.acmeco.io/js/app.js</loc></url>
      <url><loc>https://jobs.staticco.acmeco.io/jobs/real-role</loc><lastmod>2026-07-22T00:00:00.000Z</lastmod></url>
    </urlset>`),
    'https://jobs.staticco.acmeco.io/sitemap.xml': xmlPage('<?xml version="1.0"?><urlset></urlset>'),
    'https://jobs.staticco.acmeco.io/jobs/real-role': htmlPage(jsonLdJob({
      title: 'Real Role',
      description: 'Ship code.',
      datePosted: '2026-07-22',
      jobLocation: { address: { addressLocality: 'Pune' } },
      url: 'https://jobs.staticco.acmeco.io/jobs/real-role',
    }), 'Real Role'),
  });

  const calls = [];
  const wrapped = async (url) => {
    calls.push(url);
    return transport(url);
  };

  const result = await discoverCareerPages({
    company: 'Static Co',
    websiteUrl: 'https://jobs.staticco.acmeco.io/',
    transport: wrapped,
    runAt: RUN_AT,
    hostLimiterOptions: { minSpacingMs: 0 },
    retry: { maxAttempts: 1 },
  });

  assert.equal(calls.some((url) => url.endsWith('.css') || url.endsWith('.js')), false);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].title, 'Real Role');
  assert.ok(result.telemetry.excludedStatic >= 2);
});

test('excludes marketing/about pages via path+metadata, not hostname substring', async () => {
  // Hostname contains "jobs" — must not promote /about into a job observation.
  assert.equal(classifyCareerUrl('https://jobs.market.acmeco.io/about').kind, 'marketing');
  assert.equal(classifyCareerUrl('https://jobs.market.acmeco.io/blog/launch').kind, 'marketing');
  assert.equal(classifyCareerUrl('https://jobs.market.acmeco.io/jobs/backend-engineer').kind, 'job');

  const transport = fixtureTransport({
    'https://jobs.market.acmeco.io/robots.txt': {
      status: 200,
      headers: {},
      body: 'User-agent: *\nAllow: /\nSitemap: https://jobs.market.acmeco.io/sitemap-jobs.xml\n',
    },
    'https://jobs.market.acmeco.io/': htmlPage('<a href="/careers">Careers</a><a href="/about">About</a>'),
    'https://jobs.market.acmeco.io/careers': htmlPage('<p>Work with us</p>'),
    'https://jobs.market.acmeco.io/sitemap-jobs.xml': xmlPage(`<?xml version="1.0"?><urlset>
      <url><loc>https://jobs.market.acmeco.io/about</loc></url>
      <url><loc>https://jobs.market.acmeco.io/services/digital-transformation</loc></url>
      <url><loc>https://jobs.market.acmeco.io/jobs/backend-engineer</loc><lastmod>2026-07-18T00:00:00.000Z</lastmod></url>
    </urlset>`),
    'https://jobs.market.acmeco.io/sitemap.xml': xmlPage('<?xml version="1.0"?><urlset></urlset>'),
    'https://jobs.market.acmeco.io/about': htmlPage('<p>We transform industries.</p>', 'About Us'),
    'https://jobs.market.acmeco.io/services/digital-transformation': htmlPage('<p>Retail digital</p>', 'Digital Transformation'),
    'https://jobs.market.acmeco.io/jobs/backend-engineer': htmlPage(jsonLdJob({
      title: 'Backend Engineer',
      description: 'APIs in Pune.',
      datePosted: '2026-07-18',
      jobLocation: { address: { addressLocality: 'Pune' } },
      url: 'https://jobs.market.acmeco.io/jobs/backend-engineer',
    }), 'Backend Engineer'),
  });

  const result = await discoverCareerPages({
    company: 'Market Co',
    websiteUrl: 'https://jobs.market.acmeco.io/',
    transport,
    runAt: RUN_AT,
    hostLimiterOptions: { minSpacingMs: 0 },
    retry: { maxAttempts: 1 },
  });

  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].title, 'Backend Engineer');
  assert.equal(result.observations.some((row) => /about|digital|transform/i.test(row.title)), false);
  assert.ok(result.telemetry.excludedMarketing >= 1);
});

test('reuses JSON-LD JobPosting extraction for a discovered job URL', async () => {
  const transport = fixtureTransport({
    'https://jsonld.acmeco.io/robots.txt': {
      status: 200,
      headers: {},
      body: 'User-agent: *\nAllow: /\nSitemap: https://jsonld.acmeco.io/sitemap-jobs.xml\n',
    },
    'https://jsonld.acmeco.io/': htmlPage('<a href="/careers">Careers</a>'),
    'https://jsonld.acmeco.io/careers': htmlPage('<p>Jobs</p>'),
    'https://jsonld.acmeco.io/sitemap-jobs.xml': xmlPage(`<?xml version="1.0"?><urlset>
      <url><loc>https://jsonld.acmeco.io/jobs/ml-engineer</loc></url>
    </urlset>`),
    'https://jsonld.acmeco.io/sitemap.xml': xmlPage('<?xml version="1.0"?><urlset></urlset>'),
    'https://jsonld.acmeco.io/jobs/ml-engineer': htmlPage(jsonLdJob({
      title: 'ML Engineer',
      description: '<p>Train models. 2+ years experience preferred.</p>',
      datePosted: '2026-07-19',
      validThrough: '2026-08-19',
      employmentType: 'full-time',
      jobLocation: { address: { addressLocality: 'Pune', addressRegion: 'MH', addressCountry: 'IN' } },
      hiringOrganization: { name: 'JSONLD Co' },
      url: 'https://jsonld.acmeco.io/jobs/ml-engineer',
    }), 'ML Engineer'),
  });

  const result = await discoverCareerPages({
    company: 'JSONLD Co',
    websiteUrl: 'https://jsonld.acmeco.io/',
    transport,
    runAt: RUN_AT,
    hostLimiterOptions: { minSpacingMs: 0 },
    retry: { maxAttempts: 1 },
  });

  assert.equal(result.observations.length, 1);
  const row = result.observations[0];
  assert.equal(row.title, 'ML Engineer');
  assert.match(row.description, /Train models/);
  assert.equal(row.location, 'Pune, MH, IN');
  assert.equal(row.employment?.type, 'full-time');
  assert.equal(row.postedAt, '2026-07-19T00:00:00.000Z');
  assert.equal(row.originalApplicationUrl, 'https://jsonld.acmeco.io/jobs/ml-engineer');
  assert.equal(row.evidence.classification, 'direct');
  assert.ok(row.evidence.fieldSources?.title || row.evidence.resolver);
});

test('tags sitemap lastmod as modification evidence and never as postedAt', async () => {
  const lastmod = '2026-01-01T00:00:00.000Z';
  const transport = fixtureTransport({
    'https://lastmod.acmeco.io/robots.txt': {
      status: 200,
      headers: {},
      body: 'User-agent: *\nAllow: /\nSitemap: https://lastmod.acmeco.io/sitemap-jobs.xml\n',
    },
    'https://lastmod.acmeco.io/': htmlPage('<a href="/careers">Careers</a>'),
    'https://lastmod.acmeco.io/careers': htmlPage('<p>Jobs</p>'),
    'https://lastmod.acmeco.io/sitemap-jobs.xml': xmlPage(`<?xml version="1.0"?><urlset>
      <url><loc>https://lastmod.acmeco.io/jobs/undated-role</loc><lastmod>${lastmod}</lastmod></url>
      <url><loc>https://lastmod.acmeco.io/jobs/dated-role</loc><lastmod>${lastmod}</lastmod></url>
    </urlset>`),
    'https://lastmod.acmeco.io/sitemap.xml': xmlPage('<?xml version="1.0"?><urlset></urlset>'),
    'https://lastmod.acmeco.io/jobs/undated-role': htmlPage(jsonLdJob({
      title: 'Undated Role',
      description: 'No datePosted in JSON-LD.',
      jobLocation: { address: { addressLocality: 'Pune' } },
      url: 'https://lastmod.acmeco.io/jobs/undated-role',
    }), 'Undated Role'),
    'https://lastmod.acmeco.io/jobs/dated-role': htmlPage(jsonLdJob({
      title: 'Dated Role',
      description: 'Has datePosted.',
      datePosted: '2026-07-15',
      jobLocation: { address: { addressLocality: 'Pune' } },
      url: 'https://lastmod.acmeco.io/jobs/dated-role',
    }), 'Dated Role'),
  });

  const result = await discoverCareerPages({
    company: 'Lastmod Co',
    websiteUrl: 'https://lastmod.acmeco.io/',
    transport,
    runAt: RUN_AT,
    hostLimiterOptions: { minSpacingMs: 0 },
    retry: { maxAttempts: 1 },
  });

  assert.equal(result.observations.length, 2);
  const undated = result.observations.find((row) => row.title === 'Undated Role');
  const dated = result.observations.find((row) => row.title === 'Dated Role');
  assert.equal(undated.postedAt, null);
  assert.equal(undated.evidence.sitemapLastMod, lastmod);
  assert.equal(undated.evidence.pageModification?.kind, 'sitemap-lastmod');
  assert.notEqual(undated.postedAt, lastmod);
  assert.equal(dated.postedAt, '2026-07-15T00:00:00.000Z');
  assert.equal(dated.evidence.sitemapLastMod, lastmod);
  assert.notEqual(dated.postedAt, lastmod);
});

test('respects bounded request budget and exposes telemetry', async () => {
  const budget = normalizeCareerPageDiscoveryBudget({
    careerPageDiscovery: { maxRequests: 6, maxJobUrlsPerCompany: 20, maxPagesPerCompany: 20, maxBytes: 2_000_000, maxHosts: 2, maxRedirects: 2 },
  });
  assert.equal(budget.maxRequests, 6);

  const jobUrls = Array.from({ length: 10 }, (_, i) => `https://budget.acmeco.io/jobs/role-${i + 1}`);
  const pages = {
    'https://budget.acmeco.io/robots.txt': {
      status: 200,
      headers: {},
      body: 'User-agent: *\nAllow: /\nSitemap: https://budget.acmeco.io/sitemap-jobs.xml\n',
    },
    'https://budget.acmeco.io/': htmlPage('<a href="/careers">Careers</a>'),
    'https://budget.acmeco.io/careers': htmlPage('<p>Jobs</p>'),
    'https://budget.acmeco.io/sitemap-jobs.xml': xmlPage(`<?xml version="1.0"?><urlset>${
      jobUrls.map((url) => `<url><loc>${url}</loc></url>`).join('')
    }</urlset>`),
    'https://budget.acmeco.io/sitemap.xml': xmlPage('<?xml version="1.0"?><urlset></urlset>'),
  };
  for (const url of jobUrls) {
    pages[url] = htmlPage(jsonLdJob({
      title: 'Budget Role',
      description: 'Bounded.',
      datePosted: '2026-07-20',
      url,
    }), 'Budget Role');
  }

  const calls = [];
  const transport = async (url) => {
    calls.push(url);
    return pages[url] ?? { status: 404, headers: {}, body: '' };
  };

  const result = await discoverCareerPages({
    company: 'Budget Co',
    websiteUrl: 'https://budget.acmeco.io/',
    transport,
    runAt: RUN_AT,
    maxRequests: 6,
    maxJobUrlsPerCompany: 20,
    hostLimiterOptions: { minSpacingMs: 0, maxConcurrency: 1 },
    retry: { maxAttempts: 1 },
  });

  assert.ok(result.telemetry.requests <= 6);
  assert.ok(calls.length <= 6);
  assert.equal(result.telemetry.budgetExhausted, true);
  assert.equal(result.telemetry.budget.maxRequests, 6);
  assert.ok(result.hostLimiterSnapshot instanceof Map || result.hostLimiterSnapshot == null || typeof result.hostLimiterSnapshot === 'object');
});

test('Birlasoft fixture: verified Pune job observations from job inventory, not marketing/static', async () => {
  // Mirrors the disabledCareerSites failure mode: jobs.* hostname must not pull CSS/JS into the job queue.
  const transport = fixtureTransport({
    'https://jobs.birlasoft.com/robots.txt': {
      status: 200,
      headers: {},
      body: `User-agent: *
Allow: /
Sitemap: https://jobs.birlasoft.com/sitemap.xml
Sitemap: https://jobs.birlasoft.com/sitemap-jobs.xml
`,
    },
    'https://jobs.birlasoft.com/': htmlPage(`
      <link rel="stylesheet" href="/static/careers.css">
      <script src="/static/jobs-bundle.js"></script>
      <img src="/images/jobs-hero.png" alt="">
      <a href="/careers">Careers</a>
      <a href="/about">About Birlasoft</a>
    `, 'Birlasoft Careers'),
    'https://jobs.birlasoft.com/careers': htmlPage('<p>Explore openings</p><a href="/sitemap-jobs.xml">Job sitemap</a>'),
    'https://jobs.birlasoft.com/sitemap.xml': xmlPage(`<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>https://jobs.birlasoft.com/sitemap-jobs.xml</loc></sitemap>
      <sitemap><loc>https://jobs.birlasoft.com/sitemap-pages.xml</loc></sitemap>
    </sitemapindex>`),
    'https://jobs.birlasoft.com/sitemap-jobs.xml': xmlPage(`<?xml version="1.0"?><urlset>
      <url><loc>https://jobs.birlasoft.com/job/Pune-AI-Engineer/1001</loc><lastmod>2026-06-01T00:00:00.000Z</lastmod></url>
      <url><loc>https://jobs.birlasoft.com/job/Pune-Full-Stack-Engineer/1002</loc><lastmod>2026-06-02T00:00:00.000Z</lastmod></url>
      <url><loc>https://jobs.birlasoft.com/static/careers.css</loc></url>
    </urlset>`),
    'https://jobs.birlasoft.com/sitemap-pages.xml': xmlPage(`<?xml version="1.0"?><urlset>
      <url><loc>https://jobs.birlasoft.com/about</loc></url>
      <url><loc>https://jobs.birlasoft.com/services/digital</loc></url>
    </urlset>`),
    'https://jobs.birlasoft.com/job/Pune-AI-Engineer/1001': htmlPage(jsonLdJob({
      title: 'AI Engineer',
      description: 'Build enterprise AI solutions for Pune delivery center.',
      datePosted: '2026-07-10',
      employmentType: 'FULL_TIME',
      jobLocation: { address: { addressLocality: 'Pune', addressRegion: 'Maharashtra', addressCountry: 'IN' } },
      hiringOrganization: { name: 'Birlasoft' },
      url: 'https://jobs.birlasoft.com/job/Pune-AI-Engineer/1001',
    }), 'AI Engineer - Birlasoft'),
    'https://jobs.birlasoft.com/job/Pune-Full-Stack-Engineer/1002': htmlPage(jsonLdJob({
      title: 'Full Stack Engineer',
      description: 'Ship full-stack products from Hinjawadi, Pune.',
      datePosted: '2026-07-12',
      employmentType: 'FULL_TIME',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'IN' } },
      hiringOrganization: { name: 'Birlasoft' },
      url: 'https://jobs.birlasoft.com/job/Pune-Full-Stack-Engineer/1002',
    }), 'Full Stack Engineer - Birlasoft'),
    'https://jobs.birlasoft.com/about': htmlPage('<p>About Birlasoft</p>', 'About'),
    'https://jobs.birlasoft.com/services/digital': htmlPage('<p>Digital services</p>', 'Digital'),
  });

  const calls = [];
  const wrapped = async (url) => {
    calls.push(url);
    return transport(url);
  };

  const result = await discoverCareerPages({
    company: 'Birlasoft',
    websiteUrl: 'https://jobs.birlasoft.com/',
    rootDomain: 'jobs.birlasoft.com',
    transport: wrapped,
    runAt: RUN_AT,
    hostLimiterOptions: { minSpacingMs: 0 },
    retry: { maxAttempts: 1 },
  });

  assert.ok(result.observations.length >= 2);
  for (const row of result.observations) {
    assert.match(row.location, /Pune/i);
    assert.equal(row.company, 'Birlasoft');
    assert.equal(row.provider, 'career-page-discovery');
    assert.ok(row.description);
    assert.ok(row.postedAt);
    assert.ok(row.evidence.sitemapLastMod);
    assert.notEqual(row.postedAt, row.evidence.sitemapLastMod);
  }
  assert.equal(result.observations.some((row) => /about|digital|css|bundle/i.test(row.title)), false);
  assert.equal(calls.some((url) => /\.(css|js|png)(?:$|\?)/i.test(url)), false);
  assert.ok(result.telemetry.excludedStatic >= 1);
});

test('Cybage fixture: only genuine role observations, zero marketing-page false positives', async () => {
  // Mirrors the disabledCareerSites failure mode: general sitemap marketing URLs must not become jobs.
  const transport = fixtureTransport({
    'https://www.cybage.com/robots.txt': {
      status: 200,
      headers: {},
      body: `User-agent: *
Allow: /
Sitemap: https://www.cybage.com/sitemap.xml
`,
    },
    'https://www.cybage.com/': htmlPage('<a href="/careers/open-positions">Careers</a><a href="/about-us">About</a>'),
    'https://www.cybage.com/careers/open-positions': htmlPage('<p>Current openings</p><a href="/careers/open-positions/current-openings/c-developer">C Developer</a>'),
    'https://www.cybage.com/sitemap.xml': xmlPage(`<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>https://www.cybage.com/sitemap-jobs.xml</loc></sitemap>
      <sitemap><loc>https://www.cybage.com/sitemap-pages.xml</loc></sitemap>
    </sitemapindex>`),
    'https://www.cybage.com/sitemap-jobs.xml': xmlPage(`<?xml version="1.0"?><urlset>
      <url><loc>https://www.cybage.com/careers/open-positions/current-openings/c-developer</loc><lastmod>2026-06-08T00:00:00.000Z</lastmod></url>
      <url><loc>https://www.cybage.com/careers/open-positions/current-openings/python-developer</loc><lastmod>2026-06-09T00:00:00.000Z</lastmod></url>
    </urlset>`),
    'https://www.cybage.com/sitemap-pages.xml': xmlPage(`<?xml version="1.0"?><urlset>
      <url><loc>https://www.cybage.com/about-us</loc></url>
      <url><loc>https://www.cybage.com/services/digital-transformation</loc></url>
      <url><loc>https://www.cybage.com/industries/retail</loc></url>
      <url><loc>https://www.cybage.com/blog/ai-trends</loc></url>
    </urlset>`),
    'https://www.cybage.com/careers/open-positions/current-openings/c-developer': htmlPage(jsonLdJob({
      title: 'C Developer',
      description: 'Systems programming for Pune product teams.',
      datePosted: '2026-07-08',
      employmentType: 'FULL_TIME',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'IN' } },
      hiringOrganization: { name: 'Cybage Software' },
      url: 'https://www.cybage.com/careers/open-positions/current-openings/c-developer',
    }), 'C Developer | Cybage'),
    'https://www.cybage.com/careers/open-positions/current-openings/python-developer': htmlPage(jsonLdJob({
      title: 'Python Developer',
      description: 'Backend Python services in Pune.',
      datePosted: '2026-07-09',
      employmentType: 'FULL_TIME',
      jobLocation: { address: { addressLocality: 'Pune', addressCountry: 'IN' } },
      hiringOrganization: { name: 'Cybage Software' },
      url: 'https://www.cybage.com/careers/open-positions/current-openings/python-developer',
    }), 'Python Developer | Cybage'),
    'https://www.cybage.com/about-us': htmlPage('<p>About Cybage</p>', 'About Us'),
    'https://www.cybage.com/services/digital-transformation': htmlPage('<p>Digital Transformation</p>', 'Digital Transformation'),
    'https://www.cybage.com/industries/retail': htmlPage('<p>Retail</p>', 'Retail'),
    'https://www.cybage.com/blog/ai-trends': htmlPage('<p>AI trends</p>', 'AI Trends'),
  });

  const result = await discoverCareerPages({
    company: 'Cybage Software',
    websiteUrl: 'https://www.cybage.com/',
    rootDomain: 'cybage.com',
    transport,
    runAt: RUN_AT,
    hostLimiterOptions: { minSpacingMs: 0 },
    retry: { maxAttempts: 1 },
  });

  assert.equal(result.observations.length, 2);
  const titles = result.observations.map((row) => row.title).sort();
  assert.deepEqual(titles, ['C Developer', 'Python Developer']);
  for (const row of result.observations) {
    assert.match(row.location, /Pune/i);
    assert.ok(row.description);
    assert.equal(row.evidence.classification, 'direct');
  }
  const marketingTitles = ['Digital Transformation', 'Retail', 'About Us', 'AI Trends'];
  assert.equal(result.observations.some((row) => marketingTitles.includes(row.title)), false);
  assert.ok(result.telemetry.generalSitemapsSkipped >= 1 || result.manifest.sources[0].sitemaps.generalSitemaps.length >= 1);
});
