# 03 — Return resumable partial results safely

**Status:** proposed

## Parent

[Launchpad Daily Discovery Recovery Plan](../../plans/launchpad-daily-discovery-recovery.md)

## Outcome

Useful durable observations produce an honest, resumable `partial` result instead of silence when source coverage or optional scoring runs out of budget.

## What to build

- Checkpoint nonfatal source-budget exhaustion as resumable `partial`.
- Reconstruct the funnel from all committed observations using existing freshness, eligibility, readiness, and historical-suppression policy.
- Score only inside remaining downstream budget; preserve ready roles that could not be scored in a separate score-pending group.
- Emit one versioned terminal envelope with `completed`, `partial`, or `failed` status.
- Include application-ready scored roles, application-ready score-pending roles, backfill, verification queue, rejection counts and reasons, and completed/interrupted/failed/not-started source coverage.
- Make side-effect policy status-aware and fail closed.

## Main paths

- `crawler/run.mjs`
- `crawler/workflow.mjs`
- `crawler/daily-runner.mjs`
- `crawler/cli.mjs`
- `crawler/schedule-health.mjs`
- focused files under `tests/crawler/`

## Acceptance criteria

- [ ] Forced nonfatal enterprise timeout emits a labelled `partial` terminal envelope instead of hanging or reporting market scarcity.
- [ ] Partial output sets `writesPlanned: false`.
- [ ] Partial execution performs zero opportunity-ledger surfacing, v5 planning or writes, application operations, outreach operations, checkbox changes, success-canary writes, success notifications, or other external operations.
- [ ] Partial output separates scored ready roles from score-pending ready roles.
- [ ] Partial output reports backfill, verification queue, rejection counts and reasons, and exact source coverage.
- [ ] A scorer timeout cannot erase otherwise ready durable observations.
- [ ] Re-running the same daily profile resumes its partial run and can later reach `completed` without duplicate observations.
- [ ] `completed` requires all planned sources to reach terminal source states and downstream selection to finish.
- [ ] `failed` names the exact fatal reason and last durable source state.
- [ ] CLI returns a terminal envelope within 20 minutes under bounded test conditions.
- [ ] Existing compatibility fields remain available for direct callers while the versioned envelope is introduced.

## Exit gate

Force an enterprise timeout, verify honest partial output and zero prohibited operations, then resume the same daily identity to completion.

## Rollback boundary

Disable partial emission by config if necessary. Preserve `completed`, `failed`, Phase 01 lifecycle telemetry, and Phase 02 cancellation.

## Blocked by

[02 — Stop network work at the execution deadline](./02-stop-network-work-at-the-execution-deadline.md)
