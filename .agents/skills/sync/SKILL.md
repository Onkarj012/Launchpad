---
name: sync
description: Synchronize only user-confirmed Applied? and lifecycle outcomes into the direct Launchpad v5 manifest scope. Never infers state, applies, sends, checks user boxes, or falls back to v3/v4.
disable-model-invocation: true
---

# Launchpad v5 confirmation sync

Run only for an explicit `/sync` request after Onkar has manually confirmed an application submission or a lifecycle outcome. This skill observes confirmed state and records it; it never performs the application or outreach action.

## Scope and preflight

- Load and validate `config/notion-v5.manifest.json`. Use a gateway constructed for that manifest and the declared v5 targets only. The direct `Applications v5` and `Activity v5` targets are the only sync stores; the opportunity ledger is an additive local suppression record.
- Use only the public interface in `resume-v5/application-sync.mjs`: `syncAppliedApplications()` and `syncConfirmedOutcome()`. Pass the v5 gateway and, when ledger suppression is required, `createLedgerSuppressionAdapter({ ledgerPath })` from `resume-v5/suppression-adapter.mjs`.
- Refuse missing, invalid, placeholder, undeclared, legacy, or v3/v4 targets before querying or writing. Never discover replacement IDs, call a legacy module, or use a fallback tracker.
- A live gateway requires the user’s explicit authorization, protected external credentials, and the normal v5 transaction safeguards. Do not request, print, persist, or guess credentials in this workflow.

## Applied? synchronization

For a user-confirmed submission, call:

```js
await syncAppliedApplications({ gateway, suppression })
```

The public function reads the direct v5 Applications query filtered to `Applied? = true` and applies the local filter again. It may reconcile the derived `Status = Applied`, stamp `Applied At` only when no valid date exists, record the v5 Activity event, and persist its sync key. It must never set or clear `Applied?`, `Make Resume`, or any other user-owned checkbox.

Do not infer that an application was submitted from `Make Resume`, `Ready`, a resume artifact, an outreach draft or send state, an Activity row, a status value, a URL visit, or elapsed time. If the user has not confirmed submission, leave the row untouched.

## Confirmed outcome synchronization

For one explicitly confirmed outcome, call:

```js
await syncConfirmedOutcome({
  gateway,
  application,
  outcome,
  evidence,
  suppression,
})
```

Accept only the implementation’s confirmed outcome values: `Interviewing`, `Offer`, `Rejected`, `Withdrawn`, `Not Pursuing`, and `Closed/Expired`. Require `evidence.confirmed === true` plus at least one evidence locator: `source`, `url`, `connector`, or `recordId`. Unknown, ambiguous, inferred, or merely observed state is not confirmation; stop and report what is missing.

The function updates the v5 application status and appends one `Confirmed` Activity event. Never manufacture an outcome from email contents, outreach state, dates, silence, or a neighboring application. Never overwrite a different confirmed outcome without a new explicit user confirmation and an implementation-supported event key.

## Idempotency and opportunity-ledger suppression

- Activity is append-only and idempotent. Applied events use `launchpad-v5:application:<application-id>:applied`; outcome events use the same form with the normalized outcome. Query Activity by that key before creating an event. A repeat must return `noop` and create no duplicate Activity page.
- Always pass the suppression adapter when the local opportunity ledger is in scope. It reads first and matches only the application’s `dedupKey` or canonical/original application URL.
- `none` may transition to `applied`; an existing `applied` row returns `already`; no matching row returns `not-found`; any other existing action state is a `conflict` and fails closed. Never create a ledger row, overwrite an unrelated row, or silently resolve a conflict.
- Repeated syncs must be safe: preserve a valid existing `Applied At`, avoid duplicate Activity, and leave an already-suppressed opportunity unchanged. Report partial or failed results rather than claiming completion.

## Forbidden actions

Never auto-apply, auto-send, message, connect, browse LinkedIn, check or uncheck `Applied?`/`Make Resume`, mutate v3/v4/legacy data, infer confirmation, or make live calls without explicit user authorization. This skill does not alter the tracker schema.
