# Launchpad — project map & contract

This is Onkar Jadhav's job-search system: discover roles → score against targeting → tailor a one-page resume → track the lifecycle in Launchpad v5. Read `AGENTS.md`, `master_prompt.md`, and `docs/STATUS.md` before operating.

## Source of truth

- `master_prompt.md` owns targeting, scoring, resume, and outreach policy.
- `docs/STATUS.md` is the sole current execution-status index. GitHub issues remain the live issue-status authority.
- `resumes/templates/Onkar_Template.tex` is the frozen layout. Tailor only its marked slots.
- `resumes/master/Master_Resume_ATS.tex` is the approved evidence source. Never invent claims.
- `config/notion-v5.manifest.json` is the fixed v5 target manifest. `config/launchpad-v5.commands.json` is the public command/safety contract.

## Identity

Onkar Jadhav · onkarj012@gmail.com · +91-7058604679 · home Pune, Maharashtra, India · B.Tech Computer Science, PCCOE (SPPU), 9.17 CGPA, final result officially declared; degree certificate pending, 2026. Currently employed: Capgemini, A4 Analyst, Navi Mumbai, since 10 Aug 2026, in Java Full Stack (JFS) course training with no project work yet. Target titles: AI/LLM Engineer, Agentic AI Engineer, ML Engineer, Full-Stack AI, Backend Python, and early-career SWE.

## Public v5 workflow

- The unified local daily path is `node crawler/cli.mjs daily morning|midday --mode normal|startup|remote --location-preset india|pune`. It performs one shared crawl, then invokes the requested mode selector. Midday Remote does not fetch native remote feeds.
- `/morning` delegates to the unified daily path. Startup and Remote are source-emphasis modes over the shared gates; Apify is explicit rescue only and default-off (`node job-pull/apify-pull.mjs --profile <stable-name> --out RAW.json`).
- `/quick-add` prepares one user-found lead for v5 verification.
- `/make-applications` reads checked `Make Resume` rows through `resume-v5/queue-reader.mjs` and builds locally.
- `/outreach` uses `outreach-v5/workflow.mjs` for free-first research and local/v5 draft preparation. No Gmail draft adapter or send provider is guaranteed.
- `/linkedin-leads` is an explicit read-only rescue and may produce application and associated-person evidence.
- `/followups` uses `outreach-v5/cadence.mjs`; `/sync` uses `resume-v5/application-sync.mjs` for observed `Applied?` and confirmed outcomes.

The local operator entrypoint is `node launchpad-v5.mjs {help|validate|rehearse}`. `rehearse` uses fixture data and injected local fakes only. Local launchd generation/install support exists, but installation and production execution must not be claimed without retained live evidence.

## Non-negotiables

- No auto-apply, autonomous sending, connection/DM/referral automation, or automatic Gmail/LinkedIn action.
- `Make Resume` and `Applied?` are user-owned. Agents read them but never check them.
- Live writes, when explicitly authorized, target only declared v5 stores through the scoped gateway and external transaction journal. Never use a legacy fallback.
- Resume compilation is local-only. `resumes/output/<date>/` contains PDFs only; source and sidecars stay under `resumes/sources/<date>/`.
- Do not change the frozen template or master resume in integration work.
- Never fabricate experience, dates, salary, stipend, contact, link, or company evidence. Unknown stays unknown or `Not Verified`.
- No credential creation, migration, archive, delete action, or production promotion is implied by local implementation or tests.

## v5 state model

Applications v5 owns role lifecycle and manual `Make Resume` / `Applied?` inputs. Companies v5 owns reusable company evidence. Outreach v5 owns application × person × channel sequences. Activity v5 owns idempotent dated events. Referrals v5 owns referral evidence and outcomes. v3/v4 are untouched historical read-only systems and are not runtime or fallback targets.
