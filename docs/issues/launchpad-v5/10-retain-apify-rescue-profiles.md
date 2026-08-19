# Retain optional Indian-portal Apify rescue profiles

Status: locally-complete-live-gated

## Parent

[Launchpad v5 specification](../../spec/launchpad-v5.md)

## User stories covered

32–35, 75

## What to build

Remove Apify from the required daily workflow while retaining a bounded, explicitly invoked rescue path for selected Indian portals whose free structured coverage remains weak. Remove redundant actors for sources with native free interfaces, keep rescue profiles disabled by default, expose expected credit/runtime scope before execution, and preserve actor-level provenance through ingestion.

Actor absence, exhausted credits, schema drift, timeout, or partial failure must remain nonfatal and must never be reported as a successful source run.

## Acceptance criteria

- [ ] Normal, Startup, and Remote modes complete without an Apify token or Apify calls.
- [ ] Redundant Himalayas, Remotive, and We Work Remotely actors are removed from active rescue configuration.
- [ ] Selected Naukri, Foundit, Hirist, Cutshort, Wellfound, or LinkedIn rescue profiles are disabled by default and explicitly selected by stable profile name.
- [ ] Rescue execution reports expected scope, actor status, fetched/prepared/eligible counts, latency, and failure reason.
- [ ] Actor source, label, category, discovery URL, and downstream original application provenance survive preparation.
- [ ] Per-actor failures continue safely; missing credentials or credits produce an honest unavailable result.
- [ ] Tests cover profile selection, duplicate actor IDs, timeout/partial failure, missing token, provenance, and absence from daily mode.

## Blocked by

[03 — Deliver India-first Normal mode end to end](./03-deliver-india-first-normal-mode.md)
