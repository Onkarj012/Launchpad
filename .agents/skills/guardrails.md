# Launchpad guardrail vocabulary

Use these exact meanings in every Launchpad skill.

- **user-owned** — `Make Resume` and `Applied?` values belong to Onkar. Skills may read them but must never check, uncheck, or mutate them.
- **draft-only** — outreach output is local or v5 draft state. It is not a Gmail draft and is never sent by a skill.
- **v5-only** — explicitly authorized live writes target only declared Launchpad v5 stores through the scoped gateway. v3/v4 are historical read-only systems and are never fallbacks.
- **fail-closed** — unknown evidence, missing credentials, unresolved original-application URLs, and unverified contacts remain blank or `Not Verified`. Never invent dates, salary, contacts, links, or experience.
- **local-compile** — resume PDFs are built on this Mac. Sources and sidecars stay under `resumes/sources/<date>/`; `resumes/output/<date>/` contains PDFs only.
- **no auto-apply** — no skill submits an application, sends email/DM/referral, automates LinkedIn, or changes a user-owned checkbox.
