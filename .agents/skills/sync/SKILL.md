---
name: sync
description: Record user-confirmed Applied? and lifecycle outcomes into v5 only.
disable-model-invocation: true
---

# Launchpad v5 confirmation sync

Vocabulary: `../guardrails.md`. Run only after Onkar confirms a submission or outcome.

Two branches live behind pointers:

- Applied? observations → `references/applied.md`
- Confirmed outcomes → `references/outcomes.md`

Public interface: `syncAppliedApplications()` and `syncConfirmedOutcome()` in `resume-v5/application-sync.mjs`. Ledger suppression is additive via `createLedgerSuppressionAdapter()`.

## Procedure

1. Read the v5 Applications rows and observe the user-owned `Applied?` value; never set, clear, or infer it.
2. Observed Applied? branch: for each newly observed true transition, call `syncAppliedApplications()` to preserve or stamp `Applied At`, set the v5 status, and append one idempotent Activity event.
3. Confirmed outcome branch: for a user-confirmed lifecycle outcome, call `syncConfirmedOutcome()` only with `evidence.confirmed === true` and a source locator; update v5 status and append one idempotent Activity event.
4. Re-run either branch with the same identity key and report `noop` without a second Activity event. Conflicts fail closed.

## Done when

- Every observed Applied? transition has exactly one v5 Activity event and a preserved or stamped Applied At.
- Every confirmed outcome has `evidence.confirmed === true`, a locator, and exactly one v5 Activity event.
- A repeat of either branch returns `noop` with zero additional Activity events.
- The count of `Applied?` checkbox mutations is zero; conflicts are listed as blocked.

user-owned. v5-only. fail-closed. no auto-apply.
