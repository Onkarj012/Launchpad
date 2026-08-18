---
name: application-agent
description: Prepare one evidence-backed v5 application package for a named role.
disable-model-invocation: true
---

# Single-role application

Vocabulary: `../guardrails.md`. Require company, role, current JD, and a source link.

## Procedure

1. Resolve the original active employer/ATS destination. Stop at Needs Verification if it is still a lead.
2. Use the v5 Applications row and its Companies relation only.
3. Tailor and verify the resume through the `resume-latex` sequence and `resume-v5` gates.
4. Outreach is opt-in: `prepareOutreach()` / `persistOutreach()` from `outreach-v5/workflow.mjs` create a draft record only.
5. `Applied?` changes only after the user confirms and `/sync` observes it.

## Done when

- Original application status is `Resolved` or an explicit block reason is reported.
- Resume status is `Ready` or the blocking gate is reported with evidence.
- Optional outreach has exactly one draft-only result and a send count of zero.
- The count of mutations to `Make Resume` and `Applied?` is zero.

user-owned. draft-only. v5-only. no auto-apply.
