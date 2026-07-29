# Crawler source audit — 2026-07-28

Evidence base: the production SQLite at `.local/launchpad-crawler/crawler.sqlite` —
**100,642 observations / 17,498 jobs / 3,300 descriptions across 32 crawl runs**.
This is real accumulated crawl output, not a fresh sample. Every figure below is a
query against that database.

## Headline

The crawler spends most of its budget collecting jobs that can never be selected.

- **Workday is 12,506 of 17,498 jobs (71.5%)** of all inventory.
- **86% of Workday jobs are outside India** (10,792 of 12,506). Only **361 are Pune** — 2.9%.
- **Only 23% of Workday jobs are engineering-titled at all.** The most common Workday
  titles are `pharmacy technician` (228), `shift supervisor` (120), `store associate`
  (106), `pharmacy intern` (69). `cvshealth` alone contributes 730 jobs.
- **Workday descriptions: 156 of 12,506 = 1.2%.** Every other real ATS is at ~100%.

So the dominant source is majority-non-India, majority-non-engineering, and almost
entirely undescribed. That is the root cause behind both the tiny shortlist and the
"No JD text" scores.

## Source inventory — 599 boards, 18 providers

| provider | boards | jobs | with description | % |
|---|---:|---:|---:|---:|
| workday | 158 | 12,506 | 156 | **1.2%** |
| ashby | 26 | 1,329 | 1,328 | 99.9% |
| india-startup-vc | 1 | 712 | 2 | 0.3% |
| smartrecruiters | 2 | 536 | 535 | 99.8% |
| greenhouse | 10 | 526 | 526 | 100% |
| searxng | 1 | 468 | 357 | 76.3% |
| india-startup-ats-search | 1 | 454 | 7 | 1.5% |
| jobicy | 116 | 177 | 0 | **0%** |
| weworkremotely | 79 | 144 | 0 | **0%** |
| remoteok | 111 | 132 | 132 | 100% |
| lever | 5 | 117 | 116 | 99.1% |
| pinpoint | 1 | 101 | 101 | 100% |
| recruitee | 1 | 83 | 83 | 100% |
| himalayas | 63 | 73 | 0 | **0%** |
| india-startup-yc | 1 | 60 | 7 | 11.7% |
| remotive | 21 | 38 | 38 | 100% |
| career-page-discovery | 1 | 30 | 30 | 100% |
| workable | 1 | 12 | 0 | **0%** |

Crawler lanes (`sources` table) feeding those providers:

| source_id | lane | observations | jobs | % dated |
|---|---|---:|---:|---:|
| ats-enterprise | ats-expanded | 91,391 | 12,505 | 70.7 |
| ats-warm | ats-warm | 24,776 | 1,960 | 100 |
| ats-batch-1 | ats-expanded | 3,901 | 631 | 100 |
| india-startup | brave-startup | 2,831 | 1,253 | **0** |
| ats-batch-2 | ats-expanded | 2,200 | 101 | **0** |
| remote-mode | remote-sources | 1,671 | 565 | 100 |
| searxng-search | web-discovery | 1,465 | 503 | **2.7** |
| career-sites | career-site | 37 | 30 | 100 |
| startup-mode | startup-sources | 18 | 18 | 50 |

The complete per-board listing (599 boards with job / description / date counts) is
in `crawler-source-audit-2026-07-28-boards.txt` next to this file.

## Why Workday jobs have no description — root cause

Confirmed by inspecting a stored raw record. The Workday CXS **LIST** endpoint returns:

```
canonicalUrl  https://zendesk.wd1.myworkdayjobs.com/zendesk/job/Mexico-City-Mexico/Sales-Engineer_R35148
provider      workday
company       Zendesk
title         Sales Engineer
location      Mexico City, Mexico
postedAt      2026-07-13T…
description   NULL      ← never present in LIST
workMode      NULL
experience    { minYears: null, maxYears: null, evidence: null }
```

Greenhouse, Ashby, Lever, SmartRecruiters and Recruitee all return the description
**inline in their list response** (Greenhouse is queried with `content=true`), which
is why they sit at ~100%. Workday requires a **separate DETAIL request per job**.

Three compounding failures:

1. **The detail budget is 50 requests per run** (`sources.enterprise.maxDetailRequestsPerRun`)
   against 12,506 Workday jobs — 0.4% coverage per run even if every request succeeded.
2. **`sources.enterprise` lists only 4 boards** (Mastercard, Ingram Micro, ReliaQuest,
   Pitney Bowes) but `ats-enterprise` actually pulls **158 Workday boards** from the
   board registry. The other 154 boards were never in scope for the hydration budget.
3. **The hydration telemetry is silently discarded.** `crawler/ats-enterprise.mjs:514`
   builds a `workdayDetail` block (attempted / succeeded / failed / budgetExhausted),
   and `config/crawler-v2.json` documents it — but `crawler/run.mjs`'s
   `source_telemetry` INSERT persists a **fixed field list** that does not include it.
   No run has ever recorded it, so the failure was invisible.

Downstream consequence: `job-pull/match-scorer.mjs:29` caps description-less rows at
**45/100** — only Seniority (15), Location (10) and Response Likelihood (20) can be
scored honestly; Skill match and Domain relevance are deliberately left unscored
rather than guessed. So 71.5% of inventory can never score above 45, and the AI/LLM
role families can never be identified, because identifying them needs the JD text.

The three roles shortlisted on 2026-07-28 scored 43, 40 and 29 — all Workday, all
"No JD text". 43 is not a mediocre fit; it is 43 out of an achievable 45.

## Other date/description gaps worth naming

- **jobicy, weworkremotely, himalayas, workable — 0% descriptions** (406 jobs). These
  adapters keep the date but drop the body.
- **india-startup-vc: 712 jobs, 0.3% described, 0% dated.** Effectively unusable as
  dated inventory.
- **ats-batch-2: 2,200 observations, 0% dated.**
- **searxng: 2.7% dated** — expected for web discovery, but it means 468 jobs land in
  the verify queue rather than the funnel.

## Where the AI/ML roles actually are

Jobs whose title matches AI / ML / LLM / data-science terms:

| provider | AI-titled jobs |
|---|---:|
| workday | 349 |
| ashby | 183 |
| india-startup-ats-search | 166 |
| searxng | 127 |
| greenhouse | 37 |
| india-startup-vc | 29 |
| smartrecruiters | 23 |
| india-startup-yc | 22 |

They exist. Workday has the most in absolute terms, but they are buried in 12,506
mostly-US, mostly-retail rows and arrive without descriptions.

## Recommended order of work

1. **Fix the Workday hydration budget and scope** — it unlocks correct scoring for
   71.5% of inventory. Persist the `workdayDetail` telemetry first so the fix is
   measurable, then raise the budget and target hydration at rows that already pass
   the geo and title gates rather than at arbitrary rows.
2. **Prune the Workday board registry.** Boards like `cvshealth`, `aspendental` and
   `republic` contribute hundreds of pharmacy and retail rows and zero plausible
   matches. Every one of them costs fetch budget that the 42-minute run deadline
   makes scarce.
3. **Fix the 0%-description remote adapters** (jobicy, weworkremotely, himalayas,
   workable) — small volume, but they are remote-eligible, which is one of only two
   geo paths still open.
4. Only then add new sources. Adding volume ahead of steps 1–3 adds more undescribed,
   wrong-geo rows to an already saturated budget.
