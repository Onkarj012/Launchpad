# PROTOTYPE — Plugin + Web Discovery Bridge

Throwaway logic prototype. Do not promote this directory into the production
crawler as-is.

## Question

Can records collected by Indeed, Apna, WhatJobs, and generic web discovery pass
through Launchpad's existing normalization, eligibility, freshness, readiness,
deduplication, and reserve-selection rules while keeping every important
decision visible to an operator? This prototype answers only that question. It
never writes Notion, applies, sends, uses the network, or opens production
SQLite.

## Run

Interactive empty session:

```sh
node crawler/prototypes/plugin-web-discovery/tui.mjs
```

Start interactively with an envelope:

```sh
node crawler/prototypes/plugin-web-discovery/tui.mjs ./path/to/envelope.json
```

Emit a noninteractive JSON report:

```sh
node crawler/prototypes/plugin-web-discovery/tui.mjs --report ./path/to/envelope.json
```

Read the report envelope from stdin:

```sh
node crawler/prototypes/plugin-web-discovery/tui.mjs --report -
```

Use `--now 2026-07-23T12:00:00.000Z` to make freshness calculations
repeatable.

## Envelope

```json
{
  "records": [
    {
      "source": "indeed",
      "sourceJobId": "job-123",
      "title": "Junior AI Engineer",
      "company": "Example",
      "location": "Remote - India",
      "description": "Entry-level role. 0-1 years. Full-time.",
      "postedAt": "2026-07-22T09:00:00.000Z",
      "url": "https://example.invalid/discovery/job-123",
      "originalApplicationUrl": "https://jobs.example.invalid/job-123",
      "liveness": {
        "status": "Active",
        "checkedAt": "2026-07-23T10:00:00.000Z",
        "evidence": "checked by operator"
      },
      "employment": {
        "type": "full-time"
      },
      "experience": {
        "minYears": 0,
        "maxYears": 1,
        "evidence": "0-1 years"
      }
    }
  ]
}
```

`source` must be `indeed`, `apna`, `whatjobs`, or `web`. Each record needs
`sourceJobId` or `jobId`. `postedAt` may be `null`; the role then appears in
`undatedVerification` and cannot enter the shortlist. The other optional
structured fields are passed through to the existing Launchpad policy
functions.

Internships also accept the existing internship-lane stipend shape:

```json
{
  "employment": { "type": "internship" },
  "stipend": {
    "amount": 30000,
    "currency": "INR",
    "period": "month",
    "evidence": "INR 30,000 per month"
  }
}
```

The prototype reuses the daily-pull stipend parser. At least ₹30,000/month is
`Preferred`; ₹25,000–₹29,999 is `Lower-Stipend`; below ₹25,000 is rejected; and
missing or unsafe stipend evidence is verification-only. A verified INR/month
range is conservatively hard-rejected when even its maximum is below ₹25,000.

The report intentionally separates:

- `freshUnresolved`: fresh records that still point at an aggregator or lack an
  evidenced original application URL.
- `undatedVerification`: otherwise promising direct/resolved records included;
  no undated record can enter the shortlist.
- `stale`: records beyond the freshness window.
- `ineligible`: records rejected by title, geography, experience, employment,
  or another policy gate.
- `hardRejected`: only hard policy, stale, expired-liveness, fee/bond, and
  below-floor stipend failures. Verification records are not counted here.
- `applicationReady`: records whose original application, liveness, policy, and
  freshness evidence all pass, including the internship stipend gate when
  applicable.

All state is in memory. Importing the same envelope again is useful: the second
pass appears in `duplicates` without creating another candidate.
