# Automate resume queues and application-state synchronization

Status: locally-complete-live-gated

## Parent

[Launchpad v5 specification](../../spec/launchpad-v5.md)

## User stories covered

51–58, 69–76

## What to build

Complete the user-controlled application handoff without requiring pasted rows. The resume workflow reads checked Make Resume rows directly from v5, builds each role-specific PDF using the existing verified resume pipeline, and reflects actual artifact progress through the resume sub-state. The synchronization workflow observes user-confirmed Applied? changes and idempotently updates application lifecycle, dates, Activity, and cross-day suppression.

The agent must never check Make Resume or Applied? itself and must never infer an application submission.

## Acceptance criteria

- [ ] The resume workflow queries v5 for checked Make Resume rows without semantic-search guesses or pasted company/role lists.
- [ ] Only selected rows build, and each row transitions through Not Started, Building, Ready, Failed, or Stale according to real artifact results.
- [ ] Ready is set only after the correct role-specific PDF passes compilation and verification.
- [ ] Resume paths and supporting evidence are associated with the correct application; stale or mismatched files are rejected.
- [ ] On first observation of Applied? true, sync sets Status to Applied, preserves an existing application time or records a current confirmed time when appropriate, creates one Activity event, and updates suppression.
- [ ] Repeated synchronization is a no-op and never duplicates events, changes preserved dates, or reprocesses ledger state.
- [ ] Interview, offer, rejection, withdrawal, not-pursuing, and closed outcomes require user-confirmed or connector-backed evidence.
- [ ] Tests cover autonomous queue reading, artifact failures, partial batches, idempotency, unknown dates, terminal outcomes, and v3/v4 target refusal.

## Blocked by

[02 — Provision Notion v5 through the scoped local gateway](./02-provision-notion-v5-gateway.md); [03 — Deliver India-first Normal mode end to end](./03-deliver-india-first-normal-mode.md)
