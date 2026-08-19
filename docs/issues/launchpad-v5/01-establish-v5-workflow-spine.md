# Establish the fixture-driven v5 workflow spine

Status: locally-complete-live-gated

## Parent

[Launchpad v5 specification](../../spec/launchpad-v5.md)

## User stories covered

69–77

## What to build

Create the smallest complete v5 orchestration path without live Notion writes. A caller can choose Normal, Startup, or Remote mode, supply fixture-backed source results and an injected clock, run the shared policy pipeline, and receive one stable operator-facing result containing the selected shortlist, verification queue, source telemetry, shortfall explanation, planned Notion operations, and fatal/degraded status.

The same orchestration boundary must support a fake Notion gateway for tests and the later live gateway without embedding connector-specific behavior. Preserve existing normalization, eligibility, deduplication, scoring, selection, and ledger behavior unless the v5 contract explicitly supersedes it.

## Acceptance criteria

- [ ] The public orchestration accepts Normal, Startup, and Remote modes, with Normal as the default.
- [ ] A fixture-backed run produces a deterministic shortlist, verification queue, source manifests, shortfall report, and planned write set without network or Notion access.
- [ ] The workflow distinguishes nonfatal source degradation from fatal policy, readiness, deduplication, scoring, ledger, or manifest failures.
- [ ] The Notion boundary is injected and can be replaced by a fake implementation at the high-level workflow test seam.
- [ ] No live database is created or mutated by this slice.
- [ ] Existing job-pull tests continue to pass, and a new high-level workflow test demonstrates the complete no-write path.

## Blocked by

None - can start immediately
