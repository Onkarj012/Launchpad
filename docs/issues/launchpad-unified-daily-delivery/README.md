# Launchpad unified daily delivery issues

Parent specification: [Launchpad Unified Daily Delivery](../../spec/launchpad-unified-daily-delivery.md)

## Dependency order

```text
01 → 02 ──────────────┐
 ├── 03 ──────────────┤
 ├── 04 ──────────────┤
 ├── 05 ──────────────┘→ 08
 └── 07

06 (independent)
```

Issue 01 is the release-blocking wiring change and must land first. Issue 02 makes it the executed path — 01 without 02 fixes a function nothing calls. Issues 03, 04, 05, and 07 can proceed in parallel after 01. Issue 06 is independent of everything and does not block promotion. Issue 08 is the promotion gate and requires 01 through 05.

Current release position is conditional go: discovery-only production is safe to run, and the automated delivery path is incomplete. No issue status below claims production-complete.

## Test seam

All behavior is asserted through one seam: the unified daily run, invoked with configuration, an injected transport, an injected clock, an optional durable store, and ledger rows. Existing prior art is the daily runner test. Do not add seams below it.

## Issues

1. [Route the full scheduled crawl into v5 scoring](./01-route-full-crawl-into-v5-scoring.md)
2. [Make the unified run the scheduled and command entrypoint](./02-make-the-unified-run-the-only-entrypoint.md)
3. [Guarantee complete scoring before selection](./03-guarantee-complete-scoring-before-selection.md)
4. [Report portal lanes honestly and score resolved portal leads](./04-report-portal-lanes-honestly.md)
5. [Populate and consume the v4 history snapshot](./05-populate-and-consume-the-v4-history-snapshot.md)
6. [Make search-lane health observable, then restore the second provider](./06-make-search-lane-health-observable.md)
7. [Report source truncation and reduce scheduled run duration](./07-report-truncation-and-reduce-run-duration.md)
8. [Run the discovery-to-delivery canary and promote](./08-run-the-delivery-canary-and-promote.md)
