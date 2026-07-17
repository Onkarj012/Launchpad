---
name: resume-latex
description: Build a human-written, JD-matched, single-page LaTeX resume from Onkar's approved master evidence, compile and inspect it locally, and deliver a verified PDF-only output. Use whenever the user asks for a tailored resume, pastes a JD, or asks to re-angle resume bullets for a posting.
---

# Resume to LaTeX

Paste-JD entry point. Produce one truthful, human-written, single-page resume: editable `.tex` in `resumes/sources/`, and the final verified **PDF** in `resumes/output/` named `Onkar_Jadhav_<Company>_<Role>.pdf`. A run is incomplete until the content, JD, and artifact gates all pass. Build artifacts never survive.

## Source of truth and template policy
- Read `master_prompt.md` section 4 before tailoring. It is authoritative.
- Approved evidence comes only from `resumes/master/Master_Resume_ATS.tex` and `resumes/master/Master_Resume.tex`. Never invent experience or strengthen the meaning of approved evidence.
- Preserve the visual template the user likes, including its overall typography, spacing, and character. For portal applications, its implementation must still produce clean, linear ATS extraction. Styling may not detach titles, organizations, dates, locations, or bullets from their sections.
- Use `Master_Resume_ATS.tex` as the parser-safe implementation baseline. Use the pretty master and `references/template.tex` when the user requests that presentation, while enforcing the same linear-extraction artifact gate.
- Use the target JD, supplied as text or retrieved from its link, for requirement coverage and project selection.

## Fixed structure
1. Heading, unchanged.
2. Summary, rewritten around the strongest truthful hook and highest-value JD language without becoming a keyword list.
3. Experience, with Stride always present as Founder & Lead Engineer, April 2026 to Present. The lead bullet states approved traction evidence.
4. Exactly two projects selected from Lore Engine, StockXpert, GovBench, and PromptForge. Vaani never appears.
5. Technical Skills, reordered around the JD. Never add a skill not present in an approved master.

The page always contains three work blocks: Stride plus two projects.

## Mandatory JD requirement matrix
Build this before selecting projects or writing any resume line. Keep it with the tailored source or review notes.

| Exact JD phrase | Required / preferred | Category | Approved evidence source | Target section | Resume wording | Covered / missing |
|---|---|---|---|---|---|---|

Requirements:
- Give every distinct JD requirement a row. Categorize it as hard skill/tool, responsibility, domain language, qualification, outcome, or role/title language.
- `Approved evidence source` identifies the exact master bullet or skill entry. A project name alone is not provenance.
- Cover every truthfully supportable hard requirement. Place the highest-value required keywords in evidence-bearing Experience or Project bullets where supported; Technical Skills alone is not substantive evidence.
- Use an exact JD phrase once when truthful and natural, then vary wording only when useful for clarity.
- Mark unsupported or ambiguous requirements `Missing`, report them to the user, and never fabricate wording to close them.

## Project picker
Rank all four projects by supported JD requirement coverage, not raw keyword frequency. Take the top two and break ties toward evidence strength and variety:
- RAG, retrieval, search: Lore Engine
- ML, deep learning, quantitative, time series: StockXpert
- AI safety, evaluation, governance, bias: GovBench
- Agentic systems, prompt pipelines, LLM tooling: PromptForge

## Claim provenance gate
Before accepting any line:
- Map every achievement and capability claim to an exact approved master bullet or skill entry.
- Preserve qualifiers, scope, maturity, ownership, and tense. Reframing must retain the source meaning.
- Never turn a target, design capacity, prototype, benchmark, planned feature, or tool familiarity into a shipped achievement or production result. Capability-to-achievement inflation is a hard failure.
- If stronger JD-aligned wording lacks approved evidence, leave that requirement missing and report the gap.

## Human-writing gate
Run this pass after drafting and again after text extraction:
- Perfect grammar, spelling, punctuation, tense, capitalization, and parallel structure.
- Consistent US English throughout.
- **No em dashes in any resume bullet point or sentence.** Rewrite with a period, comma, colon, semicolon, or parentheses. Reject both the Unicode em dash (`—`) and LaTeX triple hyphen (`---`) in resume prose.
- Run lexical and semantic repetition checks across Summary, Experience, Projects, and Technical Skills. Remove duplicate ideas even when phrased differently.
- Use the same opening verb no more than twice across all achievement bullets.
- Do not repeat the same technology list across the Summary, multiple bullets, and Technical Skills. Put technologies in a bullet only when they prove the action.
- Prefer one core achievement per bullet. Use concrete actions, engineering decisions, constraints, and outcomes.
- Remove AI-writing habits: inflated verbs without evidence, adjective stacks, unnecessary explanatory tails, self-praise, commentary about JD fit, repeated `demonstrating`, `showcasing`, or `enabling` clauses, and mechanically uniform bullets.
- Every sentence must be natural to say in an interview and defensible from the approved evidence.

## Three mandatory gates

### 1. Content gate
- Claim provenance is complete and truthful.
- Human-writing and grammar checks pass.
- No capability-to-achievement inflation, em dashes, repeated claims, overused opening verbs, or repeated technology lists remain.

### 2. JD gate
- The requirement matrix is complete.
- Every truthfully supportable hard requirement has natural, evidence-bearing coverage.
- Unsupported requirements are explicitly reported as missing.

### 3. Artifact gate
- The PDF is exactly one visually balanced page, with no conspicuous dead zone, overflow, crowding, or tiny type. Never pad content solely to fill space.
- The PDF has been rendered and visually inspected for spacing, clipping, collisions, detached bullets, stray glyphs, and broken links.
- Extracted text follows a clean linear order and preserves section order, contact details, and title/organization/date/location associations.
- Clickable links, fonts, glyphs, and compilation-log warnings have been checked. Unexplained extraction, font, glyph, or layout warnings are failures.
- Grammar, repetition, JD coverage, and the Unicode `—` scan pass on extracted text. The LaTeX source also passes the `---` scan.
- Only the verified PDF is promoted, and all scratch artifacts are removed.

## Procedure
1. Read the JD and approved masters. Build the requirement matrix and claim-provenance map.
2. Select the two projects by supported requirement coverage.
3. Draft Summary, Experience, Projects, and Skills. Run the content and JD gates before touching layout.
4. Save the editable source to `resumes/sources/Onkar_Jadhav_<Company>_<Role>.tex`.
5. Compile locally into `resumes/sources/build/`, never the project root or `resumes/output/`:
   ```sh
   export PATH="/opt/homebrew/bin:$PATH"
   pdflatex -interaction=nonstopmode -halt-on-error \
     -output-directory=resumes/sources/build \
     resumes/sources/Onkar_Jadhav_<Company>_<Role>.tex
   ```
6. Confirm one page with `pdfinfo`. If overfull, trim the weakest content first, never the geometry. If visually underfilled, improve content selection or spacing within the liked template; do not pad, repeat, or inflate claims.
7. Render for visual inspection with `pdftoppm`, then inspect the image. Do not treat successful compilation as visual verification.
8. Extract with `pdftotext` and inspect the complete stream for linear order, associations, contact details, and matrix coverage. Run grammar and repetition checks on the extracted text.
9. Inspect clickable links, `pdffonts`, rendered glyphs, and the full LaTeX log. Resolve unexplained warnings before promotion.
10. Scan the `.tex` for `---` and both `.tex` and extracted text for `—`. Any prose match fails the run.
11. Copy only the verified PDF to `resumes/output/Onkar_Jadhav_<Company>_<Role>.pdf`, then remove that resume's `.aux`, `.log`, `.out`, scratch `.pdf`, `.toc`, `.fls`, `.fdb_latexmk`, and `.synctex.gz` files.
12. Verify `resumes/output/` contains only PDF files. Report the final PDF path, covered requirements, and unsupported gaps. Update Notion only when the invoking workflow explicitly authorizes it.

## ATS reporting
- Label any internal assessment **ATS readiness**, explain the evidence used, and do not present it as a numeric ATS score.
- Report a numeric ATS score only when obtained from a named external parser such as Enhancv. Record the parser, target JD, date, and result for a valid comparison.

## Hard rules
- Final deliverable is PDF. `.tex` stays in `resumes/sources/`; only `.pdf` is allowed in `resumes/output/`.
- Exactly one visually balanced page. No padding for page fill.
- Stride plus exactly two approved projects. Vaani never appears.
- Truthful, provenance-backed content only.
- No em dashes in resume bullets or sentences.
- Local compilation only. If `pdflatex` is absent, stop and tell the user local compilation is blocked.
