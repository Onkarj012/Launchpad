---
name: resume-latex
description: Build a human-written, JD-matched, single-page LaTeX resume from Onkar's approved master evidence, compile and inspect it locally, and deliver a verified PDF-only output. Use whenever the user asks for a tailored resume, pastes a JD, or asks to re-angle resume bullets for a posting.
---

# Resume to LaTeX

Paste-JD entry point. Produce one truthful, human-written, single-page resume: editable `.tex` in `resumes/sources/<YYYY-MM-DD>/`, and the final verified **PDF** in `resumes/output/<YYYY-MM-DD>/` named `Onkar_Jadhav_<Company>_<Role>.pdf`. A run is incomplete until the content, JD, and artifact gates all pass. Build artifacts never survive.

## Source of truth and template policy
- Read `master_prompt.md` section 4 before tailoring. It is authoritative.
- Approved evidence comes only from `resumes/master/Master_Resume_ATS.tex` (content/evidence source of truth). Never invent experience or strengthen the meaning of approved evidence.
- **Single canonical layout template:** `resumes/templates/Onkar_Template.tex`. Never author a preamble or a resume `.tex` from scratch, and never copy an old file from `resumes/sources/` as a starting point. Workflow:
  ```sh
  mkdir -p "resumes/sources/$(date +%F)"
  cp resumes/templates/Onkar_Template.tex "resumes/sources/$(date +%F)/<name>.tex"
  ```
  Then edit ONLY inside the `%== TAILOR-START: NAME ==` / `%== TAILOR-END: NAME ==` slots: `HEADLINE`, `SUMMARY`, `COURSEWORK`, `EXPERIENCE-BULLETS`, `PROJECTS`, `SKILLS`. Everything outside a slot — the full preamble, section order, section headings, the Stride Experience heading (title, Founder & Lead Engineer, April 2026 -- Present, Remote), and the Education entry itself — is frozen and must not be touched.
- Use the target JD, supplied as text or retrieved from its link, for requirement coverage and project selection within the PROJECTS and SKILLS slots.

## Identity facts (do not re-derive)
- CGPA is **9.17** (Education entry and Summary parenthetical). Never write "9.08" or "up to 7th semester".
- Never use the words "student", "final-year", "graduate", or "graduated" anywhere on a resume. Lead the Summary with engineer identity; the degree is a credential, not the framing.
- Portfolio `leo4.dev` appears in the header (frozen, outside any slot — do not edit it).

## Fixed structure
1. Heading, frozen (name, phone, HEADLINE slot line, email, location, GitHub, leo4.dev, LinkedIn).
2. Summary (SUMMARY slot), rewritten around the strongest truthful hook and highest-value JD language without becoming a keyword list.
3. Education, frozen except the COURSEWORK slot line.
4. Experience, with Stride always present as Founder & Lead Engineer, April 2026 to Present (frozen heading). Only the EXPERIENCE-BULLETS slot is tailorable; the lead bullet states approved traction evidence.
5. Exactly two projects (PROJECTS slot) selected from Lore Engine, StockXpert, GovBench, and PromptForge. Vaani never appears.
6. Technical Skills (SKILLS slot), reordered around the JD. Never add a skill not present in the approved master.

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
- The extended `tests/resume/verify.mjs` passes: template conformance (preamble and every frozen zone outside the tailor slots byte-identical to `resumes/templates/Onkar_Template.tex`), exactly one page, and page fill ≥93% of page height.
- The PDF has been rendered and visually inspected for spacing, clipping, collisions, detached bullets, stray glyphs, and broken links.
- Extracted text follows a clean linear order and preserves section order, contact details, and title/organization/date/location associations.
- Clickable links, fonts, glyphs, and compilation-log warnings have been checked. Unexplained extraction, font, glyph, or layout warnings are failures.
- Grammar, repetition, JD coverage, and the Unicode `—` scan pass on extracted text. The LaTeX source also passes the `---` scan.
- Only the verified PDF is promoted, and all scratch artifacts are removed.
- **Page-fill tuning is done via bullet count/length inside slots only.** Never touch the preamble or a frozen zone to fix underfill or overfill.

## Procedure
1. Read the JD and the approved master. Build the requirement matrix and claim-provenance map.
2. Select the two projects by supported requirement coverage.
3. Copy the template into today's date-partitioned source directory:
   ```sh
   mkdir -p "resumes/sources/$(date +%F)"
   cp resumes/templates/Onkar_Template.tex "resumes/sources/$(date +%F)/Onkar_Jadhav_<Company>_<Role>.tex"
   ```
4. Draft Summary, Coursework, Experience bullets, Projects, and Skills inside their slots only. Run the content and JD gates before touching layout.
5. Compile locally into `resumes/sources/build/`, never the project root or `resumes/output/`:
   ```sh
   export PATH="/opt/homebrew/bin:$PATH"
   pdflatex -interaction=nonstopmode -halt-on-error \
     -output-directory=resumes/sources/build \
     "resumes/sources/$(date +%F)/Onkar_Jadhav_<Company>_<Role>.tex"
   ```
6. Copy the compiled PDF to `resumes/output/$(date +%F)/Onkar_Jadhav_<Company>_<Role>.pdf` (create the date directory if missing), then run the verifier against the exact delivered pair:
   ```sh
   node tests/resume/verify.mjs \
     "resumes/sources/$(date +%F)/Onkar_Jadhav_<Company>_<Role>.tex" \
     "resumes/output/$(date +%F)/Onkar_Jadhav_<Company>_<Role>.pdf"
   ```
   A `FAIL` line blocks delivery. If overfull or a template-conformance drift is reported, fix content inside the affected slot and recompile — never edit outside a slot. If underfilled (<93%), improve content selection or bullet length within slots; do not pad, repeat, or inflate claims.
7. Render for visual inspection with `pdftoppm`, then inspect the image. Do not treat a passing verifier run as visual verification.
8. Extract with `pdftotext` and inspect the complete stream for linear order, associations, contact details, and matrix coverage. Run grammar and repetition checks on the extracted text.
9. Inspect clickable links, `pdffonts`, rendered glyphs, and the full LaTeX log. Resolve unexplained warnings before promotion.
10. Scan the `.tex` for `---` and both `.tex` and extracted text for `—` inside prose (the frozen template itself already uses `---` only as an en-dash-style separator in headings, which is expected and not resume "prose"). Any prose match inside a tailored slot fails the run.
11. Remove that resume's `.aux`, `.log`, `.out`, scratch `.pdf`, `.toc`, `.fls`, `.fdb_latexmk`, and `.synctex.gz` files from `resumes/sources/build/`.
12. Verify `resumes/output/<date>/` contains only the PDF for this run. Report the final PDF path, covered requirements, and unsupported gaps. Update Notion only when the invoking workflow explicitly authorizes it.

## ATS reporting
- Label any internal assessment **ATS readiness**, explain the evidence used, and do not present it as a numeric ATS score.
- Report a numeric ATS score only when obtained from a named external parser such as Enhancv. Record the parser, target JD, date, and result for a valid comparison.

## Hard rules
- Final deliverable is PDF. `.tex` stays in `resumes/sources/<date>/`; only `.pdf` is allowed in `resumes/output/<date>/`.
- Exactly one visually balanced page, page fill ≥93%. No padding for page fill.
- Stride plus exactly two approved projects. Vaani never appears.
- Truthful, provenance-backed content only.
- No em dashes in resume bullets or sentences.
- Never edit outside a `%== TAILOR-START/END ==` slot. If the template itself needs to change, stop and ask — that is a template-policy decision, not a per-resume one.
- Local compilation only. If `pdflatex` is absent, stop and tell the user local compilation is blocked.
