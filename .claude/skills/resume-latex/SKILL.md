---
name: resume-latex
description: Build and verify one truthful, one-page, JD-tailored v5 resume locally from the frozen template and approved master evidence. Never edits frozen zones or submits an application.
disable-model-invocation: true
---

# Resume build

Copy `resumes/templates/Onkar_Template.tex` into `resumes/sources/<date>/`, edit only tailor slots using approved evidence from `resumes/master/Master_Resume_ATS.tex`, and create the requirement matrix and provenance sidecar. Compile locally with the Mac LaTeX toolchain, run `tests/resume/verify.mjs` against the exact delivered PDF, and remove build artifacts. Only the PDF belongs in `resumes/output/<date>/`.

Keep Stride and exactly two approved projects, preserve truthful qualifiers, use no em dash in tailored prose, and report missing requirements. If local compilation or verification is unavailable, stop with a blocked result. Never change `Make Resume` or `Applied?`, write a legacy tracker, auto-apply, or send.
