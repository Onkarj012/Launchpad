# HN and YC trial yield

Trial window: 8-14 October 2026, IST. Local configuration enables both avenues for these seven dates, morning only. This is preparation for a trial, not live yield evidence. No pipeline run or schedule installation was performed for this ticket.

| Avenue | Observed days | Measured yield | Decision |
|---|---:|---|---|
| HN monthly hiring thread | 0 of 7 | Not Verified | Insufficient evidence |
| YC India and remote | 0 of 7 | Not Verified | Insufficient evidence |

HN finds the current monthly thread by its exact title and the `whoishiring` author, then reads a bounded sample of at most 100 top-level comments in the API's ranked order through the public Firebase API. Its manifest records unsampled comments. Completed samples count as observed days; they do not prove complete thread coverage. Deleted comments, replies, senior roles, unknown experience and unclear or restricted geography do not become discovered roles. Kept comments remain leads until the existing resolver returns original employer evidence. Global discovery does not bypass the shared location gate.

YC uses the existing injected search and employer resolver. Its query includes India or remote and searches both the job index and individual company job pages. A search result is never application-ready on its own.

Retain the JSON emitted by `node crawler/cli.mjs run morning --config <isolated-config>` for each trial date. Assemble the retained crawler reports into one JSON array, then run:

```sh
node crawler/cli.mjs trial-yield --trial-start 2026-10-08 --runs <retained-reports.json>
```

The report lists discovery requests, fetched records, kept leads, unresolved leads, application-ready observations, ready observations per discovery request, and missing IST dates for each avenue. Employer resolver requests are excluded. Counts are per-run observations, not distinct jobs over the week. Replayed run IDs count once. Missing, failed or truncated evidence cannot complete a date. After seven complete dates, positive ready yield suggests keep and zero ready yield suggests drop. This is an advisory decision; it never changes source configuration.

No live seven-day yield has been measured. Keep/drop decisions await retained operational evidence. Use a new explicit `trialStartDate` for a later trial; the dated trial plans stop automatically after day seven.

Public input references: [HN API](https://github.com/HackerNews/API), [HN search API](https://hn.algolia.com/api), [YC India](https://www.ycombinator.com/jobs/role/all/india), [YC remote](https://www.ycombinator.com/jobs/role/all/remote).
