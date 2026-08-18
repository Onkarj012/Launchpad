# Launchpad current status

This is the sole repository index for current execution status. It describes the checked-out working tree, not a release announcement. GitHub issues remain the live issue-status authority; local issue packs, plans, and dated research are specifications or history.

## Authority hierarchy

1. `master_prompt.md` owns targeting, scoring, resume, and outreach policy.
2. `config/launchpad-v5.commands.json`, `config/notion-v5.manifest.json`, and executable validators own command, safety, and v5 target contracts.
3. Tests and the checked-out implementation establish local behavior.
4. This file summarizes current execution status.
5. Specifications, issue packs, audits, probes, and reports preserve design intent and dated evidence. They are not current-status trackers.

When sources conflict, do not infer promotion from prose. Re-run allowed local checks and treat live gates as open until explicit production evidence exists.

## Checkout identity and warning

- Branch: `feat/launchpad-readiness-completion`
- HEAD at this documentation synchronization: `3b391863e3632fca52703066df141ebd8e460c2a`
- Working tree: dirty, with substantial tracked and untracked implementation work.
- Consequence: all implementation claims below are **working-tree** claims. They are not claims about HEAD alone, a clean committed baseline, a pushed branch, or production.
- Preservation rule: do not reset, restore, clean, stash, stage, commit, rebase, switch branches, or remove unrelated user work as part of status maintenance.

## Status vocabulary

| Term | Meaning |
|---|---|
| **working-tree** | Present in current dirty checkout. It may differ from HEAD and remote branches. |
| **local-verified** | Exercised by deterministic local validation or tests in this checkout. This does not prove credentials, external services, scheduling, yield, or production behavior. |
| **live-verified** | Observed through an explicitly authorized live integration or production-shadow procedure with retained evidence. No current item is claimed live-verified here. |
| **promoted** | A clean, reviewed revision has satisfied executable release gates and been deliberately adopted for production use. Launchpad is not promoted. |

## Current local position

Working-tree implementations for readiness Phases 00–06 are present. Local engineering paths are substantially complete; credentialed, elapsed-time, and outward-facing gates remain open.

### Phase 00 — resume path

- Resume queue reads only checked Applications v5 `Make Resume` rows and defaults to `createLocalResumeBuilder()` / `createLocalPdfVerifier()`.
- Builder changes only marked tailoring slots in frozen template, uses approved master evidence, compiles locally, and keeps `resumes/output/<date>/` PDF-only.
- Focused Phase 00 checks passed 13/13.
- No real checked role/JD is currently available locally, so real role-specific PDF evidence remains blocked.

### Phase 01 — discovery correctness

- Durable opportunity identity prefers provider + requisition ID. Distinct requisitions do not merge through company/title/location fallback.
- Workday DETAIL `startDate` is trusted; list-only relative `postedOn` remains unverified.
- Deadline and source signals propagate into scoring and mode selection.
- Remote eligibility requires explicit India/APAC evidence or compatible IST overlap; context-free worldwide/global text is insufficient.
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
- No live Notion write or real notification-delivery claim exists.

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

- real checked-role/JD resume build and retained role-specific PDF verification;
- manual rotation of previously exposed Notion credential; exposed value must not be reused;
- restored credentialed access and live four-store Notion v5 smoke;
- authenticated LinkedIn/browser smoke;
- real Gmail account connection, draft creation, send, or reply observation;
- seven actual distinct valid UTC canary dates for every intended production profile on one clean release version;
- real launchd installation, immutable release promotion, bootstrap recovery drill, or rollback drill;
- clean reviewed commit, push, PR, or production promotion.

Canary remains fail-closed. Promotion evidence must match exact normalized profile and release code/config version, contain expected report pairs and manual inventory confirmation, and span seven distinct valid UTC dates in current consecutive valid streak. Historical versions may precede that streak; invalid current evidence resets it.

## LP-001–LP-019 working-tree snapshot

GitHub is live status authority. This conservative local snapshot must not be upgraded to live-verified without explicit evidence.

| Ticket | Local status | Current interpretation |
|---|---|---|
| LP-001 | Locally complete, combined-suite gate open | Daily schedule/mode/location propagation and shared crawl-to-selector dispatch are implemented. |
| LP-002 | Locally complete, combined-suite gate open | Workday detail `startDate` is trusted and list `postedOn` is verification-only. |
| LP-003 | Locally complete, combined-suite gate open | Opportunity ledger owns cross-day suppression/cooldown; surfacing occurs only for final shortlist. |
| LP-004 | Partial | Rotation-state implementation exists; operational/live proof remains open. |
| LP-005 | Locally complete, live gate open | Outcome-bound notification receipts exist; installation and delivery proof remain open. |
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

Latest bounded verification on 2026-08-18 included Phase 06 tests (27/27), Launchpad validator, safety-contract validation, full tracked diff checks, and a clean committed-copy combined run covering 75 test files (713/713 passed). Earlier independently retained evidence includes Phase 00 (13/13), Phase 01 (168/168), and clean-copy Phase 03 (64/64). Combined test sub-run passes; overall readiness remains intentionally non-production because live, elapsed-time, credentialed, and promotion evidence is absent.
