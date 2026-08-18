---
name: quick-add
description: Normalize one user-found role into a planned v5 Applications row.
disable-model-invocation: true
---

# Quick add

Vocabulary: `../guardrails.md`. Fields: `references/lead-fields.md`.

## Steps

1. Take the user-supplied company, role, location, and source link.
2. Normalize through CandidateV1 and the current readiness gates.
3. Keep discovery URL and original-application evidence separate. A portal or LinkedIn link stays a lead until an active employer/ATS destination is resolved.
4. Show the planned Applications v5 operation. Do not write unless the user authorizes a live v5 gateway.
5. Leave `Make Resume` and `Applied?` false.

## Done when

- The candidate is valid CandidateV1 or the missing field is named
- Original-application status is Resolved, Direct ATS, or explicitly Needs Verification
- The planned v5 operation is shown
- No write happened without explicit authorization

fail-closed. v5-only. no auto-apply.
