# Launchpad v5 — System Reference

This reference describes the local executable contract as of 2026-07-23. It is intentionally explicit about what is locally verified and what remains live-gated.

## Operator entrypoint

```sh
node launchpad-v5.mjs help
node launchpad-v5.mjs validate
node launchpad-v5.mjs rehearse
```

`help` is read-only. `validate` checks `config/launchpad-v5.commands.json`, `config/notion-v5.manifest.json`, the v5 schema/views, policy files, and canonical/Claude skill mirrors. `rehearse` runs Normal, Startup, Remote, Internship, LinkedIn rescue, Apify preparation, resume queue/state sync, and outreach preparation against fixtures and local fakes. It performs zero external writes and no network/browser operation.

## Public workflow surface

| Command | Local interface | Boundary |
|---|---|---|
| `/morning` | `runNormalMode()` | Normal default; explicit v5 write phase only |
| `/morning startup` | `runStartupMode()` | Startup source emphasis; same hard gates |
| `/morning remote` | `runRemoteMode()` | Remote source emphasis; same hard gates |
| `/make-applications` | `readMakeResumeQueue()`, `processMakeResumeQueue()` | Local compilation; reads `Make Resume`, never checks it |
| `/outreach` | `prepareOutreach()`, `persistOutreach()` | Draft preparation; never sends |
| `/linkedin-leads` | `buildLinkedInRescueQueryPlan()`, `runLinkedInRescue()` | Explicit read-only rescue; no Notion mutation |
| `/followups` | `dueCadenceAction()`, `deriveOutreachState()` | Read/draft only until user confirms |
| `/sync` | `syncAppliedApplications()`, `syncConfirmedOutcome()` | User-confirmed state; idempotent Activity |
| Apify rescue | `node job-pull/apify-pull.mjs --profile <stable-name> --out RAW.json` | Default-off, explicit profile, no daily dependency |

Normal has no argument. Startup and Remote alter source emphasis, not eligibility. Internship is a separate category within the v5 Applications model, with stipend evidence and tier fields.

## Discovery and readiness

Mode runners normalize source records, retain source telemetry, and use the shared pipeline for freshness, eligibility, deduplication, scoring, application readiness, selection, and planned operations. A selected role must have:

- active liveness evidence;
- permitted Pune-metro onsite/hybrid or explicit India-compatible remote evidence;
- full-time, paid internship, or stable India-available Contractor/EOR employment;
- no hard 3+ year minimum, fee, bond, gig, commission, or unstable freelance signal;
- a resolved original employer/ATS destination with provenance.

Unresolved roles remain in the verification queue and never satisfy the minimum. Selection targets minimum 10, preferred 12, maximum 20, with strict-first freshness/fit bands and labelled backfill. Source failures are visible and nonfatal; policy, readiness, scoring, deduplication, manifest, and ledger failures stop before a live plan.

Internship tiers are deterministic: INR 30,000+ per month is Preferred; INR 25,000–29,999 is Lower-Stipend; below INR 25,000 is rejected; unknown or ambiguous compensation is verification-only. Stipend amount, currency, period, monthly amount, raw evidence, evidence text, tier, freshness, and readiness now map to Applications v5 fields.

## v5 Notion boundary

The repository-owned gateway is `notion-v5/gateway.mjs`, scoped by `config/notion-v5.manifest.json` to Applications, Companies, Outreach, Activity, and Referrals v5. `notion-v5/schema.mjs` owns property contracts and required view definitions. `notion-v5/transaction.mjs` owns redaction, external-journal enforcement, reservation, verification, commit, abort, and recovery.

Live credential rules:

1. Credentials must be in an external protected file, not the repository or command output.
2. Live writes require `live: true`, the declared v5 manifest, and the external journal path `/Users/onkarj012/.local/state/launchpad-v5/transactions.json` (`0700` parent directory, `0600` regular file).
3. Application writes use reserve → write → fetch/relation verify → commit. Failed rows are aborted and reported.
4. Unknown, undeclared, or legacy identifiers are rejected before transport. There is no fallback target.
5. Provisioning, transactional smoke, and production morning remain live-gated in this handoff. No live success is claimed here.

## Resume and state synchronization

`resume-v5/queue-reader.mjs` reads the direct v5 Applications queue and refuses a legacy gateway target. `resume-v5/resume-queue.mjs` transitions each selected row through Building and then Ready, Failed, or Stale based on the exact role artifact and verifier. Compilation remains local-only and the delivered output is PDF-only.

`resume-v5/application-sync.mjs` observes user-set `Applied? = true`. On first observation it sets Status to Applied, preserves an existing Applied At, stamps the current confirmed observation only when the date is unknown, creates one Activity event, and updates suppression. Repeated sync is a no-op. Confirmed terminal/interview outcomes require evidence.

`outreach-v5` keeps free-first contact evidence, deterministic application × person × channel identity, compact table properties, and full draft body. `confirmManualSend()` and `recordOutreachOutcome()` require explicit confirmation; they record state but contain no send provider. Cadence is Day 0, 3, 10, 17 and stops on response, rejection, opt-out, withdrawal, closure, or offer.

## LinkedIn and Apify rescue

LinkedIn rescue is separate from morning. The query plan is allowlisted and bounded. Captured posts preserve post, author, timestamp, raw hiring context, job/form link, and contact invitation evidence. The classifier may produce both an application lead and associated person; only an active resolved original application can be Ready. Deterministic fixtures cover noise, stale, duplicate, invalid, and ineligible posts. Real authenticated browsing is a manual read-only smoke only.

Apify rescue profiles are disabled by default and selected by stable profile name. Native remote sources are not duplicated through Apify. Missing token, timeout, actor failure, or schema drift is reported as unavailable/degraded and never breaks the daily path.

## Verification map

```sh
node --test tests/job-pull/*.test.mjs
node --test tests/notion-v5/*.test.mjs
node --test tests/resume-v5/*.test.mjs
node --test tests/outreach-v5/*.test.mjs
node --test tests/v5/*.test.mjs
node tests/resume/verify.mjs
git diff --check
```

The deterministic suites exercise modes, internship boundaries, provider evidence, rescue filters, Apify default-off behavior, v5 scope/retries/relations/transactions, queue and Applied? idempotency, outreach cadence, and command/help/rehearsal integration. A production run and credentialed Notion smoke are not represented by these local tests.

## Recovery and handoff

- Validate before any live operation: `node launchpad-v5.mjs validate`.
- Inspect pending journal entries with the external journal's operator tooling; recover or abort them before retrying. Never delete a pending entry to make a run look clean.
- Rotate the external Notion credential by replacing the protected file, checking permissions, and rerunning preflight. Do not print the token.
- If a source fails, report its manifest and continue only when core policy remains valid.
- If any live preflight, relation verification, transaction, or view check fails, leave v5 unused for production. Never fall back to another tracker.
