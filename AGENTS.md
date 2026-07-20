# Launchpad — project map & contract

This is Onkar Jadhav's job-search system: discover roles → score against targeting → tailor a one-page resume → track in Notion. Read this file on entry; you already know the layout, the source of truth, and who the user is. **Do not re-ask identity or project questions answered below.**

## Source of truth
- **`master_prompt.md`** (project root) is the single source of truth for targeting, scoring rubric, resume tailoring rules, and outreach. Every skill reads it. Change behavior there, not here — this file does **not** duplicate the rubric.
- **Resume layout:** `resumes/templates/Onkar_Template.tex` is the single canonical, frozen layout template. Every tailored resume starts as a copy of it; only its `%== TAILOR-START/END ==` slots (HEADLINE, SUMMARY, COURSEWORK, EXPERIENCE-BULLETS, PROJECTS, SKILLS) are editable per JD.
- **Resume content:** `resumes/master/Master_Resume_ATS.tex` is the approved-evidence source of truth. Never invent experience — tailoring only reframes/reorders/selects from it.

## Frozen identity (do not re-ask)
- **Name:** Onkar Jadhav
- **Email:** onkarj012@gmail.com · **Phone:** +91-7058604679
- **GitHub:** github.com/Onkarj012 · **LinkedIn:** linkedin.com/in/onkarj012 · **Portfolio:** leo4.dev
- **Location:** Pune, Maharashtra, India
- **Education:** B.Tech Computer Science, PCCOE (SPPU) — 9.17 CGPA — graduating Jun 2026
- **Status:** final-year student / new-grad, fresher (0–1 yr)
- **Target titles:** AI/LLM Engineer, Agentic AI Engineer, ML Engineer, Full-Stack (AI-leaning), Backend (Python), New-grad SWE
- **Headline work:** Stride (shipped, in use — always in Experience as Lead Engineer), Lore Engine (RAG), StockXpert (DL equity), GovBench (LLM governance), PromptForge (agentic). Vaani exists but is never put on tailored resumes.
- Full targeting/gates/rubric live in `master_prompt.md` §§ 2–4.

## Directory map
```
Job Search/
  AGENTS.md            ← this file (map + identity + guardrails)
  master_prompt.md     ← source of truth (targeting, rubric, resume/email rules)
  companies.json       ← Layer-2 ATS watchlist for daily-job-pull
  .agents/skills/     ← all slash skills (project-scoped, single-slash invokable)
  resumes/
    templates/         Onkar_Template.tex ← frozen canonical layout truth (+ preview PDF)
    master/            Master_Resume_ATS.tex ← content/evidence source of truth
    sources/           <YYYY-MM-DD>/ tailored .tex sources (date-partitioned) + build/ compile scratch
    output/            <YYYY-MM-DD>/ final PDFs ONLY — Onkar_Jadhav_<Company>_<Role>.pdf
  prompts/             deep-job-search.md (reference prompt, run occasionally — not a skill)
  archive/             old PLAN files, old logs, pre-template resume bases/sources/outputs (history, out of the way)
  logs/                run logs
```

## Skills (single-slash)
- `/morning` — daily entry point: runs `daily-job-pull` end-to-end, presents Strict-first shortlist, surfaces due follow-ups. Skips if today's pull already ran, unless forced. **Discovery only.**
- `/daily-job-pull` — full discovery engine (tracked boards, reverse Greenhouse/Lever/Ashby/Workday, public/startup feeds, broad WebSearch, watchlist, optional Indeed) → normalize → gate → score → diversify → log 15-20 to Notion. **Discovery only.** Usually invoked via `/morning`, not directly.
- `/quick-add` — log one user-found role (gate → score → single row).
- `/followups` — surface applications/cold-emails due a follow-up today (fixed cadence), draft on request. **Never sends.**
- `/resume-latex` — paste a JD → tailored one-page PDF-only to `resumes/output/<date>/`, built from `resumes/templates/Onkar_Template.tex`.
- `/make-applications` — batch-tailor every `Apply?`-checked Notion row (local-only).
- `/resume-check` — brutal recruiter review of the `.tex` source vs a JD (or generic fallback).
- `/application-agent` — full single-role workflow (research → fit → resume → optional cold email).

## Guardrails (non-negotiable)
- **No auto-apply, ever.** No skill checks `Apply?`, submits an application, or sends an email autonomously. `Apply?` is always a manual user action; `Auto-Suggest` is an opinion, not a command.
- **Scheduled / cloud runs are discovery-only** — a scheduled `daily-job-pull` scores and logs to Notion and nothing else.
- **Resume compilation is local-only** — needs the Mac LaTeX toolchain; never runs headless/cloud.
- **PDF-only output** — `resumes/output/<date>/` contains only `.pdf`; `.tex` stays in `resumes/sources/<date>/`; build artifacts are deleted after every compile.
- **Never fabricate** experience, metrics, dates, salaries, contacts, or links. Unknown → blank or "Not Verified".
- **Notion is the tracker of record** — propose any schema change and get approval before touching live data.

## Imported Claude Cowork project instructions
