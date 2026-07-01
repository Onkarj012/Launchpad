# Master Prompt — Job Search OS

> Single source of truth for targeting, scoring, resume tailoring, and outreach.
> Claude reads this file for every daily pull, every resume tailor, and every cold email.
> Resume **content** comes from `resumes/master/Master_Resume_ATS.tex` (default) / `resumes/master/Master_Resume.tex` (pretty). This file holds the **rules**.

---

## 1. Identity Snapshot

- **Name:** Onkar Jadhav
- **Title:** AI / Full-Stack Software Engineer
- **Location:** Pune, Maharashtra, India
- **Education:** B.Tech Computer Science, PCCOE (9.08 CGPA), graduating Jun 2026
- **Email:** onkarj012@gmail.com · **GitHub:** github.com/Onkarj012 · **LinkedIn:** linkedin.com/in/onkarj012
- **Headline products:** Stride (shipped, in use), Lore Engine, StockXpert, GovBench, PromptForge

---

## 2. Targeting

> Used for **fit-scoring** at pull time. Edit freely — this drives which jobs get a high Match Score.
> Items marked `[CONFIRM]` are assumptions — correct them.
> Company **stage** (startup / mid / big tech) is intentionally varied at sourcing time via `companies.json` and the dork queries in `skills/daily-job-pull` — see § 6/§ 7. Role targets below stay fixed regardless of stage.

### Target titles (any of)
- AI / LLM Engineer
- Agentic AI Engineer
- Machine Learning Engineer
- Full-Stack Engineer (AI-leaning)
- Backend Engineer (Python)
- Software Engineer — New Grad / Entry

### Level
- Entry-level / Fresher / New-grad (0–1 yr). Open to roles asking ≤2 yrs.

### Work mode & location
- **Preferred:** Remote (India) or Hybrid in Pune.
- **Acceptable:** Onsite Pune, Hybrid Bangalore/Mumbai/Hyderabad. `[CONFIRM]`

### Must-haves
- Real engineering work (AI/ML, backend, or full-stack with substance).
- Paid.

### Hard gates (run first, every pull — fail any → drop, never written to Notion)
1. **Location-auth** — in-person/hybrid must be Pune (or Bangalore/Mumbai/Hyderabad); remote must be India-eligible or global-with-India-ok. Onsite outside India → drop.
2. **Seniority** — hard requirement of 3+ yrs → drop.
3. **Paid** — unpaid / equity-only / commission-only → drop.

Everything else (stack fit, role flavor, pure-frontend-ness, etc.) is **soft** — it lowers Skill match / Domain relevance in § 3, not a gate.

### Salary
- `[CONFIRM]` Floor: ______ (LPA). Leave blank = don't filter on comp.

---

## 3. Scoring Rubric (0–100)

Hard gates (§ 2) run first and drop disqualified roles before scoring. Survivors get a weighted sum across 5 dimensions:

| Dimension | Weight | What it measures |
|---|---|---|
| **Skill match** | 35 | Overlap between JD's required skills and my stack (Python, TS, React/Next, FastAPI, RAG, agentic AI, ML, pgvector, etc.) |
| **Domain / role relevance** | 20 | Is the actual work AI/ML/backend/full-stack vs off-target |
| **Seniority fit** | 15 | Entry/fresher friendly = high; senior-only (but under the 3-yr gate) = low |
| **Location / remote fit** | 10 | Remote-India / Pune / hybrid = high; onsite-abroad = low |
| **Response Likelihood** | 20 | Small company (<200 ppl) + posted <48h + ≥70% skill match + ATS-direct source = high. Big company + stale posting + aggregator source = low. |

**Soft-score-down signals (drag Domain/Skill, not a gate):** pure frontend-only / pixel-pushing roles, non-technical/sales/support roles, hard requirement of a stack with zero overlap to mine that dominates the role.

- **Recency** is tracked separately as `Freshness` (Tier A 24h / B 3d / C 5d) and feeds the Response Likelihood sub-score; it is not its own top-level dimension.
- Output per job: integer 0–100 + a one-line rationale + the **single strongest hook** to lead the resume/email with + an `Auto-Suggest` boolean (see rule below).
- Fetch many, score all, **keep the top 15–20 by pure score** after gates. Log how many were dropped (by gate vs. below cutoff) in the run summary.
- **No auto-apply.** Present ranked list; Onkar reviews and picks ~5–7/day. `Apply?` checkbox is manual — never auto-checked.

**Score bands (guidance, not gates):**
- 80–100: strong fit, tailor immediately.
- 65–79: solid, tailor if hook is good.
- 50–64: stretch, only if low day-volume.
- <50: skip unless special reason.

**Auto-Suggest rule:** `score ≥ 80 AND Freshness ∈ {Tier A, Tier B} AND Response-Likelihood sub-score ≥ 14/20`. This sets the `Auto-Suggest` checkbox (cloud's pick opinion) — it never sets `Apply?`; the user always confirms manually.

---

## 4. Resume Tailoring Rules

### Structure (fixed)
1. **Heading** — unchanged.
2. **Summary** — rewritten per JD to mirror its top 3–4 keywords, lead with the scoring "hook".
3. **Experience** — **Stride is ALWAYS here** (it's a shipped product in use):
   - Title: **Founder & Lead Engineer**
   - Dates: **April 2026 – Present**
   - Lead bullet states traction (production, active trial users) — see content rules.
4. **Projects** — **exactly 2**, picked from the pool by best JD-keyword match:
   - Pool: **Lore Engine, StockXpert, GovBench, PromptForge**
   - (Vaani excluded — too little owned detail.)
5. **Technical Skills** — reorder so JD-relevant categories surface first; never invent skills not on the master.

### Hard constraints
- **Exactly ONE page. No empty space** — page must look full. If 2 projects underfill: lengthen bullets / add a relevant master bullet / expand summary. If overfull: trim weakest bullet first.
- Total project slots on page = **3** (1 Stride experience block + 2 projects). Never more, never fewer.
- Never fabricate. Only reframe / reorder / select from `Master_Resume.tex`.
- Mirror the JD's vocabulary where truthful (e.g. JD says "LLM orchestration" → use that phrasing if it fits an existing bullet).

### Project picker logic
1. Extract JD's core themes (RAG / retrieval → Lore Engine; ML/DL/quant → StockXpert; AI safety/eval/governance → GovBench; agentic/prompt pipelines → PromptForge).
2. Rank 4 projects by keyword overlap with JD.
3. Take top 2. Tie-break toward variety (don't show two near-identical projects).

### Output
- Editable source: `resumes/sources/Onkar_Jadhav_<Company>_<Role>.tex`
- Final PDF (PDF-only folder): `resumes/output/Onkar_Jadhav_<Company>_<Role>.pdf`
- Compile locally (BasicTeX) into `resumes/sources/build/` scratch, verify **page count == 1** + parse-verify before declaring done, copy only the `.pdf` to `resumes/output/`, then delete all build artifacts (`.aux/.log/.out`). `resumes/output/` holds `.pdf` only.

---

## 5. Outreach

> Cold email only on **explicit request** ("draft cold email for X"). Never auto-generate drafts.

### Cold email template
- **Length:** 120–150 words.
- **Structure:**
  1. **Hook** — specific to their company/role/product (not generic).
  2. **Proof** — ONE best-matching project, one sentence, concrete result.
  3. **Soft CTA** — 15-min chat, low pressure.
- **Tone:** direct, no fluff, no over-flattery.
- **Output:** Gmail draft via `create_draft` (Onkar reviews + sends manually). Log link in Outreach DB.

**Skeleton:**
```
Subject: <Role> — <one sharp differentiator>

Hi <Name>,

<1 sentence: specific thing about their team/product + why it pulls me.>

<1 sentence: strongest matching project + a number/result.>

<1 sentence: soft ask — open to a 15-min chat?>

Thanks,
Onkar
<phone> · github.com/Onkarj012
```

### Follow-up
- Trigger: **4 days** after send, no reply.
- **One** follow-up only, then drop. Keep it 2–3 sentences, reference the original.
- Surfaced as a flagged list; Onkar reviews, Claude drafts.
- (Follow-up tracking configured now; primarily used for cold-email flow.)

---

## 6. Workflow Commands (chat triggers)

| Say | Claude does |
|---|---|
| "pull today's jobs" | 3-layer sourcing (dorked search → ATS JSON watchlist → Indeed fallback) vs Targeting → dedup → gates → score each → write rows to Applications DB w/ today's `Date Pulled` → present ranked top 15–20 |
| "make applications" / `/make-applications` | Local-only: batch-tailor resumes for every `Apply?`-checked row → compile + parse-verify → PDF-only to `resumes/output/` → update Resume Status |
| "tailor for <row/company>" / `/resume-latex` | Read JD → pick 2 projects → tailor `.tex` in `resumes/sources/` → compile → verify 1 page → PDF-only to `resumes/output/` → update row |
| "check my resume" / `/resume-check` | Brutal recruiter review of the `.tex` source vs a pasted JD (or generic fallback) → per-section gaps + rewrites + overall verdict |
| "quick add this job" / `/quick-add` | Gate → dedup → score one user-supplied role → write a single Applications row (never checks `Apply?`) |
| "draft cold email for <company/contact>" | Build email from template → Gmail draft → log Outreach row |
| "follow-ups?" | List sent-cold-emails ≥4 days no-reply → draft follow-ups on request |

- **Pull sources:** (1) WebSearch dorked against `boards.greenhouse.io` / `jobs.lever.co` / `jobs.ashbyhq.com`, (2) ATS JSON APIs for every slug in `companies.json`, (3) Indeed MCP as breadth fallback. See `.claude/skills/daily-job-pull` for the full spec.
- **Trigger:** cloud cron `30 1 * * *` UTC (07:00 IST) + local `/pull-jobs` for ad-hoc manual pulls.
- **Dedup:** skip jobs whose `Job ID` OR `Dedup Key` (normalized company+title+location hash) already exists in Applications.
- **Watchlist auto-grow:** when a row is `Apply?`-checked, resolve its ATS+slug from the JD URL and append to `companies.json` (`source: "auto-grow"`) if not already present.

---

## 7. Pointers

- Resume content SoT: `resumes/master/Master_Resume_ATS.tex` (ATS-clean, default for portal applies) · `resumes/master/Master_Resume.tex` (pretty, for cold-email attachments)
- Tailored `.tex` sources: `resumes/sources/` · compile scratch: `resumes/sources/build/`
- Final PDFs (PDF-only): `resumes/output/Onkar_Jadhav_<Company>_<Role>.pdf`
- Base variants: `resumes/bases/`
- Sourcing watchlist: `companies.json` (project root) — seed + auto-grow company/ATS/slug list for Layer 2 fetch
- Tracking: Notion `Job Search` page → Companies / Applications / Outreach DBs
  - Page: https://app.notion.com/p/3885c2b5d1b081458df2c68954540105
  - Applications data source: `d8d525b0-e436-44b7-ae65-28c08a358684`
  - Companies data source: `9cb28730-1c2e-4e81-bb54-4cb1ac4b3a1d`
  - Outreach data source: `bf40caf6-8b07-4c55-9d21-787b8033f454`
  - Applications fields added in v3: `Company Stage`, `Source Rarity`, `Response Likelihood`, `Auth-Friendly?`, `Auto-Suggest`, `Dedup Key`
- Skills (project-scoped, single-slash): `.claude/skills/daily-job-pull`, `.claude/skills/make-applications`, `.claude/skills/application-agent`, `.claude/skills/resume-latex`, `.claude/skills/resume-check`, `.claude/skills/quick-add`
- Reference prompt (not a skill): `prompts/deep-job-search.md`
