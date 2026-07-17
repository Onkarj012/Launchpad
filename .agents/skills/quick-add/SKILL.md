---
name: quick-add
description: Log a single job the user found themselves into the Notion Applications database — score it, position it, and fill only verified fields. Use when the user says "quick add", "/quick-add", "log this job", "add this role", "throw this in the tracker", or pastes one JD they want tracked without running a full pull. Discovery/logging only — never applies, never checks Apply?.
---

# Quick Add

Log **one** job into the Notion Applications database, fast. For a role the user found themselves and just wants tracked. Not a sourcing sweep — for that use `daily-job-pull`.

## Source of truth
Read `master_prompt.md` (project root) for Targeting, Hard gates, and the Scoring Rubric (§ 2-3). Score the same way `daily-job-pull` does — this skill is the single-row version of the same engine.

## Input
A pasted JD, or the fields:
```
Role: [title]
Company: [company]
Location: [location]
JD link: [url]
```

## Steps
1. **Gate** — run `master_prompt.md` § 2 Hard gates (location-auth, seniority, paid). If it fails a gate, tell the user which and ask whether to log anyway (don't silently drop a user-supplied role).
2. **Dedup** — compute the `Dedup Key` (company|title|location, normalized) and check the Applications DB. If it already exists, say so and stop rather than creating a duplicate.
3. **Score** — run the § 3 rubric: integer 0-100, one-line rationale, single strongest hook (→ Positioning), `Auto-Suggest` boolean.
4. **Write one row** to Applications: Role, Company (relation — create Companies row if new), Location, Source, Source Rarity, Job ID, Dedup Key, JD Link, JD Text, Posted Date (or "Not Verified"), Date Pulled = today, Match Score, Response Likelihood, Freshness, Company Stage, Auth-Friendly?, Auto-Suggest, Positioning, Status = Researching, Apply? = **unchecked**, Resume Status = Not Started.
5. **Confirm** — echo back the row: Role @ Company, score, one-line rationale, apply link.

## Rules
- **Never invent** anything missing — leave the field blank or "Not Verified".
- `Apply?` stays **unchecked**. This skill discovers and logs only — no apply, no email.
- One row only. Multiple roles → tell the user to run `daily-job-pull` instead.
