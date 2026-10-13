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

// Synthetic fixtures mirror public career URL shapes; they are not live snapshots.
export const employerPages = {
  'https://jobs.birlasoft.com/': `<link rel="stylesheet" href="/static/careers.css?jobs=1">
    <a href="/about">About</a><a href="/services/digital?career=jobs">Services</a>
    <a href="/job/Pune-AI-Engineer/1001">AI Engineer</a><a href="/job/Pune-Backend-Engineer/1002">Backend Engineer</a>
    <a href="/images/jobs.svg">Logo</a><a href="mailto:jobs@birlasoft.com">Contact</a>
    <a href="https://jobs.external.io/assets/jobs.js">Asset</a>`,
  'https://jobs.birlasoft.com/sitemap.xml': `<urlset>
    <url><loc>/about</loc><lastmod>2026-10-12</lastmod></url>
    <url><loc>/static/careers.css</loc></url>
    <url><loc>/job/Pune-AI-Engineer/1001</loc><lastmod>2025-01-01</lastmod></url>
    <url><loc>/job/Pune-Backend-Engineer/1002</loc><lastmod>2026-10-12</lastmod></url>
    <url><loc>https://unrelated.io/jobs/invented</loc></url>
    <url><loc>/job/marketing/1003</loc></url>
  </urlset>`,
  'https://jobs.birlasoft.com/job/Pune-AI-Engineer/1001': `<h1>AI Engineer</h1>
    <span class="job-location text-muted">Pune, Maharashtra, India</span>
    <div class="content job-description"><p>Build Python APIs and AI tools. Required experience: 0-1 years.</p></div>`,
  'https://jobs.birlasoft.com/job/Pune-Backend-Engineer/1002': `<script type="application/ld+json">{
    "@type":"JobPosting","title":"Backend Engineer","description":"Build Python APIs. Required experience: 0-1 years.",
    "datePosted":"2026-10-12","dateModified":"2026-10-13","employmentType":"FULL_TIME",
    "url":"/job/Pune-Backend-Engineer/1002","jobLocation":{"address":{"addressLocality":"Pune","addressCountry":"India"}}}</script>`,
  'https://jobs.birlasoft.com/job/marketing/1003': `<h1>Our careers culture</h1><p>Join us to build the future.</p>`,
  'https://www.cybage.com/': `<a href="/careers/open-positions">Careers</a>`,
  'https://www.cybage.com/careers/open-positions': `<h1>Current openings</h1>
    <a href="/careers/open-positions/current-openings/python-developer">Python Developer</a>`,
  'https://www.cybage.com/careers/open-positions/current-openings/python-developer': `<nav>Location: Everywhere</nav>
    <h1>Python Developer</h1><p><strong>Location:</strong> Pune</p>
    <h2>Job Description</h2><p>Build backend services. Required experience: 0-1 years.</p>
    <h2>About Cybage</h2><p>Marketing content is not the JD.</p><footer>Full time jobs worldwide</footer>`,
  'https://www.cybage.com/sitemap.xml': `<sitemapindex><sitemap><loc>/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
  'https://www.cybage.com/sitemap-pages.xml': `<urlset>
    <url><loc>/services/digital-transformation</loc><lastmod>2026-10-12</lastmod></url>
    <url><loc>/industries/retail</loc></url><url><loc>/blog/ai-trends</loc></url>
    <url><loc>/careers/open-positions/current-openings/python-developer</loc><lastmod>2026-10-12</lastmod></url>
  </urlset>`,
};
