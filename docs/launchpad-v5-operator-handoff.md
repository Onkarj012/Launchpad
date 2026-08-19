# Launchpad v5 operator handoff

Status: local v5 foundation and unified daily implementation are present in the dirty working tree; live credential, clean-release, canary, and promotion gates remain open. See [STATUS.md](STATUS.md). GitHub issues are the live issue-status authority.

## Local commands

```sh
node launchpad-v5.mjs help
node launchpad-v5.mjs validate
node launchpad-v5.mjs rehearse

node crawler/cli.mjs daily morning --mode normal|startup|remote --location-preset india|pune --run-id <id>
node crawler/cli.mjs daily midday  --mode normal|startup|remote --location-preset india|pune --run-id <id>
```

The rehearsal is fixture-backed and safe. The daily path performs one shared crawl and then the requested mode selector. Midday Remote skips native remote feeds. Neither local validation nor rehearsal proves installed scheduling, external source yield, live Notion, browser access, or production readiness.

## Agent commands

- `/morning` means unified daily Normal. `/morning startup` and `/morning remote` select focused ranking/source emphasis over the shared gates.
- `/make-applications` reads only user-checked Applications v5 `Make Resume` rows and compiles locally. It never checks `Make Resume` or `Applied?`.
- `/outreach` performs free-first research and prepares draft content. No Gmail draft adapter or send provider is guaranteed.
- `/linkedin-leads` is explicit and read-only. It never connects, messages, or runs automatically.
- `/followups` reads/drafts due actions from v5 Outreach and Activity cadence.
- `/sync` observes user-set `Applied?` and confirmed outcomes idempotently.
- Apify remains explicit and default-off: `node job-pull/apify-pull.mjs --profile <stable-name> --out RAW.json`.

## v5 boundary

Applications, Companies, Outreach, Activity, and Referrals v5 are the only active runtime stores. The local manifest validator requires exactly ten directed reciprocal relation entries. v3/v4 are historical read-only systems and are never write, migration, archive, delete, or fallback targets.

Before any authorized live write, run `node launchpad-v5.mjs validate`. The live gateway also requires a protected external credential and transaction journal at `/Users/onkarj012/.local/state/launchpad-v5/transactions.json`. The gateway refuses undeclared or legacy identifiers and refuses writes without a reservation.

## Remaining live sequence

1. Establish a clean committed revision for the implementation to be evaluated.
2. Validate the manifest and v5 views against the authorized workspace.
3. Run the bounded synthetic reserve → write → fetch/relation verify → commit smoke plus an injected abort path.
4. Retain the written synthetic row, relation/view, journal, and abort evidence.
5. Run the fail-closed production-shadow canary using matching evidence and Markdown/JSON report pairs.
6. Accumulate seven consecutive valid runs for the same code/config version, each matching careful manual review of the same inventory.
7. Promote only after explicit operator review.

None of these live steps, a commit/push, or promotion is claimed by this handoff.

## Recovery

Pending external-journal entries require explicit recovery. Verify whether a remote page exists, then mark the entry committed or aborted through the gateway recovery path. Never delete pending state or rerun blindly. Rotate credentials by replacing the protected file without printing its contents.

## Safety boundary

No auto-apply, autonomous sending, automatic LinkedIn computer use, credential creation, user-checkbox changes, legacy fallback, or historical-system mutation. Resume compilation is local-only and dated output is PDF-only. External actions require a separately explicit, authorized, scoped path.
