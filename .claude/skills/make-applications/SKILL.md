---
name: make-applications
description: Batch-tailor resumes for every Notion Applications row the user has Apply?-checked, compiling each locally and verifying it parses clean before marking it ready. Use when the user says "make applications", "build resumes for today", "make my resumes", "/make-applications", or runs /make-applications. Local-only — never fires in a headless/cloud session since LaTeX compilation needs the Mac toolchain.
---

# Make Applications

Turn today's `Apply?`-checked rows into a ready-to-send apply queue: one tailored, compiled, parse-verified resume per row.

## Source of truth
`master_prompt.md` § 4 (tailoring rules) and the `resume-latex` skill (compile + verify mechanics) are authoritative — this skill orchestrates, it does not redefine them.

## Steps

1. **Query** the Applications **Resume Queue** view (`Apply? = true`), then filter client-side to `Resume Status = Not Started`. If empty, report "nothing queued" and stop.
   *Done when:* you have the full list of rows to process, each with its JD Link/Text and Company/Role.

2. **For each row**, invoke the `resume-latex` skill's Steps 1-6 (project picker → assemble `.tex` → compile → page-count + fill verify → parse-verify guard) using that row's JD as input.
   *Done when:* every row has produced either a compiled, parse-verified PDF, or a logged failure with reason (don't silently skip a row that failed to compile).

3. **Save** each output per the `resume-latex` PDF-only contract: `.tex` source in `resumes/sources/`, final PDF-only in `resumes/output/Onkar_Jadhav_<Company>_<Role>.pdf`, build artifacts deleted. After the batch, `resumes/output/` contains only `.pdf` files.

4. **Update** each processed row: `Resume Status = Tailored`, `Resume PDF` = the output PDF path/link.

5. **Report** a checklist to the user: Company, Role, apply link (JD Link), resume path — the day's apply queue. List any rows that failed Step 2 separately with the reason, so nothing silently drops.

## Rules
- Local-only. If invoked in an environment without LaTeX (`pdflatex`) on `PATH`, stop and tell the user to run it locally instead of guessing or skipping the compile step.
- ATS-clean template (`resumes/master/Master_Resume_ATS.tex`) only — every output here is a portal apply.
- Never fabricate experience, metrics, or dates. Only reframe/reorder/select from the master resume.
- Parse-verify (email + phone + ≥N skill keywords survive `pdftotext`) is a hard gate before a row counts as done — a compiled-but-unparseable PDF is a failure, same as a missing one.
