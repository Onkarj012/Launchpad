# Daily allocation and acceptance evidence

PR5 prepares cumulative daily counters. It does not prove recurring source yield or live history completeness.

## Allocation contract

Completed local plans share one ceiling of 20 unique roles per IST date across Normal, Startup, Remote, morning, and midday. Within each Strict/freshness waterfall band, target reservations are 10 Pune roles, 5 Startup roles, and 5 Remote roles. Unused reservations can fill another mode. Exhaust the band across modes before taking any later band. Each job has one primary mode, Startup before Pune before Remote. Company capacity remains two per mode per IST date. The requested mode owns its delivery plan; the retained daily budget includes all three mode allocations.

Partial or failed runs consume no allocation. Retries merge the retained identities and reject conflicting metadata. A missing prior row is not erased. Changed retry inventories can fail closed when they exceed capacity; they are not an exact artifact replay.

The identity-bearing `DailyPhaseTargetRollupV2` accumulates completed run allocations. It deduplicates jobs within an IST date. Each mode needs its role and employer targets on at least five of seven consecutive IST dates. Each qualifying day also needs at least two unique Strict roles across modes and usable configured local history. Legacy count-only days remain unverified. Missing, stale, malformed, injected, or undated history cannot establish acceptance. Local history availability does not establish live completeness.

Stretch, EOR/Contract, VerifyQueue, and scoring queues are separate lanes. They do not fill targets. Reports distinguish this-run allocation and focus delivery from cumulative all-mode IST counts. Failed or truncated sources remain unhealthy when they fetched rows.

## Retained original-history diagnostic

On 14 October 2026 IST, a read-only diagnostic used these original-repo files under `/Users/onkarj012/Documents/Claude/Projects/Job Search/career-ops/data/`. No originals were copied into runtime state or changed.

- `opportunity-ledger.tsv` has 157 retained rows. A known entry returned `SUPPRESSED_COOLDOWN_7D` at its recorded last-surfaced time. This checks the retained entry and cooldown path, not present-day suppression of that expired cooldown.
- `v4-history-snapshot.json` has 31 rows and `generatedAt` of `2026-07-24T21:38:52Z`. It is stale at the diagnostic date. The supplied historical matcher suppressed one known actual entry with zero ambiguous matches.
- SHA-256 values before and after matched for the ledger, snapshot, and full snapshot:

```text
opportunity-ledger.tsv              5ae921a66a971f4b96b54ed85e3a90ad1426ec9cc587ff7ccab66105eec98dd3
v4-history-snapshot.json           5f1b2cb293e7e2b425e420f7b643a592f217fa94d086c90d4c3de6b9321a6c6c
v4-history-snapshot.full.json      1a76aaab8b93b9b2bcb70cf9a85bfd0ba93decc9cc874f43ee4af3722b4bb763
```

This is a small known-entry diagnostic. Real-history completeness and present-day suppression remain unproved. No live crawler, Notion, application, outreach, credential, schedule, cleanup, or promotion operation ran.

## Prepared seven-day path

The coordinator's separately authorized bounded crawl can retain completed local reports and identity allocations against isolated paths. Keep morning and midday on the same daily-budget path. Inspect `dailyShortlistBudget.cumulativeCandidates`, the current `phaseTargetRollup.days` entry, history evidence, source end states, and missing IST dates. Keep each Markdown/JSON report pair. Seven actual calendar dates are needed; fixture dates never establish real yield. A failed history check or shortage stays visible and never relaxes gates.
