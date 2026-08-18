---
name: quick-add
description: Normalize one user-found role into a planned v5 Applications row.
disable-model-invocation: true
---

# Quick add

Vocabulary: `../guardrails.md`. Fields: `references/lead-fields.md`.

## Procedure

1. Take the user-supplied company, role, location, and source link.
2. Normalize through CandidateV1 and the current readiness gates.
3. Keep discovery URL and original-application evidence separate. A portal or LinkedIn link stays a lead until an active employer/ATS destination is resolved.
4. Show the planned Applications v5 operation. Do not write unless the user authorizes a live v5 gateway.
5. Leave `Make Resume` and `Applied?` false.

## Done when

- CandidateV1 validation passes, or every missing required field is named.
- Original-application status is exactly `Resolved`, `Direct ATS`, or `Needs Verification` with evidence.
- Exactly one planned v5 operation is shown for the normalized role.
- The unapproved write count is zero, and `Make Resume` and `Applied?` remain false.

fail-closed. v5-only. no auto-apply.
