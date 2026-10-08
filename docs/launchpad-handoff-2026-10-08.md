# Launchpad recovery handoff

Prepared 8 October 2026, IST. Last measured job verification and test run: 7 October 2026. This document records the recovery work in this conversation. It is a dated handoff, not a replacement for [STATUS.md](STATUS.md) or live GitHub issue status.

## Where we are now

The system can fetch leads, retain descriptions, apply eligibility checks, verify some employer application pages, score a verified role, and select it locally. The latest bounded run produced **one verified, scored fallback role and zero Strict matches**. It does not yet supply the requested daily shortlist or prove unattended operation.

- Branch: `feat/launchpad-readiness-completion`.
- HEAD when this handoff was written: `ae89f73eba5a2bdb8eea5b9a39694e33919c7d99`.
- The checkout is heavily dirty. Completed fixes are local working-tree changes, not a committed or promoted release. Preserve unrelated changes.
- Latest full suite: 890 passed, zero failed. Focused verifier regressions: 39 passed.
- Readiness tests pass across all six groups, but the command exits 1 for `OPERATIONAL_VERIFICATION_MISSING`. `codeComplete` is true; `productionReady` and `operationallyVerified` are false.
- Onkar asked to stop further fixes and prepare this handoff. No new repair or live job run was started for this document.

## What we started with

Launchpad already had discovery adapters, gates, scoring, resume generation, lifecycle tracking, scheduling code, and safety boundaries. The problem was that implemented paths and local tests did not establish a usable daily result.

The early recovery audit found 63 startup failures among 80 retained scheduled results. These were historical executions, not 80 fresh tests. A retained midday run fetched 2,917 inputs and selected zero roles. Its intermediate counts disagreed between reporting layers, and retained scorer inputs lacked job descriptions. The initial recovery pass also reproduced 12 existing test failures.

The product target remained 10 minimum, 12 preferred, and 20 maximum verified scored roles per IST day across modes and schedules. Pune-area onsite/hybrid and explicitly India-eligible remote roles must pass the policy. Prefer Strict early-career matches; separately label permitted two-year shortage fallbacks. Never pad a shortage by weakening verification.

## Problems found and repairs completed

| Problem | What changed | What the evidence establishes |
|---|---|---|
| Expanded production configuration failed before fetching | Persisted a bounded effective configuration and registry fingerprint instead of duplicating the full board registry | The exact startup failure reaches an injected fetch and completes locally. This is not proof of a healthy installed daily service. |
| Source failures looked like healthy empty results | Retained failed/degraded status through adapter, transport, persistence, and daily reporting; rejected sign-in/challenge/shell pages | Request failures and incomplete coverage are visible instead of appearing as zero available jobs. |
| Portal identity, employment, recency, and provider allocation were unreliable | Preserved Glassdoor listing IDs, scoped employment evidence, propagated LinkedIn time filters, and shared the resolution cap across providers | Relevant regressions pass. Benefits or client-work wording no longer automatically becomes excluded employment. |
| Portal descriptions and enriched batches did not survive the complete operator path | Added bounded detail extraction and collection persistence; restored stored telemetry on completed-run reopen | A saved 30-record replay retained five descriptions and reopened without another fetch. Portal evidence still does not prove an employer-original route. |
| Experience extraction confused company history or range bounds with applicant requirements | Excluded employer tenure and support duration; preserved applicant requirements and range lower bounds | Company age stays separate from applicant experience. Genuine mandatory 3+ year requirements still reject. |
| Fresh rows could lose to row caps; selection/scoring boundaries were inconsistent | Sorted trusted dates before caps, retained required JD fields, exhausted Strict/freshness bands before diversity, and validated model scores and daily allocation | Local tests pass. A real scorer diagnostic returned 62/100, but its role stayed out of the shortlist after employment evidence proved missing. |
| Education duration became work experience | Repaired `year(s)`, abbreviated `yrs.`, education exclusions, and required-versus-preferred clauses in `job-pull/candidate.mjs` | All five complete captured Accenture JDs now parse minima **2, 3, 2, 2, 5**. Three false experience rejections are repaired; 3 and 5 still reject. |
| An unnamed-client recruiter became an employer-original listing | Applied the same client-hiring evidence guard in the original-listing resolver and direct ATS readiness | Leading Edge stays `Needs Verification`. Ordinary software work for clients still passes. A second GPT-6.1 Sol reviewer confirmed both cases. |

The early repairs are detailed in the [first recovery report](reports/launchpad-recovery-results-2026-10-02.md) and [LinkedIn completion report](reports/linkedin-detail-recovery-2026-10-03.md). The later completion evidence is in the [6 October handoff](../.local/pipeline-completion-2026-10-06/finish/handoff.md).

## What the discovery experiments showed

We researched ten GitHub projects and tested four selected approaches. These were isolated experiments, not four new production integrations.

| Approach, 6 October | Retained inventory | Result before the final verifier fixes | Decision from the experiment |
|---|---|---|---|
| JobSpy Naukri | 100 occurrences, 99 valid unique URLs | 43 location passes, 37 title passes, one experience pass, zero verified ready | Access worked. Parser defects and employer-route verification needed attention. |
| JobNavigator-style Indeed and LinkedIn queries, using the same JobSpy library | 131 occurrences, 113 valid unique URLs | 26 passed policy/freshness; ten had retained JDs; zero verified employer routes | Useful targeted leads. It is a method comparison, not an independent scraper benchmark. |
| RoleRadar filtering, adapted to Onkar's titles | Replay of the same Indeed/LinkedIn inventory; no new jobs | Accepted 43; 24 failed our policy/freshness checks; missed seven that passed | Do not replace our eligibility gates with this permissive filter. |
| openroles published catalog | 280,000 catalog rows inspected; 53 leads retained | 25 passed policy/freshness. One mechanical ready result was the unnamed-client recruiter, so independently verified ready was zero | Useful direct-application seed inventory; employer identity still needs verification. The catalog sample was incomplete. |

The live approaches together retained 284 occurrences and 265 valid unique URLs. These are URL-unique, not proof of distinct opportunities across boards. Do not add the RoleRadar replay or catalog rows to the job total.

The original live trials spanned 11 minutes 28 seconds, with 81 completed requests and one possible interrupted request. The temporary LinkedIn resolver exceeded its distinct-detail allowance; the catalog trial may have exceeded its phase request cap by one. Both exceptions remain recorded. No production files changed during those experiments.

See [repository research](research/2026-10-06-github-job-discovery-comparison.md) and [the original trial results](../.local/source-approach-trials-2026-10-06-1907/RESULTS.md).

## How the final fixes changed the result

Two measurements must remain separate.

**Same-data replay at the original clock:** the corrected parser raised Naukri's experience/fresh provisional count from one to four. The employer guard removed the recruiter's false ready result, from one to zero. All sources still had zero ready jobs in this frozen replay. Fixing the parser recovered leads, not four verified jobs.

**Additional public verification on 7 October:** we inspected saved leads and employer pages with 65 GETs, including 55 detail/redirect requests and ten employer searches. No new broad scrape or catalog download occurred. Some leads aged beyond 14 days; two Accenture employer postings dated from July despite October portal refresh dates. They correctly failed freshness.

| Saved source inventory rechecked on 7 October | Valid unique URLs | Passed location/title/experience/employment/freshness | Retained JD after those gates | Ready | Scored | Selected |
|---|---:|---:|---:|---:|---:|---:|
| Naukri | 99 | 2 | 2 | 0 | 0 | 0 |
| Indeed and LinkedIn | 113 | 25 | 10 | 0 | 0 | 0 |
| openroles leads | 53 | 17 | 1 | 1 | 1 | 1 |

These columns are cumulative gates over reused inventory, not newly fetched job counts. Unknown employment, missing descriptions, unresolved routes, or unknown employer identity remain in verification.

The selected role was [Snowflake Cloud Support Engineer, AI/ML, Night Shift](https://jobs.ashbyhq.com/snowflake/ff8fe152-e6c9-46d1-bdc7-ea414ea9d436), Pune, full-time, posted 25 September. It requires 2+ years of technical support and a shift starting at 10 PM IST.

The actual configured `gpt-5.6-luna` scorer returned **55/100** in one 23.1-second call. Its validated components were 20 skill, 16 domain, 5 seniority, 10 location, and 4 response likelihood. The actual selector chose it as a Backfill shortage fallback. It is a modest-fit support role, not a strong Strict engineering match. Strict selection remained zero; the minimum-target shortage was nine.

This one-role result came from completing additional verification of the saved leads. It should not be attributed to the experience-parser fix alone. Job-page verification took about 3 minutes 10 seconds; that excludes later employer searches, tests, review, and reporting. No measured duration establishes a future complete daily runtime.

## Current bottlenecks

| Bottleneck | Evidence and effect | What needs to be established next |
|---|---|---|
| Fresh, suitable role supply | One modest fallback and zero Strict matches from the bounded saved inventory | A source mix that repeatedly returns current Pune/India-eligible early-career engineering roles. A larger raw count alone is insufficient. |
| Original employer application routes | Ten retained portal JDs had no verified employer route; bounded employer searches found no verified destination | Preserve or discover a real employer/ATS URL and verify its role identity. Do not guess links or treat LinkedIn signup as an employer application. |
| First-party dates, employment, and liveness | Portal refresh dates can mask old jobs; unknown employment and challenge pages cannot establish readiness | Retain original dates, full-time or paid-internship evidence, and current accessible job detail. Unknowns must stay unknown. |
| Source coverage within budgets | Earlier runs were partial; the catalog sample covered only part of its inventory | Every intended source must finish or report an explicit omitted/failed reason. Bound requests and measure useful verified roles per request. |
| Generic employer-career job identity | Fingerprinting can retain `jobdetails` instead of the URL query requisition | A narrow identity fix with captured evidence. This issue is documented but **not fixed**. No yield improvement is established yet. |
| Real daily operation and promotion | Readiness still reports missing operational verification | Prove real-history suppression, verified shortlist delivery, required v5 integration and checked-row PDF flow, then the clean-version canary/promotion/rollback gates in STATUS. These were not exercised by the bounded job tests. |

The last blocker is broader than one code repair. Existing installed shadow schedules do not prove that these local fixes are deployed or that the complete daily loop works. The repository's live/release gates and LP ticket status must be checked separately before operational work.

## Suggested resume order

1. Read [master_prompt.md](../master_prompt.md), [STATUS.md](STATUS.md), this handoff, and the final verifier report. Treat older counts as dated measurements.
2. Inspect and narrowly repair the outstanding employer-career requisition parsing issue when authorized. Protect role identity without loosening evidence gates.
3. Run a bounded fresh source experiment aimed at verified early-career engineering yield. Prioritize source/query composition and original employer URLs. Report each gate and every omitted source.
4. Score only genuinely ready jobs with the configured scorer. Keep fallback, shift requirements, score, and shortage visible. Do not count the prior Snowflake role as current without refreshing its evidence.
5. Once useful supply exists, exercise the complete daily flow and required operational integrations. Follow the release gates before any schedule adoption or promotion. One local selected role does not complete them.

This order is a proposal for the next session. The user's latest instruction authorized only this handoff document; no further repair, crawl, or promotion was started.

## Evidence and safe continuation

The last completed repair pass changed seven existing files and added one portable five-JD fixture. Hash comparison showed 593 of 600 starting files unchanged, with none missing. Three implementation files were `job-pull/candidate.mjs`, `job-pull/normal-readiness.mjs`, and `crawler/original-listing-resolver.mjs`; the remaining existing changes were their regression tests and STATUS.

Recorded checks passed: 39 focused tests, 890 full-suite tests, validation, safety, rehearsal, and `git diff --check`. Readiness's embedded 890 tests passed, but its outer exit 1 was preserved. No new product tests were run while preparing this documentation.

Useful evidence:

- [Final repair report](../.local/bugfix-recheck-2026-10-07/RESULTS.md), [structured summary](../.local/bugfix-recheck-2026-10-07/summary.json), and [checks](../.local/bugfix-recheck-2026-10-07/checks-final.json).
- [Frozen replay](../.local/bugfix-recheck-2026-10-07/frozen/summary.json) and [7 October response replay](../.local/bugfix-recheck-2026-10-07/today-final/summary.json).
- [Exact saved-lead coverage](../.local/bugfix-recheck-2026-10-07/saved-lead-coverage.json), [selection result](../.local/bugfix-recheck-2026-10-07/selection-result.json), and [readiness assessment](../.local/bugfix-recheck-2026-10-07/readiness-final.json).
- [Portable Accenture fixture](../tests/fixtures/experience/accenture-captured-2026-10-06.json). The product tests do not depend on ignored temporary files.

The `.local/` evidence is ignored and machine-local. This document preserves the conclusions, but those links will not travel with a clean clone. Preserve the evidence folders if resuming elsewhere. Replay commands are in the final report; an offline replay is not fresh discovery. Do not repeat the retained model call merely to reproduce a report.

No applications, outreach, user-owned checkbox edits, live Notion delivery, credentials, schedules, commits, pushes, or production promotion occurred in the recent source trials and verifier repair pass. No task process or dev server remained running at their handoff. This document introduces no such action. No secrets are copied into it.
