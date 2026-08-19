# Launchpad opportunity system gap audit and ticket backlog

> **Superseded status snapshot.** This is the original dated Aug 4 audit and LP backlog. Preserve its findings as research history, but do not use its gap statements or ticket ordering as current implementation status. Schedule/mode/location dispatch, Workday freshness handling, shared suppression/surfacing, exact v5 relations, and other areas have changed in the current dirty working tree. See [`../STATUS.md`](../STATUS.md) for the conservative LP-001–LP-019 snapshot; GitHub remains the live issue-status authority.

Date: 2026-08-04  
Scope: fresh-role detection, Pune/startup/India-remote sourcing, bounded Apify rescue, relationship reactivation, founder outreach, Gmail drafts, and manual LinkedIn workflow.  
Boundary: discovery, research, drafting, tracking, and notifications only. No auto-apply, autonomous email send, LinkedIn connection/message automation, account creation, CAPTCHA bypass, or user-owned checkbox changes.

## Executive finding

Launchpad is not starting from zero. Candidate normalization, eligibility, scoring, direct ATS adapters, original-listing resolution, source telemetry, remote feeds, startup enrichment primitives, local outreach drafting, manual-send confirmation, and v5 stores already exist.

Main problem is incomplete operational wiring plus several correctness defects:

- unified `daily` ignores schedule, mode, and location arguments;
- installed midday schedule reruns full morning Normal mode;
- focused Startup/Remote selectors are not reached by unified daily execution;
- Workday list `postedOn` can be treated as trusted freshness despite policy requiring corroboration;
- cross-day surfaced-state logic has two incompatible authorities;
- warm ATS rotation state is not durable;
- no successful-run notification exposes rare fresh matches;
- custom career sites are disabled and Crawlee/Firecrawl are not integrated;
- startup company evidence does not reach Companies v5 through the real gateway operation shape;
- contact research defaults to paid providers and auto-selects a person before user review;
- old Gmail history, Gmail draft creation, LinkedIn conversation import, and reply observation are absent;
- outreach Activity events cannot reliably identify their exact Outreach sequence after reload;
- Apify has profile/time caps but no persistent watermark, cache-first dataset reuse, monthly spend ledger, actual-cost reconciliation, or cross-run dedup before another paid Actor run.

## Maturity estimate

These percentages are engineering maturity estimates, not test coverage or production-yield measurements.

| Area | Estimated maturity | Current position |
|---|---:|---|
| Candidate gates, scoring, normalization, liveness and same-run dedup | 75% | Strong core; preserve it |
| Fresh-role radar | 50% | Sources and schedules exist, but midday, rotation, cooldown and notifications are defective/incomplete |
| Direct ATS and career-site coverage | 55% | Several structured providers work; custom career lane has zero enabled production sites |
| Startup and founder sourcing | 35% | YC/VC and enrichment primitives exist; focused daily dispatch, real signals and founder providers are incomplete |
| India-eligible remote sourcing | 55% | Five native feeds work; eligibility evidence and durable cadence need hardening |
| Outreach drafting and tracking | 50% | Local drafts/manual confirmation exist; person approval, sequence integrity and real delivery adapters are incomplete |
| Old-contact reactivation | 10% | No Gmail history or LinkedIn conversation ingestion |
| Apify cost-efficient rescue | 25% | Profiles and runtime bounds exist; no cache/watermark/budget state |

Overall conclusion: roughly half of required opportunity system exists. Fastest path is correcting and wiring existing pieces before adding broad new crawling infrastructure.

## Verified implementation gaps

### Discovery and freshness

1. `crawler/cli.mjs` passes no schedule/mode/location to `runDailyNormal()` for `daily`.
2. `crawler/daily-runner.mjs` hardcodes `schedule: 'morning'`, `mode: 'normal'`, and `locationPreset: 'india'`.
3. launchd descriptors pass `daily morning|midday --mode ... --location-preset ...`, but the daily CLI path ignores those values.
4. `job-pull/freshness.mjs` treats both `workday-startDate` and `workday-postedOn` as verified date kinds.
5. `runNormalMode()` invokes the shared pipeline with `dryRun: true`; `runPipeline()` records surfaced opportunities only when `dryRun` is false.
6. SQLite surfaced-state tests currently preserve indefinite suppression, conflicting with the seven-day opportunity-ledger policy.
7. warm ATS has rotation state, but operator source plans do not persist it as the durable source cursor.
8. scheduled runs write logs but do not notify the operator about new Hot/Active matches or source failures.

### Startup and remote

1. YC and VC search lanes exist.
2. several declared startup source lanes have no production source functions.
3. no startup career sites are enabled.
4. funding/hiring signal enrichment exists but production signal providers are absent.
5. startup application payload nests `companyRecord`, while the real gateway reads `operation.company`; company intelligence can be lost.
6. native remote feeds are wired, but secondary cadence uses calendar modulo rather than last successful run.
7. remote eligibility accepts context-free `global`/`India` tokens and does not enforce timezone compatibility.
8. unified daily mode does not dispatch to Startup or Remote selectors.

### Outreach and relationships

1. local contact research and draft construction exist.
2. `allowPaid` defaults to `true`.
3. research automatically selects the highest-ranked person and immediately drafts.
4. old Gmail threads are not ingested.
5. Gmail draft creation is not implemented.
6. LinkedIn hiring-post rescue is read-only, but conversation history/import is absent.
7. follow-up confirmation can occur early/out of order and overwrites `Sent At` with later touches.
8. Activity v5 has no Outreach relation or immutable sequence key.
9. reply/outcome handling is manual; reply observation does not exist.
10. no production founder/team/public-profile providers are wired.

### Apify

1. stable profiles, explicit selection, maximum three profiles, and timeout bounds exist.
2. Naukri, Foundit and LinkedIn have static freshness filters; Hirist/Wellfound/Cutshort cannot guarantee fresh-only input.
3. each invocation starts a new Actor and downloads the full dataset.
4. only same-invocation duplicate Actor IDs are suppressed.
5. no profile watermark, retained dataset offset, seen job keys, last successful run, or actual cost is persisted.
6. configured record limits are not enforced during dataset download.
7. no monthly budget or run-count guard exists.
8. no command consumes a retained dataset or local RAW file without another Actor run.

## Ticket backlog

### Wave 1 — correctness and detection speed

#### LP-001 — Make unified daily execution schedule/mode/location aware

**Priority:** P0  
**Goal:** make installed morning/midday and Normal/Startup/Remote arguments real.

Acceptance criteria:

- `crawler daily morning|midday --mode normal|startup|remote --location-preset india|pune` is parsed and passed through.
- midday executes only cheap delta lanes.
- Startup and Remote modes use their focused selectors after shared discovery.
- schedule health records correct schedule identity.
- integration tests cover launchd arguments through CLI into runner/source plan.

Dependencies: none.

#### LP-002 — Enforce Workday detail-date freshness policy

**Priority:** P0  
**Goal:** prevent refreshed Workday list labels from being ranked as fresh jobs.

Acceptance criteria:

- only corroborated detail `startDate` receives trusted Workday freshness.
- list-only `postedOn` enters VerifyQueue.
- contradictory freshness tests are updated.
- funnel telemetry distinguishes list-date verification from trusted dates.

Dependencies: none.

#### LP-003 — Unify cross-day suppression and seven-day cooldown

**Priority:** P0  
**Goal:** prevent both repeated jobs and permanent accidental suppression.

Acceptance criteria:

- final planned shortlist is recorded after successful planning.
- one timestamped lifecycle authority implements seven-day surfaced cooldown.
- applied/contacted/interviewing/rejected remain permanently suppressed.
- SQLite `surfaced` is not treated as permanent by itself.
- rerun, next-day, day-7, day-8 and actioned-state tests pass.

Dependencies: LP-001 for final unified dispatch shape.

#### LP-004 — Persist warm ATS and remote-provider rotation state

**Priority:** P0  
**Goal:** cover all enabled boards/providers over time without making every run expensive.

Acceptance criteria:

- warm ATS `rotationState` is committed to source cursor state.
- Pune/high-yield boards remain priority but all enabled boards are visited within a bounded window.
- secondary remote feeds use last-success timestamps, not UTC modulo alone.
- failed sources become eligible on the next run instead of silently waiting for the next calendar slot.

Dependencies: LP-001.

#### LP-005 — Notify on new fresh matches and degraded runs

**Priority:** P0  
**Goal:** surface bursty openings quickly.

Acceptance criteria:

- successful scheduled run emits a notification containing new Strict Hot/Active count and result/log location.
- fatal, stale, repeatedly failing and zero-source runs emit failure/degraded notifications.
- notification contains no applicant secrets and performs no application/outreach action.
- duplicate notifications are idempotent by run ID.

Dependencies: LP-001, LP-003.

#### LP-006 — Propagate complete resolver limits

**Priority:** P1  
**Goal:** make configured host/request budgets enforceable.

Acceptance criteria:

- `maxRedirects`, `maxHosts`, `maxBytes`, and `maxRequests` reach the resolver.
- config propagation test proves each limit.

Dependencies: none.

### Wave 2 — cost-efficient broad sourcing

#### LP-007 — Add Apify cache-first incremental state

**Priority:** P0  
**Goal:** never rerun a paid Actor merely to reprocess existing data.

Acceptance criteria:

- persistent state per profile: last run ID, dataset ID, consumed offset, max trusted posted date, last success, recent provider/canonical job keys.
- local RAW and retained dataset items are consumed before Actor startup.
- only unseen/unconsumed records enter preparation.
- watermark advances only after successful preparation and durable commit.
- 48-hour overlap is used where Actor input supports date filtering.
- undated profiles remain manual verification rescue.

Dependencies: LP-003 identity/lifecycle decisions.

#### LP-008 — Enforce Apify monthly budget and fresh-only run policy

**Priority:** P0  
**Goal:** fit one account and avoid wasted runs.

Policy:

- `monthlyBudgetUsd: 5`.
- `maxRunsPerMonth: 6` as user-selected operational ceiling.
- conservative `maxRunCostUsd` per profile.
- normally one profile per rescue run.
- no account rotation is part of Launchpad design.

Acceptance criteria:

- preflight blocks Actor startup if remaining budget or run count is insufficient.
- actual run cost is reconciled from run metadata.
- local hard dataset item limit is enforced.
- profile metadata declares date-filter capability and trusted output-date capability.
- rescue selector chooses source based on measured shortfall/yield, not a fixed every-day cadence.
- no run starts while cached/unconsumed results remain.

Dependencies: LP-007.

#### LP-009 — Repair career crawling and activate one verified Pune source

**Priority:** P1  
**Goal:** gain owned coverage outside known ATS boards.

Acceptance criteria:

- career-link matching uses pathname rather than hostname text.
- static assets cannot fill the job crawl queue.
- fallback candidates require verified job URL patterns.
- one high-value Pune source, such as a verified SuccessFactors/Birlasoft path or bounded Cybage adapter, is enabled.
- outputs retain existing evidence and original-listing boundaries.

Dependencies: LP-006.

#### LP-010 — Introduce Crawlee only at custom-career seam

**Priority:** P1  
**Goal:** add owned request queue/browser pooling without rewriting structured ATS adapters.

Acceptance criteria:

- one source-specific HTTP-first Crawlee worker exists.
- browser use is host-allowlisted and bounded by deadline/page/request/concurrency limits.
- selector/schema failures are explicit telemetry.
- output uses existing observation/candidate shape.
- direct ATS adapters remain unchanged.

Dependencies: LP-009.

#### LP-011 — Add default-off Firecrawl hard-page rescue

**Priority:** P2  
**Goal:** use Firecrawl only where measured Crawlee/direct retrieval fails.

Acceptance criteria:

- host allowlist and daily page/credit ceiling.
- no authenticated/private pages.
- extracted JSON is validated against page evidence.
- every result passes original-listing resolution.
- circuit breaker handles credit, rate and extraction failures.

Dependencies: LP-009, LP-010 and measured hard-page need.

### Wave 3 — startup and remote opportunity expansion

#### LP-012 — Activate focused startup sources and persist company intelligence

**Priority:** P1  
**Goal:** turn YC/VC/startup primitives into usable focused discovery.

Acceptance criteria:

- startup-tagged direct ATS boards and verified startup career pages become focused lanes.
- VC watchlist rotates through all verified companies.
- one evidence-backed funding/hiring signal provider is added without synthesizing jobs.
- operation shape includes `company: candidate.companyRecord`.
- Companies v5 receives career page, ATS, funding, stage and remote-policy evidence through real gateway tests.

Dependencies: LP-001, LP-004, LP-009.

#### LP-013 — Harden India-remote eligibility and evidence

**Priority:** P1  
**Goal:** stop false India eligibility while preserving genuine global/APAC roles.

Acceptance criteria:

- context-free words like `global team` do not prove remote eligibility.
- accepted evidence requires hire/work eligibility scoped to India/APAC/worldwide.
- exact evidence span is retained.
- timezone compatibility follows explicit policy.
- remote fields needed for selection are persisted in v5.

Dependencies: LP-001.

#### LP-014 — Wire founder/person research into selected-role handoff

**Priority:** P1  
**Goal:** produce founder/CTO/recruiter options without automatic contact selection.

Acceptance criteria:

- free public providers for hiring authors, team pages and public profiles are wired.
- Startup contact mix may reserve one founder/CTO slot when evidence exists.
- research returns up to two candidates with observation dates and source URLs.
- user selects person and channel before drafting.
- crawler emits planning-only contact research handoff for user-selected applications.

Dependencies: LP-012, LP-015.

### Wave 4 — relationship reactivation and outreach integrity

#### LP-015 — Add contact review gate and paid-provider safety

**Priority:** P0  
**Goal:** restore user-owned contact selection.

Acceptance criteria:

- `allowPaid` defaults to false.
- research does not auto-select a contact.
- no draft is generated until an approved person/channel token is supplied.
- paid sources require explicit per-run authorization.
- evidence observation date is required.

Dependencies: none.

#### LP-016 — Add read-only Gmail relationship history

**Priority:** P1  
**Goal:** find warm contacts before cold outreach.

Acceptance criteria:

- read-only connector returns thread ID, participants, direction, last inbound/outbound dates, subject and company/person identity.
- no mail send or modification capability.
- current opportunities can be joined to previous recruiter/founder conversations.
- output forms a manual warm-contact review queue.

Dependencies: LP-015 identity/review shape.

#### LP-017 — Fix outreach sequence integrity and Activity linkage

**Priority:** P0  
**Goal:** make cadence reliable across follow-ups and reloads.

Acceptance criteria:

- immutable Initial Sent At exists.
- Activity links to exact Outreach sequence by relation or immutable sequence key.
- early/out-of-order follow-up confirmation is rejected.
- later touches do not overwrite initial timestamp.
- cadence documentation and implementation agree.
- transaction updates Outreach, Activity and Application consistently.

Dependencies: v5 schema approval.

#### LP-018 — Add Gmail draft-only adapter

**Priority:** P1  
**Goal:** create reviewed drafts without sending.

Acceptance criteria:

- exact approved recipient, body and verified resume PDF are used.
- Gmail draft ID and attachment SHA-256 are stored.
- adapter exports no send function.
- contract tests reject send-capable methods.

Dependencies: LP-015, resume Ready artifact, connector authorization.

#### LP-019 — Observe replies and import LinkedIn conversations manually

**Priority:** P2  
**Goal:** stop or advance follow-ups using evidence.

Acceptance criteria:

- Gmail changes are read-only and propose response events.
- LinkedIn conversation evidence is pasted/imported manually.
- system determines whose turn and drafts a nudge/reply.
- user confirmation is required before Outreach/Application state changes.
- no LinkedIn browser automation, connection or message send.

Dependencies: LP-016, LP-017.

## Dependency graph

```text
LP-001 ─┬─> LP-003 ─> LP-005
        ├─> LP-004 ─> LP-012
        └─> LP-013

LP-003 ─> LP-007 ─> LP-008

LP-006 ─> LP-009 ─> LP-010 ─> LP-011
                    └───────> LP-012

LP-015 ─┬─> LP-014
        ├─> LP-016 ─> LP-019
        └─> LP-018

LP-017 ─> LP-019
LP-012 ─> LP-014
```

## Fast execution recommendation

Start two parallel workstreams after ticket approval:

### Stream A — fresh-role radar

1. LP-001
2. LP-002
3. LP-003
4. LP-004
5. LP-005
6. LP-007
7. LP-008

### Stream B — relationship safety and integrity

1. LP-015
2. LP-017
3. LP-016
4. LP-018

Then expand coverage with LP-009/010/012/013/014. Firecrawl and response automation remain later, evidence-triggered work.

## Connector authorization interpretation

User authorized connectors/MCPs for research, read operations, drafting and approved plan execution. This does not override Launchpad safety boundaries:

- external sending remains manual;
- LinkedIn messaging/connection remains manual;
- `Make Resume` and `Applied?` remain user-owned;
- live v5 writes remain scoped, journaled and explicitly invoked;
- paid providers require budget and per-run controls;
- account rotation is not used to bypass provider limits or pricing.
