# Launchpad v5 operator handoff

Status: local integration complete; live credential, smoke, and production gates remain open.

## Local commands

```sh
node launchpad-v5.mjs help
node launchpad-v5.mjs validate
node launchpad-v5.mjs rehearse
```

The rehearsal is the safe handoff check. It uses deterministic fixtures, a no-write planning gateway, and local in-memory queue/outreach fakes. It must report `externalWrites: 0`, `externalNetwork: false`, `browserAutomation: false`, `applicationsSubmitted: false`, `autonomousSending: false`, `pendingTransactions: 0`, and `legacyFallback: false`.

## Agent commands

- `/morning` means Normal. Use `/morning startup` or `/morning remote` only when that source emphasis is wanted.
- `/make-applications` reads only user-checked Applications v5 `Make Resume` rows and compiles locally.
- `/outreach` researches evidence and stores drafts. The user reviews and sends manually.
- `/linkedin-leads` is explicit and read-only. Morning only suggests it after a material verified shortfall.
- `/followups` reads/drafts due actions from v5 Outreach and Activity cadence.
- `/sync` observes user-set `Applied?` and confirmed outcomes idempotently.
- Apify is `node job-pull/apify-pull.mjs --profile <stable-name> --out RAW.json` only; no profile is selected by default.

## Live preflight

Before live use, run `node launchpad-v5.mjs validate`. A live gateway also requires a protected credential file outside this repository and the external transaction journal at `/Users/onkarj012/.local/state/launchpad-v5/transactions.json`. Its parent directory is owner-only (`0700`) and the journal is owner-only (`0600`). The gateway refuses undeclared or legacy identifiers and refuses live writes without a reservation.

The remaining live sequence is deliberately manual:

1. Validate the manifest and v5 views against the current authorized workspace.
2. Run the bounded synthetic reserve → write → fetch/relation verify → commit smoke, plus an injected abort path.
3. Verify the written synthetic row, Company relation, views, journal state, and rollback/abort evidence.
4. Only then run one bounded production Normal morning workflow and inspect every row and relation manually.

This handoff does not perform those steps, create credentials, browse, write Notion, or claim live success.

## Recovery

Pending external journal entries require explicit operator recovery. Inspect the journal, verify whether a remote page exists, then mark the entry committed or aborted using the gateway's recovery path. Never delete pending state or rerun blindly. Rotate credentials by replacing the external 0600-style file without printing its contents.

## Safety boundary

No auto-apply, no autonomous sending, no automatic LinkedIn computer use, no legacy fallback, no migration/archive/delete of historical systems, local-only resume compilation, and PDF-only dated output are release gates.
