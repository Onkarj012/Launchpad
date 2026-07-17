# Notion v4 — build reference (built and live)

> Applications v4 and Activity are built and confirmed reachable in Onkar Jadhav's Space
> (workspace `64f5c2b5-d1b0-813e-b307-00030b502680`). Data source IDs are recorded in
> `master_prompt.md` §7. This file stays as the schema/build reference — re-run it only
> if the DBs need to be rebuilt from scratch.
>
> **Known plan limitation:** `notion-query-data-sources` (SQL + view mode) and
> `notion-query-database-view` all require a Notion Business plan with Notion AI — this
> workspace is on a lower plan, so Claude cannot programmatically filter/query rows (e.g.
> "rows due for follow-up", "rows with Apply? checked"). Reading structured data falls back
> to `notion-search` (semantic, imprecise) or the user opening a view directly in Notion.
> See `README.md` § Known limitations.

## What to build (execute top-to-bottom once connected)

### 0. Preflight
1. `notion-fetch id=self` → confirm workspace is Onkar's (not Shreya's).
2. Fetch Job Search page `3885c2b5d1b081458df2c68954540105` → confirm existing DBs:
   - Applications data source: `d8d525b0-e436-44b7-ae65-28c08a358684`
   - Companies data source: `9cb28730-1c2e-4e81-bb54-4cb1ac4b3a1d`
   - Outreach data source: `bf40caf6-8b07-4c55-9d21-787b8033f454`

### 1. Create "Applications v4" database (parent = Job Search page)
Properties:
| Property | Type | Options |
|---|---|---|
| Role | title | |
| Company | relation | → Companies data source `9cb28730-…` |
| JD Link | url | |
| Job ID | rich_text | |
| Dedup Key | rich_text | |
| Fingerprint | rich_text | SimHash from detect-reposts |
| Source | select | scan.mjs:blue, Dork:purple, Watchlist:green, Indeed:orange, Manual:gray |
| Source Rarity | select | ATS-direct:green, Niche board:yellow, Aggregator:orange |
| Posted Date | date | |
| Date Pulled | date | |
| Freshness | select | A (<24h):green, B (<3d):yellow, C (<5d):orange |
| Liveness | select | Active:green, Expired:red, Not Verified:gray |
| Liveness Checked | date | |
| Match Score | number | 0–100 |
| Rationale | rich_text | one line |
| Hook | rich_text | strongest resume/email lead |
| Response Likelihood | number | 0–20 sub-score |
| Auto-Suggest | checkbox | opinion only, never a command |
| Experience Asked | rich_text | |
| CTC/Salary | rich_text | verbatim from JD or blank |
| Apply? | checkbox | MANUAL ONLY — no automation ever checks it |
| Status | select | Discovered:gray, Shortlisted:blue, Resume Ready:purple, Applied:green, Followed Up:yellow, Responded:orange, Interview:pink, Offer:green, Rejected:red, Dropped:brown |
| Priority | select | High:red, Medium:yellow, Low:gray |
| Resume Status | select | Not Started:gray, Tailoring:yellow, Ready:green, Sent:blue |
| Resume PDF | rich_text | path in resumes/output/ |
| Applied Date | date | |
| Applied Via | select | Portal:blue, Email:purple, Referral:green |
| Next Follow-up | date | |
| Follow-up Count | number | |
| Last Activity | date | |
| Location | rich_text | |
| Work Mode | select | Remote:green, Hybrid:yellow, Onsite:orange |
| Notes | rich_text | |
| JD Text | rich_text | |

#### Proposed additive discovery-audit fields — not applied yet

These fields support the high-recall daily pull. Adding them to live Applications v4 requires separate explicit approval and a one-row smoke test; existing fields/views stay intact.

| Property | Type | Options / purpose |
|---|---|---|
| Posted At | date with time | Exact timestamp used for freshness |
| Freshness Hours | number | Age at the captured run time |
| Freshness Window | select | Primary ≤24h, Extended 24–72h |
| Selection Tier | select | Strict, Shortage Fallback |
| Relaxations | multi_select | Adjacent Title, Experience ≤2 years |
| Role Family | select | AI/LLM, ML, Backend, Full-stack, SWE, Paid Internship, Adjacent |
| Employment Type | select | Full-time, Paid Internship |
| Eligibility Evidence | rich_text | Concise geo/pay/experience evidence |
| Run ID | rich_text | Idempotency and run audit |
| Source Provider | select | Greenhouse, Lever, Ashby, Workday, Public Search, Indeed, other feed |

Until approved, these values remain in local run manifests and may be summarized in existing `Notes`; no live schema mutation is automatic.

### 2. Create "Activity" database (parent = Job Search page)
| Property | Type | Options |
|---|---|---|
| Name | title | e.g. "Follow-up #1 — Stripe" |
| Application | relation | → Applications v4 data source (DUAL, synced "Activity") |
| Type | select | Applied:green, Follow-up:yellow, Reply:blue, Interview:pink, Thank-you:purple, Note:gray |
| Date | date | |
| Due | date | |
| Done | checkbox | |
| Notes | rich_text | draft text / links |

### 3. Views (Applications v4)
| View | Type | Config |
|---|---|---|
| Today's Pull | table | FILTER "Date Pulled" = today; SORT "Match Score" DESC |
| To Apply | table | FILTER "Apply?" checked AND "Resume Status" != Ready |
| Follow-up Due | table | FILTER "Next Follow-up" <= today AND Status in (Applied, Followed Up) |
| Pipeline | board | GROUP BY "Status" |
| Archive | table | FILTER Status in (Rejected, Dropped, Offer) |

Activity DB: one "Due" view — FILTER Done unchecked AND Due <= today, SORT Due ASC.

### 4. Migrate open rows from old Applications (`d8d525b0-…`)
- Query all rows where Status not in (Rejected, Dropped/Discarded, SKIP).
- Map old fields → v4 (same-name fields copy over; Status mapping: Researching→Discovered;
  new fields blank/Not Verified). Never fabricate values.
- Old DB: rename to "Applications (v3 archive)" — do NOT delete.

### 5. Stitch IDs
- Write both new data source IDs into `master_prompt.md` §7 (replace the TBD pair).
- Sanity: run `/quick-add` dry pass or one manual row create to verify schema accepts writes.

## Guardrails (apply during build)
- Never delete or overwrite the existing DBs; archive rename only, after migration verified.
- `Apply?` manual only. No auto-apply. Auto-Suggest is an opinion.
- Unknown values → blank or "Not Verified", never invented.
