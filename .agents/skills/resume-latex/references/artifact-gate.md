# Artifact gate

Run this after the content and JD gates. The exact commands are intentionally here so the main skill stays focused on the tailoring sequence.

1. Compile into `resumes/sources/build/` with `pdflatex -interaction=nonstopmode -halt-on-error -output-directory=resumes/sources/build <source.tex>`.
2. Copy the resulting PDF to the matching dated `resumes/output/` path.
3. Run `node tests/resume/verify.mjs <source.tex> <output.pdf>`. Resolve every `FAIL` and unexplained `WARN`.
4. Render with `pdftoppm` and inspect spacing, clipping, collisions, detached text, and glyphs.
5. Inspect `pdftotext -layout` output for linear section order, contact fields, title/organization/date/location association, and JD wording.
6. Review the LaTeX log; remove build artifacts after the verified PDF is promoted.

The output directory contains PDFs only. Matrix and provenance sidecars remain beside the source.
