# P00 reliability baseline and role-tenure repair, 19 October 2026 IST

The local candidate is based on `52e55fd41c8a78b2ded4543b7c5394c6e338f61f` in the isolated worktree. It is not promoted. No live source proof was run.

## Candidate changes

The P00 baseline repairs telemetry persistence, fatal report coverage, and fake CLI report paths. The standalone role-tenure matcher accepts a quantity at the start of a plain-text line or preserved HTML block/list item, with an optional bullet or checklist prefix. Preference-heading context lasts until a requirement heading resets it. Only terminal item lines with one of the bounded positive endings below can add a new P00 minimum.

The new matcher adds a minimum only for a complete role/position qualification with optional final punctuation, an explicit `required` or `mandatory` ending, or the retained parenthetical list of technical customer-facing role examples. Section headings are recognized before the matcher checks the next line. A blank line, heading, new bullet, or another standalone quantity requirement ends the current item. Any other adjacent text in the same item defers its number from P00 for manual review. This uses item boundaries, not a growing list of guessed continuation words. Adjacent HTML block formatting is normalized to one item boundary, including paragraphs outside list items; separate HTML list items remain independent. Raw blank lines create boundaries only in plaintext. `Nice-to-have` headings are recognized with or without hyphens.

R22 shares one heading classifier between item-boundary detection and preferred-section tracking. It recognizes heading-shaped optional and preferred labels such as `Optional qualifications` and `Preferred Qualifications & Skills`; required and minimum headings reset the section. Optional/preferred context wins if a shaped heading includes both preference and requirement cues. R23 extends that same classifier to subject-first headings with a parenthetical preference cue, such as `Qualifications (preferred)` and `Skills and experience (optional)`. Parentheses are accepted only when the heading also names a qualification subject, so a narrative `(optional)` line remains item context.

R22 introduced two hard-rejection regressions in the new path. R23 defers an unbulleted standalone role-tenure line after a dangling `degree or` line, while an explicit new bullet remains a separate requirement. The existing advanced and unspecified degree alternative cases retain their tested results. The new matcher skips a description containing nested HTML lists because it cannot prove which list item owns a number and its qualifier without tree parsing. Existing extractors still run, so nested content may retain a legacy result. This is a manual-review limitation, not a claim that nested-list requirements are understood.

R20 fixes two R19 gaps. Raw blank formatting between HTML paragraphs no longer inserts a semantic blank boundary, including within a list item. The exact outside-list and inside-list preference examples now return unknown. Local reports derive run status from the outcome, delivery reconciliation, and terminal envelope. A final degraded delivery remains `degraded` when the discovery envelope says `completed`, and unknown outcomes remain `Not Verified`. R21 maps canonical outcome `ok` to `completed`, preserving failure precedence and partial envelope status.

The previously approved preference-suffix correction remains. Existing forward, reverse, activity, and `requiredYears` extraction paths retain their HEAD behavior. This matcher does not change legacy findings. In particular, `5+ years in a role, Python experience is not required` remains outside the new path, and its legacy result is unchanged. Narrative matching remains P01 work. Known future-tenure behavior, including the legacy result 3 for `No prior experience required. You will be working remotely for at least three years in this position.`, is unchanged. No broad future, waiver, or negation grammar is claimed.

The known listing says “7–10+ years building production backend systems; 5+ years hands-on with AWS.” This repair does not address that text, and no numeric result is claimed for it. The legacy future-tenure example still returns 3. No live source proof was run.

## Checks

- R18: `node --test tests/job-pull/experience-recovery.test.mjs` passed 13/13 at 00:46:48 IST; the requested five files passed 122/122 at 00:47:55 IST; `git diff --check` passed at 00:49:09 IST. Logs and the exact IST receipt remain in `.local/p00-baseline-review/r18/`.
- R19: after the two parser corrections, `node --test tests/job-pull/experience-recovery.test.mjs` passed 13/13 at 00:53:34 IST. The captured output is in `.local/p00-baseline-review/r19/experience-recovery.log`.
- R19 `git diff --check` is recorded separately in `.local/p00-baseline-review/r19/diff-check.log`. The R18 five-file 122/122 result is prior evidence; R19 did not rerun it.
- R20: `node --test tests/job-pull/experience-recovery.test.mjs tests/crawler/local-lead-report.test.mjs` passed 23/23 at 00:59:51 IST. Output: `.local/p00-baseline-review/r20/focused-tests.log`.
- R20 `git diff --check` result is retained in `.local/p00-baseline-review/r20/diff-check.log`.
- R21: `node --test tests/crawler/local-lead-report.test.mjs` passed 10/10 at 01:02 IST. The focused run and `git diff --check` receipt are in `.local/p00-baseline-review/r21/`.
- R22: `node --test tests/job-pull/experience-recovery.test.mjs` passed 13/13 at 01:08 IST; `git diff --check` passed. The test extends the existing parser case, with no new named tests. Exact output and the IST receipt are in `.local/p00-baseline-review/r22/`.
- R23: the same focused parser test passed 13/13; `git diff --check` passed. The existing parser case now covers the two heading forms, a heading reset with a separate required item, the bachelor-degree alternative, and a separately bulleted requirement. Exact output and start times are in `.local/p00-baseline-review/r23/`.

No full suite, readiness run, rehearse, validator rerun, safety rerun, live source query, or production verification was performed. `npm run validate` remains blocked in this checkout because five ignored `.claude` skill mirrors are absent; this blocker was not rerun or repaired. Prior safety evidence remains 7/7 and was not rerun.

## P00 draft review blockers, 19 October 2026 IST

Codex review still found two introduced false hard rejections: a `Strongly preferred:` section and future-tenure prose wrapped before the numeric line. These cases block merge. Passing focused tests do not resolve the findings. P00 remains a draft proposal; no live or production readiness is claimed.
