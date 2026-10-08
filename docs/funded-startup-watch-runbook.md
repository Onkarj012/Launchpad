# Funded-startup watch

Ticket 28 adds a manual weekly intake and a seven-day local yield report. No schedule is installed. No live trial has run yet.

Run from the repository root, with operator-curated public funding evidence in `.local/funding-input.json`:

```sh
node crawler/vc-portfolio-watchlist.mjs weekly \
  --input .local/funding-input.json \
  --registry config/board-registry.json \
  --state .local/funding-watch-state.json \
  --report .local/funding-watch-report.json
```

The input has `fundingEvents` and `dailyRuns` arrays. A funding event has this shape. Replace the example with evidence from an actual announcement, including its stated funding date and the employer's careers link:

```json
{
  "fundingEvents": [
    {
      "company": "Example startup",
      "fundedAt": "2026-10-07",
      "sourceUrl": "https://example.com/news/funding",
      "board": {
        "provider": "ashby",
        "slug": "example",
        "url": "https://jobs.ashbyhq.com/example",
        "sourceUrl": "https://example.com/careers"
      }
    }
  ],
  "dailyRuns": []
}
```

Funding dates are IST calendar dates. The intake accepts the current date and the preceding six dates. Future, missing, invalid and older dates are held. Evidence URLs must be HTTPS without credentials. The board URL must match its provider and tenant. Greenhouse, Lever and Ashby use the existing warm ATS adapter. The input is curated evidence, not an automatic funding-news scraper. A funding announcement is never job evidence.

On the first run, the intake also considers watchlist companies with retained employer board links. Each new board gets one public GET, with no detail requests or retries. Its probe retains the request URL, time, discovery source, job count, India count, Pune count and failure reason. Location counts come from the board response. Failed counts stay null. New entries remain disabled proposals, even after a successful probe. Existing boards remain unchanged. Review and manually activate useful boards through the existing registry workflow before collecting daily yield.

The state records the last weekly intake date. Runs before seven IST dates have passed only update the report. Invoke the same command each week with new announcements. Keep the same state file for replay protection.

For the trial, append retained crawler workflow outputs to `dailyRuns`. Each needs its `run.run_id`, `run.started_at` and `sourceYield.sources`, or the equivalent `runId` and `runAt`. Schedule-health run summaries with `startedAt` also work. Each source row supplies `sourceId`, `fetched`, `indiaBased` and `applicationReady`. Empty sources need explicit zero counts. Missing counts do not prove zero yield.

The report covers the start date and the next six IST dates. It deduplicates run IDs and only attributes rows whose source IDs match the trial's new boards. Each observed date needs yield rows for every watched board. Missing dates keep the report incomplete. After the week ends and all seven dates are present, any application-ready yield recommends `keep`; zero recommends `drop`. The recommendation never changes source configuration. Counts sum observed roles across runs, not unique vacancies. Funding intake after that week does not change its board cohort or probe-request count. Start a separate state file for a later trial.

The output remains on this Mac. Do not publish it to Waymark. This command does not build resumes, write Notion, change user-owned checkboxes, apply, send, or install launchd.

Watchlist additions were checked on 8 October 2026 IST. [Together Fund](https://www.together.fund/) lists Composio and describes its US-India focus. [Composio careers](https://composio.dev/careers) redirects to its Ashby board. [Nexus's portfolio](https://www.nexusvp.com/companies) lists India for CrelioHealth and both India and the US for Druva. Their boards remain search seeds until employer board evidence is retained. Portfolio verification does not establish current board yield.
