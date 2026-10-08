# 04 — Plan bounded sources and remove duplicate fetches

**Status:** proposed

## Parent

[Launchpad Daily Discovery Recovery Plan](../../plans/launchpad-daily-discovery-recovery.md)

## Outcome

Source time favors relevant measured yield, preserves deterministic exploration, and never fetches the same board twice in one daily run.

## What to build

- Stop treating registry membership as an instruction to fetch every board immediately.
- Build deterministic source tiers: daily core, targeted enterprise, exploration, and opportunistic.
- Allocate 80% of measured source budget to priority coverage and 20% to deterministic exploration until three completed no-write runs provide recalibration evidence.
- Rank or continue boards using geography and title relevance, source health, retained application-ready yield, continuation cursor, and exploration quota.
- Record why every board was selected, deferred, resumed, or omitted.
- Hydrate details only for target titles and compatible geographies.
- Move tracked ATS rotation into the durable crawler source plan.
- Deduplicate normalized board identities across source lanes before network work.
- Remove the second post-crawler `fetchWarmAts()` pass only after rotation coverage exists in the first pass.
- Keep legacy planner behavior behind a bounded rollback flag while evidence is collected.

## Main paths

- `crawler/board-registry.mjs`
- `crawler/operator.mjs`
- `crawler/daily-runner.mjs`
- `config/crawler-v2-dev.json`
- focused files under `tests/crawler/`

## Acceptance criteria

- [ ] Every board receives one normalized identity before fetch planning.
- [ ] Network trace records one fetch owner per board and no board is fetched twice.
- [ ] Daily core, targeted enterprise, exploration, and opportunistic tiers are deterministic for the same inputs.
- [ ] Selection records explain every selected, deferred, resumed, and omitted board.
- [ ] Priority and exploration allocation is 80/20 unless retained evidence supports a later change.
- [ ] Continuation cursors resume unfinished productive boards before equivalent fresh work.
- [ ] Detail hydration is limited to target titles and compatible geographies.
- [ ] Tracked ATS rotation is present in the durable source plan before the duplicate post-crawler fetch is removed.
- [ ] Three no-write manifests show source discovery at or below 12 minutes without reducing retained application-ready yield.
- [ ] Legacy planner rollback preserves lifecycle, cancellation, dedupe, and selection-reason telemetry.
- [ ] `config/crawler-v2.json` and production activation remain unchanged without separate approval after local proof.

## Exit gate

Produce three no-write manifests with no duplicate board fetch, complete selection reasons, source phase at or below 12 minutes, and no lower retained ready-role yield.

## Rollback boundary

Switch source planning to the legacy projection through config while retaining durable lifecycle, cancellation, board-identity, and dedupe telemetry.

## Blocked by

[03 — Return resumable partial results safely](./03-return-resumable-partial-results-safely.md)
