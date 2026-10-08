# Phase 2: close LP-009 and improve employer-direct diversity

Status: proposed

## Parent

[Launchpad full production implementation plan](../../plans/launchpad-full-production-implementation.md), Phase 2

## What to build

Wire existing path-based career-page classification into runtime company-career discovery. Match career and job evidence against pathname and page content, reject static assets before queue insertion, and keep one shared classifier.

Activate one verified Pune employer-direct source. Start with Birlasoft job sitemap or a bounded Cybage adapter, whichever passes live no-write verification first. Preserve robots rules, host spacing, request and deadline caps, original-listing evidence, and `VerifyQueue` behavior.

## Main paths

- `crawler/company-careers.mjs`
- `crawler/career-page-discovery.mjs`
- `crawler/workflow.mjs`
- `config/crawler-v2.json`
- `tests/crawler/career-page-discovery.test.mjs`
- company-career tests

## Acceptance criteria

- [ ] Runtime matches career and job patterns against pathname and page evidence, never hostname substring alone.
- [ ] Static extensions and static content types cannot enter candidate queue.
- [ ] Queue insertion requires verified job URL pattern, `JobPosting` JSON-LD, job sitemap evidence, or source-specific adapter evidence.
- [ ] Duplicate URL classification implementations are removed where safe, leaving one shared classifier.
- [ ] One Pune employer-direct source is enabled in production config.
- [ ] At least one retained Pune role reaches normalized funnel with original employer URL and usable date evidence.
- [ ] Source cannot make Normal morning run partial.
- [ ] Zero yield and failures produce explicit telemetry.
- [ ] Phase 1 scheduled-path shadows still pass after source activation.

## Stop point

Do not add Crawlee or Firecrawl. Do not write live v5 state or change installed schedule.

## Blocked by

Phase 1 scheduled discovery contract.
