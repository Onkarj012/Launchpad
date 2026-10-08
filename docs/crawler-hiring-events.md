# Hiring challenges and off-campus drives

Set `hiringEventsPath` in the local crawler config to a JSON file on this Mac.
The daily runner reads it and returns `hiringEvents.items` and
`hiringEvents.quarantine`. It never edits the input file or turns events into
job candidates. Events do not count toward shortlist targets.

```json
{
  "items": [
    {
      "kind": "hiring-challenge",
      "title": "Backend hiring challenge",
      "company": "Example employer",
      "url": "https://employer.example/challenge",
      "date": "2026-10-18",
      "deadline": "2026-10-16T23:59:00+05:30"
    },
    {
      "kind": "off-campus-drive",
      "title": "Graduate engineering drive",
      "company": null,
      "url": "https://employer.example/drive",
      "date": "2026-10-20",
      "deadline": null
    }
  ]
}
```

Use dates and links from the event announcement. Every item needs a kind,
title, public HTTP or HTTPS URL, and event date. Company and deadline may be
unknown. Use `null` for an unknown deadline. Dates accept `YYYY-MM-DD` or an
ISO timestamp with seconds and an explicit timezone. Missing or invalid event
dates hold the item in quarantine. Invalid supplied deadlines also hold the
item. An unreadable file, malformed JSON, or missing `items` array stops the
run before discovery.

The existing `crawler/local-lead-report.mjs` renderer shows a separate event
table with each date and deadline. Timestamps display in IST. Date-only values
keep their date without adding a time. Unknown deadlines show `Not Verified`.
Held items show their input position and validation errors.

Render a retained daily result locally:

```sh
node crawler/local-lead-report.mjs DAILY_RESULT.json REPORT.md
```

No configured file means no events. This input performs no network requests,
Notion writes, outreach, or applications.
