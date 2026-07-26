---
name: conversion-ops
description: Manual funnel scorecards and checkpoints.
disable-model-invocation: true
---

# Conversion Operations

Operate the local funnel ledger: selection quality, human-contact coverage, referral attempts, outcomes, weekly reports, and checkpoints. It does not apply, send, scrape profiles, or mutate Notion.

`config/conversion-plan.json` is the policy source. Read the reference matching the requested operation.

## Steps

1. **Select the record set** — collect dated copies of the local TSV templates and user-confirmed tracker rows. If evidence is incomplete, label the resulting report partial.
   *Done when:* every input file/date range and every unavailable field is named.

2. **Operate one branch** — score a lead, audit daily composition, prepare contacts/referrals, record an outcome, generate a weekly report, or run a checkpoint as requested.
   *Done when:* the branch's reference completion gate is met without inventing a tracker event.

3. **Return actions** — list the next manual actions in priority order, including any required user confirmation. Keep discovery, application submission, and sending outside this skill.
   *Done when:* every recommendation points to evidence or an explicit unknown.

## References

- For Conversion Score and composition, read `references/selection.md`.
- For contacts and referrals, read `references/human-pipeline.md`.
- For outcome handling, weekly report, and checkpoints, read `references/measurement.md`.
