# Phase 5: make resume and sync commands work against live v5

Status: proposed

## Parent

[Launchpad full production implementation plan](../../plans/launchpad-full-production-implementation.md), Phase 5

## What to build

Add guarded live v5 entrypoints for existing resume-queue and application-sync implementations:

```text
node launchpad-v5.mjs make-applications \
  --credential-file ABS_PATH \
  --journal ABS_PATH

node launchpad-v5.mjs sync \
  --credential-file ABS_PATH \
  --journal ABS_PATH
```

Reuse `processMakeResumeQueue()`, `createLocalResumeBuilder()`, `verifyResumeArtifact()`, `syncAppliedApplications()`, scoped v5 gateway behavior, and journal reservations. Both commands query v5-only stores and print redacted receipts.

## Main paths

- `launchpad-v5.mjs`
- existing resume queue and local builder modules
- existing application sync modules
- `notion-v5/gateway.mjs`
- `notion-v5/transaction.mjs`
- resume, gateway, sync, and command tests

## Acceptance criteria

- [ ] Both commands require safe absolute credential and journal paths.
- [ ] Both commands query declared v5 stores only and never fall back to v3/v4.
- [ ] Onkar-checked `Make Resume` pilot row produces `.tex`, `.matrix.md`, `.provenance.md`, and one-page `.pdf` artifacts.
- [ ] Resume passes `node tests/resume/verify.mjs`, frozen-template, provenance, one-page, and page-fill checks.
- [ ] Resume command updates only derived `resumeState`; it never changes `Make Resume`.
- [ ] After manual submission and Onkar checking `Applied?`, first sync updates derived state and creates one deterministic Activity row.
- [ ] Second sync is a noop.
- [ ] Applied timestamp remains stable and opportunity stops resurfacing.
- [ ] Sync never changes `Applied?` or `Make Resume`.
- [ ] Launchpad sends no application, email, DM, or message.

## Stop point

No installed schedule or promotion change.

## Blocked by

Phase 4 one-row pilot and exact replay proof. User checkbox changes and application submission remain manual.
