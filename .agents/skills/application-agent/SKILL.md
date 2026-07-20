---
name: application-agent
description: Single-role application package.
disable-model-invocation: true
---

# Application Agent

Run one role through a **ready** application package. Nothing is submitted, sent, or written to Notion without user confirmation.

Read `master_prompt.md` for targeting, evidence, resume rules, and cold-email wording. Read `config/conversion-plan.json` for conversion operations. Use the conditional references below only when their branch applies.

## Steps

1. **Identify** — collect company, role, source URL, JD, and any existing tracker record. If the user has not named one role, ask them to choose one; for a batch, hand off to `/make-applications`.
   *Done when:* one `application_key` and one current JD are available, or the missing input is explicitly listed.

2. **Verify** — run `/application-readiness` before any tailoring or draft. A discovery/aggregator link is a lead, never application-ready on its own.
   *Done when:* the role is marked ready with a verified original ATS URL, or the exact verification gap is recorded and the workflow stops.

3. **Position** — score fit using `master_prompt.md`; calculate the separate Conversion Score from `config/conversion-plan.json`; state the strongest truthful project hook and gaps. Never convert a score into an application decision.
   *Done when:* both scores, score evidence, source category, and a manual-review recommendation are recorded.

4. **Tailor** — invoke `/resume-latex` for this JD and retain its requirement matrix and verified PDF. Select a resume variant only as a label for the truthful tailored output; do not create unsupported claims.
   *Done when:* the resume skill has passed all of its gates or its failure is surfaced.

5. **Prepare** — create the application answer record from `references/submitted-answers.md`. Draft a human-contact sequence only when the user explicitly requests it; use `references/contact-sequence.md` and never send.
   *Done when:* every known portal answer is sourced, every unknown is labeled `Not Verified`, and any requested draft passes the duplicate guard.

6. **Hand off** — present the original ATS link, resume path, answer record, conversion rationale, and next manual action. On user confirmation that the application was submitted, append the confirmed facts to the local submission ledger; propose, never mutate, Notion.
   *Done when:* the user has a complete manual application packet and no unconfirmed action is recorded as complete.

## References

- For exact answer capture and employment-status wording, read `references/submitted-answers.md`.
- For one-human sequencing and duplicate prevention, read `references/contact-sequence.md`.
- For verification, use `/application-readiness`.
