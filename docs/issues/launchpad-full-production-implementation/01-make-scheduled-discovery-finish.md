# Phase 1: make scheduled discovery finish and retain its work

Status: proposed

## Parent

[Launchpad full production implementation plan](../../plans/launchpad-full-production-implementation.md), Phase 1

## What to build

Make scheduled-path Normal/Pune no-write runs finish instead of returning partial with zero shortlist.

1. Recycle actual unused source time while protecting later-source minimum allocations.
2. Add idempotent source checkpoints so cancellation retains observations, cursor, and manifest deltas.
3. Replace sequential portal original-listing resolution with bounded `mapProviderSafe()` batching.
4. Give Workday DETAIL hydration a signal, deadline, request bound, and reserved source allowance.
5. Disable measured dead lanes in the production Normal profile and report unavailable transports as explicit omissions.
6. Use one count vocabulary across telemetry, reports, notifications, and canary evidence.

Do not weaken freshness, eligibility, original-listing, readiness, scoring, or company-diversity gates to hit volume.

## Main paths

- `crawler/deadline.mjs`
- `crawler/run.mjs`
- `crawler/operator.mjs`
- `crawler/ats-enterprise.mjs`
- `crawler/bounded-concurrency.mjs`
- `crawler/original-listing-resolver.mjs`
- `crawler/daily-runner.mjs`
- `crawler/source-yield.mjs`
- `job-pull/workday-enrichment.mjs`
- `job-pull/funnel-report.mjs`
- `job-pull/mode-scoring.mjs`
- `config/crawler-v2.json`
- `config/crawler-v2-dev.json`
- focused tests under `tests/crawler/` and `tests/job-pull/`

## Required production bounds

- Portal target-screen before network resolution.
- Maximum 24 portal candidates and 48 resolver requests per source run.
- Resolver concurrency 3 across providers or hosts, 1 per destination host.
- Resolver time bound 60 seconds or source allowance minus handoff reserve.
- Pune-priority Workday DETAIL hydration starts before broad enumeration exhausts source budget.
- LIST-only and undated rows remain in `VerifyQueue`.

## Acceptance criteria

- [ ] Three consecutive scheduled-path production-config no-write runs reach terminal `completed` discovery and accounting state.
- [ ] Every enabled source completes or has a predeclared planner omission.
- [ ] No source exceeds its runtime allowance.
- [ ] Checkpointed observations survive truncation or cancellation and remain idempotent on replay.
- [ ] Observation, funnel, scorer, and delivery counts balance under the standardized vocabulary.
- [ ] No ready row remains unscored.
- [ ] Median selected count is at least 5, or every lower result has complete shortfall evidence.
- [ ] Ready pool contains at least 10 distinct companies across the three runs.
- [ ] Every selected row has employer URL, Active liveness, verified freshness, accepted eligibility, finite score, and no queue overlap.
- [ ] External side-effect counters remain zero.
- [ ] Focused tests, `npm run validate`, `npm run safety`, `npm test`, `node crawler/cli.mjs readiness --run-tests`, and `git diff --check` pass.

## Stop point

No Notion write, credential read, schedule change, release creation, commit, push, or promotion.

## Blocked by

None. May run in parallel with Phase 0.
