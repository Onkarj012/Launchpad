# Launchpad unified daily delivery canary

This is an operator procedure, not a promotion claim. Ticket 08 remains blocked on repo-owner mornings until the production-shadow observations and manual comparisons below exist.

## One-time offline check

From the repository root, run:

```sh
node crawler/safety-contract.mjs
```

The command must report `passed: true`. Do not proceed with a canary day if it fails.

## Each morning

Run the unified entrypoint with a stable date-based run ID and the persistent plain-JSON canary log:

```sh
node crawler/cli.mjs daily morning --env production --run-id "morning-$(date +%F)" --canary-log logs/delivery-canary.json
```

Then print the recorded day-over-day report:

```sh
node crawler/delivery-canary.mjs compare --log logs/delivery-canary.json
```

For the daily record, verify and retain:

- eligible count, scored-pool count, ready count, and shortlist count;
- every funnel delta and its attribution: historical suppression, readiness, company cap, diversity, shortfall, or explicit unattributed;
- source/run outcome, scoring completeness, and any failed or empty lane;
- the exact strict application-ready shortlist URLs used for the manual comparison;
- the v4 history snapshot status and, when it changes from missing to loaded, the recorded shortlist before and after sizes.

The recorder writes no seeded or invented run. A missing snapshot is the baseline; after the owner populates the snapshot, the next loaded run records the before/after shortlist sizes with the note that an expected drop is the snapshot working, not a regression.

## Promotion bar

Promotion is allowed only after two consecutive valid production-shadow mornings where:

1. the automated strict application-ready roles exactly match the careful manual review of the same inventory;
2. every delta is attributed to one of the named causes, with no `unattributed` amount;
3. the safety-contract check passes and the full suite is green;
4. no live write, auto-apply, autonomous send, or user-checkbox change occurred.

A day is disqualified by a missing canary record, duplicate or non-reproducible run identity, incomplete scoring, a failed safety check, an unattributed delta, a manual-review mismatch, a missing inventory comparison, or any consequential action outside discovery and planning. Repeat the observation window; do not promote from a disqualified day.

The repo owner decides whether the release position changes. This procedure does not update a production-complete status.
