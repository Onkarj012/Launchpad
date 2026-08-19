# Launchpad readiness — report and plan

Canonical source for the Waymark artifact `launchpad-readiness-plan.waymark.html`.

## State

- Branch `ticket/w1-1-workday-freshness`, HEAD `c1d67e3`, clean, pushed to origin.
- Readiness suite static inventory: 72 tracked test files, 658 top-level `test(...)` declarations. Not executed for this report.
- Local validators pass: `launchpad-v5.mjs validate`, `crawler/safety-contract.mjs`.
- No credentialed Notion smoke, no canary streak, no promotion.
- Goal driving the ordering: a better AI/ML or full-stack role near home in Pune, applications going out soon.

## Findings — code

1. `career-ops/` is gitignored but imported by tracked source and tests. A clean clone cannot run.
2. Workday LIST `postedOn` overrides a usable DETAIL `startDate`, holding relative-labelled roles in `VerifyQueue`.
3. Durable opportunity identity is company + title + location, so distinct requisitions collapse.
4. The shared resolver drops configured `maxHosts` and `maxRequests`.
5. Scoring is not bound by the run deadline: the parent `AbortSignal` never reaches the scorer, and the scorer floor can exceed remaining time.
6. Remote mode accepts context-free "global" or "worldwide" as India eligibility and accepts every timezone.
7. Profile `sourcePlan` and `locationPreset` never reach board planning, so Pune priority is decorative.
8. The resume queue takes an injected `build` callback; no production builder is wired.
9. Canary report and JSON sidecar have validation but no generator.
10. Notifications cover fatal and fresh-match only, without run identity or delivery receipts.
11. Apify retains seen URLs only: no dataset offsets, no hard item cap, no actual-cost reconciliation.
12. Gmail draft creation, Gmail reply observation, and LinkedIn conversation import are absent from HEAD.

## Findings — skills

15 skills under `.agents/skills`, 11 mirrored into `.claude/skills` matching the declared v5 command surface.

1. The same prohibition litany is restated in every skill: duplication plus negation.
2. Two incompatible shapes. Four skills use numbered steps with `*Done when:*`; eleven are prose blobs, including real sequences such as `resume-latex` and `make-applications`. Missing completion criteria invite premature completion.
3. Descriptions still carry model-facing trigger text although every skill is user-invoked.
4. No router skill, so the operator is the index for 15 hand-invoked skills.
5. `sync` is 57 lines with two distinct branches that belong behind pointers.
6. `daily-job-pull/references/sourcing.md` is 175 lines and still carries stale fresher identity language.
7. Four skills are unmirrored and therefore not invocable in Claude. Deliberate or not, the choice is unrecorded.

## Phases

- **P0 — Unblock applying.** Commit the resume-contract work, wire the real builder into the resume queue, produce one verified one-page PDF, clear stale status documents. Gate: one real role reaches a verified PDF and is applied to manually.
- **P1 — Discovery correctness.** Findings 2 through 7. Gate: one shadow run per profile with writes disabled, manual review agreeing with every selected and rejected role.
- **P2 — Skills.** Stepped form and completion criteria for the sequence skills, leading words replacing the litany, router skill, one-line descriptions, `sync` disclosure, mirror decision. Gate: validators clean and mirror consistent.
- **P3 — Reproducible release.** Track `career-ops`, add manifest and lockfile if missing, derive the fingerprint from the tracked dependency graph, gate tests on discovered inventory. Gate: a fresh clone of the pushed revision passes every local check.
- **P4 — Live proof.** Credentialed Notion v5 smoke with reciprocal relations, journal recovery, idempotent repeat and injected abort; report and sidecar generator; notification coverage. Gate: relation-bearing smoke with zero pending journal transactions.
- **P5 — Outreach loop.** Gmail draft-only adapter, read-only reply observation, immutable initial-send timestamp and stage order. Gate: one real draft sent manually, cadence started, a real reply stopping follow-ups.
- **P6 — Promotion.** Immutable release checkout, launchd repoint, rollback revision, recovery drills, seven valid canary days per profile. Gate: the evaluator passes every gate for that profile.

## Constraints

- No auto-apply, autonomous sending, or agent mutation of `Make Resume` and `Applied?`.
- Applications can begin at the end of P0. Later phases reduce manual effort; none of them block applying.
- Per-profile promotion; whole-system readiness is withheld until every intended profile passes.

## Open questions

1. Pune locality and maximum commute.
2. Degree conferral status and final CGPA.
3. Notice period from the employment document.
4. Minimum acceptable compensation.
