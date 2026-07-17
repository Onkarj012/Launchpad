---
name: followups
description: Surface every job application and cold-email thread that is due for a follow-up today, and draft the follow-up messages on request. Reads the Notion Applications tracker (and Outreach DB) against a fixed cadence — never sends anything. Use when the user says "follow-ups?", "what's due", "who do I chase", "any follow-ups", "/followups", or asks what needs a nudge today.
---

# Follow-ups

Turn the tracker into today's chase list: which applications and cold emails are due a follow-up, and drafts ready on request. **Never sends. Never auto-emails. Drafting is on explicit ask only.**

## Source of truth
- **Cadence** mirrors `career-ops/followup-cadence.mjs` (the harvested logic — do not re-invent the day counts):
  - **Applied, no reply:** first follow-up at **day 7** after Applied Date; second at **+7** (day 14); **max 2** follow-ups, then stop.
  - **Responded / in conversation:** nudge at **+1 day** then **+3 days** if the ball is in their court.
  - **Post-interview thank-you:** **+1 day** after the interview.
- `master_prompt.md` § 5 (Outreach / follow-up) governs cold-email tone and the ≥4-days-silent rule.

## Steps

1. **Read due items.** This workspace's Notion plan blocks programmatic queries (`notion-query-data-sources` / `notion-query-database-view` both require Business plan) — a filtered pull of "Status in (Applied, Followed Up) AND Next Follow-up ≤ today" cannot be run directly. Ask the user to open the **Follow-up Due** view in Notion (it already carries this exact filter, applied natively when a human opens it) and read off what's listed, or paste the rows. Do the same for Outreach threads ≥4 days silent. Never report "nothing due" from a `notion-search` guess — only from the user-confirmed view, or say plainly you can't verify it this run.
   *Done when:* you have the full due list (user-confirmed) with each item's Status, Applied Date, Follow-up Count, and last-contact date.

2. **Classify each** by the cadence above → what kind of follow-up is due (1st chase / 2nd chase / conversation nudge / thank-you) and whether it has already hit the max-2 cap (if so, mark "stop — no more follow-ups", don't draft).
   *Done when:* every due item is tagged with its follow-up type or a stop reason.

3. **Present** the chase list in chat: Company · Role · type of follow-up due · days since last contact · the row/thread link. Group by urgency (overdue first).

4. **Draft on request only.** If the user says "draft them" (or names specific ones), write each follow-up from the § 5 template — short, specific, references the role and one concrete hook. Output as text/Gmail drafts for the user to send manually. **Never send. Never mark as sent automatically.**

5. **Stamp on user confirmation only.** After the user confirms they sent a follow-up, update that row: `Follow-up Count` +1, `Last Activity` = today, `Next Follow-up` = today + next cadence gap (or clear it once max-2 is hit), and Status → Followed Up. In the v4 Activity DB, add a `Follow-up` activity row. Never stamp a follow-up the user didn't confirm sending.

## Rules
- No auto-send, ever. This skill drafts and tracks; the user sends.
- Respect the max-2 cap on cold applications — after two silent chases, stop and mark the row Dropped only if the user agrees.
- Never fabricate a reply, an interview date, or a contact. Unknown → leave blank.
- Cadence day-counts live in `career-ops/followup-cadence.mjs`; if the user wants to change them, change them there and reflect here — don't hardcode a different number.
