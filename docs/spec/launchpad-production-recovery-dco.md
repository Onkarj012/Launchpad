# DCO-2026-07-25 — Launchpad Production Recovery

Status: proposed for implementation approval  
Date: 2026-07-25  
Owner: Onkar Jadhav  
System: Launchpad v5  
Baseline branch: `codex/conversion-plan-implementation`  
Change type: corrective architecture and production wiring  
Source: full-system audit of discovery, application, resume, lifecycle, and outreach paths

## 1. Decision

Recover Launchpad around one measurable outcome:

> Produce the strongest 10–15 application-ready roles on an ordinary inventory day, stretch to 15–20 when verified inventory supports it, prepare 7–10 truthful application packets, and support 5–8 targeted human outreaches without auto-applying or auto-sending.

Do not force a fixed count by weakening eligibility, accepting unresolved jobs, selecting low scores, widening onsite geography beyond Pune metro, or fabricating freshness and evidence.

The implementation order is:

1. Restore trustworthy local daily delivery.
2. Repair source coverage, readiness, scoring, suppression, and selection.
3. Connect application delivery and make resume generation repeatable.
4. Repair lifecycle synchronization.
5. Make outreach operational behind human review.
6. Prove reliability through a bounded production shadow before promotion.

## 2. User outcome

Every successful daily run must produce a local Markdown report containing:

- 10–15 application-ready roles routinely;
- up to 20 when verified inventory supports it;
- Strict and shortage-fallback sections;
- original employer or ATS URL;
- verified liveness;
- trusted freshness class;
- exact seniority evidence and decision;
- Match Score and Response Likelihood;
- strongest resume/outreach hook;
- explicit readiness or verification blockers;
- exact shortfall explanation when the target is missed.

After the local path is proven, an explicitly authorized later phase may persist the same committed records into Applications v5. Local Markdown delivery is the first production target. Notion live write is not a prerequisite for restoring daily job delivery.

## 3. Guardrails

This DCO preserves all existing safety contracts:

- No auto-apply.
- No application form submission.
- No autonomous email, LinkedIn message, connection, referral request, or follow-up send.
- `Make Resume` and `Applied?` remain user-owned.
- `Auto-Suggest` remains an opinion only.
- Onsite and hybrid roles remain Pune-metro-only.
- Remote roles must explicitly allow India, APAC, or worldwide participation without excluding India.
- Hard total-professional minimum of three or more years remains ineligible.
- Two-year roles remain shortage fallback only.
- Unknown evidence remains unknown or `Not Verified`.
- Unresolved aggregator or search links never enter the application-ready shortlist.
- No legacy v3/v4 write fallback.
- Resume compilation remains local-only.
- Frozen template and master resume are not changed by integration work. Any template content correction requires separate explicit approval.
- No live Notion, Gmail, commercial enrichment, or other external write is enabled by default.
- Existing uncommitted work must be preserved and reviewed before implementation begins.

## 4. Audit baseline

### 4.1 Observed production funnel

Recorded expanded run:

```text
7,823 observations
→ 54 eligible
→ 9 fresh + eligible
→ 1 application-ready
→ 0 selected
```

Recorded scheduled run:

```text
10,409 fetched
→ 5 eligible
→ 1 ready
→ 0 scored
→ 0 selected
→ fatal
```

Current empirically demonstrated end-to-end throughput:

- durable application-ready deliveries: 0/day;
- Applications v5 rows created by `crawler daily`: 0/day;
- production contact discoveries: 0/day;
- production Gmail drafts with attached resume: 0/day.

### 4.2 Source inventory versus effective coverage

Registry:

- 237 enabled boards;
- 109 warm ATS boards;
- 123 Workday boards;
- 19 India-first warm boards.

Effective warm coverage:

- crawler warm scan: first 20 boards;
- separate tracked scan: first 40 boards;
- first 20 duplicated;
- registry order makes both slices almost entirely Ashby;
- Greenhouse and Lever inventory can be permanently omitted;
- no rotation or persisted provider cursor controls the board window.

### 4.3 Application and outreach state

- Daily run plans application operations but does not execute production Applications v5 writes.
- Make Resume runtime depends on injected callbacks rather than one assembled production command.
- Applied and outcome synchronization can partially mutate live state and regress advanced statuses.
- Outreach supports local evidence, draft, and cadence functions, but real provider adapters, raw Notion normalization, Gmail draft creation, PDF attachment, and safe multi-row transactions are absent.

## 5. Service objectives

### 5.1 Daily funnel target

| Stage | Operating target |
|---|---:|
| Normalized unique observations | 3,000–8,000 diagnostic inventory |
| Cheap title/location/employment preselection | 150–300 |
| Fully hydrated plausible roles | 50–80 |
| Hard-gate eligible | 30–45 |
| Freshness-eligible | 24–36 |
| Application-ready before score | 18–25 |
| Completely scored | 100% of ready pool |
| Strict-ready before caps | 12–14 when delivering 10 Strict |
| Final application-ready report | 10–15 routine; 15–20 strong days |
| User-selected resume packets | 7–10 |
| Manual applications | 5–8 |
| Roles selected for contact research | up to 8 |
| Qualified initial outreach drafts | 5–8 |
| Total new plus follow-up touches | no more than 10–12 |

### 5.2 Quality floors

- Normal shortlist score floor: 65.
- Scores 50–64: separately labeled shortage-only stretch section.
- Scores below 50: excluded from application-ready output.
- Original ATS/employer URL: required.
- Liveness `Active`: required.
- Complete JD snapshot or verified evidence package: required.
- Unknown experience: verification or abstention, never guessed.
- Guessed emails sent: zero.
- Duplicate or parallel cross-channel outreach sequences: zero.
- Unsupported resume claims: zero.

## 6. Target architecture

```text
SOURCE DISCOVERY
  → durable normalized candidates
  → cheap deterministic hard gates
  → provider-stratified candidate pools
  → evidence hydration and readiness repair
  → LLM seniority adjudication with abstention
  → Match Score
  → Conversion Score recomputation
  → suppression-aware, score-floored selection
  → local Markdown commit
  → mark surfaced only after commit
  → optional later Applications v5 transaction
  → user-owned Make Resume selection
  → incremental evidence-backed resume build
  → manual application
  → transactional monotonic lifecycle sync
  → top-role contact research
  → user approves person and channel
  → Gmail or LinkedIn draft
  → manual send confirmation
  → evidence-linked follow-up cadence
```

## 7. Workstream A — Daily orchestration and source truth

### A1. Propagate schedule and profile arguments

Problem:

- installed launchd commands pass morning or midday, mode, and Pune profile;
- `daily` ignores them;
- `runDailyNormal()` hardcodes morning, Normal, India.

Change:

- parse schedule, mode, and location preset in `crawler/cli.mjs`;
- pass values into `runDailyNormal()`;
- pass values into `runCrawlerOperator()`;
- use deterministic run identity by schedule and local date;
- make midday execute the declared lightweight plan;
- make health reporting use the same schedule identity.

Primary files:

- `crawler/cli.mjs`
- `crawler/daily-runner.mjs`
- `crawler/install-schedule.mjs`
- `crawler/scheduler.mjs`
- `crawler/schedule-health.mjs`
- `tests/crawler/discovery-profile.test.mjs`

Acceptance:

- `daily morning --mode normal --location-preset pune` executes morning/Normal/Pune;
- `daily midday ...` executes midday plan and excludes morning-only lanes;
- schedule health sees each run under its real schedule;
- repeated same schedule/date identity is idempotent.

### A2. Establish one production configuration

Problem:

- production and live-test config names and database paths are inverted or misleading;
- manual daily invocation defaults to dev while scheduled invocation selects production.

Change:

- designate one authoritative production config and database path;
- make scheduled and documented manual commands resolve to it explicitly;
- retain dev and test configs only for isolated fixtures and local rehearsal;
- validate production source inventory during startup;
- print selected config path and database path in every run receipt.

Primary files:

- `crawler/cli.mjs`
- `config/crawler-v2.json`
- `config/crawler-v2-live-test.json`
- `config/crawler-v2-dev.json`
- `CLAUDE.md`
- `docs/crawler-v2-operator-runbook.md`

Acceptance:

- one documented command reproduces scheduled configuration;
- production never writes to a path named `live-test.sqlite`;
- startup fails clearly on ambiguous or invalid environment mapping.

### A3. Replace fixed board slices with provider-stratified rotation

Problem:

- `slice(0, maxBoards)` repeatedly scans the same boards;
- board ordering starves Greenhouse, Lever, and curated India-first boards;
- separate warm scans duplicate requests.

Change:

- create priority classes:
  1. verified India/Pune boards;
  2. historically productive boards;
  3. due rotation boards;
  4. newly approved/probation boards;
- reserve provider quotas for Ashby, Greenhouse, and Lever;
- persist last-attempt and rotation cursor;
- report attempted and omitted board IDs/counts;
- remove duplicate crawler/tracked scans or partition them into non-overlapping sets;
- never silently omit a board because of cap order.

Primary files:

- `crawler/board-registry.mjs`
- `crawler/ats-warm.mjs`
- `crawler/daily-runner.mjs`
- `crawler/run.mjs`
- `config/board-registry.json`
- `config/crawler-v2.json`

Acceptance:

- every enabled warm board is attempted within a defined rotation window;
- each run includes India-first and all supported provider families;
- no board is fetched twice in one daily run;
- telemetry includes `boardsConfigured`, `boardsAttempted`, `boardsOmitted`, and omission reasons.

### A4. Preserve truncation progress

Problem:

- normally truncated batch sources discard the next cursor;
- first page or leading array slice repeats forever.

Change:

- preserve continuation state for normal truncation separately from interrupted-run recovery;
- restart newest-first sources from page zero only when provider semantics require it;
- rotate complete-array sources across stable windows;
- record total known inventory and records not examined.

Primary files:

- `crawler/ats-batch-1.mjs`
- `crawler/ats-batch-2.mjs`
- `crawler/ats-enterprise.mjs`
- `crawler/run.mjs`

Acceptance:

- capped providers expose different inventory across consecutive runs;
- newly posted rows remain visible under newest-first rules;
- telemetry distinguishes natural exhaustion from truncation.

### A5. Promote adapter failures into source state

Problem:

- adapters can return all-board failures without throwing;
- crawler records success or empty;
- final outcome may remain `ok` with real errors.

Change:

- standardize adapter result contract;
- derive source status from attempts, successes, failures, interruption, truncation, and output count;
- classify:
  - failures with candidates: degraded;
  - failures without candidates: failed;
  - no failures with no candidates: empty;
  - candidates without failures: ok;
- make final outcome degraded when any material source is degraded;
- preserve optional-lane semantics without hiding failure evidence.

Primary files:

- `crawler/run.mjs`
- `crawler/workflow.mjs`
- `crawler/daily-runner.mjs`
- all source adapters returning nested failure data
- `job-pull/normal-mode.mjs`

Acceptance:

- all-board timeout cannot produce healthy empty status;
- final output cannot say `ok` while carrying material source errors;
- source failure histogram reaches local report and canary.

### A6. Enforce transport contracts

Problem:

- default transport ignores redirect mode and response-size limits;
- resolver host and redirect controls are not fully forwarded;
- final URL and redirect evidence are unavailable.

Change:

- enforce redirect behavior, abort signal, timeout, response-size cap, and final URL reporting;
- forward `maxHosts`, `maxRequests`, `maxRedirects`, and `maxBytes`;
- reject cross-host redirects outside declared policy;
- include request count, final URL, and redirect chain in resolver telemetry.

Primary files:

- `crawler/operator.mjs`
- `crawler/original-listing-resolver.mjs`
- remote and search adapters using shared transport

Acceptance:

- redirect-reject and manual-redirect tests pass against default transport;
- oversized body is stopped before full buffering;
- resolver cannot exceed configured host/request limits.

### A7. Bound execution and add concurrency safely

Problem:

- sources and many board loops run serially;
- no whole-run deadline exists;
- configured worst-case request ceilings exceed schedule window.

Change:

- define whole-run deadline;
- add bounded cross-board concurrency where provider-safe;
- preserve per-host politeness and rate limits;
- pre-deduplicate remote/search candidates before resolution;
- stop low-priority lanes when deadline reserve is needed for hydration/scoring/delivery;
- report skipped work explicitly.

Acceptance:

- routine daily run completes under 45 minutes;
- no source can consume full schedule window alone;
- deadline exhaustion produces degraded receipt, not silent truncation.

## 8. Workstream B — Evidence, readiness, scoring, and selection

### B1. Deduplicate after preserving complementary evidence

Problem:

- winner-takes-all dedup discards richer JD, date, liveness, identity, and application evidence;
- global SimHash can collapse unrelated boilerplate-heavy jobs.

Change:

- require stronger identity compatibility before SimHash dedup;
- merge compatible loser evidence into winner using evidence-quality precedence;
- retain source provenance for every merged fact;
- preserve strongest provider Job ID and requisition identity;
- record merge/conflict decisions.

Primary files:

- `job-pull/dedup.mjs`
- `job-pull/candidate.mjs`
- `crawler/run.mjs`

Acceptance:

- thin direct row plus rich secondary row yields one rich candidate;
- unrelated employers cannot merge from boilerplate similarity alone;
- requisition-aware identity survives URL changes.

### B2. Run suppression on the actual final pool

Problem:

- `runPipeline()` suppresses one pool;
- Normal selects from pre-suppression `scoringCandidates`.

Change:

- expose one authoritative post-suppression candidate pool;
- score and select only that pool;
- route ambiguous historical collisions to verification;
- record newly delivered roles into cooldown only after delivery commit;
- keep permanent suppression for applied, contacted, interviewing, rejected, withdrawn, and offer states.

Primary files:

- `job-pull/run.mjs`
- `job-pull/normal-mode.mjs`
- `crawler/historical-suppression.mjs`
- opportunity-ledger adapters

Acceptance:

- actioned or cooldown role cannot appear in final shortlist;
- funnel suppression totals equal actual final-pool removals;
- failed delivery creates no surfaced/cooldown state.

### B3. Add generic readiness repair before scoring

Problem:

- scoring happens before application readiness;
- missing JD/original URL/liveness evidence causes most scored rows to be discarded;
- repair is Workday-specific.

Change:

- build bounded readiness repair stage for promising candidates;
- resolve original employer/ATS URL;
- hydrate JD text, location, employment, trusted date, requisition ID, and liveness;
- prioritize Strict, fresh, direct, and India/Pune-relevant candidates;
- maintain explicit repair queue for unresolved high-priority roles;
- run expensive scoring only after repair classification.

Primary files:

- `job-pull/normal-mode.mjs`
- `job-pull/normal-readiness.mjs`
- `crawler/original-listing-resolver.mjs`
- provider-specific hydration adapters

Acceptance:

- scorer pool contains ready or explicitly repairable rows only;
- every rejected readiness row has one or more named blockers;
- JD-absent direct roles receive bounded hydration opportunity before burial.

### B4. Replace regex-only seniority gate with an abstaining classifier

Problem:

- current parser confuses total professional, technology-specific, domain-specific, preferred, and unrelated year statements;
- model-only binary gate would create opaque false negatives.

Change:

- retain deterministic extraction as a signal;
- add model output:
  - `seniorityDecision`: eligible, ineligible, uncertain;
  - `requirementKind`: total-professional, technology-specific, domain-specific, preferred, ambiguous;
  - `minimumYears`;
  - exact `evidenceQuote`;
  - confidence;
  - reason code;
- validate quote as JD substring;
- apply deterministic postconditions;
- cache by JD fingerprint, prompt version, and model version;
- route uncertain rows to verification instead of silently deleting them.

Primary files:

- `job-pull/match-scorer.mjs`
- `config/match-score.schema.json`
- `job-pull/eligibility.mjs`
- `job-pull/normal-readiness.mjs`

Acceptance:

- explicit total-professional minimum three or more rejects;
- technology-specific three-year requirement does not automatically reject;
- ambiguous requirement follows conservative policy but remains visible;
- manually labeled gold set establishes false-positive and false-negative rates.

### B5. Repair Match Score safety

Required fixes:

- normalize manual `--scores-json` rows through same no-JD clamp and JS Auto-Suggest calculation;
- attach scorer failure reasons to candidates;
- isolate chunk files by run and remove stale output before spawn;
- require absolute executable binary path;
- treat spawn failure as broken scorer;
- choose failed-row or failed-chunk threshold and make code/spec agree;
- add whole-scoring deadline;
- include source kind, company stage/size evidence, run clock, and description-truncation metadata when available.

Primary files:

- `job-pull/match-scorer.mjs`
- `job-pull/normal-mode.mjs`
- `job-pull/run.mjs`
- `config/match-score.schema.json`
- `docs/spec/match-scoring.md`

Acceptance:

- no-JD row can never exceed 45 from any score source;
- Auto-Suggest is always JS-computed;
- concurrent runs cannot share chunk artifacts;
- every failed row retains exact reason code;
- real Codex canary succeeds against bounded real JDs before default activation.

### B6. Recompute Conversion Score after Match Score

Problem:

- Conversion Score is calculated before Match Score and can remain understated or mis-tiered.

Change:

- compute or recompute conversion factors after final Match Score;
- preserve raw inputs and derived score version;
- ensure final selection sees consistent Match and Conversion scores.

Acceptance:

- conversion tier changes when Match Score changes;
- output records score versions and inputs.

### B7. Enforce selection policy

Change:

- Strict Hot → Strict Active → Strict Backfill → Fallback Hot → Fallback Active → Fallback Backfill;
- preserve Strict identity for Backfill rows;
- normal score floor 65;
- stretch 50–64 separately labeled;
- below 50 excluded;
- maximum two roles/company;
- family diversity target applied when alternatives exist;
- Strict target reported as composition requirement, not silently ignored;
- company/family/cap exclusions named in reconciliation.

Primary files:

- `job-pull/normal-selection.mjs`
- `job-pull/normal-mode.mjs`
- `config/job-pull.json`

Acceptance:

- weak fallback cannot displace higher-quality Strict Backfill;
- all selection losses reconcile to named reasons;
- selected set meets company and family rules when inventory permits.

## 9. Workstream C — Delivery, application packets, and lifecycle

### C1. Commit local Markdown first

Change:

- create one atomic local daily report;
- include selected, stretch, verification, source-health, and shortfall sections;
- include machine-readable sidecar or embedded JSON receipt;
- write to temporary path, fsync/close, then atomic rename;
- mark jobs surfaced only after successful report commit;
- failed report write leaves novelty/cooldown untouched.

Suggested destination:

- `logs/daily/<YYYY-MM-DD>-launchpad.md`
- `logs/daily/<YYYY-MM-DD>-launchpad.json`

Acceptance:

- successful run always creates human-readable and machine-readable receipts;
- rerun with same run ID is idempotent;
- report failure does not consume jobs.

### C2. Add optional transactional Applications v5 delivery later

Change:

- only after local delivery canary passes;
- use one explicit durable transaction for Companies and Applications operations;
- retain local recovery receipt;
- execute only with explicit live-write authorization;
- never fall back to v3/v4;
- mark surfaced after local and configured external commit policy succeeds.

Acceptance:

- no partial application/company write is presented as success;
- recovery can resume or reconcile pending transaction;
- no external write occurs in default daily mode.

### C3. Persist immutable application identity and JD evidence

Each delivered application record must retain:

- canonical URL;
- original ATS URL;
- provider and Job ID/requisition ID;
- JD snapshot path or immutable body;
- JD SHA-256;
- captured-at timestamp;
- freshness evidence;
- liveness evidence;
- seniority decision and quote;
- readiness decision;
- scoring versions;
- source provenance.

Identity must not rely only on company, title, and location.

### C4. Assemble incremental resume runtime

Change:

- create one production command adapter around queue reader, authoring, compilation, verification, promotion, and state update;
- queue condition:
  - `Make Resume = true`;
  - Application Readiness = Ready;
  - non-terminal status;
  - artifact absent/stale or JD hash changed;
- use requisition-aware filenames;
- bounded concurrency two or three;
- use per-application scratch directories;
- add Building lease and stale recovery;
- persist PDF/source/matrix/provenance paths and hashes;
- promote final PDF only after all gates pass.

Primary files:

- `resume-v5/queue-reader.mjs`
- `resume-v5/resume-queue.mjs`
- `resume-v5/artifact-state.mjs`
- resume authoring/verification adapters
- `launchpad-v5.mjs`

Acceptance:

- unchanged Ready artifact does not rebuild;
- changed JD invalidates artifact;
- one failed build does not block entire queue;
- same-title requisitions cannot overwrite each other.

### C5. Strengthen resume truth verification

Problem:

- verifier-passed output contains unsupported CI-style release-gating claim;
- structural provenance validation does not prove semantic equivalence.

Change:

- integration work must not edit frozen template without explicit approval;
- builder must replace every tailorable default with approved evidence-backed content;
- flag existing affected tailored artifacts as requiring rebuild before use;
- add semantic provenance validation for each factual sentence/bullet;
- compare requirement matrix against immutable JD snapshot;
- record verifier version and artifact digest;
- require human exception review for semantic mismatch.

Acceptance:

- unsupported qualifier cannot pass using a valid-looking evidence locator;
- every delivered resume claim maps semantically to approved evidence;
- current affected artifact is not reused without rebuild.

### C6. Make lifecycle synchronization monotonic and transactional

Change:

- define allowed status transitions;
- `Applied?` sync never downgrades Interviewing, Offer, Rejected, Withdrawn, or Closed;
- reserve one durable transaction for application update, Activity creation, suppression update, and Sync Key;
- use event idempotency for Activity events;
- do not use permanent value-based dedup for mutable application state;
- retry incomplete suppression even when Activity already exists;
- propagate actual outcome to opportunity ledger.

Primary files:

- `resume-v5/application-sync.mjs`
- `resume-v5/suppression-adapter.mjs`
- `notion-v5/gateway.mjs`
- transaction journal code

Acceptance:

- repeated sync is idempotent;
- Interviewing cannot regress to Applied;
- failure after any step remains recoverable and visible;
- Activity, Application, suppression, and Sync Key reconcile exactly.

## 10. Workstream D — Contact research and outreach

### D1. Add production outreach queue normalization

Change:

- decode raw Applications, Outreach, Activity, Company, and Referrals pages into stable domain objects;
- require user-selected/application-ready input;
- include approved proof point, hook, resume artifact, original ATS, and company evidence.

Acceptance:

- real raw Notion rows produce same domain shape as fixtures;
- terminal or unready applications cannot enter outreach drafting.

### D2. Add free-first contact research adapters

Order:

1. hiring-post author evidence;
2. company team/recruiting page;
3. public professional profile;
4. public company email evidence;
5. paid enrichment only after explicit per-run approval.

Rules:

- default `allowPaid = false`;
- minimize data sent to any provider;
- no guessed emails;
- evidence must support identity, current role, and company relationship;
- evidence observation date required;
- return up to two candidates, one recommended primary;
- do not auto-select contact for drafting.

Primary files:

- `outreach-v5/research.mjs`
- `outreach-v5/evidence.mjs`
- new provider adapters

### D3. Add human contact-review gate

Review card must show:

- application;
- person;
- current role;
- why relevant;
- company relationship;
- evidence URLs and date;
- recommended channel;
- email evidence/status;
- confidence;
- prior person/company contact history.

Drafting begins only after user approves person and channel.

### D4. Repair outreach transactions and cadence identity

Change:

- one transaction for Outreach creation;
- one transaction for send confirmation across Outreach, Activity, and Application;
- one transaction for response/outcome stop state;
- add immutable Initial Sent At;
- add Activity → Outreach relation or duplicate key;
- prevent early or out-of-order follow-up confirmation;
- anchor Day 3, Day 10, and Day 17 to Initial Sent At;
- normalize raw Notion rows before cadence evaluation;
- enforce one active person/channel per application and company/person silence windows.

Primary files:

- `outreach-v5/workflow.mjs`
- `outreach-v5/cadence.mjs`
- `outreach-v5/idempotency.mjs`
- `notion-v5/schema.mjs`
- `notion-v5/gateway.mjs`

Acceptance:

- follow-up send never overwrites initial timestamp;
- Activity is attributable to exact Outreach sequence;
- partial send confirmation cannot leave inconsistent state;
- same person cannot receive parallel Email and LinkedIn sequences.

### D5. Add Gmail draft creation without sending

Change:

- create Gmail draft only after user approves contact and message;
- attach exact verified role-specific PDF;
- store Gmail draft ID and attachment digest;
- never call send;
- LinkedIn output remains copy-ready text, not browser automation.

Acceptance:

- Gmail draft contains correct recipient, subject, body, and exact PDF;
- no send-capable operation exists in default workflow;
- missing email remains missing and blocks email draft creation.

## 11. Telemetry contract

Every daily receipt must include:

### Source

- configured, attempted, succeeded, degraded, failed, omitted boards;
- raw rows, accepted observations, deduplicated unique jobs;
- truncation and records-not-examined;
- request count, duration, timeout, resolver success/failure;
- detail-hydration attempted/succeeded/failed/skipped;
- per-source newly actionable yield.

### Funnel

- normalized unique;
- cheap-gate pass/fail by first reason;
- hydration pool and outcomes;
- hard-gate eligible;
- freshness classes;
- readiness blockers;
- historical/opportunity suppressions;
- scorer attempted/scored/failed with reason histogram;
- score-floor exclusions;
- company/family cap exclusions;
- selected Strict/fallback/stretch counts;
- delivery commit status.

### Operations

- run ID and schedule;
- selected config and database paths;
- start/end/duration;
- deadline status;
- local report paths and hashes;
- external transaction status when explicitly enabled;
- surfaced-state commit count;
- unresolved reconciliation count.

No successful run may contain unattributed loss between eligible, ready, scored, selected, and committed.

## 12. Delivery phases

### Phase 0 — Emergency local recovery

Goal: produce useful roles before broad refactoring completes.

- build one-off local Markdown shortlist from current durable inventory;
- verify original URL, liveness, geo, freshness, and seniority evidence manually or with bounded adjudication;
- exclude known false positives;
- target strongest ten actionable roles;
- research people for top five roles manually;
- no live writes.

Exit gate:

- one truthful local report with at least ten actionable roles, or exact verified market/source shortfall.

### Phase 1 — Trustworthy discovery and selection

Includes Workstreams A and B plus local report commit.

Exit gate:

- seven consecutive shadow runs;
- no source outage reported healthy;
- no suppression bypass;
- no readiness/scoring unexplained loss;
- local report reliably produced.

### Phase 2 — Application packets and lifecycle

Includes Workstream C.

Exit gate:

- incremental build command works against real queue;
- semantic evidence gates pass;
- lifecycle sync is monotonic and transaction-safe;
- default remains local/no-write.

### Phase 3 — Reviewed outreach

Includes Workstream D.

Exit gate:

- five to eight qualified drafts/day possible;
- no guessed emails;
- no auto-selection of contact;
- no autonomous send;
- cadence and transaction tests pass against real row normalization.

### Phase 4 — Optional live v5 promotion

Requires separate explicit authorization.

Exit gate:

- bounded credentialed smoke;
- transaction recovery tested;
- local receipt remains authoritative recovery record;
- no legacy fallback.

## 13. Test plan

Required regression coverage:

1. Morning and midday profile propagation.
2. Production config/path resolution.
3. Provider-stratified board rotation across multiple runs.
4. No duplicate board fetch within one run.
5. Normal truncation continuation.
6. Adapter-returned total failure becomes failed lane.
7. Degraded source degrades final outcome.
8. Redirect and response-size enforcement under default transport.
9. Whole-run deadline and explicit skipped-work telemetry.
10. Workday fair cross-board hydration.
11. Workday failure does not erase stronger existing evidence.
12. Dedup merges complementary evidence.
13. SimHash cannot merge unrelated employers.
14. Opportunity suppression affects actual final selection pool.
15. Failed delivery creates no surfaced state.
16. Manual scores use no-JD clamp and JS Auto-Suggest.
17. Scorer chunk artifacts are run-isolated.
18. Spawn failure is classified as broken scorer.
19. Seniority classifier quote validation and abstention.
20. Conversion Score recomputes after Match Score.
21. Score floor, Strict Backfill ordering, family balance, and company cap.
22. Local Markdown atomic commit and idempotent rerun.
23. Requisition-aware identity and filenames.
24. Incremental resume queue and JD hash invalidation.
25. Unsupported semantic claim rejected despite valid sidecar shape.
26. Applied sync cannot downgrade advanced state.
27. Multi-row lifecycle transaction recovery.
28. Raw Notion outreach row normalization.
29. Paid provider disabled by default.
30. Human contact approval required before drafting.
31. Immutable Initial Sent At and exact Activity-to-Outreach association.
32. Out-of-order follow-up rejected.
33. Gmail draft attachment digest matches verified PDF.
34. No send operation reachable from outreach workflow.

All existing tests must remain green. Production promotion also requires real-child-process and bounded credentialed smoke tests; fixture-only rehearsal is insufficient.

## 14. Canary and promotion gates

### Seven-run engineering canary

Required before Phase 1 completion:

- zero fatal scorer infrastructure failures;
- zero source outages reported as healthy;
- zero selected suppressed roles;
- zero roles surfaced before delivery commit;
- zero duplicate requisition collisions;
- zero unattributed funnel loss;
- routine duration under 45 minutes;
- complete local report every valid run.

### Fourteen-day outcome shadow

Required before claiming daily reliability:

- median ready count at least 12;
- at least ten ready roles on ten of fourteen days;
- at least fifteen ready roles on four of fourteen days;
- median Strict-ready count at least eight;
- ten Strict claimed only when at least 12–14 pre-cap Strict-ready roles exist;
- 100% ready roles scored;
- less than 10% manual geo/seniority corrections;
- zero unresolved original URLs in final shortlist;
- zero unsupported resume claims;
- zero lifecycle regressions;
- zero guessed emails or unconfirmed sent-state changes.

Failure to meet volume gate is reported as inventory/source shortfall. It must not trigger weaker automatic policy.

## 15. Rollback and recovery

- Keep default mode local and no-write.
- Add new source behavior behind config flags until canary passes.
- Persist run-scoped receipts before mutable surfaced-state changes.
- Preserve previous config snapshots for rollback.
- Disable failing source lane independently without disabling full daily delivery.
- Treat pending external journal entries as explicit recovery work; never retry blindly.
- Do not delete historical crawler, ledger, Notion, resume, or outreach data as part of rollback.
- Do not overwrite frozen template or master resume.
- Rebuild, rather than mutate in place, any resume artifact invalidated by evidence changes.

## 16. Explicitly out of scope

- Auto-applying.
- Form submission automation.
- Browser automation for logged-in job portals.
- Automated LinkedIn actions.
- Automated email sending.
- Autonomous referral requests.
- v3/v4 migration, archive, deletion, or write fallback.
- Broadening onsite geography beyond Pune metro.
- Treating bare Remote as India-authorized.
- Relaxing total-professional three-year hard gate.
- Changing user-owned checkboxes.
- Production migration to a new tracker.
- Enabling commercial rescue by default.

## 17. Implementation ticket order

### P0 — Restore output

1. `DCO-P0-01`: local Markdown delivery and post-commit surfaced state.
2. `DCO-P0-02`: schedule/profile propagation and deterministic run identity.
3. `DCO-P0-03`: authoritative production config and run lock.
4. `DCO-P0-04`: provider-stratified board rotation and duplicate-scan removal.
5. `DCO-P0-05`: adapter failure propagation and truthful final outcome.
6. `DCO-P0-06`: suppression-aware final pool.
7. `DCO-P0-07`: readiness repair before scoring.
8. `DCO-P0-08`: scorer safety fixes and real bounded canary.
9. `DCO-P0-09`: score floor and Strict/family selection policy.
10. `DCO-P0-10`: reconciled funnel and source telemetry.

### P1 — Improve evidence yield

11. `DCO-P1-01`: dedup evidence merge and requisition-aware identity.
12. `DCO-P1-02`: fair Workday hydration and removal of destructive second pass.
13. `DCO-P1-03`: transport redirect/size/deadline enforcement.
14. `DCO-P1-04`: truncation continuation and provider-aware cursor semantics.
15. `DCO-P1-05`: bounded remote/search resolution and original-page hydration.
16. `DCO-P1-06`: one safe career-page adapter and verified active sources.
17. `DCO-P1-07`: seniority abstention classifier and labeled gold set.

### P2 — Application runtime

18. `DCO-P2-01`: immutable JD/application evidence packet.
19. `DCO-P2-02`: incremental production resume-builder assembly.
20. `DCO-P2-03`: semantic provenance verification and affected-artifact rebuild policy.
21. `DCO-P2-04`: monotonic transactional Applied/outcome sync.
22. `DCO-P2-05`: optional Applications v5 transaction after local canary.

### P3 — Outreach runtime

23. `DCO-P3-01`: outreach queue and raw Notion normalizers.
24. `DCO-P3-02`: free-first contact adapters and paid-default-off policy.
25. `DCO-P3-03`: contact-review gate and person/company suppression.
26. `DCO-P3-04`: transactional Outreach/Activity/Application state.
27. `DCO-P3-05`: immutable cadence anchor and sequence relation.
28. `DCO-P3-06`: Gmail draft and exact PDF attachment, no send.
29. `DCO-P3-07`: manual response reconciliation and filtered operational views.

## 18. Definition of done

This DCO is complete only when:

- one documented daily command runs the intended profile and configuration;
- source coverage rotates fairly and reports omissions;
- all material source failures are visible;
- every selected role passes suppression, readiness, liveness, original-link, seniority, freshness, and score rules;
- local report commits atomically before surfaced state changes;
- routine output is 10–15 ready roles, with 15–20 on verified strong-inventory days;
- user can select 7–10 roles and build incremental, truthful application packets;
- lifecycle sync is monotonic and transaction-safe;
- up to eight strong roles can receive evidence-backed contact research;
- five to eight reviewed drafts can be prepared without guessed emails or autonomous sending;
- seven-run engineering canary and fourteen-day outcome shadow pass;
- all tests pass;
- docs describe executed behavior rather than planned or fixture-only behavior.

## 19. Approval boundary

Approval of this DCO authorizes implementation planning and local code changes only.

It does not authorize:

- live Notion writes;
- Gmail OAuth setup or draft creation against a real account;
- paid contact enrichment;
- production schedule installation or replacement;
- browser automation;
- sending messages;
- changing the frozen resume template;
- deleting, archiving, or migrating data.

Each outward-facing or irreversible action requires separate explicit approval at execution time.
