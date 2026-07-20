---
name: quick-add
description: One verified job lead.
disable-model-invocation: true
---

# Quick Add

Log one user-supplied role as a **lead**. This workflow does not apply, check `Apply?`, or treat an aggregator as an original application page.

Read `master_prompt.md` for hard gates and matching. Read `config/conversion-plan.json` for conversion score and composition labels. Read `references/lead-fields.md` only when the role passes the initial gate.

## Steps

1. **Capture** — collect company, role, source URL, location/work mode, JD, and visible posting date. State missing fields as `Not Verified`.
   *Done when:* one candidate record is sufficiently identified to deduplicate.

2. **Gate and deduplicate** — apply the master hard gates and check the tracker evidence supplied by the user. If ineligible, explain why and ask whether they want a research-only record; if duplicate, stop.
   *Done when:* the lead has one explicit eligibility/dedup result.

3. **Score** — produce Match Score per master policy and Conversion Score per `conversion-plan.json`, with evidence for each conversion dimension. `75+` means ready for manual review, never automatic application.
   *Done when:* both scores, source category, and one truthful hook/gap are recorded.

4. **Log** — propose the new tracker record and create a local lead/application record only from verified values. Mark application readiness `unverified` until `/application-readiness` succeeds.
   *Done when:* the user receives a complete field list with original ATS status visibly unresolved or verified.

5. **Confirm** — show role, company, scores, link, and the next safe step: `/application-readiness` before tailoring or applying.
   *Done when:* no discovery record is represented as an application.
