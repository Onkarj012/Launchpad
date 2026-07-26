# Spec — Match Score computation

**Status:** planned, not implemented
**Date:** 2026-07-25
**Blocks:** every production run. Nothing in the codebase computes Match Score, so
`unscoredCount > 0` trips the ticket-03 gate and the run exits fatal by construction —
regardless of how good the candidate pool gets.

---

## 1. Why this is the last blocker

`job-pull/run.mjs` computes `conversionScore`, freshness, eligibility and readiness.
`job-pull/candidate.mjs:385` only *reads* `matchScore` off the raw record. Match Score
comes from the `master_prompt.md` §3 rubric — 55 of its 100 points (Skill match 35,
Domain relevance 20) require reading the JD against the user's stack, plus a rationale
line, a strongest hook, and an `Auto-Suggest` boolean. It is a judgment step, not a
pipeline stage, and it has never been built.

Consequence: ticket 01 feeds full unscored inventory into selection; ticket 03 fails the
run when anything is unscored. Individually correct, jointly non-delivering.

---

## 2. What already exists — do not rebuild

| Piece | State |
|---|---|
| `applyScores(sources, scoreInput)` — `job-pull/run.mjs:153` | Done. Merges by canonical URL. Reads `matchScore`, `rationale`, `strongestHook`, `responseLikelihood`, `autoSuggest`, `humanContact`, `originalApplicationUrl`. |
| `--scores-json` → `cli.mjs` → `daily-runner.mjs` → `normal-mode.mjs` | Done, commit `a27caa2`. |
| `scoringQueue` on the result object | Done. Full `CandidateV1` per row. |
| Rubric | Written — `master_prompt.md` §3. |
| Funnel / verificationQueue on fatal path | Done, commit `5b2d2d8`. |
| **Match Score computation** | **Missing. This spec.** |

Pool size after the 2026-07-25 gate audit, under the unchanged Pune-metro geo policy:
**9 fresh-eligible today, up to ~44** once Workday `postedOn` dating lands (commit
`76bc53f`). Design for ~50/day, not thousands.

---

## 3. Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| Scoring engine | **`gpt-5.6-luna` via the Codex CLI** | Rides the existing subscription. No per-token API cost. |
| Dependency | **None added** | `child_process` is stdlib. No `package.json`, no `@anthropic-ai/sdk`, no `ANTHROPIC_API_KEY`, no `.env`. The repo stays dependency-free and `node --test` keeps running with zero install. |
| Placement | **In-run**, mid-pipeline | The scoring queue is already in hand at that point. Avoids the replay-path problem entirely (`daily --scores-json` otherwise re-crawls for 71 min). |
| Batching | **~12 jobs per codex call** | 50 separate invocations wastes session startup and loses rubric consistency. All 50 in one call invites rubric drift between the first and last job. |

Rejected: the Anthropic API path (~$1.50/day on Opus 5, ~$45/month; would have required
a root `package.json` and an API key).

### Subscription load

| | tokens |
|---|---|
| Per call (~12 JDs × ~2.5k) | ~30k in, ~2.5k out |
| Full 50-job day (4 calls) | **~140k total** |
| Typical 9-eligible day (1 call) | ~25k |

For scale: the two implementation dispatches on 2026-07-25 used 142k and 114k tokens.
A whole day of scoring costs roughly one implementation dispatch.

---

## 4. Architecture

```
04:30  crawl (~71 min) → eligibility gates → scoringQueue (9–49 rows)
                                               ↓
                        chunk into 12s → codex exec ×N → schema-validated JSON
                                               ↓
                            applyScores() → selection → shortlist → Notion ops
```

`--scores-json` remains the manual override — useful for re-scoring without re-crawling,
and for keeping tests offline.

### Codex invocation contract

`codex exec` supports JSON-Schema-constrained output, so the scorer never scrapes stdout:

```sh
codex exec -m gpt-5.6-luna \
  -s read-only \
  --skip-git-repo-check --ephemeral \
  --output-schema config/match-score.schema.json \
  -o .local/launchpad-crawler/scores-chunk-N.json \
  "<fenced scoring prompt referencing the chunk file>"
```

- `--output-schema <FILE>` — constrains the final response shape.
- `-o, --output-last-message <FILE>` — writes the final message to a file.
- `-s read-only` — codex is a coding agent; it has no business writing to the repo
  during a scoring pass.
- `--ephemeral` — do not persist session files for a nightly batch.

### New module

`job-pull/match-scorer.mjs`, called from `job-pull/normal-mode.mjs` immediately after the
scoring queue is built and before selection.

### Output schema

`config/match-score.schema.json`. Fields mirror exactly what `applyScores` reads:

| Field | Type | Notes |
|---|---|---|
| `canonicalUrl` | string | join key |
| `matchScore` | integer 0–100 | rubric total |
| `rationale` | string | one line |
| `strongestHook` | string | single strongest hook to lead the resume/email with |
| `responseLikelihood` | integer 0–20 | rubric sub-score; feeds the Auto-Suggest rule |
| `autoSuggest` | boolean | `score ≥ 80 AND window ∈ {Hot, Active} AND tier = Strict AND responseLikelihood ≥ 14` |
| `descriptionAvailable` | boolean | see below |
| `seniorityDecision` | eligible, ineligible, uncertain | abstaining classifier output |
| `requirementKind` | enum | total-professional, technology-specific, domain-specific, preferred, or ambiguous |
| `minimumYears` | number or null | minimum from the quoted requirement |
| `evidenceQuote` | string | exact literal JD substring; empty only when no years statement exists |
| `confidence` | number 0–1 | classifier confidence |
| `reasonCode` | string | stable seniority decision reason |

**`descriptionAvailable` is load-bearing.** Skill match (35) and Domain relevance (20)
both require reading the JD. Workday rows only receive JD text via
`enrichWorkdayCandidates`, whose budget is 50. A row with no description cannot be
honestly scored — it must be capped, not guessed. `CLAUDE.md`: never fabricate evidence;
unknown stays unknown.

### Range validation

Ranges are enforced twice: `minimum`/`maximum` in the JSON Schema are the first layer,
and JavaScript re-validates every returned row as the authoritative layer
(`matchScore` 0-100, `responseLikelihood` 0-20). A range-invalid row fails with
`SCORER_INVALID_RANGE`; it is never clamped into range and retained.

An earlier revision removed the schema range keywords on the theory that codex-cli
0.145.0 hangs on them. That was measured directly and is false. Seven timed trials
against real job rows, using production flags and the real chunk-file prompt: 1 row
with ranges 12.7s, 5 rows 28.2s, 10 rows 33.5s — all valid JSON with every value in
range. A probe *without* the range keywords returned `responseLikelihood: 78`, outside
the intended 0-20. The keywords therefore stay, and the JS layer stays with them.

The whole-scoring deadline is derived from that measurement rather than guessed:
33.5s worst case x 2 headroom x 5 chunks is roughly 335s, rounded to 360s.

Seniority output is validated independently of JSON Schema. A non-empty
`evidenceQuote` must be a literal substring of the JD, and a years value requires a
quote. Invalid model evidence rejects that row. Deterministic postconditions always
reject an explicit total-professional minimum of three or more years, while
technology-specific, domain-specific, and ambiguous requirements can abstain into the
verification queue. Assessments are cached by JD fingerprint, prompt version, and
model version.

---

## 5. Risks

1. **launchd PATH.** The 04:30 agent runs with a minimal environment; `/opt/homebrew/bin`
   is very likely not on it. Resolve the codex binary by absolute path — do not rely on
   `PATH`.
2. **Unattended auth.** If codex auth lapses, the run must go **degraded**, not crash:
   persist the scoring queue, empty shortlist, explicit reason code.
3. **Tier.** `gpt-5.6-luna` is the light tier (int 6 in the routing table). Rubric
   application is mechanical; skill-match judgment against the user's stack is not. If
   rankings look wrong after a few days, `gpt-5.6-sol` (int 8) is the same subscription —
   escalating tier is covered by the standing permission in the `delegation` skill.
4. **Subscription intent.** Codex subscriptions are priced for interactive developer use;
   a nightly automated batch is adjacent to that rather than squarely inside it. At
   ~140k tokens/day for a personal job search the volume is small. Noted once; the user's
   call.

---

## 6. Gate policy change

Current: `unscoredCount > 0` → fatal, `scoringFailed > 0` → fatal.

With an in-run scorer, `unscored` should always be 0, so that gate stops firing on its
own. But `scoringFailed > 0` → fatal means one transient failure kills a run that found
48 good jobs.

Fail the run only when the scorer is **broken** — auth failure, binary missing, spawn
failure, whole-run deadline, or more than 50% of attempted rows failed. Failed-row share
is authoritative because candidate failures and reconciliation are row-level, and the
final chunk can be smaller than earlier chunks. Otherwise drop the failed rows, retain
their exact reason code and captured stderr in the receipt, and deliver the rest.

---

## 7. Sequence

1. **Scorer module + wiring** — `match-scorer.mjs`, `config/match-score.schema.json`,
   chunking, call site in `normal-mode.mjs`. This alone makes runs deliver a shortlist.
2. **Gate policy** — partial-failure tolerance per §6.
3. **Live Notion write path** — separate workstream, currently ~50% (operations are
   planned, the scoped v5 gateway exists, but no live write has ever executed).

When dispatching ticket 1 to codex, specify the child-process contract explicitly rather
than letting it improvise the invocation — the implementer is codex, building the thing
that calls codex.

---

## 8. House rules that apply

From `CLAUDE.md`: no auto-apply, no autonomous sending. `Make Resume` and `Applied?` are
user-owned and never auto-checked — `Auto-Suggest` is the cloud's pick opinion only and
must never set either. Never fabricate evidence; unknown stays unknown or `Not Verified`.
Live writes only through the scoped v5 gateway with explicit opt-in.
