# Launchpad Unified Daily Delivery

Status: locally implemented in the current dirty working tree; stabilizing and live-gated. This is not a production-ready or promotion claim. See [../STATUS.md](../STATUS.md).

## Purpose

Launchpad needs one reproducible daily execution path that turns the schedule-appropriate shared crawl into a truthful, scored, mode-specific shortlist without weakening policy or introducing consequential automation.

The implemented command contract is:

```sh
node crawler/cli.mjs daily morning|midday \
  --mode normal|startup|remote \
  --location-preset india|pune \
  --run-id <unique-id>
```

`/morning` delegates to this path. Local launchd generation/install support may invoke it, but installed state and production operation require separate evidence.

## Implemented architecture

The daily runner performs one shared crawl and then invokes the requested mode selector:

1. Build the schedule/mode/location-aware source plan.
2. Execute the shared crawler inventory and collect source telemetry.
3. Merge tracked ATS and shared observations into the v5 source-lane shape.
4. Run shared normalization, eligibility, readiness, opportunity-ledger suppression, historical identity suppression, and scoring policy.
5. Invoke Normal, Startup, or Remote ranking/selection.
6. Return one operator result and surface only the final selected shortlist to the local opportunity ledger.
7. Keep v5 writes as plans by default; any live transaction remains a separate explicitly authorized path.

Midday uses the cheaper delta plan. Midday Remote deliberately skips native remote-feed fetching and selects from shared ATS/delta inventory. Morning Remote may include native remote feeds.

## Policy invariants

- Normal, Startup, and Remote share the same hard gates and application-readiness boundary.
- `india` and `pune` change source emphasis/query hints, not truth or safety rules.
- Workday freshness trusts a usable DETAIL `startDate`; LIST `postedOn` remains undated and enters `VerifyQueue`.
- Opportunity-ledger action/cooldown/backfill suppression happens before mode selection.
- Crawler SQLite owns observation/novelty/source state, not cooldown surfacing policy.
- A selected row must have application readiness and a usable finite `0–100` score.
- A missing scorer with unscored rows or broken scorer infrastructure is fatal. Bounded per-row scoring failures from a functioning scorer stay queued and degrade the run.
- Only the final mode shortlist may be surfaced. Pre-selection candidates, verification rows, scoring-queue rows, and suppressed opportunities are not surfaced.
- No auto-apply, autonomous sending, automatic user-checkbox changes, authenticated LinkedIn automation, or legacy fallback is introduced.

## Source and lane behavior

The shared crawl retains per-source telemetry and provider provenance. Resolved portal/search leads may enter scoring only after they resolve to a direct employer or ATS destination. Unresolved leads remain verification-only.

Optional lanes must still report real failures; optional does not mean silent. Empty, unavailable, degraded, and failed outcomes remain distinguishable. Truncation, cap, and duration telemetry should be preserved where the source exposes it.

Mode-specific selection occurs after the shared gates:

- **Normal:** India-first/Pune-aware strict and shortage-fallback waterfall.
- **Startup:** startup/company-signal emphasis over the same eligible scored pool.
- **Remote:** explicit India-compatible remote evidence and remote-specific ranking.

## Historical state

Launchpad v5 is current. v3/v4 are historical read-only systems. A bounded v4 snapshot may supply identity/suppression evidence, but nothing writes to, migrates, archives, deletes, or falls back to v3/v4.

## Acceptance contract

Local implementation is acceptable only while the following remain true:

- CLI arguments propagate schedule, mode, and location preset into the daily runner.
- One shared crawl feeds the requested selector.
- Midday Remote does not launch native remote feeds.
- Shared policy/readiness/scoring gates precede mode-specific selection.
- Opportunity-ledger suppression precedes selection.
- Only the final shortlist is surfaced.
- Source/lane telemetry and honest shortfall evidence remain visible.
- No external consequential action occurs by default.
- v5 manifest and safety contracts validate locally.

These criteria establish local implementation, not live readiness.

## Verification and release gate

Deterministic readiness spans:

- `tests/crawler/*.test.mjs`
- `tests/job-pull/*.test.mjs`
- `tests/notion-v5/*.test.mjs`
- `tests/resume-v5/*.test.mjs`
- `tests/outreach-v5/*.test.mjs`
- `tests/v5/*.test.mjs`

Do not turn historical passing counts into a current baseline without dated run evidence.

Production promotion is a separate fail-closed canary gate. A valid canary run needs matching evidence for the exact run ID and code/config version, a nonempty revision, a clean checkout with no dirty paths, complete Markdown and JSON reports, manual review of the same inventory, and all engineering zero gates. The evaluator requires **seven consecutive valid runs for one code/config version**. Any invalid run or version change resets the current streak.

The current repository state has no qualifying production streak and no promotion.

## Out of scope

- changing eligibility, freshness, liveness, geography, seniority, employment, score, or suppression policy to force volume;
- enabling live Notion writes, auto-apply, autonomous outreach, Gmail/LinkedIn sending, or automatic checkbox changes;
- claiming a scheduler installation from installer code/tests;
- migrating or mutating v3/v4;
- enabling paid rescue by default;
- changing the frozen resume template or approved resume evidence.

## Historical context

The original version of this specification documented a July 2026 gap between full discovery and zero automated delivery, including dated inventory counts and a proposed Normal-only bridge. Those observations are preserved in repository history and related reports, but they are not current execution status. The working-tree implementation now exposes the unified schedule/mode/location-aware path described above; live proof remains open.
