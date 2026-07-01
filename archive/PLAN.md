# Job Search OS — Rebuild Plan

Status: **BUILT (2026-06-23).** Phases 1–5 done. Notion page + 3 DBs + 5 views live; TeX Live + poppler installed; resume restructured & 1-page-verified; skills refactored.
Companion doc: `master_prompt.md` (the runtime rules). This doc = the build.

**Live IDs** — Job Search page `3885c2b5-d1b0-8145-8df2-c68954540105` · Applications ds `d8d525b0-e436-44b7-ae65-28c08a358684` · Companies ds `9cb28730-1c2e-4e81-bb54-4cb1ac4b3a1d` · Outreach ds `bf40caf6-8b07-4c55-9d21-787b8033f454`.
**Manual leftover:** the `Today` view has no filter (Notion API can't set relative-date filters) — open it, add filter `Date Pulled` → `is` → `Today`, then set it as the default view. The `By Date` board already buckets today-on-top as a fallback.

---

## 0. Goal

Replace the single flat `Applications` mega-table with a clean relational Notion system + a local artifact pipeline, supporting four flows:
1. **Daily pull** — Indeed → scored → today's jobs in Notion.
2. **Tracking** — relational, scalable, good default UI.
3. **Tailored resume** — JD → 1-page filled PDF, local + Drive-synced.
4. **Cold email** — on-demand Gmail drafts + 4-day follow-up tracking.

---

## 1. Decisions Locked (from grilling)

| # | Decision |
|---|---|
| Schema | Relational, **3 DBs**: Companies, Applications, Outreach (Contacts merged into Outreach) |
| Old data | Archive old `Applications` DB; start fresh |
| Pull source | Indeed only now; schema leaves a `Source` field for later sources |
| Scoring | Claude scores 0–100; **no auto-apply**; manual `Apply?`; ~5–7 apps/day |
| Resume home | PDF → local `Resumes/Tailored/` → manually synced to Drive; link embedded in Notion (view-only) |
| Resume structure | Stride always in **Experience** (Founder & Lead Engineer, Apr 2026–Present) + **2** projects from pool {Lore Engine, StockXpert, GovBench, PromptForge} |
| Page rule | Exactly 1 page, **must be filled** (no whitespace) |
| Targeting | Lives in `master_prompt.md` |
| Email | Gmail drafts, on explicit request only; 120–150 words; 4-day single follow-up |
| Split | Local repo = artifacts + prompts (SoT); Notion = tracking only |
| Skills | Refactor existing 3 skills to new schema (not scrap) |
| LaTeX | Install BasicTeX locally (currently missing from PATH) |
| Trigger | Manual chat commands for now (cron later) |

---

## 2. Current State (audited)

```
Job Search/
├── Master_Resume.tex          # SoT, 5 project blocks, 1-pg-ish
├── master_prompt.md           # NEW (just written)
├── README.md
├── prompts/                   # deep-job-search.md, quick-add.md
├── skills/
│   ├── daily-job-pull/SKILL.md
│   ├── application-agent/SKILL.md
│   └── resume-latex/SKILL.md  # + references/
├── Resumes/
│   ├── Bases/                 # Base1_AI_RAG_LoreEngine, Base2_FullStack_Stride, Base3_Agentic_PromptForge (.tex + preview.pdf)
│   └── Tailored/              # Onkar_Jadhav_Zyvora_AI_SWE.tex + .pdf
├── cowork-job-search/         # older duplicate of skills/prompts (legacy)
└── logs/
```

**Notion now:** `Job Search Tracker` page → one `Applications` DB (data source `2ecc555a…`), 25+ flat props, 4 views (All Jobs, Pipeline board, Resume Queue, By Date). Sibling hub `Dev & Career OS`.

**Risks found:**
- `pdflatex/xelatex/lualatex` NOT in PATH — existing PDFs built elsewhere. **Must install before resume flow works.** Onkar will also re-download current resume project zip + all resumes.
- `cowork-job-search/` duplicates `skills/` + `prompts/` — legacy clutter to consolidate or delete.

---

## 3. Target Architecture

### 3.1 Notion — new `Job Search` page, 3 linked DBs

**DB: Companies**
| Prop | Type | Notes |
|---|---|---|
| Name | Title | |
| Industry | Select | |
| Size | Select | <50 / 50–200 / 200–1k / 1k+ |
| Website | URL | |
| Notes | Text | |
| Applications | Relation → Applications | rollup of all roles at company |

**DB: Applications** (the workhorse)
| Prop | Type | Notes |
|---|---|---|
| Role | Title | |
| Company | Relation → Companies | |
| Status | Select | Researching / Applied / OA / Interview / Offer / Rejected / Ghosted |
| Apply? | Checkbox | **manual** |
| Match Score | Number | Claude, 0–100 |
| Freshness | Select | Tier A 24h / B 3d / C 5d |
| Source | Select | Indeed (extensible) |
| Job ID | Text | dedup key |
| JD Link | URL | |
| JD Text | Text | |
| Location | Text | |
| Posted Date | Date | |
| Date Pulled | Date | drives "Today" view |
| Date Applied | Date | |
| Positioning | Text | the scoring hook / angle |
| Resume Status | Select | Not Started / Tailored / Sent |
| Resume PDF | URL | Drive link → in-Notion preview |
| Outreach | Relation → Outreach | |
| Notes | Text | |

**DB: Outreach** (Contacts merged in)
| Prop | Type | Notes |
|---|---|---|
| Contact Name | Title | |
| Company | Relation → Companies | |
| Application | Relation → Applications | |
| Email | Email | |
| Title/Role | Text | their job title |
| LinkedIn | URL | |
| Type | Select | Cold / Follow-up |
| Gmail Draft | URL | link to draft |
| Sent Date | Date | |
| Follow-up Date | Date | |
| Days Since Sent | Formula | `dateBetween(now(), Sent Date, "days")` |
| Follow-up Flag | Formula | true if ≥4 days & no reply & Cold |
| Status | Select | Draft / Sent / Replied / Follow-up Sent / Closed |

**Views (Applications):**
- **Today** (DEFAULT) — table filtered `Date Pulled is Today`, sorted Match Score desc. Onkar changes the date filter to see older pulls.
- **By Date** — board grouped by Date Pulled (relative).
- **Pipeline** — board grouped by Status.
- **Resume Queue** — filtered `Apply? = true`, sorted Match Score desc.
- **All Jobs** — full table.

> "Open Notion → see only today's jobs, switch date for older" = the **Today** view as the page default. Notion has no live date-param control, so older pulls = edit the date filter or use the By Date board.

### 3.2 Local pipeline (SoT for artifacts)
- `master_prompt.md` — rules (done).
- `Master_Resume.tex` — restructured: Stride→Experience, 4-project pool intact for picking.
- `Resumes/Tailored/Resume_Onkar_<Company>_<Role>_<YYYYMMDD>.{tex,pdf}`.
- BasicTeX installed; compile + page-count verify in the resume skill.
- Drive sync = Onkar's existing Drive-for-Desktop folder (manual sync); skill writes PDF there.

---

## 4. Build Sequence

> Order matters: prompt → resume source → compile toolchain → Notion → skills.

**Phase 1 — Foundations** ✅ master_prompt.md written. ⬜ This plan approved.

**Phase 2 — LaTeX toolchain**
- Install BasicTeX (`brew install --cask basictex`) + needed packages (`cfr-lm`, `fontawesome5`, `tcolorbox`, `enumitem`, `titlesec`, `multicol` via `tlmgr`).
- Smoke-test: compile current `Master_Resume.tex` → confirm 1 page.
- Confirm Drive-synced folder path.

**Phase 3 — Restructure Master_Resume.tex**
- Add **Experience** section; move Stride there as `Founder & Lead Engineer`, Apr 2026–Present, traction lead bullet.
- Keep Lore Engine / StockXpert / GovBench / PromptForge as the pickable project pool.
- Verify still compiles to a full single page in the "Stride + 2 projects" default shape.

**Phase 4 — Notion rebuild**
- Archive old `Applications` DB (rename `Applications (archived)`, keep page).
- Create `Job Search` page.
- Create Companies, Applications, Outreach DBs with schema above + relations.
- Build the 5 views; set **Today** as default.
- Embed-test: paste a Drive PDF link in a row, confirm in-Notion preview.

**Phase 5 — Refactor skills**
- `daily-job-pull` → Indeed search vs Targeting, score via rubric, dedup on Job ID, write to new Applications schema, stamp Date Pulled.
- `application-agent` → orchestrates: present ranked list, on pick set Apply?, drive resume + outreach.
- `resume-latex` → new structure rules, compile + **page-count==1 guard**, output naming, copy to Drive folder, write Resume PDF link back to Notion.
- Consolidate/delete legacy `cowork-job-search/` duplication.

**Phase 6 — Dry run**
- "pull today's jobs" → verify rows + scores + Today view.
- Tailor one real JD → 1-page filled PDF → Notion preview.
- Draft one cold email → Gmail draft + Outreach row.

---

## 5. Open Items / Confirms Needed

- `[CONFIRM]` Targeting blanks in `master_prompt.md`: experience-year hard cap, acceptable cities, salary floor, any stack dealbreakers.
- `[CONFIRM]` Drive-synced folder absolute path (e.g. `~/Library/CloudStorage/GoogleDrive-.../JobSearch/Resumes/`).
- `[DECIDE]` Stride traction wording — exact number of trial users to state (5–10?).
- `[DECIDE]` Delete `cowork-job-search/` legacy dir, or keep as backup?
- `[NOTE]` Onkar re-downloading current resume project zip + all resumes before Phase 3.

---

## 6. Out of Scope (later)

- Cron / scheduled auto-pull.
- Additional pull sources (LinkedIn etc.) — schema-ready, not built.
- Pattern-guess contact emails (Q8 — skipped for now).
- Auto-send of any email (always manual).
