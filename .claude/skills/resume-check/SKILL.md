---
name: resume-check
description: Audit a v5 role-specific resume against its JD and approved evidence. Read-only; never edits the frozen template or claims a PDF is Ready without verification.
disable-model-invocation: true
---

# Resume check

Review the supplied JD and `.tex`/PDF against `master_prompt.md`, `resumes/templates/Onkar_Template.tex`, and `resumes/master/Master_Resume_ATS.tex`. Report requirement coverage, provenance, grammar, repetition, ATS reading order, page count/fill, links, and any unsupported claim. The final PDF is the artifact of record; local compilation and `tests/resume/verify.mjs` remain required for Ready.

Do not modify frozen zones, invent evidence, write Notion state, apply, send, or use a legacy fallback.
