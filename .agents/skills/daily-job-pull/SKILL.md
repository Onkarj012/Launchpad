---
name: daily-job-pull
description: Run the manual once-daily high-recall job discovery pipeline: tracked career-ops boards, full reverse Greenhouse/Lever/Ashby/Workday scan, free public job feeds and startup ecosystems, broad LinkedIn/Naukri/Wellfound/Instahyre/company-career WebSearch, the companies.json watchlist, and optional Indeed MCP when connected. Normalize, verify, dedup, gate, score, diversify, and write 15-20 curated roles to Notion with Strict matches separated from shortage fallback. Discovery only — never applies, checks Apply?, reads email, or uses computer-use browsing.
---

# Daily Job Pull

Manual once-daily discovery. Target 15-20 curated roles so Onkar can choose ~7-8 applications. Aim for at least 10 Strict roles when inventory supports it; state any shortfall. **No auto-apply, email ingestion, computer use, or auto-checked `Apply?`.**

## Source of truth

Read before every run:

1. `master_prompt.md` §§2-3 — targeting, hard gates, scoring.
2. `config/job-pull.json` — executable freshness, geo, fallback, quota, and diversity policy.
3. `references/sourcing.md` — query matrix, source reliability, ATS endpoints.
4. `companies.json` — curated watchlist.

`job-pull/` owns deterministic normalization, policy, dedup, selection, ledger, and audit. `career-ops/` remains a discovery/hygiene library; its `data/pipeline.md` is not the tracker.

## Required sources

Run each source once and record success/failure plus fetched/dated/eligible counts. A failed source is non-fatal, but never claim it ran.

1. **Tracked boards + public feeds** — from repo root invoke `node job-pull/run.mjs` or its tracked adapter, which calls `career-ops/scan.mjs --dry-run --json` from `career-ops/`. Configured providers include tracked company ATS boards and public remote feeds.
2. **Reverse ATS (tiered — warm daily, full weekly)** — `job-pull/run.mjs` drives `job-pull/reverse-warm-scan.mjs`. **Default (daily):** the warm scan hits only `config/reverse-warm-set.json` — the boards that have already produced an eligible match — in seconds, not the ~1hr a blind 13k-board crawl costs. **Weekly / on demand:** add `--reverse-full` to run the full Greenhouse/Lever/Ashby/Workday discovery crawl (delegates to `career-ops/scan-ats-full.mjs`) and auto-promote any newly-productive board into the warm set. Bootstrap or rebuild the warm set with `node job-pull/reverse-warm-scan.mjs --seed-from-history`. The warm set removes daily dependence on both the 13k crawl and the manual watchlist. Run a full pass when the warm set feels stale (no fresh hits for several days) or at least weekly.
3. **Startup ecosystems** — YC and a16z seeds run inside the `--reverse-full` pass (`scan-ats-full.mjs --seeds yc,a16z`); include other free/public feeds configured in `portals.yml` when their date and geo evidence is usable.
4. **WebSearch broad net** — execute every query family in `references/sourcing.md`: direct ATS domains, LinkedIn, Naukri, Wellfound, Instahyre, and untracked company career pages. Capture results as raw JSON records in a scratchpad, then run `node job-pull/public-search-prepare.mjs --in RAW --out PREPARED` and pass `--public-json PREPARED` to `run.mjs`; search snippets never prove liveness or eligibility by themselves. When Indeed MCP is connected, pass its raw results through the same prepare step and use `--indeed-json PREPARED`.
5. **Watchlist** — query every `companies.json` ATS slug once. Cache duplicate slug responses for this run.
6. **Indeed MCP, optional** — probe availability. When connected, run `search_jobs` for strict role families against Pune-metro and explicit India/APAC remote queries. When unavailable, log `source unavailable` and continue; never pretend it ran.
7. **Apify structured board pull, optional** — when `APIFY_TOKEN` is set, run `node job-pull/apify-pull.mjs --out RAW.json --config config/apify.json` (LinkedIn/Naukri/Wellfound/YC actors), then feed RAW.json through the normal `public-search-prepare.mjs` step. Per-actor failure is non-fatal. When `APIFY_TOKEN` is unset, log `source unavailable` and continue; never pretend it ran. See `references/sourcing.md`.

## Pipeline

1. **Prepare run.** Validate config. Capture one `runAt` timestamp. Refuse a second successful run on the same local date unless user explicitly requests a forced rerun.
2. **Discover.** Run required sources and normalize every result to CandidateV1. Consume JSON/manifests, not `career-ops/data/pipeline.md`, because markdown loses machine metadata.
3. **Enrich evidence.** Preserve exact `postedAt`, source/provider, job ID, work mode, location, employment/pay, experience requirement, description, and liveness evidence. Unknown stays null/`Not Verified`.
4. **Liveness.** Use current ATS/feed membership or `check-liveness.mjs --api-only --json`. Drop confirmed expired. Keep inconclusive as `Not Verified`; no Playwright/browser fallback.
5. **Dedup.** In order: canonical URL → provider+Job ID → normalized company/title/location → ledger → description fingerprint where available. Prefer ATS-direct > niche/public board > aggregator. Use `fingerprint-core.mjs`; `detect-reposts.mjs` is not universal SimHash clustering.
6. **Hard gates.** Apply all `master_prompt.md` gates. Never relax location authorization, paid status, liveness, or freshness.
7. **Freshness.** `Primary` ≤24h; `Extended` >24–72h. Reject older or undated candidates from curated output.
8. **Classify selection tier.** `Strict` = target role family and no hard requirement above 1 year. `Shortage Fallback` may use only approved adjacent title and/or hard requirement up to 2 years. A 3+ year hard minimum is rejected.
9. **Score all eligible candidates before final selection.** First run emits `scoringCandidates`. Apply `master_prompt.md` §3 to every one; write a temporary JSON array keyed by canonical URL with `matchScore`, `rationale`, `hook`, `responseLikelihood`, and `autoSuggest`. Re-run with `--scores-json <file>`. Never rank an unscored candidate above a scored candidate; if scoring fails, report degraded mode explicitly.
10. **Select deterministically.** Strict Primary → Strict Extended → Fallback Primary → Fallback Extended. Target 15-20 total, at least 10 Strict when inventory supports it. Max 2/company. Balance role families; aim for at least 4 families and no family above 40% when alternatives exist; relax only family-share cap when needed to reach volume, never company/hard gates.
11. **Preview.** Show selected rows and exact fallback reasons before live writes. Do not change live Notion schema without separate explicit approval.
12. **Write safely.** Reserve each row in transactional ledger → create Notion row → commit page URL; abort and report failed writes. `Apply? = unchecked`, `Status = Discovered`, `Resume Status = Not Started`.
13. **Summarize.** Report per-source counts, failures, freshness split, Strict count/target, fallback reasons, diversity counts, and fetched → dated → live/not-verified → gate-passing → deduped → selected → written.

## Presentation

Two separate sections:

- **Strict Matches — N / target 10**
- **Shortage Fallback — N** with `Relaxed: adjacent title`, `Relaxed: experience requirement is 2 years`, or both.

Each line: Role @ Company · work mode/location · exact freshness · role family · score · rationale · apply link.

## Rules

- Manual only for now. Do not create a schedule unless Onkar later asks.
- Onsite/hybrid: Pune metro only. Remote: explicit India/APAC/worldwide-with-India-ok only; bare `Remote` fails.
- Allow full-time and explicitly paid/stipended internships only.
- Unknown dates, salaries, experience, eligibility, or links stay blank/`Not Verified`; never invent.
- No email access, authenticated browser session, computer use, application submission, email sending, or contact action.
- Watchlist growth remains manual-policy controlled; this skill does not mutate `companies.json`.
- Keep full source links intact and clickable.
