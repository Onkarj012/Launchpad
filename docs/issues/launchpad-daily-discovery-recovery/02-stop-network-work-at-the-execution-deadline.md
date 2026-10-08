# 02 — Stop network work at the execution deadline

**Status:** proposed

## Parent

[Launchpad Daily Discovery Recovery Plan](../../plans/launchpad-daily-discovery-recovery.md)

## Outcome

One execution budget stops actual network activity on time and preserves the downstream reserve needed to return a terminal result.

## What to build

- Keep `createDailyExecution()` as sole execution-budget owner.
- Partition the 20-minute contract into source discovery through minute 12, downstream work through minute 17, and terminal handoff through minute 20.
- Allow unused source time to flow downstream; never allow reserved downstream time to flow back into discovery.
- Pass one parent cancellation signal and absolute deadline through every source wrapper, adapter, retry, page loop, resolver, Workday detail request, and HTTP transport call.
- Check remaining budget between boards, pages, retries, queries, items, and detail requests.
- Treat the outer abort race as a final safety guard, not the cancellation mechanism.
- Persist cursor and source telemetry before returning from interruption.

## Main paths

- `crawler/daily-runner.mjs`
- `crawler/operator.mjs`
- `crawler/run.mjs`
- `crawler/ats-batch-1.mjs`
- `crawler/ats-batch-2.mjs`
- `crawler/ats-enterprise.mjs`
- `crawler/india-startup-lanes.mjs`
- `crawler/brave-search.mjs`
- focused files under `tests/crawler/`

## Acceptance criteria

- [ ] Every adapter and transport path receives the parent signal and absolute deadline.
- [ ] Inner loops stop starting boards, pages, retries, queries, items, and detail requests once budget expires.
- [ ] A hanging transport stops within its deadline plus two seconds.
- [ ] Request count does not increase after cancellation is observed.
- [ ] Active-source cursor and telemetry are durable before the source returns `interrupted`.
- [ ] Untouched planned sources remain explicit as `not_started`.
- [ ] Optional downstream scoring cannot consume the minute 17–20 handoff reserve.
- [ ] Existing per-host spacing, concurrency, retry, and politeness limits remain authoritative.
- [ ] Fatal config, schema, manifest, database, persistence, or safety failures remain `failed`, not `partial`.

## Exit gate

A hanging injected transport stops within deadline plus two seconds, and instrumentation proves no request starts after cancellation.

## Rollback boundary

Disable the new deadline path per source if needed while retaining the parent safety deadline and Phase 01 telemetry.

## Blocked by

[01 — Make run and source state durable](./01-make-run-and-source-state-durable.md)
