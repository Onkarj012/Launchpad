---
name: make-applications
description: Batch-build every user-checked Make Resume v5 row into a local verified PDF.
disable-model-invocation: true
---

# Resume queue

Vocabulary: `../guardrails.md`. Read `readMakeResumeQueue()` from `resume-v5/queue-reader.mjs`. Process with `processMakeResumeQueue()` from `resume-v5/resume-queue.mjs`.

## Procedure

1. Query Applications v5 with the fixed Make Resume filter. Refuse legacy targets.
2. For each checked row: set `resumeState` to Building only.
3. Tailor that row with the `resume-latex` sequence. Do not invent slot content.
4. Call `createLocalResumeBuilder()` then `createLocalPdfVerifier()` from `resume-v5/local-builder.mjs`.
5. Set Ready, Failed, or Stale from `verifyResumeArtifact()`. Never change `Make Resume` or `Applied?`.
6. Report every selected row, artifact path, and verification result.

## Done when

- Every selected row has exactly one terminal `resumeState`: `Ready`, `Failed`, or `Stale`.
- The count of terminal rows equals the count of selected rows; no selected row is skipped.
- Each `Ready` row has PDF, source, matrix, and provenance artifacts, and `verifyFile` returns `PASS`.
- The count of mutations to `Make Resume` and `Applied?` is zero.
- Every failed row is listed with its reason and artifact state.

user-owned. local-compile. v5-only. no auto-apply.
