# LinkedIn detail recovery completion, 2026-10-03

The interrupted recovery pass is locally complete. The final suite passes **851/851** across 89 test files. Saved public responses pass through the real operator, SQLite persistence, a completed-run reopen, Normal screening and the visible local queue. No new live crawl or external write was made. Production readiness remains false.

This report supersedes the earlier implementation handoff in this file. It separates work recovered from the exited worker from the completion changes made in this session. The starting checkout was already heavily dirty; no release, commit, promotion or clean-tree claim is made.

## Recovered outcome

The exited worker's result was **failure**, not success. `.local/linkedin-recovery-2026-10-03/live-fix.exit` is `1`. `live-fix-events.jsonl` records a final targeted result of **96 passed, 1 failed out of 97**, followed by transport retries and a terminal HTTP 429. `live-fix-targeted-final.log/.exit` confirm that result.

The remaining failure was `the exact captured 30 enriched records finalize after checkpoints and survive store reopen`. It asserted that those records exceeded the ordinary 10,000-node JSON limit, but this particular representation did not. That assertion failed before its persistence assertions ran. The old **842/842** full-suite result was before these final fixes and is historical evidence only.

The worker had already added bounded collection/envelope serialization in `crawler/run.mjs` and `crawler/workflow.mjs`, plus company-history exclusion and ASCII/Unicode range handling in `job-pull/candidate.mjs`. The saved `live-fix-before/manifest.json` and before-copies identify those changes. `job-pull/eligibility.mjs` is byte-identical to that before-copy. These recovered changes were inspected and verified here, not attributed to this session as new implementation.

## Completion changes

- `job-pull/candidate.mjs`: narrow company-tenure exclusion to employer tenure context, preserving applicant requirements such as "We expect 3+ years of experience", "Our ideal engineer has 3-5 years of experience" and "Our company requires 3-5 years of experience". Product support duration is excluded. Explicit experience strings now preserve Unicode range lower and upper bounds, matching description parsing.
- `crawler/run.mjs`: include stored run telemetry in durable snapshots, with current source telemetry overlaid. The previous snapshot discarded persisted workflow telemetry; an idempotent operator rerun returned an empty verification queue despite the queue being present in SQLite. The repaired reader retains it without refetching.
- `tests/crawler/source-envelope-recovery.test.mjs`: remove the false threshold assertion, use the actual `.raw` persistence API, and prove a 120-record bounded batch exceeds the ordinary aggregate node limit but persists every row. Reject invalid individual records before any batch row is persisted. Test completed-run telemetry restoration.
- `tests/job-pull/experience-recovery.test.mjs`: cover employer history, genuine applicant language, description ranges, title ranges and explicit Unicode experience ranges without relaxing the three-year hard gate.

Recovered collection limits remain **10,000 records, 2,000,000 serialized bytes per record and 20,000,000 serialized bytes per collection/envelope**. Each record retains the existing **10,000-node and depth-32** limits. Undefined, cycles, excessive depth, nonfinite numbers, bigint, non-plain objects, symbol keys, sparse arrays and oversized records fail closed. Collections are split only at declared serialization boundaries. Invalid batches persist zero rows.

Portal detail extraction and destination identity enforcement were retained. JobPosting descriptions and dates remain portal evidence. No portal description sets employer liveness to Active, supplies a verified original application URL or bypasses destination employer and role/requisition identity. Existing mismatch, missing-identity and matching-destination regressions pass.

## Replay of the bounded live captures

Source evidence: `.local/linkedin-recovery-2026-10-03/trial-2026-10-02T21-46-47-249Z/`. Its original receipt remains unchanged. Its clock is `2026-10-02T21:46:47.248Z`.

The offline replay verifies SHA-256 digests and byte counts for **all nine original response bodies**, then supplies them through the same bounded trial/operator path. It reproduces the exact request order: three searches and six detail roles. Unknown URLs throw; `globalThis.fetch` throws. No synthetic response is used in this replay. The final transport replay ran before the snapshot repair; the retained database was then reopened with the repaired reader. No additional transport request was made by that reopen.

| Measure | Final replay evidence |
| --- | --- |
| Injected GETs / live requests | 9 / 0 |
| Fetched listings / retained SQLite observations | 30 / 30 |
| Retained descriptions | 5 |
| Operator counts | ready 0, verification 28, rejected 2, selected 0 |
| Normal queue and visible local report | strict ready 0, fallback ready 0, verification 18, rejected 12, selected 0 |
| Completed-run reopen | idempotent true, 30 observations, 5 JDs, 28 workflow verification entries, zero additional requests |
| Source status / run status | truncated / completed_with_failures |
| Source failed count / durable exception rows | 1 / 0 |

Operator verification counts include incomplete source-level placeholders; they are not the final eligibility queue. Normal and the renderer independently apply full targeting. Their 12 rejected rows carry **3 experience hard-minimum**, **6 title seniority** and **3 off-target title** reasons. No ready role is padded or scored.

| Captured detail | JD characters | Experience evidence | Final handling |
| --- | ---: | --- | --- |
| NEC Software Solutions, 4473721963 | 5,166 | Applicant minimum unknown; employer's 122/30 years ignored | Verification, manual experience review |
| NEC Software Solutions India, 4472169167 | 5,166 | Applicant minimum unknown; employer's 122/30 years ignored | Verification, manual experience review |
| Endava, 4472507956 | 4,047 | Required 3+ years | Rejected |
| Hitachi, 4471319619 | 5,162 | At least 5 years | Rejected |
| Zebra, 4472935139 | 4,868 | 0-1 years | Verification; original route and liveness unverified |
| Amazon, 4473984427 | 0 | Not extracted | Verification; portal posting identity mismatch |

The replay **still has completed_with_failures**. The six-role cap leaves 14 target-screened candidates unvisited, and the Amazon response fails `portal-detail-posting-identity-mismatch`. Source telemetry retains that error and `failed: 1`; the empty exception-row list does not erase it. JSON serialization errors are absent. Every retained observation has no verified original employer route and `Not Verified` liveness.

Artifacts under `.local/recovery-completion-2026-10-03/replay-final/`: `operator.json`, `crawler.sqlite`, `retained.json`, `normal.json`, `queue.md`, `reopened-queue.md`, `reopened-operator.json`, `summary.json`, `trial.json`, `counters.json` and response captures. The renderer queue was read and inspected, including NEC manual-review rows and explicit experience rejections. `replay-final-persistence.log/.exit` records the successful proof.

## Earlier saved-response acceptance replay

The original week-search capture and three complete detail bodies under `.local/recovery-2026-10-02/first-pass/` were also replayed through the actual operator and Normal selector, with SQLite reopen assertions. Ten observations persist. Eight injected requests comprise search and seven detail attempts. Four uncaptured detail pages receive explicitly synthetic 404 fixtures; those fixtures are coverage gaps, not live employer liveness evidence. No live request occurs.

- Woodfrog 4473136187 retains **2,542** JD characters and exact portal date `2026-10-02T10:16:32.000Z`; minimum experience and salary remain unknown, original route unresolved, liveness Not Verified.
- Rasta.Ai 4473131541 retains **3,705** JD characters, explicit three-year minimum and disclosed 6-8 LPA CTC; it is rejected before scoring.
- Cognologix 4433878985 retains **3,786** JD characters and its actual **3-5-year** range; it is rejected before scoring. The earlier report's range-accuracy limitation is now resolved.

Normal has **five verification leads and zero selected roles**. The local report has five rejected rows, including both experience failures. Evidence is in `replay-earlier/summary.json`, `offline-operator.json`, `offline-normal.json`, `offline-queue.md` and the isolated SQLite file. `replay-earlier.log/.exit` is exit 0.

## Verification results

All new evidence below is under `.local/recovery-completion-2026-10-03/`. Every started test/replay/check process has a retained PID and actual exit receipt and has completed.

| Check | Exact result | Receipt |
| --- | --- | --- |
| Focused regression, eight relevant files | 119/121; two failures corrected | `focused.log/.exit`, exit 1 |
| Affected experience checks only | 35/35 | `focused-affected.log/.exit`, exit 0 |
| Affected persistence/workflow/identity checks only | 62/62 | `focused-persistence.log/.exit`, exit 0 |
| `npm run validate` | Valid; no mirror or skill-contract issues | `validate.log/.exit`, exit 0 |
| `npm run safety` | All seven checks pass | `safety.log/.exit`, exit 0 |
| `npm test` | **851 passed, 0 failed, 0 skipped** | `full-tests.log/.exit`, exit 0 |
| `node crawler/cli.mjs readiness --run-tests` | All six groups, 89 files, 851/851; testExitCode 0; readiness false | `readiness.log/.exit`, exit 1 |
| `npm run rehearse` | Passed; zero external writes/network; five local fake writes | `rehearse.log/.exit`, exit 0 |
| `git diff --check` | Pass | `diff-check.log/.exit`, exit 0 |
| Final whitespace check after report edit | Pass | `diff-check-report.log/.exit`, exit 0 |

The first focused failures were a support-duration phrase incorrectly treated as applicant experience after narrowing the filter, and an invalid test candidate lacking required identity fields. Both were corrected, then only affected checks repeated. The source/persistence and destination-identity checks in that first pass had already passed. The final consolidated suite includes every regression.

The initial completion replay harness also assumed raw fields on the SQLite API wrapper and `jobId` on Normal verification DTOs. Those assertions were corrected to use `.raw` and discovery URL identity. Their failed logs remain. The subsequent reopen assertion exposed the real snapshot defect described above; after the repair, it passes. No failed receipt was replaced or presented as a pass.

`consolidated-results.json` contains exact commands, PIDs, timestamps and exits for the one consolidated pass. `readiness-summary.json` records **codeComplete true, productionReady false, operationallyVerified false**, with the sole failing assessment reason **OPERATIONAL_VERIFICATION_MISSING**. The operational exit was not suppressed. The final report edit affects only whitespace checking; the tests were not repeated afterward.

## Incremental review and preservation

This session changes exactly **five files**: `crawler/run.mjs`, `job-pull/candidate.mjs`, the two recovery tests above, and this report. The recovered worker also changed `crawler/workflow.mjs`; it was inspected and tested but not edited in this session. The saved original before-copy comparison is `recovered-live-fix.patch`. This session's exact starting bytes and hashes are in `starting-state/` and `starting-manifest.json`. `completion-diff.patch` and `completion-delta.json` isolate this session's edits from the existing dirty checkout.

The review covered actual parser behavior, lower-bound preservation, invalid-record persistence, declared aggregate bounds, snapshot restoration, original-route/liveness safety and destination identity regressions. No eligibility/readiness policy, configuration, schedule, credential, user-owned checkbox, `career-ops/`, adjacent implementation or existing capture was edited. No delegation, application, message, external write, Notion mutation, commit, push, publish or promotion occurred.

## Remaining gates and handoff

The implementation and offline persistence proof are complete. Operational adoption remains blocked by the repository's existing gates: verified employer-original routes and liveness, useful fresh yield and terminal coverage across configured sources, live eligible/scored shortlist delivery, a real checked-row resume/PDF proof, manually repaired credentials and a scoped live v5 proof, authenticated browser/Gmail evidence where required, a clean reviewed immutable candidate, seven valid same-version UTC canary dates with matching inventory/report pairs, and authorized schedule promotion/rollback proof. LP-009, LP-010 and LP-011 remain open as documented in `docs/STATUS.md`; no status file or issue was changed.

This pass did not recheck external issue status, live credentials, installed schedules or current source yield, and did not run a fresh crawl. Amazon detail identity rejection remains fail-closed; the diagnostic caps remain intentional. Operator queue totals are broader than Normal's strict queue and should not be presented as application-ready inventory. Final local handoff: `.local/recovery-completion-2026-10-03/handoff.json` and the visible `replay-final/reopened-queue.md`.
