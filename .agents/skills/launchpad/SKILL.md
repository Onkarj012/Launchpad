---
name: launchpad
description: Route a Launchpad v5 request to the correct skill. Read this first when the operator is unsure which slash command to run.
disable-model-invocation: false
---

# Launchpad router

Read `master_prompt.md` and `docs/STATUS.md`. Vocabulary is in `../guardrails.md`. Mirror policy: the eleven operational skills plus this router are mirrored into `.claude/skills`; the four supporting skills remain `.agents`-only.

## Routed skills

| Request | Skill |
| --- | --- |
| Daily discovery / morning / midday | `morning` |
| Source/query mechanics behind a pull | `daily-job-pull` |
| One user-found role | `quick-add` |
| Tailor one JD into a PDF | `resume-latex` |
| Batch every checked Make Resume row | `make-applications` |
| Recruiter review of a tailored source | `resume-check` |
| One role research + resume + optional draft | `application-agent` |
| Contacts and outreach drafts | `outreach` |
| Due follow-ups | `followups` |
| Observed Applied? / outcomes | `sync` |
| Explicit LinkedIn hiring-post rescue | `linkedin-leads` |
| Readiness gate before applying | `application-readiness` |
| Conversion measurement | `conversion-ops` |
| Interview prep loop | `interview-loop` |
| Proof-of-fit artifacts | `proof-of-fit` |

Never auto-apply or send. Never check, uncheck, or otherwise mutate user-owned boxes. Supporting skills remain local and are routed here without `.claude` mirrors.
