---
name: make-applications
description: Process the user-controlled Make Resume queue from Applications v5, build role-specific resumes locally, and set only the derived v5 resume state after verification. Never checks the queue or submits an application.
disable-model-invocation: true
---

# Resume queue

Read `readMakeResumeQueue()` from `resume-v5/queue-reader.mjs`; it queries Applications v5 directly and refuses legacy targets. Process the returned rows with `processMakeResumeQueue()` from `resume-v5/resume-queue.mjs`.

For each checked row, set Building, run the existing local template-based resume build, verify the exact PDF plus source, matrix, and provenance sidecars, then set Ready, Failed, or Stale. Preserve the frozen template and master evidence source. `Make Resume` and `Applied?` are never changed. Compilation is local-only and `resumes/output/<date>/` contains PDFs only.

Report every selected row, artifact path, verification result, and failure. Never attach a stale or mismatched artifact, write a legacy tracker, auto-apply, or send outreach.
