# Report source truncation and reduce scheduled run duration

Status: proposed

## Parent

[Launchpad Unified Daily Delivery](../../spec/launchpad-unified-daily-delivery.md)

## User stories covered

24, 25, 26, 27, 28

## What to build

Make configured caps visible when they bind, and keep the morning run inside its window now that scoring runs inside it.

The crawl already persists truncation, cap-hit, and records-not-examined signals per source, but they are not reported where an operator would see them, so a capped first page is indistinguishable from exhausted inventory. Surface them in schedule health, then raise per-source caps only where truncation is actually observed rather than uniformly.

Separately, a full production crawl takes about sixteen minutes and every source is fetched in a strictly sequential loop. That measurement predates adding scoring to the same run. Re-measure after unification, and record per-source durations before changing anything: bounded detail hydration on enterprise boards is a plausible dominant cost, and if it dominates, concurrency is the wrong fix.

If concurrency is warranted, use a bounded pool and keep the existing per-host spacing and concurrency limiter authoritative over it, so politeness constraints are never relaxed by parallelism.

## Acceptance criteria

- [ ] Truncation, cap-hit, and records-not-examined signals are reported per source in schedule health.
- [ ] A source that hits its record cap reports truncation rather than presenting a capped page as complete inventory.
- [ ] Per-source durations are recorded and reported.
- [ ] Run duration is re-measured after unification and the dominant cost is identified before any concurrency change.
- [ ] Caps are raised only for sources where truncation was observed.
- [ ] If concurrency is introduced, per-host spacing and concurrency limits remain authoritative over the pool.
- [ ] The scheduled run completes inside its morning window with scoring included.

## Blocked by

[01 - Route the full scheduled crawl into v5 scoring](./01-route-full-crawl-into-v5-scoring.md)
