# Ticket 16: web discovery root cause

Date: 8 October 2026, IST.

## Cause and fix

The checked-out production and development configs enable SearXNG, disable
Brave, and give SearXNG a 20-query budget. Neither declares configured engines.
This path needs no Brave API key.

`fullyDegraded()` treated an absent configured-engine list as proof that every
engine failed. A first query with sparse results and one engine timeout therefore
skipped every remaining query, even when later queries could return leads.
The daily-run regression reproduced zero leads before the fix and one ATS lead
after it. Unknown engine coverage now keeps the remaining bounded queries active.
Confirmed failure of every configured engine still stops the remaining queries.

The SearXNG adapter also replaced a missing results field with an empty array.
It now preserves the missing field so discovery reports a malformed response.

Empty searches carry a reason in their manifest and telemetry. The daily
web-discovery manifest retains each source's reason. Reasons distinguish no
queries, zero query budget, interruption, degraded engines, malformed responses,
failed requests, unusable result URLs, and healthy searches with no results.
Search snippets still cannot establish posting dates or application readiness.

## Evidence limits

Tests use injected HTTP responses through the existing search and daily-run
interfaces. They establish the code defect and fixture recovery. No live search
ran, so this does not establish the cause of every historical empty run or prove
current source yield. No targeting policy changed.

The ticket file is untouched under the explicit Git instruction. This report
records the root cause for the orchestrator to copy into the ticket.

## Verification

- Red tests reproduced the skipped-query defect, absent empty reasons, and the
  adapter hiding malformed responses before each corresponding code change.
- Focused search, daily-runner, and operator tests passed 100 of 100.
- `npm test` passed 924 of 926. The two failures in `tests/v5/operator.test.mjs`
  concern validation and rehearsal with missing Claude skill mirrors.
- `npm run validate` exited 1. The base commit lacks the Claude mirrors for
  linkedin-leads, outreach, sync, launchpad, and guardrails. They remain untouched.
- `npm run safety` passed all seven checks. `git diff --check` passed.
- `npm ci` succeeded after the sandbox attempt failed DNS resolution. It reported
  one high-severity dependency advisory. No dependency versions changed.
- Readiness with tests and a separate rehearsal were skipped under the explicit
  full-suite test budget. No live network discovery or external writes ran.
