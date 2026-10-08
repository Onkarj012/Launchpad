# 06 — Prove the recovery contract without production activation

**Status:** proposed

## Parent

[Launchpad Daily Discovery Recovery Plan](../../plans/launchpad-daily-discovery-recovery.md)

## Outcome

Deterministic and bounded local evidence proves the recovery contract while production, schedules, credentials, external writes, and release actions remain blocked.

## What to build

- Add focused tests for stable identity, source lifecycle, cancellation, partial safety, resume, source planning, board dedupe, funnel reconciliation, and terminal bounds.
- Keep the whole issue-pack budget at no more than 20 new focused tests.
- Run one final full tracked readiness suite after output-contract consolidation.
- Run three consecutive no-write local-live Normal morning exercises that each return `completed`, `partial`, or `failed` within 20 minutes.
- Run one forced interruption and same-daily-identity resume drill that later completes.
- Retain manifests, terminal envelopes, request/cancellation evidence, source coverage, funnel counts, and proof of zero prohibited operations.
- Update `docs/STATUS.md` only after evidence exists, using exact local-verified wording and preserving every live or production gate.

## Main paths

- `tests/crawler/*.test.mjs`
- local no-write evidence paths already used by crawler readiness tooling
- `docs/STATUS.md` after proof

## Acceptance criteria

- [ ] No more than 20 new focused tests were added across tickets 01–06.
- [ ] Focused tests cover identity, resume, source-state completeness, real cancellation, terminal envelope, partial safety, board ownership, planner reasons, funnel reconciliation, and market-honest empty output.
- [ ] One final full tracked readiness run passes after output-contract consolidation.
- [ ] Full-suite evidence reports nonzero test inventory and does not pass on an empty or zero-test run.
- [ ] Three consecutive no-write local-live runs each emit a terminal status within 20 minutes.
- [ ] Three-run evidence retains source manifests, selection reasons, ready yield, rejection or incomplete-coverage reasons, and request counts.
- [ ] One forced interruption resumes under the same daily identity and later completes without duplicate observations.
- [ ] Partial-run evidence proves zero opportunity-ledger, v5, application, outreach, checkbox, send, surfacing, success-canary, success-notification, or other external operation.
- [ ] No targeting, scoring, freshness, evidence, or safety policy test was weakened to make the suite pass.
- [ ] `docs/STATUS.md` distinguishes local-verified evidence from unperformed credentialed, elapsed-time, release, and production gates.
- [ ] No schedule installation, production config activation, live write, credential operation, commit, push, pull request, promotion, or rollback occurred as part of this ticket.

## Exit gate

Three terminal no-write runs complete within 20 minutes, one partial-to-completed resume drill succeeds, prohibited-operation count remains zero, and one final full tracked suite passes with nonzero inventory.

## Stop point

Stop at local proof. Commit, push, pull request, launchd installation, production config activation, credentialed smoke, live write, release promotion, and rollback drill each require separate explicit authorization.

## Blocked by

[05 — Make the mode selector the final shortlist owner](./05-make-the-mode-selector-the-final-shortlist-owner.md)
