# Guarantee complete scoring before selection

Status: proposed

## Parent

[Launchpad Unified Daily Delivery](../../spec/launchpad-unified-daily-delivery.md)

## User stories covered

10, 11, 29

## What to build

Make it impossible for selection to operate over an incompletely scored candidate pool, and make the counts between eligible and selected reconcile every run.

Selection already reports scored, unscored, and scoring-failed counts, and company-cap and diversity selection already require a Match Score. What is missing is a gate: a run today can report a shortlist while its own counts show unscored or scoring-failed candidates in the pool. With full inventory now feeding the pipeline, a partially scored pool is far more likely and far less visible.

Add an explicit gate that fails the run when unscored or scoring-failed counts are nonzero, rather than returning a shortlist selected from a partial pool. Verify that run-level maximum and minimum totals apply after scoring rather than truncating the pool before it; a cap operating before scoring is a scoring-order defect and must be corrected, not configured around.

Report the reconciliation between eligible, scored, ready, and selected so that any drop between discovery and delivery is attributable line by line.

## Acceptance criteria

- [ ] A run whose pool contains an unscored eligible candidate fails explicitly instead of returning a shortlist.
- [ ] A run whose pool contains a scoring failure fails explicitly with the failure surfaced.
- [ ] Run-level maximum totals do not remove candidates before Match Score is assigned.
- [ ] Every selected role carries a Match Score and the required scoring dimensions.
- [ ] Run output reconciles eligible, scored, ready, and selected counts, and any delta is attributable to a named cause.
- [ ] Existing selection and scoring tests pass unchanged.

## Blocked by

[01 - Route the full scheduled crawl into v5 scoring](./01-route-full-crawl-into-v5-scoring.md)
