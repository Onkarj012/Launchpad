---
name: daily-job-pull
description: Run explicit Launchpad v5 discovery. Normal is the default; Startup and Remote are selected through morning. Normalize, gate, score, deduplicate, select, report telemetry, and plan v5-only writes. Never apply, send, tick user checkboxes, or invoke browser rescue.
disable-model-invocation: true
---

# Daily discovery

Use the v5 mode runners and their injected source adapters. Normal uses India-first ATS, Indian portals, optional Indeed, native feeds, and startup/company lanes. Startup emphasizes startup boards, VC/YC signals, and funding evidence. Remote emphasizes direct remote ATS and native remote feeds. Apify is absent from the daily path and can run only as an explicit named rescue profile.

The shared gates are immutable: original employer/ATS resolution, active liveness, permitted geography, paid employment, experience cap, no fees/bonds, freshness evidence, and deterministic deduplication. Internships use the separate lane and stipend tiers: INR 30,000+ Preferred, INR 25,000–29,999 Lower-Stipend, lower rejected, unknown verification-only.

Selection is minimum 10, preferred 12, maximum 20. Use the documented freshness waterfall and label every relaxation. Unresolved leads remain in Needs Verification and never count toward the minimum. A source failure is visible and nonfatal; a core integrity failure is fatal before planning.

The runner must leave `Make Resume = false` and `Applied? = false`. Use the scoped v5 gateway only for an explicitly authorized write phase, with reserve → write → verify → commit. Never write to a legacy target or use a legacy fallback.
