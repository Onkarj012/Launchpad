---
name: linkedin-leads
description: Explicit manual LinkedIn hiring-post rescue. Build the bounded allowlisted query plan, inspect an already-authenticated browser session read-only, and pass captured posts through the v5 classifier. Never auto-run from morning, log to Notion, apply, connect, follow, react, comment, message, or send outreach.
disable-model-invocation: true
---

# LinkedIn rescue

This is a rescue path for a materially short verified pool. It is never part of `/morning` execution. Morning may suggest `/linkedin-leads`; it must not invoke it.

## Local interface

- Query plan: `buildLinkedInRescueQueryPlan()` from `job-pull/linkedin-rescue-query.mjs`.
- Capture processing: `runLinkedInRescue({ explicitInvocation: true, now, capturedPosts })` from `job-pull/linkedin-rescue-mode.mjs`.
- Captured fixtures and deterministic policy tests live under `tests/fixtures/linkedin-rescue/` and `tests/job-pull/linkedin-rescue.test.mjs`.

## Procedure

1. Build the default allowlisted plan from `master_prompt.md` target titles. Keep the plan within 6 queries, 20 posts per query, 60 total posts, and a 24–336 hour cutoff.
2. Use the user's existing authenticated browser session only if the user explicitly asks for the manual rescue. Inspect posts read-only. Do not automate login or create credentials.
3. Capture exact post URL, author identity and relationship, timestamp evidence, raw hiring context, company/title/location, job or form links, and any self-declared contact invitation. Missing values stay null.
4. Run `runLinkedInRescue` with `explicitInvocation: true`. It applies the same original-application, liveness, freshness, eligibility, deduplication, and scoring gates.
5. Report `applicationLeads`, `associatedPeople`, and every `reports` item. A post may produce both outputs. `Ready` requires a resolved active original application; otherwise keep it in `Needs Verification`.
6. Hand off a Ready lead for explicit human review and a person record to `/outreach` only for drafting. This skill never calls either workflow automatically.

## Safety

The deterministic module declares `network: false`, `browserAutomation: false`, `notionMutation: false`, and `outreachSend: false`. A real browser smoke is manual and read-only only. Never apply, submit a form, connect, follow, react, comment, DM, message, or send.
