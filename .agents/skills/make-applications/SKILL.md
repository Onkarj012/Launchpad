---
name: make-applications
description: Batch-build every user-checked Make Resume v5 row into a local verified PDF.
disable-model-invocation: true
---

# Resume queue

Vocabulary: `../guardrails.md`. Read `readMakeResumeQueue()` from `resume-v5/queue-reader.mjs`. Process with `processMakeResumeQueue()` from `resume-v5/resume-queue.mjs`.

## Steps

1. Query Applications v5 with the fixed Make Resume filter. Refuse legacy targets.
2. For each checked row: set `resumeState` to Building only.
3. Tailor that row with the `resume-latex` sequence. Do not invent slot content.
4. Call `createLocalResumeBuilder()` then `createLocalPdfVerifier()` from `resume-v5/local-builder.mjs`.
5. Set Ready, Failed, or Stale from `verifyResumeArtifact()`. Never change `Make Resume` or `Applied?`.
6. Report every selected row, artifact path, and verification result.

## Done when

- Every checked row has a terminal `resumeState` of Ready, Failed, or Stale
- Ready rows have PDF + source + matrix + provenance and `verifyFile` `PASS`
- No user-owned checkbox changed
- Failures are listed rather than skipped

user-owned. local-compile. v5-only. no auto-apply.
