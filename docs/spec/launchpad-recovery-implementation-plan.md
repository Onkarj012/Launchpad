# Historical implementation plan — DCO-2026-07-25 Launchpad Production Recovery

> **Historical execution plan, not current status.** This document preserves the dated branch, inventory, test counts, implementation gaps, and proposed waves reviewed on 2026-07-25. Many claims were superseded by later working-tree implementation, including schedule/mode dispatch, Workday freshness, suppression/surfacing, and the canary evaluator. Do not use this file as a tracker or release baseline. See [`../STATUS.md`](../STATUS.md) for current execution status. The DCO remains the design/acceptance contract.

Status at the time: revised after review by gpt-5.6-sol (codex) and kimi-k2.7-code (opencode-go)
Date: 2026-07-25
Historical branch: `codex/conversion-plan-implementation`
Source DCO: `docs/spec/launchpad-production-recovery-dco.md`

Historical goal: get Launchpad producing 10–15 truthful application-ready roles per day, as fast as
possible, with no weakened gates, no fabricated evidence, and no skipped verification.

---

## 0. Historical verified ground truth (checked on 2026-07-25)

| Claim | Verified | Evidence |
|---|---|---|
| Full suite green on that working tree | yes, historical evidence only | `node --test tests/crawler/*.test.mjs tests/job-pull/*.test.mjs` → 499 pass, 0 fail, 33.7s on the dated checkout; not a current baseline |
| Uncommitted work exists and must be preserved | yes | 6 modified + **8 untracked** (corrected — both reviewers caught the undercount); in-run codex Match Scorer (`job-pull/match-scorer.mjs`, 302 lines) + scoring-gate policy + 7 new tests in modified files + 6 in `tests/job-pull/match-scorer.test.mjs`. Green, never committed. **Not "complete" — see §0.2.** |
| A1 — `daily` ignores schedule/mode/preset | yes | `crawler/cli.mjs:129-142` — the `daily` branch passes only `config`, `runId`, `scores`, `scorer`, `canaryStore`. `run` (line 146) parses the profile; `daily` does not. |
| A2 — env default is dev | yes | `crawler/cli.mjs:44` — `explicitOption(args, '--env') ?? 'dev'`. Scheduled launchd command selects production; a bare manual `daily` silently runs dev. |
| A3 — fixed board slices | yes | `crawler/ats-warm.mjs:111`, `crawler/ats-batch-1.mjs:209`, `crawler/ats-batch-2.mjs:230` — all `slice(0, maxBoards)` from a static registry order. No cursor, no rotation. |
| B2 — suppression runs off the final pool | yes | `job-pull/run.mjs:244` builds `scoringCandidates` before the suppression loop at `:257`; suppression is tagged onto entries but the exported pool is pre-suppression. |
| C1 — no daily Markdown writer | yes | Nothing under `crawler/` or `job-pull/` writes `logs/daily/*.md`. The three files in `logs/` are skill-authored, last one 2026-07-22. |

Codebase size: 41 `crawler/*.mjs` + 44 `job-pull/*.mjs` ≈ 18.5k lines, 74 test files.

### 0.1 Measured inventory (production DB, `.local/launchpad-crawler/crawler.sqlite`, 634 MB, 11,314 jobs)

This is the part the DCO does not have: what is actually *in* the durable store today.

| Fact | Value |
|---|---|
| Open jobs | 11,314 |
| Workday rows | 8,063 (71% of all inventory) — **11 of them carry a posted date** |
| Open + dated + posted within 14d | 1,125 |
| Of those, India-located | 329 · remote-ish 260 · other 516 · blank 20 |
| India + fresh, by provider | smartrecruiters 225 · ashby 44 · greenhouse 32 · himalayas 17 · lever 8 · workday 1 |
| **India + fresh, by company** | **bosch group 225** · bjak 25 · pure storage 10 · phonepe 8 · zscaler 5 · zeta 5 · devrev 4 · then a tail of 1–3 |
| Distinct India-hiring companies, last 14d | **41** |
| Distinct India-hiring companies, all time | 145 |
| Open jobs with a stored JD | 2,857 of 11,314 (25%) |

There are **two separate board scans**, and only one of them is starved:

- `sources.atsWarm` — 19 operator-curated India-first boards (greenhouse phonepe/commerceiq/devrev/
  purestorage/zscaler/postman/groww/druva/6sense/observeai · lever meesho/zeta/mindtickle · ashby
  atlan/uipath/plane/…), `maxBoards: 20`. All 19 are scanned. **This lane works** — it is where the
  phonepe / pure storage / zscaler / zeta / devrev / atlan / uipath / plane rows come from.
- The **tracked registry scan** in `crawler/daily-runner.mjs:222` — `config.sources.trackedAts` is
  **absent from the config**, so `fetchWarmAts` falls back to its default `maxBoards = 40`
  (`crawler/ats-warm.mjs:106`) over `projectTrackedBoards(registry)` = 237 boards **in registry
  order**. Registry composition is `workday 123 · greenhouse 57 · ashby 41 · lever 11 ·
  smartrecruiters 2 · pinpoint/recruitee/workable 1 each`, and the first 40 enabled entries are
  **100% Ashby**. So 57 greenhouse boards, 11 lever boards, and 123 workday boards in the registry
  are *never fetched at all* — permanently, every run, by list order.

Four conclusions follow, and they reorder the plan:

1. **Coverage is the dominant term, not readiness — and the cheapest fix is config, not code.**
   The single largest India source is `sources.atsBatch1` → smartrecruiters `BoschGroup`
   (`country: "in"`), which alone produced 225 of the 329 fresh India rows from **one board entry**.
   `atsBatch1` contains exactly four boards (Bosch, Visa, Blue Altair, Delta Capita). Adding more
   `country: "in"` smartrecruiters/greenhouse boards for India-hiring companies is a JSON edit with
   no code risk and a directly measurable yield. That can ship today, ahead of `DCO-P0-04`.
   `DCO-P0-04` (rotation) then unlocks the 57 unreachable greenhouse registry boards.
2. **Workday is 71% of inventory and contributes ~0 eligible rows**, because it is undated and
   freshness is a hard gate. Commit `76bc53f` (date Workday rows from the LIST `postedOn` label)
   has dated 11 rows so far — it has effectively not run yet. `DCO-P1-02` (fair Workday hydration)
   is not a P1 nicety; it is 8,063 rows of dead weight consuming the request budget every run.
3. ~~**The binding constraint is distinct India-hiring companies; the DCO's largest omission is
   source expansion.**~~ **RETRACTED — see conclusion 4.** That count (41 companies / 14 days) was
   computed over *dated* rows only, which silently excluded the entire Workday pool. It is not the
   ceiling.
4. **Workday is the largest source of India company diversity in the system, and one branch throws
   all of it away.** Provider-level counts over open rows, India-located:

   | provider | distinct India-hiring companies | India rows |
   |---|---:|---:|
   | **workday** | **97** | **977** |
   | himalayas | 16 | 17 |
   | ashby | 13 | 100 |
   | greenhouse | 10 | 241 |
   | lever | 5 | 90 |
   | smartrecruiters | 2 | 484 |

   All 977 were first seen within the last 7 days. The companies are Qualys, Barclays, BlackRock,
   Micron, HPE, Fiserv, Nike, GE Healthcare, Harman, FactSet, Autodesk, BP, Chevron, JCI, SVB…
   Filtering to non-senior tech titles leaves **329 rows across 69 distinct companies**, including
   Autodesk Pune "Software Engineer (Context Graph, AI/ML)", Barclays Pune software engineer / data
   scientist / devops, and BP Pune software engineer / data engineer.

   Every one of them is discarded at `job-pull/freshness.mjs:26-33` for lack of a corroborated date.

   So the earlier framing — "Workday is undated dead weight, demote it" — was exactly backwards.
   It is not dead weight; it is the best India inventory in the store, held behind a dating bug.
   **The fix is `DCO-P1-02`, not new sources.** Board expansion drops from "the DCO's largest
   omission" to a hedge to run only if W1-1 underdelivers.

### 0.2 What review corrected (verified, not taken on trust)

Both reviewers were given the plan and the code. Every finding below was re-checked against the
source before being accepted.

**The dominant term is freshness, not readiness or coverage.** Sol's arithmetic on the DCO's own
recorded funnel is decisive: `54 → 9` loses 45 rows at freshness; `9 → 1` loses 8 at readiness.
Board rotation removed none of those 53 — it changes *future* supply, not this funnel. The
mechanism is `job-pull/freshness.mjs:26-33`: a Workday row whose `evidence.freshness.kind` is not
`workday-startDate` or `workday-postedOn` has its `postedAt` **forced to `null`**, which returns
`eligible: false` / `VerifyQueue`. Combined with §0.1: 8,063 Workday rows, **11 of them carrying
that evidence**. Freshness corroboration is the single largest lever and the plan had it in Wave 5.

Commit `76bc53f` already added the `workday-postedOn` evidence kind. It has dated 11 rows. **Before
any of this is scheduled, one measurement settles it: run the Workday lane and count how many of
the 8,063 become datable.** That is an hour, and it can reorder everything below.

**The uncommitted scorer is not "complete" — four DCO-B5 requirements are unmet.** Verified in code:

| B5 requirement (`DCO` §8 B5) | Actual state |
|---|---|
| isolate chunk files by run, remove stale output before spawn | `job-pull/match-scorer.mjs:268-269` — paths are `scores-chunk-${chunkIndex}.json` in a fixed workDir, no run ID. Concurrent runs collide. No stale removal. |
| whole-scoring deadline | only a per-chunk `timeoutMs` (`match-scorer.mjs:229`). No batch deadline. |
| treat spawn failure as broken scorer | `SCORER_SPAWN_FAILED` is thrown (`match-scorer.mjs:240`) but is **absent** from `BROKEN_SCORER_REASON_CODES` (`job-pull/normal-mode.mjs:190`), so it only fails the run past the 50% row threshold. |
| manual `--scores-json` through the no-JD clamp and JS Auto-Suggest | `job-pull/run.mjs:171,188` — `matchScore` taken raw with no clamp, and `autoSuggest: score.autoSuggest === true` takes the **model's boolean directly**. |

The last one is a guardrail breach, not a gap: `master_prompt`/DCO require Auto-Suggest to be
JS-computed from pipeline facts. `job-pull/match-scorer.mjs:100-108` does it correctly; the manual
path does not.

Consequence: **W0-1 commits this to preserve it, and immediately flips the CLI default to
opt-in.** `crawler/cli.mjs:133-137` currently defaults the in-run codex scorer **on**, which ships
all four defects into every production run.

**`markJobsSurfaced` already fires before any report exists.** `crawler/workflow.mjs:372-377` marks
reserve jobs surfaced at selection time. `DCO-P0-01` is therefore not "add a writer" — it must
*remove or defer that existing mutation*, or the DCO's "surfaced only after commit" invariant is
violated on day one, silently, by code that is already running.

**Conversion Score is a live selection tie-breaker** (`job-pull/normal-selection.mjs:30`), so
`DCO-B6` (recompute after Match Score) must land **before** `DCO-P0-09`, not after it.

**Wave 1 was not safely parallel.** My "different files, no overlap" claim was false: `DCO-P0-02`
and `DCO-P0-04` both edit `crawler/daily-runner.mjs` (`:174-183` vs `:222-227`), and `DCO-P0-01`
and `DCO-P0-07` both edit `job-pull/normal-mode.mjs` (`:275-286`). Worse than a merge conflict —
the report writer must be authored against the output shape readiness repair produces.

**The seven-run canary could not have passed as scheduled.** Its gates depend on tickets the plan
put after it: zero-outages-reported-healthy needs `P0-05`; zero-suppressed-selected needs `P0-06`;
zero-unattributed-loss needs `P0-10`; sub-45-minute duration needs `A7`; **zero duplicate
requisition collisions needs `P1-01`**, which was in Wave 5. And **no canary evaluator existed in the dated checkout** —
`crawler/delivery-canary.mjs:62-182` records counts and deltas and compares by counting runs. It
cannot enforce a single one of the §14 gates.

**Kimi's fair correction to my §0.1 conclusion 3:** the DCO *does* schedule structural coverage
work (A3–A7, P1-05/06). What it does not schedule is the low-risk **config expansion** the data
calls for. Restated accordingly below.

## 1. The judgment calls, after review

The DCO orders P0 as "restore output first" (`DCO-P0-01` local Markdown). Taken literally that
ships a report containing **one role**. The output spine is necessary but not sufficient — so the
question is what actually raises the count, and in what order it is safe to land.

**Three calls, all evidence-backed:**

1. **Freshness corroboration comes first**, ahead of both coverage and readiness. It is 45 of the
   53 lost rows, its mechanism is one branch in `job-pull/freshness.mjs:26-33`, and it gates 71% of
   the durable store. It is currently scheduled in P1. It moves to Wave 1.
2. **Branches may run in parallel; integration and acceptance are strictly serial in DCO order.**
   Both reviewers independently rejected the parallel-acceptance model, and the shared-file
   evidence is conclusive. Concurrent branches are still worth it for wall-clock; the merge order
   is the DCO's.
3. **The canary's prerequisites move ahead of the canary.** `A7`, `P0-05/06/10`, and `P1-01`
   (requisition identity) all gate §14 criteria. Plus a canary **evaluator** has to be built — the
   thing the plan called "the gate" does not currently exist as executable code.

Phase 0 of the DCO (a manual emergency shortlist off current durable inventory, **plus manual
contact research for the top five roles** — the plan had dropped that half) still runs first and
takes hours, not days. It is the only thing that puts roles in front of a human this week.

**Before any of it: one measurement.** Run the Workday lane with commit `76bc53f`'s dating and
count how many of the 8,063 rows become datable. If most do, freshness work is nearly done and
coverage becomes the lever. If few do, `DCO-P1-02` is the critical path. An hour of work decides
which plan is correct — so it happens before the plan is committed to.

## 2. Waves

Each ticket lists: **owner** (who writes it), **fence** (what/how/stop), **verify** (what I run
before accepting). Every ticket is a separate commit with its own tests. Full suite must stay
green at every commit — the dated plan used 499 passing as its historical floor. Current verification must use `docs/STATUS.md` and dated run evidence, not this count.

### Wave 0 — preserve, measure, and deliver something by hand (inline, today)

**W0-1 is the first and blocking action.** Both reviewers flagged that the uncommitted work was
undercounted and under-protected.

- **W0-1** Commit the uncommitted work to preserve it (6 modified + 8 untracked), **then
  immediately flip the in-run scorer to opt-in** — change `crawler/cli.mjs:133-137` from
  `--no-scorer` (default on) to `--scorer` (default off). The four unmet B5 requirements in §0.2
  ship into every production run otherwise. Owner: me, inline.
  Verify: suite green before and after; `daily` with no flag constructs no scorer.
- **W0-2** `t3.json` → delete or move under `.local/`. Decide `icon/`.
- **W0-3 — the measurement that orders everything else.** Run the Workday lane against the four
  enterprise tenants with `76bc53f`'s `postedOn` dating and count how many of the 8,063 rows become
  datable. Record the number in this doc. Owner: me, inline, ~1 hour.
- **W0-4** DCO Phase 0 emergency shortlist: one local Markdown report off the durable SQLite
  inventory, hand-verified (original URL, liveness, geo, freshness, seniority quote), targeting 10
  actionable roles or an exact verified shortfall statement — **plus manual contact research for
  the top five roles**, which DCO §12 Phase 0 requires and the first draft dropped. No live writes.
  Owner: me, inline. Throwaway; not the C1 writer.

### Wave 1 — freshness truth, then readiness, then coverage

Serial by integration order. Branches may run concurrently; merges land in this order.

- **W1-1 = `DCO-P1-02` + `DCO-A4` (promoted from P1)** Workday date corroboration + truncation
  continuation. Scope set by W0-3's number. Fair cross-board hydration; remove the destructive
  second pass; preserve continuation state so capped providers expose new inventory across runs.
  Owner: **codex sol**. Verify: datable share of the Workday pool measured before/after; capped
  providers return different rows on consecutive runs.
- **W1-2 = `DCO-P0-02`** Schedule/profile propagation + deterministic run identity. `daily
  <morning|midday> --mode --location-preset` reaches `runDailyNormal()`; run ID = f(schedule, local
  date); midday runs the declared lightweight plan.
  Owner: **codex luna** — the `run` branch at `cli.mjs:146` is the template to copy.
- **W1-3 = `DCO-P0-03`** One authoritative production config + database path + run lock. Startup
  fails loudly on ambiguous mapping; production never writes `*live-test.sqlite`; every receipt
  prints resolved config + DB path. Owner: **codex luna**.
  Verify: `--env production` and the installed launchd command resolve identically; a concurrent
  second run is refused, not interleaved.
- **W1-4 — new ticket, not in the DCO: config-only India source expansion.** Add `country: "in"`
  smartrecruiters/greenhouse boards for India-hiring companies to `sources.atsBatch1` /
  `sources.atsWarm`. JSON only, no code. Kimi's point stands — this was a conclusion without an
  owner. Owner: me + **codex luna** for board probing/verification.
  Verify: each added board probed live before enabling, with an `evidenceRef` like the existing
  entries; distinct-India-company count measured before/after.
- **W1-5 = `DCO-P0-06`** Suppression on the actual final pool (`job-pull/run.mjs:244` vs `:257`).
  **Moved ahead of readiness repair** on sol's dependency: bounded repair must not spend scarce
  hydration requests on actioned or cooldown roles. Owner: **codex luna**.
- **W1-6 = `DCO-P0-07`** Bounded readiness repair before scoring, operating on the post-suppression
  pool from W1-5. Resolve original employer/ATS URL; hydrate JD, location, employment, trusted
  date, requisition ID, liveness; prioritize Strict + fresh + direct + India/Pune; explicit repair
  queue. Owner: **codex sol**.
  Verify: every rejected row carries ≥1 named blocker; scorer pool holds no unrepairable rows;
  bounded against the run deadline.
- **W1-7 = `DCO-P0-04`** Provider-stratified board rotation, unlocking the 192 never-fetched
  registry boards. Priority classes, reserved Ashby/Greenhouse/Lever quotas, persisted cursor,
  `boardsConfigured|Attempted|Omitted` + reasons wired into the daily receipt (kimi: `recordBoardHealth`
  at `crawler/board-registry.mjs:597-616` exists but nothing calls it), duplicate tracked/warm scans
  partitioned — 6 boards currently overlap. **Depends on W1-2/W1-3**: a persisted rotation cursor
  needs real schedule identity and the authoritative DB, or retries advance rotation twice or write
  it into the wrong environment. Owner: **codex sol**.

### Wave 2 — truth in the funnel, and the output spine

- **W2-1 = `DCO-A7` (promoted from P1)** Whole-run deadline, bounded provider-safe concurrency,
  explicit skipped-work telemetry. Both reviewers: promote. Measure per-source duration **before**
  adding concurrency. Owner: **codex sol**.
- **W2-2 = `DCO-P0-05`** Adapter failure propagation; degraded source degrades final outcome; an
  all-board timeout can never read `ok`/empty. Owner: **codex sol**.
- **W2-3 = `DCO-B6`** Recompute Conversion Score after Match Score — **before** selection policy,
  since conversion is a live tie-breaker at `job-pull/normal-selection.mjs:30`. Owner: **codex luna**.
- **W2-4 = `DCO-P0-09`** Selection policy: floor 65, 50–64 labeled stretch, <50 excluded, Strict
  waterfall with Backfill identity preserved, max 2/company, family diversity, every loss named.
  Owner: **codex sol**.
- **W2-5 = `DCO-P0-01`** Local Markdown + JSON atomic delivery — **now, against a stabilized output
  shape**, which is why it moved out of Wave 1. Temp → fsync → atomic rename. Must carry the DCO §2
  per-role fields the first draft omitted: exact seniority evidence and decision, Match Score,
  Response Likelihood, strongest hook, explicit blockers, shortfall explanation.
  **Must also remove or defer the existing `markJobsSurfaced` at `crawler/workflow.mjs:372-377`**,
  which fires before any report exists. Owner: **codex sol**.
  Verify: idempotent rerun under one run ID; a killed run between write and rename leaves no
  surfaced state; failed report consumes no jobs.
- **W2-6 = `DCO-P0-10`** Reconciled funnel + source telemetry per DCO §11, asserted as a test:
  no successful run carries unattributed loss across eligible → ready → scored → selected →
  committed. Owner: **codex luna**.

### Wave 3 — scoring correctness and canary prerequisites

- **W3-1 = `DCO-P0-08`** The four verified B5 defects from §0.2: run-isolated chunk files + stale
  output removal, whole-scoring deadline, `SCORER_SPAWN_FAILED` added to the broken-scorer set,
  and manual `--scores-json` rows routed through the no-JD clamp and JS Auto-Suggest
  (`job-pull/run.mjs:171,188`). Then a **real bounded Codex canary against real JDs**. Only after
  that does the scorer get enabled for the seven-run canary — it stays opt-in until then.
  Owner: **codex luna** for the fixes; canary run by me.
- **W3-2 = `DCO-P1-01`** Dedup evidence merge + requisition-aware identity. **Promoted from P1**:
  §14 requires zero duplicate requisition collisions, so the canary cannot gate without it.
  Owner: **codex sol**.
- **W3-3 — new ticket: the canary evaluator.** `crawler/delivery-canary.mjs:62-182` records counts
  and deltas and compares by counting runs; it cannot enforce a single §14 gate. Build an evaluator
  that checks source-outage truth, scorer failures, suppressed selections, surfaced-before-commit,
  requisition collisions, duration, report presence, consecutive valid runs, and code/config
  version. Owner: **codex sol**. Without this, "the canary passed" is an assertion, not a result.
- **W3-4** Canary preflight: validate the v4 history snapshot (`crawler/v4-history-snapshot.mjs:43-96`)
  — missing or malformed silently becomes zero suppression. Owner: **codex luna**.
- **W3-5 = `DCO` §15 rollback** Feature flags for new source behavior + preserved config snapshots.
  Owner: **codex luna**.

### Wave 4 — canary gate

Seven-run engineering canary per DCO §14, evaluated by W3-3's evaluator. **This is the gate — it is
the "no cutting corners" clause, and it does not compress.** Run by me.

### Wave 5 — remaining P1 evidence yield

Transport redirect/size/deadline (`P1-03`) · bounded remote/search resolution (`P1-05`) · one safe
career-page adapter (`P1-06`) · seniority abstention classifier + labeled gold set (`P1-07`).

`DCO-P1-07` needs a **hand-labeled gold set built before the classifier** — otherwise the
false-negative rate is unmeasurable and the abstention policy unfalsifiable. That labeling is
Onkar's, not a model's. Long pole in P1; start labeling during Wave 2.

### Wave 6+ — P2 application runtime, P3 outreach

Per DCO order. Both gated behind the 14-day outcome shadow for anything touching live state.
Default stays local/no-write throughout; every outward-facing action needs separate approval at
execution time (DCO §19).

## 3. Delegation model

Per `~/.claude/skills/delegation`: codex writes, Claude main thread reviews. No Claude coding
subagents.

- **codex sol** — design judgment: W1-1, W1-6, W1-7, W2-1, W2-2, W2-4, W2-5, W3-2, W3-3.
- **codex luna** — mechanical, with an existing pattern to copy: W1-2, W1-3, W1-4 (probing), W1-5,
  W2-3, W2-6, W3-1, W3-4, W3-5.
- **me, inline** — all of Wave 0, every review, both canaries, the shortfall calls, and anything
  touching the frozen template, live state, or the gold set.

Every dispatch carries the three-sided fence: exact files, the existing idiom to match, and a stop
line with an explicit test budget — worker models otherwise pile tests past the point of value.
Returned work is a claim: I re-read the diff and run the suite before accepting. Branches may run
concurrently, but **merges land in wave order**, and any ticket touching
`crawler/daily-runner.mjs` or `job-pull/normal-mode.mjs` serializes through me.

## 4. Risks

1. **Yield may not reach 10–15 even after Wave 1.** Real. 41 distinct India-hiring companies in 14
   days, max 2/company. Sol's caveat is fair — "source expansion is the answer" is not yet
   supported; freshness, truncation, evidence merge, hydration, and seniority false negatives are
   all live alternative causes. W0-3 is the first measurement that narrows this. If the count is
   still short after Wave 1, it is reported as a verified inventory shortfall, never as a relaxed
   gate (DCO §14 final clause).
2. **Shared-state conflict between concurrent branches** — not merely merge conflict. `DCO-P0-02`
   and `P0-04` both edit `crawler/daily-runner.mjs`; `P0-01` and `P0-07` both edit
   `job-pull/normal-mode.mjs`; the report writer must be authored against the shape readiness
   repair produces. Mitigation is the serial merge order above, which is why the spine moved to
   Wave 2.
3. **The scorer's gate semantics change** (fatal → degraded when a scorer ran) is the first change
   that lets a run deliver a partial shortlist. Understated in the first draft: the code thresholds
   on **failed-row** share while `docs/spec/match-scoring.md` describes **failed-chunk** share, and
   `SCORER_SPAWN_FAILED` is not classified as broken. W3-1 fixes both; until then the scorer is
   opt-in.
4. **45-minute deadline vs. readiness repair + rotation + hydration**, all of which add requests.
   Blocking, not a candidate — `DCO-A7` is promoted to W2-1, ahead of the canary.
5. **Pre-report surfaced mutation** (`crawler/workflow.mjs:372-377`) silently violates the DCO's
   core delivery invariant today. Owned by W2-5.
6. **"The canary passed" is currently unfalsifiable** — no evaluator existed in the dated checkout. Owned by W3-3.
7. **Stale or missing v4 history snapshot silently becomes zero suppression.** Owned by W3-4.

## 5. Review status

Reviewed by **gpt-5.6-sol** (codex, read-only) and **kimi-k2.7-code** (opencode-go, read-only).
Both were given the DCO, the plan, and the source. Every finding was re-verified against the code
before being folded in — four of sol's scorer findings, the `markJobsSurfaced` ordering bug, the
conversion tie-breaker, and the shared-file dependency were each confirmed by direct reading.

Where the reviewers disagreed — sol said freshness is the dominant term, kimi said readiness —
the arithmetic settles it: `54 → 9` is 45 rows lost at freshness, `9 → 1` is 8 lost at readiness,
and `job-pull/freshness.mjs:26-33` plus the 8,063-row undated Workday pool supplies the mechanism.
Sol is right; kimi's reading conflated the freshness stage into the readiness collapse. Kimi's
distinct contribution — that coverage sets the *absolute ceiling* even at perfect conversion — is
correct and is why W1-4 and W1-7 both stay in Wave 1.

**The open question I raised for Onkar is withdrawn.** I asked whether 10–15/day was reachable
given 41 distinct India-hiring companies per 14 days. That number excluded Workday, which alone
carries 97 India-hiring companies and 329 non-senior tech rows across 69 companies. Current sources
are sufficient for the target. The constraint is a dating bug, not inventory.

`DCO-P1-02` is therefore not a P1 ticket. It is **the** ticket, and W1-1 is correctly first.
