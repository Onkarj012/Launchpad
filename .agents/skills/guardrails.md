# Launchpad guardrail vocabulary

Use these words. Do not restate the paragraph in every skill.

- **user-owned** — `Make Resume` and `Applied?` are only changed by Onkar. Agents read them and never check or uncheck them.
- **draft-only** — outreach output is local/v5 draft state. It is not a Gmail draft and is never sent by an agent.
- **v5-only** — live writes, when explicitly authorized, target only declared Launchpad v5 stores through the scoped gateway. v3/v4 are historical and are not fallbacks.
- **fail-closed** — unknown evidence, missing credentials, unresolved original-application URLs, and unverified contacts stay blank or `Not Verified`. Never invent dates, salary, contacts, or experience.
- **local-compile** — resume PDFs are built on this Mac. `resumes/output/<date>/` contains PDFs only.
- **no auto-apply** — no skill submits an application, sends email/DM/referral, or automates LinkedIn.
