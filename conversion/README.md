# Conversion Operations Ledger

This is the local, reviewable record for the human-conversion layer. It does not replace Notion, apply to jobs, send messages, or contain credentials.

Create dated copies of the templates in `conversion/templates/` when an action is confirmed. Keep a shared `application_key` across every ledger: normalized `company|role|original_ats_url`.

- `application-submission.tsv`: exact confirmed portal answers and application evidence.
- `contacts.tsv`: one-contact-at-a-time sequence and duplicate guard.
- `referrals.tsv`: referral prospects, requests, and outcomes.
- `outcomes.tsv`: replies, stages, rejections, and source/reporting inputs.

`config/conversion-plan.json` is the sole policy source for conversion score, composition, cadence, daily targets, and checkpoints. `master_prompt.md` remains authoritative for targeting, resume evidence, and cold-email wording. A future Notion schema change needs approval; see `SCHEMA_PROPOSAL.md`.
