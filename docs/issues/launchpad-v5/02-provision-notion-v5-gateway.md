# Provision Notion v5 through the scoped local gateway

Status: locally-complete-live-gated

## Parent

[Launchpad v5 specification](../../spec/launchpad-v5.md)

## User stories covered

41–50, 69–74

## What to build

Deliver a complete synthetic record path through a new Notion v5 system. Create Applications v5, Companies v5, Outreach v5, Activity v5, and Referrals v5 with coherent relations, compact operating properties, evidence properties, and the agreed focused views. Record their identifiers in a versioned manifest consumed by one local agent-independent gateway.

The gateway must store credentials outside the repository, refuse undeclared or legacy database identifiers, support pagination and rate-limit handling, and prove reserve → write → verify → commit with a synthetic candidate and company relation. V3 and v4 must remain untouched.

## Acceptance criteria

- [ ] All five v5 databases exist with their agreed responsibilities and valid reciprocal relations.
- [ ] Applications exposes the agreed operating fields, evidence fields, manual checkboxes, lifecycle statuses, resume states, employment categories, selection tiers, and relaxation evidence.
- [ ] The agreed Ready, Backfill, Internship, Startup, Remote, Verification, Resume, Applied, Outreach, Follow-up, Pipeline, and Archive views exist and filter the intended fields.
- [ ] A checked-in manifest contains only v5 identifiers, and the gateway rejects v3, v4, unknown, or undeclared targets.
- [ ] Credentials are loaded from an external protected location and never written to source control or command output.
- [ ] A synthetic company and application can be reserved, written, fetched, relation-verified, and committed; an injected failure aborts cleanly.
- [ ] Contract tests cover property mapping, pagination, retries, deterministic company find-or-create, relations, scope refusal, and structured errors.
- [ ] No historical application data is migrated, archived, corrected, or deleted.

## Blocked by

[01 — Establish the fixture-driven v5 workflow spine](./01-establish-v5-workflow-spine.md)
