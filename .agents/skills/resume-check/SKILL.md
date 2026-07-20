---
name: resume-check
description: Review a resume against a JD before application, with evidence provenance, requirement coverage, and final-PDF artifact checks.
---

# Resume check

Run a red review that separates unsupported content, uncovered JD requirements, and artifact defects. `master_prompt.md` §4 is the review policy; `resumes/evidence/README.md` defines the required audit record.

## Steps

1. **Load.** Read the target source, matching PDF when present, JD, approved master, evidence sidecars, and selected base profile.
   *Done when:* every review input is identified, or its absence is stated as `Not verified`.

2. **Trace.** Check the complete requirement matrix and provenance table against `resumes/evidence/approved-evidence.md` and the master anchors.
   *Done when:* every JD requirement is `Covered` or `Missing`, and every factual resume claim has a valid source locator or is flagged.

3. **Read.** Review Summary, Stride, both projects, Skills, and Education for truth, scope, grammar, US English, readability, repetition, opening verbs, and interview defensibility.
   *Done when:* each section has an evidence-backed verdict and every proposed rewrite preserves approved meaning.

4. **Inspect artifact.** When a PDF exists, run `node tests/resume/verify.mjs <source.tex> <output.pdf>` and perform the manual visual, extraction-order, and log checks in `../resume-latex/references/artifact-gate.md`.
   *Done when:* artifact status is `Pass`, `Fail`, or `Not verified`; source review alone never clears submission readiness.

5. **Report.** Use `references/report-shape.md`. Label the internal result **ATS readiness**, never an ATS score; quote an external ATS number only with its named parser, target JD, date, and result.
   *Done when:* the user receives a clear submit/no-submit call, real gaps, and provenance-safe fixes.
