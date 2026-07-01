# Job Search — Onkar Jadhav

Cowork project folder. Skills auto-trigger in Cowork; prompts are paste-and-run.

## Structure

```
Job Search/
├── Master_Resume.tex              ← source of truth (never edit tailored versions directly)
├── Resumes/
│   ├── Bases/                     ← three stable base resumes, one per role family
│   │   ├── Base1_AI_RAG_LoreEngine.tex    → AI / LLM / GenAI / RAG / ML
│   │   ├── Base2_FullStack_Stride.tex     → Full-stack / product / SDE
│   │   └── Base3_Agentic_PromptForge.tex  → Agentic AI / multi-agent / tooling
│   └── Tailored/                  ← per-company tailored resumes
├── skills/                        ← auto-trigger Cowork skills
│   ├── application-agent/         "apply to [company]" → 8-step application package
│   ├── daily-job-pull/            "pull today's jobs"  → Indeed → ranked → Notion
│   └── resume-latex/              "tailor my resume"   → single-page .tex
│       └── references/template.tex
├── prompts/                       ← paste-and-run prompts
│   ├── deep-job-search.md         weekly strategic sweep + 30-day plan
│   └── quick-add.md               log one role fast
└── logs/                          ← daily/weekly job pull outputs
```

## Skills

Install each folder under `skills/` as a Cowork skill. Once installed, natural phrasing triggers them automatically.

| Skill | Trigger phrases |
|-------|-----------------|
| `daily-job-pull` | "pull today's jobs", "find new jobs", "job refresh", "check Indeed" |
| `application-agent` | "apply to [company]", "run the application agent", "prep my application" |
| `resume-latex` | "tailor my resume", "give me the .tex", "tailor my CV for [role]" |

## Resume system

- Slots 1–2 always **StockXpert** + **GovBench**.
- Slot 3 rotates: **Lore Engine** (AI/RAG) · **Stride** (full-stack) · **PromptForge** (agentic).
- **Vaani never included.**
- Per-job edits: title, summary, and skills reorder only (the three SWAP ZONES). Bullets and geometry stay fixed.

## House rules

- No em-dashes in outreach.
- One follow-up only, then move on.
- Draft everything; user approves before anything sends.
- Never invent contacts, emails, salaries, or company facts — mark unverifiable as "Not Verified".
