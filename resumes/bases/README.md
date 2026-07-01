# Base Resume System

Three stable, single-page base resumes. Each locks the format, macros, and StockXpert + GovBench. Only the **rotating slot-3 project** changes between bases. Per job, you (or I) edit **only the three SWAP ZONES** — never the layout.

| Base | Slot-3 project | Use for |
|------|----------------|---------|
| `Base1_AI_RAG_LoreEngine.tex` | Lore Engine | AI / LLM / GenAI / RAG / ML roles |
| `Base2_FullStack_Stride.tex` | Stride | Full-stack, product, web, SDE roles |
| `Base3_Agentic_PromptForge.tex` | PromptForge | Agentic AI, multi-agent, LLM tooling/orchestration |

## The only things you change per job (SWAP ZONES)

1. **Title** (header line) — match the JD's role name.
2. **Summary** — swap 1-2 nouns to mirror the JD. Keep it 3-4 lines. Truthful only.
3. **Skills** — reorder the lines so the JD's top keywords lead; add only skills you can honestly claim.

Everything else (bullets, projects, geometry, fonts) stays untouched, so the format never breaks and it stays one page.

## Compiling

These use your real template (`cfr-lm` + `fontawesome5`) and compile as-is on **Overleaf** (pdflatex). The `_preview.pdf` files were rendered here with a substitute font and **no icons** (those packages aren't installed in this environment) — they exist only to confirm one-page fit and overall layout. Your Overleaf build is the true render.

## Map for the 6 jobs currently logged (23 Jun pull)

- **Zyvora** (agentic AI SWE) -> Base 3 (Agentic)
- **Spearmint** (AI agents + MERN) -> Base 3 (Agentic)
- **MyAdvice** (GenAI / RAG) -> Base 1 (AI/RAG)
- **Meru Land** (TS/React/Next AI SaaS) -> Base 2 (Full-Stack)
- **CYBERSYNC** (full-stack fresher) -> Base 2 (Full-Stack)
- **TwarIT** (data scientist) -> Base 1, but reorder so StockXpert leads

## To verify before sending

- PromptForge GitHub URL in Base 3 is assumed as `github.com/Onkarj012/PromptForge` — confirm it matches your real repo.
- Recheck it is still one page after a swap (long titles/skills can push it over; tighten the skills line, not the geometry).
