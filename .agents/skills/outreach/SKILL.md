---
name: outreach
description: Prepare free-first v5 outreach drafts for user-selected applications. Never sends, auto-selects a contact, changes Applied?, or writes a legacy target.
disable-model-invocation: true
---

# Outreach

Use `prepareOutreach()` and `persistOutreach()` from `outreach-v5/workflow.mjs` for selected Applications v5 rows. Research in `FREE_FIRST_SOURCE_ORDER` from `outreach-v5/research.mjs`; preserve public evidence, identity, current role, confidence, and channel. Missing email stays missing. Paid or credit providers are optional and only used on explicit user choice.

For shortlisted or watched employers, use `prepareEmployerOutreach()` and `persistEmployerOutreachDrafts()` from the same workflow. Save these as local JSON drafts. The email draft is available only when the selected contact and email evidence came from `companyTeamPages`; the LinkedIn draft requires a public profile URL. This path does not create Gmail drafts or send messages.

Deep drafts are capped at six. An attachment requires the exact role's `Resume State = Ready` artifact and a matching PDF. Store compact Outreach v5 properties plus the full draft body. A duplicate key is application × person × channel.

Only explicit user confirmation may call `confirmManualSend()` or `recordOutreachOutcome()`. Gmail integration is draft-only through injected lookup/create transport functions: it has no send capability, and the real send remains a manual user action. `observeGmailReplies()` may list/read messages only, binds evidence to the exact Gmail thread plus Outreach ID and duplicate key, and `recordObservedReply()` can stop that exact v5 cadence on a genuine reply. Follow-ups use Day 0/3/10/17 and enforce Initial -> Follow-up 1 -> Follow-up 2 order. Never auto-apply, auto-send, take LinkedIn action, invent a contact, or fall back to a legacy tracker.
