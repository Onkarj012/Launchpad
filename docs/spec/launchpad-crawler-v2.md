# Launchpad Crawler v2: durable hybrid job discovery

Status: proposed

## Problem Statement

Onkar needs Launchpad to deliver a dependable morning queue of new-to-him, verified, application-ready jobs without pretending that the external market can guarantee ten suitable postings every 24 hours.

Launchpad v5 already has useful source adapters, normalization, eligibility, freshness, deduplication, selection, opportunity-history, audit, and Notion planning seams. Its discovery coverage and durable crawl state are still too limited for the desired operating cadence. The broad reverse ATS scan concentrates on a small provider set, arbitrary company career pages are not systematically discovered, public web search is not a first-class source lane, and connector or commercial rescue results do not yet flow through one durable source index.

Scratch artifacts and the current opportunity ledger can suppress previously surfaced roles, but they do not fully represent the lifecycle of a job across providers, URLs, observations, description changes, reposts, closures, application actions, source failures, and crawl runs. This makes it difficult to distinguish a genuinely new posting from a newly discovered older role, a refreshed listing, or a duplicate seen through another source.

LinkedIn and Indeed also require deliberate boundaries. An authenticated LinkedIn crawler would violate platform rules and introduce account risk. A direct Indeed scraper would be brittle and unnecessary when a separate connector can export structured results. Both sources should contribute discovery leads without weakening Launchpad’s requirement to resolve and verify the original employer or ATS listing.

The corrected daily outcome is therefore:

> Attempt to deliver 12–15 candidates each morning, with a target of at least 10 new-to-Onkar, verified jobs posted within the previous seven days, prioritizing jobs posted within 72 hours. When the market does not contain ten suitable jobs, report the shortfall plainly and never pad the shortlist with stale, senior, unresolved, or geographically invalid roles.

## Solution

Build a self-hosted Launchpad Crawler v2 as the durable discovery layer beneath the existing Launchpad v5 workflow.

The crawler will combine direct public ATS endpoints, structured company-career crawling, web-search discovery, startup and Indian job-board adapters, connector inboxes, manual LinkedIn rescue, and a paid feed used only when free lanes produce a verified shortfall. Every source will emit observations through a common source contract. Observations will be normalized, resolved to original application destinations, verified, deduplicated, and persisted in SQLite before selection.

SQLite will become the crawler’s durable operational truth for sources, companies, boards, jobs, observations, descriptions, crawl runs, and source failures. The existing Launchpad opportunity and application lifecycle remain authoritative for surfaced, applied, contacted, rejected, and cooldown state. The integration must preserve one coherent identity across crawler state, the opportunity ledger, and Applications v5 rather than creating a competing application tracker.

The morning selection contract will produce 12–15 candidates when inventory supports it:

- 6–8 strict full-time roles requiring 0–2 years and matching the permitted geography.
- 2–3 paid internships or explicit fresher, graduate, or new-grad roles.
- At most 2 controlled reaches whose stated minimum is two years and whose fit is exceptional.
- No undated, stale, unresolved intermediary, inactive, senior, or foreign-remote role in the application shortlist.

Candidates will be ordered by strictness and freshness: within 24 hours, within 72 hours, within seven days, paid internships, controlled reaches, and finally clearly labelled 7–14-day backfill only when the daily target remains unmet. Backfill does not count toward the seven-day minimum.

Contact research begins only after a user selects verified applications. For the strongest five to eight applications, Launchpad will seek up to two evidence-backed contacts per application and target ten useful contacts in total. Drafting and sending remain separate: the system may prepare up to six deeply personalized drafts, but it never sends messages or submits applications.

Delivery will proceed in four stages:

1. Crawler core: SQLite state, source contract, rate limiting, retries, conditional requests, run telemetry, and compatibility with the existing Launchpad pipeline.
2. Coverage expansion: additional ATS providers plus sitemap, feed, and `JobPosting` JSON-LD discovery.
3. External discovery: Brave Search, connector inboxes, startup and Indian board adapters, and shortfall-triggered commercial rescue.
4. Conversion: reserve queue, post-selection contact research, source-yield reporting, and weekly missed-role audits.

The first useful milestone is crawler core, expanded ATS coverage, generic structured career-page crawling, and Brave discovery.

## User Stories

1. As a job seeker, I want the daily goal defined as ten new-to-me verified jobs from the last seven days, so that Launchpad measures an achievable market-dependent outcome.
2. As a job seeker, I want jobs posted within 24 hours ranked first, so that I can apply early.
3. As a job seeker, I want jobs posted within 72 hours prioritized over older fresh jobs, so that the queue favors timely opportunities.
4. As a job seeker, I want the morning system to offer 12–15 candidates when inventory supports it, so that I can select at least ten worthwhile applications.
5. As a job seeker, I want the report to state when ten suitable jobs do not exist, so that weak roles are not used to manufacture a target.
6. As a job seeker, I want previously surfaced roles excluded from the new-job count, so that daily volume is truthful.
7. As a job seeker, I want reposts and materially refreshed jobs distinguished from unchanged duplicates, so that I can judge whether they deserve renewed attention.
8. As a job seeker, I want closed and expired jobs suppressed, so that I do not waste application time.
9. As a job seeker, I want strict roles requiring 0–2 years to form the majority of the shortlist, so that the queue matches my new-grad profile.
10. As a job seeker, I want paid internships and explicit fresher or graduate roles represented separately, so that they are not crowded out by full-time jobs.
11. As a job seeker, I want no more than two controlled reaches, so that aspirational roles do not dilute the practical queue.
12. As a job seeker, I want a controlled reach to require exceptional skill fit and no more than a stated two-year minimum, so that reaches remain credible.
13. As a job seeker, I want undated roles routed to verification rather than the shortlist, so that freshness claims are evidence-backed.
14. As a job seeker, I want unresolved aggregator and intermediary links excluded from application-ready results, so that every shortlist item has an original destination.
15. As a job seeker, I want India, Pune-metro, and genuinely India-compatible remote eligibility verified, so that foreign-only remote jobs are excluded.
16. As a job seeker, I want 7–14-day roles used only as labelled backfill, so that they never masquerade as fresh inventory.
17. As an operator, I want one durable crawl database, so that discoveries survive process restarts and daily scratch cleanup.
18. As an operator, I want every job to retain first-seen, last-seen, and original posted timestamps, so that discovery time is not confused with posting time.
19. As an operator, I want every fetch represented as an observation, so that source history can be audited without overwriting prior evidence.
20. As an operator, I want provider job IDs retained, so that stable ATS identities are preferred over fuzzy matching.
21. As an operator, I want canonical application URLs retained, so that the same role found through multiple sources converges on one job.
22. As an operator, I want company, normalized title, and normalized location used as a fallback identity, so that cross-source duplicates can be detected when provider IDs differ.
23. As an operator, I want JD fingerprints retained, so that description changes and reposts can be detected.
24. As an operator, I want source provenance retained through selection, so that every result explains where it was discovered and where it was verified.
25. As an operator, I want the crawler state reconciled with the existing opportunity ledger, so that surfaced, applied, contacted, rejected, and cooldown state stays coherent.
26. As an operator, I want source failures stored with run and host context, so that recurring coverage problems can be diagnosed.
27. As an operator, I want scratch JSON available for debugging, so that individual runs remain inspectable without making scratch files authoritative.
28. As an operator, I want public structured ATS endpoints preferred over HTML scraping, so that discovery is more stable and respectful.
29. As an operator, I want Greenhouse, Lever, Ashby, and Workday coverage preserved, so that current productive sources remain intact.
30. As an operator, I want SmartRecruiters, Workable, Teamtailor, Recruitee, Personio, BambooHR, Breezy, Comeet, Pinpoint, Rippling, SuccessFactors, Phenom, iCIMS, Jobvite, and Oracle coverage activated or discovered where public data permits, so that ATS recall expands.
31. As an operator, I want unsupported or private provider instances reported without breaking the full run, so that partial source degradation remains useful.
32. As an operator, I want productive known ATS boards scanned every three to four hours, so that new postings are found promptly.
33. As an operator, I want expanded ATS discovery scanned twice daily, so that broader coverage remains bounded.
34. As an operator, I want company career pages discovered through known domains, sitemaps, feeds, and career links, so that nonstandard employers enter the corpus.
35. As an operator, I want `JobPosting` JSON-LD parsed from individual job pages, so that dates, locations, employment types, and descriptions use structured evidence.
36. As an operator, I want sitemap `lastmod`, `ETag`, `Last-Modified`, and content fingerprints used for incremental revisits, so that unchanged pages are not repeatedly downloaded.
37. As a responsible crawler operator, I want `robots.txt` honored, so that site crawling respects publisher directives.
38. As a responsible crawler operator, I want per-host concurrency and retry limits, so that Launchpad does not overload career sites.
39. As a responsible crawler operator, I want exponential backoff with jitter for transient failures, so that retries remain bounded and polite.
40. As an operator, I want terminal and retryable failures distinguished, so that invalid boards do not consume every run.
41. As an operator, I want Brave Search to discover unknown employers and job pages, so that direct-board coverage can grow beyond the existing company list.
42. As an operator, I want Brave queries generated from role family, geography, experience, ATS-domain, career-site, startup, and VC dimensions, so that the limited query budget covers diverse discovery paths.
43. As an operator, I want the Brave query budget configurable and observable, so that API credit usage remains controlled.
44. As a job seeker, I want search results treated only as leads until the original listing is resolved, so that snippets never count as verified jobs.
45. As an operator, I want resolved search leads to enrich the company and board directory, so that future discovery can use direct crawling.
46. As an operator, I want Indeed connector exports accepted through a dated inbox, so that Indeed can contribute without a custom scraper.
47. As an operator, I want connector payloads normalized through the same candidate contract, so that Indeed results receive identical verification and deduplication.
48. As an operator, I want malformed connector files quarantined with actionable errors, so that one bad import does not corrupt a run.
49. As an operator, I want imported connector files processed idempotently, so that reruns do not create duplicate observations.
50. As a job seeker, I want every Indeed lead resolved to the original employer listing when possible, so that intermediary URLs do not enter the shortlist.
51. As a LinkedIn user, I want LinkedIn discovery limited to saved searches, public search, and explicit manual rescue, so that my authenticated account is not crawled.
52. As a LinkedIn user, I want hiring-post authors captured with evidence during manual rescue, so that useful contact context is preserved.
53. As a LinkedIn user, I want LinkedIn URLs resolved to original employer or ATS pages, so that platform listings remain discovery evidence rather than application truth.
54. As an operator, I want Cutshort, Wellfound, YC, VC portfolio boards, Naukri, Foundit, and Hirist available as bounded source lanes where safe interfaces exist, so that India and startup coverage improves.
55. As an operator, I want brittle or authenticated portals to use connector, search, or manual rescue patterns, so that Launchpad does not depend on unsafe scraping.
56. As an operator, I want the commercial career-site feed disabled during healthy free runs, so that recurring cost stays controlled.
57. As an operator, I want commercial rescue triggered only when the verified candidate pool is below 12, so that paid retrieval addresses a measurable shortfall.
58. As an operator, I want the commercial rescue to try 24-hour inventory before seven-day inventory, so that paid results preserve freshness.
59. As an operator, I want commercial retrieval capped by configurable record and cost limits, so that a single run cannot create unexpected spend.
60. As a job seeker, I want agencies removed from commercial rescue where the provider supports it, so that original employers remain the priority.
61. As an operator, I want every source to emit a common manifest with counts, status, errors, duration, and freshness yield, so that source performance is comparable.
62. As an operator, I want one crawl-run outcome to show fetched, changed, resolved, verified, duplicate, suppressed, selected, and failed counts, so that the funnel is explainable.
63. As an operator, I want source degradation to be nonfatal when valid candidates can still be processed, so that one broken lane does not erase a useful morning run.
64. As an operator, I want database-integrity, identity, eligibility, selection, and downstream-plan corruption to be fatal, so that untrustworthy results are never published.
65. As an operator, I want a resumable run model, so that a process interruption does not require refetching every successful source.
66. As an operator, I want run stages to be idempotent, so that safe retries do not multiply jobs, observations, or downstream operations.
67. As an operator, I want the morning schedule to run warm ATS, expanded ATS, career pages, web discovery, connector import, normalization, and selection in order, so that dependencies are explicit.
68. As an operator, I want a lightweight midday scan, so that jobs posted after the morning run can be surfaced promptly.
69. As an operator, I want source schedules configurable rather than hard-coded, so that cadence can evolve without code changes.
70. As a job seeker, I want contact research to begin only after I select applications, so that research effort is not spent on rejected candidates.
71. As a job seeker, I want contacts prioritized by hiring-post author, recruiter, engineering manager, team lead, and small-company founder or CTO, so that each lead has a plausible relationship to the role.
72. As a job seeker, I want up to two contacts per selected application, so that outreach has useful redundancy without becoming indiscriminate.
73. As a job seeker, I want ten verified contacts across the best five to eight applications, so that outreach quality is tied to real opportunities.
74. As a job seeker, I want each contact to include current role, company relationship, evidence URL, channel, confidence, and relevance, so that I can verify the lead.
75. As a job seeker, I want contacts deduplicated by application, person, and channel, so that repeated discovery does not create duplicate outreach.
76. As a job seeker, I want guessed email patterns labelled unverified and excluded from verified contact counts, so that fabricated addresses are never presented as facts.
77. As a job seeker, I want up to six deeply personalized drafts prepared only for the strongest applications, so that effort is concentrated.
78. As a job seeker, I want all messages to remain drafts until I review and send them, so that outreach stays under my control.
79. As a job seeker, I want all applications to remain manual, so that the crawler never becomes an auto-apply system.
80. As an operator, I want a daily reserve queue separate from the final shortlist, so that replacements are available without weakening the selection contract.
81. As an operator, I want source-yield reporting by lane and provider, so that high-value coverage can be expanded.
82. As an operator, I want a weekly missed-role audit, so that false negatives are classified as query, discovery, resolution, parsing, gating, deduplication, or timing failures.
83. As an operator, I want invalid geography and experience false positives measured, so that quality can be improved against a target below ten percent.
84. As an operator, I want zero previously surfaced jobs mislabeled as new measured as a release gate, so that novelty remains trustworthy.
85. As an operator, I want application-to-response and response-to-screen conversion tracked, so that source quality is judged by outcomes rather than scrape volume.
86. As an operator, I want two-week success evaluated by median application-ready yield, fresh new-to-me yield, false-positive rate, novelty accuracy, contact yield, missed-role reasons, and conversion, so that rollout decisions use evidence.

## Implementation Decisions

- Extend Launchpad v5 rather than create a parallel job-search runtime. The crawler is a discovery subsystem; the existing eligibility, scoring, selection, opportunity, application, outreach, and manual-action contracts remain in force.
- Define the primary behavioral boundary as one crawl run. It accepts configured source plans, connector observations, prior durable state, and a clock; it returns committed crawl state, normalized candidates, a verification queue, a 12–15 candidate reserve, the application shortlist, source telemetry, shortfall reasons, and planned downstream operations.
- Preserve the existing normalized candidate contract as the handoff into Launchpad’s eligibility, freshness, deduplication, scoring, and selection pipeline. Extend it only with provenance and observation fields that cannot be represented today.
- Introduce a versioned source contract. A source declares its identity, lane, trust class, schedule, rate policy, cursor or conditional-fetch state, capabilities, and fetch result. A fetch result contains observations plus a manifest; it never writes application state directly.
- Classify source output as either a direct listing or a discovery lead. Only direct original employer or ATS listings can become application-ready. Leads must pass resolution first.
- Use public structured ATS endpoints where available. HTML parsing is a fallback for public pages that permit crawling and expose no usable structured endpoint.
- Preserve current Greenhouse, Lever, Ashby, and Workday coverage while expanding provider discovery to SmartRecruiters, Workable, Teamtailor, Recruitee, Personio, BambooHR, Breezy, Comeet, Pinpoint, Rippling, SuccessFactors, Phenom, iCIMS or custom JSON-LD, Jobvite, and Oracle.
- Treat provider activation as capability-based. A provider may support board discovery, listing enumeration, description retrieval, dates, locations, liveness, and application URLs independently. Missing capabilities must remain explicit.
- Build a generic company-career discovery lane that can locate career links, job sitemaps, general sitemaps, RSS or Atom feeds, and structured job pages from a canonical company domain.
- Parse `JobPosting` JSON-LD as structured evidence for company, title, description, `datePosted`, `validThrough`, employment type, job location, applicant location requirements, and application URL. Retain the source URL and raw evidence needed for audit.
- Make incremental fetching the default. Persist and reuse provider cursors, sitemap `lastmod`, HTTP `ETag`, HTTP `Last-Modified`, canonical URLs, and content fingerprints.
- Honor `robots.txt`. Apply configurable per-host concurrency, request spacing, timeouts, response-size limits, retry counts, exponential backoff, and jitter.
- Store crawler state in SQLite with foreign keys, uniqueness constraints, transactions, and schema migrations. Use write-ahead logging when compatible with the deployment environment.
- Model `sources` as configured discovery origins and their trust, cadence, and capability metadata.
- Model `companies` as canonical employer identities with domains and reusable verification state.
- Model `company_boards` as the relationship between a company and an ATS board, career root, sitemap, or feed, including provider configuration and fetch validators.
- Model `jobs` as durable canonical opportunities, not individual sightings.
- Model `job_observations` as append-only or immutable-enough sightings of a job from a source at a crawl time, including source identifiers, URLs, dates, liveness, and fingerprints.
- Model `job_descriptions` as content-addressed description versions so unchanged text is not duplicated and material changes remain auditable.
- Model `crawl_runs` as staged executions with schedule identity, start and finish times, status, counts, shortfall, and cost telemetry.
- Model `source_failures` as structured failure events with retry class, stage, host, source, response metadata safe to retain, and resolution state.
- Do not duplicate Applications v5, Outreach v5, or Activity v5 inside crawler state. If a local `applications` compatibility table is required for identity or offline suppression, treat it as a projection of the authoritative Launchpad lifecycle and define reconciliation explicitly.
- Resolve job identity in descending confidence: provider plus provider job ID; canonical original application URL; stable employer job identifier; company plus normalized title plus normalized location plus compatible posting window; JD fingerprint as supporting evidence.
- Keep discovery time, first-seen time, last-seen time, original posted date, updated date, and inferred repost date distinct.
- Treat a role as new-to-Onkar only when no matching durable job has been surfaced previously and no authoritative application or suppression state says otherwise.
- Treat a description or timestamp change as a refresh, not automatically as a new role. A repost becomes eligible for renewed consideration only under an explicit repost policy and must retain linkage to the prior job.
- Reconcile SQLite job identity with the existing opportunity ledger and Applications v5 before novelty is assigned. Conflicts fail closed into verification.
- Keep scratch JSON as an optional debug export. It is reproducible output, not durable truth.
- Add a Brave Search source adapter around the existing configurable query matrix. Bound the daily query budget and record consumed queries and results.
- Generate Brave queries from target role families, Pune and Pune-metro, India remote, APAC or worldwide availability, fresher and 0–2-year terms, ATS domains, company career paths, startup sources, and VC portfolio sites.
- Resolve every web-search result to an original employer or ATS listing before verification. Successful resolutions may add or update companies and company boards for future direct scans.
- Implement a dated connector inbox for Indeed JSON. Validate each file against a versioned schema, ingest idempotently, quarantine invalid payloads, retain an import receipt, and pass valid records through ordinary resolution and verification.
- Do not build an Indeed scraper.
- Do not build an authenticated LinkedIn crawler. LinkedIn remains an explicit manual rescue, saved-alert, public-search, and original-listing-resolution lane.
- Use Indian and startup boards through public structured interfaces where available. For portals requiring authentication or hostile scraping, use connector, public search, manual rescue, or an explicitly approved third-party feed.
- Keep the commercial career-site feed as a disabled-by-default rescue source. Trigger it only after free lanes complete and the verified candidate reserve is below 12.
- Configure commercial rescue to query 24-hour inventory first, expand to seven days only on continued shortfall, prefer India and Pune-compatible roles, include full-time and paid internships, remove agencies when supported, and cap results at 100–250 per run.
- Record commercial records retrieved, estimated cost, filters, actor or dataset identity, and shortfall before and after rescue.
- Preserve the immutable Launchpad hard gates from the canonical targeting rules. Source expansion must never weaken geography, work authorization, experience, employment, fee or bond, liveness, date, or original-application requirements.
- Select in this order: strict within 24 hours; strict within 72 hours; strict within seven days; paid internships or explicit fresher roles; controlled reaches; labelled 7–14-day backfill.
- Target 12–15 reserve candidates. Aim for 6–8 strict full-time roles, 2–3 internships or explicit fresher roles, and at most 2 controlled reaches. Composition targets are constrained by quality and are never padding requirements.
- Count only new-to-Onkar verified jobs posted within seven days toward the ten-job goal. Report fresh strict count, reserve count, shortlist count, backfill count, verification count, and exact missing count separately.
- Preserve manual selection between discovery and contact research. The crawler does not autonomously start enrichment for every discovered role.
- After selection, reuse the Outreach v5 evidence and deduplication contracts to find up to two contacts per application and target ten verified contacts across the top five to eight roles.
- Prioritize contacts in this order: hiring-post author; relevant India or engineering recruiter; engineering manager; team lead or senior engineer; founder or CTO for companies of roughly fewer than 50 people.
- Require contact name, current role, company or team relationship, evidence URL, channel, confidence, relevance reason, and application-person-channel duplicate key.
- Treat guessed email patterns as unverified. They do not count toward verified contact targets.
- Produce no more than six deep personalized drafts per selected batch. Never send a message, create sent-state, check `Apply?`, or submit an application.
- Make source schedules configuration-driven. The intended operating schedule is 04:30 IST warm and expanded ATS, 05:15 career pages, 06:00 Brave and startup sources, 06:30 connector imports, 07:00 normalization and verification, 07:30 selection, and a lightweight midday scan.
- Allow overlapping source schedules to reuse host locks and durable cursors safely. A second run must not duplicate observations or downstream operations.
- Make source failure nonfatal when integrity is intact and other sources yield valid candidates. Make database corruption, invalid identity merges, broken hard-gate evaluation, inconsistent selection, or altered downstream plans fatal.
- Deliver in four independently reviewable stages: crawler core; coverage expansion; external discovery and rescue; conversion and audit.
- Treat crawler core plus expanded ATS, structured company crawling, and Brave discovery as the first production-useful milestone.

## Testing Decisions

- Prefer one high-level behavioral seam: a deterministic crawl-run execution supplied with fixture source responses, connector payloads, prior SQLite state, opportunity suppression state, configuration, and a fixed clock. Assert observable database state, normalized outputs, shortlist composition, novelty, shortfall, telemetry, and downstream plans.
- Test external behavior rather than private helper functions. A good test states what an operator or downstream Launchpad module observes after a run, not which internal parser functions were called.
- Reuse the repo’s existing workflow, run-audit, adapter, candidate, freshness, eligibility, deduplication, selection, opportunity-ledger, and outreach test patterns.
- Add source contract conformance tests that every adapter must pass: stable source identity, versioned manifest, deterministic normalization, bounded errors, correct direct-versus-lead classification, cursor or conditional-fetch persistence, and no application-state writes.
- Add provider fixtures only for provider-specific external formats. For each activated ATS, cover enumeration, pagination, job identity, description, posting date, location, liveness, and application URL when the provider exposes them.
- Add structured career-page fixtures for career-link discovery, sitemap indexes, job sitemaps, RSS or Atom feeds, multiple JSON-LD blocks, arrays and graphs, remote-location requirements, expired jobs, canonical URLs, and malformed structured data.
- Add conditional-fetch tests proving unchanged `ETag`, `Last-Modified`, sitemap `lastmod`, and content fingerprints avoid redundant description versions while updating last-seen state.
- Add robots and host-policy tests proving disallowed URLs are not fetched, per-host concurrency is bounded, retries respect classification, and terminal failures are not retried indefinitely.
- Add SQLite migration tests from an empty database and every released schema version. Assert foreign keys, uniqueness, transaction rollback, idempotent reruns, and recovery after an interrupted stage.
- Add identity tests for provider ID matches, canonical URL matches, cross-source duplicates, normalized company-title-location fallback, materially changed JDs, reposts, and ambiguous collisions routed to verification.
- Add novelty tests proving previously surfaced, applied, contacted, rejected, cooldown, and unchanged duplicate jobs are never labelled new.
- Add freshness tests for exact 24-hour, 72-hour, seven-day, and fourteen-day boundaries in the configured India timezone.
- Add selection tests proving the 12–15 reserve target, 6–8 strict preference, 2–3 internship or fresher preference, controlled-reach cap of two, and backfill labelling. Quality gates must override composition targets.
- Add shortfall tests proving the report states the exact deficit and never pads with undated, unresolved, inactive, senior, invalid-geography, foreign-remote, or stale roles.
- Add Brave adapter tests around a fake transport. Assert query-budget enforcement, lead classification, result deduplication, original-listing resolution, and board-directory enrichment without making live API requests.
- Add Indeed inbox tests for valid imports, malformed schema, quarantine behavior, duplicate files, partial records, import receipts, original-employer resolution, and crash-safe idempotency.
- Add LinkedIn boundary tests proving automatic source plans never invoke an authenticated LinkedIn fetcher and manual rescue output still passes ordinary verification and deduplication.
- Add commercial-rescue tests proving it remains disabled at or above 12 verified reserve candidates, triggers below 12 only after free lanes finish, tries 24 hours before seven days, respects result and cost caps, and records cost telemetry.
- Add degradation tests proving an optional source failure yields a degraded but useful run, while database integrity, identity ambiguity that would cause unsafe merging, or downstream-plan mutation produces a fatal no-write outcome.
- Add contact-pipeline tests at the existing Outreach v5 workflow seam. Assert research begins only for selected applications, returns no more than two contacts per application, deduplicates application-person-channel, rejects unsupported email verification, and never sends.
- Add schedule tests using a fake clock and scheduler boundary. Assert the intended IST cadence, missed-run recovery, non-overlapping host work, and the lightweight midday plan.
- Add a two-week replay harness over retained sanitized run artifacts. Report median application-ready yield, number of days with ten qualifying new-to-Onkar seven-day roles, invalid geo or experience rate, novelty mistakes, contact yield, per-source yield, shortfall reasons, and missed-role classifications.
- Do not make live third-party availability a required unit or pull-request test. Run bounded opt-in integration probes for public providers, Brave, and the commercial feed, with credentials and network dependencies clearly separated from deterministic verification.

## Out of Scope

- Guaranteeing ten suitable jobs posted within the previous 24 hours.
- Padding a shortlist to meet a numeric target.
- Auto-applying, checking `Apply?`, submitting forms, or changing application state without user confirmation.
- Sending email, LinkedIn messages, connection requests, or follow-ups.
- Authenticated LinkedIn crawling or scraping.
- Building a direct Indeed scraper.
- Bypassing authentication, CAPTCHAs, paywalls, robots directives, rate limits, or platform access controls.
- Treating aggregators, search snippets, or intermediary URLs as verified application destinations.
- Replacing Notion as the tracker of record for applications, outreach, activity, and outcomes.
- Migrating, modifying, archiving, or deleting Launchpad v3 or v4 data.
- Treating guessed email patterns as verified contact information.
- Activating every possible ATS provider in the first milestone.
- Building a general-purpose web crawler unrelated to job discovery.
- Providing a cloud resume-compilation or application-submission runtime.
- Committing to the current quoted Brave or commercial-feed pricing as a permanent architectural assumption; budgets remain configurable and must be checked operationally.

## Further Notes

- This specification is additive to the Launchpad v5 contract. Where it conflicts with the canonical targeting, gating, resume, outreach, or manual-action rules, the canonical Launchpad source of truth wins unless explicitly amended.
- The proposed SQLite schema includes `sources`, `companies`, `company_boards`, `jobs`, `job_observations`, `job_descriptions`, `crawl_runs`, and `source_failures`. The requested `applications` and `contacts` concepts should integrate with, or project from, the existing Applications v5 and Outreach v5 lifecycle rather than silently creating new authorities.
- The source contribution numbers are operating targets, not additive guarantees. The same job may be observed through several lanes.
- External source prices, allowances, provider coverage, schemas, and platform terms can change. They must be verified when an adapter is implemented or enabled.
- The initial two-week success criteria are:
  - Median 12 application-ready roles offered per day when market inventory supports it.
  - At least 10 new-to-Onkar verified roles posted within seven days when such inventory exists.
  - Fewer than 10% invalid geography or experience false positives.
  - Zero previously surfaced roles mislabeled as new.
  - Ten verified contact leads across selected applications on contact-research days.
  - Source-by-source yield and explicit missed-role reasons.
  - Application-to-response and response-to-screen conversion reporting.
- The highest-risk design question is authority ownership between SQLite, the existing opportunity ledger, and Notion. Implementation must define a one-way or explicitly reconciled state flow before adding any local `applications` or `contacts` tables.
- The testing seam described above is inferred from the existing Launchpad v5 workflow and test architecture and is recorded here because the invoked synthesis workflow forbids an interview. It should be revisited only if implementation reveals that the current crawl-run boundary cannot express a required external behavior.
