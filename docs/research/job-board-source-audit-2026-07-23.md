# Job-board and source audit for Launchpad Crawler v2

Date: 2026-07-23  
Profile: Pune-based 2026 new graduate, 0–1 years, AI/LLM, ML, Python backend, AI-leaning full-stack, and new-grad SWE  
Scope: source coverage and integration strategy only. This note does **not** propose weakening geography, experience, freshness, liveness, compensation, deduplication, or original-application gates.

## Executive finding

Launchpad does not primarily have a gate problem. It has an activation and board-registry problem.

The crawler has reusable implementations for 3 warm ATS providers, 4 expanded ATS providers, 6 second-batch ATS providers, 7 enterprise/custom providers, company career pages, web search, Indeed inbox imports, and India-startup lanes. Production configuration activates only:

- 19 warm boards: 10 Greenhouse, 3 Lever, and 6 Ashby;
- 2 SmartRecruiters boards;
- SearXNG with 20 queries/day.

The Batch 2 registry, enterprise registry, and generic career-site registry are empty; India startup discovery and Indeed import are disabled. This is visible directly in the [production crawler configuration](../../config/crawler-v2.json). The temporary Codex plugin/web bridge is useful for calibration, but it is not yet a durable production lane.

The best next source work is therefore:

1. populate the existing enterprise and Batch 2 registries with verified India/Pune boards;
2. activate real startup source functions;
3. update the Himalayas adapter to its current search API contract;
4. add sanctioned broad India APIs or public sitemaps as **lead generators**, never as application-ready authorities;
5. route all of these through the unchanged Launchpad gates.

## What the crawler actually covers today

| Source class | Implemented capability | Production activation | Retrieval efficiency | Quality and likely yield |
|---|---|---:|---|---|
| Greenhouse, Lever, Ashby | Direct public JSON boards through [`ats-warm.mjs`](../../crawler/ats-warm.mjs) | 19 total warm boards across these providers | High: normally one bounded structured request per board, stable provider IDs and direct URLs | Highest precision; good Normal and Startup coverage, but only the configured employers are visible |
| SmartRecruiters | List pagination plus optional detail enrichment through [`ats-batch-1.mjs`](../../crawler/ats-batch-1.mjs) | Bosch and Visa only | Medium: one list request plus detail requests for enriched records | High precision, but current two-board breadth is too narrow for a dependable daily Pune/new-grad yield |
| Workable, Teamtailor, Recruitee | Adapters exist in Batch 1 | No boards configured | Zero operational yield | Potentially valuable, especially Workable/Recruitee; implementation availability is not coverage |
| Breezy, BambooHR, Personio, Comeet, Pinpoint, Rippling | Structured adapters exist in [`ats-batch-2.mjs`](../../crawler/ats-batch-2.mjs) | Zero boards configured | Zero operational yield | Useful long tail, with Pinpoint/Recruitee-style feeds especially clean; needs a verified board registry |
| Workday, SuccessFactors, Phenom, iCIMS, Jobvite, Oracle, custom JSON-LD | Enterprise adapter exists in [`ats-enterprise.mjs`](../../crawler/ats-enterprise.mjs) | Zero boards configured | Zero operational yield | Important for Pune enterprises; Workday has already produced useful Pune leads during manual discovery |
| Generic employer career pages | Sitemap, HTML and `JobPosting` JSON-LD discovery through [`company-careers.mjs`](../../crawler/company-careers.mjs) | Zero career sites configured | Zero operational yield | Broadest way to cover Freshteam, Zoho Recruit and custom sites without a provider-specific scraper |
| SearXNG | 20 bounded queries, maximum 10 results/query | Enabled | High discovery breadth for low request volume; at most 200 raw search observations before dedupe | Leads only. Every item still needs original employer/ATS resolution, liveness, date and gate verification |
| Indeed | Dated connector inbox with idempotent import and original-link resolution | Disabled | Efficient when connector exports exist | Useful rescue recall; it must remain a lead source rather than an authority |
| India startup lane | Cutshort, Wellfound, YC and related request abstractions | Disabled and request list empty | Zero operational yield | The lane exists structurally but is not a real source until requests/source functions are supplied |
| Remote feeds | Himalayas, Jobicy, We Work Remotely and Remotive adapters exist in the separate v5 remote workflow | Not part of the current crawler operator source plan | Efficient structured feeds, but not yet a crawler-v2 production input | Good remote recall; India eligibility and original destination still need verification |
| Apna, WhatJobs, LinkedIn, Indeed Codex plugins | Temporary interactive discovery | Not durable crawler sources | High operator cost relative to repeatable feeds | Useful shortage probes; recent calibration showed low precision from Apna/WhatJobs for this technical fresher profile |

The official provider contracts support the structured-first design:

- Greenhouse exposes its Job Board API publicly without authentication. [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html)
- Lever documents published postings as public and exposes JSON fields including hosted and apply URLs. [Lever Postings API](https://github.com/lever/postings-api)
- Ashby’s public job-board API includes published time, workplace type, location, employment type, compensation and apply URL. [Ashby public job-posting API](https://developers.ashbyhq.com/docs/public-job-posting-api)
- SmartRecruiters exposes public postings and query/filter capabilities, although its current Posting API documentation describes API-key authentication for customer integrations. Existing anonymous endpoints must therefore be live-probed per company rather than assumed. [SmartRecruiters Posting API](https://developers.smartrecruiters.com/docs/posting-api)

## How crawler v2 should serve each mode

Crawler v2 currently accepts `morning` and `midday` schedules; it does not accept `normal`, `startup`, `remote`, or `pune` as production source-plan modes. The v5 mode implementations are separate modules. Incorporation should make crawler output a common discovery substrate while preserving mode-specific selection.

| Mode | Source plan | Mode-specific treatment | What crawler v2 adds |
|---|---|---|---|
| Normal / regular India | Warm ATS every run; expanded ATS, enterprise boards, career pages, SearXNG and connector inbox in the morning | India-permitted geography, 0–2 years, strict freshness and original listing | Durable first/last-seen history, source health, cross-source dedupe and one verification queue |
| Startup | Warm startup-tagged Ashby/Greenhouse/Lever boards; Workable/Recruitee; YC India; VC portfolio pages; bounded startup web search | Startup score/composition changes, but ordinary eligibility does not | Converts repeated startup discoveries into permanent direct-board entries instead of re-searching them daily |
| Remote | Remote-capable direct ATS plus Himalayas, WWR, Jobicy and Remotive; YC remote discovery | Require explicit India/worldwide eligibility, timezone compatibility and stable paid employment | Durable provider-date evidence and suppression of “remote” roles that are actually US/EU-only |
| Pune-specific | Pune employer watchlist across Workday, SmartRecruiters, Workable, Recruitee, Greenhouse, Lever and custom career pages; Pune-targeted SearXNG | Pune/PCMC/hybrid/on-site first; India-remote may be a labelled expansion, not a silent geo relaxation | High-frequency monitoring of local employers and automatic promotion of newly discovered Pune boards |
| Midday | Warm ATS and the cheapest/highest-yield direct sources only | Same gates and freshness contract | Low-cost delta scan using conditional state; no need to rerun every long-tail source |

A clean integration boundary is:

```text
mode-specific source plan
        ↓
crawler observations and durable identity
        ↓
original-listing resolution + liveness + freshness
        ↓
unchanged shared gates
        ↓
normal/startup/remote/Pune ranking and composition
        ↓
v5 handoff plan
```

This prevents “try more” from becoming “accept worse.” A source may increase the verification queue without increasing the application-ready shortlist.

## Highest-value sources to activate or add

### P0 — populate capabilities that already exist

#### 1. Workday and other Pune enterprise boards

**Modes:** Pune, Normal  
**Why first:** The enterprise adapter exists but its registry is empty. Manual discovery already found useful Pune listings on employer-owned Workday sites. This is the most direct route to more verified local inventory.

Start with verified Pune/India employers found during calibration (for example, Ingram Micro, ReliaQuest, Mastercard and Pitney Bowes), then add product and engineering employers from the target-company list. Workday’s external-career interface is tenant-specific and not a documented public job-search API, so every tenant/site tuple needs a bounded integration probe and date-field verification.

**Cost:** low configuration cost; medium verification cost.  
**Expected incremental yield:** high relative to the current zero-board enterprise lane.

#### 2. Workable and Recruitee boards

**Modes:** Pune, Normal, Startup

Workable officially documents public account endpoints for published jobs and optional job details; its authenticated customer API is not required for a public careers-page reader. [Workable careers-page API guide](https://help.workable.com/hc/en-us/articles/115012771647-Using-the-Workable-API-to-create-a-careers-page)

Recruitee’s Careers Site API explicitly requires no authorization, and `/api/offers/` returns published company jobs. [Recruitee Careers Site API](https://docs.recruitee.com/reference/intro-to-careers-site-api), [offers endpoint](https://docs.recruitee.com/reference/offers)

Live official pages show that both systems carry Pune engineering inventory, even when individual examples are too senior for Onkar: [Workable Pune AI example](https://apply.workable.com/blue-altair/j/9DCF355896/), [Recruitee Pune engineering example](https://careersdeltacapita.recruitee.com/o/fullstack-java-developer). The gate—not the source adapter—must reject senior examples.

**Cost:** low adapter cost because adapters exist; medium board-discovery cost.  
**Expected incremental yield:** moderate, with good original-link quality.

#### 3. Pinpoint public postings

**Modes:** Normal, Pune, Startup

Pinpoint publishes an unauthenticated `postings.json` endpoint with stable IDs, full text, compensation, deadline, employment type, location and job URL; its documentation recommends this feed over the older `jobs.json`. [Pinpoint Job Postings JSON Endpoint](https://developers.pinpointhq.com/docs/jobs-json-endpoint)

**Cost:** low; the adapter already exists.  
**Expected incremental yield:** low-to-moderate in Pune, but very high data quality and cheap liveness checks.

#### 4. Generic sitemap and `JobPosting` career pages

**Modes:** all

Google’s job-posting specification makes `datePosted`, title and description required and defines `validThrough`, location, remote-location requirements, experience and canonical URL guidance. Google also recommends accurate sitemap `lastmod` values and removal/expiry of closed roles. [Google JobPosting documentation](https://developers.google.com/search/docs/appearance/structured-data/job-posting)

This is the correct fallback for Freshteam, Zoho Recruit and custom employer sites. Freshteam’s documented job API requires an employer OAuth token, so it should not be treated as a public cross-company API. [Freshteam API](https://developers.freshteam.com/api/)

**Cost:** medium because sitemap discovery, robots checks and malformed markup handling are required.  
**Expected incremental yield:** moderate across all modes and the best way to close unknown-ATS gaps.

### P1 — add sanctioned discovery feeds

#### 5. YC India and YC remote pages

**Modes:** Startup, Remote

YC provides official India job pages and shows current company, job type, discipline, compensation and location data. [YC jobs in India](https://www.ycombinator.com/jobs/role/all/india) The site’s current `robots.txt` allows general pages while disallowing parameterized company searches; use the stable official job pages or SearXNG `site:ycombinator.com/jobs` discovery, then resolve each job to its employer/ATS page. [YC robots.txt](https://www.ycombinator.com/robots.txt)

There is no documented public YC jobs API. Treat YC as a high-quality startup lead source, not a direct ATS authority.

**Cost:** low through SearXNG, medium for a dedicated HTML reader.  
**Expected incremental yield:** moderate Startup/India inventory; high company quality.

#### 6. Foundit “today” sitemap

**Modes:** Normal, Pune rescue

Foundit’s current `robots.txt` explicitly advertises a `todays-jobs-sitemap.xml` and sitemap index while disallowing private and event middleware paths. [Foundit robots.txt](https://www.foundit.in/robots.txt)

Use the sitemap only as a bounded lead feed. A Foundit URL cannot become application-ready until it resolves to a live original employer or ATS page.

**Cost:** low.  
**Expected incremental yield:** high raw Pune/India recall, low-to-moderate gate-passing yield.

#### 7. Jooble API

**Modes:** Normal and Pune shortage rescue

Jooble offers a documented key-based REST API with keyword, location, radius, salary and pagination parameters. [Jooble REST API](https://jooble.org/api/about), [endpoint reference](https://help.jooble.org/en/support/solutions/articles/60001448238-rest-api-documentation)

It is an aggregator. Every result remains unresolved until the original employer listing is found. Access requires registration and the live quota/terms should be confirmed before activation.

**Cost:** low implementation, external key required.  
**Expected incremental yield:** high raw recall; uncertain application-ready yield pending a one-week calibration.

#### 8. Adzuna India API

**Modes:** Pune and Normal rescue

Adzuna has an India site with a large Pune inventory and a REST search API exposing created time, company, location, category, contract type and redirect URL. [Adzuna Pune](https://www.adzuna.in/pune), [search API](https://developer.adzuna.com/docs/search)

The default API limit is 250 calls/day, and personal research is a permitted use, but the terms also impose attribution and restrictions that need operator review before a durable resolver follows third-party listings. [Adzuna API terms](https://developer.adzuna.com/docs/terms_of_service)

**Cost:** low implementation, API key required.  
**Expected incremental yield:** high raw Pune recall; uncertain verified yield. Trial behind a feature flag before adoption.

#### 9. National Career Service

**Modes:** Pune/India low-frequency rescue

NCS offers public filters for location, posted dates, experience, sector and job nature and explicitly states that its services are free. [NCS Maharashtra jobs](https://www.ncs.gov.in/jobs-in-maharashtra)

No suitable public job-search API was found. Current result pages also contain broad third-party inventory, so the employer/original-link verification burden is high.

**Cost:** medium if read through public pages; no stable API contract.  
**Expected incremental yield:** low for this technical profile. Keep below direct ATS and sanctioned API sources.

### P0 for Remote — fix and tune what already exists

#### 10. Update Himalayas instead of adding another generic remote board first

**Mode:** Remote

Himalayas now provides a free unauthenticated search API with filters for keyword, country, worldwide availability, seniority, employment type, timezone and recency sort. It returns publication/expiry dates and application links. The API is refreshed every 24 hours and now caps browse requests at 20, whereas Launchpad’s current adapter still documents a fixed 50-record contract. [Himalayas API](https://himalayas.app/docs/remote-jobs-api), [`himalayas.mjs`](../../job-pull/remote-adapters/himalayas.mjs)

Use queries such as `country=IN`, `seniority=Entry-level`, role keywords and `sort=recent`, followed by a second worldwide pass. Do not infer India eligibility from the word “remote.”

**Cost:** very low.  
**Expected incremental yield:** high precision improvement and lower processing noise; absolute fresher India yield remains market-dependent.

The other current remote feeds are valid but should remain secondary:

- We Work Remotely publishes official category RSS feeds and requests attribution. [WWR RSS](https://weworkremotely.com/remote-job-rss-feed)
- Jobicy’s API provides dates, geography, level and job type with a six-hour delay, but Jobicy says most inventory targets the Americas and Europe/EMEA. [Jobicy API and fair-use terms](https://jobicy.com/jobs-rss-feed)
- Remotive explicitly delays public API jobs by 24 hours. It is useful for seven-day discovery, not the first-24-hour lane. [Remotive API terms](https://remotive.com/remote-jobs/api)

### P2 — opportunistic startup rescue

Hacker News exposes an official `jobstories` endpoint returning up to 200 current job stories. [Official Hacker News API](https://github.com/HackerNews/API) Titles and descriptions are unstructured and geography is inconsistent, so it should be a low-frequency Startup/Remote lead lane with strict India/location resolution.

## Sources that should not be directly crawled

| Source | Boundary |
|---|---|
| LinkedIn | Keep public/manual or sanctioned connector rescue. Do not crawl authenticated job search. Resolve every lead to the employer page. |
| Indeed | Keep connector inbox only; no custom HTML scraper. |
| Wellfound | Keep manual/search lead discovery. Its `robots.txt` disallows `_jobs`, job-ID query patterns and application paths. [Wellfound robots.txt](https://wellfound.com/robots.txt) |
| Cutshort | Its `robots.txt` disallows several job/application URL patterns while advertising sitemaps. Use search/sitemap URLs only where permitted and resolve to the employer. [Cutshort robots.txt](https://cutshort.io/robots.txt) |
| Internshala | Do not crawl. Its `robots.txt` disallows its API, job and internship detail/search paths and blocks automated AI crawlers. [Internshala robots.txt](https://internshala.com/robots.txt) |
| Apna and WhatJobs | Use their sanctioned Codex connectors as shortage probes; do not build a parallel scraper. Recent profile-specific calibration showed poor technical-fresher precision. |
| AICTE internship portal | Public and India-relevant, but current Pune pages contain large volumes of unpaid or sub-threshold internships. Use only as a rare internship rescue and let the stipend gate reject the majority. [AICTE Pune internships](https://internship.aicte-india.org/fetch_city.php?city=UHVuZQ%3D%3D) |

`robots.txt` is an operational crawl directive, not a substitute for legal review or source terms.

## Proposed implementation order

1. **Populate enterprise boards:** verified Pune/India Workday tenants first.
2. **Populate Batch 1 and Batch 2:** Workable, Recruitee and Pinpoint first; retain board-level health and yield.
3. **Enable generic career sites:** seed known employers and promote repeat SearXNG discoveries into the registry.
4. **Make Startup real:** YC India plus direct startup ATS/watchlists; keep Wellfound/Cutshort as lead-only rescue.
5. **Modernize Remote:** current Himalayas search contract, then existing WWR/Jobicy/Remotive feeds.
6. **Trial one broad India feed:** Foundit today sitemap first; Jooble second; Adzuna only after terms review.
7. **Calibrate for seven days:** measure fetched, India/Pune-qualified, 0–2-year-qualified, fresh, resolved, duplicate, application-ready and eventually response/screen yield per source.

Do not rank a source by raw fetched count. The useful efficiency metric is:

```text
application-ready new-to-Onkar roles
────────────────────────────────────
requests + verification effort + recurring cost
```

Pause or demote sources that repeatedly create unresolved, stale, senior, foreign-remote or duplicate observations. Promote sources that deliver original employer URLs, trustworthy provider dates and actual application outcomes.

## Acceptance criteria for incorporation

- The crawler accepts an explicit mode/source-plan policy rather than silently using the same source mix for every mode.
- Pune is a location policy/preset over Normal sources, not a relaxation of gates.
- Every aggregator/API/plugin record enters as a lead until original-listing resolution.
- Startup and Remote modes change source weighting and composition only; they do not bypass shared eligibility.
- Current empty registries are populated with live-probed boards and board ownership evidence.
- Remote provider location restrictions are preserved as structured evidence.
- Source reports retain fetched, discarded-at-source, resolved, gated, duplicated, selected and verification counts, including resumed runs.
- After seven days, decisions use application-ready and conversion yield, not anecdotal one-day volume.

