---
name: resume-check
description: Brutal recruiter-grade review of Onkar's resume and final PDF against a target JD, with auditable requirement coverage, provenance, human-writing, grammar, repetition, and ATS artifact checks. Use for resume checks, reviews, red-pen feedback, or pre-application validation.
---

# Resume Check

Red-pen, recruiter-grade review. No flattery. Find the weaknesses before a recruiter or parser does, then give truthful fixes.

## Source of truth
- Read `master_prompt.md` sections 2 through 4.
- Review the target `.tex` source and, when a compiled tailored PDF exists, review the matching final PDF artifact too. Default source: `resumes/master/Master_Resume_ATS.tex`. Tailored sources live in `resumes/sources/` and final PDFs in `resumes/output/`.
- Approved evidence comes only from `resumes/master/Master_Resume_ATS.tex` and `resumes/master/Master_Resume.tex`.
- Preserve the visual template the user likes, but treat broken or non-linear ATS extraction as a failure regardless of appearance.

## JD handling
- **JD-specific is primary.** Review every section and the final artifact against that JD.
- **Generic fallback:** if no JD is supplied, use the common requirements for the target families in `master_prompt.md` and state that the result is a generic readiness pass, not a precise keyword-match review.

## Mandatory requirement matrix
For a JD-specific review, produce one row per distinct requirement:

| Exact JD phrase | Required / preferred | Category | Approved evidence source | Target section | Resume wording | Covered / missing |
|---|---|---|---|---|---|---|

- Categories: hard skill/tool, responsibility, domain language, qualification, outcome, and role/title language.
- Provenance must name the exact approved master bullet or skill entry.
- Require complete coverage of every truthfully supportable hard requirement, with high-value required keywords in evidence-bearing bullets when supported.
- Technical Skills alone does not prove a responsibility or achievement.
- Mark unsupported or ambiguous requirements `Missing`. Never invent content to close a gap.

## Four lenses
Default to Recruiter unless the user names another mode.
- **Diagnoser:** clinical matrix-led gap analysis for every JD requirement.
- **Recruiter:** six-second scan plus the full report structure below.
- **Rewriter:** concrete, provenance-backed rewrites for weak sections.
- **Hiring Manager:** substance, ownership, evidence, and interview credibility over raw keyword count.

## Three review gates

### 1. Content gate
- Map every claim to an exact approved master bullet or skill entry.
- Flag capability-to-achievement inflation: a target, design capacity, prototype, benchmark, planned feature, or tool familiarity presented as a shipped achievement or production result.
- Check perfect grammar, spelling, punctuation, tense, capitalization, parallel structure, and consistent US English.
- **No em dashes in any resume bullet point or sentence.** Scan for the Unicode em dash (`—`) and LaTeX triple hyphen (`---`). Rewrite matches with a period, comma, colon, semicolon, or parentheses.
- Run lexical and semantic repetition checks across all sections. Flag duplicated claims even when paraphrased.
- The same opening verb may appear no more than twice across achievement bullets.
- Flag repeated technology lists, overloaded bullets, promotional commentary, self-praise, adjective stacks, JD-fit explanations, repeated `demonstrating`/`showcasing`/`enabling` tails, and mechanically uniform bullet structures.
- Prefer one interview-defensible achievement per bullet.

### 2. JD gate
- Complete the requirement matrix before judging sections.
- Confirm every truthfully supportable hard requirement has natural, evidence-bearing coverage.
- Distinguish exact phrase coverage from substantive evidence.
- Report every unsupported requirement as a genuine gap rather than proposing fabricated wording.

### 3. Artifact gate
When the tailored PDF exists:
- Confirm exactly one visually balanced page without padding, conspicuous dead space, overflow, crowding, or tiny type.
- Render and inspect the PDF for spacing, clipping, collisions, detached bullets, stray glyphs, and broken links.
- Extract all text and verify linear section order, contact details, JD coverage, and title/organization/date/location associations.
- Check clickable links, embedded or substituted fonts, glyph rendering, and compilation-log warnings when the log is available.
- Run grammar, lexical repetition, semantic repetition, and Unicode `—` checks on extracted text; scan the source for `---`.
- Treat unexplained extraction, font, glyph, link, layout, or log warnings as failures.
- Verify final output is a PDF and scratch artifacts have been cleaned up.

If no PDF exists, mark the artifact gate `Not verified`; source review alone cannot clear the resume for submission.

## Recruiter report structure
For Summary, Experience/Stride, each Project, Technical Skills, and Education:
- **What the JD demands:** concrete requirement or signal.
- **What the resume says:** current evidence.
- **Provenance:** exact approved master source, or `Unsupported`.
- **Gap diagnosis:** missing keyword, weak evidence, inflated claim, grammar issue, repetition, buried lede, or artifact defect.
- **Verdict:** red critical, orange weak, green strong, or blue over-engineered/cut.
- **Rewritten version:** truthful, provenance-backed wording with no em dash.

Then report:
- Requirement matrix and unsupported gaps.
- Content gate, JD gate, and artifact gate results separately.
- **ATS readiness:** an evidence-based internal assessment with limitations, not a numeric ATS score.
- **External ATS score:** include a number only if supplied by a named parser such as Enhancv, with parser, JD, date, and result. Never relabel an internal estimate as an external score.
- Six-second impression.
- Top three critical fixes and top three quick wins.
- Honest call on whether the current PDF is ready to submit.

## Tone and rewrite rules
- No warm-up, compliment sandwich, or praise without evidence.
- Every critical or weak finding includes a concrete fix.
- Rewrites may reframe, reorder, select, shorten, or combine approved evidence only when meaning remains equivalent.
- Never strengthen scope, ownership, maturity, metrics, or outcomes. If the evidence cannot support a requirement, say so plainly.

## Procedure
1. Read the target `.tex`, matching PDF if present, approved masters, and target JD.
2. Build the requirement matrix and claim-provenance map.
3. Run content and JD gates section by section.
4. Run the artifact gate on the rendered and extracted final PDF when present.
5. Produce the requested lens report and separate gate verdicts.
6. Offer to hand approved rewrites to `resume-latex` for regeneration. Do not claim submission readiness until a final PDF passes all three gates.
