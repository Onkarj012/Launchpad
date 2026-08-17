# Launchpad unified daily delivery canary

Status: executable fail-closed procedure; no qualifying streak or promotion is claimed. The implementation is locally stabilizing and remains live-gated. See [STATUS.md](STATUS.md).

Historical invalid records remain invalid. Do not seed, edit, reinterpret, or omit evidence to create a streak.

## Preconditions

A canary day may begin only from the exact clean checkout being evaluated:

- nonempty committed revision;
- clean working tree and empty dirty-path list;
- one declared code/config version retained for the streak;
- exact branch/worktree or checkout identity recorded in the report pair;
- local validators and the required deterministic suite green;
- no live write, auto-apply, autonomous send, authenticated LinkedIn action, or user-checkbox change.

The current dirty working tree cannot produce a valid canary record.

Run the safety contract before each observation window:

```sh
node crawler/safety-contract.mjs
```

It must report `passed: true`.

## Matching evidence file

Before the run, prepare a JSON evidence file for that exact run. It must use the run ID and code/config version the command will record and include at least:

- recognized matching `runId` and `codeConfigVersion`;
- nonempty revision;
- clean checkout/worktree evidence and empty dirty paths;
- complete Markdown and JSON report paths;
- `reportComplete: true`;
- `manualInventoryMatch: true` only after careful review of the same inventory;
- engineering counters required by the evaluator, including zero fatal scorer-infrastructure failures, source outages reported healthy, selected suppressed roles, roles surfaced before commit, duplicate requisition collisions, and unattributed funnel loss.

The Markdown report and JSON sidecar must retain the manual inventory, automated shortlist, URL-by-URL comparison, revision, checkout identity, code/config version, funnel counts, attribution, source health, runtime, and safety evidence. A bare Boolean is not sufficient operator evidence even where the machine contract consumes one.

## Daily command

Use a stable unique run ID, the persistent canary log, and the matching evidence file:

```sh
RUN_ID="morning-$(date +%F)"
node crawler/cli.mjs daily morning \
  --env production \
  --mode normal \
  --location-preset pune \
  --run-id "$RUN_ID" \
  --canary-log logs/delivery-canary.json \
  --canary-evidence "logs/canary-evidence/${RUN_ID}.json"
```

A missing, malformed, mismatched, incomplete, or dirty-checkout evidence file makes the run invalid.

## Daily review

Print the day-over-day comparison:

```sh
node crawler/delivery-canary.mjs compare --log logs/delivery-canary.json
```

Retain and inspect:

- eligible, scored-pool, ready, shortlist, verification, and scoring-queue counts;
- every funnel delta and named attribution;
- source outcomes, failed/degraded/empty lanes, and any false healthy report;
- strict application-ready URLs and manual review of the same inventory;
- suppression, cooldown, duplicate requisition, and pre-commit surfacing evidence;
- report-pair completeness, revision, clean checkout, version, and runtime;
- history-snapshot status and any explainable before/after shortlist change.

## Evaluator

Run the promotion evaluator after recording/reviewing the day:

```sh
node crawler/delivery-canary.mjs evaluate --log logs/delivery-canary.json
```

The command exits nonzero unless every executable gate passes.

## Promotion bar

Promotion may be recommended only after **seven consecutive valid runs** that all:

1. use the same code/config version;
2. come from a clean committed checkout with retained revision and checkout identity;
3. have matching recognized evidence and complete Markdown/JSON report pairs;
4. match careful manual review of the exact same inventory;
5. have zero fatal scorer-infrastructure failures;
6. have zero source outages incorrectly reported healthy;
7. select zero suppressed roles;
8. surface zero roles before final-shortlist commit;
9. have zero duplicate requisition collisions;
10. have zero unattributed funnel loss;
11. satisfy the evaluator's runtime and safety gates;
12. perform no consequential action outside discovery/planning.

Any invalid record breaks the consecutive streak. A code/config version change starts a new streak. Historical invalid logs do not become valid after implementation changes.

The evaluator can recommend; the repo owner decides whether to promote. No commit, push, live Notion smoke, production streak, or production promotion is claimed by this runbook.
