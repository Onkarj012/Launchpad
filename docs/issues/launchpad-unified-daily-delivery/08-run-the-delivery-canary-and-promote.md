# Run the discovery-to-delivery canary and promote

Status: proposed

## Parent

[Launchpad Unified Daily Delivery](../../spec/launchpad-unified-daily-delivery.md)

## User stories covered

29, 30, 31, 37, 41

## What to build

Prove the unified run over consecutive days before calling the workflow production-complete.

The current release position is a conditional go: discovery-only production is safe, and the full end-to-end workflow is not ready. Promotion should be earned by repeated observed behavior, not by one good run.

Run the unified daily run in production shadow for several consecutive mornings. Each day, compare the crawl's eligible count, the scored pool size, and the shortlist size, and require every delta to be explainable by a named cause — historical suppression, readiness, company cap, diversity, or shortfall. Record the shortlist size before and after the history snapshot is populated, since the expected drop is the snapshot working rather than a regression.

Promote when the automated run returns the strict application-ready roles that a careful manual review of the same inventory finds, on two consecutive days, with the full test suite green and every safety contract intact.

## Acceptance criteria

- [ ] The unified run executes on the production schedule in shadow for several consecutive mornings.
- [ ] Each day records eligible, scored, ready, and selected counts with every delta attributed to a named cause.
- [ ] Shortlist size before and after snapshot population is recorded and explained.
- [ ] The automated run returns the strict application-ready roles manual review finds, on two consecutive days.
- [ ] The full existing suite passes, with the pre-change baseline of 474 tests as the floor.
- [ ] Discovery-only scheduling, no auto-apply, no autonomous sending, no automatic user-checkbox changes, no fabricated evidence, and no legacy fallback are all verified intact.
- [ ] The release position is updated from conditional go to production-complete, or the blocking cause is recorded.

## Blocked by

[01 - Route the full scheduled crawl into v5 scoring](./01-route-full-crawl-into-v5-scoring.md), [02 - Make the unified run the scheduled and command entrypoint](./02-make-the-unified-run-the-only-entrypoint.md), [03 - Guarantee complete scoring before selection](./03-guarantee-complete-scoring-before-selection.md), [04 - Report portal lanes honestly and score resolved portal leads](./04-report-portal-lanes-honestly.md), [05 - Populate and consume the v4 history snapshot](./05-populate-and-consume-the-v4-history-snapshot.md)
