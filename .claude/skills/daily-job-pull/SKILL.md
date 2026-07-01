---
name: daily-job-pull
description: Pull fresh job postings from ATS-domain search dorks, the companies.json watchlist's ATS JSON APIs, and Indeed fallback; dedup, gate, score against Onkar's targeting, and write the top matches into the Notion Applications database stamped with today's Date Pulled. Use whenever the user says "pull today's jobs", "find new jobs", "job refresh", "any new roles", "check Indeed", "what's open", "/pull-jobs", or otherwise asks to discover and log new openings. Trigger even when the user does not say "Indeed" or "Notion" explicitly.
---

# Daily Job Pull

Discover fresh roles across three sourcing layers, score them, and log the top 15-20 to the tracker. The user reviews and picks ~5-7 to pursue. **Nothing is applied to. No auto-apply, no auto-checked `Apply?`.**

## Source of truth
Read `master_prompt.md` (project root) before each run — it holds **Targeting**, the **Hard gates**, and the **Scoring Rubric** (§ 2-3). Do not hardcode targeting or weights here; edit them there. Read `companies.json` (project root) for the Layer 2 watchlist. Mechanical sourcing details (dork templates, ATS endpoint shapes, slug-parse rules, dedup hash) live in `references/sourcing.md` — load it before Step 1.

## Steps

1. **Layer 1 — discover.** For each (role term from `master_prompt.md` § Targeting) × (ATS domain) × (geo term), run the dork via `WebSearch` (templates in `references/sourcing.md` § Dorks). Parse every hit into `{company, role, location, url}` and extract `ats` + `slug` from the URL (`references/sourcing.md` § Slug parsing). These slugs are transient for this run only — do not write them to `companies.json`.
   *Done when:* every role term has been dorked against every ATS domain at least once, and every hit has a parsed slug or is discarded as unparseable.

2. **Layer 2 — watchlist fetch.** For every company in `companies.json`, GET its ATS JSON endpoint (`references/sourcing.md` § ATS endpoints). A 404 means a dead slug — log it, do not stop the run. Filter results to target titles + geo.
   *Done when:* every watchlist entry has been queried once (success or logged miss).

3. **Layer 3 — fallback.** Run Indeed MCP `search_jobs` once per role family. Tag every result `Source Rarity = Aggregator`.

4. **Merge + dedup.** Compute the `Dedup Key` hash for every candidate (`references/sourcing.md` § Dedup). On collision keep the best-rarity source (ATS-direct > Niche board > Aggregator) and its link. Drop any candidate whose `Job ID` or `Dedup Key` already exists in the Applications database.
   *Done when:* the candidate set has zero duplicate Dedup Keys and zero collisions with existing Notion rows.

5. **Hard gates.** Apply `master_prompt.md` § 2 Hard gates (location-auth, seniority, paid) to every survivor. Drop failures — never write them. Count drops per gate.

6. **Freshness tier.** A (<24h) / B (<3d) / C (<5d) by `Posted Date`; prefer the date from ATS JSON when present (most reliable). Older than 5 days → drop. Missing/relative date ("30+ days ago") → leave Posted Date blank, note "Not Verified", keep only if otherwise strong.

7. **Score.** Run `master_prompt.md` § 3 Scoring Rubric on every gate-survivor: 5-dimension weighted sum, one-line rationale, single strongest hook, `Auto-Suggest` boolean.

8. **Rank + cut.** Sort by score descending, keep the top 15-20. Log the cut count (fetched → dropped-by-gate → dropped-below-cutoff → written) for Step 10.

9. **Write rows** to Applications, one per surviving job: Role, Company (relation — create the Companies row if new), Location, Source, Source Rarity, Job ID, Dedup Key, JD Link (most-direct, params intact), JD Text, Posted Date, Date Pulled = today, Match Score, Response Likelihood, Freshness, Company Stage, Auth-Friendly?, Auto-Suggest, Positioning (the hook), Status = Researching, Apply? = unchecked, Resume Status = Not Started.
   *Done when:* every job from Step 8 has a Notion row with every field above populated or explicitly "Not Verified".

10. **Write run summary** to Notion (callout block on the Applications page or a log row): counts per layer fetched, dropped-by-gate, dropped-below-cutoff, written, auto-suggested.

11. **Present** the ranked list in chat (when run interactively): grouped by freshness tier, score descending, each row showing Role @ Company, location, freshness, score, one-line rationale, apply link.

## Rules
- Never invent salaries, dates, links, or experience. Unknown field → blank or "Not Verified".
- `Apply?` is **manual** — never auto-check it. `Auto-Suggest` is the cloud's opinion, not a command.
- Watchlist growth happens elsewhere: `companies.json` only gains an entry when a user `Apply?`-checks a row (see `master_prompt.md` § 6). This skill never writes to `companies.json`.
- Do not apply, email, or contact anyone. This skill only discovers, scores, and logs.
- Apply links stay intact and clickable.
- Cache each ATS board's JSON response for the duration of one run — don't refetch the same slug twice.
