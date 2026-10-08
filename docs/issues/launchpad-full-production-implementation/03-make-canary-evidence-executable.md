# Phase 3: make reports, shortfalls, and canary evidence executable

Status: proposed

## Parent

[Launchpad full production implementation plan](../../plans/launchpad-full-production-implementation.md), Phase 3

## What to build

Call `writeDeliveryCanaryReport()` from daily runtime after final delivery reconciliation and before canary validation. Generate matching Markdown and JSON evidence from machine result. Bind run ID, revision, code and config fingerprint, normalized profile, inventory identity, source and funnel counts, reconciliation, transaction result, and Markdown digest.

Add honest shortfall states and a `finalize-shortfall` command. Manual inventory evidence may finalize an immutable `shortfall_pending_review` run, but cannot change machine counters, shortlist, or discovery result.

Required daily states:

```text
completed                  >=5 selected and all gates pass
shortfall_pending_review   0-4 selected, machine accounting complete
completed_shortfall        pending shortfall plus retained manual inventory confirmation
degraded                   any operational or evidence defect
```

## Main paths

- `crawler/canary-report.mjs`
- `crawler/delivery-canary.mjs`
- `crawler/canary-evaluator.mjs`
- `crawler/daily-runner.mjs`
- `crawler/cli.mjs`
- corresponding canary, CLI, report, and daily-runner tests

## Acceptance criteria

- [ ] Daily CLI accepts explicit external `--canary-report-root`, `--canary-log`, and `--notification-log` paths.
- [ ] Every completed live-capable run automatically writes matching Markdown and JSON reports.
- [ ] Missing report pair degrades run.
- [ ] Report digest and inventory identity validate.
- [ ] `finalize-shortfall` updates only existing immutable run evidence and never reruns discovery or changes shortlist.
- [ ] Manual evidence cannot lower or replace machine counters.
- [ ] `shortfall_pending_review` never counts toward promotion.
- [ ] `completed_shortfall` requires all machine gates plus retained manual inventory confirmation.
- [ ] Source, resolver, scorer, report, notification, or reconciliation defects remain `degraded`.
- [ ] Focused tests eliminate missing evidence, wiring-induced degraded outcome, healthy-reported outage mismatch, and undefined scorer counter failures.

## Blocked by

Phase 2. Phase 1 count vocabulary and retained accounting must be stable first.
