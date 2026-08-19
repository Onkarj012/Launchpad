# Launchpad Crawler v2 operational baseline

Status: Phase 0 baseline recorded on 2026-07-24.

## SearXNG smoke

The bounded SearXNG smoke completed successfully. SearXNG is therefore an
activated discovery lane, not a pending setup item. Search results remain
leads until they resolve to an original employer or ATS listing and pass the
shared readiness gates.

Recorded crawler output from the baseline run:

| Stage | Count |
| --- | ---: |
| Raw fetched | 2,426 |
| Observations | 589 |
| Verification queue | 82 |
| Application-ready | 0 |

These are live crawler-output metrics. They are not test counts and do not
claim that any role was written to Notion.

## Boundaries

- Local tests are deterministic repository checks. The Phase 0 release
  command below defines the scoped crawler, Normal, Startup, Remote, v5
  gateway, and deduplication suites; this pass did not run it.
- The previously recorded scoped local baseline is 269 passing tests; that
  result is preserved as a release reference and was not rerun here.
- Live crawler output is collection and evidence telemetry only. It does not
  submit applications, send messages, generate resumes, or perform Notion
  writes.
- Planned writes are the v5 operations produced by a planning-only handoff.
  They are payloads to inspect, not confirmed remote mutations.
- Real Notion writes are not represented by this baseline and were not
  performed or verified. A credentialed live smoke remains a separate gate.

## Phase 0 release command

This repository has no package manifest or package-script convention. The
documented release-level command is:

```sh
node --test tests/crawler/*.test.mjs tests/job-pull/normal-mode.test.mjs tests/job-pull/startup-mode.test.mjs tests/job-pull/remote-mode.test.mjs tests/notion-v5/gateway.test.mjs tests/job-pull/dedup.test.mjs
```

The command is intentionally scoped to the crawler and the three mode,
gateway, and deduplication contracts. It performs no network or Notion write
by itself.
