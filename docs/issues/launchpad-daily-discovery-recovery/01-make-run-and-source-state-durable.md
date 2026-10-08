# 01 — Make run and source state durable

**Status:** proposed

## Parent

[Launchpad Daily Discovery Recovery Plan](../../plans/launchpad-daily-discovery-recovery.md)

## Outcome

Every daily run has stable identity, every planned source is visible before fetching starts, and an interrupted invocation can resume unfinished work without losing or duplicating durable evidence.

## What to build

- Use `daily-<schedule>-<mode>-<location-preset>-<IST-date>` as the default daily identity.
- Reuse the same incomplete run for repeated invocations of the same profile and IST date.
- Preserve explicit `--run-id` for controlled replay and keep historical timestamped IDs readable.
- Register every planned source before network work begins.
- Persist source transitions through `pending`, `running`, `succeeded`, `truncated`, `interrupted`, `failed`, and `not_started` as applicable.
- Record attempt metadata without deleting or rewriting prior run history.
- Classify dead over-deadline `running` rows as stale or abandoned in schedule health while preserving their evidence.

## Main paths

- `crawler/scheduler.mjs`
- `crawler/cli.mjs`
- `crawler/run.mjs`
- `crawler/schedule-health.mjs`
- focused files under `tests/crawler/`

## Acceptance criteria

- [ ] Same schedule, mode, location preset, and IST date return the same default run ID.
- [ ] A different schedule, mode, location preset, or IST date produces a different default run ID.
- [ ] Explicit `--run-id` still overrides the default identity.
- [ ] Historical timestamped run IDs remain readable.
- [ ] Every planned source has a durable source row before its fetch begins.
- [ ] Planned source count equals explicit source-state count at terminal or resumable handoff.
- [ ] Interrupting after ATS batch 2 records the active source as `interrupted` and untouched sources as `not_started`.
- [ ] Re-running the same daily command resumes the same ID and unfinished work without duplicate observations.
- [ ] Attempt metadata distinguishes retries or resumes without deleting earlier telemetry.
- [ ] Schedule health distinguishes active, stale or abandoned, partial or resumable, completed, and failed runs.
- [ ] Database, schema, persistence, or safety-invariant failure remains fatal and produces no downstream write plan.

## Exit gate

Interrupt after ATS batch 2, invoke the same command again, and prove same-ID resume, no duplicate observations, and complete source-state coverage.

## Rollback boundary

Restore timestamp-based default IDs if needed while retaining additive source telemetry, attempt metadata, and historical rows.

## Blocked by

None. Can start first.
