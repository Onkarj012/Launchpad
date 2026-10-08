# Launchpad recovery next steps

This plan follows the [first-pass results](../reports/launchpad-recovery-results-2026-10-02.md), including the parent's nine successful public captures and the offline replay. The twelve-request budget is consumed. The completed experiment used no delivery, credential, setting, schedule or promotion changes. Subsequent experiments should set and retain their own request budgets.

The next engineering priority is a narrow public LinkedIn detail stage. Three of three captured pages supplied a usable JD, while the current resolver discarded that text at its aggregator boundary. Woodfrog is already visible in the needs-verification queue; it needs better evidence, not a weaker eligibility gate.

## 1. Retain bounded public LinkedIn detail evidence

Implement in `job-pull/portal-adapters/linkedin.mjs`, with a small separate parser/helper if needed. Dispatch it within the existing portal-resolution budget in `crawler/operator.mjs`, before final employment/experience screening. Avoid a second independent request budget or duplicate GET of the same detail URL.

The stage should:

- Fetch only configured public LinkedIn job detail URLs from already parsed cards. Deduplicate by LinkedIn job ID, share the parent signal, deadline, host limiter, byte cap and request cap, and checkpoint completed evidence.
- Parse JobPosting JSON-LD from the public response. Handle object, array and `@graph` forms, invalid JSON and missing descriptions. Verify the posting identity against the requested card rather than borrowing a related/recommended job.
- Retain description, observed employment type, exact portal date and any explicitly disclosed salary with `portal-detail-jsonld` field provenance, URL, observation timestamp and response digest. Unknown experience and salary remain unknown. Portal dates retain aggregator provenance.
- Cache the public detail response within the run so original-employer resolution can reuse it. Count one actual GET once. Stop on HTTP access blocks, login/challenge HTML, cancellation, deadline or budget exhaustion. No browser fallback or login bypass.
- Leave `originalApplicationUrl` unresolved and employer liveness `Not Verified` unless the separate original-employer resolver supplies its existing required evidence. A JobPosting on LinkedIn cannot promote a role to first-party ready status.
- Re-run the unchanged targeting policy after enrichment. Search-card eligibility is preliminary; a title without a JD cannot prove an acceptable experience requirement.

Use the saved sample before requesting any new live budget. The existing offline replay is `.local/recovery-2026-10-02/first-pass/offline-live-replay.mjs`. Extract small non-sensitive fixtures for lasting regressions rather than embedding entire public pages in the tracked tests.

Acceptance:

| Captured role | Required outcome |
| --- | --- |
| Woodfrog 4473136187 | Nonempty JD retained; October 2 portal date retained with provenance; unknown experience manual-review; salary `Not Verified`; needs-verification queue includes the exact lead; selected/ready remain zero without employer resolution. |
| Rasta 4473131541 | Explicit minimum 3 years rejects the role before scoring/ready delivery. |
| Cognologix 4433878985 | The stated 3–5 year requirement rejects the role before scoring/ready delivery. The current extractor reports 5; range extraction remains a separate accuracy limitation. |
| Access-block/malformed/cancelled detail fixtures | Truthful failure/verification reason; no fabricated evidence or post-cancellation requests. |
| Duplicate search cards and resolver reuse | One counted detail request per job ID, within the existing shared cap; checkpoint replay does not duplicate observations. |

The captured projection reduced the verification queue from seven to five by rejecting two unsuitable roles. That is a demonstrated evidence-quality improvement, not recovered ready-job volume. Validate the implemented stage with a bounded new capture and retained request accounting after these offline criteria pass.

## 2. Verify the surviving lead's employer route

Work from Woodfrog's retained public lead and JD. Investigate the actual application destination through the existing resolver/manual verification seam in a bounded read-only pass. Never infer first-party resolution from LinkedIn's company name, JobPosting object or HTTP 200.

Acceptance is either a supported employer/ATS application URL with existing resolution evidence and verified employer liveness, or a precise unresolved reason shown beside the lead. Keep the experience review visible. Undisclosed salary stays `Not Verified`, as allowed by current policy. No application is submitted, no contact is sent, and no user-owned checkbox changes.

Only then evaluate whether the candidate can enter the ready pool and the existing scorer. This plan does not promise that it will. If no original route is verifiable, retain the needs-verification lead and report that outcome.

## 3. Repair the independent baseline test failures

The full check ran 820 tests, with 808 passing and 12 failing. An isolated pre-edit reproduction ran the three failing files and reproduced the same twelve names. Consult `baseline-failure-comparison.json` and `baseline-failures.log` rather than treating the August documentation's 725-pass claim as the current result.

Investigate the two failures in `env-isolation-novelty.test.mjs`, two in `historical-suppression.test.mjs`, and eight in `workflow.test.mjs`. Separate stale fixtures from implementation defects using the current explicit eligibility, novelty, suppression and partial-run contracts. Do not make eligibility default to true to satisfy old fixtures.

Acceptance: relevant targeted tests establish reserve/identity behavior, historical suppression, repeated-run isolation and truthful partial states. Then one full required-check pass succeeds for that revision, or the remaining exact failures are reported. Keep this repair attributable and separate from portal detail implementation.

## 4. Trial targeted ATS planning without adopting production knobs

The two captured ATS boards returned 41 listings and zero policy-eligible observations. The offline bounded plan improves India-tagged allocation from 3/20 to 15/20, but historical eligible board matches only rise from five to six. Those measures are insufficient for changing production config.

Collect explicit public evidence for a small set of Pune/India-compatible early-career engineering boards in a bounded experiment with its own recorded request budget. Record normalized board identity, employer evidence, actual fetched roles, description availability, fresh eligible rows and ready rows. Include deferred board/lane reasons. Do not treat `India`, an `indiaFirst` tag or a reachable endpoint as sufficient hiring evidence.

Compare legacy versus bounded planning at the same board/request/time budget with the same targeting policy. Acceptance requires a retained improvement in fresh eligible JD-bearing leads and fair source completion, not only more fetched inventory or more India tags. Review registry metadata changes and production planner activation against those trial results. Keep production settings as found until outcome evidence supports adoption.

## 5. Measure the residual browser-detail gap

Only after public LinkedIn enrichment and the targeted ATS comparison, measure which viable leads still require rendered detail. Keep the existing four-provider capped fairness. For one authorized provider, compare plain HTTP versus rendered detail under identical deadlines, host limits and request/page accounting.

Acceptance requires additional usable JD or verified original-route evidence on eligible leads, a truthful no-results/error distinction, no access-control bypass, and browser cleanup on success, failure and cancellation. A longer-lived browser alone is not a recovery outcome. If there is no additional useful evidence, leave the browser lifecycle unchanged.

## 6. Keep delivery and promotion gates separate

The installed plists have no `--execute-writes`. This recovery pass changed no credential, schedule, Notion record, application or outreach state. Public lead captures and offline tests do not satisfy live write, resumed scheduled coverage, immutable release or seven-date promotion gates.

Before any future delivery, follow the existing scoped v5 transaction and operational-evidence contracts under a separate explicit request. Continue to display strict ready roles, shortage fallback and needs-verification leads separately. Recheck freshness at the execution clock and never count stale retained roles as recovered ready jobs.

## Handoff state

Completed locally: startup persistence, adapter-to-durable reporting, parser/filter corrections, provider fairness and truthful verification visibility. Successful live observations: parent public inventory and three LinkedIn JDs. Offline replay exit 0 with Woodfrog preserved, two experience exclusions enforced and zero application-ready rows.

Open: bounded public LinkedIn detail implementation, employer-original resolution, twelve baseline test failures, broader useful source yield and all delivery/promotion gates. The initial public-request budget is complete. The next concrete implementation is item 1; broad browser work and arbitrary cap/policy changes are deferred.
