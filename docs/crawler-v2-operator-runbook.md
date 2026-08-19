# Crawler v2 operator runbook

Current release status is in [STATUS.md](STATUS.md). The unified daily working-tree implementation is locally stabilizing and remains live-gated.

## Profile matrix

The executable profile is the cross-product of:

- schedule: `morning | midday`
- mode: `normal | startup | remote`
- location preset: `india | pune`

```sh
node crawler/cli.mjs plan morning --mode normal  --location-preset pune
node crawler/cli.mjs plan morning --mode startup --location-preset pune
node crawler/cli.mjs plan morning --mode remote   --location-preset india
node crawler/cli.mjs plan midday  --mode normal  --location-preset pune
node crawler/cli.mjs plan midday  --mode startup --location-preset india
node crawler/cli.mjs plan midday  --mode remote   --location-preset india
```

Normal, Startup, and Remote share the same policy/readiness boundary. Pune changes source priority and query hints only; it is not a fourth eligibility implementation.

## Unified daily run

```sh
node crawler/cli.mjs daily morning --mode normal  --location-preset pune  --run-id <unique-id>
node crawler/cli.mjs daily morning --mode startup --location-preset india --run-id <unique-id>
node crawler/cli.mjs daily morning --mode remote   --location-preset india --run-id <unique-id>
node crawler/cli.mjs daily midday  --mode normal  --location-preset pune  --run-id <unique-id>
node crawler/cli.mjs daily midday  --mode startup --location-preset india --run-id <unique-id>
node crawler/cli.mjs daily midday  --mode remote   --location-preset india --run-id <unique-id>
```

The daily command runs one schedule-appropriate shared crawl, converts that inventory into the v5 lane contract, and invokes the requested mode selector. It does not perform a second focused-source crawl. Midday Remote deliberately omits native remote feeds and selects from shared ATS/delta inventory.

## Discovery-only run

```sh
node crawler/cli.mjs run morning --mode normal --location-preset pune --run-id <unique-id>
node crawler/cli.mjs run midday --mode normal --location-preset pune --run-id <unique-id>
```

`run` is the discovery crawler surface. `daily` additionally executes v5 scoring/selection and commits only the final selected shortlist to the local opportunity ledger; v5 operations remain planning-only unless a separate live path is explicitly authorized.

Neither path applies, sends, generates resumes, changes `Make Resume`/`Applied?`, or performs authenticated LinkedIn actions.

## Shared gating and surfacing order

1. Normalize and apply freshness, liveness, geography, employment, experience, fee/bond, and original-URL/readiness rules.
2. Apply opportunity-ledger action, cooldown, and seen-backfill suppression.
3. Apply read-only historical identity suppression where supplied.
4. Resolve usable finite `0–100` scores under the shared scoring policy.
5. Run the requested Normal, Startup, or Remote selector.
6. Surface only the final selected shortlist.

A missing scorer with unscored rows or a broken scorer is fatal. Bounded per-row failures from a functioning in-run scorer remain in the scoring queue and degrade the run; they are never treated as scored.

Crawler SQLite owns observations, novelty, source telemetry, and schedule state. The opportunity ledger owns cooldown and cross-day surfaced policy.

Workday DETAIL `startDate` is trusted when usable. LIST `postedOn` is not trusted and enters `VerifyQueue`.

## Recovery and interpretation

- Reuse the same run ID only when an idempotent retry is intended.
- `verificationQueue` and `scoringQueue` are not application-ready inventory.
- A shortfall is reported honestly; do not relax geography, experience, freshness, liveness, compensation, score, or original-URL gates.
- v3/v4 rows are historical read-only identity inputs and are never migrated, changed, deleted, or used as runtime fallback.
- Review source telemetry by schedule, mode, preset, and source before changing frequency or caps.
- Local launchd installer support does not prove the current schedule is installed or healthy.

## Handoff boundary

The crawler returns a local discovery/planning result. Any later Notion transaction requires explicit authorization and the protected v5 transaction path. Applications, outreach delivery, and user-owned checkboxes remain human-controlled.
