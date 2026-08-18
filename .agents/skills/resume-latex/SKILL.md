---
name: resume-latex
description: Tailor one JD into a verified one-page PDF from the frozen template.
disable-model-invocation: true
---

# Resume build

Vocabulary: `../guardrails.md`. Policy: `master_prompt.md`. Layout: `resumes/templates/Onkar_Template.tex`. Evidence: `resumes/master/Master_Resume_ATS.tex`.

## Steps

1. Copy the frozen template into `resumes/sources/<date>/Onkar_Jadhav_<Company>_<Role>.tex`.
2. Edit only `%== TAILOR-START/END ==` slots. Capgemini stays frozen. Stride stays in Experience. Exactly two other approved projects go under Engineering Projects. No em dash. No invented claims.
3. Write `<stem>.matrix.md` and `<stem>.provenance.md` beside the source.
4. Compile and place the PDF with `createLocalResumeBuilder()` from `resume-v5/local-builder.mjs`.
5. Verify with `createLocalPdfVerifier()` / `node tests/resume/verify.mjs <source.tex> <output.pdf>`.
6. Delete `resumes/sources/<date>/build/` artifacts. Leave only the PDF in `resumes/output/<date>/`.

## Done when

- PDF exists at `resumes/output/<date>/Onkar_Jadhav_<Company>_<Role>.pdf`
- Source plus matrix and provenance sit beside each other under `resumes/sources/<date>/`
- `verifyFile` returns `PASS`
- Frozen zones match the template byte-for-byte
- Missing JD requirements are listed, not invented

Stop if LaTeX or verification is unavailable. user-owned boxes stay untouched. local-compile only. no auto-apply.
