# P00 reliability baseline and role-tenure repair

19 October 2026 IST. Base revision: `52e55fd41c8a78b2ded4543b7c5394c6e338f61f`. PR #14 remains draft. This is local engineering evidence, with no live source or production proof.

## Changes

- Workflow telemetry collections retain per-record size, depth, node and count limits without rejecting a valid collection solely for its aggregate JSON size. Persistence and replay use matching boundaries.
- A post-crawl handoff failure retains a durable source snapshot. Local reports show terminal failure cause, retained coverage and unknown measurements. Final degraded delivery takes precedence over a completed discovery snapshot; successful outcome `ok` maps to `completed`.
- Source-yield reports identify the discovery snapshot. They do not count delivered roles, later enrichment or scoring. Per-board rates require matching request evidence.
- Fake CLI runs write reports to temporary test destinations.
- Standalone role-tenure qualifications retain flat HTML item and paragraph boundaries, real bullet/checklist markers and Markdown emphasis. Supported preferred headings preserve optional context, while explicit required headings reset it. Ordinary skill bullets and parenthetical continuations do not change section state.

The new role-tenure path accepts a complete role/position qualification, an explicit mandatory ending, or the retained technical customer-facing examples. Unknown adjacent continuations defer its number. Nested HTML lists defer this path for the whole description; existing extractors still run. This does not claim nested-list understanding.

Paragraph markers preserve completed sentence boundaries. An unfinished bachelor's degree alternative or prospective tenure remains attached to its following quantity. An independent list item can still supply a mandatory minimum. The forward extractor excludes bounded prospective `spend` and `work` leads, while explicit applicant cues such as `must have`, `should have` under a required heading, and `will require` retain their tested results. Other legacy extraction is unchanged apart from the approved preferred-suffix correction.

## Review and verification

Codex reviewed the uncommitted follow-up against draft revision `6e2f521f1b909bcac81ebc3417451c0711290bb3`. R35 review found no actionable regressions. Earlier rounds found introduced preference, formatting, paragraph and degree-alternative errors. Those failed attempts and their receipts remain local; passing tests alone were not treated as acceptance. The final follow-up retains the existing test names and extends their assertions.

Final local checks on 19 October 2026 IST:

- Five focused files passed 122/122, from 02:37:34 to 02:38:29. They cover the daily runner, discovery profile, local lead report, source-envelope recovery and experience recovery.
- `npm run safety` passed all seven checks at 02:38:29.
- R35's focused parser test passed 13/13 at 02:34:36. Its initial degree-alternative attempt failed and was corrected before the passing run.
- `git diff --check` passed after the final documentation update.
- The synthetic fatal report was previously inspected at 728px and 360px. It was not re-rendered for this parser follow-up.

Commands:

```sh
node --test tests/crawler/daily-runner.test.mjs tests/crawler/discovery-profile.test.mjs tests/crawler/local-lead-report.test.mjs tests/crawler/source-envelope-recovery.test.mjs tests/job-pull/experience-recovery.test.mjs
npm run safety
git diff --check
```

`npm run validate` remains blocked in the isolated checkout by five absent ignored `.claude` skill mirrors. No skills or validator behavior were changed. That known blocker was not rerun for the final follow-up. Full-suite, readiness and rehearsal checks were not run. GitHub has no check results for this draft; an empty checks list is not a passing CI run.

## Remaining limits

Narrative experience parsing stays in P01. The known `7–10+ years building production backend systems; 5+ years hands-on with AWS` defect is not fixed. The legacy future-tenure example `No prior experience required. You will be working remotely for at least three years in this position.` still returns 3. No broad future, waiver or negation grammar is claimed.

No live job query, application, message, tracker write, credential change, schedule installation, production promotion or PR merge was performed. The original dirty checkout is preserved. Private research and job evidence remain local. Local checks do not establish suitable daily supply or operational readiness.
