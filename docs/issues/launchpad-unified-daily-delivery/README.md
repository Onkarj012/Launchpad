# Launchpad unified daily delivery historical issue pack

Parent specification: [Launchpad Unified Daily Delivery](../../spec/launchpad-unified-daily-delivery.md)

This directory preserves the older local **01–08** unified-delivery issue pack. These numbers are not LP-001–LP-019. The files are specifications/history, not the live status authority. GitHub owns live issue state, and [../../STATUS.md](../../STATUS.md) is the sole repository execution-status index.

## Historical dependency order

```text
01 → 02 ──────────────┐
 ├── 03 ──────────────┤
 ├── 04 ──────────────┤
 ├── 05 ──────────────┘→ 08
 └── 07

06 (independent)
```

The unified daily path is now locally implemented in the current dirty working tree and is stabilizing behind live gates. This is **not** a conditional-go, production-safe, production-ready, or promoted claim. The fail-closed canary still requires clean same-version evidence and seven consecutive valid runs.

## Test seam

Unified behavior is asserted at the daily-run boundary with injected configuration, transport, clock, durable state, and ledger rows. Local deterministic evidence does not replace production-shadow evidence.

## Issues

1. [Route the full scheduled crawl into v5 scoring](./01-route-full-crawl-into-v5-scoring.md)
2. [Make the unified run the scheduled and command entrypoint](./02-make-the-unified-run-the-only-entrypoint.md)
3. [Guarantee complete scoring before selection](./03-guarantee-complete-scoring-before-selection.md)
4. [Report portal lanes honestly and score resolved portal leads](./04-report-portal-lanes-honestly.md)
5. [Populate and consume the v4 history snapshot](./05-populate-and-consume-the-v4-history-snapshot.md)
6. [Make search-lane health observable, then restore the second provider](./06-make-search-lane-health-observable.md)
7. [Report source truncation and reduce scheduled run duration](./07-report-truncation-and-reduce-run-duration.md)
8. [Run the discovery-to-delivery canary and promote](./08-run-the-delivery-canary-and-promote.md)
