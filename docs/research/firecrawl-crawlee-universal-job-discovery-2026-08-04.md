# Firecrawl vs Crawlee for universal job discovery in Launchpad

Date: 2026-08-04  
Profile: Pune-based 2026 CS new graduate, 0–1 years, targeting AI/LLM, ML, backend Python, AI-leaning full-stack, and new-grad SWE  
Scope: discovery architecture and Pune-market evidence only. This report does **not** propose auto-apply, autonomous outreach, weaker eligibility gates, authenticated-portal crawling, or bypassing source terms and robots directives.

## Executive verdict

1. **Use Crawlee as the preferred owned crawling framework, but only for missing public career-site and source-specific adapters.** It fits Launchpad's Node.js architecture, is Apache-2.0 licensed, runs locally, and exposes browser, queue, session, proxy, and storage primitives. It should augment—not replace—the direct ATS adapters and Launchpad's identity, freshness, eligibility, original-listing, and handoff logic. [Crawlee repository](https://github.com/apify/crawlee) · [Introduction](https://crawlee.dev/js/docs/introduction)
2. **Use Firecrawl, if at all, as a bounded optional cloud rescue for a small allowlist of difficult public pages.** Its hosted service removes more proxy/render/extraction plumbing, but credits, external processing, and weaker source-specific control make it a poor default for daily enumeration. Its self-hosted edition lacks Fire-engine's advanced IP-block/bot handling and does not support cloud `/agent` or `/browser`. [Firecrawl repository](https://github.com/firecrawl/firecrawl) · [Self-hosting](https://docs.firecrawl.dev/contributing/self-host)
3. **Neither is a universal job source.** Neither supplies an employer/ATS registry, knows every tenant-specific contract, guarantees access to restricted portals, maintains all selectors, resolves original listings, or understands Launchpad gates.
4. **Neither broadly replaces paid Apify Actors.** Crawlee replaces an Actor only when Launchpad owns that adapter, selectors, proxies, deployment, and maintenance. Firecrawl can replace generic rendering/extraction plumbing, not a maintained board-specific scraper. [Apify Actors](https://docs.apify.com/platform/actors) · [Schedules](https://docs.apify.com/platform/actors/running/schedules) · [Proxy](https://docs.apify.com/platform/proxy)
5. **The evidence does not support at least 10 new suitable Pune jobs every day.** Pune has substantial posting stock and fresh technical roles, but seniority, age, off-target work, duplicates, unresolved originals, and history gates remove most. The defensible answer is **not established, with sampled evidence materially below 10 gate-surviving new roles on ordinary days**.

## Feature, license, self-hosting, and cost comparison

| Dimension | Firecrawl | Crawlee | Launchpad consequence |
|---|---|---|---|
| Product | Hosted scrape/search/crawl API with Markdown, HTML, screenshot, links, actions, and structured JSON; open-source core is self-hostable. [Scrape](https://docs.firecrawl.dev/features/scrape) · [Crawl](https://docs.firecrawl.dev/features/crawl) | TypeScript/JavaScript crawling and browser-automation library with HTTP, Playwright/Puppeteer, routing, retries, queues, sessions, proxies, autoscaling, and pluggable storage. [Introduction](https://crawlee.dev/js/docs/introduction) | Crawlee is the owned adapter substrate; Firecrawl is an optional external service. |
| License | Core is AGPL-3.0; SDKs and some UI components are MIT. Modified network-served self-hosting needs license review. [Repository](https://github.com/firecrawl/firecrawl) | Apache-2.0. [Repository](https://github.com/apify/crawlee) | Crawlee is simpler for proprietary local integration. |
| Self-hosting | Docker-based. Basic fetch and optional Playwright work, but self-hosting lacks Fire-engine and differs from cloud. [Self-hosting](https://docs.firecrawl.dev/contributing/self-host) | Runs locally, in Docker, or on compatible compute; operator owns infrastructure. | Prefer Crawlee for routine local discovery; do not expect self-hosted Firecrawl to match cloud stealth. |
| Cost observed 2026-08-04 | Free 1,000 credits; Hobby $16/year-billed for 5,000; Standard $83 for 100,000; Growth $333 for 500,000; Scale $599 for 1,000,000; no pay-per-use. Normal scrape/crawl generally 1 credit/page; enhanced proxy 5 credits/request. [Pricing](https://www.firecrawl.dev/pricing) · [Enhanced mode](https://docs.firecrawl.dev/features/stealth-mode) | Library fee $0; real cost is compute, browser memory/CPU, bandwidth, storage, engineering, and third-party proxies. Apify deployment meters compute, transfer, proxies, and storage. [Usage/resources](https://docs.apify.com/platform/actors/running/usage-and-resources) | Crawlee is cheaper only when maintenance/proxies stay controlled. |
| Anti-bot/proxy | Cloud `auto` tries basic then enhanced; enhanced is for complex sites and costs 5 credits if used. [Enhanced mode](https://docs.firecrawl.dev/features/stealth-mode) | Rotates supplied proxies, supports sticky sessions and tiers, and retires blocked sessions; operator supplies proxies and site-specific block rules. [Proxy](https://crawlee.dev/js/docs/guides/proxy-management) · [Sessions](https://crawlee.dev/js/docs/guides/session-management) | Firecrawl has convenience; Crawlee has control. Neither guarantees access. |
| Browser/render | Managed JS rendering and page actions; self-host Playwright service optional. [Scrape](https://docs.firecrawl.dev/features/scrape) | First-class Playwright/Puppeteer and browser pooling. | HTTP/ATS APIs first, browser only on allowlist. |
| Extraction | Built-in cleaned Markdown/HTML, links, screenshots, schema/prompt JSON. | Application writes deterministic selectors/parsers and schemas. | Firecrawl prototypes faster; Crawlee gives stronger production provenance. |
| URL discovery | `/map` uses sitemaps/search/cache but may omit links; `/crawl` is more complete. [Map](https://docs.firecrawl.dev/features/map) | `enqueueLinks()` adds discovered links to RequestQueue with scope controls. [Example](https://crawlee.dev/js/docs/examples/crawl-all-links) | Both find leads; neither makes them application-ready. |
| Scheduling | On-demand; official observability guidance requires caller cron/application scheduling. [Observability](https://docs.firecrawl.dev/use-cases/observability) | Runs when invoked; recurring scheduling is external. | Keep Launchpad's existing scheduler/operator. |
| State | Crawl job IDs, progress, webhooks, pagination, results retained 24 hours. [Crawl](https://docs.firecrawl.dev/features/crawl) | RequestQueue/Dataset/KV storage can persist, but default local storage is normally purged unless configured. [Request storage](https://crawlee.dev/js/docs/guides/request-storage) | Neither replaces SQLite/v5 opportunity state. |
| Concurrency | Hosted plan concurrency, observed 2–150. [Pricing](https://www.firecrawl.dev/pricing) | `AutoscaledPool` adapts using CPU, memory, event loop within configured bounds. [AutoscaledPool](https://crawlee.dev/js/api/core/class/AutoscaledPool) | Preserve host limits and scorer reserve. |
| Dedup | URL/query-level crawl controls only. | Queue unique-key/URL dedup only. | Preserve provider ID → original URL → company/title/location → lifecycle suppression in [`crawler/identity.mjs`](../../crawler/identity.mjs). |

## What each tool is—and is not

### Firecrawl

Firecrawl is a **managed web-content retrieval and extraction service**. It helps when Launchpad has a public URL but does not want to own all rendering, proxy selection, actions, Markdown cleanup, and schema extraction. [Scrape](https://docs.firecrawl.dev/features/scrape) · [Crawl](https://docs.firecrawl.dev/features/crawl)

It is not a job database, ATS tenant registry, source-specific Workday/SuccessFactors contract, original-listing resolver, durable job ledger, native recurring scheduler, guarantee against CAPTCHAs/login walls, or permission to ignore robots/terms.

### Crawlee

Crawlee is a **crawler construction toolkit**: HTTP/browser crawlers, queues, routes, retries, sessions/cookies, proxy orchestration, browser pooling, concurrency, and storage. [Introduction](https://crawlee.dev/js/docs/introduction)

It is not a hosted proxy pool, maintained adapter for every board, selector/schema guarantee, job-data vendor, legal policy engine, or cross-source requisition deduper.

## Capability and limit analysis

### Anti-bot, proxy, browser, and rendering

Firecrawl Cloud is shorter-path on difficult public pages, but `auto` can escalate one-credit requests to five-credit enhanced requests. Its self-hosted edition loses Fire-engine. Crawlee provides sessions, retries, cookie persistence, proxy tiers, and browser control, but Launchpad pays for and tunes the actual proxy/browser infrastructure. [Firecrawl enhanced mode](https://docs.firecrawl.dev/features/stealth-mode) · [Crawlee proxy management](https://crawlee.dev/js/docs/guides/proxy-management) · [Session management](https://crawlee.dev/js/docs/guides/session-management)

Use retrieval tiers: first-party ATS/feed/API → plain HTTP/sitemap/JSON-LD → source-specific HTTP adapter → allowlisted browser → Firecrawl enhanced or Actor rescue. This matches [`crawler/chromium-fallback.mjs`](../../crawler/chromium-fallback.mjs), which already limits rendering by host.

### Extraction and source semantics

Firecrawl schema/prompt JSON can bootstrap an unfamiliar public page, but job discovery needs provider requisition ID, original apply URL, publication evidence, location, employment, and experience with auditable provenance. Prompt-derived values must be lead/verification hints, never override first-party ATS detail. Missing dates, experience, or originals remain `VerifyQueue`/`Not Verified`.

Crawlee leaves extraction logic to Launchpad. That is more work but fits deterministic direct adapters and fail-closed evidence handling.

### Scheduling, state, and dedup

Neither creates a second lifecycle authority. Keep durable run/job state, provider IDs, canonical originals, novelty, material refresh, history suppression, source funnels, and the planning-only handoff in [`crawler/workflow.mjs`](../../crawler/workflow.mjs), [`crawler/identity.mjs`](../../crawler/identity.mjs), and [`crawler/daily-runner.mjs`](../../crawler/daily-runner.mjs). Crawlee queues are crawl orchestration; Firecrawl job IDs are external-call telemetry.

### Robots and access

Technical ability is not permission. Continue checking public accessibility, official APIs, source terms, robots, rate limits, and authentication boundaries. Private sessions, CAPTCHA solving, and application endpoints remain out of scope. The audit boundaries for LinkedIn, Indeed, Wellfound, Cutshort, and Internshala remain. [`job-board-source-audit-2026-07-23.md`](job-board-source-audit-2026-07-23.md#sources-that-should-not-be-directly-crawled)

## Does either replace paid Apify Actors?

**No blanket replacement is justified.** Crawlee can replace an Actor only by moving its source logic and operations into Launchpad. Firecrawl may replace a generic webpage-render/extract Actor, not maintained portal queries/selectors/schema. Actors additionally package managed runs, inputs/outputs, versioning, schedules, datasets/KV, and optional managed proxy products. [Actors](https://docs.apify.com/platform/actors) · [Schedules](https://docs.apify.com/platform/actors/running/schedules) · [Proxy](https://docs.apify.com/platform/proxy)

Keep [`config/apify.json`](../../config/apify.json) default-off, require explicit profiles through [`job-pull/apify-pull.mjs`](../../job-pull/apify-pull.mjs), and preserve provenance through [`job-pull/apify-prepare.mjs`](../../job-pull/apify-prepare.mjs). Retire a profile only after an owned lane proves equal/better original URL/date evidence, fresh gated yield, cost including maintenance, bounded schema drift, and source-policy compliance.

## Source-specific adapter implications

| Source class | Recommendation | Firecrawl | Crawlee | Authority |
|---|---|---|---|---|
| Greenhouse, Lever, Ashby public APIs | Keep direct JSON adapters. [Greenhouse](https://developers.greenhouse.io/job-board.html) · [Lever](https://github.com/lever/postings-api) · [Ashby](https://developers.ashbyhq.com/docs/public-job-posting-api) | None | None | Direct ATS |
| Workday CXS | Keep tenant/site POST enumeration and detail hydration; preserve Workday freshness policy. | UI diagnosis only | May help tenant discovery, not replace CXS | Direct after detail |
| SuccessFactors/Oracle/iCIMS/Phenom/Jobvite | Provider-specific adapter before generic browser where stable public contract exists. | Debug/rescue | Good implementation substrate | Direct only with proven detail |
| Custom employer careers/sitemaps/feeds/JSON-LD | Expand current generic career lane. | Optional extraction fallback | **Highest-value target:** Cheerio first, Playwright allowlist second | Direct company or verify |
| Public JS-heavy aggregator | Lead generation; resolve to employer/ATS. | Bounded rescue if permitted | Source-specific adapter if justified | Lead until resolved |
| Restricted/authenticated portal | Connector/manual/sanctioned paid rescue only. | No bypass | No bypass | Never ready from snippet |

The highest immediate gain remains activating/repairing source registries and source-specific career adapters, not replacing structured endpoints with one universal crawler. [`job-board-source-audit-2026-07-23.md`](job-board-source-audit-2026-07-23.md)

## Pune-volume assessment

### Three different quantities

- **All Pune postings (stock):** all visible Pune-tagged listings, including nontechnical, senior, stale, duplicate, contract, unknown-pay, and closed-but-indexed pages.
- **Fresh technical postings:** credibly new/recent roles in target technical families before experience, employment, original, history, and readiness gates.
- **Launchpad-gated survivors:** new-to-Onkar, live, original/resolved, Pune-eligible, target-family roles with strict 0–1 years or labelled fallback up to 2, acceptable employment, and Hot/Active/eligible Backfill freshness.

Portal counters cannot establish the latter two.

### Direct and operational evidence

| Evidence sampled/recorded | What it shows | Gate result |
|---|---|---|
| Foundit's public [today-jobs sitemap](https://www.foundit.in/xmlsitemap/todays-jobs-sitemap.xml) exposed 1,591 URLs on 2026-08-04; 108 URL slugs contained Pune and 38 matched broad technical-title tokens. Inspected pages still included duplicates, non-CS engineering, senior roles, and `datePosted` values from 2026-08-02. | Raw Pune and technical-looking inventory can exceed ten, but sitemap membership and title tokens do not prove first-posted-today, suitable, or application-ready status. | Only a small verification queue; **0 fully proven fresh strict survivors** in this spot check. |
| A Foundit **Data Engineer — Unique Infotech** page was marked fresher/full-time and looked profile-aligned, while other sampled Pune AI roles required 4–12 years and one appeared under two Foundit IDs. [Foundit robots/sitemap evidence](https://www.foundit.in/robots.txt) | Broad aggregators can surface promising leads, but experience filtering and cross-ID dedup collapse apparent volume. | Strong lead only; original-employer resolution and date/liveness verification still required. |
| OpenGov public Ashby JSON returned two distinct Pune **AI Developer II** requisitions with `publishedAt` on 2026-08-04; both require **3+ years in AI**. [Ashby board JSON](https://api.ashbyhq.com/posting-api/job-board/opengov?includeCompensation=true) | Same-day technical flow can still be senior; distinct requisitions can be near-duplicate observations. | **0 survivors:** 3+ hard reject. |
| Lynx Analytics public Greenhouse JSON returned four Pune technical roles. **AI Engineer (India)** had `updated_at` 2026-07-23 and requires **2 years overall / 1 year LLM-AI**; three others require 5 years. [Greenhouse JSON](https://boards-api.greenhouse.io/v1/boards/lynxanalytics/jobs?content=true) | One conditional fallback amid senior stock. Greenhouse `updated_at` is not first publication; detail has `first_published`. [API fields](https://developers.greenhouse.io/job-board.html) | At most **1 conditional fallback**, subject to true date/liveness/history. |
| SonicWall public Greenhouse JSON returned three sampled Pune technical roles requiring 5–12+ years. [Greenhouse JSON](https://boards-api.greenhouse.io/v1/boards/sonicwall/jobs?content=true) | Pune technical stock is not fresher supply. | **0 survivors**. |
| Onit public Lever JSON returned Pune AI Engineer/Senior AI Engineer created March–April 2026 and a 7+ year senior SWE. [Lever JSON](https://api.lever.co/v0/postings/onit?mode=json) | Live pages can be far beyond the 14-day horizon. | **0 on freshness**, plus seniority failures. |
| Kingfish public Lever JSON returned Pune Software Engineer created 2026-02-18 requiring 5+ years JavaScript and 3+ Salesforce. [Lever JSON](https://api.lever.co/v0/postings/KingfishGroup?mode=json) | Broad Pune SWE result can be stale and senior. | **0 survivors**. |
| ReliaQuest first-party Workday object exposed Associate Software Engineer Pune, explicit 0–1 years, but start/posting date 2026-07-15: 20 days old on the report date. [Workday object](https://reliaquest.wd5.myworkdayjobs.com/wday/cxs/reliaquest/ReliaQuest_Careers/job/Pune-India-Office/Associate-Software-Engineer_R15032) | Exact-level matches exist but may already be beyond Backfill. | **0 on freshness** in this point sample. |
| Real Launchpad run 2026-07-24: 763 direct crawler observations → 6 eligible → all 6 history/cooldown-suppressed → 0 new direct roles. A broader 198-record run yielded 6 gate-passing and **1 final ready** Finastra Associate SWE Pune. [`daily-run-2026-07-24.md`](../reports/daily-run-2026-07-24.md) | Closest end-to-end stock→gate→history→ready measurement; only one day and incomplete coverage. | **1 ready**, not 10. |
| Configured Birlasoft probe found a 697-posting sitemap with 286 Pune-tagged URLs, but the generic adapter was disabled because traversal could consume assets/mislabel pages. [`crawler-v2.json`](../../config/crawler-v2.json) | Large stock at one employer does not establish date, family, experience, liveness, or suitability. | Unknown until correct source adapter/gates. |

### Verdict on ten per day

The evidence supports large Pune stock, much smaller fresh technical flow, and smaller gate-survivor flow. It **does not substantiate a dependable 10 new suitable Pune roles/day**. This does not prove impossibility; it means an exact claim is unjustified. Exceptional campus-hiring spikes may reach it, but no validated sample demonstrates it as a baseline.

A 14-day read-only calibration is required. Per day/source record fetched Pune stock, new provider requisitions, dated Hot/Active/Backfill technical roles, strict/fallback survivors, verify queue, original resolution, liveness failures, history suppression, ready new-to-Onkar roles, and request/proxy/credit/Actor/human cost. Report median, quartiles, and days reaching 10; never infer from counters.

## Recommended target architecture

```text
mode/location source plan
  + direct ATS adapters (preferred)
  + source-specific public adapters (Crawlee where useful)
  + generic sitemap/JSON-LD lane (Crawlee HTTP-first)
  + allowlisted Crawlee browser fallback
  + optional Firecrawl hard-page rescue (lead/verification)
  + explicit default-off Apify rescue
        |
existing candidate normalization and provenance
        |
original-listing resolution and first-party hydration
        |
unchanged eligibility, freshness, liveness gates
        |
existing requisition identity and history suppression
        |
telemetry, verification, scoring, selection
        |
planning-only v5 handoff: noAutoApply=true, writesPlanned=false
```

Crawlee owns request routing/retries/session/proxy/browser lifecycle for selected adapters. Firecrawl owns only a metered external retrieval attempt. Launchpad retains registry, candidate schema, evidence precedence, resolver, gates, dedup, novelty, scoring, telemetry, and handoff.

## Concrete repository seams

| Seam | Connection | Preserve |
|---|---|---|
| [`crawler/operator.mjs`](../../crawler/operator.mjs) | Future source plans return existing observations/manifest/cursor/verification shape. Firecrawl is a separate plan, not silent transport replacement. | Deadline, budgets, telemetry, planning-only contract. |
| [`crawler/company-careers.mjs`](../../crawler/company-careers.mjs) | Highest-value Crawlee target; improve routes/queues while reusing robots/sitemap/JSON-LD/conditional/verification semantics. | Evidence and direct-vs-lead classification. |
| [`crawler/chromium-fallback.mjs`](../../crawler/chromium-fallback.mjs) | Retain minimal allowlist or replace per-page launches with shared Crawlee BrowserPool. | HTTP-first and render-host allowlist. |
| [`crawler/board-registry.mjs`](../../crawler/board-registry.mjs) | Store adapter kind/evidence/capabilities/health; discoveries propose, never auto-enable. | Human activation. |
| [`config/crawler-v2.json`](../../config/crawler-v2.json) | Future flags: hosts, page/request caps, proxy mode, Firecrawl credit ceiling, browser concurrency. | Default-off rescue and source budgets. |
| [`job-pull/normal-sources.mjs`](../../job-pull/normal-sources.mjs), [`crawler/daily-runner.mjs`](../../crawler/daily-runner.mjs) | Map new IDs into existing structured-career/web-discovery lanes. | One shared scoring/gating pipeline. |
| [`crawler/original-listing-resolver.mjs`](../../crawler/original-listing-resolver.mjs) | Every portal/Firecrawl lead passes this boundary. | Bounded redirects/hosts/bytes/requests and first-party precedence. |
| [`job-pull/eligibility.mjs`](../../job-pull/eligibility.mjs), [`job-pull/freshness.mjs`](../../job-pull/freshness.mjs) | Consume new candidates without exemptions. | Pune/India, paid work, 0–1 strict/up-to-2 fallback, 3+ reject, date rules. |
| [`crawler/identity.mjs`](../../crawler/identity.mjs), [`crawler/workflow.mjs`](../../crawler/workflow.mjs) | Keep all observations in existing identity/history/verification/yield reporting. | Lifecycle authority. |
| Apify files | Preserve explicit rescue baseline. | Named profiles, preflight, provenance, default-off. |

## Fastest phased integration plan

1. **Baseline first:** use current telemetry to define new requisition, fresh technical, strict/fallback eligible, resolved, ready, duplicate, verify, requests, duration, and cost.
2. **One HTTP-first Crawlee adapter:** target broken high-value custom cases. Prefer direct SuccessFactors for Birlasoft if verified; constrain Cybage to real job paths; add one small JSON-LD site. Emit only existing candidate fields.
3. **Shared browser pool:** allowlisted hosts only; per-host and whole-run caps; source-specific selectors; fail closed on missing title/company/location/original/date; emit block/schema failures.
4. **Optional Firecrawl rescue:** host allowlist, daily page/credit ceiling, data-handling review, no private portals, no prompt field accepted as first-party without resolver hydration, circuit breaker on credit/rate/errors.
5. **Actor comparison:** over the same window compare application-ready new roles divided by USD + requests + proxy + verification + maintenance + recovery. Mixed architecture is expected.

## Explicit no-auto-apply boundary

This proposal ends at discovery and planning-only handoff.

- No Firecrawl call, Crawlee route, or Actor submits applications.
- No browser opens/completes application forms as an automated action.
- No adapter checks `Make Resume` or `Applied?`.
- No email, connection, DM, referral, or follow-up is sent.
- Aggregator output is not ready until original ATS/employer detail resolves.
- Board discoveries remain proposals until manual activation.
- Keep `noAutoApply: true` and `writesPlanned: false` in [`crawler/workflow.mjs`](../../crawler/workflow.mjs).

## Key risks

1. Coverage illusion: more pages without more ready roles.
2. Freshness inflation from updates, Workday refreshes, search dates, or sitemap lastmod.
3. Selector/schema drift and plausible partial extraction.
4. Firecrawl enhanced/proxy/browser cost escalation.
5. Firecrawl AGPL/cloud-self-host split and third-party dependency terms.
6. External data handling; never send credentials, authenticated pages, applicant data, or private tracker content.
7. Robots/terms violations; technical access is not permission.
8. Browser work starving scorer/hydration budgets.
9. URL-queue dedup mistaken for requisition/lifecycle dedup.
10. Forcing a Pune quota by accepting stale, senior, unresolved, or off-target roles.

## Final recommendation

Adopt **Crawlee selectively**, not as a rewrite: repair and extend public career-site/long-tail adapters while all observations continue through Launchpad's resolver, evidence, gates, identity, and handoff. Trial **Firecrawl only as a metered, allowlisted rescue**. Keep **Apify explicit rescue** until source-by-source evidence justifies retirement.

For Pune, optimize for real survivors rather than a guaranteed quota. The hard conclusion is: **the available primary-source samples and complete Launchpad run do not substantiate 10 daily gate-surviving Pune roles.**
