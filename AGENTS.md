# Launchpad — agent contract

Onkar Jadhav's job-search system: discover roles → score against targeting → tailor a truthful one-page resume → track the lifecycle in Launchpad v5. This file is the single entry contract for any agent working in this repo. `CLAUDE.md` imports it.

## Where truth lives

Consult in this order. When sources conflict, the higher rung wins and the lower one is stale — say so rather than reconciling silently.

1. **`master_prompt.md`** — targeting, gates, scoring rubric, resume tailoring, outreach policy. Behavior changes go here.
2. **Executable contracts** — `config/launchpad-v5.commands.json` (commands + safety), `config/notion-v5.manifest.json` (v5 stores), `crawler/safety-contract.mjs` (runnable guardrail enforcer). Prose never overrides these; run them.
3. **`docs/STATUS.md`** — current execution position and open gates. Describes the dirty working tree, not a release. GitHub issues are the live issue-status authority.
4. **`docs/SYSTEM-REFERENCE.md`** — the local executable contract: entrypoints, pipeline stages, v5 boundary, verification map.
5. **Tests and the checked-out implementation** — what actually runs.

Resume has two frozen sources of truth: `resumes/templates/Onkar_Template.tex` is the layout (copy it, edit only `%== TAILOR-START/END ==` slots; the Capgemini block never tailors), and `resumes/master/Master_Resume_ATS.tex` is the approved evidence. Tailoring reframes, reorders, and selects from the master. It never adds.

## Guardrail vocabulary

These six words carry the whole safety boundary. Use them as written; skills reference the token instead of restating the rule. `node crawler/safety-contract.mjs` is the enforcer.

- **user-owned** — `Make Resume` and `Applied?` belong to Onkar. Read them; leave their values exactly as found.
- **draft-only** — outreach produces local or v5 draft state. Call it a draft. It is not a Gmail draft and no skill sends it.
- **v5-only** — authorized live writes target declared Launchpad v5 stores through the scoped gateway and the external transaction journal. v3/v4 are historical read-only systems; when v5 is unavailable, stop.
- **fail-closed** — unknown evidence stays blank or `Not Verified`. Dates, salary, contacts, links, companies, and experience come from evidence or not at all.
- **local-compile** — resume PDFs build on this Mac. Sources and sidecars live in `resumes/sources/<date>/`; `resumes/output/<date>/` holds PDFs only.
- **no auto-apply** — hard boundary, stated as a prohibition because it has no positive form: no skill submits an application, sends email/DM/referral, automates LinkedIn, creates or rotates a credential, or mutates a user-owned checkbox. Prepare the artifact and hand it to Onkar.

## Identity

Onkar Jadhav · Pune, India · Capgemini A4 Analyst (Navi Mumbai, since 10 Aug 2026, JFS training, no project work yet) · early-career for targeting. Wants AI/ML/full-stack with a Pune-wide onsite/hybrid commute or India-eligible remote.

Full snapshot — contacts, education, target titles, headline projects — is `master_prompt.md` §1. Read it once; never re-ask.

## Working here

- **Verify with:** `npm run validate` · `npm run safety` · `npm test` · `node crawler/cli.mjs readiness --run-tests` (all six groups) · `git diff --check`. `npm run rehearse` exercises the operator path on fixtures and injected fakes.
- **Scope of a local pass:** these prove local consistency only. They say nothing about source yield, installed scheduling, live Notion, authenticated browser, or production. Report what you ran and what you skipped.
- **`career-ops/` is ignored mutable runtime state** — user config and run cache, not tracked. The release code is the vendored snapshot at `vendor/career-ops/`. Import from `vendor/`; edit `career-ops/` only when Onkar names it.
- **Worktrees** live under `.claude/worktrees/` on `dco/*` branches. Work in one when asked; each carries its own copy of this file.
- **Changes you did not make are Onkar's.** The tree is usually dirty on purpose. Do not reset, restore, stash, clean, stage, or revert unrelated work.
- **Commit, push, PR, promote, install a schedule: explicit request only.**

## What we are building towards

The system is **code-complete and deliberately not promoted**. Every engineering path exists locally; almost nothing has touched the outside world. Work here moves items across that line — the north star is a daily loop Onkar can trust unattended, where discovery surfaces genuinely fresh India-eligible roles, resumes build from checked rows, outreach drafts wait for his confirmation, and nothing ever acts on his behalf.

Three rungs, and evidence is what promotes between them:

- **local-verified** — deterministic tests or validators pass in this checkout. Where the repo mostly sits (725/725 across 76 files as of 2026-08-21).
- **live-verified** — an authorized live integration ran and the evidence was retained. **No item currently holds this.**
- **promoted** — a clean reviewed revision cleared the release gates: seven distinct valid UTC canary dates on one version, matching manual inventory, complete report pairs, immutable content-addressed checkout, working rollback. Launchpad is not promoted.

The open gates and the LP-001–LP-019 ticket snapshot in `docs/STATUS.md` are the working backlog — read that section before proposing improvement work, since it names exactly which live proofs are missing and which tickets are genuinely open (LP-009, LP-010, LP-011) versus locally done and waiting on evidence.

When you improve this system: prefer closing an open gate over adding surface. Move a claim up a rung with retained evidence, or make a fail-closed path fail more honestly. A new feature that adds another unverified local path makes the gap wider, not smaller. And keep claims exact — `docs/STATUS.md` is scrupulous about the difference between "implemented" and "verified", and that discipline is the most valuable thing in the repo.

## Where to look

| Task | Go to |
|---|---|
| Which slash command fits a request | `.agents/skills/launchpad/SKILL.md` (router) |
| Targeting, scoring, resume, outreach policy | `master_prompt.md` |
| What is done, what is open, ticket status | `docs/STATUS.md` |
| Entrypoints, pipeline stages, v5 boundary | `docs/SYSTEM-REFERENCE.md` |
| Which agent/model handles what | `docs/launchpad-agent-routing.md` |
| Design intent and dated evidence | `docs/spec/`, `docs/issues/`, `docs/plans/`, `docs/reports/` — history, never current status |
| Runbooks and operator handoff | `docs/crawler-v2-operator-runbook.md`, `docs/launchpad-v5-operator-handoff.md` |

Skills live in `.agents/skills/`. Eleven operational skills plus the router mirror into `.claude/skills/`; four supporting skills (`application-readiness`, `conversion-ops`, `interview-loop`, `proof-of-fit`) stay `.agents`-only by design and `npm run validate` enforces that split.
