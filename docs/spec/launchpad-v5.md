# Launchpad v5: free-first discovery and Notion workflow

Status: local-implementation-complete-live-gated

This local document is the implementation source of truth for the Launchpad v5 issue set.

## Problem Statement

Onkar needs a dependable daily job-search operating system that finds at least ten fresh, highly relevant, fresher-friendly opportunities, prioritizes original employer career pages, prepares role-specific resumes, supports high-quality human outreach, and keeps the complete application lifecycle coherent in Notion.

The current system cannot deliver that outcome reliably. Discovery depends operationally on a broad Apify pull that is not sustainable on the free allowance, while free direct sources are underused. The current application shortlist is fixed at ten and constrained by hard composition quotas even when more strong roles exist. Freshness, compensation, employment, and fallback rules do not match the intended policy. Important requirements embedded in job-description text can escape automated gates.

The operating contracts also disagree. The canonical agent skills are local and read-only, while older skills describe live Notion writes. Applications v4 contains contradictory checkbox and status state, incomplete original-ATS provenance, mixed freshness vocabularies, broken legacy relations, incomplete deduplication, and unused Activity and Referrals databases. Agents repeatedly rediscover database identifiers instead of using one stable integration. Resume selection, application confirmation, outreach, and follow-ups therefore require manual copying and produce competing sources of truth.

Onkar wants a clean Launchpad v5 rather than another layer on v4: a free-first, India-aware, company-career-page-first workflow that any local agent can run, with a new Notion system, explicit search modes, truthful shortage handling, transactional writes, autonomous queue reading, manual application/sending boundaries, and no initial migration from v4.

## Solution

Build Launchpad v5 as a new end-to-end workflow around one normalized and deduplicated daily discovery corpus, three user-facing discovery modes, a flexible 10–20 application-ready shortlist, a stable local Notion integration, and five clean v5 databases.

Normal mode will run without arguments and emphasize India-first discovery across direct ATS boards, Indian job portals, the connected Indeed source, startup sources, and native remote feeds. Startup mode will emphasize recently funded and actively hiring startups. Remote mode will emphasize roles that can engage someone working from India through employment, EOR, or stable full-time-equivalent contracting. All modes share the same hard gates and original-application resolution requirements.

The system will rank strict roles by freshness and fit, target at least ten and preferably twelve roles, include every application-ready role above the quality threshold up to twenty, and backfill transparently when strict inventory is insufficient. Full-time compensation will be informational. Internships will be a separate category with explicit stipend tiers.

Create Applications v5, Companies v5, Outreach v5, Activity v5, and Referrals v5 from scratch. V5 starts empty. The daily run writes only new verified roles and explicitly labelled backfill roles. A repository-owned local integration will use a fixed v5 manifest and credentials stored outside the repository. Agents will read `Make Resume` and `Applied?` directly, synchronize derived state idempotently, and never search for or write to archived databases.

Contact research will find one relevant person per shortlisted role where possible, deeply personalize the strongest five or six outreach attempts, and keep all sending manual. LinkedIn hiring-post discovery will be a separate manually invoked Codex computer-use rescue workflow rather than part of automatic morning discovery.

## User Stories

1. As a new-graduate job seeker, I want at least ten viable opportunities each day, so that I can maintain a serious application cadence.
2. As a new-graduate job seeker, I want the system to prefer twelve strong opportunities when inventory supports it, so that I have a useful daily buffer.
3. As a new-graduate job seeker, I want up to twenty excellent opportunities surfaced on unusually strong days, so that arbitrary quotas do not hide valuable jobs.
4. As a job seeker, I want shortfalls reported truthfully, so that weak or unresolved jobs are never disguised as good matches.
5. As a job seeker, I want jobs posted within twenty-four hours prioritized, so that I can apply before applicant pools become crowded.
6. As a job seeker, I want strong 24–72-hour and 3–7-day roles used in a clear fallback order, so that freshness relaxations remain visible.
7. As a job seeker, I want roles ranked by both freshness and fit bands, so that neither a weak new listing nor an excellent slightly older listing dominates incorrectly.
8. As a job seeker, I want only active original employer or ATS application destinations treated as application-ready, so that I do not waste time on stale aggregators.
9. As a job seeker, I want aggregator and search results retained as discovery leads until resolved, so that portal coverage improves recall without weakening evidence.
10. As a job seeker, I want Pune, Pimpri-Chinchwad, and Hinjawadi onsite or hybrid roles accepted, so that local opportunities match my constraints.
11. As a job seeker, I want global remote roles accepted when they can legally engage someone in India, so that geography does not unnecessarily limit my search.
12. As a job seeker, I want EOR and stable full-time-equivalent contractor roles accepted, so that legitimate global employment structures remain available.
13. As a job seeker, I want freelance, gig, commission, and unpredictable short-contract work rejected, so that the shortlist remains focused on stable employment.
14. As a job seeker, I want any timezone accepted, so that global roles are not filtered out based on working hours.
15. As a job seeker, I want full-time compensation displayed but not used as a hard minimum or ceiling, so that undisclosed or variable compensation does not hide suitable jobs.
16. As a job seeker, I want internships separated from full-time roles, so that their evaluation and application strategy remain distinct.
17. As a job seeker, I want internships paying at least INR 30,000 per month marked preferred, so that the strongest internships are obvious.
18. As a job seeker, I want internships paying INR 25,000–29,999 marked as lower-stipend opportunities, so that I can decide whether they are worthwhile.
19. As a job seeker, I want lower and unknown internship compensation rejected or routed to verification appropriately, so that compensation evidence is never invented.
20. As a job seeker, I want role-family and company-stage diversity reported without hard quotas, so that ten strong new-grad roles can all be surfaced together.
21. As a job seeker, I want a normal mode requiring no arguments, so that the daily workflow remains easy to remember.
22. As a job seeker, I want normal mode to prioritize Indian job portals and India-relevant employer pages, so that discovery focuses on employers more likely to hire me.
23. As a job seeker, I want Naukri, Foundit, Hirist, Cutshort, Instahyre, Peerlist, LinkedIn Jobs, and Indeed covered, so that Indian-market discovery is not dependent on one portal.
24. As a job seeker, I want portal results verified against employer-owned application pages, so that search snippets never masquerade as reliable job evidence.
25. As a job seeker, I want a startup mode, so that I can focus on recently funded and actively hiring companies.
26. As a job seeker, I want funding within the previous eighteen months recorded as a company signal, so that aggressive hiring potential is visible without confusing it with job freshness.
27. As a job seeker, I want a remote mode, so that I can focus the daily corpus on work-from-home opportunities available from India.
28. As a job seeker, I want modes to change source emphasis and ranking without weakening hard gates, so that focused searches remain trustworthy.
29. As a job seeker, I want direct ATS boards and the warm reverse scan used daily, so that cheap, high-trust discovery remains the core.
30. As a job seeker, I want the full reverse ATS crawl available weekly or on demand, so that the warm set can discover new productive employers without slowing every morning.
31. As a job seeker, I want native Himalayas, Jobicy, We Work Remotely, and Remotive feeds used directly, so that remote discovery does not pay for redundant scraping.
32. As a job seeker, I want Apify removed from the required daily path, so that the system works without a subscription or exhausted credit allowance.
33. As a job seeker, I want selected Apify actors retained only as explicit rescue profiles, so that difficult Indian portals remain available when free discovery is insufficient.
34. As a job seeker, I want individual source failures reported without destroying a healthy run, so that partial coverage remains useful and honest.
35. As a job seeker, I want eligibility, scoring, deduplication, readiness, or ledger failures to stop the run, so that corrupted results never reach Notion.
36. As a job seeker, I want `/linkedin-leads` suggested when the verified pool remains substantially short, so that hiring posts can supplement normal discovery.
37. As a Codex user, I want LinkedIn hiring-post discovery manually invoked, so that it never drives my authenticated account automatically in the background.
38. As a Codex user, I want LinkedIn computer use to read posts but never apply, connect, or message, so that I retain control of account actions.
39. As a job seeker, I want LinkedIn posts containing forms, referral invitations, or DM requests captured with their associated person, so that hidden-market opportunities become actionable.
40. As a job seeker, I want every LinkedIn-derived role to pass the same ATS resolution, freshness, eligibility, and dedup gates, so that rescue discovery does not lower quality.
41. As a Notion user, I want an entirely new v5 workspace model, so that v4 mistakes are not inherited structurally.
42. As a Notion user, I want Applications, Companies, Outreach, Activity, and Referrals to have distinct responsibilities, so that the operating tables remain understandable.
43. As a Notion user, I want v5 to start empty, so that the first production run can validate the new model without historical contamination.
44. As a Notion user, I want v3 and v4 untouched during initial implementation, so that historical information remains recoverable.
45. As a Notion user, I want application rows to show compact operating fields while retaining detailed evidence, so that daily review is fast without losing auditability.
46. As a Notion user, I want dedicated views for ready roles, backfill, internships, startups, remote roles, verification, resume building, applying, outreach, follow-ups, pipeline, and archive, so that each task has a focused queue.
47. As a Notion user, I want Companies v5 to store canonical domains, career pages, ATS configuration, stage, funding, locations, remote policy, and verification state, so that company evidence is reusable.
48. As a Notion user, I want company find-or-create behavior to be deterministic, so that minor naming variations do not create duplicate companies.
49. As a Notion user, I want backfill rows written with exact selection tier and relaxation reasons, so that I can filter them without losing application options.
50. As a Notion user, I want unresolved roles separated into Needs Verification and excluded from the minimum ten, so that uncertainty is visible.
51. As a Notion user, I want `Make Resume` to be the only manual resume-selection checkbox, so that queue intent is unambiguous.
52. As a Notion user, I want `Applied?` to represent confirmed submission only, so that application history remains truthful.
53. As a Notion user, I want agents to read checked queues autonomously, so that I never have to paste company and role lists into chat.
54. As a Notion user, I want derived statuses and dates synchronized from confirmed actions, so that checkboxes, views, and follow-ups cannot disagree.
55. As a Notion user, I want status synchronization to be idempotent, so that repeated agent runs do not duplicate Activity events or reset dates.
56. As a Notion user, I want application statuses limited to meaningful lifecycle outcomes, so that resume and outreach details do not overload one status property.
57. As a job seeker, I want a separate resume sub-state, so that selecting a role does not falsely claim its PDF is ready.
58. As a job seeker, I want resume status set to Ready only after compilation and verification succeed, so that every ready artifact is usable.
59. As a job seeker, I want one relevant person researched for each shortlisted application where possible, so that each application has a human path.
60. As a job seeker, I want the strongest five or six applications to receive deeply personalized outreach, so that effort is concentrated where it can matter most.
61. As a job seeker, I want lighter LinkedIn or public-email contact paths for the remaining roles, so that broader coverage does not require generic mass messaging.
62. As a job seeker, I want public company pages, hiring authors, public profiles, Apollo discovery, limited Hunter credits, and optional Vibe used in that order, so that outreach remains free-first.
63. As a job seeker, I want missing verified email to be reported rather than fabricated, so that public profiles and messaging remain valid alternatives.
64. As a Notion user, I want Outreach rows keyed by application, person, and channel, so that repeated contact attempts are deduplicated correctly.
65. As a Notion user, I want long outreach drafts stored inside the Outreach page with only a preview in the table, so that tables remain readable.
66. As a job seeker, I want all applications and messages sent manually, so that agents never submit or communicate on my behalf.
67. As a job seeker, I want outreach scheduled for Day 0 with follow-ups on Days 3 and 10 and silent closure on Day 17, so that contact cadence remains consistent.
68. As a job seeker, I want follow-ups stopped immediately after a reply, rejection, opt-out, or role closure, so that outreach remains respectful.
69. As an agent user, I want one local Notion CLI shared by Claude, Codex, and future agents, so that database behavior does not depend on one connector.
70. As an agent user, I want a fixed v5 manifest, so that agents never rediscover or accidentally target archived databases.
71. As a security-conscious user, I want Notion credentials stored outside the repository, so that secrets never enter source control or prompts.
72. As a security-conscious user, I want the integration scoped only to v5 databases, so that unrelated workspace content and legacy databases cannot be modified.
73. As an operator, I want transactional reserve, write, verify, and commit behavior, so that partial Notion failures are recoverable and visible.
74. As an operator, I want a dry-run mode, so that discovery and payload behavior can be rehearsed without live writes.
75. As an operator, I want source telemetry and exact shortfall reasons, so that weak source lanes can be repaired rather than guessed about.
76. As an operator, I want a simple command surface for morning discovery, resume building, outreach, LinkedIn rescue, follow-ups, and synchronization, so that the end-to-end workflow is memorable.
77. As an operator, I want all existing and new verification gates to pass before go-live, so that v5 never silently falls back to v4.
78. As an operator, I want historical v4 migration handled by a later, separately approved reconciliation process, so that initial v5 delivery remains safe and reviewable.

## Implementation Decisions

- Treat the canonical agent skill package as authoritative. Make the Claude-specific skill package a compatibility surface that points to or mirrors the same contracts without maintaining divergent behavior.
- Preserve the existing deterministic normalization, eligibility, freshness, deduplication, scoring, selection, and ledger core where its behavior remains valid. Redesign source orchestration, selection policy, Notion integration, state synchronization, and skills around it.
- Build one normalized discovery corpus per run. Modes are named source/ranking plans over that corpus, not separate schemas or weakened policy variants.
- Expose exactly three discovery modes initially: `normal` by default, `startup`, and `remote`. Do not expose role-family modes or scheduling in this version.
- Make normal mode India-first in query budget. Use bounded, freshness-focused discovery across Indian portals and the connected Indeed source. Treat every portal result as provisional until the original employer application is resolved.
- Use direct employer ATS data as the highest-trust source. Use startup boards, native feeds, search, connectors, LinkedIn posts, and paid actors as progressively lower-trust discovery sources.
- Run tracked ATS boards, the warm reverse ATS scan, selected native public feeds, bounded search, watchlist coverage, and mode-specific sources daily. Keep the full reverse scan manual, weekly, or explicitly requested.
- Replace paid Apify indirection for Himalayas, Remotive, and We Work Remotely with their native free interfaces. Repair supported pagination and limits rather than requesting unsupported page sizes.
- Keep selected Indian-portal Apify actors disabled as manual rescue profiles. Missing tokens, depleted credits, actor errors, or schema drift must never break the normal workflow.
- Preserve source-level provenance through normalization. Do not collapse actor, portal, provider, source category, discovery URL, and original application URL into one generic source value.
- Define daily volume as minimum 10, preferred 12, maximum 20. Include all application-ready roles above threshold up to 20. Replace fixed role/source quotas with reporting and soft ranking goals.
- Introduce an explicit ≤24-hour freshness tier. Use the agreed freshness-and-fit bands before conversion score, response likelihood, source quality, and exact skill coverage tie-breakers.
- Use this shortage waterfall: strict ≤24 hours; strict 24–72 hours; strict 3–7 days; fresh roles requiring up to two years; fresh adjacent roles; relaxed 3–7-day roles. Never relax immutable gates.
- Require original application resolution, active liveness, coherent company evidence, permitted geography/employment, no hard 3+ year minimum, and no fee/bond concern for application-ready status.
- Extract location, citizenship/authorization, experience, employment type, internship stipend, fees, bonds, and seniority from title and description evidence before eligibility. Unknown evidence remains unknown.
- Remove the full-time salary floor from hard eligibility. Keep disclosed compensation as a preference and display field.
- Model employment category explicitly: full-time employee, internship, and stable full-time-equivalent Contractor/EOR. Reject unstable freelance and gig arrangements.
- Model internships as a separate category. INR 30,000+ is preferred; INR 25,000–29,999 is lower-stipend; below INR 25,000 is rejected; unknown stipend is verification-only.
- Record company stage using Startup, Scale-up, Mid-size, or Enterprise. Treat funding within 18 months as a company hiring signal, not evidence that a job itself is fresh.
- Create five new v5 databases and do not mutate the v4 schema in place. V5 begins empty and receives only new-run data during initial rollout.
- Applications v5 owns one job/application lifecycle. Companies v5 owns reusable company identity and sourcing evidence. Outreach v5 owns one application-person-channel sequence. Activity v5 owns immutable dated events and due actions. Referrals v5 owns referral relationships and outcomes.
- Separate primary operating fields from evidence fields in Applications. Primary fields cover role, company, status, manual inputs, original application, freshness, scores, work/employment category, tier, role family, company stage, resume state, outreach state, and next action. Evidence fields cover source, identifiers, timestamps, liveness/readiness, requirements, relaxation, rationale, hook, run identity, and synchronization metadata.
- Create focused views for Today's Ready, Today's Backfill, Internships, Startup Roles, Remote Roles, Needs Verification, Make Resume Queue, Resume Ready/To Apply, Applied Tracker, Outreach Review, Follow-up Due, Pipeline, and Closed/Archive.
- Treat `Make Resume` and `Applied?` as user-owned inputs that agents never check. Retire `Apply?` from the canonical model.
- Use application lifecycle statuses Ready, Applied, Interviewing, Offer, Rejected, Withdrawn, Not Pursuing, and Closed/Expired. Keep resume and outreach state orthogonal.
- Use resume states Not Started, Building, Ready, Failed, and optionally Stale. Set Ready only after the final PDF passes compilation and verification.
- On first observation of `Applied? = true`, idempotently set application status, preserve or stamp the application time when known, append one Activity event, and update cross-day suppression. Never invent a historical application date.
- Derive contact summaries and follow-up state from Outreach and Activity records instead of maintaining independent manual booleans as competing truth.
- Store compact outreach metadata in database properties and the complete message in the page body. Keep public evidence, contact channel, draft location, sent confirmation, next eligible contact, response, outcome, and deterministic duplicate key.
- Research contacts during morning preparation where feasible. Draft deep outreach after the corresponding resume is ready. Normally send after applying; allow referral-first drafting when a hiring post explicitly invites it.
- Build one repository-owned Notion gateway/CLI using a versioned v5 manifest. Store credentials outside the repository. Scope the integration to v5 databases and refuse legacy, unknown, or undeclared database identifiers.
- Support queue queries, transactional creates, validated property updates, relation creation, append-only Activity events, idempotent synchronization, pagination, rate-limit backoff, and structured error reporting through the gateway.
- Use reserve → write → verify → commit for live application writes. Abort failed reservations and list failed rows. Never report a successful run while selected rows are unaccounted for.
- Keep `/morning`, `/morning startup`, `/morning remote`, `/make-applications`, `/outreach`, `/linkedin-leads`, `/followups`, and `/sync` as the public workflow surface.
- `/morning` writes verified results because explicit invocation authorizes that bounded mutation. It must stop before writes when the v5 manifest, readiness core, deduplication, scoring, or ledger preflight is unhealthy.
- Individual source failures are nonfatal and visible. Core policy/integrity failures are fatal. A shortfall after all allowed backfill writes valid roles, reports the gap, and suggests LinkedIn rescue.
- Do not schedule discovery in this version. Do not auto-apply, auto-send, auto-connect, or automatically invoke authenticated LinkedIn computer use.
- Do not migrate, archive, or delete v3/v4 during this scope. A later migration requires its own dry-run reconciliation report and explicit approval.

## Testing Decisions

- Test externally observable workflow behavior rather than private helper structure. A good test supplies source records and user-controlled state, runs the highest available public workflow, and asserts the shortlist, audit report, Notion operations, state transitions, and failure outcome visible to an operator.
- Use one primary high-level seam: execute the complete morning orchestration with fixture-backed source adapters, an injected clock, deterministic scoring inputs, and a fake Notion v5 gateway. Assert normal/startup/remote behavior, 10/12/20 bounds, fallback ordering, source telemetry, transactional writes, queue reading, and idempotent synchronization through this seam.
- Extend the existing fixture-backed pipeline/run-audit test style rather than creating browser-dependent end-to-end tests for deterministic policy.
- Preserve focused adapter contract tests for ATS providers, Indian portal preparation, Indeed input, native remote feeds, funding/startup inputs, and LinkedIn-lead ingestion. Assert normalized evidence and source provenance, not implementation-specific HTTP call counts unless required by an external API contract.
- Add eligibility contract cases for global remote authorization, citizenship exclusions, Pune-metro onsite/hybrid, stable Contractor/EOR work, unstable freelance work, hidden experience requirements, fees/bonds, and internship stipend tiers.
- Add freshness and selection contract cases for the ≤24-hour tier, freshness-and-fit bands, minimum/preferred/maximum volume, unlimited same-family strong inventory within the maximum, and the complete relaxation waterfall.
- Add original-application readiness cases proving that portal/search/LinkedIn leads cannot enter ready output until resolved, while unresolved leads remain visible in Needs Verification and do not count toward ten.
- Add provider behavior for supported Himalayas pagination/limits, Remotive's delayed inventory classification, optional connector absence, partial portal failure, Apify rescue failure, and source-provenance preservation.
- Add Notion gateway contract tests against a fake transport for manifest scoping, pagination, retries, rate limits, property mapping, deterministic company find-or-create, relation integrity, unknown-ID refusal, and structured errors.
- Add transaction tests covering reservation, successful write/verification/commit, individual write failure/abort, crash recovery, duplicate runs, and truthful partial-failure reporting. Reuse the existing ledger state tests as prior art.
- Add state-machine tests showing that `Make Resume` and `Applied?` remain manual; first-observed transitions create one event; repeated sync is a no-op; existing dates are preserved; unknown dates remain unknown; and terminal outcomes stop follow-up generation.
- Add resume-workflow tests proving queue discovery is autonomous, only checked rows build, Building/Ready/Failed transitions reflect actual artifact results, and no stale or mismatched PDF is attached to outreach.
- Add outreach tests for one application-person-channel key, compact preview plus full body, free-first contact evidence, optional email availability, manual sent confirmation, Day 0/3/10/17 cadence, duplicate prevention, and immediate stop on response or opt-out.
- Keep LinkedIn computer use outside deterministic CI. Test its query construction and ingestion/filtering contract with captured fixtures; reserve real authenticated browsing for an explicit manual smoke test.
- Before go-live, run all existing job-pull and resume verification suites, the new high-level workflow suite, a complete no-write rehearsal, and a small transactional smoke test against v5. Verify the written row, Company relation, views, and rollback behavior manually.
- Treat any fallback write to v4, unexplained source omission, unresolved transaction, duplicate Activity event, or application-ready row without original-source evidence as a release-blocking failure.

## Out of Scope

- Migrating historical Applications v4, Companies, Outreach, or legacy v3 records into v5.
- Archiving or deleting v3 or v4 databases.
- Fixing historical v4 status, deduplication, relation, freshness, or original-ATS data in place.
- Automatically submitting job applications.
- Automatically checking `Make Resume` or `Applied?`.
- Automatically sending email, LinkedIn messages, InMail, connection requests, referral requests, or follow-ups.
- Automatically running authenticated LinkedIn computer use from `/morning`.
- Automated Instagram discovery; Instagram remains manual tip intake.
- Scheduled or cloud execution.
- A guaranteed verified email for every role.
- A new standalone People/Contacts database before cross-application person reuse demonstrates the need.
- Role-family-specific public search modes or a general composable mode language.
- Unbounded web scraping, bypassing portal restrictions, or treating search snippets as evidence.
- Making Apify, Vibe/Explorium, Hunter, Apollo enrichment, or another paid service a required dependency.
- Changing the frozen resume layout or fabricating resume evidence.
- Permanent night-shift filtering; all timezones remain allowed by user decision.

## Further Notes

- Notion remains the tracker of record. Local ledgers and run artifacts exist for transactional safety, offline audit, and reconciliation; they must not become competing lifecycle truth.
- The first live v5 run must occur only after schema validation, gateway tests, pipeline tests, resume workflow tests, a no-write rehearsal, and a transactional Notion smoke test pass. Failure leaves v5 unused and must never fall back to v4.
- The initial v5 deployment should create schema and views, record their stable identifiers in the manifest, validate integration permissions, and then run one bounded production morning workflow followed by manual verification of every written relation and view.
- Existing working-tree changes predate this specification and must be preserved. Implementation should isolate scope carefully and avoid overwriting unrelated resume or skill edits.
- The current system reference describes behavior that differs from both the live runtime and the agreed v5 contract. Update verification documentation as part of implementation so it is generated from or checked against executable behavior.
- This specification deliberately describes stable domain contracts rather than file paths. Implementation may reorganize modules as long as the public workflow, evidence rules, safety boundaries, and test seam remain intact.
