# 05 — Make the mode selector the final shortlist owner

**Status:** proposed

## Parent

[Launchpad Daily Discovery Recovery Plan](../../plans/launchpad-daily-discovery-recovery.md)

## Outcome

One funnel and one shortlist authority explain every role transition and produce one coherent completed-run answer.

## What to build

- Keep crawler output focused on durable observations, evidence, source health, verification state, and diagnostic reserve.
- Make the Normal, Startup, or Remote mode selector the sole owner of final scoring, diversity, target count, shortlist, v5 plans, and completed-run opportunity surfacing.
- Consolidate telemetry around `fetched → dated → eligible → ready → scored → selected`.
- Reconcile source coverage, rejection reasons, score state, shortlist counts, v5-plan counts, opportunity surfacing, canary evidence, and notification receipts.
- Make notification and canary behavior status-aware: completed may use existing allowed success paths; partial and failed may not claim success.
- Retain crawler `shortlist` only as a compatibility field until direct callers and fixtures migrate.
- Make zero-role output distinguish gate-driven scarcity from incomplete source coverage.

## Main paths

- `crawler/workflow.mjs`
- `crawler/daily-runner.mjs`
- `crawler/cli.mjs`
- relevant mode selectors and receipt code
- focused files under `tests/crawler/`

## Acceptance criteria

- [ ] Mode selector is the sole final authority for score, diversity, target count, shortlist, v5 plans, and completed-run surfacing.
- [ ] Crawler compatibility `shortlist` does not drive user-facing selection or side effects.
- [ ] Each durable role is accounted for through fetched, dated, eligible, ready, scored, and selected funnel states as applicable.
- [ ] Crawler, mode-selector, v5-plan, opportunity-surfacing, canary, and notification counts reconcile for completed runs.
- [ ] Partial and failed runs create no success canary, success notification, ledger surfacing, or v5 write plan.
- [ ] Completed runs preserve existing no-auto-apply, no-send, manual-checkbox, v5-only, and evidence rules.
- [ ] Nonzero eligible inventory cannot silently produce a zero shortlist without an explicit reason.
- [ ] Empty output names exact rejection reasons when completed or exact incomplete-source coverage when partial.
- [ ] Direct callers and fixtures retain compatibility until migration is explicit.

## Exit gate

Pass reconciled funnel tests where shortlist, v5 plan, surfacing, canary, and notification counts agree, and zero-job output is market-honest.

## Rollback boundary

Retain crawler compatibility fields while keeping mode-selector shortlist authority and status-aware side effects.

## Blocked by

[04 — Plan bounded sources and remove duplicate fetches](./04-plan-bounded-sources-and-remove-duplicate-fetches.md)
