# Launchpad v5 — System Reference

This reference describes the current local executable contract in the checked-out working tree. Current execution status and open gates live in [STATUS.md](STATUS.md). GitHub issues are the live issue-status authority.

## Operator entrypoints

```sh
node launchpad-v5.mjs help
node launchpad-v5.mjs validate
node launchpad-v5.mjs rehearse

node crawler/cli.mjs daily morning --mode normal|startup|remote --location-preset india|pune --run-id <id>
node crawler/cli.mjs daily midday  --mode normal|startup|remote --location-preset india|pune --run-id <id>
```

`help` is read-only. `validate` checks command, manifest, schema/view, policy, and skill-mirror contracts. `rehearse` uses fixtures and local fakes only. The daily command performs one shared crawl and then invokes the requested mode selector. Midday Remote skips native remote feeds and selects from the shared midday ATS/delta inventory.

## Public workflow surface

| Command | Local interface | Boundary |
|---|---|---|
| `/morning` | unified `daily morning --mode normal` | Default daily mode; no auto-apply/send |
| `/morning startup` | unified `daily morning --mode startup` | Startup source emphasis; shared gates |
| `/morning remote` | unified `daily morning --mode remote` | Remote source emphasis; shared gates |
| `/make-applications` | `readMakeResumeQueue()`, `processMakeResumeQueue()` | Local compilation; reads `Make Resume`, never checks it |
| `/outreach` | `prepareOutreach()`, optional authorized persistence | Local/v5 draft preparation; no guaranteed Gmail adapter or send provider |
| `/linkedin-leads` | `buildLinkedInRescueQueryPlan()`, `runLinkedInRescue()` | Explicit read-only rescue; no automatic browser or message action |
| `/followups` | `dueCadenceAction()`, `deriveOutreachState()` | Read/draft only until user confirmation |
| `/sync` | `syncAppliedApplications()`, `syncConfirmedOutcome()` | Observes user-set state; idempotent Activity |
| Apify rescue | `node job-pull/apify-pull.mjs --profile <stable-name> --out RAW.json` | Default-off, explicit profile, no daily dependency |

Normal, Startup, and Remote change source emphasis and ranking, not the safety boundary. `india` and `pune` are location presets, not separate eligibility engines.

## Shared daily pipeline

The daily runner:

1. executes the schedule-appropriate shared crawl;
2. merges the shared inventory and source telemetry;
3. applies normalization, liveness, freshness, employment, geography, seniority, original-URL, and application-readiness rules;
4. removes actioned, rejected, cooldown, and seen-backfill opportunities through the opportunity ledger;
5. applies read-only historical identity suppression where available;
6. resolves usable `0–100` scores or places rows in the scoring queue under the shared scoring policy;
7. invokes the requested Normal, Startup, or Remote selector;
8. surfaces only the final selected shortlist to the local opportunity ledger and plans any v5 operations through the no-write boundary by default.

Crawler SQLite owns crawl observations, novelty, source health, and schedule state. It does not own the seven-day opportunity cooldown/surfacing policy.

Workday freshness trusts a usable DETAIL `startDate` and applies the normal age classes. LIST-only `postedOn`, including bounded labels, is not trusted for selection and remains in `VerifyQueue` until detail evidence supplies a usable `startDate`.

Daily readiness requires `eligibility?.eligible === true`; missing eligibility is not ready. Unstated experience manual review is not a rejection after the full eligibility result passes, while all other hard failures remain enforced.

`VerifyQueue` stays outside scoring and selection. The selection result records empty selected-key intersections with both `VerifyQueue` and `scoringQueue`. Backfill rows require a finite known age in the 8–14-day band.

Unresolved roles do not count toward the shortlist. A missing scorer with unscored rows, or a broken scorer infrastructure path, is fatal. Bounded per-row scoring failures from a functioning in-run scorer remain queued and make the run degraded rather than silently treating those rows as scored.

## Execution deadlines

The configured run stays at 20 minutes, with 12 minutes for discovery, five minutes reserved for scoring, and three minutes for handoff. Company careers, ATS warm rows, rendered navigation and body reads, and Workday detail enrichment consume the operator's signal and remaining discovery budget. Scoring checks its live remaining budget before starting. Company progress checkpoints retain the company and current URL to locate a stalled request. HTTP provider timeouts cover response bodies as well as headers.

Deterministic stalled transports and fake browsers establish local cancellation behavior. They do not prove the cause of a historical 15-minute stall or establish live source yield.

## v5 Notion boundary

The repository-owned gateway is `notion-v5/gateway.mjs`, scoped by `config/notion-v5.manifest.json` to Applications, Companies, Outreach, Activity, and Referrals v5. The working-tree validator requires exactly ten directed reciprocal relation entries across five relation pairs.

Live credential rules:

1. Credentials remain in an external protected file, not the repository or command output.
2. Live writes require `live: true`, the declared v5 manifest, and the external transaction journal at `/Users/onkarj012/.local/state/launchpad-v5/transactions.json`.
3. Application writes use reserve → write → fetch/relation verify → commit. Failed rows are aborted and reported.
4. Unknown, undeclared, v3, or v4 identifiers are rejected as runtime targets. There is no legacy fallback.
5. v3 and v4 remain historical read-only systems. No migration, archive, delete, or write is part of the active contract.
6. No live credentialed Notion smoke is claimed for the current dirty working tree.

## Resume, synchronization, and outreach

`resume-v5/queue-reader.mjs` reads the v5 Applications queue and refuses legacy targets. Resume compilation remains local-only and the delivered output is PDF-only.

`resume-v5/application-sync.mjs` observes user-set `Applied? = true` and confirmed outcomes. It never checks `Applied?` itself. Repeated synchronization is idempotent.

`outreach-v5` maintains free-first contact evidence, deterministic application × person × channel identity, draft content, cadence, and explicit manual-send/outcome confirmation. The active workflow contains no guaranteed Gmail draft adapter and no send provider. A local draft must not be represented as a Gmail draft or sent message.

## Scheduler support

The repository includes local macOS launchd generation/install support for morning and midday. Tests use temporary paths and injected command stubs. Therefore the implementation supports installation, but repository evidence alone does not establish that the current working-tree commands are installed, loaded, healthy, or live-verified on this machine.

## Verification map

`node crawler/cli.mjs readiness --run-tests` covers all six deterministic test groups:

```sh
node --test tests/crawler/*.test.mjs
node --test tests/job-pull/*.test.mjs
node --test tests/notion-v5/*.test.mjs
node --test tests/resume-v5/*.test.mjs
node --test tests/outreach-v5/*.test.mjs
node --test tests/v5/*.test.mjs
```

Core local checks:

```sh
node launchpad-v5.mjs validate
node crawler/safety-contract.mjs
git diff --check
```

Local tests do not prove source yield, installed scheduling, a live Notion transaction, authenticated browser access, a clean committed release, or the seven-run production canary gate.

## Recovery and release boundary

- Inspect pending external-journal entries before retrying; never delete them to make a run look clean.
- If a live preflight, relation verification, transaction, or view check fails, keep v5 unused for live writes and never fall back to v3/v4.
- Promotion requires seven consecutive valid same-version canary runs with clean revision/worktree evidence, matching manual inventory, complete Markdown/JSON report pairs, and all engineering zero gates.
- The repository currently claims no qualifying canary streak and no promotion.
