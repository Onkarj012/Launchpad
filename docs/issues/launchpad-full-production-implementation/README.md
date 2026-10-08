# Launchpad full production implementation local issue pack

Parent plan: [Launchpad full production implementation](../../plans/launchpad-full-production-implementation.md)

Published draft: [Launchpad full production implementation plan](https://waymark.leo4.dev/p/Onjaequ3M8zd)

This directory converts plan phases 0 through 9 into dependency-ordered local tickets. These files are implementation specifications, not live issue state. No GitHub issue was created. GitHub remains the live issue-status authority, and [../../STATUS.md](../../STATUS.md) remains the sole repository execution-status index.

## Success target

Normal morning production produces at least five fresh, eligible, employer-linked roles on normal inventory days. A lower count is valid only with complete machine accounting and retained manual inventory confirmation.

Initial production profile:

```text
morning / normal / pune / production / live-v5
```

## Dependency order

```text
00 ───────────────────────────────┐
                                  v
01 → 02 → 03 ───────────────────→ 04 → 05 → 06 → 07 → 08 → 09
```

Phases 0 and 1 may start in parallel. Phase 4 requires Phase 0 journal reconciliation plus Phase 1 through 3 acceptance. Phase 9 follows initial production and does not block Phase 8.

## Tickets

1. [Phase 0: establish one current truth](./00-establish-one-current-truth.md)
2. [Phase 1: make scheduled discovery finish and retain its work](./01-make-scheduled-discovery-finish.md)
3. [Phase 2: close LP-009 and improve employer-direct diversity](./02-close-lp-009-employer-direct-diversity.md)
4. [Phase 3: make reports, shortfalls, and canary evidence executable](./03-make-canary-evidence-executable.md)
5. [Phase 4: reconcile credentials and prove one live row](./04-reconcile-credentials-and-prove-live-row.md)
6. [Phase 5: make resume and sync commands work against live v5](./05-make-live-resume-and-sync-commands.md)
7. [Phase 6: create a clean immutable candidate](./06-create-clean-immutable-candidate.md)
8. [Phase 7: run the seven-date immutable canary](./07-run-seven-date-immutable-canary.md)
9. [Phase 8: promote the live morning schedule and prove rollback](./08-promote-live-schedule-and-prove-rollback.md)
10. [Phase 9: close LP-010 and LP-011 after useful production](./09-close-lp-010-and-lp-011.md)

## Shared boundaries

- Never auto-apply or send email, DM, referral requests, or LinkedIn actions.
- Never write user-owned `Make Resume` or `Applied?` fields.
- Never invent freshness, eligibility, experience, salary, contact, or resume evidence.
- Never fall back to v3/v4.
- Keep `maximumPerCompany = 2`.
- Live writes, credential access, schedule changes, release creation, commit, push, PR, promotion, and rollback require their named approvals.
- Each phase ends only with retained evidence, not code presence alone.
