# Launchpad Job-Discovery System: Current-State Technical Report

Author: gpt-5.6-luna (Codex), read-only repo analysis dispatched 2026-07-24.

As of 2026-07-24, Launchpad is an India-first, fresher-oriented job-discovery and application-preparation system. Its intended flow is discovery → eligibility filtering → scoring → resume preparation → Notion tracking. The active runtime contract is Launchpad v5.

## 1. System purpose and non-negotiables

Launchpad targets AI/LLM, agentic AI, ML, Python backend, AI-leaning full-stack, and new-grad SWE roles for a Pune-based final-year student. `master_prompt.md` is the source of truth for targeting, gates, scoring, resume tailoring, and outreach. `AGENTS.md` defines the repository contract and directory layout. (`AGENTS.md:1-16`; `master_prompt.md:1-5`)

Non-negotiable rules:

- No auto-apply, application submission, email sending, LinkedIn messaging, or autonomous outreach. `Apply?`, `Make Resume`, and `Applied?` remain user-controlled. (`AGENTS.md:44-60`; `master_prompt.md:81-93`)
- Scheduled and cloud execution is discovery-only.
- Resume compilation is local-only.
- `resumes/output/<date>/` contains final PDFs only. Tailored `.tex` sources remain under `resumes/sources/<date>/`. (`AGENTS.md:48-57`)
- Experience, metrics, dates, compensation, contacts, and links may not be fabricated. Unknown values remain blank, unverified, or in the verification queue. (`AGENTS.md:50-60`; `master_prompt.md:127-140`)
- Notion is the intended tracker of record, but schema changes require approval. (`AGENTS.md:56-60`)
- Launchpad v5 is the only active runtime. v3 and v4 are historical/read-only; there is no legacy fallback or migration path. (`AGENTS.md:56-60`; `config/launchpad-v5.commands.json:18-25`)
- The declared Notion scope is Applications v5, Companies v5, Outreach v5, Activity v5, and Referrals v5. (`config/notion-v5.manifest.json:1-12`)
- The default morning workflow reports application-ready roles first, then backfill and verification queues. Its application-ready target is minimum 10, preferred 12, maximum 20. (`.agents/skills/morning/SKILL.md:7-15`)

## 2. Discovery architecture

Launchpad currently contains three related but distinct discovery layers.

```text
Live agent / connector / fixture
          |
          v
mode sourceFunctions or imported JSON
          |
          v
v5 mode runner
          |
          v
candidate normalization
          |
          v
eligibility -> freshness -> dedup -> scoring -> selection
          |
          +--> planned Notion v5 operations
          |
          +--> verification queue / shortfall / telemetry

Scheduled crawler v2
          |
          v
direct HTTP ATS/search/inbox source plans
          |
          v
durable SQLite observations and identity
          |
          v
crawler workflow -> reserve / shortlist / verification handoff
```

### Layer 1: `job-pull` pipeline

`job-pull/run.mjs` is the standalone/manual pipeline. It can consume:

- tracked ATS output;
- reverse ATS warm/full-scan output;
- manually prepared public-search JSON;
- optional Indeed connector JSON;
- externally supplied score JSON.

It performs candidate deduplication, freshness classification, eligibility, conversion scoring, suppression, selection, and JSON reporting. It does not write Notion; its result explicitly reports `notionWrites: false`. (`job-pull/run.mjs:38-63`; `job-pull/run.mjs:191-363`; `job-pull/run.mjs:372-475`)

The public-search and Indeed inputs are imported artifacts. They are not fetched by `run.mjs` itself. The sourcing reference requires a live agent to collect WebSearch results, prepare them, and pass them through `--public-json`. (`.agents/skills/daily-job-pull/references/sourcing.md:41-49`)

### Layer 2: crawler v2

Crawler v2 is the durable discovery substrate. `crawler/operator.mjs` builds source plans for ATS providers, enterprise boards, SearXNG, startup lanes, remote mode, and connector inboxes. `crawler/workflow.mjs` resolves identity, persists observations and jobs into SQLite, applies historical suppression, produces a reserve and shortlist, and emits a planning-only v5 handoff. (`crawler/operator.mjs:184-283`; `crawler/operator.mjs:308-421`; `crawler/workflow.mjs:134-157`; `crawler/workflow.mjs:231-339`)

Crawler v2 shares policy modules with `job-pull`, including candidate normalization, eligibility, freshness, application readiness, and opportunity-ledger reading. It does not call the normal-mode Notion gateway and returns `writesPlanned: false`. (`crawler/operator.mjs:327-358`; `crawler/workflow.mjs:280-286`)

Its durable state is SQLite at `.local/launchpad-crawler/crawler.sqlite` in production and `.local/launchpad-crawler/dev.sqlite` in development. (`config/crawler-v2.json:1-4`; `config/crawler-v2-dev.json:1-4`)

### Layer 3: manual/live-agent-driven `sourceFunctions`

The v5 Normal, Startup, and Remote source modules expose injection seams:

- Normal lanes use only injected `sourceFunctions` or deterministic fixtures. The module explicitly has no network primitive. (`job-pull/normal-sources.mjs:118-146`)
- Startup lanes use only injected functions or fixtures. (`job-pull/startup-sources.mjs:148-177`)
- Remote lanes use injected functions, fixtures, or injected native transports. (`job-pull/remote-sources.mjs:147-174`)

`runNormalMode()` defaults to empty source functions and fixtures, then marks missing required lanes unavailable. It runs the shared pipeline, applies optional V4 suppression, builds planned v5 operations, and uses a no-write Notion gateway by default. Gateway execution is disabled unless an approved transactional fake gateway is explicitly injected. (`job-pull/normal-mode.mjs:141-188`)

There is a hybrid helper, `crawler/daily-runner.mjs`, that can feed crawler warm ATS output and tracked ATS output into `runNormalMode()`. However, the installed scheduled launchd agents invoke `crawler/cli.mjs` directly with `--env production --mode normal`; they do not invoke `runDailyNormal()`. (`crawler/daily-runner.mjs:141-195`; `crawler/install-schedule.mjs:43-60`)

Therefore, the three layers share data contracts and policy modules, but they are not one unified scheduled pipeline today.

## 3. Source inventory

| Source class | Declared lanes and implementation | Current state |
|---|---|---|
| ATS-direct | Normal: `tracked-ats`, `reverse-ats-warm`. Crawler: `ats-warm`, `ats-batch-1`, `ats-batch-2`, `ats-enterprise`. Providers include Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Pinpoint, and Workday. (`job-pull/normal-sources.mjs:4-6`; `config/crawler-v2.json:5-142`) | **(a) Automated/scheduled for configured boards.** Crawler v2 has native HTTP adapters and the production config contains active board registries. |
| Portal / aggregator | Normal declares Naukri, Foundit, Hirist, Cutshort, Instahyre, Peerlist, LinkedIn Jobs, and optional Indeed. (`job-pull/normal-sources.mjs:7-14`) | **(b) Requires live injection for useful coverage.** The mode layer has no network primitive. The documented operating path is live WebSearch → prepared JSON → pipeline. There is no automated equivalent for the portal lanes. (`.agents/skills/daily-job-pull/references/sourcing.md:41-86`; `docs/reports/daily-run-2026-07-24.md:52-58`) |
| Native remote feeds | Remote declares Himalayas, Jobicy, We Work Remotely, and Remotive. Native adapters exist for all four. (`job-pull/remote-sources.mjs:3-19`) | Implemented and automated when Remote mode is explicitly invoked through crawler v2, using injected HTTP transports. They are not part of the default scheduled `--mode normal` launchd path. |
| Startup / VC | Startup declares employer boards, VC portfolio boards, YC, Wellfound, Indian startup directories, startup watchlist, and funding/hiring signals. (`job-pull/startup-sources.mjs:6-14`) | **(b) Source-function/injection layer for the v5 Startup runner.** Crawler v2 also has a scheduled SearXNG-backed `india-startup` lane and can construct YC/VC source functions when SearXNG and the resolver are available. The full Startup mode is not the default launchd mode. (`crawler/operator.mjs:208-245`; `crawler/operator.mjs:256-281`) |
| Apify rescue | Profiles include LinkedIn, Naukri, Foundit, Hirist, Wellfound, and Cutshort. (`config/apify.json:1-172`) | Implemented but deliberately manual-only. `apify-pull.mjs` is not imported by daily mode runners, requires explicit `--profile`, requires `APIFY_TOKEN`, and writes only a raw rescue output. (`job-pull/apify-pull.mjs:3-9`; `job-pull/apify-pull.mjs:49-54`; `config/apify.json:1-8`) |
| Connector inbox | `crawler/connector-inbox.mjs` accepts only `indeed`, `apna`, and `whatjobs`. `crawler/indeed-inbox.mjs` accepts dated `IndeedConnectorV1` exports and imports them idempotently with receipts and quarantine handling. (`crawler/connector-inbox.mjs:6-7`; `crawler/indeed-inbox.mjs:84-139`) | **(b) Requires an external live connector/session to produce files.** The production crawler has both Indeed and generic connector inboxes disabled. (`config/crawler-v2.json:204-210`) |

The current production crawler is therefore strongest on configured ATS-direct sources. Portal breadth, authenticated-board discovery, and connector breadth remain dependent on interactive or separately provisioned inputs.

## 4. Scheduled crawler

### Schedule and configuration

The default schedule plan uses Asia/Kolkata:

- Morning: daily window beginning at 04:30 IST. Its stages are warm ATS, expanded ATS, career pages, Brave/startup, connector imports, normalization/verification, and selection.
- Midday: daily at 12:30 IST. Its stages are warm ATS refresh, changed career pages, connector imports, normalization/verification, and selection. (`crawler/schedules.mjs:1-46`)

`install-schedule.mjs` generates launchd agents whose command arguments explicitly include:

```text
node crawler/cli.mjs run <schedule> --env production --mode normal --location-preset pune
```

The launchd agents are installed under `~/Library/LaunchAgents`. (`crawler/install-schedule.mjs:43-96`; `crawler/install-schedule.mjs:117-156`)

The production and development crawler configs are functionally the same source configuration. The verified differences are:

- production database: `.local/launchpad-crawler/crawler.sqlite`;
- development database: `.local/launchpad-crawler/dev.sqlite`;
- production has the updated Workday pagination explanation in its notes. (`config/crawler-v2.json:1-4,138-142`; `config/crawler-v2-dev.json:1-4,138-142`; `diff -u config/crawler-v2-dev.json config/crawler-v2.json`)

### Actual current source activation

Production currently has:

- 19 warm ATS boards;
- SmartRecruiters, Workable, and Recruitee Batch 1 boards;
- one enabled Pinpoint Batch 2 board;
- four enabled Workday enterprise boards;
- an empty generic `careerSites` array;
- SearXNG enabled at `http://127.0.0.1:8080`;
- India startup discovery enabled;
- Brave disabled;
- Chromium disabled;
- Indeed disabled;
- generic connector inbox disabled;
- commercial rescue disabled. (`config/crawler-v2.json:5-28`; `config/crawler-v2.json:30-75`; `config/crawler-v2.json:88-174`; `config/crawler-v2.json:174-245`)

The morning operator includes warm ATS, Batch 1, Batch 2, enterprise ATS, India startup, and SearXNG search when their config gates are enabled. The midday operator skips Batch 2, enterprise, startup, and SearXNG source plans because those are guarded by `schedule !== 'midday'`; with the current empty career-site and disabled connector configuration, midday effectively runs the warm and Batch 1 ATS paths plus downstream processing. (`crawler/operator.mjs:184-207`; `crawler/operator.mjs:246-282`)

### Recent fixes

- Workday now uses POST with `{ appliedFacets, limit, offset, searchText }`, a page size of 20, advances offset by the number of received postings, and stops when Workday's own `total` is exhausted or the configured limit is reached. (`crawler/ats-enterprise.mjs:131-148`; `crawler/ats-enterprise.mjs:161-214`)
- Production crawler limits are configured as `maxPages: 10` and `maxJobsPerBoard: 200`. (`config/crawler-v2.json:138-142`)
- The launchd installation now passes `--env production`, preventing schedule/config drift into the development database. (`crawler/install-schedule.mjs:43-60`; `crawler/cli.mjs:25-46`)
- Lifecycle suppression now includes `interviewing` as a suppression state. (`crawler/identity.mjs:1-5`)
- The operator reads the opportunity ledger and the V4 snapshot loader before invoking `crawlWorkflow()`. (`crawler/operator.mjs:327-348`)

### Still-known crawler limitations

- SearXNG is reachable, but current job-specific queries return zero results. The endpoint returned HTTP 200 for a generic probe; this remains unresolved. (`docs/reports/daily-run-2026-07-24.md:36-47,82-88`)
- The V4 snapshot loader is wired, but `career-ops/data/v4-history-snapshot.json` does not exist. Missing-file behavior intentionally returns an empty row set, so no V4 suppression occurs from that source. (`crawler/v4-history-snapshot.mjs:7-23`; `crawler/historical-suppression.mjs:163-172`)
- Brave, connector inbox, Indeed, Chromium, and commercial rescue are disabled in both production and dev configs. (`config/crawler-v2.json:193-245`)
- Generic career-site discovery has no active sites because `careerSites` is empty. (`config/crawler-v2.json:144-173`)

## 5. Eligibility, scoring, selection, and suppression

### Hard gates

The policy runs gates before scoring. A candidate is excluded if it fails any of these:

1. Location authorization: onsite/hybrid must be Pune metro; remote must explicitly permit India, APAC, Asia-Pacific, worldwide, or an equivalent India-compatible scope.
2. Seniority: a hard minimum of 3+ years is rejected. Up to 2 years is shortage fallback only.
3. Employment: full-time or explicitly paid/stipended engineering internships only. Unpaid, volunteer, commission-only, part-time, contract, and unknown-pay internships are rejected.
4. Freshness evidence: undated roles enter `VerifyQueue`; roles older than 14 days are rejected.
5. Liveness: confirmed dead or expired listings are rejected; inconclusive liveness remains `Not Verified`.
6. Cross-day suppression: actioned lifecycle states never resurface, and surfaced-but-unactioned roles have a seven-day cooldown. (`master_prompt.md:20-59`, especially §2 hard gates)

The Workday exception is implemented: ordinary Workday `postedOn` values are not trusted as true original dates unless separately corroborated. (`master_prompt.md:50-57`; `job-pull/freshness.mjs:17-23`)

One implementation-level policy overlay is worth noting: `master_prompt.md` leaves the salary floor blank pending confirmation, but `config/conversion-plan.json` currently sets `salaryFloorLpa` to 8, and `runPipeline()` passes that value into eligibility. (`master_prompt.md:61-62`; `config/conversion-plan.json:10-23,60`; `job-pull/run.mjs:207-215`)

### Fit scoring

The declared Match Score is 0–100 with these weights:

| Dimension | Weight |
|---|---:|
| Skill match | 35 |
| Domain / role relevance | 20 |
| Seniority fit | 15 |
| Location / remote fit | 10 |
| Response Likelihood | 20 |

The score bands are guidance: 80–100 strong, 65–79 solid, 50–64 stretch, below 50 generally skipped. The `Auto-Suggest` condition requires score ≥80, Hot or Active freshness, Strict tier, and response-likelihood ≥14/20. (`master_prompt.md:66-93`, §3)

The implementation separates Match Score from Conversion Score. `runPipeline()` consumes `candidate.matchScore`, or merges externally supplied scores through `--scores-json`; it reports scored versus unscored candidates rather than calculating the five-dimension Match Score itself. (`job-pull/run.mjs:152-189`; `job-pull/run.mjs:343-347`)

Conversion Score uses separate weights for responsibilities/stack, experience, geography, project connection, direct/VC source, human contact, and freshness. Its configured thresholds are 75 for strong/manual review and 65 for inspection. (`config/conversion-plan.json:10-23`; `job-pull/conversion-score.mjs:1-18,54-88`)

### Freshness classes

The effective classes are:

- `Hot`: 0–72 hours;
- `Active`: over 72 hours through 7 days;
- `Backfill`: over 7 through 14 days, only if not previously surfaced;
- `VerifyQueue`: undated or unverified;
- `Rejected`: older than 14 days. (`master_prompt.md:50-57,80`; `job-pull/freshness.mjs:1-55`)

### Deduplication

Deduplication is ordered by source quality and uses:

1. existing ledger collision;
2. canonical URL;
3. provider plus job ID;
4. normalized company/title/location;
5. SimHash/JD fingerprint similarity at configured threshold 0.93.

The pipeline records duplicate reason and evidence in its audit output. (`.agents/skills/daily-job-pull/references/sourcing.md:164-171`; `config/job-pull.json:98-106`; `job-pull/dedup.mjs:62-124`)

### Selection targets

The master policy targets a 25–35-role curated discovery pool, with at least 10 Strict roles when inventory supports it, maximum two roles per company, and role-family diversity. (`master_prompt.md:80-85`, §3)

The v5 application-ready shortlist is narrower:

- minimum 10;
- preferred 12;
- maximum 20;
- Strict Hot → Strict Active → Strict Backfill → fallback Hot → fallback Active → fallback Backfill;
- unresolved or unready roles do not count toward the minimum. (`job-pull/normal-mode.mjs:160-218`; `job-pull/normal-selection.mjs:26-110`; `.agents/skills/daily-job-pull/SKILL.md:9-15`)

### Historical and cross-day suppression

The local opportunity ledger handles committed/surfaced lifecycle and cooldown suppression in `job-pull/run.mjs`. (`job-pull/run.mjs:243-263`; `master_prompt.md:50-57`)

Crawler identity reconciliation additionally matches provider/job ID, canonical URL, or company/title/location and distinguishes new, duplicate, refresh, repost, closure, and lifecycle suppression. (`crawler/identity.mjs:123-164`)

The V4 historical suppression index is read-only and matches provider/job ID, canonical URL, or company/title/location. Ambiguous collisions are not suppressed automatically. (`crawler/historical-suppression.mjs:85-160`)

## 6. MCP and external connector landscape

### Claude Code MCP configuration

The user-level Claude Code configuration contains one MCP server:

- `apify` at `https://mcp.apify.com`.

No repository-local MCP configuration files were found. The Claude Code configuration is `/Users/onkarj012/.claude.json`; its `mcpServers` object contains only Apify.

### Codex CLI MCP configuration

`codex mcp list` currently reports:

- `computer-use`: disabled, unsupported;
- `node_repl`: enabled, unsupported;
- `apify`: enabled, unsupported;
- `github`: enabled with bearer-token configuration;
- `vercel`: enabled, unsupported.

Only Apify is directly relevant to job discovery, but the repository's Apify implementation does not depend on the MCP server. `job-pull/apify-pull.mjs` calls the Apify HTTP API directly and requires `APIFY_TOKEN`. (`job-pull/apify-pull.mjs:22-24,264-303,415-430`)

### Consumer and interactive connectors referenced by repository docs

The repository references:

- Indeed MCP, when connected;
- manual LinkedIn rescue through an authenticated interactive browser;
- Apna and WhatJobs sanctioned connectors;
- Dice and Jobs and Careers connectors;
- ZipRecruiter MCP, which is documented as US/Canada restricted.

Relevant references appear in `master_prompt.md:246`, `docs/research/job-board-source-audit-2026-07-23.md:37-41,209-216`, and `docs/reports/daily-run-2026-07-24.md:82-88`.

### Unattended versus interactive usability

No MCP or consumer connector is callable by the scheduled Node process as an MCP session. Scheduled Node execution uses direct HTTP transports, local files, SQLite, and configured environment variables. The source-function seams require a caller to inject functions or records; the portal workflow requires a live agent session to perform WebSearch. (`job-pull/normal-sources.mjs:118-146`; `crawler/operator.mjs:74-113`)

Interactive sessions can provide WebSearch results, browser-rescued leads, connector exports, or Apify inputs. Those results must still pass normal normalization, original-listing resolution, liveness, freshness, eligibility, deduplication, and suppression.

## 7. Known gaps and honest limitations

- Portal and aggregator lanes have no automated equivalent today. Every normal discovery run needing Naukri, Foundit, Hirist, Cutshort, Instahyre, Peerlist, LinkedIn Jobs, or similar breadth requires live WebSearch or manually supplied records. (`.agents/skills/daily-job-pull/references/sourcing.md:41-86`; `docs/reports/daily-run-2026-07-24.md:52-58,82-85`)
- SearXNG is reachable but returns zero results for current job-specific queries. (`docs/reports/daily-run-2026-07-24.md:43,85`)
- The V4 Notion history snapshot file is not populated, so the new V4 suppression path currently contributes no historical rows. (`crawler/v4-history-snapshot.mjs:17-23`; `docs/reports/daily-run-2026-07-24.md:86`)
- Dice, Jobs and Careers, Apna Jobs, and WhatJobs are not reachable from this Codex session because their connectors belong to separate Claude-account or ChatGPT-app contexts. (`docs/reports/daily-run-2026-07-24.md:87`)
- Brave, Indeed, generic connector inbox, Chromium, and commercial rescue are disabled in the current production configuration. (`config/crawler-v2.json:193-245`)
- Generic employer career-page discovery is implemented but currently has no active `careerSites` entries. (`config/crawler-v2.json:144-173`)
- Apify rescue exists, but it is intentionally explicit and is not part of Normal, Startup, Remote, or scheduled daily discovery. (`config/apify.json:1-8`; `job-pull/apify-pull.mjs:3-9`)
- The scheduled crawler produces a planning-only handoff and does not write Notion or submit applications. (`crawler/workflow.mjs:280-286`; `config/launchpad-v5.commands.json:14-16`)
- The current scheduled launchd mode is `normal`; Remote and full Startup mode are explicit invocations rather than the default scheduled path. (`crawler/install-schedule.mjs:43-60`; `crawler/operator.mjs:208-255`)

## 8. File and path map

### Contracts and policy

- `AGENTS.md` — repository contract, identity, guardrails, directory map.
- `master_prompt.md` — targeting, gates, scoring, freshness, suppression, resume, and outreach policy.
- `config/launchpad-v5.commands.json` — command surface and safety flags.
- `config/notion-v5.manifest.json` — v5 Notion database identifiers and property/view contracts.
- `config/job-pull.json` — executable job-pull gates, freshness limits, dedup threshold, and selection settings.
- `config/conversion-plan.json` — Conversion Score, shortlist composition, cadence, and salary-floor configuration.

### Skills and manual workflow

- `.agents/skills/morning/SKILL.md` — `/morning` entrypoint and shortlist handoff.
- `.agents/skills/daily-job-pull/SKILL.md` — discovery contract.
- `.agents/skills/daily-job-pull/references/sourcing.md` — source order, WebSearch matrix, ATS endpoints, feeds, Apify, and dedup policy.
- `job-pull/normal-mode.mjs` — v5 Normal orchestration and planned Notion operations.
- `job-pull/normal-sources.mjs` — Normal source lane declarations and injection seam.
- `job-pull/startup-sources.mjs` — Startup/VC lane declarations and injection seam.
- `job-pull/remote-sources.mjs` — Remote lane declarations and native feed adapters.
- `job-pull/run.mjs` — standalone/manual shared pipeline.
- `job-pull/eligibility.mjs`, `freshness.mjs`, `dedup.mjs`, `select.mjs`, `normal-selection.mjs` — policy execution.

### Crawler v2

- `crawler/operator.mjs` — configuration loading, source-plan construction, policy preparation, V4/opportunity history wiring, and operator execution.
- `crawler/workflow.mjs` — durable crawl workflow, identity decoration, reserve, shortlist, verification queue, source yield, and handoff.
- `crawler/cli.mjs` — validate, plan, run, readiness, schedule installation, and schedule health commands.
- `crawler/schedules.mjs` — morning and midday schedule definitions.
- `crawler/install-schedule.mjs` — launchd plist generation and installation.
- `crawler/ats-enterprise.mjs` — Workday and enterprise ATS adapter, including offset/total pagination.
- `crawler/identity.mjs` — durable identity and lifecycle suppression states.
- `crawler/historical-suppression.mjs` — read-only V4 identity suppression.
- `crawler/v4-history-snapshot.mjs` — V4 snapshot loader.
- `config/crawler-v2.json` — production crawler configuration.
- `config/crawler-v2-dev.json` — development crawler configuration.
- `.local/launchpad-crawler/crawler.sqlite` — production durable crawler database.
- `.local/launchpad-crawler/dev.sqlite` — development durable crawler database.
- `.local/launchpad-crawler/logs/` — launchd and crawler logs.

### Rescue and connector paths

- `config/apify.json` — disabled-by-default Apify rescue profiles.
- `job-pull/apify-pull.mjs` — explicit Apify execution and raw-record mapping.
- `crawler/connector-inbox.mjs` — generic connector envelope normalization.
- `crawler/indeed-inbox.mjs` — dated Indeed connector import, quarantine, and receipt handling.
- `connector-inbox/` — configured connector inbox root.
- `connector-inbox/indeed/` — configured Indeed inbox.

### Ledgers and outputs

- `career-ops/data/opportunity-ledger.tsv` — local cross-day opportunity ledger.
- `career-ops/data/v4-history-snapshot.json` — expected V4 snapshot path; currently absent.
- `resumes/master/Master_Resume_ATS.tex` — approved evidence source.
- `resumes/templates/Onkar_Template.tex` — frozen resume layout.
- `resumes/sources/<YYYY-MM-DD>/` — tailored `.tex` sources and build scratch.
- `resumes/output/<YYYY-MM-DD>/` — final PDFs only. (`AGENTS.md:20-43`)
