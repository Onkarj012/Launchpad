# Launchpad full-production remaining phases

Status snapshot: 2026-09-01

This document records remaining work in the current dirty checkout. It is an execution handoff, not release or production evidence. `docs/STATUS.md` remains the repository status authority, and GitHub remains the live issue-status authority.

## Current position

Locally accepted work:

- Phase 0 journal-audit implementation, command wiring, safety parity, and focused tests. Independent Grok review: `PASS`.
- Phase 1 runtime-budget and durable-checkpoint core. Focused tests: 36/36. Independent Grok review: `PASS`.
- Phase 1 portal screening and original-listing resolution bounds. Focused tests: 73/73. Independent Grok review: `PASS`.

Current unfinished slice:

- Workday crawler checkpointing, DETAIL request bounds, and reserved source allowance have partial Luna edits in the working tree.
- First focused run passed 75/75.
- Second focused run passed 76/79.
- Three regressions remain:
  1. LIST checkpoint ordering and aggregate DETAIL budget across pages.
  2. Reserved DETAIL allowance and replay cursor.
  3. Derived DETAIL abort signal reaching the injected transport.
- Luna exited with code 1.
- Grok review, final focused verification, and final diff check have not run for this slice.

## Dependency order

```text
00 ───────────────────────────────┐
                                  v
01 → 02 → 03 ───────────────────→ 04 → 05 → 06 → 07 → 08 → 09
```

Phases 0 and 1 may proceed in parallel. Phase 4 requires Phase 0 journal reconciliation and Phase 1 through 3 acceptance. Phase 9 follows useful production evidence and does not block initial promotion.

## Phase 0: establish one current truth

Local engineering is complete and reviewed. Live evidence remains open.

Remaining work:

- Obtain explicit approval to access the external credential file and v5 transaction journal.
- Run the authorized GET-only live Notion journal audit.
- Classify retained pages, synthetic artifacts, stale test artifacts, malformed records, and unresolved records.
- Retain the owner-only external audit receipt.
- Synchronize authority documents only after evidence exists.

Approval boundary:

- Credential access and live Notion reads require explicit approval.
- No live write belongs to this phase.

## Phase 1: make scheduled discovery finish and retain its work

### 1. Finish Workday crawler slice

- Repair the three failing focused tests.
- Ensure LIST observations checkpoint before DETAIL requests.
- Start Pune-priority DETAIL hydration before broad enumeration consumes reserved allowance.
- Share one aggregate DETAIL request cap across pages and boards.
- Stop new DETAIL starts after cancellation or deadline exhaustion.
- Forward the derived abort signal to the injected transport.
- Preserve a replay cursor that does not skip unfinished DETAIL rows.
- Replace checkpointed rows by stable source identity instead of duplicating them.
- Keep LIST-only and undated Workday rows in `VerifyQueue`.
- Run focused tests, Grok read-only review, and scoped `git diff --check`.

### 2. Bound downstream Workday enrichment

- Add signal, deadline, and stop-before-start checks to `job-pull/workday-enrichment.mjs`.
- Prevent downstream DETAIL hydration from consuming scorer and handoff reserves.
- Preserve LIST evidence on cancellation, failure, missing DETAIL data, or request exhaustion.
- Keep any remaining undated candidate fail-closed in `VerifyQueue`.

### 3. Finish remaining discovery controls

- Preserve reduced but non-zero downstream processing after a partial crawl where the contract allows it.
- Disable measured dead Normal lanes in the production profile.
- Report unavailable transports as explicit planner omissions rather than silent empty sources.
- Standardize count vocabulary across source telemetry, funnel reports, scoring, notifications, and canary evidence.

### 4. Run Phase 1 local gates

Run and retain exact results for:

```text
npm run validate
npm run safety
npm test
node crawler/cli.mjs readiness --run-tests
git diff --check
```

### 5. Produce scheduled-path evidence

- Run three consecutive production-config, scheduled-path, no-write exercises.
- Require terminal `completed` discovery and accounting state.
- Require every enabled source to complete or have a predeclared planner omission.
- Prove no source exceeds its allowance.
- Prove checkpoint replay remains idempotent.
- Balance fetched, dated, eligible, ready, scored, selected, and delivery counts.
- Prove no ready row remains unscored.
- Reach median selected count of at least five, or retain complete shortfall evidence for every lower result.
- Reach at least ten distinct ready-pool companies across the three runs.
- Require employer URL, Active liveness, verified freshness, accepted eligibility, finite score, and no queue overlap for every selected row.
- Keep every external side-effect counter at zero.

## Phase 2: close LP-009 and improve employer-direct diversity

Remaining work:

- Measure employer-direct contribution after Phase 1 scheduled runs finish reliably.
- Improve direct source diversity without weakening freshness, eligibility, readiness, or company caps.
- Retain source-yield and company-diversity evidence.
- Close LP-009 only when evidence meets the issue contract.

## Phase 3: make canary evidence executable

Remaining work:

- Produce complete machine-readable and human-readable report pairs for each canary run.
- Make shortfall evidence complete when fewer than five roles are selected.
- Reconcile source, funnel, scorer, delivery, and side-effect counts.
- Fail closed on missing report pairs, mismatched inventory, incomplete counts, or mutable version identity.
- Retain manual inventory confirmation where required.

## Phase 4: reconcile credentials and prove one live row

Blocked by Phase 0 through 3 acceptance and explicit live approval.

Remaining work:

- Reconcile the approved v5 credential and external journal.
- Run the scoped v5 safety checks.
- Execute one authorized live-row transaction through the v5 gateway.
- Verify relations, idempotency, journal binding, and retained evidence.
- Prove no v3/v4 fallback and no user-owned checkbox mutation.

Approval boundary:

- Credential access and live Notion writes require explicit approval.

## Phase 5: make live resume and sync commands work

Remaining work:

- Exercise resume generation against an authorized checked v5 row.
- Build the role-specific PDF locally from frozen template and approved master evidence.
- Verify PDF and sidecar outputs.
- Exercise scoped v5 sync commands against retained live evidence.
- Keep `Make Resume` and `Applied?` user-owned and unchanged.

Approval boundary:

- Live v5 reads or writes require explicit approval.
- No application submission, email, DM, referral, or LinkedIn action is allowed.

## Phase 6: create a clean immutable candidate

Remaining work:

- Finish all local implementation and review gates.
- Produce a clean reviewed revision.
- Build a detached content-addressed release checkout.
- Install dependencies only inside the approved release procedure.
- Record version, import graph, test inventory, and rollback identity.

Approval boundary:

- Commit, push, PR, release creation, and dependency installation require their named approvals.

## Phase 7: run the seven-date immutable canary

Remaining work:

- Run canaries on seven distinct valid UTC dates.
- Use one immutable release version for all seven dates.
- Retain complete report pairs and manual inventory evidence.
- Require matching version and inventory identity across every canary.
- Restart the seven-date count if the release version changes.

## Phase 8: promote the live schedule and prove rollback

Remaining work:

- Obtain explicit promotion approval.
- Install the immutable morning production schedule.
- Verify launchd state and retained release receipt.
- Run and verify the production schedule.
- Obtain explicit rollback approval.
- Roll back to the retained prior release and prove schedule state.
- Obtain explicit re-promotion approval.
- Re-promote the accepted release and retain final evidence.

Approval boundary:

- Schedule changes, promotion, rollback, and re-promotion each require explicit approval.

## Phase 9: close LP-010 and LP-011 after useful production

Blocked until production has enough measured evidence.

Remaining work:

- Measure useful production behavior after promotion.
- Close LP-010 and LP-011 only from retained production data.
- Do not infer closure from local code presence or fixture tests.

## Hard boundaries

- Never auto-apply.
- Never send email, DM, referral requests, or LinkedIn actions.
- Never mutate user-owned `Make Resume` or `Applied?` fields.
- Never invent freshness, eligibility, experience, salary, contact, or resume evidence.
- Never fall back to v3/v4.
- Keep `maximumPerCompany = 2`.
- Live writes, credential access, schedule changes, dependency installation, release creation, commit, push, PR, promotion, rollback, and re-promotion require explicit approval.
- Each phase ends only with retained evidence, not code presence alone.
