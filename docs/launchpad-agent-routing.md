# Launchpad agent routing contract

Status: Phase 4 delegation policy.
Governs who does what across Claude Code, the Codex/gpt-5.6 worker, and Onkar.

## Purpose and scope

This contract governs delegation only.
It states which of Claude Code, a Codex worker, or Onkar performs a given piece of Launchpad work, and in what order handoffs happen between them.

It does not grant any new authority to any agent.
It does not relax, override, or reinterpret any rule in `CLAUDE.md` or `AGENTS.md`.
Where this document is silent, the non-negotiables in `CLAUDE.md` control.

If a routing decision below ever appears to conflict with a non-negotiable, the non-negotiable wins and the routing decision is wrong and should be fixed, not followed.

This contract does not:

- Authorize Codex or Claude to submit an application, send a message, or take any live action Onkar has not approved.
- Change what `Make Resume` and `Applied?` mean or who checks them.
- Introduce a new Notion write path outside the existing scoped gateway.
- Reopen v3/v4 as runtime targets.

## Ownership matrix

| Capability | Claude Code | Codex | Onkar |
|---|---|---|---|
| Policy and evidence gates (targeting rubric, scoring policy, resume evidence rules) | Applies policy as written; cannot alter it | No policy authority | Owns; sole authority to change `master_prompt.md`, the gates, and this contract |
| Morning orchestration (`/morning`, `crawler/cli.mjs daily`, `crawler/daily-runner.mjs`) | Owns; runs the daily workflow and reviews its output | Bounded source worker only, and only for a task Claude explicitly assigns for that run | Approves any live write the run would trigger |
| Job connectors: Indeed, Dice, ZipRecruiter, Jobs and Careers | Runs directly; no default Codex role | No default role on these connectors | Reviews the resulting shortlist |
| Job connectors: Apify (`job-pull/apify-pull.mjs`) | Decides when the explicit, default-off rescue is invoked and verifies its output | May execute a bounded Apify batch, and only when Claude assigns that specific batch for that run | Aware via handoff; no live write proceeds without approval |
| Contact research | Does prospecting, drafting, and policy review of candidate contacts | Extracts public evidence only; no drafting judgment, no target selection | Selects the target contact from the candidates Claude presents |
| GitHub / demo / proof evidence | Assembles and verifies links and supporting evidence for review | May gather raw evidence only if assigned that narrow task | Makes the final claim review and the public-sharing decision |
| Code changes and tests | Plans, reviews, and integrates | Primary implementation worker for well-specified tasks | Approves push/PR before it lands |
| Notion v5 writes | Only path is the scoped gateway; Claude never writes any other way | Must never write Notion directly and must never bypass the gateway | Authorizes live operation (credential and gateway enablement) |
| Application submission and message sending | Never, under any circumstance | Never, under any circumstance | Sole owner; always a manual, deliberate action |

Footnote on consolidation:

The source list gave "Morning orchestration" and "Job connectors" as separate rows that both described Codex's relationship to Apify, but inconsistently.
One framed Codex generically as a "bounded source worker" inside morning orchestration.
The other said "Codex runs Apify batches only when assigned" specifically for connectors.

These are resolved here as one rule expressed at two altitudes, not as two competing rules.
Claude owns the orchestration and decides if or when Apify rescue runs at all; that is a run-level decision.
Within that run, Codex may execute one assigned Apify batch as a worker; that is a task-level decision.
The two rows above are kept distinct on purpose, orchestration separate from connector detail, rather than merged into one, because collapsing them would lose the run-level versus task-level distinction.

The source's plain "Job connectors" row also bundled five direct-run connectors together with Apify under one line, despite Apify having a different, default-off status.
This table splits that into two rows so the direct-run connectors are not implied to share Apify's rescue-only posture, and so Apify's stricter assignment rule for Codex is visible on its own line.

## Handoff contract

Workers return structured artifacts, not conversational claims.
A Codex research or connector task is done only when it returns the shape below.
No copy-pasted summary, chat message, or paraphrase becomes Launchpad truth on its own.

Claude is responsible for reading the returned artifact itself, not for trusting a worker's prose description of what it did.
An artifact that is missing, malformed, or inconsistent with its own evidence fields is not integrated; it is sent back or discarded.

```json
{
  "applicationId": "...",
  "companyId": "...",
  "person": "...",
  "currentRole": "...",
  "companyRelationshipUrl": "...",
  "contactUrl": "...",
  "email": null,
  "emailEvidenceUrl": null,
  "observedAt": "...",
  "confidence": "verified | partial | no-result",
  "hiringInvitation": null,
  "noResultReason": null
}
```

Field notes:

- `applicationId` / `companyId`: the Launchpad v5 identifiers the artifact correlates to.
  These should resolve to a real existing record.
  If the lead has no v5 record yet, the field stays empty rather than a fabricated ID.
- `person`, `currentRole`, `companyRelationshipUrl`, `contactUrl`: research output.
  Each is either a directly observed value or absent.
  No inferred or guessed value is written into these fields.
- `email`: null unless a worker directly observed a verified email address with supporting evidence.
  Never a pattern-generated or guessed address.
- `emailEvidenceUrl`: null whenever `email` is null.
  Otherwise the URL or source location where the email was observed.
- `observedAt`: an ISO 8601 timestamp of when the evidence was captured.
  Expected whenever `confidence` is not `no-result`.
- `confidence`: three allowed values.
  `verified` means the evidence was directly observed and supports every populated field.
  `partial` means some fields are observed and others are missing or unconfirmed.
  `no-result` means research was attempted and nothing usable was found.
- `hiringInvitation`: null unless a worker observed an explicit hiring or referral invitation as stated evidence.
  It is never a judgment call by Claude or Codex.
- `noResultReason`: null unless `confidence` is `no-result`.
  When set, it is a short, specific reason, for example "profile not found" or "no public contact listed".

## Operating rules

1. Exactly one connector owner per run.
   When Apify is in use for a given run, either Claude is running it directly or Codex is executing one assigned batch, never both for the same run.
2. Exactly one Notion writer.
   All v5 writes go through Claude's scoped gateway; Codex never holds a Notion credential or a write path of its own.
3. Every delegated task, to Codex or otherwise, defines its exact output, its method, and its stop condition before the task starts.
   A task without a defined stop condition is not ready to delegate.
4. Claude verifies a connector's or worker's claims against the returned artifact and its evidence fields before drafting outreach or mutating any v5 state.
   An unverified claim does not get used, no matter how plausible it reads.
5. Codex never marks outreach as sent, an application as submitted, or a referral as confirmed.
   Those states change only through Onkar's manual action, as recorded by `/sync` or `/outreach` per the existing v5 workflow.

## Enforcement and escalation

A violation is any artifact or state change that does not match this contract. Concrete examples:

- A Codex worker writing to Notion directly instead of returning an artifact for Claude's gateway.
- A connector run with two owners active on the same connector at once.
- An outreach record marked sent without Onkar's manual confirmation.
- An application marked submitted by any agent, under any label.
- A returned artifact that claims `confidence: "verified"` without an `observedAt` or without evidence for the fields it populates.

Claude is responsible for catching this at review time.
Before integrating a worker's output, and before any v5 write, Claude checks the artifact against the handoff shape and against the ownership matrix above.
If a returned artifact does not match the expected shape, or claims a state change that its evidence does not support, Claude rejects it and does not integrate it, rather than repairing it into something plausible.

This ties directly to the non-negotiables already in `CLAUDE.md`. No auto-apply and no autonomous sending remain absolute, regardless of which agent produced the draft or the evidence behind it. `Make Resume` and `Applied?` remain user-owned checkboxes; no routing decision in this contract lets Claude or Codex check them on Onkar's behalf. Live writes, when authorized, target only the declared v5 stores through the scoped gateway and the external transaction journal; a legacy v3/v4 fallback is never an acceptable substitute, even under time pressure. Where evidence is missing, incomplete, or unverifiable, the correct state is unknown or `Not Verified`, never a filled-in guess.

An escalation past this point, meaning a repeated violation, an ambiguous ownership case not covered by the matrix, or a worker that consistently returns malformed artifacts, goes to Onkar for a decision. No agent resolves an escalation by unilaterally expanding its own scope.
