---
name: resume-latex
description: Build a single-page, compile-ready LaTeX resume tailored to a target role from Onkar's master resume, compile it locally, verify it is exactly one filled page, save the PDF-only output to resumes/output/, and delete build artifacts. Use whenever the user asks for a tailored resume, "tailor my CV/resume for [role]", "make my resume for this job", pastes a JD, or asks to re-angle resume bullets for a posting. Trigger on any resume-tailoring or resume-LaTeX request.
---

# Resume → LaTeX

Paste-JD entry point. Produce one compile-ready, **single-page, fully-filled** tailored resume: editable `.tex` kept in `resumes/sources/`, final **PDF only** in `resumes/output/` named `Onkar_Jadhav_<Company>_<Role>.pdf`. Build artifacts never survive.

## Source of truth
- `resumes/master/Master_Resume_ATS.tex` — **default template for every output.** Single-column, parser-clean, no icon fonts; use its `\entry`/`\subentry` macros as-is. Content is identical to `resumes/master/Master_Resume.tex` — only switch to the pretty `Master_Resume.tex` + `references/template.tex` when the user explicitly asks for a non-portal version (cold-email attachment / leo4.dev). **Never invent experience.** Only reframe / reorder / select from the master.
- `master_prompt.md` § 4 (project root) — the tailoring rules (authoritative). Read before tailoring.
- The target JD (link or text) — for keyword mirroring + project selection.

## Fixed structure (per master_prompt.md § 4)
1. **Heading** — unchanged.
2. **Summary** — rewritten to mirror the JD's top 3-4 keywords; lead with the scoring hook.
3. **Experience** — **Stride ALWAYS here.** Founder & Lead Engineer, April 2026 – Present. Lead bullet = traction (production, 5-10 active trial users).
4. **Projects** — **exactly 2**, picked from the pool {Lore Engine, StockXpert, GovBench, PromptForge} by best JD-keyword match. Vaani never appears.
5. **Technical Skills** — reorder so JD-relevant categories surface first. Never add a skill not on the master.

Total on page = 3 blocks (Stride experience + 2 projects). Never more, never fewer.

## Project picker
Rank the 4 pool projects by JD keyword overlap, take top 2:
- RAG / retrieval / search → **Lore Engine**
- ML / DL / quant / time-series → **StockXpert**
- AI safety / eval / governance / bias → **GovBench**
- agentic / prompt pipelines / LLM tooling → **PromptForge**
Tie-break toward variety (avoid two near-identical projects).

## Steps
1. Select the 2 projects; rewrite the summary + bullets to mirror JD vocabulary where truthful (Google XYZ pattern, quantified).
2. Assemble the `.tex` matching the master's macros exactly.
3. **Save the source** to `resumes/sources/Onkar_Jadhav_<Company>_<Role>.tex` (the editable source stays here for manual edits + recompile).
4. **Compile locally** into the scratch build dir (never the root, never `output/`):
   ```
   export PATH="/opt/homebrew/bin:$PATH"
   pdflatex -interaction=nonstopmode -halt-on-error \
     -output-directory=resumes/sources/build \
     resumes/sources/Onkar_Jadhav_<Company>_<Role>.tex
   ```
5. **Verify page count == 1**: `pdfinfo resumes/sources/build/Onkar_Jadhav_<Company>_<Role>.pdf | grep Pages`.
   - If **> 1 page**: trim the weakest bullet first (never shrink geometry).
   - If **< 1 full page / whitespace at bottom**: lengthen bullets, add a relevant master bullet, or expand the summary until the page is full. **An underfilled page is a failure, same as overflow.**
6. **Parse-verify guard** (hard gate, run before declaring done): `pdftotext resumes/sources/build/Onkar_Jadhav_<Company>_<Role>.pdf -` and assert the raw text stream contains email, phone, and at least N JD-matched skill keywords (N = the number mirrored into the summary/skills in Step 1). Catches layout that compiles fine but extracts garbled for an ATS parser. On failure fix the `.tex` (never the PDF) and recompile.
7. **Promote PDF + clean up** (the PDF-only invariant): copy **only** the `.pdf` to `resumes/output/`, then delete every build artifact:
   ```
   cp resumes/sources/build/Onkar_Jadhav_<Company>_<Role>.pdf resumes/output/Onkar_Jadhav_<Company>_<Role>.pdf
   rm -f resumes/sources/build/Onkar_Jadhav_<Company>_<Role>.{aux,log,out,pdf,toc,fls,fdb_latexmk,synctex.gz}
   ```
   After this step `resumes/output/` MUST contain only `.pdf` files (no `.tex/.aux/.log/.out`). The `.tex` lives only in `resumes/sources/`.
8. If a Notion Applications row exists: set Resume Status = Tailored and paste the output PDF path/link into Resume PDF.

## Fill calibration (validated)
Recipe that lands **exactly 1 filled page** with the master template:
- Summary ~4 lines · Education = B.Tech line only (drop HSC + coursework) · Stride 3 bullets · each project 3 bullets · Technical Skills condensed to ~6 rows.
- If a touch of whitespace remains at the bottom: add one more bullet to the strongest block (don't stretch geometry).
- Render to inspect fill: `pdftoppm -png -r 100 resumes/sources/build/<name>.pdf /tmp/chk` then view. (TeX Live + poppler via Homebrew, no sudo.)

## Hard rules
- **PDF-only in `output/`.** `.tex` source in `sources/`, scratch in `sources/build/`, artifacts deleted after every compile.
- Filename convention (every file in `output/`): `Onkar_Jadhav_<Company>_<Role>.pdf`.
- Exactly one page, **filled** — no empty space.
- Stride always in Experience; exactly 2 projects from the 4-pool; Vaani never.
- Truthful only — no invented metrics, employers, or dates. Only reframe/reorder/select from the master.
- Tighten/expand bullets, never the geometry.
- Local-only: needs `pdflatex` on PATH. If absent, stop and tell the user to run locally.
