# Deliver India-first Normal mode end to end

Status: locally-complete-live-gated

## Parent

[Launchpad v5 specification](../../spec/launchpad-v5.md)

## User stories covered

1–15, 20–24, 29–35, 73–76

## What to build

Make the default morning workflow produce a trustworthy India-first daily shortlist and write it transactionally to v5. Normal mode combines tracked employer ATS boards, the warm reverse ATS scan, bounded discovery across Indian job portals, the connected Indeed source when available, selected native public feeds, and targeted employer-career searches.

Every portal, search, connector, or feed result remains provisional until its original employer application is resolved and its current liveness, freshness, experience, location, citizenship, employment, fee/bond, and company evidence pass. Selection must target at least 10, prefer 12, accept up to 20 strong roles, and use the agreed freshness-and-fit bands and relaxation waterfall without hard family/source quotas.

## Acceptance criteria

- [ ] Running morning with no mode argument executes Normal mode and records the run mode in output and v5.
- [ ] Normal mode attempts direct ATS/watchlist, warm reverse ATS, Indian portal searches, Indeed when connected, and the agreed native feeds, reporting per-source success and failure.
- [ ] Portal/search results cannot enter Ready output until an original employer or ATS application is resolved and active.
- [ ] The selection result uses minimum 10, preferred 12, maximum 20; strong same-family inventory is not discarded to satisfy diversity quotas.
- [ ] Ranking implements the agreed ≤24-hour, 24–72-hour, 3–7-day, fit-score, and relaxed-backfill bands.
- [ ] Full-time salary is informational rather than a hard eligibility floor.
- [ ] Pune-metro onsite/hybrid, global remote eligibility, hard 3+ years, unstable work, citizenship exclusions, fees, bonds, and hidden description requirements are classified from evidence.
- [ ] Verified Ready and labelled Backfill rows are written through reserve → write → verify → commit; unresolved roles appear in Needs Verification and never count toward ten.
- [ ] A shortfall writes the valid rows, explains the missing count and failed lanes, and suggests LinkedIn rescue when materially short.
- [ ] Individual source failure is nonfatal; core policy or integrity failure stops before live writes.
- [ ] The highest-level fixture/fake-gateway test demonstrates a complete successful Normal run and a fatal pre-write failure.

## Blocked by

[01 — Establish the fixture-driven v5 workflow spine](./01-establish-v5-workflow-spine.md); [02 — Provision Notion v5 through the scoped local gateway](./02-provision-notion-v5-gateway.md)
