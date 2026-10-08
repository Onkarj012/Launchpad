# Launchpad next phase: more verified roles across Pune, startups and remote

Prepared 8 October 2026, IST, on branch `fix/pipeline-yield` (HEAD `be6cc04`, 923/923 tests). This is a plan. All open questions were settled with Onkar on 8 October (Decisions, below). Nothing in it has been started.

## Where we are

Three bounded runs on 8 October, each on a fresh isolated database:

| | Run 1 | Run 2 | Run 3 |
|---|---:|---:|---:|
| Fetched | 3,887 | 4,990 | 5,037 |
| Passed location, title, experience, employment, freshness | 25 | 36 | 35 |
| Ready and scored | 1 | 8 | 8 |
| Shortlisted | 1 | 4 | 4 |

The shortlist is Barclays Full Stack Engineer, BP Data Engineer (two requisitions), and Barclays AI Engineer. All Pune, all posted 6 to 7 October, scores 63 to 72, all labelled Backfill. Strict matches: zero.

What the run data says, in order of weight:

1. **Supply is the bottleneck, not the gates.** Of 3,090 stored jobs, 226 mention Pune. Only 82 of those come from employer ATS boards, and they come from about eight employers: Barclays, BP, 6sense, Autodesk, Capco, Blue Altair, Delta Capita, Bosch. Every ready role came from two of them.
2. **The board registry is aimed at the wrong place.** It holds 255 boards and none is marked Pune-relevant. The 123 enterprise Workday tenants are mostly US companies (Boeing, CVS Health, Chevron, Cincinnati Children's). The 2,785 to 3,384 "onsite, not Pune" rejects per run are mostly these.
3. **The company cap now binds.** Eight ready roles from two employers become four under the two-per-company rule in `master_prompt.md`. More employers, not a looser cap, is the fix.
4. **Portal leads stall at verification.** About 40 LinkedIn, Glassdoor, Instahyre and Wellfound leads per run have no JD and no employer route. Many are from employers with their own ATS (Mastercard, BMC, Atlas Copco, TransUnion, MetLife, BNY, Jefferies, Accenture, Purplle, Avaloq). Nothing cross-matches a portal lead to that employer's board.
5. **Several built lanes produce nothing.** `structured-career-pages` has an empty company list. `startup-company-careers` is not wired into the daily path. `web-discovery` came back empty. Naukri, Foundit, Hirist, Cutshort and Peerlist need live injection or the Apify rescue. Glassdoor returns 403; LinkedIn returned 429 on the third run.
6. **Some Pune ATS roles may be false title rejects.** Examples to audit: Barclays "Recon Developer", "Sterling Developer", "Test Engineer", "Data Analyst"; BP "Junior Business Intelligence Specialist", "Enterprise Technology Engineer"; 6sense "Software Engineer II"; Blue Altair "Analyst / Consultant - Fullstack Developer". Some will be correct rejects. None has been checked.

## Goal and how we measure it

**Three modes, each with its own results and shortlist.** One shared crawl each morning feeds three selectors. Each produces a full results list (every verified, scored role) and a shortlist. Onkar does the final shortlisting by hand. A role that fits more than one mode appears once, tagged with the other modes it fits.

| Mode | Covers | Daily shortlist target |
|---|---|---|
| Pune | Pune city and PCMC, onsite or hybrid, any company size | 10+ from 6+ employers |
| Startup | Startups in Pune or remote from India, seeded from YC, VC portfolios and funding news | 5+ from 4+ employers |
| Remote | Remote roles open to India, from Indian or foreign companies | 5+ from 4+ employers |

Two side lists sit outside the targets: **Stretch** (up to 3 a day) and **EOR/Contract**. Neither counts toward any mode's target.

**Target for this phase:** each mode meets its target on 5 of 7 consecutive IST days, every role verified (JD, employer route, live, allowed employment, fresh, location rule met), with at least 2 Strict matches a day across modes. The two-per-company cap applies within each mode's shortlist. If week one shows supply cannot reach the targets, they get lowered then, with the numbers.

**Guardrails that do not move:** fail-closed gates, two-per-company cap per shortlist, no auto-apply, draft-only outreach, v5-only writes, user-owned checkboxes untouched.

**Every run reports:** fetched, Pune or India-eligible, passed gates, ready, scored, shortlisted, employers represented, Strict count, and yield per source per request. A source that adds requests without adding ready roles gets paused by the existing `sourceYield` rules.

## Scope rules for this phase

### Pune area

A listing counts as Pune when its location names Pune or any of these areas, even without the word "Pune":

- **Already accepted:** Pune metro, Pimpri-Chinchwad, PCMC, Hinjawadi/Hinjewadi, Wakad, Baner, Kharadi, Viman Nagar, Magarpatta, Talawade.
- **To add:** Kalyani Nagar, Koregaon Park, Yerwada, Hadapsar, Mundhwa, Aundh, Pashan, Balewadi, Bavdhan, Kothrud, Shivajinagar, Senapati Bapat Road, Wagholi, Kondhwa, Undri, Pimpri, Chinchwad, Pimple Saudagar, Nigdi, Bhosari, Moshi, Sus, Maan, Marunji.
- **Out:** the outer industrial belt (Chakan, Talegaon, Ranjangaon, Shikrapur).

Tested on 8 October: "Kalyani Nagar, Maharashtra", "Hadapsar", "Yerwada", "Balewadi High Street", "Pimpri" and "Chinchwad" are rejected today. Each new area gets a regression test. Short names that collide with other places are matched only alongside "Maharashtra", "MH" or a Pune pin code (411xxx, 412xxx).

### Remote from India and abroad

- Pass when the listing or JD names India or APAC (current rule).
- **New:** also pass "worldwide", "anywhere" or "global" when the JD has no country limit and no work-authorization requirement. These roles carry the label `Remote: worldwide, no country limit` so Onkar can see the basis.
- Still rejected: US, Canada, EU, UK or LATAM only; foreign work authorization required.
- Run 8 October baseline: 766 remote roles rejected as region-restricted (mostly correct), 198 as unclear, including "anywhere in the world" (24), "home based - worldwide" (18) and bare "Remote" (40).

### Working hours and shifts

Changed. Night and rotating shifts are allowed for Pune and remote roles, which is the whole scope. Remote roles on US or EU hours, and onsite night or rotating shifts, pass with the label `Night hours (IST)`. They are no longer dropped. This replaces the "US-hours-only and overnight-only overlap → drop" line in `master_prompt.md`.

### Experience and the Stretch list

- Unchanged: Strict is 0 to 1 years required, Fallback up to 2, a hard minimum of 3+ is rejected. "Preferred" years are not a hard requirement.
- **New Stretch list**, up to 3 roles a day. A role qualifies only if all of these hold: core family (AI/ML, full-stack, backend), hard minimum of exactly 3 years, score 80+, and posted by a startup or remote. Stretch roles never count toward targets.

### Role families

Unchanged. The adjacent Fallback families stay as they are (Application, Platform, Data, Solutions, Forward-Deployed, Research Engineer). QA/SDET, SRE/DevOps, support and analyst roles are not added.

### Companies

- Capgemini is excluded.
- Other IT services majors (TCS, Infosys, Wipro, Cognizant, Accenture, HCL, Tech Mahindra, LTIMindtree) pass only for AI or product engineering titles. Their generic roles are dropped.

### Employment type, internships and the EOR/contract lane

Approved wording for `master_prompt.md` "Employment type & must-haves", replacing the line that drops all contract roles:

> - Full-time engineering roles or explicitly paid/stipended engineering internships (stipend ≥ ₹40k/month with a stated PPO path).
> - **Global remote employment lane (separate):** foreign-company roles employing in India through an employer of record (label `EOR`), or long-term contracts with full-time hours, ongoing or ≥6 months, stated fixed pay, and hire by the company itself (label `Contract`). Shown only in their own list and shortlist; never counted toward full-time targets.
> - Unpaid, equity-only, commission-only, volunteer, part-time, freelance per-task, training-fee, bonded, and agency-resale-without-named-client roles → drop.

The wording lands in `master_prompt.md` together with the gate code that enforces it (workstream R4), so prose and code never disagree.

### Salary

The floor drops from ₹6 LPA to **₹5.5 LPA** for Pune and remote roles. Roles with disclosed pay below it are dropped. Undisclosed pay passes as `Not Verified`, as today.

### Notice period

Onkar's notice is taken as 3 months until HR confirms otherwise. Listings that ask for immediate joiners or a notice of 30 days or less get the label `Notice risk`. They are kept, not dropped.

## Workstreams

Ordered by expected yield. A to D work on the existing pipeline. E opens new avenues. F to H make the result usable and trustworthy.

### A. Build a real Pune and India employer registry (biggest lever)

The current registry was seeded from US-heavy lists. Build one from where Onkar can actually work.

1. **Assemble a seed list of 250 to 400 employers** in four tiers:
   - Pune GCCs and captives (banking, auto, industrial, software): for example Mastercard, BNY, UBS, Deutsche Bank, Citi, Barclays, BP, Allstate, John Deere, Siemens, Bosch, Volkswagen IT, Eaton, Cummins, Honeywell, Emerson, Atlas Copco, ZS Associates, Amdocs, NVIDIA, Rapid7, Veritas, Qualys, BMC, TransUnion, Avaloq, Capco, Delta Capita.
   - Pune product companies: for example Icertis, PubMatic, Druva, Mindtickle, 6sense, Persistent, Synechron, Zensar, Coditas, KPIT, Tata Technologies, Bajaj Finserv tech, eQ Technologic.
   - India AI and dev-tool startups with India-eligible remote or Pune offices, seeded from YC (India filter), Peak XV, Accel, Blume, Lightspeed, Elevation portfolios, Inc42 funding news from the last 90 days, and Pune incubators.
   - Large services firms (Accenture, Infosys, TCS, Cognizant, Wipro and the others under Companies), kept in a separate tier whose roles pass only for AI or product engineering titles. Capgemini is not included.
   Sources: NASSCOM member list, STPI and SEZ tenant lists for Hinjawadi, Kharadi, Magarpatta and Viman Nagar, Startup India directory, the YC and VC lists already in `config/vc-portfolio-watchlist.json` (currently empty), and the research doc's section B.
2. **Discover each employer's ATS** from its careers page: Workday (`*.myworkdayjobs.com` tenant, instance, site), SuccessFactors, Oracle Recruiting Cloud, iCIMS, Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Darwinbox, Keka, Zoho Recruit. Record the exact board URL and how it was found.
3. **Verify each board** with one public GET: it returns jobs, and at least one has an India location. Tag `puneRelevant` and `indiaRelevant` from the actual job locations, not from reputation.
4. **Register** verified boards in `config/board-registry.json` (the file production reads, not only `crawler-v2.json`).
5. **Re-prioritise** so Pune-relevant boards are fetched first every morning, and US-only tenants with zero India yield over 7 days rotate out or pause.

Expected effect: the main lever on employer count and Strict matches. Pune GCCs post many entry-level and associate roles on Workday.

Done when: at least 150 verified boards tagged Pune or India-relevant, each with a probe record. A bounded run shows Pune ATS roles from at least 25 employers.

Work split: research and discovery by two agents in parallel (GCC and product list; startup and VC list); probing by one worker within a request budget; Claude reviews entries before they land.

### B. Turn portal leads into employer routes

1. **Cross-match**: when a portal lead's company matches a registry employer, search that employer's own board for the same title (Workday `searchText`, Greenhouse/Lever/Ashby list filter). Promote only on employer, title and location match, plus a requisition match when one exists. Otherwise the lead stays in verification.
2. **Use visible apply links** from Instahyre and Wellfound where the page shows an external employer link. No login, no private endpoints.
3. **Raise the resolver budget only on evidence**: measure verified routes per resolver request first.
4. **Rate-limit hygiene**: one LinkedIn guest pass per run, back off for the day on 429, never retry the same page.

Expected effect: a share of the roughly 40 held leads a day, mostly the large employers in point 4 above.

Done when: a bounded run converts at least 10 portal leads to verified employer routes with zero wrong matches in a manual check of every conversion.

### C. Turn on the lanes that are built but empty

1. **Structured career pages (LP-009).** The sitemap and JobPosting JSON-LD crawler exists. Feed it employers from workstream A whose sites publish JSON-LD but use no supported ATS.
2. **Startup company careers.** Wire the existing lane into the daily path so it stops reporting `SOURCE_FUNCTION_UNAVAILABLE`.
3. **Web discovery.** Find out why Brave and SearXNG returned nothing (key, budget, or query shape) and fix the cause.
4. **TheirStack connector.** Two queries exist and are disabled. Decide on cost, then enable or delete.
5. **Apify rescue for Naukri, Foundit and Hirist.** The profiles exist. Use them as Onkar-invoked rescue only, capped at $1 per run and $15 per month, and send their leads through workstream B. The cap gets revisited once their yield is measured.

Done when: every configured source ends each run as `ok`, `empty` with a reason, or `disabled` by decision. None stays `unavailable` by accident.

### D. Audit the gates for false rejects, without loosening them

0. Add the Pune areas listed under scope rules, with tests.
1. Pull 100 random rejects per code (`TITLE_OFF_TARGET`, `TITLE_SENIORITY_REJECT`, `GEO_REMOTE_SCOPE_UNCLEAR`, `GEO_NOT_VERIFIED`, `EXPERIENCE_HARD_MIN_3_PLUS`) and label each as right or wrong by hand.
2. Check multi-city listings ("Bengaluru, Pune, Hyderabad"), Pune suburbs, "Maharashtra" only, and titles like Analyst, Consultant, Associate, Engineer I/II, Developer with a tech prefix.
3. Fix only proven false rejects, each with a regression test built from the real example.
4. Find out why every selected role is Backfill and none is Strict, even when posted the day before. Tier logic or scoring evidence may be mislabelling fresh, fitting roles.
5. Apply the scope rule changes decided on 8 October, each with tests: shift and night-hours labels, the Stretch list, the company rules, the ₹5.5 LPA floor and the `Notice risk` label. Update `master_prompt.md` in the same change.

Done when: false-reject rate per code is measured, the fixes have tests, and Strict selection is explained or fixed.

### E. New avenues beyond job boards

Each avenue gets a bounded trial (one week), a yield measure, and a keep or drop decision. Everything stays draft-only and Onkar-confirmed.

| Avenue | What it gives | How it would work | Effort |
|---|---|---|---|
| Hiring posts (LinkedIn, X) | Roles posted by engineers and founders before they reach boards | Onkar pastes the post URL and text into `inbox/hiring-posts.md`; the morning run reads it; workstream B resolves the employer route. No login automation | Low |
| Hacker News "Who is hiring" | Remote-friendly startups, some India-eligible | Monthly thread via the public Algolia API; filter for India, remote-global, early-career | Low |
| YC Work at a Startup | Startup roles with India filters | Already a query; add the India-remote filter and check country limits | Low |
| Funded-startup watch | Companies that just raised and will hire | Inc42 and VC funding news from the last 90 days produce employer seeds for workstream A and founder outreach drafts | Medium |
| Founder and hiring-manager outreach | Roles that are never posted | For each shortlisted or watched employer, a draft note naming the role and Onkar's matching project, as a LinkedIn message and as an email to an address published on a company or personal site. Onkar sends manually | Medium |
| Referral map | Warm intros | Inputs: Onkar's LinkedIn connections CSV (official "Download your data" export) plus a hand-written list of alumni and batchmates. Launchpad matches people to registry employers and shortlists and drafts notes. It never sends | Medium, needs Onkar |
| Hiring challenges and off-campus drives | Fresher-specific pipelines | Unstop, HackerEarth, HackerRank, and company graduate drives (e.g. off-campus programs at GCCs); track deadlines as dated items | Medium |
| AICTE internships and NATS apprenticeships | Paid internships and graduate apprenticeships | Separate lane, counted apart from full-time. Same bar as any internship: stipend ≥ ₹40k/month with a stated PPO path | Medium |
| Open-source contribution path | Hiring signal at OSS-first companies | Pick 3 to 5 companies from the registry that hire from contributors; track good-first-issues | High, long horizon |

Out of this phase by decision: Pune community events and Capgemini internal moves.

Done when: each trialled avenue has a one-week yield number and a keep or drop decision.

### S. Startups as a first-class mode

1. Run `daily --mode startup` every day alongside Pune and Remote, from the same crawl.
2. Wire the startup company-careers lane into the daily run (also C2).
3. Grow the VC watchlist: Antler and a16z are listed with no companies; add YC India, Z47 (Matrix), Nexus, Kalaari, 100X.VC, Speciale Invest and Together Fund, then discover each portfolio company's board through workstream A.
4. Funded-startup watch (from E) feeds new startups into the registry weekly.

Done when: the Startup shortlist meets its target on 3 consecutive days with roles from at least 4 startups.

### R. Remote as a first-class mode

1. Run `daily --mode remote` every day.
2. Apply the new worldwide rule and its label, with tests built from real rejected listings.
3. Add remote-first companies known to hire in India to the registry (seeded from Himalayas, We Work Remotely and Remotive company pages and the research doc), verified like any other board.
4. Build the separate EOR and contract lane, and put the approved wording into `master_prompt.md` in the same change.

Done when: the Remote shortlist meets its target on 3 consecutive days, and the EOR/contract lane shows its roles separately with zero leakage into full-time shortlists.

### F. Make the shortlists usable each morning

1. Each day's output is one local HTML report on this Mac. It holds, per mode, the full verified results list and the shortlist, plus the Stretch and EOR/Contract lists, so Onkar can do the final shortlisting by hand. Each shortlisted role gets a one-line "why it fits" from the scorer evidence, its labels (`Night hours (IST)`, `Notice risk`, `EOR`, `Contract`, other modes it fits), and the apply link. Nothing goes to Waymark, since the report holds Onkar's data.
2. From day 3, Claude runs this by hand each morning while the build continues, so Onkar has real shortlists to apply to before the build ends.
3. Resume path: a checked row builds a tailored one-page PDF on this Mac (`resumes/sources/<date>/`, `resumes/output/<date>/`).
4. Outreach drafts for the hiring manager or recruiter where one is identifiable, draft-only.

Done when: Onkar can go from the morning shortlist to an application in under 15 minutes per role, by his own measure.

### G. Run it every day, unattended, in shadow

1. A launchd schedule runs at about 07:45 and 13:15 IST on the isolated config for 7 days, with no Notion writes. It is installed only on Onkar's go at the start of G and removes in one command.
2. Daily funnel report in the local HTML report, with source health and per-source yield.
3. Watch for drift: LinkedIn 429, Glassdoor 403, board failures, scorer variance (the same role scored 72 one run and 67 the next).
4. Onkar notes anything he misses from Notion during the week. That note decides the tracker (H).

Done when: 7 consecutive days of shadow runs with complete reports and the phase target met on 5 of them.

### H. Pick the tracker, then close its gates (after G)

Decided after G, from what Onkar missed during shadow week:

- **Notion v5.** Close the Notion release gates in `docs/STATUS.md`: rotated Notion credential, live four-store v5 smoke, one guarded live write. About half a day.
- **Local tracker.** SQLite stays the source of truth, with one small local page to tick Make Resume and Applied? and set a status. Notion code stays, frozen. About 1 to 2 days, and it needs Onkar's approval to change the v5-only rule in `AGENTS.md` and the safety contract.

Either way, the remaining release gates stay: real resume build, seven-date canary on one clean version, schedule install, promotion and rollback drill.

## Order and timing

| Day (IST) | Work |
|---|---|
| Day 1 | A1 to A2 research in parallel (two agents, now including startups and remote-first companies); D0 Pune areas; D1 sampling; C3 web-discovery diagnosis |
| Day 2 | A3 probing and A4 registration (first 100 boards); D2 to D3 fixes; D5 scope rule changes; C2 wiring |
| Day 3 | First bounded run in all three modes; manual morning runs start (F2); B1 cross-match build; R2 worldwide rule; E trials start (HN, hiring posts, YC) |
| Day 4 | A second batch (to 150+); B2 to B4; C1 structured career pages; R4 EOR/contract lane |
| Day 5 | Bounded run and review; F1 report format; E outreach drafts and referral map |
| Days 6 to 12 | G shadow week; E keep or drop decisions at the end |
| After G | H: pick the tracker, then close its gates |

Bounded runs stay at one or two a day to respect LinkedIn and Glassdoor limits.

## Agents and review

- **Research and employer discovery:** Codex `gpt-6-luna` and Claude `claude-haiku-5-5` in parallel, high effort, each on a different slice, each writing one evidence file.
- **Implementation:** Codex `gpt-6.1-sol` for identity, resolver and gate code; `gpt-6-luna` for config and registry work. Each in its own worktree with a written fence and test budget.
- **Review:** a read-only Codex review of every merged slice; Claude checks diffs and reruns the full suite before each merge.
- **Live runs:** Claude only, isolated config, results compared run over run.

## Decisions (Onkar, 8 October 2026)

1. **Company cap:** keep two per company, applied within each mode's shortlist.
2. **Paid sources:** Apify rescue for Naukri, Foundit and Hirist, Onkar-invoked, capped at $1 per run and $15 per month. TheirStack waits until free-source yield is measured.
3. **Onkar in the loop:** hiring-post capture and the referral map, about 20 minutes a day. Pune communities and Capgemini internal moves are out of this phase.
4. **Internships and apprenticeships:** a separate lane, counted apart from full-time, only with a stipend of ₹40k+ a month and a stated PPO path.
5. **Pune area:** city and PCMC areas listed under scope rules; outer industrial belt excluded.
6. **Remote:** India or APAC as today, plus worldwide roles whose JD shows no country limit, labelled.
7. **EOR and contract:** a separate, labelled lane, never mixed with full-time shortlists. `master_prompt.md` wording approved as written.
8. **Output:** results and a shortlist for each of Pune, Startup and Remote; Onkar does the final shortlisting by hand.
9. **Targets:** Pune 10+ from 6+ employers, Startup 5+ from 4+, Remote 5+ from 4+.
10. **Roles in several modes:** shown once, tagged with the other modes.
11. **Experience:** band unchanged, "preferred" years not a hard requirement, plus a Stretch list of up to 3 a day under the rules above.
12. **Role families:** unchanged.
13. **Shifts and hours:** night and rotating shifts allowed for Pune and remote roles, including US or EU hours, labelled `Night hours (IST)`.
14. **Companies:** Capgemini excluded; other services majors only for AI or product engineering titles.
15. **Salary floor:** ₹5.5 LPA, Pune or remote.
16. **Notice:** taken as 3 months until HR confirms; immediate-joiner and ≤30-day listings kept with `Notice risk`.
17. **Daily output:** one local HTML report per day. No daily Waymark page.
18. **Order:** usable output first; manual morning runs from day 3 while the build continues.
19. **Shadow week:** launchd at about 07:45 and 13:15 IST, no writes, installed on Onkar's go.
20. **Hiring posts:** pasted into `inbox/hiring-posts.md`, read by the morning run.
21. **Referral map:** LinkedIn connections CSV plus a hand-written list; drafts only.
22. **Outreach drafts:** LinkedIn plus email, only to publicly published addresses; Onkar sends.
23. **Tracker:** Notion v5 or a local tracker, decided after shadow week.
24. **Branch and PR:** continue on `fix/pipeline-yield` and open one PR after workstream D.

## Evidence

- Run outputs: `.local/pipeline-yield-2026-10-08/phase3/`, `phase3b/`, `phase3c/` (machine-local, ignored by git).
- Research: `docs/research/2026-10-08-source-supply-and-employer-routes.md`, `docs/research/2026-10-08-pipeline-verification-techniques.md`.
- Prior handoff: `docs/launchpad-handoff-2026-10-08.md`.
