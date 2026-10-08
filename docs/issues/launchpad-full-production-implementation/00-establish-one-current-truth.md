# Phase 0: establish one current truth

Status: proposed

## Parent

[Launchpad full production implementation plan](../../plans/launchpad-full-production-implementation.md), Phase 0

## What to build

Add a read-only `audit-v5-journal` command around the existing scoped v5 gateway and transaction journal. Classify every historical committed page ID as retained live page, synthetic artifact, stale test artifact, malformed record, or unresolved. Write redacted evidence to an external owner-only receipt. Never delete journal rows to unblock retry.

After retained evidence exists, synchronize current authority files, command manifest, CLI help, test counts, scheduler claims, receipt counts, journal claims, and Phase A claims. Validation must prove the command manifest and CLI help expose every live-sensitive flag.

## Main paths

- `notion-v5/transaction.mjs`
- `notion-v5/gateway.mjs`
- `crawler/cli.mjs`
- `crawler/operator.mjs`
- `config/launchpad-v5.commands.json`
- `docs/STATUS.md`
- `docs/SYSTEM-REFERENCE.md`
- `docs/plans/launchpad-daily-production-adoption.md`
- `tests/notion-v5/gateway.test.mjs`
- `tests/notion-v5/transaction.test.mjs`

## Acceptance criteria

- [ ] `node crawler/cli.mjs audit-v5-journal --credential-file ABS_PATH --journal ABS_PATH --receipt ABS_PATH` exists and is read-only.
- [ ] Every historical committed journal entry has a retained classification.
- [ ] Receipt records target, journal state, page existence, relation state, and redacted evidence outside repository with mode `0600`.
- [ ] No pending or verified recovery entry is hidden, changed, or deleted.
- [ ] Relevant unresolved entries block Phase 4 pilot.
- [ ] Status docs agree with retained receipt and current CLI behavior.
- [ ] Command manifest, CLI help, and safety checks expose the same live-sensitive flags.
- [ ] Credential values never appear in output or retained repository files.

## Blocked by

None. May run in parallel with Phase 1. Credential access and read-only live audit still require explicit approval.
