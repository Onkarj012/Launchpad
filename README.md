# Job Search OS — README

Onkar Jadhav's job-search system: discover roles → score against targeting → tailor a resume → track in Notion. This file is the operator's guide — how to run it, how it's wired, and what's currently unreliable. For the rubric/targeting rules themselves, see `master_prompt.md`. For directory layout and identity, see `CLAUDE.md`.

## Quick start

Everything is **manual-trigger only** right now (no cron is configured — see Known limitations). Typical day:

```
/morning              → pull fresh jobs, present shortlist, surface due follow-ups
[you check Apply? on the rows you want, in Notion]
/make-applications     → tailors + compiles resumes for every Apply?-checked row (local only)
[you apply on the portal/email, then set Applied Date + Status=Applied in Notion]
/followups             → run later in the day / next day to see who needs a nudge
```

One-off commands:
- `/quick-add` — you found a role yourself, just log it.
- `/resume-latex` — tailor one resume against a pasted JD.
- `/resume-check` — brutal review of the resume `.tex` against a JD.
- `/application-agent` — full single-role workflow (research → fit → resume → optional cold email).

## Pipeline — what `/morning` and `/pull-jobs` actually do

```
Tracked scan       career-ops scan.mjs --dry-run --json
Reverse ATS        all public Greenhouse / Lever / Ashby / Workday directories, last 72h
Startup/public     YC + a16z seeds and dated remote/APAC feeds
Broad search       ATS domains + LinkedIn/Naukri/Wellfound/Instahyre/company careers
Watchlist          companies.json direct ATS JSON
Indeed             optional MCP adapter when connected; unavailable is reported
                         ↓
Normalize CandidateV1 with exact posting/source/geo/employment/experience evidence
                         ↓
API/feed liveness → URL/Job ID/Dedup Key/ledger/fingerprint dedup
                         ↓
Hard gates: Pune-metro onsite/hybrid; explicit India/APAC/global remote; paid; ≤72h
                         ↓
Strict (target title + 0–1 yr) vs shortage fallback (adjacent title and/or ≤2 yrs)
                         ↓
Score → max 2/company + role-family balancing
                         ↓
Strict Primary/Extended first, fallback separate → 15–20 curated when supply supports it
```

Full mechanical detail (dork templates, ATS endpoint URLs, dedup hash) lives in `.claude/skills/daily-job-pull/references/sourcing.md` — don't duplicate it here.

The low-level career-ops scanners run without an API key. `job-pull/` adds machine-readable normalization, strict geo/freshness policy, shortage fallback, diversity selection, source telemetry, and durable dedup. Full reverse ATS can be long-running and may degrade when public datasets or boards rate-limit; every run reports those gaps.

## Notion structure

- **Applications v4** (data source `7bc3de3a-91d9-4391-8b22-9e68b264e8d2`) — the tracker of record. Views: Today's Pull, To Apply, Follow-up Due, Pipeline (board), Archive.
  - **Today's Pull** is the one to open daily: filtered to `Date Pulled = today` (native Notion relative filter, self-refreshes — no manual reset needed), trimmed to 10 columns (Role, Company, Match Score, Freshness, Auto-Suggest, Hook, Location, Work Mode, JD Link, Apply?), sorted by Match Score. Only ever shows the latest pull, never stale rows.
  - **Default view** keeps all 35 properties but reordered decision-first (Role/Company/Score/Freshness/Status/Apply?/Hook.../JD Link) then progress fields, then sourcing/audit metadata last; first 2 columns frozen so Role/Company stay visible on scroll.
- **Companies** (`9cb28730-1c2e-4e81-bb54-4cb1ac4b3a1d`) — Name, Website, Size, Industry, relations to Applications/Outreach. No "stage" field (bigtech/mid/startup lives only in `companies.json`, not mirrored to Notion).
- **Activity** (`76a31def-a145-45db-9b82-0c263b80ab1b`) — dual-relation follow-up/interview/reply log, replaces ad-hoc tracking.
- **Outreach** (`bf40caf6-8b07-4c55-9d21-787b8033f454`) — cold-email log.
- v3 DB (`d8d525b0-e436-44b7-ae65-28c08a358684`) is archived read-only history — all open rows migrated into v4.

Full schema (every property + option) is in `NOTION_V4_SETUP.md`.

## Known limitations (read this before trusting a run)

1. **Notion can't be queried programmatically — confirmed, not guessable.** `notion-query-data-sources` (SQL + view mode) and `notion-query-database-view` both hard-fail with `This tool requires a Business plan or higher with Notion AI` on this workspace. This is a plan limit, not a bug — the only complete fix is upgrading to Notion Business with Notion AI. Until then, two things are already in place to route around it:
   - **Daily-pull dedup uses a local transaction ledger.** `career-ops/data/notion-written.tsv` is checked before writes; the new ledger helper migrates old rows and tracks pending/committed/aborted states so partial Notion failures remain visible. Because Notion cannot be queried comprehensively, stale pending records still require manual reconciliation.
   - **`/followups` and `/make-applications` now ask you directly** instead of pretending to query. `/followups` has you open the **Follow-up Due** view (it already carries the right filter natively when *you* open it — the block only applies to Claude's API access) and read off / paste what's listed. `/make-applications` has you name the rows you checked `Apply?` on from **To Apply** / **Today's Pull**. Neither will report "nothing due" / "nothing queued" from a guess anymore — only from what you confirm.
   - Cross-check anything that matters (e.g. before writing off follow-ups as clear) by looking at the Notion view yourself — Claude's view into Applied/Follow-up/Apply? state is only as current as what you've told it.

2. **No cron is configured.** `CronList` returns none — every pull so far has been manual, despite older docs implying a daily 07:00 IST cloud run. If you want automatic daily pulls, set one up via the `schedule` skill; it is not running today without that.

3. **No single source has complete recall.** The 57-company watchlist remains Greenhouse/Lever/Ashby-biased, but daily discovery now also attempts full reverse Greenhouse/Lever/Ashby/Workday directories, public/startup feeds, and broad India-board search. Darwinbox/Keka/custom portals may still depend on search-engine indexing. Indeed remains optional until its MCP is connected. Weekly five-link missed-alert audits measure the remaining gap. `internshala.com` stays excluded as stale/unreliable.

4. **Resume compilation is local-only.** `/make-applications` and `/resume-latex` need the Mac LaTeX toolchain (`pdflatex`) — they will not (and should not) run in a headless/cloud session.

5. **`career-ops/` is a vendored discovery library.** Job Search OS uses `scan.mjs`, `scan-ats-full.mjs`, `check-liveness.mjs`, `fingerprint-core.mjs`, `detect-reposts.mjs`, follow-up tooling, and user-layer config. Generic JSON/liveness patches may be overwritten by a career-ops update, so root compatibility tests must pass after updates. `career-ops/data/*` remains engine state/cache; Notion is the tracker of record.

## Guardrails (non-negotiable — see `CLAUDE.md` for the full list)

- No skill ever auto-checks `Apply?` or sends anything. `Auto-Suggest` is an opinion, not a command.
- Scheduled/cloud runs are discovery-only.
- Never fabricate experience, dates, salaries, or contacts — unknown fields stay blank or "Not Verified".
- `resumes/output/` holds PDFs only; `.tex` stays in `resumes/sources/`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/pull-jobs` returns very few results | Watchlist-bound gates killing everything — check the run summary's drop counts per gate/layer, not just the final count. |
| `/followups` says "nothing due" but you know something's overdue | Query-tool limitation above — open the Follow-up Due view in Notion directly to confirm. |
| A company 404s in `companies.json` | It's likely not on Greenhouse/Lever/Ashby. Don't hand-add a slug without curling the endpoint first (`.claude/skills/daily-job-pull/references/sourcing.md` § ATS endpoints) — the `_meta.verification` rule in `companies.json` exists because guessed slugs silently return nothing. |
| `/make-applications` fails to compile | Confirm you're running locally (not cloud) and `pdflatex` is on `PATH`. |
| Notion write fails on a field | Check `NOTION_V4_SETUP.md` for the live schema — don't assume a v3 field (e.g. `Company Stage`, `Auth-Friendly?`) still exists in v4. |
