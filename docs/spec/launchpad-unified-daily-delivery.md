# Launchpad Unified Daily Delivery

Status: proposed

## Problem Statement

Onkar needs `/morning` to hand him the application-ready roles that Launchpad has already discovered, without a manual review pass standing between discovery and delivery.

Discovery now works. The 2026-07-24 production run fetched 9,128 records, normalized 7,823, and produced 54 eligible roles against a previous baseline of six. The funnel reconciled exactly, no historical or cooldown suppression fired incorrectly, and remote feeds, Workday hydration, cursor reset, and geography recovery were all verified against live sources. A manual review of that inventory produced three strict application-ready roles.

Delivery does not work. The same day's automated run produced zero shortlist roles. The three application-ready roles reached Onkar only because a person read the crawler inventory by hand.

The cause is that Launchpad currently runs three disconnected paths rather than one:

- The scheduled crawler discovers from the full source registry, persists observations, computes its own eligibility and reserve, and stops. It never invokes v5 scoring, selection, or write planning.
- The daily bridge runner is the only component that feeds crawler output into v5 scoring, but it deliberately narrows the crawl to warm ATS before running it, and then maps only two of the twelve declared Normal source lanes. Every Workday, expanded-ATS, career-page, remote-feed, and search observation is discarded before scoring. The bridge also has no caller outside its own test.
- The public `/morning` command points at the Normal mode module, which has no network primitive at all. Invoked without injected source functions, every required lane reports unavailable and the shortlist is empty by construction.

Three further problems compound this. Seven portal lanes are declared required but can never be satisfied automatically, so every run reports itself degraded whether or not anything actually failed, which masks real failures. The v4 history snapshot loader is wired but its file has never been populated, so the identity suppression it exists to perform contributes nothing. And a full production crawl takes about sixteen minutes with every source fetched strictly in sequence, before any scoring work is added to it.

The result is that Launchpad is honest about what it found and silent about what Onkar should do next.

## Solution

Collapse the three paths into one daily run whose input is the full source registry and whose output is a scored, selected, delivery-ready shortlist.

The scheduled run will crawl every configured source exactly as it does today, retaining durable observation state, novelty semantics, and funnel telemetry unchanged. It will then route every observation, grouped by the source that produced it, into the Normal source-lane contract, so that Workday, expanded ATS, career pages, remote feeds, and web discovery all enter v5 scoring alongside warm and tracked ATS. Selection, company caps, diversity, readiness, historical suppression, and write planning continue to run exactly where they run now, on the complete inventory instead of a warm-only slice.

That unified run becomes the scheduled entrypoint and the module behind `/morning`. Today the launchd agents invoke the crawler directly and the command contract names a module that cannot reach a network. After this change, both name the same run, so what the schedule discovers is what the command delivers.

Alongside the wiring, four correctness gaps close. Every eligible candidate must carry a Match Score before selection runs, and a run that would select over unscored candidates fails loudly rather than shortlisting a partially scored subset. Portal lanes stop claiming to be required capabilities that Launchpad does not have, and resolved portal leads — those the original-listing resolver has already turned into direct employer or ATS listings — flow through the same scoring path as any other lead. The v4 history snapshot is populated from Applications v4 and consumed by the daily run, so identity suppression finally reflects real application history. Search-lane health becomes observable, so a search source returning zero results is distinguishable from a search source that is not running.

Discovery volume is not the target. The target is that the automated run returns the same strict application-ready roles a careful manual review of the same inventory would return, on consecutive days, with an explainable count at every step between eligible and selected.

## User Stories

1. As a job seeker, I want `/morning` to return the application-ready roles Launchpad already discovered, so that I do not have to review raw crawler inventory by hand.
2. As a job seeker, I want the roles found by the scheduled crawl to be the roles offered to me, so that discovery uplift translates into applications.
3. As a job seeker, I want Workday roles that survive hydration and eligibility to be scored, so that enterprise inventory can reach my shortlist.
4. As a job seeker, I want expanded-ATS batch roles to be scored, so that boards outside the warm set can reach my shortlist.
5. As a job seeker, I want native remote feed roles to be scored, so that India-compatible remote work competes with Pune onsite work.
6. As a job seeker, I want structured career-page discoveries to be scored, so that direct employer listings are not discarded after the effort of finding them.
7. As a job seeker, I want web-discovery and startup-lane leads that resolved to a real employer listing to be scored, so that resolution work produces opportunities rather than telemetry.
8. As a job seeker, I want one daily run rather than three partial paths, so that a fix in one place cannot silently fail to reach delivery.
9. As a job seeker, I want the scheduled agent and the `/morning` command to invoke the same run, so that what runs unattended is what I can reproduce interactively.
10. As a job seeker, I want every eligible role scored before selection, so that company caps and diversity rules never operate over unscored candidates.
11. As a job seeker, I want a run that could not score every eligible role to fail loudly, so that a silently truncated shortlist is never presented as a complete one.
12. As a job seeker, I want a shortfall report that names which lane came up short, so that an empty morning has a cause I can act on.
13. As a job seeker, I want lanes Launchpad cannot automate marked as requiring live injection rather than as failures, so that a healthy run is not reported as degraded.
14. As a job seeker, I want genuinely failing sources still reported as failed, so that honest lane accounting does not hide real breakage.
15. As a job seeker, I want portal leads that were resolved to a direct employer or ATS listing to enter scoring, so that resolution converts aggregator noise into candidates.
16. As a job seeker, I want unresolved portal leads to stay in the verification queue, so that URL-only leads never reach my shortlist.
17. As a job seeker, I want roles I already applied to, was contacted about, interviewed for, or was rejected from to be suppressed using my real Applications v4 history, so that actioned opportunities never resurface.
18. As a job seeker, I want a missing or stale history snapshot reported explicitly, so that absent suppression is visible rather than assumed.
19. As a job seeker, I want a stale snapshot to warn rather than fail the run, so that an out-of-date export does not cost me a morning.
20. As a job seeker, I want the shortlist to shrink honestly once real history is suppressed, so that I trust the count I am given.
21. As a job seeker, I want search lanes that return zero results distinguished from search lanes that are not running, so that I know whether to fix configuration or queries.
22. As a job seeker, I want unresponsive search engines reported per query, so that upstream engine blocking is diagnosable without guesswork.
23. As a job seeker, I want a second search provider available once the first is proven, so that one blocked provider does not remove all search discovery.
24. As a job seeker, I want sources that hit their configured record cap to report that they truncated, so that a cap is never mistaken for exhausted inventory.
25. As a job seeker, I want caps raised only where truncation is actually observed, so that request budget is spent where inventory exists.
26. As a job seeker, I want the scheduled run to finish well inside its morning window, so that adding scoring does not push delivery past the time I need it.
27. As a job seeker, I want per-source durations reported, so that the slowest source is known before anything is parallelized.
28. As a job seeker, I want polite per-host request limits preserved under any concurrency, so that faster runs do not get Launchpad blocked.
29. As a job seeker, I want the count of eligible, scored, ready, and selected roles reconciled every run, so that any drop between discovery and delivery is explainable line by line.
30. As a job seeker, I want the unified run to be observed for several days before it is trusted, so that promotion is based on repeated behavior rather than one good run.
31. As a job seeker, I want promotion gated on the automated run matching a careful manual review of the same inventory, so that automation replaces the manual pass rather than approximating it.
32. As an operator, I want one entrypoint to invoke, configure, and debug, so that reproducing a scheduled run does not require assembling a pipeline by hand.
33. As an operator, I want run output to name each contributing source lane, so that I can attribute a delivered role to the source that found it.
34. As an operator, I want the existing durable crawl state, idempotency, and novelty semantics preserved, so that unification does not reset discovery history.
35. As an operator, I want a re-run of the same run identifier to remain idempotent, so that a retried morning does not double-count observations.
36. As an operator, I want the command contract and project documentation updated to name the unified run, so that the documented path and the executed path agree.
37. As an operator, I want the full existing test suite to keep passing, so that unification is verifiable as a change in wiring rather than a change in policy.
38. As an operator, I want the unified run covered at one high-level seam, so that behavior is asserted where Onkar observes it rather than in private helpers.
39. As an operator, I want enrichment work bounded when the candidate pool grows, so that feeding full inventory into scoring cannot make the run unbounded.
40. As an operator, I want a run that fails in one source to still deliver from the others, so that a single broken lane does not cost a whole morning.
41. As a job seeker, I want no auto-apply, no autonomous sending, and no automatic checkbox changes introduced by unification, so that every safety contract survives the change.
42. As a job seeker, I want write planning to remain planning until I explicitly opt in, so that unification does not quietly begin writing to Notion.

## Implementation Decisions

- Unify onto the existing daily bridge run as the single delivery entrypoint. Do not create a fourth runtime. The scheduled crawl operator, the Normal mode pipeline, and the source-lane contract keep their current responsibilities and boundaries.
- Remove the warm-only narrowing the bridge currently applies to configuration before crawling. The bridge crawls the full configured registry, exactly as the scheduled crawler does today, including expanded ATS batches, enterprise Workday boards, career pages, remote feeds, startup lanes, and web discovery.
- Introduce an explicit mapping from crawler source identifier to Normal source lane, owned in one place, so that lane attribution is a data decision rather than scattered conditionals. Warm ATS maps to the existing reverse-warm lane, remote-mode output maps to the existing native remote feed lane, and Indeed connector output maps to the existing Indeed lane.
- Add four new Normal source lanes for crawler families that have no current lane: expanded ATS (batch and enterprise), structured career pages, web discovery (search, startup, YC, and VC portfolio lanes), and generic connector inbox.
- Declare every new lane optional rather than required. Required lanes flip run outcome to degraded and drive shortfall reason codes; making the new lanes required would change shortfall semantics for every existing run and every existing assertion without any policy justification.
- Preserve per-lane manifests. Group crawler observations by their originating source identifier, merge that source's telemetry and failures into the lane manifest, and derive lane status from the same rules the bridge already applies to warm ATS: failures with candidates are degraded, failures without candidates are failed, candidates without failures are ok, and neither is empty.
- Populate lane errors from real crawler failures even though the new lanes are optional, so that optional status suppresses false degradation without suppressing true failure reporting.
- Rely on the existing candidate schema contract at the lane boundary. Crawler observations already carry the canonical candidate schema version, so the lane normalizer passes them through assertion rather than re-normalizing, and no new normalization path is introduced.
- Add a daily command to the crawler command surface that invokes the unified run, and repoint the generated launchd agents at it. Update the public command contract so the morning command names the unified run rather than the network-less mode module, and update the project map to match.
- Keep the unified run discovery-and-planning only. It plans writes through the no-write gateway by default; live gateway execution stays behind the existing explicit opt-in.
- Gate the run on complete scoring. Selection already reports scored, unscored, and scoring-failed counts; the run asserts that unscored and scoring-failed are zero and fails explicitly otherwise, rather than proceeding with a partially scored pool.
- Verify that run-level maximum and minimum totals apply after scoring rather than truncating the candidate pool before it. Any cap that operates before scoring is a scoring-order defect, not a configuration choice.
- Bound Workday and other candidate enrichment that currently runs across the flattened candidate set of every lane. With full inventory feeding the pipeline, unbounded enrichment is a runtime and request-budget risk; it takes an explicit request budget consistent with the crawler's existing detail-hydration budget.
- Reclassify the seven Indian portal lanes from required to optional, with an explicit reason code stating that they require live injection. They have no automatable source function and no network primitive, so permanent required-but-unavailable status is inaccurate rather than informative.
- Route portal leads that the original-listing resolver already converted into direct employer or ATS listings into the web-discovery lane, retaining provider provenance so a delivered role can still be attributed to the portal that surfaced it. Unresolved leads remain in the verification queue and cannot be selected.
- Populate the v4 history snapshot at its expected path from a read-only export of Applications v4, in the row shape the snapshot loader already declares, wrapped with a generation timestamp. v4 remains historical-only: nothing writes to, migrates, archives, or deletes it.
- Make the unified run read the snapshot by default rather than defaulting its historical rows to empty. Snapshot status — loaded, missing, stale, or malformed — is surfaced in run telemetry. Stale warns; missing and malformed degrade to zero rows without fabricating history and without failing the run.
- Surface search-lane diagnostics that the transport already receives and currently discards, specifically unresponsive engine lists and response status, per query. Zero results with healthy engines and zero results with blocked engines are different failures and must be reported differently.
- Do not change search query strings before engine health is observable. Treat upstream engine blocking as the leading hypothesis and configuration format support as the second.
- Re-enable the second search provider only after the first is diagnosable, so that a yield change can be attributed to one provider. Enabling it is configuration and credential work; the discovery plan for it already exists.
- Report truncation, cap-hit, and records-not-examined signals that the crawl already persists per source, and raise per-source caps only where truncation is actually observed.
- Measure per-source durations before changing crawl concurrency. Sources are currently fetched in a strictly sequential loop, but bounded detail hydration on enterprise boards is a plausible dominant cost; if it dominates, concurrency is the wrong fix.
- If concurrency is warranted, use a bounded pool and keep the existing per-host spacing and concurrency limiter authoritative over the pool, so that politeness constraints are never relaxed by parallelism.
- Preserve every existing safety contract without exception: discovery-only scheduling, no auto-apply, no autonomous sending, no automatic changes to user-owned Make Resume or Applied fields, no fabricated evidence, no legacy runtime fallback, and local-only resume compilation.

## Testing Decisions

- Use a single seam: the unified daily run. It accepts configuration, an injected transport, an injected clock, an optional durable store, and ledger rows, and returns shortlist, scoring queue, verification queue, per-lane source manifests, shortfall, historical suppressions, counts, and outcome. Every behavior in this spec is asserted through that one entrypoint.
- Prefer the existing seam to a new one. The daily runner test already establishes the full pattern — temporary directory, generated warm set, fixture ATS payloads, a fake transport that fails on unexpected URLs, fixed clock, and empty ledger rows — and it extends to the new lanes without new infrastructure.
- Test external behavior only. A good test here states what Onkar or the operator observes after a run: which roles were selected, which lanes contributed, which counts reconcile, which suppression fired, which status a lane reported. Do not assert on private helpers, internal grouping structures, or the shape of the lane mapping table.
- Reuse existing prior art for fixtures and fakes: the daily runner test for the end-to-end shape, the enterprise ATS tests for Workday list and detail payloads, the scheduled remote test for native feed payloads, the workflow tests for funnel and telemetry assertions, and the historical suppression and snapshot tests for suppression inputs.
- Add lane-coverage tests proving that expanded ATS, enterprise Workday, career page, remote feed, and web discovery observations each appear in the correct Normal lane manifest and are present in the scored pool.
- Add an end-to-end delivery test proving that inventory which reaches eligibility also reaches the shortlist, so that the reported zero-shortlist-from-nonzero-eligible condition is a regression test rather than a description.
- Add lane-status tests proving that an optional lane with crawler failures still reports its errors and its degraded or failed status, and that an optional lane with no configured source does not degrade run outcome.
- Add a scoring-completeness test proving that a run whose pool contains an unscored eligible candidate fails explicitly rather than returning a shortlist.
- Add a scoring-order test proving that run-level maximum totals do not remove candidates before Match Score is assigned.
- Add an enrichment-budget test proving that a large candidate pool does not produce unbounded detail requests.
- Add portal-lane tests proving that optional portal lanes without injection do not mark the run degraded, and that an injected portal lead which the resolver converted to a direct listing is scored while an unresolved lead remains in the verification queue with its provider provenance intact.
- Add snapshot-consumption tests proving that a populated snapshot suppresses matching roles from the shortlist, that a missing snapshot suppresses nothing and reports missing status, that a stale snapshot warns while still supplying rows, and that a malformed snapshot degrades to zero rows without failing the run.
- Add search-diagnostic tests using a fake transport proving that unresponsive engine data and zero-result health are observable in lane telemetry, and that a zero-result response with healthy engines is reported differently from one with blocked engines.
- Add truncation-reporting tests proving that a source which hits its record cap reports truncation rather than presenting a capped page as complete inventory.
- Add idempotency tests proving that re-running the same run identifier against the same durable store does not duplicate observations or re-deliver already-surfaced roles, extending the existing idempotency coverage to the full source set.
- Add a partial-failure test proving that one failing source lane still permits delivery from the remaining lanes.
- Keep the entire existing suite green as an explicit gate. The current baseline is 474 passing tests across crawler, job-pull, and v5 suites; unification is a wiring change and must not require policy-test edits.
- Do not require live third-party availability in any deterministic test. Live verification belongs to the canary, not to the suite.
- Treat the canary as the release gate rather than a test: several consecutive scheduled runs in production shadow, comparing crawler eligible count against scored pool and shortlist, with every delta explainable, and promotion only when the automated run returns the strict application-ready roles that manual review of the same inventory finds on two consecutive days.

## Out of Scope

- Changing any eligibility, freshness, liveness, geography, seniority, employment, or suppression policy. This work changes what reaches scoring, not what passes it.
- Guaranteeing a fixed daily count of application-ready roles when the market does not contain them. An honest shortfall remains the correct output.
- Enabling live Notion writes, auto-apply, autonomous outreach, automatic checkbox changes, or any authenticated browser automation.
- Migrating, writing to, archiving, or deleting v3 or v4 historical systems. The history snapshot is a read-only export.
- Building automated collection for login-heavy Indian portals. They remain live-injection, connector, or explicit rescue lanes.
- Enabling paid commercial rescue by default.
- Adding new discovery sources. The inventory this spec delivers already exists.
- Changing the frozen resume template or approved resume evidence.
- Redesigning funnel telemetry, which reconciled exactly in the reference run and needs extension, not replacement.
- Rewriting the crawler's own selection and reserve logic. It continues to serve durable crawl state and schedule health; v5 selection owns delivery.

## Further Notes

- The reference run for this spec is 2026-07-24: 9,128 fetched, 7,823 normalized, 54 eligible, funnel delta zero, zero incorrect historical or cooldown suppressions, and three strict application-ready roles found by manual review. Those three roles are the acceptance target for the automated run.
- The reported gap understates the break. Wiring the bridge to full inventory is necessary but not sufficient, because the scheduled agents do not invoke the bridge at all and the command contract points at a module with no network primitive. All three must move together or the fix reaches nothing.
- Expect the shortlist to shrink once the v4 snapshot is populated. That is the snapshot working, not a regression, and the canary should record the before-and-after explicitly.
- Expect the run's degraded status to change meaning once portal lanes become optional. Runs that previously always reported degraded will report ok, which makes the first genuinely degraded run meaningful for the first time.
- The sixteen-minute crawl duration is measured before any scoring work is added. Duration should be re-measured immediately after unification, before deciding whether concurrency is needed.
- Search and Brave work does not block promotion. Their absence costs discovery breadth, not delivery correctness, and the 54 eligible roles were found without them.
