# Launchpad Discovery Yield Improvement

Status: proposed

## Problem Statement

Onkar needs Launchpad to surface more genuinely recent, relevant, application-ready jobs without weakening its evidence, eligibility, freshness, or manual-control rules.

Launchpad can now retrieve substantial job inventory, but its 2026-07-24 production run showed that retrieval volume is not translating into useful opportunities. The scheduled crawler fetched 2,637 records, retained 763 observations after source filtering, found only six eligibility survivors, and produced no application-ready roles. A separate manual pipeline found one implementation-reported ready role, but that result depended on a Workday date that the canonical policy does not consider independently corroborated.

The loss occurs at several distinct layers:

- The scheduled crawler uses a narrower source registry than the manual reverse-ATS path that found the best candidate.
- A source-level geography regex discards records before the authoritative eligibility policy runs and does not recognize every allowed Pune alias or India-compatible remote scope.
- Workday summary records are classified before their detailed job descriptions, locations, requisition identifiers, and freshness evidence are hydrated.
- Durable crawler identity treats a previously observed job as not new even when later evidence makes it newly actionable, while the canonical policy intends cooldown to begin after surfacing or user action rather than raw observation.
- Provider cursor behavior can resume beyond the newest page and miss newly posted records.
- Search and portal leads are often stored without job description, original employer URL, location, posted date, liveness, or experience evidence, leaving them unresolved instead of useful.
- Match Score is not guaranteed before diversity selection, allowing company caps and composition rules to operate over unscored candidates.
- An unconfirmed salary floor is active even though the canonical targeting policy leaves that floor blank.
- Current reporting mixes source-filtered observations, overlapping gate evidence, freshness rejection, novelty, cooldown, and readiness in ways that can produce incorrect explanations for zero-yield runs.

Launchpad must improve fresh eligible yield, not merely raw fetched volume. It must also keep posted freshness distinct from discovery novelty: a job first seen today is not necessarily a job posted today.

## Solution

Improve Launchpad through three ordered layers: recover existing inventory, unify proven source coverage, then expand into additional structured sources.

First, correct the existing funnel. Remove or widen the premature geography filter so the canonical geo classifier makes the final decision. Hydrate plausible Workday records before policy evaluation. Separate observed, resolved, eligible, ready, surfaced, and actioned lifecycle states so a role can become newly actionable after later enrichment. Correct provider cursor semantics. Guarantee scoring before final selection. Remove the unconfirmed salary floor. Produce reconciled funnel telemetry that distinguishes first-failure counts from overlapping evidence.

Second, make the scheduled crawler consume one authoritative provider-aware board registry shared with the broader reverse-ATS path. Promote verified boards discovered from real jobs into this registry only after ownership, endpoint, location relevance, and evidence capabilities are confirmed. Add the existing Remote and Startup source families to scheduled discovery-only operation while preserving the same hard gates.

Third, add structured and resolvable discovery sources. Prioritize Personio XML feeds, Comeet careers feeds, remote-job APIs such as Himalayas, direct employer `JobPosting` JSON-LD, company sitemaps, India-focused VC portfolio boards, and provider-specific Brave Search queries. Treat every aggregator, search engine, remote board, and portfolio board as a lead generator until Launchpad resolves the original employer or ATS listing and verifies its evidence.

The improved system will maintain two independent time dimensions:

- Posted freshness: Hot, Active, Backfill, VerifyQueue, or Rejected, based only on accepted employer or provider evidence.
- Discovery novelty: newly observed, previously observed, materially refreshed, newly resolved, newly actionable, surfaced, or actioned.

A newly observed role with an unverified date may be prioritized in the verification queue, but it may not be represented as Hot. A previously observed role that later gains enough evidence to become application-ready may surface once as newly actionable. Only surfaced roles begin the seven-day cooldown; applied, contacted, interviewing, rejected, and equivalent action states remain permanently suppressed according to policy.

The primary outcome will be newly actionable, application-ready, never-surfaced roles per unit of request cost and verification effort. Raw fetched count remains diagnostic only.

## User Stories

1. As a job seeker, I want Launchpad to find more recent eligible roles, so that I can apply while opportunities are still fresh.
2. As a job seeker, I want retrieved volume separated from useful yield, so that a large crawl is not mistaken for a successful run.
3. As a job seeker, I want posted freshness distinguished from first discovery, so that Launchpad never claims a role was posted today merely because it was first seen today.
4. As a job seeker, I want uncorroborated Workday dates routed to verification, so that mutable requisition timestamps do not create false Hot labels.
5. As a job seeker, I want newly discovered undated roles prioritized for verification, so that promising opportunities are resolved before they become stale.
6. As a job seeker, I want roles that become application-ready after later enrichment surfaced once, so that incomplete first observations do not permanently hide valid jobs.
7. As a job seeker, I want cooldown to begin only after a role is surfaced, so that invisible crawler observations do not consume my opportunity window.
8. As a job seeker, I want applied, contacted, interviewing, and rejected roles permanently suppressed, so that actioned opportunities do not reappear.
9. As a job seeker, I want Pune aliases recognized consistently, so that roles in PCMC, Hinjawadi, Wakad, Baner, Kharadi, Magarpatta, Viman Nagar, and Talawade are not lost.
10. As a job seeker, I want explicitly India-compatible APAC, worldwide, global, and remote roles evaluated by the canonical geo policy, so that valid remote opportunities are not dropped early.
11. As a job seeker, I want explicit foreign-only remote roles rejected, so that broader source coverage does not weaken location authorization.
12. As a job seeker, I want hard minimums of three or more years rejected unchanged, so that increased yield does not come from senior-role padding.
13. As a job seeker, I want roles with up to two years separated as shortage fallback, so that relaxed inventory remains honest.
14. As a job seeker, I want unknown experience handled through evidence resolution rather than guesswork, so that unstated requirements do not become invented fresher eligibility.
15. As a job seeker, I want unpaid, volunteer, commission-only, contract, and disallowed employment rejected unchanged, so that broader coverage remains relevant.
16. As a job seeker, I want every final shortlist item linked to an original employer or ATS destination, so that I can apply through a trustworthy source.
17. As a job seeker, I want aggregator and search results excluded from the final shortlist until resolved, so that intermediary pages do not masquerade as application-ready jobs.
18. As a job seeker, I want every shortlist candidate scored before selection, so that company caps and role-family balance preserve the strongest candidates.
19. As a job seeker, I want Match Score and Response Likelihood populated for every selected role, so that ranking follows the canonical rubric.
20. As a job seeker, I want unconfirmed compensation floors disabled, so that roles are not rejected by assumptions I did not approve.
21. As a job seeker, I want no auto-apply or autonomous sending added by discovery improvements, so that all consequential actions remain under my control.
22. As an operator, I want one authoritative board registry shared by scheduled and manual discovery, so that a proven source cannot be missing from production scheduling.
23. As an operator, I want each board record to identify provider, tenant, company, ownership evidence, geography relevance, and capabilities, so that registry entries are auditable.
24. As an operator, I want boards promoted from real resolved leads, so that registry growth is backed by current evidence.
25. As an operator, I want newly proposed boards manually approved before activation, so that discovery cannot silently alter the production watchlist.
26. As an operator, I want source capabilities represented independently, so that listing enumeration, detail retrieval, date evidence, liveness, and application URL support are explicit.
27. As an operator, I want the scheduled crawler to use the same proven reverse-ATS coverage as manual runs, so that useful boards are not limited to interactive sessions.
28. As an operator, I want existing Normal, Startup, and Remote source families to feed one shared policy pipeline, so that mode differences do not create inconsistent eligibility behavior.
29. As an operator, I want remote feeds scheduled as discovery-only sources, so that valid India-compatible remote roles can be found automatically.
30. As an operator, I want startup and VC sources resolved directly rather than depending entirely on web-search indexing, so that portfolio jobs are discovered promptly.
31. As an operator, I want Workday list retrieval targeted by role and location, so that request budgets are spent on plausible records rather than arbitrary global pages.
32. As an operator, I want Workday details fetched only for plausible candidates, so that evidence quality improves without uncontrolled request volume.
33. As an operator, I want Workday requisition identifiers retained, so that distinct jobs are not collapsed by company-title-location fallback identity.
34. As an operator, I want original-page structured data preferred over search snippets, so that dates, locations, and employment facts use stronger evidence.
35. As an operator, I want `JobPosting` JSON-LD parsed from employer pages, so that custom career sites can provide structured details without provider-specific APIs.
36. As an operator, I want company career sitemaps and job sitemaps discovered, so that new job URLs can be found without full browser automation.
37. As an operator, I want sitemap modification timestamps treated only as page-change evidence, so that they are not misrepresented as posting dates.
38. As an operator, I want Personio XML feeds supported, so that structured startup and mid-market roles can enter the direct ATS pipeline.
39. As an operator, I want Comeet careers feeds supported when public company identifiers and tokens are available, so that additional startup inventories become structured sources.
40. As an operator, I want Himalayas used as the primary remote lead feed, so that worldwide and India restrictions are available in structured form.
41. As an operator, I want Remotive, Remote OK, We Work Remotely, and Jobicy used as secondary lead feeds, so that remote coverage improves without relying on one board.
42. As an operator, I want remote-board publication dates retained separately from employer posted dates, so that aggregator timestamps do not overstate freshness.
43. As an operator, I want India-focused VC portfolio boards scanned for leads and company discovery, so that high-growth startup coverage expands.
44. As an operator, I want Peak XV, Accel, Lightspeed, Antler, a16z, and similar boards treated as lead generators, so that outbound original listings remain authoritative.
45. As an operator, I want provider-specific Brave queries, so that limited query budget targets direct ATS and career URLs rather than broad portal category pages.
46. As an operator, I want search-engine freshness treated only as discovery evidence, so that index dates do not populate employer freshness.
47. As an operator, I want SearXNG health failures and unresponsive engines visible, so that a zero-result lane can be distinguished from a healthy empty market.
48. As an operator, I want portal URLs hydrated before gating, so that Hirist, Cutshort, Instahyre, and similar leads can be evaluated with real evidence.
49. As an operator, I want portal hydration to extract JD, location, date, liveness, provider, job ID, and original destination, so that verification has a complete fact set.
50. As an operator, I want login-heavy portals retained as manual or explicit rescue lanes, so that scheduled discovery does not depend on brittle authenticated scraping.
51. As an operator, I want Naukri, Internshala, Wellfound, LinkedIn, and similar sources excluded from unattended direct integration unless a supported interface exists, so that production remains stable and bounded.
52. As an operator, I want AICTE internships considered through conservative public-page extraction, so that paid India engineering internships can supplement full-time inventory.
53. As an operator, I want provider polling strategies tailored to endpoint behavior, so that generic cursor handling does not skip newest jobs.
54. As an operator, I want newest-first providers rescanned from page zero, so that newly posted roles are not missed after a completed prior scan.
55. As an operator, I want persisted cursors used for interrupted-run continuation rather than tomorrow's starting page, so that durability does not reduce freshness recall.
56. As an operator, I want complete-array feeds processed by stable row identity, so that artificial pagination does not cap inventories.
57. As an operator, I want page and item caps reported explicitly, so that bounded coverage is never mistaken for full coverage.
58. As an operator, I want every observation stored independently from surfacing state, so that durable discovery does not become accidental suppression.
59. As an operator, I want observed, resolved, eligible, freshness-verified, ready, surfaced, and actioned states represented distinctly, so that lifecycle transitions are auditable.
60. As an operator, I want materially refreshed jobs re-evaluated for readiness, so that improved evidence can make a role actionable without mislabelling it as a repost.
61. As an operator, I want ambiguous identity matches routed to verification, so that different requisitions are not incorrectly merged.
62. As an operator, I want V4 historical data available as a read-only snapshot, so that suppression uses auditable history beyond local crawler experiments.
63. As an operator, I want local test and rehearsal runs distinguished from production observations, so that development activity does not consume production novelty.
64. As an operator, I want every run report to show fetched, source-filtered, normalized, resolved, eligible, fresh, ready, newly actionable, suppressed, and selected counts, so that losses reconcile.
65. As an operator, I want first-failure counts to be mutually exclusive, so that totals explain exactly where candidates exited.
66. As an operator, I want overlapping gate evidence reported separately, so that hidden seniority and title problems remain visible even when geography failed first.
67. As an operator, I want source yield measured by fresh eligible and ready roles, so that high-volume low-value boards can be tuned or retired.
68. As an operator, I want request count, verification effort, and recurring cost included in source yield, so that expensive lanes justify themselves.
69. As an operator, I want Workday detail success, date corroboration, and request cost measured, so that enrichment remains bounded and useful.
70. As an operator, I want original-listing resolution rate measured, so that lead sources are judged by actionable outcomes.
71. As an operator, I want verification queues grouped by missing fact, so that date, location, liveness, experience, and original URL bottlenecks are visible.
72. As an operator, I want verification queue age measured, so that promising roles are resolved before their eligibility window expires.
73. As an operator, I want boards calibrated over seven- and twenty-eight-day windows, so that source decisions use repeatable evidence.
74. As an operator, I want a fourteen-day shadow evaluation before broad activation, so that uplift is demonstrated without corrupting production state.
75. As an operator, I want shadow results compared against the unchanged canonical gates, so that improvements measure better discovery rather than relaxed policy.
76. As an operator, I want daily reports generated from reconciled run data, so that narrative explanations cannot contradict stored counts.
77. As an operator, I want report assertions validated against artifacts, so that statements about cooldown, freshness, and suppression remain accurate.
78. As an operator, I want optional source failures to degrade gracefully, so that one broken board does not erase useful results from healthy lanes.
79. As an operator, I want identity, policy, database, and reporting-integrity failures to fail closed, so that untrustworthy jobs are never surfaced.
80. As an operator, I want the improved system to state honest market shortfalls, so that a narrow Pune and new-grad market is never padded to meet a numeric target.

## Implementation Decisions

- Extend the existing Launchpad Crawler v2 and Launchpad v5 discovery contracts rather than create another parallel runtime.
- Use one deterministic scheduled crawl run as the primary behavioral and testing seam. The run accepts source plans, durable crawler state, historical lifecycle state, configuration, and a fixed clock; it returns persisted observations, verification work, newly actionable roles, shortlist output, shortfall, and reconciled telemetry.
- Establish one authoritative provider-aware board registry consumed by scheduled, manual, Normal, Startup, and Remote discovery paths. Existing provider-specific configuration may be generated from or projected out of this registry during migration.
- Require manual approval before a newly discovered board becomes active production configuration. Automatic discovery may create board proposals and supporting evidence only.
- Remove positive India matching as a destructive source-level filter. Source adapters may discard only explicit incompatible records when evidence is unambiguous; canonical eligibility owns final geo decisions.
- Reuse the canonical geography policy and alias vocabulary across every source. Duplicate local regex policies are not authoritative.
- Add bounded Workday enrichment before readiness classification. List retrieval preselects plausible role and location records; detail retrieval supplies description, location, requisition identity, experience evidence, liveness, and freshness evidence.
- Treat Workday `startDate` or equivalent mutable requisition timestamps as provider evidence requiring corroboration under the canonical Workday exception. They do not independently produce Hot or Active status.
- Preserve separate fields for original posted time, provider publication or update time, source publication time, first observed time, last observed time, and evidence verification time.
- Add discovery novelty independently from posted freshness. Discovery novelty includes newly observed, unchanged, materially refreshed, newly resolved, newly actionable, surfaced, and actioned outcomes.
- Replace the current observation-based novelty gate with lifecycle-aware newly-actionable logic. A role may become newly actionable after later evidence resolution even when its canonical identity was observed earlier.
- Apply seven-day cooldown only after a role is surfaced. Preserve permanent suppression for applied, contacted, interviewing, rejected, and other terminal or actioned states defined by canonical policy.
- Keep material refresh distinct from repost. A description or date change triggers re-evaluation but does not automatically create a new opportunity.
- Prefer identity in descending confidence: provider plus requisition ID, canonical original application URL, stable employer job identifier, compatible company-title-location fallback, and description fingerprint as supporting evidence.
- Isolate development and rehearsal observations from production novelty state through separate databases or explicit environment/run authority.
- Correct provider cursor semantics. Newest-first sources begin each scheduled scan at the newest page. Persisted page state is for interrupted-run continuation or true stable cursors, not indefinite forward-only daily scanning.
- Process complete-array feeds using stable job identity and bounded full-feed handling rather than unsupported page parameters.
- Guarantee Match Score and required scoring dimensions before diversity, company-cap, and composition selection. Unscored eligible roles enter an explicit scoring queue and cannot silently compete as zero-score candidates.
- Disable the salary floor until the user confirms a value. Unknown salary remains unknown and does not fail eligibility.
- Build a reusable original-listing resolver and hydration stage. It follows public redirects and outbound links, fingerprints provider URLs, fetches original pages, extracts structured evidence, and returns explicit unresolved reasons.
- Treat search engines, aggregators, remote boards, startup boards, VC portfolio boards, and Indian portals as lead sources unless they already point to a verified original employer listing.
- Add a universal `JobPosting` JSON-LD extractor supporting direct objects, arrays, and graph wrappers. Retain raw evidence references needed for audit.
- Add sitemap and career-link discovery for verified company domains. Sitemap `lastmod` is modification evidence only and never substitutes for `datePosted`.
- Add Personio XML as the first new direct structured provider. Treat its creation timestamp with provider-specific confidence until publication semantics are proven.
- Add Comeet careers feeds when public company identifiers and tokens are available. Treat update timestamps as modification evidence rather than original publication dates.
- Schedule Himalayas as the primary structured remote lead source. Add Remotive, Remote OK, We Work Remotely, and Jobicy as secondary bounded feeds.
- Store remote-board publication timestamps separately from employer posting timestamps. Every remote lead must still resolve to an original listing and pass India authorization.
- Add India-focused VC portfolio boards as lead and registry-growth sources. Extract company, job, and outbound original career URLs; do not treat portfolio-board records as final evidence.
- Add Brave Search as a provider-specific direct-URL discovery layer with bounded query budgets, country localization, freshness filters for discovery prioritization, caching, and explicit result-resolution telemetry.
- Keep SearXNG optional. Report engine degradation and unresponsive-engine diagnostics rather than treating every successful HTTP response as a healthy search result.
- Keep Naukri, Internshala, Wellfound, LinkedIn, and other login-heavy or unsupported portals as manual, search-index, connector, or explicit Apify rescue lanes.
- Consider AICTE public internship listings as a bounded optional source. Missing publication evidence routes candidates to verification.
- Populate the read-only historical snapshot used for identity suppression. Preserve v4 as historical-only and do not write to legacy systems.
- Rebuild daily funnel reporting from persisted run facts. Report mutually exclusive first-failure counts and separate overlapping evidence counts.
- Make the primary source KPI newly actionable, application-ready, never-surfaced roles divided by requests, verification effort, and source cost.
- Retain raw fetched count, source-prefilter count, and observation count as diagnostics rather than success metrics.
- Deliver in three implementation stages: existing-funnel recovery, source-registry unification and resolver activation, then structured-source expansion.
- Preserve all Launchpad safety contracts: discovery-only scheduling, no auto-apply, no autonomous sending, no automatic user checkbox changes, no fabricated evidence, and no legacy runtime fallback.

## Testing Decisions

- Prefer one high-level deterministic scheduled-crawl seam. Supply fixture source responses, fixed clock, production-like configuration, prior crawler state, opportunity history, and historical snapshot; assert observable database state, verification output, newly actionable transitions, shortlist, shortfall, and telemetry.
- Test external behavior rather than private helpers. A good test describes what the operator, persisted state, or downstream Launchpad pipeline observes after a run.
- Reuse existing crawler workflow, source-adapter, identity, eligibility, freshness, readiness, selection, schedule, and report test patterns.
- Add a geo recovery test proving APAC, worldwide, global, remote, and all configured Pune aliases survive source ingestion and are decided by canonical eligibility.
- Add a foreign-location test proving explicit incompatible onsite or remote scopes remain rejected.
- Add Workday list-to-detail tests proving plausible candidates are hydrated before policy classification and irrelevant rows do not consume unrestricted detail requests.
- Add Workday freshness tests proving uncorroborated provider dates remain in VerifyQueue and independently corroborated dates can enter normal freshness classes.
- Add dual-time tests proving posted freshness and discovery novelty remain independent.
- Add lifecycle tests proving raw observation does not trigger cooldown, surfacing does trigger cooldown, actioned states remain suppressed, and a previously observed role can become newly actionable after enrichment.
- Add material-refresh tests proving evidence changes trigger re-evaluation without automatically creating a repost.
- Add identity tests proving provider requisition IDs and canonical original URLs distinguish separate requisitions that share company, title, and location.
- Add environment-isolation tests proving development and rehearsal observations do not affect production novelty.
- Add newest-first pagination tests proving each scheduled run examines page zero and does not resume indefinitely from yesterday's terminal page.
- Add interrupted-run tests proving a true continuation resumes safely without duplicating observations.
- Add complete-array feed tests proving inventories above the prior item cap are either fully processed within configured bounds or reported as explicitly truncated.
- Add scoring-order tests proving every selected role has a Match Score and Response Likelihood before company caps and role composition are applied.
- Add salary tests proving an unconfirmed null floor rejects no role and a future explicitly configured floor behaves predictably.
- Add original-listing resolver tests for direct ATS URLs, aggregator redirects, intermediate pages, canonical tags, unsupported destinations, loops, and unresolved outcomes.
- Add portal hydration tests proving a URL-only lead cannot enter the shortlist until JD, location, liveness, freshness evidence, and original destination satisfy policy.
- Add JSON-LD tests for single objects, arrays, graph wrappers, malformed blocks, multiple job postings, remote applicant-location requirements, expired jobs, and canonical application URLs.
- Add sitemap tests proving job URLs are discovered while static assets and general marketing pages are excluded. Assert sitemap `lastmod` never populates posted freshness.
- Add Personio and Comeet adapter contract tests using recorded deterministic fixtures. Cover identity, locations, descriptions, employment type, date semantics, and original application URLs.
- Add remote-feed contract tests proving aggregator timestamps remain source timestamps, India/worldwide restrictions are parsed, and unresolved employer destinations cannot become ready.
- Add portfolio-board tests proving outbound original links and company proposals are produced without treating board records as final application evidence.
- Add Brave tests using a fake transport. Cover query budgets, provider-specific queries, result deduplication, country localization, discovery freshness, resolver outcomes, and cache reuse.
- Add SearXNG diagnostic tests proving unresponsive-engine data and zero-result health are observable.
- Add board-promotion tests proving discovered provider tenants remain proposals until manually approved.
- Add reporting reconciliation tests proving all mutually exclusive first-failure categories sum to total observations and overlapping evidence is labelled separately.
- Add regression coverage for the 2026-07-24 artifacts: two stale eligibility survivors, four previously observed backfills, zero historical cooldown suppressions, unscored portal survivors, and the Workday freshness caveat.
- Add source-yield tests proving fetched count alone cannot rank a source above one producing newly actionable ready roles.
- Add a fourteen-day replay or shadow harness over sanitized retained artifacts. Report fresh eligible yield, newly actionable yield, original-resolution rate, Workday detail success, verification age, novelty mistakes, and request/cost efficiency.
- Do not require live third-party availability in unit or pull-request tests. Keep bounded opt-in integration probes separate from deterministic fixtures.
- Treat zero valid geo-prefilter losses, zero observation-only suppressions, complete preselection scoring, and reconciled reporting as release gates for the first stage.

## Out of Scope

- Weakening Pune onsite eligibility, India-compatible remote authorization, experience maximums, employment rules, liveness, freshness, or original-application requirements to increase counts.
- Guaranteeing a fixed number of suitable jobs when the external market does not contain them.
- Treating first-seen time, search-engine freshness, sitemap modification time, or aggregator publication time as an original employer posting date.
- Auto-applying, submitting forms, creating accounts, changing user-owned checkboxes, sending outreach, or recording sent state without user confirmation.
- Authenticated LinkedIn crawling or autonomous LinkedIn messaging.
- Building unsupported unattended scrapers for Naukri, Internshala, Wellfound, or other login-heavy portals.
- Activating paid commercial rescue by default.
- Migrating, writing to, archiving, or deleting v3 or v4 historical systems.
- Changing the frozen resume template or approved resume evidence.
- Making a salary decision on the user's behalf.
- Promoting newly discovered boards into production without manual approval.
- Using live external APIs as mandatory deterministic test dependencies.

## Further Notes

- The 2026-07-24 daily report should be corrected before it is used as an improvement baseline. Stored run data reports zero historical suppressions; the six eligibility survivors were two stale roles and four previously observed backfills.
- The implementation-reported Finastra role is a strong application candidate by title, location, description, and experience, but its Workday date evidence does not satisfy the canonical freshness exception without corroboration.
- Broad reverse-ATS discovery produced every portal-run eligibility survivor. Registry unification therefore has stronger observed value than indiscriminate source expansion.
- Workday hydration has immediate evidence-backed value because existing observations include Pune Associate Software Engineer roles whose list summaries did not provide enough structured facts for policy evaluation.
- The target of ten daily application-ready roles remains inventory-dependent. Pune onsite plus explicit India-compatible remote plus new-grad experience is intentionally narrow. Launchpad must report an honest shortfall rather than pad results.
- Recommended rollout order is: correct geo filtering, Workday hydration, lifecycle novelty, cursors, scoring, salary policy, and reports; then unify registries and activate resolution; then add Personio, remote feeds, Brave, portfolio boards, Comeet, JSON-LD, and optional AICTE coverage.
