# PRD — Job-Search System Revamp

> Status: ready to build · Source: grilling session 2026-07-01 · No code tracker (files project) — this file IS the PRD.

## Problem Statement

Every time the user opens Claude in the Job Search project, Claude has no idea what the project is, where files live, or who the user is — so it re-asks the same identity/context questions each run. The skills that already exist (`daily-job-pull`, `resume-latex`, `make-applications`, `application-agent`) live in a folder Claude Code doesn't auto-discover, so they aren't single-slash invokable. The root is polluted with build artifacts, three overlapping PLAN files, and a dead duplicate skill tree (`cowork-job-search/`). Tailored resume outputs mix `.tex/.pdf/.aux/.log/.out` in one folder, so finding the single final PDF is painful. The user cannot trust the system because it is incoherent and unpredictable.

## Solution

A self-describing project where Claude reads a `CLAUDE.md` on entry and immediately knows the layout, the source of truth, and the user's frozen identity — so it never re-asks. All skills move to `.claude/skills/` and become single-slash commands. `master_prompt.md` stays the one source of truth every skill reads. The root is cleaned; the directory is reorganized into an obvious structure. Resume outputs are split: editable `.tex` sources in one place, final **PDF-only** in a dedicated `output/` folder named `Onkar_Jadhav_<Company>_<Role>.pdf`. A new `/resume-check` skill provides brutal recruiter-grade review. `/daily-job-pull` runs on a cloud schedule (discovery only); application and resume building stay manual and approval-gated.

## User Stories

1. As the user, I want Claude to know what this project is the moment I open it, so that I don't re-explain it every session.
2. As the user, I want Claude to already know my name, contact, and target roles, so that it never re-asks my details.
3. As the user, I want every skill to be single-slash invokable, so that I can trigger workflows without copy-pasting prompts.
4. As the user, I want one source of truth (`master_prompt.md`), so that changing targeting or rubric in one place changes all skill behavior.
5. As the user, I want to paste a job description and get a tailored resume, so that I can apply fast to a specific role.
6. As the user, I want tailored resumes generated from my master resume only, so that no experience is ever invented.
7. As the user, I want the final resume as a PDF in a dedicated output folder, so that I don't sift through `.tex/.aux/.log/.out` files to find it.
8. As the user, I want the editable `.tex` source kept, so that I can make manual edits and recompile.
9. As the user, I want build artifacts (`.aux/.log/.out`) auto-cleaned after every compile, so that folders stay tidy.
10. As the user, I want a clean, predictable directory, so that Claude and I both navigate it easily.
11. As the user, I want the dead `cowork-job-search/` duplicate removed, so that there's no confusion about which skills are canonical.
12. As the user, I want old PLAN files archived, so that history is kept but out of the way.
13. As the user, I want a `/resume-check` skill that reviews my resume like a brutal senior recruiter, so that I fix weaknesses before applying.
14. As the user, I want resume-check to run against a specific pasted JD, so that feedback is role-aligned.
15. As the user, I want a generic "most common requirements" fallback for resume-check, so that I can review even without a JD in hand.
16. As the user, I want resume-check to read the `.tex` source, so that review targets the editable content.
17. As the user, I want `/daily-job-pull` to run automatically each morning, so that fresh scored roles appear without me remembering to run it.
18. As the user, I want the scheduled pull to only discover and log jobs, so that nothing is ever auto-applied or auto-emailed.
19. As the user, I want application prep and resume building to stay manual, so that I approve everything before it goes out.
20. As the user, I want the daily pull to run in the cloud, so that it fires without my Mac being awake.
21. As the user, I want resume compilation to stay local, so that the LaTeX toolchain on my Mac is used.
22. As the user, I want a `/quick-add` skill, so that I can log a single job fast.
23. As the user, I want `deep-job-search` to remain a reference prompt, so that the rare heavy sweep stays available without cluttering the slash menu.
24. As the user, I want jobs tracked in Notion with a cleaner database and views, so that I can see my pipeline clearly.
25. As the user, I want Claude to propose the new Notion schema before touching live data, so that I approve changes to my real DB.
26. As the user, I want consistent output filenames (`Onkar_Jadhav_<Company>_<Role>.pdf`), so that recruiters see a clean name.
27. As the user, I want two master resumes kept (ATS default + pretty), so that I use the parser-clean one for portals and the pretty one for cold-email attachments.
28. As the user, I want the whole system to feel coherent and trustworthy, so that I rely on it daily without double-checking.

## Implementation Decisions

**Directory reorganization**
```
Job Search/
  CLAUDE.md              project map + frozen identity + guardrails
  master_prompt.md       single source of truth (targeting, rubric, resume/email rules)
  companies.json         Layer-2 watchlist
  .claude/skills/        all slash skills
  resumes/
    master/              Master_Resume.tex + Master_Resume_ATS.tex (ATS default)
    bases/               Base1-3 (+ previews)
    sources/             tailored .tex + build/ scratch
    output/              PDF ONLY
  prompts/               deep-job-search.md
  archive/               PLAN.md, PLAN_v2, PLAN_v3, old logs
  logs/
```

**CLAUDE.md (the "never re-ask" contract)** — thin, not a rubric copy. Contains: directory map; frozen identity block (name, contact, target roles, hard rules) extracted from the master resume; a pointer declaring `master_prompt.md` as source of truth and `resumes/master/Master_Resume_ATS.tex` as resume content; the guardrail that scheduled/auto actions are discovery-only. Rubric/targeting is NOT duplicated here — only referenced — to avoid two drifting sources.

**Skills** move from `skills/` → `.claude/skills/` (project-scoped, not global). Final roster: `daily-job-pull`, `resume-latex`, `make-applications`, `application-agent`, `resume-check` (new), `quick-add` (new, from `prompts/quick-add.md`).

**resume-latex** — paste-JD entry point. Compiles in `resumes/sources/` (or `sources/build/`), copies only the `.pdf` to `resumes/output/` renamed `Onkar_Jadhav_<Company>_<Role>.pdf`, keeps the `.tex` in `sources/`, and deletes `.aux/.log/.out` after compile. `make-applications` is the Notion-batch variant of the same engine.

**resume-check (new)** — one skill, four modes (Diagnoser · Recruiter · Rewriter · Hiring-Manager). Reads the `.tex` source. JD-specific review is primary; a "most-common-requirements" generic fallback exists when no JD is supplied. Output follows the brutal recruiter report structure the user supplied: per-section (What the JD demands / What the CV says / Gap diagnosis / Verdict with 🔴🟠🟢🔵 / rewritten version), then an overall verdict (ATS score estimate, 6-second impression, top-3 critical fixes, top-3 quick wins, honest hire-probability). Tone: red-pen recruiter, no flattery, green only if earned. The Recruiter mode is held to the pasted prompt as its quality bar; Diagnoser/Rewriter/Hiring-Manager modes are authored in the same brutal style (their original Cowork texts are not on disk).

**Scheduling** — a `/schedule` cloud routine runs `/daily-job-pull` each morning. Discovery only: score and log top matches to Notion, never checks `Apply?`, never applies, never emails. Local-only skills (`resume-latex`, `make-applications`) are never scheduled.

**Notion** — remains the tracker of record via connected MCP. Database schema and views get a cleaner redesign; the new schema is proposed and approved before any change to live data.

## Testing Decisions

Good tests here assert **external, observable outcomes**, not internal skill wording:

- **PDF-only invariant** — after any resume skill runs, `resumes/output/` contains only `.pdf` files (no `.aux/.log/.out/.tex`). This is the highest-value check.
- **Single-page filled** — compiled resume is exactly one filled page (existing `resume-latex` page-count + fill verify; keep as-is).
- **Parse-verify guard** — compiled PDF extracts clean text (existing guard in `resume-latex`; prior art for the whole family).
- **No invention** — tailored `.tex` contains only content derivable from the master resume (spot-check against `Master_Resume_ATS.tex`).
- **Filename convention** — every file in `output/` matches `Onkar_Jadhav_<Company>_<Role>.pdf`.
- **Discovery-only guardrail** — a scheduled `daily-job-pull` run never sets `Apply?` and never triggers an application/email.
- **Discoverability** — each skill in `.claude/skills/` is invokable by its slash name.

Prior art: the existing `resume-latex` Steps (page-count verify, parse-verify) and `make-applications` per-row compile-or-log-failure pattern are the templates to reuse.

## Out of Scope

- Building the 3 non-supplied reviewer prompt texts from their original Cowork sources (authored fresh instead).
- Any auto-apply, auto-email, or auto-`Apply?` behavior — permanently excluded by design.
- Migrating the tracker off Notion.
- Global (`~/.claude/skills/`) installation — skills stay project-scoped.
- Rewriting `master_prompt.md`'s targeting/rubric content (structure stays; it remains the source of truth).
- Converting `deep-job-search` into a skill (stays a prompt).

## Further Notes

- Destructive cleanup requires explicit user go, executed reversible-moves-first, deletes-last: DELETE `cowork-job-search/` (dead Cowork mirror, user confirmed Claude Code only), DELETE all build artifacts, DELETE `.DS_Store`; MOVE PLANs → `archive/`; MOVE tailored `.tex` → `resumes/sources/` and `.pdf` → `resumes/output/`.
- The user's stated goal is trust: coherence and predictability matter more than feature count.
- The schedule the user believed existed was not found on disk (no crontab/launchd/Claude cron) — a fresh `/schedule` routine will be created and verified.
