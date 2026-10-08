# Launchpad daily production adoption

Status: Phase A local-verified. Last updated: 2026-08-30.

This plan replaced an earlier production-readiness draft after approval. Phase A is implemented and locally verified. Live writes, credential changes, schedule changes, promotion, commits, pushes, and pull requests still require separate approval.

## Executive summary

### Destination

Launchpad runs each morning and gives Onkar a safe, useful application queue. It discovers fresh Pune and India-eligible remote engineering roles, applies policy gates, scores them, writes a final shortlist to Applications v5, notifies Onkar, builds truthful one-page resumes only for rows Onkar checks, and observes applications only after Onkar submits them manually.

Initial production profile:

```text
schedule: morning
mode: normal
location: pune
environment: production
writes: Applications and Companies v5
automatic application submission: prohibited
```

Startup, Remote, and midday live delivery stay disabled until each profile earns separate evidence.

### What changes

1. Reconcile freshness policy so undated roles remain in `VerifyQueue`.
2. Fix readiness without allowing missing eligibility to pass.
3. Give every enabled source bounded execution opportunity.
4. Keep one canonical selection pipeline.
5. Make Notion transaction, replay, ledger, canary, and notification results agree by key.
6. Add strict morning-only live-write CLI with lazy credential access.
7. Prove one live row, one real resume, one manually submitted application, seven valid production dates, schedule adoption, and rollback.

### Sequence

```text
Local correctness
-> controlled one-row live proof
-> real resume and manual application proof
-> immutable seven-day canary
-> production schedule and rollback proof
```

### Primary risk

Planned, committed, surfaced, notified, and canary inventories can diverge during partial writes or replay. This plan makes keyed delivery reconciliation the gate before cooldown, canary, notification success, or promotion.

### Completion proof

Launchpad is production-ready only when one clean immutable release has:

- passing local validation and production-config shadow evidence;
- successful v5 preflight and one-row write/replay proof;
- one verified real role-specific PDF;
- one manually submitted and idempotently synchronized application;
- seven consecutive valid UTC dates on one revision, config, and normalized profile;
- installed immutable morning schedule;
- retained rollback proof and first successful scheduled live run.

## Current state and verified evidence

### Verified facts

- Shared daily discovery, source telemetry, durable run identity, cancellation, partial outcomes, scoring, mode selection, delivery planning, v5 gateway, transaction journal, resume compilation, synchronization, promotion, and rollback code paths exist in the working tree.
- Latest full suite reports 768 passing tests with zero failures.
- Recovery exercises retained terminal no-write evidence with zero prohibited external side effects.
- Production-config shadow `shadow-20260830T123328Z` completed with 9 terminal sources, 18 ready and scored rows, 3 selected rows, balanced delivery reconciliation, and zero external side effects.
- v5 manifest and external credential path exist, but no successful real Notion write is retained.
- Scheduler is installed in no-write mode. Repository evidence does not establish an immutable promoted live-write release.
- Resume path has local fixture proof. No real checked role has produced retained role-specific PDF evidence.
- No item currently holds live-verified or promoted status.

### Resolved Phase A authority conflict

`master_prompt.md`, `docs/SYSTEM-REFERENCE.md`, tests, and executable behavior now keep Workday LIST `postedOn` and genuinely undated roles in `VerifyQueue`. Workday DETAIL `startDate` remains the verified freshness authority.

## Settled decisions

### Safety boundary

- `user-owned`: Launchpad never changes `Make Resume` or `Applied?`.
- `draft-only`: outreach may prepare drafts, never send.
- `v5-only`: authorized live writes target declared Launchpad v5 stores only.
- `fail-closed`: unknown evidence remains blank or `Not Verified`.
- `local-compile`: resume source, evidence, and PDF generation stay local.
- `no auto-apply`: Launchpad never submits applications, sends email or DM, requests referrals, automates LinkedIn, or creates credentials.
- No v3 or v4 fallback.

### Freshness

- Workday DETAIL `startDate` may establish freshness.
- Workday LIST `postedOn` does not establish selection freshness.
- Genuinely undated roles remain `VerifyQueue` and never enter automated selection.
- `Backfill` requires known age from 8 to 14 days.
- More than 14 days is rejected.
- Future LIST-evidence trust requires a separate policy amendment before code changes.

### Experience

- Missing experience text is not automatic rejection after full eligibility passes.
- Explicit minimum of 3 or more years remains hard rejection.
- Two-year requirements remain tagged shortage fallback.
- Missing eligibility never passes daily selection.

### Surfacing and cooldown

For the initial live profile:

```text
surfaced = newly committed Applications v5 row
```

- Planned row is not surfaced.
- No-write shadow does not start cooldown.
- Failed or recovery-blocked row does not start cooldown.
- Newly committed row starts seven-day cooldown.
- Replay-skipped row does not refresh cooldown or increment surfacing count.
- Crash after commit but before ledger write is repaired from journal commit time.
- Notification failure degrades operational result but does not erase committed row.

### Initial production scope

Only this profile may execute live delivery:

```text
morning / normal / pune / production / live-v5
```

Startup, Remote, and midday remain no-write.

## Scope and non-goals

### In scope

- Normal morning discovery and selection.
- Pune and India-eligible remote policy gates already owned by Normal mode.
- Applications and Companies v5 delivery.
- Opportunity ledger cooldown.
- Notification receipt.
- Local truthful resume compilation.
- Manual application and `/sync` proof.
- Immutable promotion, schedule installation, and rollback.
- Operator instructions for daily use and failure recovery.

### Not required for initial production readiness

- Automatic application submission.
- Automatic email, DM, referral, or LinkedIn action.
- Gmail live connection.
- Startup, Remote, or midday live writes.
- Crawlee, Firecrawl, SearXNG, or speculative source expansion.
- Resume template redesign.
- v3/v4 migration, archive, delete, or fallback.
- Public Waymark publication.
- Commit, push, PR, or deployment without explicit approval.

## Requirements and design

### Daily user flow

1. Scheduled morning run discovers, gates, scores, selects, and delivers shortlist.
2. Notification reports completed or degraded result with exact counts.
3. Onkar opens Applications v5 by Run ID and reviews original employer URLs.
4. Onkar checks `Make Resume` for chosen roles.
5. `/make-applications` builds and verifies local one-page PDFs.
6. Onkar reviews PDF and submits application manually.
7. Onkar checks `Applied?`.
8. `/sync` records confirmed state and Activity idempotently.
9. Optional `/outreach` prepares a draft for manual review and send.

### Canonical selection pipeline

```text
normalize
-> resolve original URL
-> liveness
-> freshness
-> eligibility
-> opportunity-ledger suppression
-> historical suppression
-> readiness
-> scoring
-> selection
-> shortlist limit
-> delivery plan
```

`VerifyQueue` stays outside scoring and selection. Every selected row must exist in canonical funnel accounting.

Required invariants:

```text
selected ∩ VerifyQueue = empty
selected ∩ scoringQueue = empty
selected count = planned operation count
all selected rows have usable score
all selected rows have resolved original employer URL
```

### Discovery budget ownership

- One parent deadline owns cancellation.
- Every enabled source receives positive start allocation or explicit planner omission.
- Every source has a maximum duration.
- Priority work cannot consume later sources' reserved start allocations.
- No request starts after cancellation.
- `not_started_bug` fails run. `omitted_by_planner` is explicit, bounded, and reported.

Config invariants:

```text
scorerFloorMs <= downstreamReserveMs
discoveryBudgetMs + downstreamReserveMs + handoffReserveMs <= wholeRunDeadlineMs
every enabled source has positive start allocation or explicit planner omission
```

### Live gateway preflight

One gateway-owned `validateLiveWritePreflight()` proves:

- live mode enabled;
- test and provisioning modes disabled;
- exact `LaunchpadV5ManifestV2`;
- no v3/v4 target IDs;
- valid external credential file;
- valid external file-backed journal;
- canonical paths outside repository;
- owner-only permissions and current-user ownership;
- required relation targets;
- no blocking recovery entry for requested keys.

CLI calls this method. CLI does not duplicate gateway internals.

### Keyed transaction result

```js
{
  status,
  newlyCommitted,
  alreadyCommitted,
  failed,
  recovery,
  deliveredKeys,
}
```

Status meanings:

```text
noop       no input
replayed   every requested key already committed
committed  all new keys committed
partial    some new keys committed, others failed or require recovery
aborted    no new key committed
recovery   pending or verified journal state blocks retry
```

Commit invariant:

```text
committed keys = verified keys
```

Missing, duplicate, or unknown commit keys fail closed. Journal never marks more keys committed than transaction confirms.

### Delivery reconciliation

Required counts:

```text
selected
planned operations
newly committed
already committed
failed
recovery blocked
ledger surfaced
canary shortlist
notification receipt
```

Execution order:

1. Build delivery plan.
2. Stop before live gateway factory in no-write mode.
3. Require completed discovery and scoring.
4. Construct live gateway lazily.
5. Execute transaction.
6. Reconcile keyed transaction result.
7. Record newly committed ledger rows.
8. Repair missing replay ledger entries using journal commit time.
9. Compute final outcome.
10. Evaluate canary.
11. Emit notification receipt.

Partial, aborted, recovery, or notification failure degrades run and invalidates success canary. Failed rows remain retryable. Replay does not refresh cooldown.

### Strict live CLI

```sh
node crawler/cli.mjs daily morning \
  --env production \
  --mode normal \
  --location-preset pune \
  --execute-writes \
  --credential-file ABS_PATH \
  --journal ABS_PATH
```

Live execution rejects:

- midday, Startup, or Remote;
- dev or live-test environment;
- arbitrary config;
- relative credential or journal path;
- orphan credential or journal flags;
- incomplete discovery or scoring result.

`notionGatewayFactory` remains lazy. Partial, failed, and no-write runs call it zero times and read credentials zero times.

## Ordered phases

## Phase A: local correctness

### T0: reconcile freshness authority

- Make implementation, tests, `docs/STATUS.md`, and `docs/SYSTEM-REFERENCE.md` match `master_prompt.md`.
- Route Workday LIST-only and genuinely undated roles to `VerifyQueue`.
- Preserve bounded Workday detail hydration.
- Add invariant proving selected keys never remain in `VerifyQueue`.

### T1: fix readiness without failing open

- Require `eligibility?.eligible === true` in daily selection.
- Remove only manual-review rejection for unstated experience.
- Preserve every other hard failure and relaxation evidence.
- Isolate any permissive standalone diagnostic behavior from daily mode.

### T2: implement fair source budgeting

- Add production deadline and reserve config.
- Add per-source max duration and minimum start allocation.
- Report terminal state or planner omission for every enabled source.
- Treat silent not-started state as bug.
- Retain per-source quality and duration telemetry.

### T3: enforce one canonical pipeline

- Remove Normal-only side pools.
- Keep `VerifyQueue` separate.
- Run suppression, readiness, scoring, and selection once.
- Apply shortlist limit after selection and before operation generation.
- Balance funnel and delivery counts.

### T4: harden transaction and replay

- Add gateway-owned live preflight.
- Return keyed transaction categories and explicit replay status.
- Validate commit cardinality.
- Keep journal recovery visible.
- Preserve secret redaction.

### T5: reconcile delivery side effects

- Reconcile transaction before ledger, canary, and notification success.
- Record only newly committed rows as new surfacing.
- Repair missing ledger rows from original commit time.
- Make replay ledger-idempotent.
- Degrade on incomplete delivery or notification failure.

### T6: add strict morning live-write CLI

- Require exact initial production profile.
- Reject unsafe combinations.
- Construct gateway lazily.
- Keep `--shortlist-limit 1` for explicitly approved proof.

### T7: complete local verification and shadow

Run focused tests, then:

```sh
npm run validate
npm run safety
npm test
node crawler/cli.mjs readiness --run-tests
git diff --check
```

Run production-config no-write shadow. Pass only when every enabled source terminates or is explicitly omitted, reconciliation balances, selected rows satisfy gates, and all external side-effect counters remain zero.

### STOP A

Report local evidence. Do not rotate credentials, write to Notion, alter schedule, promote, publish, commit, push, or create PR without separate approval.

## Phase A progress report — 2026-08-30

Status: `local-verified`. Phase A tasks T0 through T7 are implemented. STOP A evidence is complete.

### Verification evidence

- Full test suite: 768 passed, 0 failed.
- Focused accounting and source-budget suite: 80 passed, 0 failed.
- `npm run validate`: passed.
- `npm run safety`: all six checks passed.
- `git diff --check`: passed.

### Production-config no-write shadow

Run ID: `shadow-20260830T123328Z`.

- Terminal status: `completed`.
- Source coverage: 9 completed, 0 interrupted, 0 failed, 0 not started.
- Fetched: 4,818.
- Application-ready and scored: 18.
- Selected: 3.
- Planned v5 operations: 3.
- Selected gate violations: 0.
- Delivery reconciliation: balanced with no mismatch reasons.
- Transaction, opportunity-ledger writes, replay repairs, canary persistence, and notification delivery: zero.
- No credential or live gateway access occurred.

Tracked ATS remained honestly `degraded`: 1,739 rows fetched with three request timeouts and one HTTP 404 retained in source evidence. Degradation no longer appears as false `not_started` coverage.

### Remaining work

Phase B is next. T8 requires Onkar to rotate the previously exposed credential manually, followed by a separately authorized scoped v5 preflight. T9 then requires separate approval for one selected live row and replay proof. STOP B follows that proof.

## Phase B: controlled live proof

### T8: restore and verify v5 access

Onkar rotates previously exposed credential manually. Run scoped v5 preflight. Stop on any credential, manifest, relation, journal, or target failure. Never fall back to legacy stores.

### T9: run one-row write and replay proof

With separate approval, execute one selected row using `--shortlist-limit 1`. Verify live values, Company relation, Run ID, original URL, score, freshness, tier, source, relaxation evidence, and untouched user-owned checkboxes. Replay must create no duplicate and must not refresh ledger cooldown.

### STOP B

Report one-row proof. Do not set `Make Resume`, submit application, install schedule, or promote automatically.

## Phase C: real application proof

### T10: build one real role-specific resume

Onkar manually checks `Make Resume`. `/make-applications` must produce:

```text
resumes/sources/<date>/<stem>.tex
resumes/sources/<date>/<stem>.matrix.md
resumes/sources/<date>/<stem>.provenance.md
resumes/output/<date>/<stem>.pdf
```

Verify frozen template structure, approved evidence provenance, complete JD matrix, one-page layout, ATS extraction, truthful claims, and PDF-only output directory.

### T11: prove manual application and sync

Onkar submits application manually and checks `Applied?`. `/sync` observes confirmed state, writes one deterministic Activity event, and remains idempotent on replay. Applied opportunity no longer resurfaces.

### STOP C

Report application proof. Do not change schedule or promote without separate approval.

## Phase D: production promotion

### T12: create immutable candidate release

From clean reviewed revision, create detached content-addressed checkout, install pinned dependencies, run full validation, and bind revision, config fingerprint, test inventory, manifest fingerprint, and normalized profile.

### T13: run seven-day live canary

Run same immutable release and profile on seven consecutive valid UTC dates. Each date retains matching Markdown and JSON reports, source manifests, reconciliation, transaction results, delivered keys, ledger counts, canary, notification receipt, and manual inventory confirmation. Invalid current-version evidence resets streak.

### T14: install schedule and prove rollback

After explicit promotion approval, install morning live schedule pointing to immutable release. Midday remains no-write. Verify dry-run command, redaction, prior release receipt, rollback target, launchd state, first scheduled run, and restoration on first failure.

## Acceptance and verification

### Local acceptance

- Authority conflict removed.
- Undated roles never auto-select.
- Missing eligibility never passes.
- Unstated experience can pass only after full eligibility.
- Every enabled source terminates or has explicit planner omission.
- No request starts after cancellation.
- Canonical funnel and delivery counts balance.
- Replay status and commit cardinality are exact.
- Partial delivery and notification failure invalidate success canary.
- No-write and partial discovery access no credential and perform no external delivery action.

### Live pilot acceptance

- Exact v5 preflight passes.
- One row commits with verified Company relation.
- User-owned checkboxes remain false and untouched.
- Replay creates no duplicate.
- Replay does not refresh cooldown.
- Failed rows remain retryable.
- One real selected role produces verified one-page PDF.
- One manually submitted application syncs once and suppresses resurfacing.

### Promotion acceptance

- Clean immutable release identity retained.
- Seven consecutive valid UTC dates on same revision, config, and profile.
- Matching report pairs and manual inventory confirmation.
- Immutable morning schedule installed.
- Rollback proof retained.
- First scheduled live run succeeds.
- Operator runbook matches installed commands and failure behavior.

### Status progression

```text
local-verified
-> live-pilot
-> canary-in-progress
-> promoted
```

No prose claim may skip evidence rung.

## Daily operator runbook

### Morning

1. Read notification receipt.
2. Require completed status and valid canary.
3. Open Applications v5 filtered by Run ID.
4. Review ranked shortlist and original employer URLs.
5. Choose roughly 7 to 8 roles based on real inventory.
6. Check `Make Resume` only for chosen roles.
7. Run `/make-applications`.
8. Review each PDF and live application page.
9. Submit manually.
10. Check `Applied?`.
11. Run `/sync`.
12. Use `/outreach` only when useful. Review and send manually.

### Failure handling

#### Partial or failed discovery

No gateway execution or success canary. Inspect source manifests. Resume only through supported same-identity recovery.

#### Partial, aborted, or recovery transaction

Keep committed rows, preserve journal, leave failed rows retryable, and require explicit recovery. Never delete journal entries or fall back to legacy stores.

#### Notification failure

Treat run as degraded. Inspect Applications v5 and local report. Day does not count toward canary streak.

#### Resume failure

Do not apply with failed PDF. Keep `Applied?` false. Fix source or evidence issue and rebuild.

#### Dead application page

Do not use aggregator substitute. Mark listing dead through supported state and suppress resurfacing.

## Risks and mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| Freshness policy drift | stale or unverifiable roles auto-select | restore one authority contract and test LIST-only Workday behavior |
| Source starvation | broad source set exists but most never run | per-source start allocation, duration caps, terminal-state accounting |
| Eligibility fail-open | unsafe role reaches shortlist | daily readiness requires explicit accepted eligibility |
| Partial transaction drift | canary or cooldown claims rows not delivered | keyed reconciliation before ledger and canary |
| Replay changes cooldown | old role disappears for another seven days | preserve original commit time and do not increment replay surfacing |
| Credential access on no-write run | secret read without delivery need | lazy factory after completed run and preflight |
| Notification false success | unattended failure appears healthy | failed receipt degrades run and invalidates canary |
| Dirty-tree promotion | release cannot be reproduced | immutable clean checkout and content-addressed revision |
| Resume claim inflation | application contains unsupported claim | master evidence provenance, JD matrix, local PDF verification |
| Schedule failure | unattended live delivery stops or runs wrong code | dry run, immutable plist target, first-run observation, rollback proof |

## Non-blocking open questions

These do not block scoped Phase B preflight:

1. Whether `VerifyQueue` should receive a separate manual-review report or stay in current run report.
2. Whether notification delivery is local-only or later gains an approved external provider.
3. Which seven-day canary start date follows one-row and application proof.
4. Whether Startup or Remote becomes second promoted profile after Normal stabilizes.

Material policy changes, including trusting Workday LIST evidence, return plan to draft and require renewed approval.

## Approval boundaries

Phase A implementation and this progress report are complete. Separate approval is required for each remaining action:

- rotate or test credentials;
- execute live v5 preflight;
- execute one-row live write;
- build a resume from a user-checked live row;
- install or change schedule;
- create immutable release;
- promote or roll back;
- publish this plan to Waymark;
- create branch, commit, issue, push, or pull request.
