---
name: followups
description: Surface and draft the v5 Follow-up Due queue using Outreach and Activity cadence. Never send, never invent a queue, and never claim an empty queue without current v5 evidence.
disable-model-invocation: true
---

# Follow-ups

Read current Applications v5, Outreach v5, and Activity v5 rows through the scoped gateway. Use `dueCadenceAction()` and `deriveOutreachState()` from `outreach-v5/cadence.mjs`. Cold outreach cadence is Day 0, Day 3, Day 10, Day 17, with no more than two follow-ups. Stop on reply, rejection, opt-out, withdrawal, closure, or offer.

Present overdue items first with application, person, channel, last confirmed event, due action, and stop reason. Draft only on explicit request. A draft is not a send and does not stamp a sent date. If v5 queue evidence is unavailable, say so and request the user's current Follow-up Due view or pasted rows; do not infer an empty queue.

No automatic email, LinkedIn message, DM, referral, checkbox change, legacy write, or legacy fallback is allowed.
