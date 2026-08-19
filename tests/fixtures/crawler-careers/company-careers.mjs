export const pages = {
  'https://acme.example/': `
    <a href="/about">About</a><a href="/careers">Careers</a>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"AI Engineer","url":"https://acme.example/jobs/ai-engineer?utm_source=home","datePosted":"2026-07-20","validThrough":"2026-08-20","description":"Build agents","hiringOrganization":{"name":"Acme"},"jobLocation":{"address":{"addressLocality":"Pune"}},"directApply":true,"sameAs":"https://jobs.acme.example/ai-engineer"}</script>
    <script type="application/ld+json">[{"@type":"JobPosting","title":"Backend Engineer","url":"/jobs/backend","datePosted":"2026-07-19","description":"Build APIs","hiringOrganization":{"name":"Acme"}}]</script>
    <script type="application/ld+json">{"@graph":[{"@type":"JobPosting","title":"Graph ML Engineer","url":"/jobs/graph","datePosted":"2026-07-18","description":"Build models","hiringOrganization":{"name":"Acme"}}]}</script>
    <script type="application/ld+json">{malformed</script>
    <link rel="alternate" type="application/rss+xml" href="/jobs.rss">
  `,
  'https://acme.example/careers': `<a href="/sitemap-index.xml">Sitemap</a><a href="https://boards.example/acme/lead">Open role</a>`,
  'https://acme.example/sitemap-index.xml': `<?xml version="1.0"?><sitemapindex><sitemap><loc>/sitemap-jobs.xml</loc><lastmod>2026-07-21</lastmod></sitemap></sitemapindex>`,
  'https://acme.example/sitemap-jobs.xml': `<?xml version="1.0"?><urlset><url><loc>https://acme.example/jobs/backend?ref=nav</loc><lastmod>2026-07-19</lastmod></url><url><loc>/jobs/expired</loc><lastmod>2025-01-01</lastmod></url><url><loc>/jobs/undated</loc></url></urlset>`,
  'https://acme.example/jobs.rss': `<rss><channel><item><title>RSS Lead</title><link>https://acme.example/jobs/rss-lead?utm_medium=x</link><pubDate>Mon, 21 Jul 2026 00:00:00 GMT</pubDate><description>RSS description</description></item></channel></rss>`,
  'https://acme.example/jobs/backend': `<script type="application/ld+json">{"@type":"JobPosting","title":"Backend Engineer","description":"Build APIs","datePosted":"2026-07-19","hiringOrganization":{"name":"Acme"},"jobLocation":{"address":{"addressLocality":"Pune"}},"url":"/jobs/backend"}</script>`,
};

export const responses = Object.fromEntries(Object.entries(pages).map(([url, body]) => [url, { status: 200, headers: { 'content-type': url.endsWith('.xml') || url.endsWith('.rss') ? 'application/xml' : 'text/html' }, body }]));
