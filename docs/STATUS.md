# Launchpad current status

This is the sole repository index for current execution status. It describes the checked-out working tree, not a release announcement. GitHub issues remain the live issue-status authority; local issue packs, plans, and dated research are specifications or history.

## Authority hierarchy

1. `master_prompt.md` owns targeting, scoring, resume, and outreach policy.
2. `config/launchpad-v5.commands.json`, `config/notion-v5.manifest.json`, and executable validators own command, safety, and v5 target contracts.
3. Tests and the checked-out implementation establish local behavior.
4. This file summarizes current execution status.
5. Specifications, issue packs, audits, probes, and reports preserve design intent and dated evidence. They are not current-status trackers.

When sources conflict, do not infer promotion from prose. Re-run allowed local checks and treat live gates as open until explicit production evidence exists.

## P02 daily stage-loss receipts, 2026-10-20

The isolated P02 worktree adds a hashed daily receipt to the existing crawler run telemetry and readable Markdown/HTML reports. Receipt persistence reuses the crawler SQLite run envelope. This is uncommitted local implementation, not a release or readiness claim. Focused evidence and remaining limits are in `.local/p02-receipts/report.md`.

## P03 identity and date evidence, 2026-10-20

The isolated P03 worktree preserves provider requisition IDs, identity aliases and separate date evidence through the current daily receipt/report path. Date-only evidence stays date-only, unknown publication dates remain in VerifyQueue, and same-provider distinct requisitions do not merge through a shared alias. Focused local proof and limits are in `.local/p03-receipts/report.md`; no live source or history claim is made.

## P04 held employer-route recovery, 2026-10-20

The isolated P04 implementation adds an explicit retained-lead input to the existing portal resolver pass. Recovery shares that pass's resolver request and parent deadline limits, and its local receipt/report labels recovered leads separately from new discovery. This is local fixture evidence only. No live probe or operational verification is claimed.

## P05 held-lead recovery resume, 2026-10-20

The isolated P05 implementation resumes due held leads from the existing observation store and keeps retry timing and terminal outcomes. Existing workflow fixtures cover reopen/retry, rate limits, fresh-versus-stale HTTP status, transport failure, success deduplication, identity preservation and terminal outcomes. Open after two review rounds: recovery's half share of the resolver deadline ignores a short parent allowance, so ordinary discovery can still be starved; the recovery-state read still parses every historical ordinary success; and a held lead retried through ordinary discovery is missing from the recovery receipt and continuation. This is local fixture evidence only; no live yield or operational verification is claimed.

## P06 scoring retry, 2026-10-22

A role whose match scoring failed now keeps a retry record in the crawler run telemetry. A later run retries it when it reappears, counts each attempt, and shows the outcome in the Scoring recovery section of the daily report. Three failed attempts end in a terminal record. Local-verified by the fixture tests in the mode-scoring, daily-runner and local-lead-report test files. Not yet done: `nextEligibleAt` is recorded and shown as the earliest retry but does not hold back scoring, and the 200-record cap has no dedicated test. Open after two review rounds: a shared generic careers URL or a company/title/location alias can let a different role settle a retry record as recovered or selected, and a proven cross-provider alias is still vetoed by the requisition check. Readiness gating is unaffected; the error is in the retry record and report. Local fixture evidence only; no live scorer run.

## P09 source states, 2026-10-22

Sources that never ran now end as `not_started` instead of `empty`. This covers pending, not-started, unattempted, and omitted statuses, configured sources that were not planned, and portal lanes that did not run. A failed child lane stays `failed` even when a sibling lane is pending. The daily partial path no longer turns a never-run `tracked-ats` into a completed `empty` scan, and a new daily test pins that a partial run with a not-started source emits no delivery.

Already satisfied with no code change: failed, truncated, and interrupted absence never closes a job, and a reopened store keeps the earlier `last_seen_at` for a job the failed run did not see. Explicit employer closure sets `closed_at`, while a transport failure does not. New tests pin these rules. A source that is not current in the private daily report now shows its last successful snapshot time and age, marked not current. Open after two review rounds: the snapshot lookup trusts the stored `succeeded` telemetry status, which a warm-source transport failure can also carry, so a failed scan can be reported as the last successful snapshot; and it dates the snapshot by run completion rather than the source attempt, which understates age after a resume. Local fixture evidence only; no live source run.

## P10 useful source yield, 2026-10-22

Local-verified: the private daily report has a "Useful yield by source" section. Each source and query row counts requisitions that reached JD completeness, hard eligibility, valid scoring, scoring failure, history suppression, verification, final selection, and a recovered held-lead route. A requisition counts once per row and once overall, even when discovery and held-lead recovery both find it. Requests, duration, failures, and truncation sit beside each row. A row takes its source's cost only when the source ran one query, or has no query split and one row; otherwise its cost stays Not Verified. The section says no allocation is recommended from fetched counts.

Already satisfied with no code change: the crawler-v2 twenty-minute budget split (1200000, 720000, 300000, 180000 ms). A new test pins those values. No budget, priority, host limit, or cooldown changed.

Open after two review rounds: held-lead recovery provenance still misses some identities after employer resolution, so the recovered-route count can undercount (fixture: 2 of 4); EOR and contract-terms verification reasons still count as hard-eligible; and per-identity deduplication keeps the first reference's stage flags instead of combining them. Each returned daily result also carries the crawler observations (about 10.7 KB per role in one probe); no large-run size bound is verified.

Local fixture evidence only; no live yield claimed.

## P11 private report evidence, 2026-10-23

Local-verified: the private daily HTML report gives each role card a state (`Ready and scored`, `Promising, needs verification`, or `Rejected`), its exact reason codes, a missing-fields list, and one next safe action. The state comes from the retained gate outcome. Reason-code wording is a fallback that applies only when no gate ran. Cards sit under Pune and Pune-metro, India-eligible remote, or other-location headings. A role that a geography gate rejected never sits under the remote heading. Each card shows the country or residency constraint, liveness with its check time when retained, one novelty label, and an application-readiness line. A card is application-ready only with ready status, a usable match score, and loaded history. History counts as loaded only with status `loaded`, a valid `generatedAt`, and at least one row. Stale snapshots carry status `stale`, so they never count.

The counts line shows requested, eligible, selected, confirmed delivered, and `Shortfall this run` as separate numbers. Requested is the limit the run used after the remaining daily capacity clamp. Roles that name the same employer apply route each keep their own card. Both cards carry `SHARED_APPLY_ROUTE` with the next step "Verify each role's own employer listing". Cards for ready roles show the experience decision and requirement excerpt from the role's eligibility. Card titles render larger than body text.

The stage-loss receipt table gets state and next-action columns. The Markdown handoff gets the same counts line and state and next-action columns. Roles that only wait on verification now sit under Needs verification in Markdown, not Rejected. The Markdown table no longer prints the `Applied?` placeholder.

Already satisfied: the HTML report never showed `Applied?` or `Make Resume`, and its only action link was the employer apply link. A guard test pins both reports.

Not done, needs `job-pull/normal-selection.mjs` or `job-pull/normal-mode.mjs`:
- Normal-path hard rejections have no cards. The selection result holds only scored, ready rows, so rejected roles appear only as receipt rows.
- VerifyQueue cards show `Not Verified` for the liveness check time, which the queue record drops. They also show `Not Verified` for the country or residency constraint, although the queue record keeps it under `evidence.location`; the renderer does not read that field yet.

Not done, unreachable from retained data: `Already surfaced`. No daily result row carries a per-role surfaced flag. The label code stays, so a future producer can set it.

Not done in Markdown: rows do not name `SHARED_APPLY_ROUTE`. Only the HTML cards do.

Local fixture evidence only; no live run. No visual check of this slice in a browser.

## Checkout identity and warning

- Branch: `dco/yield-00-reliability-baseline`
- Candidate base: `52e55fd41c8a78b2ded4543b7c5394c6e338f61f`
- Preparation provenance: P00 candidate work began in this isolated checkout on 2026-10-18 IST from the stated base.
- Consequence: implementation claims below describe this checkout's contents, not HEAD alone, a pushed branch, or production.
- Preservation rule: do not reset, restore, clean, stash, stage, commit, rebase, switch branches, or remove unrelated user work as part of status maintenance.
- This checkout carries the P00 reliability baseline plus a scoped standalone role-tenure qualification repair. Candidate-specific checks are recorded below; earlier dated sections describe historical source-root checkouts and are not evidence for this candidate.

## Status vocabulary

| Term | Meaning |
|---|---|
| **working-tree** | Present in the current checkout. It may differ from HEAD and remote branches. |
| **local-verified** | Exercised by deterministic local validation or tests in this checkout. This does not prove credentials, external services, scheduling, yield, or production behavior. |
| **live-verified** | Observed through an authorized live integration with retained evidence. No live integration was run for this candidate. |
| **promoted** | A clean, reviewed revision has satisfied release gates and been deliberately adopted for production use. This candidate is not promoted. |

## P00 candidate status, 2026-10-19

PR #14 contains the reliability baseline and a reviewed follow-up for standalone role-tenure qualifications. Codex review of the R35 follow-up found no actionable regressions. Final focused checks passed 122/122 across five files at 02:38 IST, and the safety contract passed 7/7. These are local results. The PR remains draft because isolated-checkout validation is still blocked by five missing ignored skill mirrors.

The role-tenure matcher preserves flat HTML list items, recognized qualification paragraphs, real list markers and Markdown emphasis. Supported preferred headings keep their context until a required heading resets it. Ordinary skill bullets do not change section state. A minimum needs a complete qualification, an explicit mandatory ending, or the retained technical-role examples. Unresolved same-item continuations, optional tails and nested HTML lists defer the new matcher. Existing extraction paths still run.

HTML paragraph handling preserves completed sentences and keeps unfinished bachelor's degree alternatives or prospective tenure attached to the following quantity. Explicit applicant cues such as `must have` retain their minimum. The forward extractor now excludes the bounded prospective `spend` and `work` leads handled by this repair; other legacy parsing remains unchanged apart from the approved preference-suffix correction.

The legacy future-tenure example containing `at least three years` still returns 3. No broad future, waiver or negation grammar is claimed.

Reports retain failure causes and source coverage, preserve final degraded delivery status, and map successful outcome `ok` to `completed`. Missing measurements remain `Not Verified`. See [the P00 report](reports/2026-10-18-reliability-repair.md) for verification limits. No live source proof or promotion was performed.

## P01 experience reconciliation, 2026-10-19

The working tree now reconciles structured source experience with bounded mandatory JD requirements. The exact 7–10+ backend and 5+ AWS example rejects despite junior mentoring language. Preferred sections remain separate from mandatory Requirements sections, and a neutral Qualifications heading clears inherited preference and track state. Explicit junior and senior tracks are evaluated by applicability evidence; unassigned alternatives stay in VerifyQueue. Universal mandatory cues clear inherited track scope when they appear before the quantity or qualify that same requirement after it. A cue for a later requirement does not change the preceding track-specific minimum. Track selection passes only when the full bounded assignment clause is explicit and unconditional; conditional or alternative wording stays unresolved. Reports retain excerpts, selected-track evidence, and conflicts.

The shared daily workflow fixtures show hard rejections and unresolved alternatives do not reach scoring or shortlist. Mandatory cues after a quantity override preferred headings only within that requirement clause. A five-year minimum in the title remains hard evidence when a description is present, with title provenance and excerpt retained. Wrapped company-tenure boilerplate no longer overrides a separate applicant minimum, and a bachelor's-degree alternative stays open across paragraphs. The junior track, preferred-five case, minimum-one range, and minimum-two fallback continue through remaining gates. Round9's five-file suite passes 161/161, safety passes 7/7, and `git diff --check` passes. The implementation is local-verified and under parent review on its isolated branch. This is local evidence only. No live source, runtime, store, or tracker proof was run, and the system remains unpromoted.

Round10 retains unbounded `1+` minima, reconciles explicit source minima before unresolved track conflicts, and keeps LinkedIn description-derived values separate from `JobPosting.experienceRequirements.monthsOfExperience`. A selected junior track can pass when only the senior alternative carries six years; an explicit structured five-year source minimum still rejects even with unassigned alternatives. Round11 preserves a recovered mandatory source minimum when the same evidence also mentions a preference, while an explicit `sourceMinYears: null` remains JD-derived. Round12 also reconciles recovered mandatory evidence with legacy scalar minima using the stricter finite value in both object and flat input shapes. Pure preferences remain non-mandatory. A selected track with no matching requirement stays in VerifyQueue with its alternatives retained. The six-file focused suite passes 186/186, safety passes 7/7, and the final `git diff --check` is recorded below. No new named test or test file was added. Only the eight authorized paths are modified. Work remains unstaged for parent review.

## Current local position

Working-tree implementations for readiness Phases 00–06 and daily-discovery recovery are present. Discovery includes public LinkedIn guest search plus Chromium-backed Glassdoor, Instahyre, and Wellfound lanes. Workday LIST-only `postedOn` and genuinely undated roles remain in `VerifyQueue`; only DETAIL `startDate` supplies Workday freshness. Local engineering paths are substantially complete; shortlist selection, live v5 writes, and production promotion remain open.

- Candidate checks: see [the P00 review report](reports/2026-10-18-reliability-repair.md).
- `npm run validate` is blocked in this isolated checkout because five ignored `.claude` skill mirrors are absent. The source root's historical validation result does not apply to this candidate. No skill mirrors or validator behavior were changed.
- No live source probe or production verification was run for this candidate.

### 2026-10-07 enforcement repairs and bounded verification

- Applicant experience now handles `year(s)` and excludes education quantities, including `yrs. of full time educational`. All five retained Accenture JDs parse minima 2, 3, 2, 2, and 5. Three false experience rejects are repaired; actual 3+ requirements still reject.
- Resolver and readiness reject an unnamed client hiring route even when ATS JSON-LD names the recruiter. Leading Edge remains `Needs Verification`; ordinary software work for clients still passes this identity check.
- Frozen saved-body replay yields zero ready jobs. Today's bounded verification yields one ready, scored, locally selected fallback: Snowflake Cloud Support Engineer, AI/ML, posted 25 September, requiring 2+ years and a 10 PM IST night shift. Configured `gpt-5.6-luna` scored it 55/100. Strict selection is zero and the minimum-target shortage is nine.
- Focused regressions pass 39/39 and the full suite passes 890/890. Readiness covers all six test groups with 890/890 passing, but the command exits 1 for `OPERATIONAL_VERIFICATION_MISSING`; `codeComplete` is true and `productionReady` and `operationallyVerified` remain false.
- [Retained bounded report](../.local/bugfix-recheck-2026-10-07/RESULTS.md) separates the frozen replay from 65 public GETs, including 55 job-detail/redirect requests and ten original-employer searches. No external delivery, Notion write, application, message, checkbox change, scheduling, or promotion occurred. Real-history suppression remains unproved.

### 2026-10-06 local pipeline completion and bounded proof

- Local selection now exhausts each Strict/freshness band before balancing another band. Source provenance claims cannot bypass the explicit score or validated model boundary. Daily allocation rejects malformed present days and conflicting duplicate metadata.
- Warm ATS sorts trusted provider dates before its row cap. Missing Greenhouse JDs use bounded identity-checked detail retrieval; Recruitee requirements survive normalization. Explicit senior-role JD requirements reject. Verified readiness requires a retained JD and full-time or paid-internship evidence; unknown employment remains in verification.
- The bounded fresh public-source Normal run retained 75 GETs in 61.303 seconds, 966 observations and 866 dated rows. It ended partial with zero selected. A GET-only proof fence refused Workday's read-only search POST and later lanes remained interrupted; this is a proof limitation, not a production transport defect.
- After the freshness-cap repair, an ATS-only replay of those current captures refreshed Capco job 8255708 through its exact employer API. Real `gpt-5.6-luna` scoring returned 62 with valid components in 22.056 seconds. This retained diagnostic proves the configured model route. The official application page supplied no employment-type evidence. Final readiness replay has 868 observations, 768 dated, one provisional candidate, zero ready/scored/selected and one verification row, with a shortage of 10. The final replay invoked no scorer.
- Total public network reads were 77 GETs. All writes, history, database, allocation and rotation state were isolated under `.local/pipeline-completion-2026-10-06/finish/`. No external delivery, notification, real-history suppression, scheduling or promotion was exercised.
- Full local suite passed 883/883. Validate, safety and rehearsal passed. Check counts and process receipts are retained in that directory. Readiness's deterministic tests pass; its outer command remains fail-closed for `OPERATIONAL_VERIFICATION_MISSING`, with `productionReady: false` and `operationallyVerified: false`. No production or 10–20-role yield claim is made.
- Same-run retries with changed inventory can fail safely instead of replaying the exact retained shortlist. This nonblocking limitation remains.

### 2026-08-24 production-shadow discovery

- Scheduler is installed and loaded: `~/Library/LaunchAgents/com.launchpad.crawler.morning.plist` and `.midday.plist`. Morning runs at 04:30 local; production plists invoke `--env production --mode normal --location-preset pune` without live-write execution.
- Morning shadow run: 676 fetched, 3 eligible, 0 selected, terminal status `partial`. `ats-warm` consumed the source budget; eight configured plans remained `notStarted`, including portal discovery.
- Midday shadow run: 2917 fetched, 66 eligible, 0 selected, terminal status `completed`. Portal contribution: LinkedIn 74, Glassdoor 26, Instahyre 40, Wellfound 107.
- The 2026-08-24 shadow run exposed two policy defects: unstated experience was rejected by `job-pull/normal-readiness.mjs`, and undated rows received no `normal-selection.mjs` waterfall band. Phase A T0-T1 repairs now keep undated rows in `VerifyQueue`, require explicit eligibility, and allow unstated experience only after eligibility passes.
- Notification path has 18 retained receipts in `logs/notification-receipts.jsonl`; latest receipts report `freshCount: 0`. This proves receipt generation, not successful v5 persistence.
- v5 manifest and external credential file exist. No successful real Notion write is retained. Journal still contains only aborted initialization; CLI has no live execution flag and Normal mode rejects non-fake gateways.

### Daily-discovery recovery — local no-write proof

- Daily runs now use stable schedule + mode + location + IST-date identity, durable SQLite run/source attempts, same-identity resume, and observation-key deduplication.
- One absolute execution deadline owns discovery cancellation. Source adapters receive the parent signal and remaining budget; terminal envelopes distinguish `completed`, `partial`, and `failed` outcomes.
- Partial outcomes fail closed before opportunity-ledger surfacing, v5 execution planning, canary persistence, or notification delivery.
- Board selection is deterministic and bounded with priority/exploration allocation, deferred/omitted reasons, completion-gated rotation, and resumed-source ownership that avoids duplicate legacy fetches.
- Mode selector owns final shortlist and delivery plan. Funnel and delivery reconciliation cover fetched → dated → eligible → ready → scored → selected plus ledger, v5 plan, canary, and notification counts.
- Retained local evidence: `.local/launchpad-recovery-proof-2026-08-21-v2/evidence.json` (`LaunchpadLocalRecoveryProofV1`, SHA-256 `6a1e5cc58b2e69ee2d530e343366a67f20c371736d25d044cd84ab1e5b1ebef0`). Three sequential Normal/morning/india public-source no-write exercises reached terminal states in 107,699 ms, 73,905 ms, and 59,941 ms: one truthful scoring failure and two partial coverage outcomes. None is represented as a successful production-scored run.
- Fixture-only interruption/resume proof retained one run ID across `partial` → `completed`, persisted two unique observations with zero duplicates, recorded a resumed source attempt, started zero requests after cancellation, and performed zero prohibited partial operations.
- All external side-effect counters remained zero: no ledger persistence, gateway execution, canary persistence, notification, application, outreach, checkbox, credential, schedule, or production-config mutation.
- Latest tracked test run passed 725/725 across 76 inventoried test files. Readiness reports `codeComplete: true`, while correctly retaining `productionReady: false` and `operationallyVerified: false` because local-only evidence cannot satisfy production operational verification. Receipt: `.local/launchpad-recovery-proof-2026-08-21-v2/readiness-passing.json` (SHA-256 `5113d5d6053b783bfb12823f8a396777722b7b0e23611141f52f3230754b2ca7`).

### Phase 00 — resume path

- Resume queue reads only checked Applications v5 `Make Resume` rows and defaults to `createLocalResumeBuilder()` / `createLocalPdfVerifier()`.
- Builder changes only marked tailoring slots in frozen template, uses approved master evidence, compiles locally, and keeps `resumes/output/<date>/` PDF-only.
- Focused Phase 00 checks passed 13/13.
- No real checked role/JD is currently available locally, so real role-specific PDF evidence remains blocked.

### Phase 01 — discovery correctness

- Durable opportunity identity prefers provider + requisition ID. Distinct requisitions do not merge through company/title/location fallback.
- Workday DETAIL `startDate` is trusted and follows the normal `Hot`, `Active`, and `Backfill` age classes. LIST-only `postedOn`, including bounded labels, and genuinely undated rows route to `VerifyQueue`. See [workday-postedon-probe.md](research/workday-postedon-probe.md).
- Deadline and source signals propagate into scoring and mode selection.
- Remote eligibility follows current `master_prompt.md` §2, including worldwide/anywhere/global roles without country limits or foreign work-authorization requirements. The older India/APAC-only description is superseded.
- Apify remains explicit rescue only and default-off, with persisted offsets, seen-cache state, hard budget controls, and cost reconciliation paths.
- Location presets reorder source emphasis without bypassing shared eligibility and score gates.
- Focused Phase 01 checks passed 168/168.

### Phase 02 — skill and operator contracts

- `launchpad` router maps all fifteen routed skills.
- Shared guardrails define user-owned checkbox, no-send, no-auto-apply, evidence, and v5-only boundaries.
- Eleven mirrored operational skills validate; four supporting skills remain local-only by design.
- `node launchpad-v5.mjs validate` passes in current working tree.

### Phase 03 — reproducible local runtime

- Canary fingerprint walks recursive local import graph, includes dynamically discovered vendored providers through `vendor/career-ops/runtime.mjs`, and fails closed on missing graph files or empty/zero-test inventory.
- Runtime no longer depends on untracked source bytes from embedded root `career-ops/`. Outer-owned release code lives under `vendor/career-ops/`; root `career-ops/` remains ignored mutable runtime/user state.
- Upstream revision, snapshot scope, dirty-working-tree provenance, tracker aliases, and MIT license are retained in vendored source.
- Top-level dependency manifest and lockfile pin `dotenv`, `js-yaml`, and `playwright`.
- Clean-copy proof excluded root `career-ops/`, existing `node_modules/`, and `.git`; `npm ci --ignore-scripts`, 64 focused tests, and Launchpad validation passed there. Final clean committed-copy verification after all phases passed 713/713 tests across 75 test files.
- Reverse full scan and history seeding use caller-selected runtime state cwd while executable modules remain vendored.
- Clean installation reported one high-severity npm audit finding. No automatic dependency mutation was attempted.

### Phase 04 — Notion safety and notification receipts

- Scoped Notion v5 smoke path reserves all Companies, Applications, Outreach, and Activity keys before dependency-ordered writes.
- It verifies eight reciprocal relations, journals external page IDs, supports replay, and makes no rollback/deletion claim.
- Structured Notion errors redact configured secrets; secret lists are frozen and non-enumerable.
- Daily notification receipts bind run/profile/outcome/fresh count and persist append-only JSONL evidence without changing crawler exit status on notification failure.
- v5 manifest and external credential path are present, but no successful real Notion write exists. Eighteen notification receipts are retained through 2026-08-24; receipts report `freshCount: 0` and do not prove v5 persistence.

### Phase 05 — Gmail/outreach seams

- Injected Gmail draft-only transport supports deterministic lookup/create and exact attachment SHA-256 binding. No send operation is exported.
- Injected Gmail reply observation is read-only and thread/binding scoped.
- Reply Activity is made durable before Outreach/Application stop-state updates; replay repairs partial stop updates without duplicating Activity.
- Only approved v5 fields are written; Gmail identities remain in deterministic notes and idempotency keys.
- No Gmail account was connected, no real draft was created, no message was sent, and no real reply was observed.

### Phase 06 — immutable promotion and rollback

- Promotion requires a full 40-hex revision matching a clean source HEAD.
- Release checkout is detached and content-addressed outside source repo; new checkouts use `npm ci --ignore-scripts`.
- Every installed discovery profile must pass current-version canary gates across at least seven distinct valid UTC dates.
- Generated launchd plists point to immutable release checkout and external log paths.
- Schedule installation stops on first bootstrap failure and restores touched plist/service state; release receipt remains unchanged on failure.
- External release receipt advances atomically only after every bootstrap succeeds, retains prior release, and preserves rollback target during same-revision re-promotion.
- Rollback verifies retained checkout, reinstalls recorded profiles, and swaps current/previous receipt state only after successful installation.
- Dry-run paths do not create worktrees, run npm, write plists/receipts, or call launchctl.
- Phase 06 focused checks passed 27/27. No real worktree, npm install, launchctl, promotion, rollback, or external receipt operation occurred during those tests.

## Unified daily path

```sh
node crawler/cli.mjs daily morning --mode normal  --location-preset india
node crawler/cli.mjs daily morning --mode startup --location-preset pune
node crawler/cli.mjs daily morning --mode remote   --location-preset india
node crawler/cli.mjs daily midday  --mode normal  --location-preset pune
node crawler/cli.mjs daily midday  --mode startup --location-preset india
node crawler/cli.mjs daily midday  --mode remote   --location-preset india
```

One shared crawl feeds selected Normal, Startup, or Remote selector. Midday Remote omits native remote-feed fetching. All modes use shared eligibility, score, opportunity-ledger suppression, and final-shortlist gates. v5 is sole active runtime target; v3/v4 remain historical read-only systems without fallback, migration, archive, or delete paths.

## Open live and release gates

Following have **not** happened:

- live shortlist delivery from verified, eligible, scored rows; undated rows remain in `VerifyQueue`;
- morning source-budget partitioning with every configured plan reaching a terminal state;
- real checked-role/JD resume build and retained role-specific PDF verification;
- manual rotation of previously exposed Notion credential; exposed value must not be reused;
- restored credentialed access and live four-store Notion v5 smoke;
- guarded live v5 execution from CLI and one retained real write proof;
- authenticated LinkedIn/browser smoke beyond current production-shadow discovery;
- real Gmail account connection, draft creation, send, or reply observation;
- seven actual distinct valid UTC canary dates for every intended production profile on one clean release version;
- real launchd installation, immutable release promotion, bootstrap recovery drill, or rollback drill;
- clean reviewed commit, push, PR, or production promotion.

Canary remains fail-closed. Promotion evidence must match exact normalized profile and release code/config version, contain expected report pairs and manual inventory confirmation, and span seven distinct valid UTC dates in current consecutive valid streak. Historical versions may precede that streak; invalid current evidence resets it.

## LP-001–LP-019 working-tree snapshot

GitHub is live status authority. This conservative local snapshot must not be upgraded to live-verified without explicit evidence.

| Ticket | Local status | Current interpretation |
|---|---|---|
| LP-001 | Locally complete, live gate open | Daily schedule/mode/location propagation, stable daily identity, durable resume, and shared crawl-to-selector dispatch passed the tracked suite. |
| LP-002 | Locally complete, live gate open | Workday detail `startDate` is trusted; every LIST-only `postedOn` and undated row stays in `VerifyQueue`. |
| LP-003 | Locally complete, live gate open | Opportunity ledger owns cross-day suppression/cooldown; partial outcomes suppress delivery and completed surfacing is selector-owned. |
| LP-004 | Locally implemented, live gate open | Bounded priority/exploration planning, completion-gated rotation, request accounting, and fixture resume/deduplication have local proof; production operation remains open. |
| LP-005 | Locally complete, live gate open | Outcome-bound notification receipts exist; scheduler is installed and shadow runs are retained, but shortlist delivery remains empty. |
| LP-006 | Partial | Resolver-limit propagation is improved but not declared complete across all sources. |
| LP-007 | Locally implemented, live gate open | Apify persisted offset and seen-cache paths exist; live retained-dataset proof remains open. |
| LP-008 | Locally implemented, live gate open | Apify budget guards and reconciliation paths exist; live cost-policy proof remains open. |
| LP-009 | Open | Custom career crawling still lacks required verified Pune production source. |
| LP-010 | Not started | Crawlee has not been introduced at custom-career seam. |
| LP-011 | Not started | Default-off Firecrawl hard-page rescue is not implemented. |
| LP-012 | Partial | Startup mode and company evidence paths exist; focused source/provider and live persistence proof remain open. |
| LP-013 | Partial | India-remote evidence and selection are hardened; complete operational proof remains open. |
| LP-014 | Partial | Person/founder research can feed outreach preparation; selected-role handoff and provider coverage remain incomplete. |
| LP-015 | Partial | Free-first and contact-review safeguards are improved; paid-provider/live review proof remains open. |
| LP-016 | Partial | Thread-bound read-only Gmail reply lookup exists through injected transport; broad relationship-history and live integration proof remain open. |
| LP-017 | Locally implemented, live gate open | Outreach sequence, Activity-first reply handling, replay repair, and stop-state linkage exist; live lifecycle proof remains open. |
| LP-018 | Locally complete, live gate open | Draft-only Gmail adapter and exact attachment digest exist through injected transport; no real Gmail draft is claimed. |
| LP-019 | Partial | Bound Gmail reply observation exists; real reply evidence and manual LinkedIn conversation import remain open. |

## Safety boundary

External actions remain prohibited except through explicitly authorized scoped paths. Launchpad never auto-applies, autonomously sends email/DM/referral requests, creates or rotates credentials, or checks user-owned `Make Resume` or `Applied?` fields. Resume compilation remains local-only. Unknown evidence remains `Not Verified`.

## Local verification commands

These commands establish local consistency only:

```sh
node launchpad-v5.mjs validate
node crawler/safety-contract.mjs
node crawler/cli.mjs readiness --run-tests
git diff --check
```

The latest verification is the 2026-10-18 section above. Historical verification on 2026-08-21 included validation, safety, tracked diff checks, production-config byte-diff protection, and 725/725 passing tests across 76 files. That local recovery evidence includes three terminal public-source exercises and one fixture interruption/resume drill. These older receipts do not establish current scheduling, credentialed operations, promotion, or rollback. Earlier retained evidence includes Phase 00 (13/13), Phase 01 (168/168), clean-copy Phase 03 (64/64), and Phase 06 (27/27).
