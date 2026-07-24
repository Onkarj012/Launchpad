# Route the full scheduled crawl into v5 scoring

Status: proposed

## Parent

[Launchpad Unified Daily Delivery](../../spec/launchpad-unified-daily-delivery.md)

## User stories covered

1–8, 33, 34, 35, 39, 40

## What to build

Make the daily bridge run crawl the full configured source registry and route every observation it produces into the Normal source-lane contract, so that all discovered inventory reaches v5 scoring instead of a warm-ATS slice.

Remove the narrowing the bridge applies to configuration before crawling. It currently zeroes the expanded ATS batches, enterprise boards, career sites, search providers, connector inboxes, startup lanes, and commercial rescue before handing configuration to the crawl operator. After this change the bridge crawls what the scheduled crawler crawls today, with durable state, idempotency, novelty semantics, and funnel telemetry unchanged.

Introduce one explicit mapping from crawler source identifier to Normal source lane. Warm ATS maps to the existing reverse-warm lane, remote-mode output to the existing native remote feed lane, and Indeed connector output to the existing Indeed lane. Add four new lanes for families that have none: expanded ATS covering both batch and enterprise boards, structured career pages, web discovery covering search, startup, YC, and VC portfolio output, and the generic connector inbox.

Declare every new lane optional. Group observations by originating source identifier, merge that source's telemetry and failures into the lane manifest, and derive lane status using the rules the bridge already applies to warm ATS. Optional status must suppress false degradation without suppressing real failure reporting: lane errors are still populated from actual crawler failures.

Bound the candidate enrichment that runs across the flattened candidate set of every lane. It is currently unbounded, which was harmless against a warm-only pool and is a runtime and request-budget risk against full inventory.

## Acceptance criteria

- [ ] The daily run crawls the full configured registry; no source family is disabled by the runner before the crawl.
- [ ] Expanded ATS, enterprise Workday, career page, remote feed, and web discovery observations each appear in the correct Normal lane manifest and in the scored candidate pool.
- [ ] Warm ATS, tracked ATS, remote feed, and Indeed lane behavior is unchanged for inputs that previously reached them.
- [ ] Every new lane is optional and does not mark run outcome degraded when it has no configured source.
- [ ] A crawler failure in a new lane still surfaces that lane's errors and its degraded or failed status.
- [ ] Observations pass through the lane boundary on the existing candidate schema contract, with no new normalization path introduced.
- [ ] Candidate enrichment observes an explicit request budget consistent with the crawl's existing detail-hydration budget.
- [ ] Re-running the same run identifier against the same durable store does not duplicate observations or re-deliver surfaced roles.
- [ ] A run in which one source lane fails still delivers from the remaining lanes.
- [ ] Nonzero eligible inventory produces a nonzero shortlist; the reported zero-shortlist-from-nonzero-eligible condition has explicit regression coverage.
- [ ] All existing tests pass unchanged; no policy test required edits.

## Blocked by

None - can start immediately
