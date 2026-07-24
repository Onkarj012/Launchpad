# Crawler v2 board ownership and activation

Date: 2026-07-24

This note records the Phase 3 configuration boundary. It uses only evidence
already present in `job-board-source-audit-2026-07-23.md`. A board is not
enabled merely because an adapter exists or because a provider can serve
public postings.

## Seeded, probe-gated boards

The audit includes official posting examples that identify these board IDs:

| Company | Provider | Board identifier | India/Pune relevance | Enabled | Probe status |
|---|---|---|---|---:|---|
| Blue Altair | Workable | `blue-altair` | India and Pune evidence in the audit example | no | pending |
| Delta Capita | Recruitee | `careersdeltacapita` | India and Pune evidence in the audit example | no | pending |

They are present in `atsBatch1.boards` with `enabled: false`. A future probe
must confirm endpoint reachability, employer ownership, stable provider ID,
and direct application URLs before activation.

## Explicitly unverified Workday TODOs

The audit names Mastercard, Ingram Micro, ReliaQuest and Pitney Bowes as
calibration leads, but does not provide enough tenant/instance/site evidence
to construct a Workday URL safely. They remain disabled TODO records in
`enterprise.disabledBoards`; no tenant, instance, site, or endpoint was
invented.

## Still unseeded

The audit documents the Pinpoint contract and generic career-site discovery,
but contains no verified Pinpoint board identifier or employer career URL.
Those registries therefore remain empty. Their disabled TODO records explain
the evidence gap without affecting crawler execution.

This file changes configuration documentation only. It does not alter shared
eligibility, freshness, liveness, compensation, original-listing, or
deduplication policy.
