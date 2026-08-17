# Launchpad current status

This is the sole repository index for current execution status. It describes the checked-out working tree, not a release announcement. GitHub issues remain the live issue-status authority; local issue packs and dated research are specifications or history.

## Authority hierarchy

1. `master_prompt.md` owns targeting, scoring, resume, and outreach policy.
2. `config/launchpad-v5.commands.json`, `config/notion-v5.manifest.json`, and executable validators own command, safety, and v5 target contracts.
3. Tests and the checked-out implementation establish local behavior.
4. This file summarizes current execution status.
5. Specifications, issue packs, audits, probes, and reports preserve design intent and dated evidence. They are not current-status trackers.

When sources conflict, do not infer a promotion from prose. Re-run the allowed local checks and treat live gates as open until explicit production evidence exists.

## Checkout identity and warning

- Branch: `ticket/w1-1-workday-freshness`
- HEAD at this documentation synchronization: `978ce25f49260a353e0afde6b53a6fec70b057b1`
- Working tree: dirty, with substantial pre-existing tracked and untracked implementation work.
- Consequence: all implementation claims below are **working-tree** claims. They are not claims about HEAD alone, a clean committed baseline, a pushed branch, or production.
- Preservation rule: do not reset, restore, clean, stash, stage, commit, rebase, switch branches, or remove the untracked Aug 4 research/profile material as part of this documentation update.

## Status vocabulary

| Term | Meaning |
|---|---|
| **working-tree** | Present in the current dirty checkout. It may differ from HEAD and remote branches. |
| **local-verified** | Exercised by deterministic local validation or tests in this checkout. This does not prove credentials, external services, scheduling, yield, or production behavior. |
| **live-verified** | Observed through an explicitly authorized live integration or production-shadow procedure with retained evidence. No current item is claimed live-verified here. |
| **promoted** | A clean, reviewed revision has satisfied the executable release gate and been deliberately adopted for production use. Launchpad is not promoted. |

## Current local position

The unified daily path is implemented in the working tree and is stabilizing behind live gates:

```sh
node crawler/cli.mjs daily morning --mode normal  --location-preset india
node crawler/cli.mjs daily morning --mode startup --location-preset pune
node crawler/cli.mjs daily morning --mode remote   --location-preset india
node crawler/cli.mjs daily midday  --mode normal  --location-preset pune
node crawler/cli.mjs daily midday  --mode startup --location-preset india
node crawler/cli.mjs daily midday  --mode remote   --location-preset india
```

Key locally implemented behavior:

- one shared crawl feeds the selected Normal, Startup, or Remote mode selector;
- midday Remote omits native remote-feed fetching because those feeds are morning-only;
- all modes use shared score gating, select from the post-opportunity-ledger-suppression pool, and surface only the final shortlist;
- crawler SQLite remains discovery/observation state and no longer owns cooldown surfacing policy;
- Workday detail `startDate` is trusted; list-only `postedOn` is undated and enters `VerifyQueue`;
- the local manifest validator requires the exact ten reciprocal v5 relation entries;
- readiness test coverage spans `tests/crawler`, `tests/job-pull`, `tests/notion-v5`, `tests/resume-v5`, `tests/outreach-v5`, and `tests/v5`;
- local launchd generation/support exists, but this file does not claim that the current working-tree commands are installed or live-verified;
- v5 is the only active runtime target. v3 and v4 are historical read-only systems with no fallback, migration, archive, or delete path.

## Open live and release gates

The following have **not** happened:

- no live credentialed Notion v5 smoke;
- no authenticated LinkedIn/browser smoke;
- no retained production-shadow canary streak for this implementation version;
- no seven consecutive same-version valid canary runs with matching manual inventory evidence and report pairs;
- no clean committed baseline for the current dirty implementation;
- no commit, push, or production promotion;
- no guaranteed Gmail draft adapter or read-only Gmail history integration.

The canary is fail-closed. A valid day requires a clean revision/worktree, recognized matching run evidence, the expected report pair, and a manual review of the same inventory. The evaluator may recommend promotion only after seven consecutive valid runs for one implementation version. Historical invalid logs remain invalid.

## LP-001–LP-019 working-tree snapshot

GitHub is the live status authority. This conservative local snapshot must not be upgraded to live-verified without explicit evidence.

| Ticket | Local status | Current interpretation |
|---|---|---|
| LP-001 | Locally complete, full-suite gate open | Daily schedule/mode/location propagation and shared crawl-to-selector dispatch are implemented. |
| LP-002 | Locally complete, full-suite gate open | Workday detail `startDate` is trusted and list `postedOn` is verification-only. |
| LP-003 | Locally complete, full-suite gate open | Opportunity ledger owns cross-day suppression/cooldown; surfacing occurs only for the final shortlist. |
| LP-004 | Partial | Rotation-state implementation exists, but operational/live proof remains open. |
| LP-005 | Partial | Notification implementation exists, but installation, delivery, and operational proof remain open. |
| LP-006 | Partial | Resolver-limit propagation is improved but not declared complete across all sources. |
| LP-007 | Partial | Apify seen/cache state exists in the working tree; retained-dataset operations are not complete. |
| LP-008 | Partial | Apify budget state and guards exist in part; full cost reconciliation and live policy proof remain open. |
| LP-009 | Open | Custom career crawling still lacks the required verified Pune production source. |
| LP-010 | Not started | Crawlee has not been introduced at the custom-career seam. |
| LP-011 | Not started | Default-off Firecrawl hard-page rescue is not implemented. |
| LP-012 | Partial | Startup mode and company evidence paths exist, but focused source/provider coverage and live persistence proof remain open. |
| LP-013 | Partial | India-remote evidence and selection are hardened in part; complete operational proof remains open. |
| LP-014 | Partial | Person/founder research can feed outreach preparation, but selected-role handoff and provider coverage are incomplete. |
| LP-015 | Partial | Free-first and contact review safeguards are improved; complete paid-provider/live review proof remains open. |
| LP-016 | Not started | Read-only Gmail relationship history is absent. |
| LP-017 | Partial | Outreach sequence and Activity linkage are improved in the working tree; full lifecycle/live proof remains open. |
| LP-018 | Not started | Gmail draft-only adapter is absent. Local draft text is not a Gmail draft guarantee. |
| LP-019 | Not started | Reply observation and manual LinkedIn conversation import are absent. |

## Safety boundary

External actions remain prohibited except through an explicitly authorized, scoped path. Launchpad never auto-applies, autonomously sends email/DM/referral requests, creates credentials, or checks the user-owned `Make Resume` or `Applied?` fields. Resume compilation remains local-only. Unknown evidence remains `Not Verified`.

## Local verification commands

These commands establish local consistency only:

```sh
node launchpad-v5.mjs validate
node crawler/safety-contract.mjs
node crawler/cli.mjs readiness --run-tests
git diff --check
```

The readiness command runs the crawler, job-pull, notion-v5, resume-v5, outreach-v5, and v5 test groups. Do not quote a passing-test count unless the run evidence is dated and retained. For this documentation synchronization, verification is intentionally limited to repository `rg` checks, the two validators above, and `git diff --check`.
