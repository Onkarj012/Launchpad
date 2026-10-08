# Launchpad daily discovery recovery local issue pack

Parent specification: [Launchpad Daily Discovery Recovery Plan](../../plans/launchpad-daily-discovery-recovery.md)

Published draft: [Recovery Manifest — Launchpad Daily Discovery](https://waymark.leo4.dev/p/M3urjCXJpDzq)

This directory converts the draft recovery plan into six dependency-ordered local implementation tickets. These files are specifications, not live issue state. No GitHub issue was created. GitHub remains the live issue-status authority, and [../../STATUS.md](../../STATUS.md) remains the sole repository execution-status index.

## Destination

Every Normal morning run returns a truthful `completed`, `partial`, or `failed` result within 20 minutes, resumes after interruption, and never reports execution failure as market scarcity.

## Dependency order

```text
01 → 02 → 03 → 04 → 05 → 06
```

Each ticket's exit gate must pass before work starts on the next ticket.

## Tickets

1. [Make run and source state durable](./01-make-run-and-source-state-durable.md)
2. [Stop network work at the execution deadline](./02-stop-network-work-at-the-execution-deadline.md)
3. [Return resumable partial results safely](./03-return-resumable-partial-results-safely.md)
4. [Plan bounded sources and remove duplicate fetches](./04-plan-bounded-sources-and-remove-duplicate-fetches.md)
5. [Make the mode selector the final shortlist owner](./05-make-the-mode-selector-the-final-shortlist-owner.md)
6. [Prove the recovery contract without production activation](./06-prove-the-recovery-contract-without-production-activation.md)

## Shared acceptance contract

- Same schedule, mode, location preset, and IST date produce the same default daily run ID.
- Every planned source has an explicit durable terminal or resumable state.
- Parent cancellation reaches actual network work; request count remains fixed after cancellation.
- CLI emits one versioned terminal envelope within 20 minutes.
- `partial` always means `writesPlanned: false` and performs no opportunity-ledger, v5, application, outreach, checkbox, surfacing, success-canary, success-notification, or other external operation.
- One network fetch owner exists per board.
- Crawler, mode-selector, v5-plan, and notification counts reconcile for completed runs.
- Empty output reports exact rejection reasons or exact incomplete-source coverage.
- At most 20 new focused tests are added across this pack, followed by one final full tracked readiness run.
- Production remains blocked until separately authorized live and promotion gates pass.

## Shared non-goals

No targeting relaxation, weak-role padding, new provider, Crawlee, Firecrawl, paid rescue, browser automation, Notion schema change, resume/outreach/Gmail/LinkedIn behavior change, historical-data deletion, schedule installation, live write, commit, push, pull request, production config activation, or promotion belongs to this issue pack.
