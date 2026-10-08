# Launchpad full production implementation plan

Status: Draft. Last updated: 2026-08-31.


## Context

Launchpad has substantial local implementation and a passing test suite, but it is not producing a dependable morning queue. Scheduled Normal/Pune runs remain partial, recent scheduled runs produced zero shortlist rows, live v5 state is ambiguous, resume and sync code lack live entrypoints, canary evidence generation is unwired, and installed launchd agents point at a mutable dirty checkout.

This plan changes the objective from "more locally complete code" to one working daily loop:

```text
fresh jobs
-> strict eligibility and freshness gates
-> at least 5 qualified roles on normal inventory days
-> Applications v5 delivery
-> user-selected truthful resume
-> manual application
-> idempotent sync
-> immutable scheduled operation with rollback
```

Passing tests remains necessary but no longer counts as completion. Each phase ends with retained operational evidence.

## Definition of done

Initial production profile:

```text
morning / normal / pune / production / live-v5
```

Launchpad is fully working when one immutable release:

1. Produces at least 5 fresh, eligible, employer-linked roles on normal inventory days.
2. Treats 0-4 roles as a valid market shortfall only when machine accounting is complete and Onkar confirms retained inventory.
3. Writes selected rows to Applications and Companies v5 with verified relations and idempotent replay.
4. Builds a truthful one-page PDF only after Onkar checks `Make Resume`.
5. Records an application only after Onkar submits manually and checks `Applied?`.
6. Runs successfully on seven distinct valid UTC dates with one revision, config, profile, and matching report pairs.
7. Runs from an immutable scheduled checkout and has retained rollback proof.

Hard boundaries remain unchanged:

- Never auto-apply.
- Never send email, DM, referral request, or LinkedIn action.
- Never write `Make Resume` or `Applied?`.
- Never invent freshness, eligibility, experience, salary, contact, or resume evidence.
- Never fall back to v3/v4.
- Keep `maximumPerCompany = 2`.

## Current facts that shape implementation

- Local gates pass: 768/768 tests, validation, six safety checks, and diff checks.
- Scheduled morning runs from 2026-08-24 through 2026-08-31 remained partial and produced no useful shortlist.
- Best manual shadow produced 18 ready/scored rows and 3 selected rows, but scheduled-path behavior differs by roughly 40x in fetched count.
- Static source allocations strand unused time instead of returning it to later sources.
- Source cancellation can discard observations already collected by adapters.
- Portal original-listing resolution is sequential and can consume the entire source budget.
- Workday DETAIL enrichment has no signal/deadline and is disabled whenever discovery is partial.
- Ready inventory is concentrated in too few companies, so the company cap correctly limits selection.
- Existing reports use conflicting count vocabularies. The 4,818 versus 6,696 shadow totals must be classified, not hand-reconciled.
- External journal contains 20 `committed` entries dated 2026-07-25, while status documents claim no successful live write exists.
- Current canary log has 51 records and zero valid dates.
- Canary report generator exists but runtime does not call it.
- Resume queue and application sync implementations exist, but only fixture rehearsal constructs a compatible gateway.
- Installed launchd agents use the mutable source checkout and omit live-write flags.

## Ownership

| Owner | Work |
|---|---|
| Engineer | Code, config, tests, CLI, reports, release and schedule tooling |
| Operator | No-write shadows, journal audit, preflight, live pilot, evidence retention, canary operation |
| Onkar | Credential rotation, Notion sharing, live approvals, inventory confirmation, checkboxes, resume review, manual application |
| Reviewer | Diff review, clean candidate approval, promotion and rollback approval |

## Phase 0: establish one current truth

This phase can run in parallel with Phase 1 engineering. Live writes cannot start until it completes.

### 0.1 Reconcile retained Notion journal state

Add a read-only journal audit command around existing transaction and gateway code:

```text
node crawler/cli.mjs audit-v5-journal \
  --credential-file ABS_PATH \
  --journal ABS_PATH \
  --receipt ABS_PATH
```

For every historical committed page ID:

1. Read journal metadata without printing credential values.
2. Fetch recorded page read-only from declared v5 scope.
3. Classify entry as retained live page, synthetic artifact, stale test artifact, malformed record, or unresolved.
4. Record target, state, page existence, relation state, and redacted evidence in an external 0600 receipt.
5. Never delete journal rows to unblock retry.
6. Block Phase 4 pilot while any relevant entry remains unresolved.

Critical files:

- `notion-v5/transaction.mjs`
- `notion-v5/gateway.mjs`
- `crawler/cli.mjs`
- `tests/notion-v5/gateway.test.mjs`
- `tests/notion-v5/transaction.test.mjs`

### 0.2 Normalize status authority

After evidence exists, update current authority files together:

- `docs/STATUS.md`
- `docs/SYSTEM-REFERENCE.md`
- `docs/plans/launchpad-daily-production-adoption.md`
- `config/launchpad-v5.commands.json`
- `crawler/operator.mjs` help output

Correct stale test counts, command flags, scheduler state, receipt counts, journal claims, and Phase A claims. Add validation that command manifest and CLI help expose every live-sensitive flag.

### Phase 0 acceptance

- Every historical committed journal entry has a retained classification.
- No pending or verified recovery entry is hidden or deleted.
- Status docs agree with journal receipt and current CLI.
- Command manifest, help output, and safety checks agree.
- Live pilot remains blocked if journal state is ambiguous.

## Phase 1: make scheduled discovery finish and retain its work

Goal: scheduled-path no-write runs complete instead of returning partial with zero shortlist.

### 1.1 Recycle unused source time

Refactor `planSourceBudgets()` and source execution so later sources receive actual unused time while minimum start allocations remain protected.

Use current runtime deadline as truth:

```text
remaining = actual discovery time remaining
reserve = later source count * minimumSourceStartAllocationMs
current allowance = min(configured cap, remaining - reserve)
```

Do not subtract a source's full planned allocation before knowing actual consumption. Preserve deterministic planner output for inspection, then calculate runtime allowance immediately before each source starts.

Add telemetry:

- `initialPlannedAllocationMs`
- `runtimeAllowanceMs`
- `actualDurationMs`
- `unusedMs`
- `recycledMs`
- `laterSourceReserveMs`
- `capHit`

Critical files:

- `crawler/deadline.mjs`
- `crawler/run.mjs`
- `tests/crawler/source-budgeting.test.mjs`

### 1.2 Retain partial source observations

Add optional checkpoint support to `fetchSource()`:

```js
source.fetch({ ..., checkpoint })
```

`checkpoint({ observations, cursor, manifestDelta })` must persist observations and cursor idempotently before more network work begins. Final source results use the same persistence path.

Wire checkpointing first into sources proven to lose useful work:

- Portal discovery
- Enterprise ATS/Workday enumeration and hydration

If a source hits its cap after checkpointing, status remains `truncated`, but retained rows stay available and accounting reports them. A source that ignores cancellation still fails through the existing final guard.

Critical files:

- `crawler/run.mjs`
- `crawler/operator.mjs`
- `crawler/ats-enterprise.mjs`
- `tests/crawler/run.test.mjs`
- `tests/crawler/operator.test.mjs`
- `tests/crawler/ats-enterprise.test.mjs`

### 1.3 Bound and parallelize original-listing resolution

Replace sequential resolution in portal discovery with a shared bounded batch built on `mapProviderSafe()`.

Initial production limits:

- Target-screen candidates before network resolution.
- Maximum 24 candidates per portal source run.
- Maximum 48 resolver requests.
- Maximum 60 seconds or source allowance minus handoff reserve.
- Concurrency across providers/hosts: 3.
- Per destination host: 1 request at a time.

Resolved employer URLs proceed. Unresolved portal rows remain in `VerifyQueue`; they never enter selection with an aggregator URL.

Critical files:

- `crawler/operator.mjs`
- `crawler/bounded-concurrency.mjs`
- `crawler/original-listing-resolver.mjs`
- `tests/crawler/operator.test.mjs`
- `tests/job-pull/portal-adapters.test.mjs`

### 1.4 Give Workday DETAIL a real deadline and reserve

Extend `enrichWorkdayCandidates()` with `signal` and `deadline`. Pass them to DETAIL requests and stop starting work when no budget remains.

Within enterprise source execution:

- Reserve a fixed share of source allowance for DETAIL hydration.
- Retain LIST observations incrementally.
- Hydrate Pune priority rows before broad enumeration consumes the source budget.
- Use bounded request count and existing board-fair ordering.
- Keep LIST-only and undated rows in `VerifyQueue`.

For downstream enrichment after a partial crawl, use a reduced non-zero budget instead of `0`, bounded by remaining downstream time.

Critical files:

- `job-pull/workday-enrichment.mjs`
- `crawler/ats-enterprise.mjs`
- `crawler/daily-runner.mjs`
- `tests/job-pull/workday-enrichment.test.mjs`
- `tests/crawler/ats-enterprise.test.mjs`
- `tests/crawler/daily-runner.test.mjs`

### 1.5 Stop dead lanes consuming Normal morning budget

Update production config from measured evidence:

- Disable SearXNG while local endpoint returns empty.
- Disable dependent India-startup lane in Normal profile.
- Keep unavailable remote-ATS transport as explicit omission, not healthy-empty success.
- Keep Startup, Remote, browser-heavy portals, and midday live delivery disabled.
- Set per-source caps from retained duration data.
- Increase whole-run/discovery budgets only enough to cover measured healthy sources while preserving downstream and handoff reserves.

Do not weaken gates or company diversity to hit volume.

Critical files:

- `config/crawler-v2.json`
- `config/crawler-v2-dev.json`
- `crawler/deadline.mjs`
- `tests/crawler/source-budgeting.test.mjs`
- `tests/crawler/discovery-profile.test.mjs`

### 1.6 Standardize count vocabulary

Use one set of names in SQLite telemetry, JSON reports, Markdown reports, notifications, and canary evidence:

```text
networkRecordsSeen
observationsProduced
observationsRetained
duplicateObservations
candidatesNormalized
verificationQueue
fresh
eligible
ready
scored
selected
plannedOperations
newlyCommitted
alreadyCommitted
failedDelivery
recoveryBlocked
surfaced
```

Classify old 4,818 and 6,696 values according to this vocabulary. Do not alter old evidence.

Critical files:

- `crawler/source-yield.mjs`
- `job-pull/funnel-report.mjs`
- `job-pull/mode-scoring.mjs`
- `crawler/daily-runner.mjs`
- report tests under `tests/crawler/` and `tests/job-pull/`

### Phase 1 acceptance

Run focused tests, then full local gates:

```sh
node --test \
  tests/crawler/source-budgeting.test.mjs \
  tests/crawler/run.test.mjs \
  tests/crawler/operator.test.mjs \
  tests/crawler/ats-enterprise.test.mjs \
  tests/crawler/daily-runner.test.mjs \
  tests/job-pull/workday-enrichment.test.mjs

npm run validate
npm run safety
npm test
node crawler/cli.mjs readiness --run-tests
git diff --check
```

Run three scheduled-path production-config no-write shadows on separate dates.

Pass when:

- Three consecutive runs reach terminal `completed` discovery/accounting state.
- Every enabled source completes or has a predeclared planner omission.
- No source exceeds its runtime allowance.
- Observation and funnel counts balance.
- No ready row remains unscored.
- Median selected count is at least 5, or any lower result has complete shortfall evidence.
- Ready pool contains at least 10 distinct companies across the three runs.
- Selected rows retain employer URL, Active liveness, verified freshness, accepted eligibility, finite score, and no queue overlap.
- External side-effect counters remain zero.

### STOP 1

No Notion write, credential read, schedule change, release creation, commit, push, or promotion.

## Phase 2: close LP-009 and improve employer-direct diversity

LP-009 is mandatory because upstream company concentration prevents the company cap from producing five roles.

### 2.1 Wire existing path-based career discovery

Reuse `classifyCareerUrl()` and related path/static-asset handling from `crawler/career-page-discovery.mjs`. Replace full-URL hostname matching in runtime `company-careers.mjs`.

Requirements:

- Match career/job patterns against pathname and page evidence, never hostname substring alone.
- Reject static extensions and static content types before queue insertion.
- Require verified job URL patterns, JobPosting JSON-LD, job sitemap evidence, or source-specific adapter evidence.
- Preserve robots, host spacing, page/request/deadline caps, original-listing evidence, and `VerifyQueue` behavior.
- Remove duplicate classification implementations where safe; one shared classifier owns URL classification.

### 2.2 Activate one verified Pune source

Start with Birlasoft job sitemap or bounded Cybage adapter, whichever passes live no-write verification first.

Acceptance:

- One source enabled in production config.
- Static assets cannot fill queue.
- At least one retained Pune employer-direct role reaches normalized funnel with original URL and usable date evidence.
- Source cannot make Normal morning run partial.
- Source reports explicit zero-yield or failure telemetry.

Critical files:

- `crawler/company-careers.mjs`
- `crawler/career-page-discovery.mjs`
- `crawler/workflow.mjs`
- `config/crawler-v2.json`
- `tests/crawler/career-page-discovery.test.mjs`
- company-career tests

### STOP 2

Re-run Phase 1 shadows. Do not add Crawlee or Firecrawl yet.

## Phase 3: make reports, shortfalls, and canary evidence executable

### 3.1 Wire canary report generation

Call existing `writeDeliveryCanaryReport()` from daily runtime after final delivery reconciliation and before canary validation. Evidence must be generated from machine result, not hand-authored.

Add explicit external paths:

- `--canary-report-root ABS_PATH`
- `--canary-log ABS_PATH`
- `--notification-log ABS_PATH`

Reports bind:

- Run ID
- Revision
- Code/config fingerprint
- Normalized profile
- Inventory identity
- Source/funnel/reconciliation counts
- Transaction result
- Markdown digest

No report pair means degraded outcome.

### 3.2 Add honest shortfall finalization

Daily result states:

```text
completed                  >=5 selected and all gates pass
shortfall_pending_review   0-4 selected, machine accounting complete
completed_shortfall        pending shortfall plus retained manual inventory confirmation
degraded                   any operational or evidence defect
```

Add a command that finalizes an existing immutable run using an external manual inventory evidence file. It cannot alter shortlist or rerun discovery.

```text
node crawler/cli.mjs finalize-shortfall \
  --run-id ID \
  --manual-inventory-evidence ABS_PATH \
  --canary-report-root ABS_PATH \
  --canary-log ABS_PATH
```

A pending shortfall does not count toward promotion. A finalized shortfall may count only when all machine gates pass and Onkar confirms fewer than five valid roles existed.

Critical files:

- `crawler/canary-report.mjs`
- `crawler/delivery-canary.mjs`
- `crawler/canary-evaluator.mjs`
- `crawler/daily-runner.mjs`
- `crawler/cli.mjs`
- corresponding tests

### Phase 3 acceptance

- Matching Markdown/JSON pair generated automatically for every completed live-capable run.
- Digest and inventory identity validate.
- Machine counters cannot be lowered by manual evidence.
- Pending shortfall never counts.
- Source, resolver, scorer, report, notification, or reconciliation defect remains degraded.
- Current four canary failure classes are eliminated in focused tests: missing evidence, degraded outcome caused by wiring, healthy-reported outage mismatch, undefined scorer counters.

## Phase 4: reconcile credentials and prove one live row

Phase 4 starts only after Phase 0 journal audit and Phase 1/2 no-write acceptance.

### 4.1 Human setup

Onkar:

1. Rotates exposed Notion credential and does not reuse old value.
2. Stores new token in a 0600 file outside repository.
3. Shares all five v5 databases with integration.
4. Approves read-only preflight.
5. Reviews preflight receipt.
6. Separately approves one-row write.

### 4.2 Add explicit preflight command

Expose gateway-owned preflight without a write:

```text
node crawler/cli.mjs live-preflight \
  --credential-file ABS_PATH \
  --journal ABS_PATH \
  --receipt ABS_PATH
```

Preflight validates manifest, relations, credential ownership/mode, journal path, target access, and blocking recovery state. Receipt stays outside repo and contains no secret.

### 4.3 Run one-row write and exact replay

```text
node crawler/cli.mjs daily morning \
  --env production \
  --mode normal \
  --location-preset pune \
  --shortlist-limit 1 \
  --execute-writes \
  --credential-file ABS_PATH \
  --journal ABS_PATH \
  --canary-report-root ABS_PATH \
  --canary-log ABS_PATH \
  --notification-log ABS_PATH \
  --run-id ID
```

Replay exact run identity and operation key.

Acceptance:

- One Applications v5 row exists.
- Company relation verifies by read-back.
- Employer URL, score, freshness, tier, source, Run ID, and relaxation evidence match report.
- Create payload omits user-owned fields rather than setting them.
- Replay creates zero pages and reports `alreadyCommitted`/`replayed`.
- Replay does not refresh cooldown or increment surfacing.
- Journal has no requested pending/verified entry.
- Pilot does not count toward seven-date streak.

### STOP 3

Do not check user-owned fields automatically. Do not promote or install schedule.

## Phase 5: make resume and sync commands work against live v5

### 5.1 Add live gateway command entrypoints

Create guarded CLI entrypoints for existing implementations:

```text
node launchpad-v5.mjs make-applications \
  --credential-file ABS_PATH \
  --journal ABS_PATH

node launchpad-v5.mjs sync \
  --credential-file ABS_PATH \
  --journal ABS_PATH
```

Reuse:

- `processMakeResumeQueue()`
- `createLocalResumeBuilder()`
- `verifyResumeArtifact()`
- `syncAppliedApplications()`
- existing scoped gateway and journal reservations

Both commands must query only v5 stores and print redacted receipts.

### 5.2 Prove one real resume

Onkar checks `Make Resume` on pilot row. Resume workflow creates:

- `.tex`
- `.matrix.md`
- `.provenance.md`
- one-page `.pdf`

Pass `node tests/resume/verify.mjs`, frozen template checks, provenance checks, one-page check, and page-fill gate. Command may update only `resumeState`.

### 5.3 Prove manual application sync

Onkar reviews PDF, submits manually, then checks `Applied?`.

Run `/sync` twice.

Acceptance:

- First sync updates derived application state and creates one deterministic Activity row.
- Second sync is noop.
- Applied timestamp remains stable.
- Opportunity becomes suppressed from resurfacing.
- Neither command writes `Make Resume` or `Applied?`.
- No application, email, or message is sent by Launchpad.

### STOP 4

No schedule or promotion change.

## Phase 6: create clean immutable candidate

### 6.1 Review and commit only after explicit approval

Before commit:

- Review all dirty paths and separate unrelated user work.
- Update canonical status and runbooks.
- Run full local gates.
- Obtain explicit commit approval.

### 6.2 Prepare content-addressed checkout

Reuse `crawler/release-manager.mjs`:

- Require exact clean revision.
- Create detached checkout outside source repo.
- Run `npm ci --ignore-scripts`.
- Run full validation from release checkout.
- Bind revision, lockfile, config fingerprint, manifest fingerprint, source registry, and normalized profile.
- Initial installed profile contains only `morning / normal / pune`.

Prepare schedule specs but do not install them.

### Phase 6 acceptance

- Source checkout clean and exact revision retained.
- Release checkout clean and content-addressed.
- Validation passes inside release checkout.
- Release receipt candidate records all fingerprints.
- No plist points at mutable source tree in proposed output.

### STOP 5

Candidate exists. Existing schedule remains unchanged until seven-date proof and separate approval.

## Phase 7: seven-date immutable canary

Run manually from same immutable release on seven distinct valid UTC dates.

Each date uses identical:

- Revision
- Lockfile/install
- Production config fingerprint
- Source registry
- Normalized profile
- Manifest
- Journal identity
- Report schema

Each date must produce either:

- `completed` with at least 5 qualified roles, or
- `completed_shortfall` with retained manual inventory proof.

Retain per date:

- Markdown and JSON report pair
- Source manifests and budget telemetry
- Observation accounting
- Resolver accounting
- Workday DETAIL accounting
- Funnel and company-cap exclusions
- Selected/planned/delivered key reconciliation
- Transaction and ledger result
- Notification receipt
- Inventory identity
- Manual inventory evidence where needed
- Clean revision/config fingerprint

Any degraded or pending-shortfall date does not count. Revision or config change restarts streak.

### STOP 6

Report seven-date evidence. Promotion still needs separate approval.

## Phase 8: promote live morning schedule and prove rollback

### 8.1 Extend immutable schedule specification

Extend `buildAgentPlist()` and release manager with explicit live-delivery options.

Morning plist includes paths, never secret values:

```text
--execute-writes
--credential-file ABS_PATH
--journal ABS_PATH
--canary-report-root ABS_PATH
--canary-log ABS_PATH
--notification-log ABS_PATH
```

Rules:

- Only morning Normal/Pune agent receives live flags.
- Midday live agent is absent.
- Working directory and CLI path point at immutable release.
- Logs and state live outside release checkout.
- Release receipt records argument fingerprint and delivery mode.
- Dry run prints complete plist and bootstrap plan without changing OS state.

Critical files:

- `crawler/install-schedule.mjs`
- `crawler/release-manager.mjs`
- `crawler/cli.mjs`
- `crawler/schedule-health.mjs`
- schedule/release tests

### 8.2 Promotion and first scheduled run

Run promotion dry run. Review generated agents. Remove dry-run only after explicit approval.

Observe first scheduled run and verify:

- Immutable path and expected revision
- Completed outcome or finalized shortfall
- Live v5 delivery
- Report pair
- Notification receipt
- No journal recovery
- User-owned values unchanged

### 8.3 Rollback drill

Dry-run rollback, then execute after approval. Verify previous no-write schedule boots and runs. Restore live release through normal promotion path. Retain promotion, rollback, `launchctl print`, and first-run receipts.

### Phase 8 acceptance

- Installed morning agent points only at immutable checkout.
- First scheduled live run succeeds.
- Rollback restores previous recorded schedule.
- Re-promotion restores candidate release.
- Current release receipt, installed plist, and schedule-health report agree.

## Phase 9: close LP-010 and LP-011 without blocking useful production

These tickets come after initial working production. They must not delay jobs.

### 9.1 LP-010: Crawlee at custom-career seam

After LP-009 no-write evidence, implement one default-off source-specific HTTP-first Crawlee worker.

Requirements:

- Exists only behind custom-career adapter seam.
- Direct ATS adapters remain unchanged.
- Browser fallback host-allowlisted.
- Deadline, page, request, memory, and concurrency limits enforced.
- Selector/schema failures produce explicit telemetry.
- Output uses existing observation shape and original-listing gates.
- Default Normal morning profile keeps it off until benchmark proves net useful yield.

Promote LP-010 source only if it recovers employer-direct roles without making scheduled path partial.

### 9.2 LP-011: Firecrawl hard-page rescue

First retain measured pages where direct HTTP and bounded Crawlee both fail. If no measured need exists, keep LP-011 blocked and record evidence rather than adding unused paid infrastructure.

If triggered:

- Default off.
- Public unauthenticated pages only.
- Host allowlist and daily page/credit ceiling.
- Structured extraction validated against fetched page evidence.
- Every result passes original-listing resolution.
- Circuit breaker handles credits, rate limits, malformed extraction, and provider outage.
- Failure never blocks healthy primary sources.

## Parallel work and dependencies

Safe parallel work:

- Phase 0 journal audit command and Phase 1 discovery fixes.
- Budget recycling, portal resolver batching, and Workday deadline work in separate bounded changes.
- Command/help/manifest synchronization alongside focused tests.
- Phase 2 career-source work after shared classifier contract is settled.

Must remain sequential:

```text
scheduled-path discovery acceptance
-> journal reconciliation
-> live preflight
-> one-row write/replay
-> resume proof
-> manual application/sync
-> clean immutable candidate
-> seven valid dates
-> live schedule promotion
-> rollback drill
```

LP-010 follows LP-009. LP-011 follows measured LP-010/direct failure evidence.

## Verification matrix

### Local code

```sh
npm run validate
npm run safety
npm test
node crawler/cli.mjs readiness --run-tests
git diff --check
```

### Discovery behavior

- Three scheduled-path production no-write runs.
- No lost observations.
- No unaccounted source.
- No ready unscored row.
- Median selected count at least 5 or retained valid shortfall.
- At least 10 distinct ready companies across validation window.

### Live pilot

- Scoped preflight receipt.
- One row and Company relation.
- Exact replay with zero duplicates.
- User-owned fields untouched.
- Journal and cooldown reconciliation.

### Application flow

- Verified four-file resume artifact set.
- One manual application.
- Two sync runs, second noop.
- Applied opportunity suppressed.

### Promotion

- Clean immutable revision.
- Seven valid UTC dates.
- Installed immutable morning schedule.
- First scheduled live run.
- Rollback and restoration receipts.

## Risks and controls

| Risk | Control |
|---|---|
| More code, still no jobs | Phase 1 exits only on scheduled-path yield evidence |
| Volume pressure weakens quality | Keep all gates and company cap; valid shortfall records market reality |
| Partial source loses useful rows | Optional durable checkpoints plus balanced observation accounting |
| One source consumes run | Runtime allowance, later-source reserve, request and resolver caps |
| Live state duplicates historical rows | Journal audit before pilot; exact replay proof |
| Manual evidence overrules machine failure | Machine counters can only invalidate, never be lowered |
| Dirty checkout reaches schedule | Promotion requires clean content-addressed release |
| Added source tools widen failure area | LP-010/011 default off and evidence-gated |
| User-owned fields mutate | Payload omission tests plus live read-back before/after |
| Seven-day streak becomes ceremony | Every day must contain real delivery/report/inventory evidence |

## Recommended execution order

1. Phase 0 journal/status audit and Phase 1 discovery fixes.
2. Phase 2 LP-009 employer-direct Pune source.
3. Phase 3 automatic reports and valid shortfall flow.
4. Three scheduled-path no-write acceptance runs.
5. Phase 4 credential setup, preflight, one-row pilot, replay.
6. Phase 5 live resume and application sync proof.
7. Phase 6 clean immutable candidate.
8. Phase 7 seven-date canary.
9. Phase 8 schedule promotion and rollback.
10. Phase 9 LP-010 and evidence-gated LP-011.

Fastest useful milestone is end of Phase 1/2: a retained local morning shortlist with at least five qualified employer-linked roles. First real v5 milestone is end of Phase 4. Full production completion is end of Phase 8.
