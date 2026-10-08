# Phase 9: close LP-010 and LP-011 after useful production

Status: proposed

## Parent

[Launchpad full production implementation plan](../../plans/launchpad-full-production-implementation.md), Phase 9

## What to build

Close LP-010 with one default-off source-specific HTTP-first Crawlee worker behind the custom-career adapter seam. Keep direct ATS adapters unchanged. Browser fallback must be host-allowlisted and bounded by deadline, pages, requests, memory, and concurrency. Output uses existing observation shape and original-listing gates.

Investigate LP-011 only after retaining measured pages where direct HTTP and bounded Crawlee both fail. If no measured need exists, keep LP-011 blocked and record that evidence. If needed, add default-off Firecrawl rescue for public unauthenticated allowlisted pages with daily page or credit ceiling, evidence validation, original-listing checks, and circuit breaker behavior.

## Main paths

- custom-career adapter seam
- company-career source modules
- production and development source config
- source telemetry and original-listing modules
- focused Crawlee or Firecrawl tests added only when evidence triggers work

## Acceptance criteria

- [ ] Crawlee worker exists only behind custom-career seam and defaults off.
- [ ] Direct ATS adapters remain unchanged.
- [ ] Browser fallback enforces host allowlist, deadline, page, request, memory, and concurrency limits.
- [ ] Selector and schema failures produce explicit telemetry.
- [ ] Output uses existing observation shape and passes original-listing gates.
- [ ] Normal morning profile keeps Crawlee off until benchmark proves net useful employer-direct yield without partial runs.
- [ ] LP-011 has retained measured direct-HTTP and Crawlee failure evidence before implementation starts.
- [ ] If Firecrawl is implemented, it defaults off, handles only public unauthenticated allowlisted pages, enforces daily cost bounds, validates extraction against fetched evidence, and cannot block healthy sources.
- [ ] If measured need does not exist, LP-011 remains blocked with recorded evidence instead of unused paid infrastructure.

## Blocked by

Phase 8 initial working production and Phase 2 LP-009 evidence. LP-011 additionally depends on measured LP-010 and direct-HTTP failure evidence.
