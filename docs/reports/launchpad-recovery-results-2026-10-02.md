# Launchpad first recovery pass results

This pass repairs the confirmed startup and reporting failures, corrects portal identity and employment parsing, shares the existing resolution cap across providers, and removes stale/hard-rejected rows from Normal's needs-verification queue. It proves no recovered live ready jobs. This worker's three public GET attempts failed at DNS resolution, but the parent supplied nine successful public GET captures. Those establish reachable public inventory and three usable LinkedIn portal JDs. Production configuration and scheduling were not changed.

The full suite still has 12 failures. All 12 failing names reproduce against isolated pre-edit sources. Validation, safety, and the tracked diff check pass. Launchpad remains unpromoted and operationally unverified.

## Scope and provenance

Work began against a heavily dirty checkout. The supplied AGENTS contract, `master_prompt.md`, STATUS open gates, SYSTEM-REFERENCE, command/Notion manifests, and safety enforcer were read. Existing files were copied before edits, including their preexisting Git diffs. No reset, stash, staging, commit, push, child-agent dispatch, credentials, settings, schedules, ignored `career-ops/` edits, live Notion writes, application submission, outreach, full scheduled crawl, or paid scorer was used.

Evidence lives in `.local/recovery-2026-10-02/first-pass/`. The preexisting sibling `baseline.json` was left untouched. `baseline/` holds the eight edited existing source files; `hashes-before.json`, `git-status-before.txt`, `attributable-delta.patch`, and `attribution.json` separate this pass from the user's changes. New adapters/tests that were already untracked were treated as existing files, not newly invented work.

The requested filenames retain October 2. Execution crossed midnight in IST into October 3; live-attempt timestamps are retained in UTC. Cached impact estimates use the explicit analysis clock `2026-10-02T12:00:00Z` and never become current-job claims.

## Confirmed failures and changes

| Path | Before | After and evidence |
| --- | --- | --- |
| Production startup | Expanded config has 13,285 JSON nodes. `startCrawlRun` throws at `run config.boardRegistry.boards[149].company`, before any DB access. | Persisted snapshot has 4,474 nodes. Real production config starts a memory-backed durable run; an injected source is fetched once and completes. `before.json`, `startup-after.json`, recovery-config tests. |
| Adapter reporting | LinkedIn injected HTTP 429 reports `empty`, `failed: 0`, `errors: []`. | Failed empty lane reports failure; healthy cards plus a failed query report degraded. Errors survive SQLite and the daily lane bridge, including attempted lanes with zero cards. |
| HTTP 200 pages | Sign-in, challenge and unrecognized HTML can parse into a healthy empty result. | Page-health checks reject these pages. Explicit no-results pages pass; LinkedIn's empty fragment remains a valid exhausted result. Browser blank/shell pages fail closed. |
| Employment | Whole-description `volunteer`, `contract`, and `part-time` tokens can describe benefits, client work, or hybrid location. | Title/type evidence and scoped description evidence determine excluded employment. Paid volunteer days and hybrid WFH phrases pass. Actual unpaid, volunteer, part-time, temporary and contract roles remain excluded, including conflicts with structured full-time/paid claims. |
| Glassdoor identity | Query removal destroys `jobListingId` and merges distinct partner listing URLs. | Meaningful parameters survive; known tracking parameters and fragments are removed. Listing ID becomes the job ID; tracking variants deduplicate. |
| LinkedIn recency | The configured top-level `timeWindow` never reaches URL construction. | It reaches every query, with explicit per-query overrides preserved. Week/day facets are tested. |
| Resolution cap | First 24 eligible cards consume the cap in provider order. | Provider round-robin grants every populated provider a turn, preserves order within each provider, and preserves final observation order. No cap, deadline or request budget increase. |
| Verification visibility | Raw source rows can enter Normal's queue without fresh policy evaluation; a stale fixture appears as needs-verification. | Queue rows are reclassified against the run clock and policy. Stale and hard-rejected rows are excluded. Rows expose `Needs Verification`, observed posted date or null, freshness class, and exact missing-evidence reasons. |

### Persisted configuration contract

Only the redundant full `boardRegistry.boards` copy is replaced. The snapshot retains effective `sources.*.boards`, source settings, planner settings/state, discovery profile, registry path and registry identity metadata. Planner selections/state also remain in existing source telemetry. The registry SHA-256 covers normalized identity followed by every ordered normalized board as JSON lines. Disabled boards therefore affect the fingerprint too.

The registry collection is explicitly bounded to 1,000 boards and 2,000,000 serialized bytes. Each identity/board still passes the ordinary JSON validator. The final persisted configuration still uses the unchanged global 10,000-node and depth-32 limits. Tests reject cycles, oversized settings, oversized individual boards, excessive collection count and excessive registry bytes before DB access. A partial run with a fingerprinted snapshot refuses a changed registry on resume.

This snapshot is diagnostic/reproducibility evidence, not a replacement runtime registry. Full registry metadata must come from the matching fingerprinted registry file. Older runs without this fingerprint retain their previous resume behavior.

### Parser and reporting boundaries

Failed requests now contribute to request counts. The operator checks HTTP status before handing a body to the LinkedIn adapter, because its real transport returns status/body rather than throwing for every HTTP error. Provider failures and record-normalization failures retain separate count contributions, while mirrored error messages are deduplicated.

The Wellfound parser also preserves `Part-time` and `Contract` instead of labeling every non-intern card full-time. This was a directly related parser defect found while protecting the employment exclusions.

Page-health checks are deliberately conservative for parsed-empty pages. An unknown no-results wording can report markup failure until captured and tested. These heuristics do not establish complete card extraction under every provider layout, nor do they make an aggregator date first-party evidence.

## Retained evidence versus current execution

The streaming log summary verifies the prior audit's **63 startup failures among 80 retained scheduled results**, covering run IDs dated August 24 through October 2. These are retained executions, not 80 new experiments. `historical-summary.json` and `retained-log-summary.json` preserve sanitized counters.

The August 24 midday Normal result contains 2,917 inputs, 2,682 first-failure geography rejections, 247 portal rows in the verification queue, and zero selected. Its provider inventory is LinkedIn 74, Glassdoor 26, Instahyre 40, Wellfound 107. Its 29 retained scorer-input rows all lack descriptions. Different layers disagree on intermediate counts: that same log's funnel says 66 eligible while top-level counts say 29 eligible. The DB crawl row also has different fetched/observation counts. They describe different stages and must not be presented as a single reconciled current funnel.

Both installed plist files were read only. They invoke production Normal/Pune morning or midday without `--execute-writes`. This proves their recorded arguments, not today's service health or successful external delivery.

### Read-only retained DB comparison

`impact-experiments.mjs` opens `.local/launchpad-crawler/crawler.sqlite` with `readOnly: true`, selects the latest observation per job key, and compares pre-edit versus current eligibility under the same policy.

| Measure | Before | After |
| --- | ---: | ---: |
| Unique retained jobs analyzed | 9,214 | 9,214 |
| Employment rejections | 476 | 320 |
| All eligibility gates passing | 175 | 176 |
| Newly eligible with a verified fresh date at the analysis clock | 0 | 0 |
| Ready with a verified fresh date at the analysis clock | 0 | 0 |

Of the 176 gate-passing retained rows, 123 have rejected freshness and 53 remain undated/uncorroborated. The single newly eligible row is a retained Workday Data Engineer listing; its freshness is rejected. It is not a recovered ready job. Most employment corrections still lose on other gates, so filter correction alone cannot repair yield. Unknown salary, experience, and posting dates were not filled in.

### Recovery options ranked after the live captures

1. **Keep the startup, reporting, parser and queue fixes.** The exact production startup failure now reaches an injected fetch. Error semantics survive the adapter, transport, SQLite and daily bridge. The capped fairness fixture gives each of four populated providers six candidates without increasing work.
2. **Implement narrow public LinkedIn JSON-LD detail enrichment next.** Three of three tested detail pages return HTTP 200 and a usable JobPosting JD. The current original-listing resolver visits each saved page but returns `destination-intermediary` with zero description characters. A separate portal-detail projection supplies the JD while leaving employer resolution and liveness unverified. This has stronger outcome evidence than starting with full browser hydration.
3. **Verify the eligible lead's employer application route independently.** Woodfrog survives current policy with unknown experience requiring review. It remains a public lead, not a ready role. Portal detail cannot establish an employer-original destination. Salary is undisclosed, so the active six-LPA policy reports `SALARY_NOT_VERIFIED`, not an invented amount or a salary rejection.
4. **Repair baseline tests before relying on a clean full-suite gate.** All 12 failures are independently reproduced against pre-edit sources. They still block a clean local consistency claim.
5. **Trial bounded ATS planning after improving verified board evidence.** Production has no `sourcePlanner` block; development enables 20 boards. Offline Pune allocation selects 15 India-tagged boards versus 3 in the legacy warm slice; historical eligible matches change only from 5 to 6. The registry has 238 boards, only 2 `indiaRelevant` and 2 `puneRelevant`, plus 19 `indiaFirst`. The captured Atlan/Druva sample contains 41 listings and produces zero currently policy-eligible observations through the existing warm adapter. Reachable boards and India flags alone do not prove suitable early-career yield.
6. **Defer broad browser-detail work and cap increases.** Browser portals still close their context before the plain HTTP resolver, but there is no rendered-detail comparison in this evidence. First measure how much remains after public LinkedIn detail enrichment. No policy broadening, challenge bypass, or cap increase has outcome support. Naukri/foundit/hirist/cutshort/peerlist lane names still do not establish built-in adapters.

## Live observations and offline replay

The shared budget is fully consumed: **3 worker attempts plus 9 parent public GETs = 12**. No additional live requests were made during handoff.

| Capture | Worker result | Parent result |
| --- | --- | --- |
| LinkedIn day-window AI engineer, Pune | `ENOTFOUND` | HTTP 200, 10 cards |
| Ashby Atlan posting API | `ENOTFOUND` | HTTP 200, 6 listings |
| Greenhouse Druva API with content | `ENOTFOUND` | HTTP 200, 35 listings |
| Second inventory capture | Not attempted by worker | LinkedIn week 10 cards plus saved Atlan/Druva bodies, 3 GETs, all HTTP 200 |
| LinkedIn details for 4473136187, 4473131541, 4433878985 | Not attempted by worker | 3 GETs, all HTTP 200 and JobPosting JSON-LD |

`public-probes.json` describes this worker's restricted network surface. `parent-public-probes.json`, `live-inventory.json`, `live-details.json`, `live-detail-decisions.json`, the three saved detail HTML files, and saved search/ATS bodies establish the successful parent observations. `ENOTFOUND` was worker-sandbox-specific; it is not a general source outage. Parent captures are bounded public-source evidence, not a scheduled production crawl or an application-ready delivery proof.

### Existing-flow replay with zero live requests

Run from the repository root:

```sh
node .local/recovery-2026-10-02/first-pass/offline-live-replay.mjs
```

The replay replaces `globalThis.fetch` with a throwing guard. Injected transports read saved bodies only. It uses the actual LinkedIn adapter, original-listing resolver, warm ATS adapter, Normal runner, eligibility policy and six-LPA salary floor. It injects empty lifecycle ledgers, disables surfacing and Workday enrichment, and invokes no paid scorer or external gateway. The replay clock is `2026-10-02T18:23:00Z`, shortly after the parent captures. Exit **0**; all assertions passed.

| Stage | Result |
| --- | --- |
| Saved week-search adapter | 10 cards parsed |
| Existing resolver on the 3 saved LinkedIn details | 3 `destination-intermediary` results; no JD retained and no original application URL |
| Card-only Normal queue | 7 needs-verification leads; 0 selected |
| Experimental portal JSON-LD field projection into Normal | 5 needs-verification leads; 0 selected |
| Captured Atlan/Druva bodies through warm ATS | 41 observations; 0 policy-eligible |

The projection is an experiment in the local replay script, not production enrichment. It reads portal title/date/employment/description with portal provenance and never supplies first-party resolution or Active employer liveness.

- **Woodfrog, 4473136187:** Software Engineer - NLP/LLM Reasoning. Portal detail dated October 2, 10:16:32 UTC; 2,546 plain-text JD characters in this replay. Eligible as relaxed/manual-review for unstated experience. Salary remains `Not Verified`. It remains in Normal's needs-verification queue with unresolved original destination and unverified employer liveness. It is not lost from the queue and is not application-ready.
- **Rasta.Ai, 4473131541:** the captured JD requires a minimum of 3 years. It correctly fails `EXPERIENCE_HARD_MIN_3_PLUS` and leaves the needs-verification queue after projection.
- **Cognologix, 4433878985:** the captured JD requires 5 years of hands-on experience. It correctly fails the same hard gate and leaves the queue after projection.

The parent decision sidecar used the base eligibility config and reported the salary floor disabled. The replay supplies the conversion policy's actual six-LPA floor, matching Normal mode. All three captured roles have undisclosed salary, so their result is `SALARY_NOT_VERIFIED`; no eligibility upgrade comes from that difference.

The exact lead loss is therefore **JD evidence at the resolver's aggregator boundary**, not Woodfrog's identity or queue visibility. No new production edit was needed after this replay. A narrowly bounded portal-detail stage is specified in the next-steps plan; employer-original resolution stays separate.

## Verification receipts

Every listed test subprocess has a `.pid`, `.exit` and `.log` receipt. All started test/probe processes finished; none needed termination. Shell backgrounding printed a harmless `nice(5)` permission warning, but children ran and their actual wait exits were captured.

| Check | Tests | Passed / failed | Exit |
| --- | ---: | --- | ---: |
| P0 config/run/reporting targeted pass | 29 | 29 / 0 | 0 |
| Parser/employment targeted pass | 60 | 60 / 0 | 0 |
| SQLite/daily bridge/operator/Normal targeted pass | 126 | 126 / 0 | 0 |
| Visibility experiment before its fix | 9 | 8 / 1 | 1 |
| Visibility fix plus relevant regressions | 27 | 27 / 0 | 0 |
| `npm run validate` | validator | pass | 0 |
| `npm run safety` | 7 contract checks | pass | 0 |
| `npm test` | 820 | 808 / 12 | 1 |
| `node crawler/cli.mjs readiness --run-tests` | 820, 86 inventoried files across all six groups | 808 / 12 | 1 |
| `git diff --check` | tracked diff | pass | 0 |
| Isolated pre-edit reproduction of failing files | 22 | 10 / 12 | 1 |
| Final error-count correction, adapter/daily/Normal regressions | 81 | 81 / 0 | 0 |
| Final non-array-error guard adapter check | 6 | 6 / 0 | 0 |
| Saved live-response replay | offline assertions | pass, 0 live requests | 0 |

The five required project checks ran once. A subsequent review corrected normalization-count addition and guarded non-array supplied errors; the two final targeted receipts cover that small change. The full suite was not repeated after it, in keeping with the requested budget. The final tree contains one additional regression test beyond the 820-test full-suite snapshot.

The same 12 failing test names reproduce with pre-edit code in these three files:

- `tests/crawler/env-isolation-novelty.test.mjs`: 2 failures.
- `tests/crawler/historical-suppression.test.mjs`: 2 failures.
- `tests/crawler/workflow.test.mjs`: 8 failures.

Their exact names are in `baseline-failure-comparison.json`. Symptoms include empty expected reserves, missing identity rows, and a completed-versus-partial mismatch. No baseline-failure repair is claimed. The isolated reproduction was limited to those three failing files, not a second full baseline suite. Readiness reports `codeComplete: false`, `productionReady: false`, and `operationallyVerified: false`; no operational evidence was supplied.

## Exact modified files

Existing source files changed by this pass:

- `crawler/run.mjs`
- `crawler/operator.mjs`
- `crawler/daily-runner.mjs`
- `job-pull/normal-sources.mjs`
- `job-pull/normal-mode.mjs`
- `job-pull/eligibility.mjs`
- `job-pull/portal-adapters/browser-portals.mjs`
- `job-pull/portal-adapters/linkedin.mjs`

New source/test files:

- `job-pull/portal-adapters/page-health.mjs`
- `tests/crawler/recovery-config.test.mjs`
- `tests/crawler/recovery-sources.test.mjs`
- `tests/job-pull/recovery-employment.test.mjs`
- `tests/job-pull/recovery-portals.test.mjs`
- `tests/job-pull/recovery-visibility.test.mjs`

New handoff files are this report and `docs/plans/launchpad-recovery-next-steps-2026-10-02.md`. Local diagnostics, baseline copies, scripts and receipts are confined to the stated evidence directory. No existing history document or plan was rewritten.

## Remaining blockers

The startup barrier is repaired locally. Parent captures establish reachable public inventory and three portal JDs, including one eligible manual-review lead. Employer-original resolution, verified application readiness, reliable scheduled coverage, and live ready delivery remain unproven. The captured sample is bounded and dated; it must not stand in for a broader production result. Baseline tests, production planner adoption, sparse board metadata and delivery prerequisites remain open. Credential/schedule/Notion/outreach/promotion gates remain outside this pass.

The next implementation should retain public LinkedIn JSON-LD detail evidence under a small request budget, then verify the surviving lead's employer route independently. Repair the baseline failures before claiming a clean local gate. The result-driven acceptance criteria are in the new next-steps plan.
