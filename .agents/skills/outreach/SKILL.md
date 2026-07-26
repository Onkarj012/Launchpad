---
name: outreach
description: Prepare free-first v5 outreach drafts for user-selected applications. Never sends, auto-selects a contact, changes Applied?, or writes a legacy target.
disable-model-invocation: true
---

# Outreach

Use `prepareOutreach()` and `persistOutreach()` from `outreach-v5/workflow.mjs` for selected Applications v5 rows. Research in `FREE_FIRST_SOURCE_ORDER` from `outreach-v5/research.mjs`; preserve public evidence, identity, current role, confidence, and channel. Missing email stays missing. Paid or credit providers are optional and only used on explicit user choice.

Deep drafts are capped at six. An attachment requires the exact role's `Resume State = Ready` artifact and a matching PDF. Store compact Outreach v5 properties plus the full draft body. A duplicate key is application × person × channel.

Only explicit user confirmation may call `confirmManualSend()` or `recordOutreachOutcome()`. Those functions record confirmation and cadence state; they do not send anything. Follow-ups use Day 0/3/10/17 and stop on reply, rejection, opt-out, or closure. Never auto-apply, auto-send, invent a contact, or fall back to a legacy tracker.
