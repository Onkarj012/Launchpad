# Phase 8: promote the live morning schedule and prove rollback

Status: proposed

## Parent

[Launchpad full production implementation plan](../../plans/launchpad-full-production-implementation.md), Phase 8

## What to build and operate

Extend `buildAgentPlist()` and release manager with explicit live-delivery path options. Only morning Normal/Pune agent receives live flags. Midday live agent stays absent. Working directory and CLI path point at immutable release. Logs, credential file, journal, canary reports, canary log, and notification log stay outside release checkout.

Run promotion dry-run first. After explicit approval, install candidate, observe first scheduled live run, dry-run rollback, execute rollback after separate approval, verify prior no-write schedule, then restore live candidate through normal promotion path.

## Main paths

- `crawler/install-schedule.mjs`
- `crawler/release-manager.mjs`
- `crawler/cli.mjs`
- `crawler/schedule-health.mjs`
- schedule and release tests

## Required morning flags

```text
--execute-writes
--credential-file ABS_PATH
--journal ABS_PATH
--canary-report-root ABS_PATH
--canary-log ABS_PATH
--notification-log ABS_PATH
```

## Acceptance criteria

- [ ] Dry-run prints complete plist and bootstrap plan without changing OS state.
- [ ] Only morning Normal/Pune agent receives live-delivery flags.
- [ ] Installed agent points only at immutable checkout and external state paths.
- [ ] Release receipt records argument fingerprint and delivery mode.
- [ ] First scheduled live run ends completed or finalized shortfall, writes expected v5 rows, produces report pair and notification receipt, and leaves no journal recovery.
- [ ] User-owned fields remain unchanged before and after run.
- [ ] Rollback restores previous recorded no-write schedule and boots successfully.
- [ ] Re-promotion restores candidate release through normal promotion path.
- [ ] Promotion, rollback, `launchctl print`, first-run, and restoration receipts are retained.
- [ ] Current release receipt, installed plist, and schedule-health report agree.

## Blocked by

Phase 7 seven-date immutable canary. Promotion, rollback, and re-promotion each require explicit approval.
