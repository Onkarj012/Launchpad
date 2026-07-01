# Job Search OS — v3 Plan (Throughput + Multi-Source Sourcing)

Status: **APPROVED, BUILDING (2026-07-01).** Builds on `PLAN.md` (v1, built) and `PLAN_v2.md` (shortlist-rate fix, partial). v3 targets the bottleneck found in this round of grilling: **throughput** — only 5 applications were possible last week because finding + filtering jobs is slow and manual.

Companion: `master_prompt.md` (runtime rules) · `PLAN.md` (v1) · `PLAN_v2.md` (v2).

---

## 0. Diagnosis (this round)

- ATS-resume parse leak (v2's main finding) is **mostly solved** (`Master_Resume_ATS.tex`).
- Real current bottleneck = **volume of applications**. 5/week, not for lack of fit but lack of throughput: job discovery is manual and single-source (Indeed), and the daily list is small.
- Resume compile is **NOT** a bottleneck (user builds 5 resumes in <5 min).
- Master metric = **shortlists + interviews booked**, not apps sent or jobs found.
- "All types of jobs/companies" = **company-stage variety** (big tech / mid / startup), NOT widening role types. Roles stay the existing targets in `master_prompt.md`.

---

## 1. Decisions Locked (v3 grilling)

| # | Decision |
|---|---|
| Scope of "all types" | Company **stage** variety (big tech / mid-size / startup). Role targets unchanged. |
| Master metric | Shortlists + interviews. Everything optimizes for response likelihood, not raw count. |
| Sourcing model | **3 layers**: (1) ATS-domain Google dorks = discovery primary, (2) ATS JSON APIs = structured fetch for a watchlist, (3) Indeed/aggregator = fallback breadth. |
| Watchlist | **Seed-generated** (b) + **auto-grow** (c): every `Apply?`-checked company's slug is appended to the watchlist. No hand-maintained 80-slug list. |
| Dedup | Normalized `company + title + location` hash. Keep the freshest / most-direct (ATS-direct > aggregator) source link. |
| Shortlist gates | **Hard gates**: location-auth + seniority (≤2 yr) + paid. Everything else = soft score. |
| Scoring | 5 dimensions, v2 reweight: Skill 35 · Domain 20 · Seniority 15 · Location 10 · **Response Likelihood 20** (sums 100). |
| Daily output | Fetch many → score all → keep **top 15-20** by pure score. User reviews, picks **5-7** to apply that day. |
| Notion stage view | Secondary lens: board grouped by company stage. Primary sort still pure score. |
| Auto-Suggest | Cloud sets an `Auto-Suggest` flag (its pick opinion: high score + fresh + good response-likelihood). User confirms by checking `Apply?`. Never auto-applies, never auto-checks `Apply?`. |
| Execution split | **Cloud** = fetch + score + dedup + write Notion + Notion summary (no Mac needed). **Local** = resume making (LaTeX, Mac-only) on `/` trigger. |
| Triggers | Cloud **cron** 7:00 AM IST (daily pull) + local `/pull-jobs` (manual same logic) + local `/make-applications` (batch resumes for `Apply?`-checked). |
| Cron auth fallback | If headless MCP auth (Notion/Indeed/Apify) doesn't hold in cloud, fall back to "fires when a reachable session exists." Verify on first run. |
| Summary channel | **Notion only.** No push, no email. |

---

## 2. Sourcing Architecture (the core of v3)

### 2.1 Layer 1 — Discovery via ATS-domain Google dorks (primary)

Goal: find fresh postings across the **whole web** without a company list, while staying scam-free (results are restricted to real ATS domains, so every hit is a direct apply page).

**Mechanism:** run dorked search queries through (a) the Apify Google-search/Google-jobs actor and (b) `WebSearch`. One query per (role family × ATS domain × geo). Parse results into `{company, role, location, url, posted_hint}`.

**ATS domains to restrict to:**
- `boards.greenhouse.io`
- `jobs.lever.co`
- `jobs.ashbyhq.com`
- (later, optional) `*.workable.com`, `*.recruitee.com`, `apply.workable.com`

**Query template:** `site:<ats-domain> "<role term>" (<geo terms>) <recency hint>`

Role terms (from `master_prompt.md` § Targeting): `AI engineer`, `LLM engineer`, `machine learning engineer`, `full stack engineer`, `backend engineer python`, `software engineer new grad`.

Geo terms: `Pune OR "remote India" OR "remote, India" OR India`.

Recency: prefer search tools' past-24h/past-week filter where available; otherwise rely on Layer-3 freshness parsing + the `Posted Date` from the JD page.

**Example queries:**
```
site:boards.greenhouse.io "AI engineer" (Pune OR "remote India")
site:jobs.lever.co "machine learning engineer" India
site:jobs.ashbyhq.com "software engineer" "new grad" India
site:boards.greenhouse.io "backend engineer" python (Pune OR remote India)
```

**Slug auto-resolution (kills v2's slug pain):** every dork hit's URL already contains the company slug:
- Greenhouse: `boards.greenhouse.io/<slug>/jobs/<id>` → slug = path segment 1
- Lever: `jobs.lever.co/<slug>/<id>` → slug = path segment 1
- Ashby: `jobs.ashbyhq.com/<slug>/<id>` → slug = path segment 1

Parse the slug from each URL and add to `companies.json` (see 2.4). This is how the watchlist grows for free.

### 2.2 Layer 2 — Structured fetch via ATS JSON APIs (watchlist, day-0)

For every company slug in the watchlist, hit the public board JSON directly. This is the most reliable, day-0, fully-structured source (clean title, location, department, posted date, apply URL).

**Endpoints:**
- Greenhouse: `https://boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true`
- Lever: `https://api.lever.co/v0/postings/<slug>?mode=json`
- Ashby: `https://api.ashbyhq.com/posting-api/job-board/<slug>` (POST or GET per their posting API)

Fetch all, filter to target role titles + geo, then hand to dedup + scoring. Layer 2 catches roles that don't surface in search yet (search indexing lags; ATS JSON is instant).

### 2.3 Layer 3 — Aggregator fallback (Indeed / Apify Indeed)

Keep the existing Indeed MCP (`search_jobs`) and any Apify Indeed actor as a **breadth fallback**, lowest source-rarity rank. Used to catch companies not on ATS (still many mid/large cos use Indeed-only or Workday). Mark these `Source Rarity = Aggregator` so scoring's Response Likelihood can dock them slightly (flooded posts → lower reply rate).

### 2.4 Watchlist file — `companies.json`

New file at project root. Schema:
```json
{
  "companies": [
    {
      "name": "Acme AI",
      "stage": "startup",            // startup | mid | bigtech
      "ats": "greenhouse",          // greenhouse | lever | ashby
      "slug": "acmeai",
      "source": "seed",             // seed | auto-grow | manual
      "added": "2026-07-01",
      "last_seen_role": "AI Engineer"
    }
  ]
}
```
- **Seed:** generated this build — ~40-60 AI/full-stack companies hiring in Pune / remote-India across all three stages. User prunes.
- **Auto-grow:** when a row is `Apply?`-checked, resolve that company's ATS+slug (from its JD URL) and append with `source: "auto-grow"` if absent.
- Dedup the file on `(ats, slug)`.

### 2.5 Dedup (cross-source)

A job can appear in all three layers. Canonical key:
```
hash = normalize(company) + "|" + normalize(title) + "|" + normalize(location)
normalize = lowercase, strip punctuation, collapse whitespace, drop "(remote)"/seniority noise
```
- On collision, keep the row whose source has the **best rarity**: ATS-direct > Niche board > Aggregator. Replace the JD link with the most-direct one.
- Also still skip anything whose original `Job ID` already exists in Notion (carry-over from v1).
- Store the hash in a new `Dedup Key` Notion field for cross-run dedup.

---

## 3. Scoring (master_prompt.md § 3 rewrite)

**Hard gates (run first; fail any → drop, never written):**
1. Location-auth: in-person/hybrid must be Pune; remote must be India-eligible / global-with-India-ok. Onsite-abroad → drop.
2. Seniority: hard requirement of 3+ yrs → drop.
3. Paid: unpaid / equity-only / commission-only → drop.

**Soft score (0-100), weighted sum:**
| Dimension | Weight | Measures |
|---|---|---|
| Skill match | 35 | JD required skills ∩ stack (Python, TS, React/Next, FastAPI, RAG, agentic, ML, pgvector…) |
| Domain / role relevance | 20 | Work is AI/ML/backend/full-stack vs off-target |
| Seniority fit | 15 | Entry/fresher friendly = high |
| Location / remote fit | 10 | Remote-India / Pune / hybrid = high |
| **Response Likelihood** | 20 | small-co (<200) + posted <48h + ≥70% skill match + ATS-direct source = high; big-co + stale + aggregator = low |

**Per job output:** integer 0-100 + one-line rationale + single strongest **hook** (→ Positioning) + `Auto-Suggest` boolean.

**Auto-Suggest rule:** `score ≥ 80 AND freshness ∈ {A,B} AND ResponseLikelihood-subscore ≥ 14/20`.

**Keep top 15-20** by pure score after gates. Log how many were dropped (gates + below cutoff) in the run summary.

---

## 4. Notion changes (Applications DB)

Add fields (extends v1 schema in `PLAN.md` § 3.1):
| Prop | Type | Notes |
|---|---|---|
| `Company Stage` | Select | Startup / Mid / Big Tech |
| `Source Rarity` | Select | ATS-direct / Niche board / Aggregator |
| `Response Likelihood` | Number | 0-20 sub-score |
| `Auth-Friendly?` | Select | Remote-global / India-based / Visa-only / No |
| `Auto-Suggest` | Checkbox | cloud's pick opinion; user confirms via `Apply?` |
| `Dedup Key` | Text | normalized hash for cross-run dedup |

Views:
- **Today** (default, existing) — table, `Date Pulled is Today`, sort Match Score desc.
- **Auto-Suggested** (new) — filter `Auto-Suggest = true` AND today, sort score desc. The morning shortlist.
- **By Stage** (new) — board grouped by `Company Stage` (the secondary lens).
- Existing Pipeline / Resume Queue / All Jobs unchanged.

---

## 5. Skills — detailed specs

### 5.1 `daily-job-pull` (rewrite)

**Trigger:** "pull today's jobs", "find new jobs", "job refresh", + cron + `/pull-jobs`.

**Reads:** `master_prompt.md` (targeting + rubric), `companies.json` (watchlist).

**Steps:**
1. **Layer 1 — Discovery.** For each (role term × ATS domain × geo), run the dork via Apify Google actor + `WebSearch`. Collect hits. Parse `{company, role, location, url}`; extract `ats` + `slug` from URL. Discovered slugs go into a **transient set for this run only** — they do NOT auto-join the permanent watchlist. Only `Apply?`-checked companies graduate to `companies.json` (`source: auto-grow`), keeping the watchlist high-signal.
2. **Layer 2 — Watchlist fetch.** For each company in `companies.json`, GET its ATS JSON endpoint. Filter to target titles + geo.
3. **Layer 3 — Fallback.** Indeed MCP `search_jobs` per role family. Tag `Source Rarity = Aggregator`.
4. **Merge + dedup** on `Dedup Key` hash; keep best-rarity source link; drop any existing `Job ID`/`Dedup Key` already in Notion.
5. **Hard gates** — drop fails (don't write). Count drops.
6. **Freshness tier** — A (<24h) / B (<3d) / C (<5d); older → drop. Pull `Posted Date` from ATS JSON when present (most reliable).
7. **Score 0-100** per § 3. Compute `Response Likelihood` sub-score + `Auto-Suggest`.
8. **Rank by pure score, keep top 15-20.**
9. **Write rows** to Applications: Role, Company (+ stage), Location, Source, Source Rarity, Job ID, Dedup Key, JD Link (most-direct), JD Text, Posted Date, Date Pulled = today, Match Score, Response Likelihood, Freshness, Auth-Friendly?, Auto-Suggest, Positioning (hook), Status = Researching, Apply? = unchecked, Resume Status = Not Started.
10. **Write Notion run-summary** (a callout block or a log row): counts per layer, total fetched, dropped-by-gate, dropped-below-cutoff, written, auto-suggested. (No push/email.)
11. **Present ranked list** in chat (when run interactively), grouped by freshness, score desc, with apply links.

**Rules:** never invent fields; `Apply?` always manual; never apply/email/contact; links intact; respect source rate limits (cache board JSON per run).

### 5.2 `make-applications` (new, local-only)

**Trigger:** "make applications", "build resumes for today", `/make-applications`.

**Purpose:** batch-tailor resumes for the 5-7 the user `Apply?`-checked. LaTeX = Mac-only, so this never runs in cloud.

**Steps:**
1. Query Applications for rows where `Apply? = true` AND `Resume Status = Not Started`.
2. For each, run the `resume-latex` logic: read JD → pick 2 projects by keyword overlap → fill `Master_Resume_ATS.tex` swap zones (title/summary/skills) → compile → `pdftotext` parse-verify (email + phone + ≥N skill keywords present) → assert page rules.
3. Output `Resumes/Tailored/Resume_Onkar_<Company>_<Role>_<YYYYMMDD>.{tex,pdf}`; copy PDF to Drive-synced folder.
4. Update each row: `Resume Status = Tailored`, `Resume PDF` = Drive link.
5. Report a checklist: company, role, apply link, resume path — the user's apply queue for the day.

**Rules:** ATS-clean template only for portal applies; never fabricate; parse-verify gate before "done."

### 5.3 `application-agent` (light update)

- Keep as orchestrator. Update to know about `Auto-Suggest` (surface those first) and to call `make-applications` for the checked set.
- Outreach/referral stage stays as specced in v2 but is **out of scope for this build** (deferred).

### 5.4 `resume-latex` (small update)

- Point default template to `Master_Resume_ATS.tex` (ATS-clean), not the old `multicol` master.
- Add the `pdftotext` parse-verify guard (v2 TODO): after compile, assert email + phone + ≥N skill keywords survive raw text extraction before declaring done.

---

## 6. Cron / remote trigger

- **Routine:** scheduled cloud agent, `0 1 * * *` UTC = **07:00 IST** wait — 07:00 IST = 01:30 UTC. Use cron `30 1 * * *` UTC.
- **Action:** run `daily-job-pull` (Layers 1-3 → score → write Notion → Notion summary). No local files touched.
- **Auth:** needs Notion + Indeed + Apify MCP reachable headless. **First-run check:** confirm the routine can call these without interactive auth. If it can't, fall back to a persistent-session trigger that fires when a reachable session exists.
- **Summary:** Notion run-summary block only.
- **`/pull-jobs`** local command = identical logic, manual, for ad-hoc pulls.

---

## 7. Build Sequence

1. ⬜ Seed `companies.json` (~40-60 cos across stages; user prunes).
2. ⬜ Rewrite `daily-job-pull` skill — 3-layer sourcing, slug parse, dedup hash, hard gates, 5-dim scoring + Auto-Suggest, top-20, Notion write + summary.
3. ⬜ Add Notion fields (Company Stage, Source Rarity, Response Likelihood, Auth-Friendly?, Auto-Suggest, Dedup Key) + Auto-Suggested + By Stage views.
4. ⬜ Update `master_prompt.md` § 2-3 — hard gates, reweight, source list, Auto-Suggest rule.
5. ⬜ Build `make-applications` skill (local resume batch).
6. ⬜ Update `resume-latex` (ATS template default + parse-verify guard) and `application-agent` (Auto-Suggest awareness).
7. ⬜ Create cron routine (30 1 * * * UTC) + verify headless auth; add `/pull-jobs` command.
8. ⬜ Dry run: pull → verify fresh ATS-direct + aggregator rows deduped + scored + Auto-Suggested → check 5-7 → `make-applications` → resumes + Drive links → confirm apply queue.

---

## 8. Open Confirms

- `companies.json` seed list — generate then user prunes (no blocker).
- ATS API rate limits / occasional 404 on dead slugs — accept misses, log, prune dead slugs periodically.
- Ashby posting API exact request shape — verify at build (GET vs POST).
- Drive-synced folder absolute path — reuse v1's (`master_prompt.md` § 7 pointers / PLAN.md § 5).
- Headless MCP auth in cloud cron — verify on first run; fallback ready.

---

## 9. Out of Scope (v3)

- Referral / cold-email outreach stage (specced in v2 § E; deferred).
- Auto-apply / auto-check `Apply?` (always manual).
- Workday / Workable / Recruitee adapters (add later if ATS-3 coverage too thin).
- Role-type widening beyond existing targets.
