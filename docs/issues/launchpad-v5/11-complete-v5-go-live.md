# Complete the v5 go-live and canonical skill handoff

Status: locally-complete-live-gated

## Parent

[Launchpad v5 specification](../../spec/launchpad-v5.md)

## User stories covered

34–35, 69–78

## What to build

Release Launchpad v5 as the sole active workflow without mutating or falling back to legacy databases. Align the canonical agent skills and Claude compatibility surface to the same commands and contracts, update system verification documentation to reflect executable behavior, run every deterministic and artifact verification suite, rehearse the complete workflow without writes, and execute a bounded transactional v5 smoke test.

After all gates pass, run one production Normal morning workflow and verify every selected row, company relation, view, ledger transition, and failure report manually.

## Current handoff state

Local integration is complete and the deterministic rehearsal is green. Canonical and Claude-compatible skills are byte-identical, and canonical mirror acceptance is complete. No credentialed Notion smoke, authenticated LinkedIn smoke, production morning run, or live success is claimed.

## Acceptance criteria

- [x] Canonical and Claude-compatible skills expose the same morning, startup, remote, resume, outreach, LinkedIn rescue, follow-up, and sync behavior without contradictory mutation rules. **Canonical and Claude mirrors are byte-identical; canonical mirror acceptance is complete.**
- [x] System documentation, configuration, command help, and verification references describe the implemented v5 contract and no longer claim legacy runtime behavior.
- [x] All existing job-pull and resume tests plus the new workflow, provider, gateway, state, outreach, and command/help tests pass locally.
- [x] A full no-write rehearsal covers discovery through planned Notion operations and reports zero external writes, zero external network/browser activity, no unexplained source omission, and no pending transaction.
- [ ] A bounded live v5 smoke test verifies reserve → write → fetch/relation verification → commit and an injected abort path.
- [ ] The first production Normal run writes only to v5 and every selected application appears in the correct relation and view.
- [x] Any failed gate leaves v5 unused for production and never falls back to a legacy target.
- [x] Historical systems remain unmodified by this integration; active migration, archive, and delete actions are absent.
- [x] The final handoff records how to run each command, inspect failures, rotate credentials, validate the manifest, and recover pending transactions.

## Blocked by

[04 — Add the separate internship application lane](./04-add-internship-application-lane.md); [05 — Deliver Startup mode end to end](./05-deliver-startup-mode.md); [06 — Deliver global Remote mode end to end](./06-deliver-global-remote-mode.md); [07 — Automate resume queues and application-state synchronization](./07-automate-resume-queues-and-sync.md); [08 — Deliver free-first outreach and follow-ups](./08-deliver-outreach-and-followups.md); [09 — Deliver the manually invoked LinkedIn hiring-post rescue](./09-deliver-linkedin-leads-rescue.md); [10 — Retain optional Indian-portal Apify rescue profiles](./10-retain-apify-rescue-profiles.md)
