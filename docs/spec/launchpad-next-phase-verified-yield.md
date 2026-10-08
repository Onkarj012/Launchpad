# Launchpad next phase: verified roles across Pune, startups and remote

Status: ready-for-agent

Written 8 October 2026 (IST) from the next-phase plan and the grilling decisions of the same day. Nothing in it is implemented yet.

## Problem Statement

Onkar is an early-career engineer in Pune, currently in training at Capgemini. He wants an AI/ML, full-stack or backend role in Pune or remote from India. The coming weeks matter. His notice is taken as 3 months until HR confirms, and listings that want immediate joiners get harder to win the longer he waits.

Launchpad finds too few roles he can act on. On 8 October it fetched about 5,000 jobs per run and shortlisted 4. All 4 came from two employers, all were labelled Backfill, and none was a Strict match. The losses are spread across the pipeline:

- Supply is the bottleneck, not the gates. The board registry holds 255 boards, none tagged Pune-relevant. Most of its Workday tenants are US companies whose jobs fail the location gate.
- About 40 portal leads per run (LinkedIn, Glassdoor, Instahyre, Wellfound) stall in verification. Nothing links a portal lead to the same employer's own ATS board, even when that board is known.
- Several built lanes produce nothing: structured career pages have no company list, the startup company-careers lane is not wired into the daily run, and web discovery comes back empty.
- The gates encode rules that no longer match Onkar's situation. They drop all contract and EOR roles, drop remote roles on US or EU hours even though Onkar accepts night work, have no rule for onsite shifts, do not exclude his current employer, and use a ₹6 LPA salary floor he has replaced.
- Some Pune listings are rejected for location only because they name an area such as Kalyani Nagar or Hadapsar without the word "Pune".
- The two-per-company cap now binds, because ready roles come from too few employers.
- There is no usable daily output. The Notion v5 tracker has never made a live write, so results reach Onkar only as raw run files.

## Solution

One shared crawl each morning feeds three modes, each with its own full results list and shortlist: Pune (code name `normal`), Startup, and Remote. Two side lists sit outside the targets: a Stretch list of up to 3 roles that ask for exactly 3 years, and an EOR/Contract list for foreign companies that hire in India through an employer of record or on long-term contracts. A role appears in one mode and carries a tag naming any other modes it fits.

The daily output is one private HTML report on Onkar's Mac. Each shortlisted role shows why it fits, its labels (`Night hours (IST)`, `Notice risk`, `Remote: worldwide, no country limit`, `EOR`, `Contract`, other modes), and the apply link. Onkar does the final shortlisting by hand.

Supply grows mostly through a rebuilt employer registry aimed at Pune and India. Each board is verified with one public request and tagged Pune- or India-relevant from its real job locations. Portal leads get matched to the employer's own board. Built-but-empty lanes are switched on. The gates get a false-reject audit, and the scope rules change to match the decisions below. Fail-closed stays the default throughout.

New avenues run as one-week trials: hiring posts that Onkar pastes into a local inbox file, Hacker News "Who is hiring", YC Work at a Startup with India filters, a funded-startup watch, founder and hiring-manager outreach drafts, and a referral map. All outreach is draft-only. Onkar sends everything himself.

Claude runs the pipeline by hand each morning from day 3 of the build, so Onkar has real shortlists before the build ends. A 7-day unattended shadow week on launchd follows, with no Notion writes. Whether the tracker stays on Notion v5 or moves to a small local page is decided after shadow week.

**Phase target:** each mode meets its daily shortlist target on 5 of 7 consecutive IST days. The targets are Pune 10+ roles from 6+ employers, Startup 5+ from 4+, and Remote 5+ from 4+. Every shortlisted role must be verified, and there must be at least 2 Strict matches a day across modes.

## User Stories

### Daily output

1. As Onkar, I want one local HTML report each morning, so that I can review the day's roles without opening run files.
2. As Onkar, I want the report split into Pune, Startup and Remote sections, so that I can work through one kind of role at a time.
3. As Onkar, I want each mode to show both its full verified results list and its shortlist, so that I can do the final shortlisting by hand.
4. As Onkar, I want a role that fits several modes to appear once, tagged with its other modes, so that I review it only once.
5. As Onkar, I want each shortlisted role to carry a one-line "why it fits" drawn from the scorer evidence, so that I can decide quickly.
6. As Onkar, I want every role's labels shown next to it, so that I notice night hours, notice risk, EOR or contract terms before I apply.
7. As Onkar, I want the employer's own apply link on each role, so that I apply at the source and not through a portal.
8. As Onkar, I want the Stretch list and the EOR/Contract list in their own sections, so that I never confuse them with full-time early-career roles.
9. As Onkar, I want the report to show fetched, eligible, passed-gates, ready, scored, shortlisted, employers represented and Strict counts, so that I can see where roles were lost.
10. As Onkar, I want yield per source per request in the report, so that I can see which sources are worth their cost.
11. As Onkar, I want the report to stay on my Mac and never go to Waymark, so that my job search data stays private.
12. As Onkar, I want to go from the morning shortlist to an application in under 15 minutes per role, so that applying fits around training.

### Pune mode and location

13. As Onkar, I want listings that name a Pune area, such as Kalyani Nagar, Hadapsar, Yerwada, Balewadi, Pimpri or Chinchwad, to count as Pune even without the word "Pune", so that real Pune roles are not rejected.
14. As Onkar, I want short area names that also exist elsewhere to match only alongside "Maharashtra", "MH" or a 411xxx/412xxx pin code, so that roles in other cities are not mistaken for Pune.
15. As Onkar, I want the outer industrial belt (Chakan, Talegaon, Ranjangaon, Shikrapur) excluded, so that the commute stays realistic.
16. As Onkar, I want multi-city listings that include Pune to pass as Pune, so that GCC roles posted for several sites are kept.

### Remote mode

17. As Onkar, I want remote roles that name India or APAC to pass as before, so that the current remote supply is kept.
18. As Onkar, I want "worldwide", "anywhere" or "global" remote roles to pass when the JD sets no country limit and asks for no foreign work authorization, so that I see foreign roles I can actually take.
19. As Onkar, I want those roles labelled `Remote: worldwide, no country limit`, so that I can see why they passed.
20. As Onkar, I want roles limited to the US, Canada, EU, UK or LATAM, or that require foreign work authorization, still rejected, so that I don't waste applications.

### Startup mode

21. As Onkar, I want a daily Startup mode built from the same crawl, so that startup roles are not hidden behind large employers.
22. As Onkar, I want the startup company-careers lane wired into the daily run, so that the lane produces roles instead of reporting that it is unavailable.
23. As Onkar, I want the VC watchlist grown with India-focused funds and their portfolio boards, so that more startups feed the registry.
24. As Onkar, I want recently funded startups added to the registry each week, so that I reach companies about to hire.

### Shifts, hours and notice

25. As Onkar, I want night and rotating shifts allowed for Pune and remote roles, so that I see roles I'm willing to take.
26. As Onkar, I want remote roles on US or EU hours labelled `Night hours (IST)` instead of dropped, so that I can still choose them knowingly.
27. As Onkar, I want onsite night or rotating shifts labelled `Night hours (IST)`, so that the shift is visible before I apply.
28. As Onkar, I want listings that ask for immediate joiners or a notice of 30 days or less kept and labelled `Notice risk`, so that I can still try for them.

### Experience and Stretch

29. As Onkar, I want the Strict band to stay at 0–1 years required, so that Strict means a real fit for my experience.
30. As Onkar, I want Fallback to allow up to 2 years, so that close roles still appear.
31. As Onkar, I want "preferred" years not treated as a hard minimum, so that soft wording doesn't reject me.
32. As Onkar, I want up to 3 Stretch roles a day that ask for exactly 3 years, in AI/ML, full-stack or backend, scoring 80+, at a startup or remote, so that I can try rare roles where years may bend.
33. As Onkar, I want Stretch roles never counted toward any mode's target, so that the targets stay honest.

### Employment type, companies and pay

34. As Onkar, I want foreign-company roles that hire in India through an employer of record kept and labelled `EOR`, so that I can consider global remote employment.
35. As Onkar, I want long-term contracts kept and labelled `Contract`, but only with full-time hours, ongoing or 6+ months, stated fixed pay and a direct hire by the company, so that I see stable contract work and nothing exploitative.
36. As Onkar, I want EOR and contract roles shown only in their own list and never counted toward full-time targets, so that the full-time shortlists stay clean.
37. As Onkar, I want unpaid, equity-only, commission-only, volunteer, part-time, freelance per-task, training-fee, bonded and agency-resale-without-named-client roles dropped, so that bad offers never reach me.
38. As Onkar, I want internships kept only when the stipend is ₹40k+ a month and a path to a full-time offer (PPO) is stated, so that any internship I see is worth leaving a full-time job for.
39. As Onkar, I want Capgemini roles excluded, so that I never see my current employer.
40. As Onkar, I want other IT services majors kept only for AI or product engineering titles, so that I don't move sideways into a generic services role.
41. As Onkar, I want roles with disclosed pay below ₹5.5 LPA dropped, so that a switch never cuts my pay.
42. As Onkar, I want roles with undisclosed pay kept as `Not Verified`, so that missing data doesn't reject a good role.

### Supply: registry, portal leads and lanes

43. As Onkar, I want a registry of 250–400 Pune and India employers, so that most fetched jobs are ones I can actually take.
44. As Onkar, I want each board verified with one public request and tagged Pune- or India-relevant from real job locations, so that relevance is evidence and not reputation.
45. As Onkar, I want Pune-relevant boards fetched first every morning, so that the best supply survives time and request budgets.
46. As Onkar, I want US-only tenants with zero India yield over 7 days rotated out or paused, so that they stop using the budget.
47. As Onkar, I want a portal lead matched to the same employer's own board by employer, title and location, plus requisition when present, so that held leads become verified employer routes.
48. As Onkar, I want a portal lead left in verification when no match is found, so that wrong matches never reach the shortlist.
49. As Onkar, I want visible external apply links on Instahyre and Wellfound used, without login or private endpoints, so that more leads resolve safely.
50. As Onkar, I want one LinkedIn guest pass per run, with back-off for the day after a 429, so that sources aren't burned.
51. As Onkar, I want the structured career-page crawler fed with employers that use no supported ATS, so that the lane finds roles.
52. As Onkar, I want the empty web-discovery result diagnosed and the cause fixed, so that search-based discovery works.
53. As Onkar, I want the Apify rescue for Naukri, Foundit and Hirist capped at $1 a run and $15 a month and run only when I ask, so that cost stays bounded.
54. As Onkar, I want every configured source to end each run as `ok`, `empty` with a reason, or `disabled` by decision, so that no source stays broken unnoticed.
55. As Onkar, I want sources that use requests without producing ready roles paused by the existing source-yield rules, so that budget goes where roles come from.

### Gate audit

56. As Onkar, I want 100 random rejects per main reason code labelled right or wrong by hand, so that false-reject rates are measured, not guessed.
57. As Onkar, I want only proven false rejects fixed, each with a regression test built from the real listing, so that the gates never loosen by accident.
58. As Onkar, I want to know why every selected role was Backfill and none Strict, even when posted the day before, so that Strict selection can be trusted.

### New avenues

59. As Onkar, I want to paste a hiring post's URL and text into one local inbox file and have the morning run read it, so that roles posted by founders and engineers reach the pipeline.
60. As Onkar, I want the Hacker News "Who is hiring" thread filtered for India-eligible, remote-global and early-career roles each month, so that I see remote-friendly startups.
61. As Onkar, I want the YC Work at a Startup query to use India and remote filters, so that it returns roles I can take.
62. As Onkar, I want founder and hiring-manager notes drafted for shortlisted or watched employers, as a LinkedIn message and an email to a publicly published address, so that I can reach roles that are never posted.
63. As Onkar, I want a referral map built from my LinkedIn connections export and a hand-written list, matched to registry employers and shortlists, so that I find warm intros.
64. As Onkar, I want every outreach item to stay a draft that I send myself, so that nothing ever acts on my behalf.
65. As Onkar, I want hiring challenges and off-campus drives tracked as dated items, so that I don't miss deadlines.
66. As Onkar, I want each avenue to report a one-week yield and get a keep or drop decision, so that only useful avenues stay.

### Running it

67. As Onkar, I want Claude to run the pipeline by hand each morning from day 3 of the build, so that I can start applying before the build is done.
68. As Onkar, I want a 7-day shadow week on launchd at about 07:45 and 13:15 IST, on the isolated config, with no Notion writes, so that unattended runs are proven before anything goes live.
69. As Onkar, I want the schedule installed only when I say go, and removable in one command, so that I stay in control of my machine.
70. As Onkar, I want drift such as LinkedIn 429s, Glassdoor 403s, board failures and scorer variance shown in the report, so that I notice when a run degrades.
71. As Onkar, I want to note what I miss from Notion during shadow week, so that the tracker decision rests on real use.
72. As Onkar, I want a checked row to build a tailored one-page resume PDF locally, so that applying stays fast.
73. As Onkar, I want Make Resume and Applied? left exactly as I set them, so that the system never changes my decisions.

## Implementation Decisions

### Policy

- `master_prompt.md` remains the source of truth for targeting. Its "Employment type & must-haves", timezone, salary and company rules change in the same change as the gate code that enforces them, so prose and code never disagree. The approved employment wording is:
  > - Full-time engineering roles or explicitly paid/stipended engineering internships (stipend ≥ ₹40k/month with a stated PPO path).
  > - **Global remote employment lane (separate):** foreign-company roles employing in India through an employer of record (label `EOR`), or long-term contracts with full-time hours, ongoing or ≥6 months, stated fixed pay, and hire by the company itself (label `Contract`). Shown only in their own list and shortlist; never counted toward full-time targets.
  > - Unpaid, equity-only, commission-only, volunteer, part-time, freelance per-task, training-fee, bonded, and agency-resale-without-named-client roles → drop.
- The salary floor in the conversion plan config moves from 6 to 5.5 LPA. Undisclosed pay stays `Not Verified`.
- The guardrails do not change: fail-closed, the two-per-company cap per shortlist, no auto-apply, draft-only, v5-only, and user-owned checkboxes left untouched.

### Eligibility module (`classifyCandidate`)

- The candidate classification result gains a `labels` list beside `reasons`. A label never rejects a role. Labels: `Night hours (IST)`, `Notice risk`, `Remote: worldwide, no country limit`, `EOR`, `Contract`.
- Geo: the Pune area list grows to the agreed areas. Ambiguous short names match only with "Maharashtra", "MH" or a 411xxx/412xxx pin code. The outer industrial belt is an explicit reject.
- Remote: "worldwide", "anywhere" and "global" pass when the JD shows no country limit and no foreign work-authorization requirement. US-hours-only and overnight-only overlap stop being a reject reason and add `Night hours (IST)` instead.
- Shifts: onsite and hybrid night or rotating shifts in Pune pass with `Night hours (IST)`.
- Employment: two new classes, EOR and long-term contract, each with the evidence the approved wording requires. They are eligible only for the EOR/Contract lane. A contract role that lacks any of full-time hours, ongoing or 6+ months, stated fixed pay, or direct hire by the company is dropped. Unknown contract terms fail closed into verification, not into the lane.
- Internships: eligible only with stated stipend ≥ ₹40k/month and a stated PPO path. This bar applies to the AICTE and NATS avenue too.
- Companies: Capgemini is an excluded employer. A configured list of IT services majors (TCS, Infosys, Wipro, Cognizant, Accenture, HCL, Tech Mahindra, LTIMindtree) passes only for AI or product engineering titles. Each rule gets its own reason code. Proposed names: `COMPANY_EXCLUDED`, `SERVICES_MAJOR_GENERIC_ROLE`.
- Experience: Strict, Fallback and the 3+ reject stay as they are. The classification exposes whether the hard minimum is exactly 3 years, so selection can build the Stretch list without re-parsing.
- Notice: text that asks for immediate joiners or a notice of 30 days or less adds `Notice risk`. It never rejects.

### Selection and modes (daily runner and mode selectors)

- One crawl feeds the Pune (`normal`), Startup and Remote selectors. Each returns a full verified results list and a shortlist.
- Each role is assigned one primary mode and tagged with the others it fits. The two-per-company cap applies within each mode's shortlist.
- The Stretch list comes from scored roles with a hard minimum of exactly 3 years, a core family (AI/ML, full-stack, backend), a score of 80+, and a startup or remote listing. It is capped at 3 a day and never counted toward targets.
- The EOR/Contract list holds only roles in that lane. It has its own shortlist, and none of its roles may appear in a full-time shortlist.
- The phase target is evaluated per mode per IST day and recorded in the run report.

### Registry

- Registry boards gain `puneRelevant` and `indiaRelevant` flags and a probe record (when, how found, job count, India job count), all derived from one public GET.
- The registry gains about 250–400 employers in four tiers: Pune GCCs and captives, Pune product companies, India AI and dev-tool startups, and services majors. Capgemini is not seeded.
- Board ordering puts Pune-relevant boards first. US-only tenants with zero India yield over 7 days rotate out or pause through the existing rotation state.
- Production reads the registry file, so verified boards are registered there, not only in the crawler config.

### Original-listing resolver

- A new cross-match step: when a portal lead's company matches a registry employer, search that employer's board by title (Workday `searchText`, list filters on Greenhouse, Lever and Ashby). Promote only on employer, title and location match, plus requisition when one exists.
- Visible external apply links on Instahyre and Wellfound count as employer routes. No login and no private endpoints.
- The resolver budget is raised only after measuring verified routes per request.

### Sources

- The structured career-page lane gets its company list from registry employers that have no supported ATS but publish JobPosting JSON-LD.
- The startup company-careers lane is added to the daily path.
- Web discovery gets a root-cause fix for its empty results (key, budget or query shape).
- TheirStack is enabled or deleted by decision, after free-source yield is measured.
- The Apify rescue runs only when Onkar invokes it, capped at $1 a run and $15 a month.
- Every source ends a run as `ok`, `empty` with a reason, or `disabled` by decision.
- LinkedIn: one guest pass per run, back-off for the day on 429, no retry of the same page.

### Inbox, referral and outreach

- Hiring posts: a local markdown inbox file holds entries of post URL plus pasted text. The morning run parses it into connector-inbox envelopes, and the resolver handles them like any other lead. Entries are never fetched with a login.
- Referral map: inputs are the LinkedIn connections CSV export (name, company, title, connected date) and a hand-written list. People are matched to registry employers and shortlisted roles. The output is draft notes only.
- Outreach drafts cover LinkedIn and email. Email drafts only use addresses published on a company or personal site. Everything is draft-only.

### Report

- The existing local lead report renderer grows into a daily HTML report. It has per-mode results and shortlists, the Stretch and EOR/Contract sections, labels, "why it fits", apply links, funnel counts, per-source yield and drift signals. It reads run output and never scores or writes a lifecycle. It is written only to Onkar's Mac.

### Scheduling and tracker

- Shadow week uses the existing launchd install support at about 07:45 and 13:15 IST, on the isolated config, with no Notion writes. Install and removal happen only on Onkar's instruction.
- The tracker choice is deferred to after shadow week. If Notion v5: rotate the credential, run the live four-store smoke and make one guarded write. If local: a small local page over SQLite for Make Resume, Applied? and status, which first needs Onkar's approval to change the v5-only rule in `AGENTS.md` and the safety contract. This spec builds neither.

## Testing Decisions

A good test feeds real-shaped input through a public seam and checks what Onkar would see: eligible or not, tier, reason codes, labels, which list a role lands in, and what the report shows. Tests do not reach into helper functions or private state. Every gate fix gets a regression test built from the real listing that exposed it. Live network is never used in tests; fetches and the scorer are injected fakes.

Proposed seams, highest first:

1. **Daily run seam** (daily mode runners with injected fixtures and a fake scorer). This is the main seam. It covers mode routing, one-role-one-mode with tags, the per-mode two-per-company cap, the Stretch list (cap, eligibility, kept out of targets), EOR/Contract isolation (zero leakage into full-time shortlists), per-mode target evaluation, source terminal states, and the daily report content. Prior art: the daily-runner tests that drive the real Normal pipeline from crawler fixtures, and the normal, startup and remote mode tests.
2. **Eligibility seam** (`classifyCandidate` with a normalized candidate and policy). This covers each scope rule in isolation: Pune areas and ambiguous-name guards, outer-belt reject, worldwide remote, night-hours and notice labels, EOR and contract evidence, internship stipend and PPO bar, company exclusion and the services-major title rule, the ₹5.5 LPA floor, and the exactly-3-years flag. Prior art: the eligibility, experience-recovery and recovery-employment tests.
3. **Existing module seams, reused unchanged.** The board-registry tests cover the relevance flags, probe records and Pune-first ordering. The original-listing-resolver tests, with a fake fetch, cover cross-match promotion and the no-match case. The connector-inbox tests cover hiring-post parsing. The source-yield tests cover per-source yield.

No new seam is proposed. The two main seams already exist. Most new tests go through the daily run seam, and eligibility tests cover only rule detail that is clumsy to reach end to end.

Verification commands stay as in `AGENTS.md`: validate, safety, test, readiness with tests, and diff check. Bounded live runs on the isolated config are evidence for the yield target, not tests, and are reported separately.

## Out of Scope

- Submitting applications, sending messages or email, LinkedIn automation, and any change to Make Resume or Applied?.
- Live Notion writes and closing the Notion gates. Building a local tracker. Both wait for the post-shadow-week decision.
- Changing the v5-only rule, `AGENTS.md` or the safety contract.
- Promotion, the seven-date canary, and the rollback drill.
- Loosening the experience band or adding QA/SDET, SRE/DevOps, support or analyst families.
- A daily Waymark page, or any publishing of Onkar's results.
- Pune community events and Capgemini internal moves.
- Cloud scheduling.
- Raising the Apify cap or enabling TheirStack before yield is measured.

## Further Notes

- **Primary-mode precedence is an assumption.** Onkar chose "show once, tag the others" but did not set which mode wins. This spec assumes Startup, then Pune, then Remote, which was the ordering offered in the same question. Confirm before building selection.
- **Notice is taken as 3 months until HR confirms.** The `Notice risk` label does not depend on the number, so an HR answer changes no code.
- If week one shows supply cannot reach the targets, the targets get lowered then, with the numbers.
- Build order follows the plan. Days 1–2 cover registry research and probing, the Pune areas, reject sampling, the scope rule changes and wiring the startup lane. Day 3 starts the bounded runs in all three modes, the manual morning runs, the cross-match and the worldwide rule. Days 4–5 cover the second registry batch, the EOR/Contract lane, structured career pages, the report format, outreach drafts and the referral map. Days 6–12 are shadow week.
- One PR on `fix/pipeline-yield`, opened after the gate audit workstream.
- Source plan: `docs/plans/launchpad-next-phase-2026-10-08.md`.
