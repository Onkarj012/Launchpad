---
name: morning
description: Run the Launchpad v5 daily discovery handoff. No mode argument means Normal; `/morning startup` and `/morning remote` select the focused modes. Discovery is explicit and never auto-applies, sends, or invokes LinkedIn rescue.
disable-model-invocation: true
---

# Morning

`/morning` defaults to Normal. The only focused variants are `/morning startup` and `/morning remote`; all three use the same immutable eligibility, freshness, readiness, scoring, deduplication, shortfall, and v5 transaction contracts.

Use the corresponding public runner: `runNormalMode()` from `job-pull/normal-mode.mjs`, `runStartupMode()` from `job-pull/startup-mode.mjs`, or `runRemoteMode()` from `job-pull/remote-mode.mjs`. Every source lane must be represented in telemetry. A source failure degrades coverage; policy, readiness, scoring, deduplication, manifest, or ledger failure stops before any live plan.

Report application-ready roles first, then labelled backfill and the verification queue. The target is minimum 10, preferred 12, maximum 20. If the verified pool is materially short, suggest `/linkedin-leads` but do not run it. Internship records remain in the dedicated Internship category and do not weaken the full-time lane.

Live writes, if explicitly authorized later, may target only the declared Applications v5 and Companies v5 relations through the scoped gateway. `Make Resume` and `Applied?` remain user-owned. Never apply, send, connect, message, or fall back to a legacy tracker.
