---
name: application-agent
description: Prepare one evidence-backed v5 application package for a named role.
disable-model-invocation: true
---

# Single-role application

Vocabulary: `../guardrails.md`. Require company, role, current JD, and a source link.

## Steps

1. Resolve the original active employer/ATS destination. Stop at Needs Verification if it is still a lead.
2. Use the v5 Applications row and its Companies relation only.
3. Tailor and verify the resume through the `resume-latex` sequence and `resume-v5` gates.
4. Outreach is opt-in: `prepareOutreach()` / `persistOutreach()` from `outreach-v5/workflow.mjs` create a draft record only.
5. `Applied?` changes only after the user confirms and `/sync` observes it.

## Done when

- Original application is resolved or explicitly blocked
- Resume is Ready (or the block is reported)
- Optional outreach is draft-only, never sent
- No user-owned checkbox changed

user-owned. draft-only. v5-only. no auto-apply.
