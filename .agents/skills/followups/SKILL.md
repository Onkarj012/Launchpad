---
name: followups
description: Manual follow-up queue and drafts.
disable-model-invocation: true
---

# Follow-ups

Build the current manual chase list. Never send, never claim a contact occurred, and never report an empty queue without current user-supplied tracker or ledger evidence.

`config/conversion-plan.json` is the cadence source: applications at day 3 and day 7, cold outreach at day 4, and conversations at day 1 then day 3. Read `references/queue.md` when classifying the queue.

## Steps

1. **Collect** — ask for the Notion Follow-up Due view or pasted current rows, plus any dated local ledgers. Include application key, last confirmed contact, stage, and reply state.
   *Done when:* every candidate due item has evidence sufficient to calculate its age.

2. **Classify** — assign each item a single due action or stop reason from the configured cadence. Close silence at 14 days for reporting, not by deleting history.
   *Done when:* every supplied item has a due date, cadence stage, and no item exceeds its configured cap.

3. **Prioritize** — present overdue items first with company, role, days silent, channel, and latest manual evidence.
   *Done when:* the user can act on the entire queue without interpreting dates.

4. **Draft** — only on explicit request, draft concise role-specific notes with one real hook or proof link. Respect the contact duplicate guard.
   *Done when:* each requested draft has a recipient, purpose, and no invented information.

5. **Record** — only after the user confirms a send, update the dated local contact/outcome ledger copy and compute the next date. Propose a Notion update instead of mutating it.
   *Done when:* every confirmed send is auditable and every unsent draft remains unsent.
