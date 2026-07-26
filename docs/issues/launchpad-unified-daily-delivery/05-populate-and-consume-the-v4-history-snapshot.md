# Populate and consume the v4 history snapshot

Status: proposed

## Parent

[Launchpad Unified Daily Delivery](../../spec/launchpad-unified-daily-delivery.md)

## User stories covered

17, 18, 19, 20

## What to build

Give identity suppression the real application history it was built for.

The snapshot loader exists, is tested, handles missing, stale, and malformed files gracefully, and is wired into the crawl operator. Two things are missing. The snapshot file at its expected path has never been created, so the loader always returns zero rows. And the unified daily run defaults its historical rows to empty rather than reading the snapshot at all, so even a populated file would not reach delivery-side suppression.

Produce the snapshot from a read-only export of Applications v4, in the row shape the loader already declares, wrapped with a generation timestamp. Document the refresh procedure alongside the existing research documentation. v4 stays historical-only: nothing writes to, migrates, archives, or deletes it.

Make the unified run read the snapshot by default and surface its status — loaded, missing, stale, or malformed — in run telemetry. Stale warns and still supplies rows. Missing and malformed degrade to zero rows without fabricating history and without failing the run.

## Acceptance criteria

- [ ] The snapshot file exists at the expected path in the declared row shape with a generation timestamp.
- [ ] The refresh procedure is documented and repeatable.
- [ ] The unified run reads the snapshot by default rather than defaulting to empty historical rows.
- [ ] A populated snapshot suppresses matching roles from the shortlist and reports them as historical suppressions.
- [ ] Snapshot status appears in run telemetry for all four outcomes.
- [ ] A stale snapshot warns and still supplies its rows.
- [ ] A missing or malformed snapshot suppresses nothing, fabricates nothing, and does not fail the run.
- [ ] No write, migration, archive, or delete touches v4.

## Blocked by

[01 - Route the full scheduled crawl into v5 scoring](./01-route-full-crawl-into-v5-scoring.md)
