# 24: Why 8 October had no Strict roles

**What to build:** Written explanation of why the 8 October run selected only Backfill roles and no Strict roles, including roles posted the day before. Record the cause and its evidence here. No code change in this ticket.

**Blocked by:** None (can start immediately)

**Status:** done

- [ ] Cause is written in this ticket
- [ ] Evidence comes from run output
- [ ] Any bug found is noted here for a follow-up ticket

## Finding

Diagnosed on 8 October 2026, IST, against `9846da8c17297df8992c1dfcf6fe2b98d5d56a20`. No code or policy changed. The acceptance checkboxes and ticket status remain for the orchestrator.

The four-role shortlist had zero Strict matches because none of the eight ready, scored roles had Strict eligibility before scoring. Freshness and selection tier are separate. The four selected roles were `freshnessWindow: Hot`, but the selector calls every relaxed selection `selectionTier: Backfill`, including roles posted the day before. Their dates were not classified as 8–14 days old.

### Retained run evidence

Paths below are relative to the main checkout at `/Users/onkarj012/Documents/Claude/Projects/Job Search`. These are ignored, machine-local run artifacts, not new crawls or portable fixtures.

| Run output | Run time, IST | Fetched | Eligible | Ready / scored | Selected | Strict selected | Selected bands |
|---|---|---:|---:|---:|---:|---:|---|
| `.local/pipeline-yield-2026-10-08/phase3/run.clean.json` | 8 October, 09:53:31 | 3,887 | 25 | 1 / 1 | 1 | 0 | `relaxed-backfill-8-14d: 1` |
| `.local/pipeline-yield-2026-10-08/phase3b/run.clean.json` | 8 October, 10:19:09 | 4,990 | 36 | 8 / 8 | 4 | 0 | `relaxed-hot-0-72h: 4` |
| `.local/pipeline-yield-2026-10-08/phase3c/run.clean.json` | 8 October, 10:27:49 | 5,037 | 35 | 8 / 8 | 4 | 0 | `relaxed-hot-0-72h: 4` |

Counts come from `counts`; Strict counts are retained in `dailyShortlistBudget.strictSelected`. The last two runs selected the same four requisitions. In each `shortlist[]` entry, `eligibility.strict` is false, `eligibility.experience.code` is `EXPERIENCE_NOT_STATED_MANUAL_REVIEW`, and `freshnessWindow` is `Hot`.

| Employer / role / requisition | Retained posting date | Why it is relaxed |
|---|---|---|
| Barclays Full Stack Engineer, `JR-0000116892` | 6 October | Target title, but no parsed numeric minimum or fresher evidence; `relaxations` contains `experience-not-stated`. |
| BP Data Engineer, `RQ116240` | 7 October | Unknown numeric experience plus adjacent title; `relaxations` contains `experience-not-stated` and `adjacent-title`. |
| BP Data Engineer, `RQ116393` | 7 October | Same two relaxations, separate requisition. |
| Barclays AI Engineer, `JR-0000123586` | 7 October | Target title, but no parsed numeric minimum or fresher evidence; `relaxations` contains `experience-not-stated`. |

The retained descriptions ask for technical experience without stating applicant years or entry-level eligibility. BP's company-history sentence says "For over 100 years"; it is not an applicant requirement. No numeric experience extraction defect was established in these four descriptions.

The complete pre-scorer pools are retained at:

- `.local/launchpad-crawler/scoring-runs/phase3b-20261008T101909-9a5a552fc8ba/scores-chunk-0-jobs.json`
- `.local/launchpad-crawler/scoring-runs/phase3c-20261008T102749-2ed8a28ef547/scores-chunk-0-jobs.json`

All eight `jobs[]` inputs have `selectionTier: relaxed`. Seven have `experience.minYears: null`; BP Software Engineer has `minYears: 2` with evidence "2–3 years of professional software development experience". Both runs report zero unscored rows and zero scoring failures. There was no Strict role in this scoring pool for the scorer or company cap to demote. The two-per-company cap limits eight ready roles from Barclays and BP to four selected roles; it does not explain their eligibility tier.

The first run selected only that BP Software Engineer, posted 28 September. Its `eligibility.experience.code` is `EXPERIENCE_RELAXED_UP_TO_2`, and both its freshness and selection tier are `Backfill`. This earlier one-role result differs from the later fresh four-role shortlists.

### Code path and follow-up

`job-pull/eligibility.mjs`, through `classifyExperience` and `classifyCandidate`, requires a parsed minimum of at most one year or explicit fresher evidence for Strict experience. Unknown years remain relaxed with manual review. Data Engineer also matches `TITLE_ADJACENT_RELAXED`. This agrees with the retained classifications and the current `master_prompt.md` policy; recency alone cannot establish Strict experience.

`job-pull/normal-selection.mjs`, through `selectNormalApplications`, assigns `selectionTier = strict ? 'Strict' : 'Backfill'` while preserving `freshnessWindow` separately. Record a follow-up naming defect: use a distinct shortage-fallback tier label consistently across selectors and consumers, and retain `Backfill` for the 8–14-day freshness class. Protect the distinction with a fresh relaxed-role regression through the existing selection seam. No freshness calculation or scoring-tier bug was established, and no fix belongs in this ticket.

This finding explains the retained shortlisted and scored inventory. It does not measure false-reject rates or establish that no Strict opportunity existed among rejected or unverified leads. That audit is outside ticket 24.
