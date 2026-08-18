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

## Done when

- Every confirmed Applied? row has Status Applied, a preserved or stamped Applied At, and one Activity event
- A repeat returns `noop` with no extra Activity
- Outcomes require `evidence.confirmed === true` plus a locator
- Conflicts fail closed and are reported

user-owned. v5-only. fail-closed. no auto-apply.
