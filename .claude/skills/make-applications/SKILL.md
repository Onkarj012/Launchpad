---
name: make-applications
description: Batch-tailor resumes for every Notion Applications row the user has Apply?-checked, compiling each locally and verifying it parses clean before marking it ready. Use when the user says "make applications", "build resumes for today", "make my resumes", "/make-applications", or runs /make-applications. Local-only — never fires in a headless/cloud session since LaTeX compilation needs the Mac toolchain.
---

# Make Applications

Turn today's `Apply?`-checked rows into a ready-to-send apply queue: one tailored, compiled, parse-verified resume per row.

## Source of truth
`master_prompt.md` § 4 (tailoring rules) and the `resume-latex` skill (compile + verify mechanics) are authoritative — this skill orchestrates, it does not redefine them.

## Steps

1. **Get the queue.** This workspace's Notion plan blocks programmatic queries (`notion-query-data-sources` / `notion-query-database-view` both require Business plan) — do not attempt to auto-query the `Apply?` checkbox. Ask the user directly which rows from today's (or a named) pull they've checked `Apply?` on — they pick from the **To Apply** / **Today's Pull** view themselves and tell you the Company/Role list, or paste the rows. Pull each named row's JD Link/Text via `notion-search` or a direct page URL the user gives you.
   *Done when:* you have the full list of rows to process, each with its JD Link/Text and Company/Role, confirmed by the user — not guessed from an unreliable query.

2. **For each row**, invoke the `resume-latex` skill's Steps 1-9 (project picker → copy `resumes/templates/Onkar_Template.tex` into today's date directory → edit only inside its tailor slots → compile → `tests/resume/verify.mjs` gate → parse-verify guard) using that row's JD as input. Never author a `.tex` from scratch and never copy an old file from `resumes/sources/` — always start from the canonical template.
   *Done when:* every row has produced either a compiled, verifier-passed PDF, or a logged failure with reason (don't silently skip a row that failed to compile or failed the verifier).

3. **Save** each output per the `resume-latex` PDF-only contract, date-partitioned by today's run date: `.tex` source in `resumes/sources/<YYYY-MM-DD>/`, final PDF-only in `resumes/output/<YYYY-MM-DD>/Onkar_Jadhav_<Company>_<Role>.pdf`, build artifacts deleted. After the batch, `resumes/output/<YYYY-MM-DD>/` contains only `.pdf` files.

4. **Update** each processed row: `Resume Status = Ready` (on the current v3 DB use its existing "Tailored" option), `Resume PDF` = the output PDF path/link, `Last Activity` = today. Do **not** touch `Status`, `Applied Date`, or `Apply?` — this skill only prepares resumes; applying and the Applied stamp are manual user actions handled after the user actually submits.

5. **Report** a checklist to the user: Company, Role, apply link (JD Link), resume path — the day's apply queue. List any rows that failed Step 2 separately with the reason, so nothing silently drops. Close with the reminder: "After you apply on the portal, mark the row Applied (set Applied Date) so `/followups` can seed the follow-up cadence." Follow-up seeding is **not** automatic — it starts only once the user marks a row Applied.

## Rules
- Local-only. If invoked in an environment without LaTeX (`pdflatex`) on `PATH`, stop and tell the user to run it locally instead of guessing or skipping the compile step.
- Single canonical layout: `resumes/templates/Onkar_Template.tex`. Content evidence: `resumes/master/Master_Resume_ATS.tex`. Every output here is a portal apply.
- Never fabricate experience, metrics, or dates. Only reframe/reorder/select from the master resume, edited only inside the template's tailor slots.
- `tests/resume/verify.mjs <source.tex> <output.pdf>` passing (template conformance, 1 page, ≥93% page fill, parse-verify: email + phone + ≥N skill keywords survive `pdftotext`) is a hard gate before a row counts as done — a compiled-but-failing PDF is a failure, same as a missing one.
