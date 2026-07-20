---
name: resume-latex
description: Tailor and locally verify a one-page resume when the user supplies a JD, asks for a tailored resume, or requests role-specific resume wording.
---

# Resume to LaTeX

Build one evidence pack: a JD-matched source, its matrix and provenance sidecars, and a locally verified PDF. `master_prompt.md` §4 is the policy source; `resumes/evidence/README.md` is the audit-record contract.

## Steps

1. **Frame.** Read the JD, `master_prompt.md` §4, the approved master, `resumes/profiles/README.md`, and the selected profile. Create `<stem>.matrix.md` and `<stem>.provenance.md` from the contract before drafting.
   *Done when:* every distinct JD requirement has a matrix row and the profile is recorded in both sidecars.

2. **Select.** Choose the two projects by supported requirement coverage and map every factual summary sentence, bullet, and skills claim to `resumes/evidence/approved-evidence.md`.
   *Done when:* every supported hard requirement has evidence-bearing coverage or is explicitly `Missing`, and every planned factual claim has a valid locator.

3. **Draft.** Copy `resumes/templates/Onkar_Template.tex` into `resumes/sources/<YYYY-MM-DD>/` and edit only its six tailor slots. Preserve the exact source meaning, qualifiers, maturity, metrics, and ownership.
   *Done when:* the source has Stride plus exactly two approved projects, no Vaani, no fabricated claim, no em dash in tailored prose, and no frozen-zone change.

4. **Verify content.** Complete the human-writing and JD gates in `master_prompt.md` §4: grammar, US English, natural interview-defensible wording, no repeated claim/technology list, no opening verb more than twice, and no capability-to-achievement inflation.
   *Done when:* the matrix and provenance sidecars account for every requirement and factual claim with all unsupported requirements visible.

5. **Compile and inspect.** Follow `references/artifact-gate.md` exactly. A verifier failure blocks promotion; fix only tailored content and repeat the gate.
   *Done when:* the delivered PDF passes the verifier, visual inspection, text-order inspection, and log review; only the PDF is in the dated output directory and build scratch is removed.

6. **Report.** State the selected profile, PDF path, covered requirements, real gaps, and the three gate results. Update a tracker only when the invoking workflow authorizes it.
   *Done when:* the user can distinguish a verified artifact from an unsupported requirement or unverified item.

## Fixed facts

CGPA is 9.17. The frozen header retains `leo4.dev`. Do not use `student`, `final-year`, `graduate`, or `graduated` on the resume. Local compilation is required; if `pdflatex` is unavailable, stop before claiming a final PDF.
