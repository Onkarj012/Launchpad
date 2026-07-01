# Job Search OS — v2 Plan (Shortlist-Rate Fix)

Status: **IN PROGRESS (2026-06-26).** Builds on `PLAN.md` (v1, fully built). v2 targets the real bottleneck found by grilling: **70 applications / 1 month / 0 replies.**

Companion: `master_prompt.md` (runtime rules) · `PLAN.md` (v1 build).

---

## 0. Diagnosis (from grilling)

Resume content + projects are strong and real (live sites + GitHub repos). The failure is **not getting shortlisted**, and it is upstream of resume quality. Three causes, in priority order:

1. **ATS-killing resume format** — master `.tex` uses `multicol`, `tcolorbox`, `fontawesome5`, `marvosym`, two-column `tabular*`. Icon-labeled contact fields strip to bare values; two-column header detaches name from contact; reading order fragments. Real risk, now fixed.
2. **Late timing** — applying day 3–5 to flooded posts (Indeed/LinkedIn/Glassdoor/Wellfound), often past the ATS auto-close-after-N-applicants threshold. "Latest" feeds from those boards are mostly scams.
3. **Zero referrals/outreach** — never did email referral asks; LinkedIn DMs got no replies. Cold-apply shortlist rate ~2–5%; referral 10–20×. Untapped.

(Location auth is NOT a cause — user self-filters JD auth requirements before applying.)

---

## 1. Decisions Locked (v2 grilling)

| # | Decision |
|---|---|
| Low-competition def | **Channel obscurity** primary (ATS-direct, niche boards); **recency** (<24h) as a secondary flag/feature |
| New sources | career-ops-style **ATS adapters: Greenhouse / Lever / Ashby** (day-0, scam-free, first-N applicant) + keep existing **Apify + Indeed** connectors + **YC / Wellfound** for startups |
| career-ops repo | **Borrow patterns only** — reimplement source-scraping logic into existing skills; keep Notion + LaTeX system. Ref: `santifer/career-ops`, `andrew-shwetzer/career-ops-plugin` |
| Internships | Keep in pipeline but **reframe**: chase only if strong brand OR high full-time conversion. NOT for "experience" (Stride already = experience block). Tag `Convert?`. Low-brand internship = skip |
| Geography | In-person/hybrid → **Pune only**; **Remote → anywhere**, timezone-flexible. Add `Auth-Friendly?` tag |
| Volume | **7–10/day**, optimized for fresh + real + high-chance (not raw count) |
| Resume system | **Two tracks**: pretty (`leo4.dev`, cold emails) + **ATS-clean** (every portal apply). User also sourcing an Overleaf ATS template to compare |
| "High chance" | New 5th scoring dimension: **Response Likelihood** = small-co (<200) + posted <48h + ≥70% skill match = high; big-co + stale = low |
| Standout vehicle | Portfolio `leo4.dev` exists; lean on it + per-project demo links in resume header & cold emails |

---

## 2. Build Spec

### A. ATS-clean resume — ✅ BUILT
- `Master_Resume_ATS.tex` — single column, no icon fonts, no `multicol`/`tcolorbox`, linear reading order, plain-text labeled contact line (`Phone:`/`Email:`/`GitHub:`/`LinkedIn:`/`Portfolio:`).
- Verified via `pdftotext` (raw stream order) — every contact field, section header, and skill keyword survives.
- Master = 3 pages (full 4-project pool, expected). Tailored output (Stride + 2 projects) targets 1 page.
- TODO: add parse-verify guard to `resume-latex` skill — after compile, run `pdftotext` and assert email + phone + ≥N skill keywords present before declaring done.
- TODO: user brings Overleaf ATS template → pick cleaner of the two.

### B. Fresh-direct sourcing (adopt career-ops patterns)
- Add ATS adapters: **Greenhouse** (`boards-api.greenhouse.io/v1/boards/<co>/jobs`), **Lever** (`api.lever.co/v0/postings/<co>`), **Ashby** (`api.ashbyhq.com/posting-api/job-board/<co>`). Maintain a watchlist of target companies' board slugs.
- Keep Apify + Indeed connectors as secondary breadth.
- Add YC Work-at-a-Startup + Wellfound for startup roles (higher reply rate).
- Refactor `daily-job-pull` skill: query all sources → dedup on `Job ID` → score → write rows.

### C. New Notion fields (Applications DB)
- `Role Type` — Select: Internship / New-grad / Full-time
- `Source Rarity` — Select: ATS-direct / Niche board / Aggregator (Indeed/LinkedIn)
- `Auth-Friendly?` — Select: Remote-global / India-based / Visa-sponsor-only / No
- `Response Likelihood` — Number (0–100, the 5th scoring sub-score)
- `Convert?` — Checkbox (internships only: high FT-conversion signal)
- (`Freshness` <24h flag already exists from v1)

### D. Scoring update (`master_prompt.md` §3)
- Add **Response Likelihood** as 5th dimension. Proposed reweight (sums 100):
  Skill 35 · Domain 20 · Seniority 15 · Location 10 · **Response Likelihood 20**.
- Internship variant: weight brand + convert higher, salary lower.

### E. Referral / outreach step (new pipeline stage)
- For each high-score role: find 1–2 employees (recruiter or team eng) via LinkedIn → draft **email** referral ask (not LinkedIn DM — those got 0 replies) BEFORE cold-applying.
- Reuse existing cold-email template (`master_prompt.md` §5). Attach/link a 60-sec demo or `leo4.dev`.
- Log in Outreach DB.

---

## 3. Build Sequence

1. ✅ ATS-clean master resume + parse-verify.
2. ⬜ Parse-verify guard in `resume-latex` skill.
3. ⬜ Notion: add 5 new Applications fields.
4. ⬜ `master_prompt.md`: add Response Likelihood dim + reweight + source list.
5. ⬜ `daily-job-pull`: wire Greenhouse/Lever/Ashby adapters + YC/Wellfound; tag rarity/freshness/auth.
6. ⬜ Referral stage in `application-agent` (email-first).
7. ⬜ Dry run: pull → verify fresh ATS-direct rows → tailor ATS resume → referral draft.

---

## 4. Open Confirms
- Target-company watchlist for ATS adapters — which companies' boards to poll? (need slugs)
- Overleaf ATS template — user to provide for comparison.
- Reweight numbers above — confirm or adjust.
