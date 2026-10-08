# Phase 4: reconcile credentials and prove one live row

Status: proposed

## Parent

[Launchpad full production implementation plan](../../plans/launchpad-full-production-implementation.md), Phase 4

## What to build

Expose a gateway-owned, read-only `live-preflight` command. Validate exact v5 manifest, relations, credential file ownership and mode, external journal path, target access, and blocking recovery state without writing.

After Onkar rotates the exposed Notion credential, shares all five v5 databases, approves preflight, reviews its receipt, and separately approves one-row execution, run one selected row with `--shortlist-limit 1`. Replay the exact run identity and operation key.

## Main paths

- `notion-v5/gateway.mjs`
- `notion-v5/transaction.mjs`
- `crawler/cli.mjs`
- `crawler/daily-runner.mjs`
- `config/notion-v5.manifest.json`
- gateway, transaction, CLI, and daily-runner tests

## Acceptance criteria

- [ ] `live-preflight` performs no write and emits a redacted external receipt.
- [ ] Preflight rejects invalid manifest, relations, credential ownership or mode, repository-local journal, inaccessible target, or blocking recovery state.
- [ ] One Applications v5 row exists after separately approved pilot.
- [ ] Company relation verifies by read-back.
- [ ] Employer URL, score, freshness, tier, source, Run ID, and relaxation evidence match retained report.
- [ ] Create payload omits `Make Resume` and `Applied?` instead of setting them.
- [ ] Exact replay creates zero pages and reports `alreadyCommitted` or `replayed`.
- [ ] Replay does not refresh cooldown or increment surfacing.
- [ ] Journal has no requested pending or verified recovery entry.
- [ ] Pilot does not count toward seven-date canary streak.

## Stop point

Do not check user-owned fields automatically. Do not promote or install schedule.

## Blocked by

Phase 0 journal reconciliation and Phase 1 through 3 no-write acceptance. Credential rotation, preflight, pilot write, and replay each require their named approval.
