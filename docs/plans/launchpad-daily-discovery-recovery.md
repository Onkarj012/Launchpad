# Launchpad Daily Discovery Recovery Plan

**Status:** Draft  
**Last updated:** 2026-08-19  
**Visual profile:** Runtime recovery control brief  
**Template:** Custom raw Waymark report  
**Destination:** Every Normal morning run returns a truthful `completed`, `partial`, or `failed` result within 20 minutes, can resume after interruption, and never reports execution failure as market scarcity.

## Read this first

### What happened

Launchpad found jobs but did not deliver a result. Two interrupted runs on 2026-08-19 each persisted 1,045 observations, including 19 postings dated within the preceding 24 hours. Both remained at `running / fetch` and emitted no shortlist.

### Why it happened

Runtime registry projection expands the workload to about 109 warm ATS boards and 123 enterprise boards. Source groups run serially. Several adapters do not receive the parent cancellation signal or deadline. Selection and CLI output begin only after the complete crawler returns. Useful rows therefore survive in SQLite while the user sees silence.

### What changes

Repair delivery before expanding coverage:

1. make run identity and every source state durable;
2. stop actual network work when its budget ends;
3. return safe partial evidence instead of silence;
4. spend source budget on relevant, measured coverage;
5. produce one coherent final shortlist and funnel;
6. prove the behavior with bounded no-write runs.

### Completion proof

The plan is complete only when:

- three consecutive no-write local-live runs return a terminal result within 20 minutes;
- one forced interruption resumes under the same daily identity and later completes;
- a partial run performs zero opportunity-ledger, v5, application, outreach, checkbox, or external operations;
- an empty result names either exact rejection reasons or exact incomplete-source coverage;
- the full tracked suite passes once after the output contract is consolidated.

## Target run contract

### Time budget

| Window | Owner | Required result |
|---|---|---|
| 0–12 minutes | Source discovery | Fetch bounded selected sources; persist observations and source state continuously. |
| 12–17 minutes | Normalization, verification, scoring | Reconstruct funnel from durable observations; score only within remaining budget. |
| 17–20 minutes | Handoff and receipts | Emit one terminal envelope; persist telemetry, canary, and notification evidence as allowed by status. |

Unused source time may flow downstream. Reserved downstream time may not flow back into discovery.

### Result meanings

| Status | Meaning | User-visible output | Allowed side effects | Next run |
|---|---|---|---|---|
| `completed` | All planned sources reached a terminal source state and downstream selection finished. | Final shortlist, backfill, verification queue, complete coverage and rejection reasons. | Existing completed-run planning and surfacing rules only. No auto-apply or send. | Idempotent for same daily profile. |
| `partial` | Useful observations exist, but source coverage or optional scoring ended at budget. | Clearly labelled scored, score-pending, backfill, verification, rejection, and omitted-source evidence. | None: `writesPlanned: false`; no ledger surfacing, v5 plan, success canary, or success notification. | Resume same daily profile. |
| `failed` | Config, schema, policy, manifest, database, persistence, or safety invariant failed. | Exact fatal reason and last durable source state. | None. | Repair failure, then resume or explicitly replay. |

### Stable daily identity

Default identity:

```text
daily-<schedule>-<mode>-<location-preset>-<IST-date>
```

Example:

```text
daily-morning-normal-india-2026-08-19
```

A repeated invocation for the same profile and IST date resumes the same incomplete run. Explicit `--run-id` remains available for controlled replay. Historical timestamped IDs remain readable.

## Diagnosis

### Verified run evidence

| Attempt | State | Observations | Distinct jobs | Dated within 24h | Source telemetry reached |
|---|---|---:|---:|---:|---|
| 2026-08-19 05:05 UTC | `running / fetch` | 1,045 | 1,019 | 19 | warm, batch 1, batch 2 |
| 2026-08-19 05:26 UTC | `running / fetch` | 1,045 | 1,015 | 19 | warm, batch 1, batch 2 |

Latest source yield per attempt:

- warm ATS: 813 observations, `succeeded`;
- ATS batch 1: 132 observations, `truncated`;
- ATS batch 2: 100 observations, `truncated`;
- enterprise, remote, startup, and SearXNG: no telemetry row.

Three recent engineering postings from completed sources were inspected. All failed current hard gates: Celonis required six years and Bangalore; Camunda was senior and lacked captured explicit India eligibility; Baseten was San Francisco. This shows real gate-driven scarcity inside completed sources. It does not prove zero eligible jobs across sources that never completed.

### Verified failure chain

1. CLI defaults to dev when `--env` is absent (`crawler/cli.mjs:116-123`).
2. Registry projection replaces small inline arrays with about 109 warm and 123 enterprise boards (`crawler/board-registry.mjs:721-736`).
3. Source groups execute serially (`crawler/run.mjs:530-562`).
4. Default whole-run deadline is 42 minutes with five-minute downstream reserve (`crawler/daily-runner.mjs:25-52`).
5. Warm ATS receives parent cancellation inputs; several batch and enterprise wrappers do not (`crawler/operator.mjs:364-377`).
6. Outer `Promise.race` rejects the caller but does not cancel adapter work by itself (`crawler/run.mjs:431-445`).
7. Observations persist incrementally, but source telemetry is inserted only after a source returns (`crawler/run.mjs:448-560`).
8. Workflow selection starts only after the durable crawl returns (`crawler/workflow.mjs:337-366`).
9. Daily runner performs another tracked ATS fetch after crawler completion (`crawler/daily-runner.mjs:466-504`).
10. CLI emits only after the complete daily runner resolves (`crawler/cli.mjs:246-275`).
11. Timestamped default run IDs prevent normal same-day resume, despite stable identity logic already existing in the scheduler (`crawler/scheduler.mjs:25-68`).

### Research provenance

Codex Luna ran read-only on 2026-08-19 under explicit no-edit and no-live-action constraints. It independently confirmed the registry/serial bottleneck, incomplete deadline propagation, hidden durable observations, timestamped-ID resume failure, ambiguous absent telemetry, duplicate ATS work, and scorer as a second delivery boundary. No Codex edits or tests occurred.

## Recovery design

### Workstream A — durable run control

- Use profile-scoped daily identity.
- Register every planned source before fetching.
- Persist source transitions: `pending → running → succeeded | truncated | interrupted | failed`, or `pending → not_started`.
- Store attempt metadata under run telemetry where practical.
- Classify dead, over-deadline `running` rows as stale or abandoned in schedule health without deleting history.

### Workstream B — one real execution budget

- Keep `createDailyExecution()` as budget owner.
- Pass one parent signal and absolute deadline through every wrapper, adapter, retry, page loop, resolver, Workday detail request, and HTTP transport call.
- Check remaining budget between boards, pages, retries, queries, and detail requests.
- Treat outer abort race as final guard, not cancellation implementation.
- Persist cursor and telemetry before returning from interruption.

### Workstream C — resumable partial handoff

When source budget ends without a fatal invariant failure:

1. mark active source `interrupted` and untouched sources `not_started`;
2. checkpoint run as resumable `partial`;
3. read all committed observations;
4. apply existing freshness, eligibility, readiness, and historical-suppression rules;
5. score only inside remaining budget;
6. emit a versioned result with exact coverage and score state.

Partial output groups:

- application-ready and scored;
- application-ready and score-pending;
- backfill;
- verification queue;
- rejected counts and reasons;
- completed, interrupted, failed, and not-started source coverage.

### Workstream D — measured source planning

Registry membership stops meaning “fetch every board now.” Use deterministic tiers:

| Tier | Purpose | Selection basis |
|---|---|---|
| 0 — daily core | Best recurring India/Pune direct ATS coverage | Trusted dates and descriptions, geography relevance, retained ready-role yield. |
| 1 — targeted enterprise | Bounded Workday and enterprise coverage | Geography/title relevance, health, continuation cursor, prior ready yield. |
| 2 — exploration | Learn new or stale-health boards | Deterministic quota; initially 20% of enterprise budget. |
| 3 — opportunistic | Long-tail discovery | Remote, India-startup, and SearXNG only while source budget remains. |

Use 80% measured priority and 20% deterministic exploration until three completed runs provide evidence to recalibrate. Record why every board was selected, deferred, resumed, or omitted. Hydrate details only for target titles and compatible geographies.

### Workstream E — one discovery pass and one shortlist owner

- Move tracked ATS rotation into the durable crawler source plan.
- Deduplicate board identities across lanes before network work.
- Remove the second post-crawler `fetchWarmAts()` pass from `runDailyNormal()`.
- Keep crawler output focused on observations, evidence, source health, verification, and diagnostic reserve.
- Make Normal/Startup/Remote mode selector the sole owner of final scoring, diversity, target count, shortlist, v5 plans, and completed-run opportunity surfacing.
- Preserve crawler `shortlist` only as a compatibility field until direct callers migrate.

## Delivery sequence

| Phase | Plain-language outcome | Main changes | Exit gate | Rollback boundary |
|---|---|---|---|---|
| 01 — Know where work stopped | Every run and source is explainable and resumable. | Stable profile ID, attempt metadata, planned-source rows, explicit source states, stale-run health. | Interrupt after batch 2; same command resumes same ID with no duplicate observations and complete source-state coverage. | Restore timestamp default IDs while retaining additive telemetry and history. |
| 02 — Stop work on time | Parent budget stops actual network activity. | Signal/deadline propagation, inner-loop budget checks, transport cancellation, cursor checkpointing, downstream reserve. | Hanging transport stops within deadline +2s; request count does not increase after cancellation. | Disable new deadline path per source; keep parent safety deadline. |
| 03 — Return what is usable | Incomplete coverage produces safe partial evidence, not silence. | Partial checkpoint, durable funnel reconstruction, versioned envelope, score-pending group, completed-only side effects. | Forced enterprise timeout emits labelled partial output and zero write/surfacing operations; resume can later complete. | Disable partial emission by config; completed and failed paths remain. |
| 04 — Spend source time better | Bounded work favors relevant yield while preserving exploration. | Durable ATS rotation, board dedupe, tiered planner, selection reasons, targeted hydration. | No board fetched twice; three no-write manifests; source phase ≤12 minutes without lower retained ready yield. | Switch planner to legacy projection; keep lifecycle, cancellation, and dedupe telemetry. |
| 05 — Produce one answer | One funnel explains every role transition. | Mode selector becomes final authority; unified `fetched → dated → eligible → ready → scored → selected` telemetry; status-aware notification. | Shortlist, v5 plans, and receipt counts reconcile; zero-job output identifies gates or incomplete coverage. | Retain compatibility reserve fields while mode shortlist stays authoritative. |
| 06 — Prove it safely | Local behavior is demonstrated; production stays blocked. | Focused tests, one final full suite, three no-write live-local runs, interruption/resume drill, status update. | Three terminal runs ≤20 minutes, one partial-to-completed resume, no external mutation, nonzero inventory in full suite. | No production activation; retain previous working config. |

### Phase dependencies and stop points

1. Phase 01 must pass before cancellation work starts.
2. Phase 02 must prove no adapter leaks before partial delivery starts.
3. Phase 03 must prove partial safety before source prioritization starts.
4. Phase 04 must retain or improve ready-role yield before funnel consolidation.
5. Phase 05 full suite must pass once before release work.
6. Phase 06 stops at local proof. Commit, push, PR, launchd install, production config activation, live smoke, and promotion each need separate explicit authorization.

## Change map

### Run control and output

| Path | Action | Responsibility |
|---|---|---|
| `crawler/scheduler.mjs` | Modify | Stable profile identity and resume classification. |
| `crawler/cli.mjs` | Modify | Stable default ID and terminal completed/partial/failed envelope. |
| `crawler/daily-runner.mjs` | Modify | Budget partition, partial handoff, duplicate ATS removal, completed-only surfacing. |
| `crawler/run.mjs` | Modify | Planned source states, partial checkpoint, attempt metadata. |
| `crawler/schedule-health.mjs` | Modify | Active, stale, partial, resumable, completed, and failed health. |

### Discovery and source planning

| Path | Action | Responsibility |
|---|---|---|
| `crawler/operator.mjs` | Modify | Parent budget propagation and bounded source plan. |
| `crawler/ats-batch-1.mjs` | Modify | Board/page/detail cancellation boundaries. |
| `crawler/ats-batch-2.mjs` | Modify | Board/item cancellation boundaries. |
| `crawler/ats-enterprise.mjs` | Modify | Board/page/detail limits and parent signal. |
| `crawler/india-startup-lanes.mjs` | Modify | Query work bounded by source budget. |
| `crawler/brave-search.mjs` | Modify | Search and resolver work bounded by source budget. |
| `crawler/board-registry.mjs` | Modify | Tiered projection by relevance, health, yield, continuation, and exploration. |

### Funnel, configuration, and proof

| Path | Action | Responsibility |
|---|---|---|
| `crawler/workflow.mjs` | Modify | Reconstruct durable partial funnel; diagnostic crawler reserve. |
| `config/crawler-v2-dev.json` | Modify | Explicit execution and source-planning budgets. |
| `config/crawler-v2.json` | Modify later | Mirror approved defaults only after local proof. |
| `tests/crawler/*.test.mjs` | Modify/add | Resume, source states, cancellation, partial safety, rotation, dedupe, funnel, and bounds. |
| `docs/STATUS.md` | Modify after proof | Record exact local behavior and remaining production gates. |

### Explicitly unchanged

- `master_prompt.md`: targeting, scoring, evidence, freshness, and safety policy remain authoritative.
- `config/notion-v5.manifest.json`: no schema or target change.
- resume and outreach paths: outside discovery-recovery scope.
- existing SQLite observations, cursors, opportunity history, canary records, and v5 state: never deleted by this work.

## Acceptance board

| Gate | Proof | Failure response |
|---|---|---|
| Stable identity | Same schedule/mode/location/date returns same default ID. | Stop Phase 01. |
| Resume | Interrupted run continues unfinished work without duplicate observations. | Stop Phase 01. |
| Source visibility | Planned source count equals explicit source-state count. | Stop Phase 01. |
| Real cancellation | Hanging transport stops within deadline +2s; no request starts after cancellation. | Stop Phase 02. |
| Terminal bound | CLI emits completed, partial, or failed within 20 minutes. | Stop Phase 02 or 03. |
| Partial safety | Zero ledger, v5, external, application, send, or checkbox operations. | Stop Phase 03. |
| Board ownership | Network trace records one fetch owner per board. | Stop Phase 04. |
| Planner quality | Selection reasons and ready yield retained for three no-write runs. | Roll back Phase 04 planner flag. |
| Funnel coherence | Crawler, mode, v5-plan, and notification counts reconcile. | Stop Phase 05. |
| Market honesty | Empty output names exact rejection or incomplete-source reasons. | Stop Phase 05. |
| Regression | Full tracked suite passes once with nonzero inventory. | Stop Phase 06. |
| Operational evidence | Three no-write local-live runs meet terminal SLO. | Keep production blocked. |

Test budget: at most 20 new focused tests, then one final full readiness run. Widen only after a real failure or demonstrated blast radius.

## Safety and non-goals

### Invariants preserved

- No auto-apply, autonomous send, connection, DM, referral, reaction, or comment action.
- `Make Resume` and `Applied?` remain user-owned.
- Partial result creates no opportunity-ledger surfacing or v5 write plan.
- No legacy tracker fallback.
- No fabricated job, company, location, compensation, date, link, or eligibility evidence.
- Existing databases remain additive and readable.

### Not part of this plan

- relaxing targeting or score thresholds;
- padding target count with weak or unverifiable roles;
- adding Crawlee, Firecrawl, paid rescue, browser automation, or new providers;
- redesigning Notion schemas or v5 stores;
- changing resume, outreach, Gmail, LinkedIn, or application behavior;
- deleting stale runs or historical data;
- installing schedules, running live writes, or promoting production.

## Risks and controls

| Severity | Risk | Control |
|---|---|---|
| High | Partial output mistaken for final shortlist. | Visible `partial` status, exact coverage, separate score-pending group, `writesPlanned: false`, no surfacing or success receipt. |
| High | Adapter continues after caller returns. | Parent signal reaches transport and inner loops; post-cancel request count must remain fixed before Phase 03. |
| High | Stable IDs collide. | Include schedule, mode, location preset, and IST date; preserve explicit override. |
| High | Priority planner hides productive boards. | Keep deterministic 20% exploration, omission reasons, yield measurement, and legacy-planner rollback flag. |
| Medium | Removing second ATS pass reduces coverage. | Move rotation into durable first pass and compare board identities before removing duplicate path. |
| Medium | Stale historical rows confuse operators. | Classify stale/abandoned in health output; never delete evidence automatically. |
| Medium | Scorer consumes reserve. | Hard timeout and score-pending partial group; optional scoring cannot erase ready roles. |
| Low | Versioned result breaks direct callers. | Retain compatibility fields until fixtures and direct callers migrate. |

## Non-blocking open questions

1. After three completed local-live runs, should evidence replace the initial 80/20 priority-to-exploration ratio?
2. Should score-pending partial roles remain visible by default? Current default: yes, in a separate labelled group.
3. Should midday resume morning work? Current default: separate schedule identity; explicit morning rerun resumes morning.
4. Which compatibility release removes crawler `shortlist` as user-facing output? Current default: retain until direct callers migrate.

Defaults apply unless Phase 04 or Phase 05 evidence proves them harmful. None blocks Phase 01.

## Approval boundary

This published page remains a draft specification. It authorizes no crawler implementation, executor handoff, branch, commit, issue, pull request, schedule installation, production config activation, live smoke, external write, or promotion.

Each downstream action requires separate explicit approval.
