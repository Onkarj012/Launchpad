---
name: application-agent
description: Prepare one evidence-backed Launchpad v5 application package for a named role. Research, verify original application, tailor a local resume, and optionally prepare outreach. Never auto-applies or sends.
disable-model-invocation: true
---

# Single-role application

Require company, role, current JD, and a source link. Resolve the original active employer/ATS destination before calling a role application-ready. Use the v5 Applications row and its Companies relation only; refuse legacy targets.

Run the existing resume-v5 queue/artifact gates locally from the frozen template and approved master evidence. Outreach is opt-in and uses `prepareOutreach()` / `persistOutreach()` from `outreach-v5/workflow.mjs`; it creates a draft record only. `Applied?` changes only after the user's own confirmation and `/sync` observes it. No auto-apply, auto-send, fabricated contact, or legacy fallback.
