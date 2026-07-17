---
name: morning
description: Manual once-daily morning job run. Executes tracked feeds + full Greenhouse/Lever/Ashby/Workday reverse discovery + public/startup sources + broad WebSearch + optional Indeed MCP + optional Apify structured board pull, then normalizes, verifies, dedups, gates, scores, diversifies, and logs 15-20 curated roles with at least 10 Strict when supply supports it. Presents shortage fallback separately, reminds user to choose 7-8, and surfaces follow-ups. Discovery only — never applies, checks Apply?, reads email, or uses computer-use browsing.
---

# Morning

Manual single entry point for daily discovery and follow-up surfacing. **No schedule by default. No auto-apply, auto-checked `Apply?`, email ingestion, computer use, or sending.**

## Source of truth

`master_prompt.md` §§2-3 and `config/job-pull.json` are authoritative. `daily-job-pull` owns discovery mechanics.

## Steps

1. **Check run state.** If a successful pull already exists for today's local date, show its summary and stop unless Onkar explicitly requests a forced rerun.
2. **Discover.** Invoke `daily-job-pull` end-to-end: tracked providers, the tiered reverse ATS scan (warm set daily; run `--reverse-full` weekly or when the warm set feels stale to refresh Greenhouse/Lever/Ashby/Workday and grow the warm set), startup/public feeds, broad WebSearch, watchlist, optional Indeed when connected, and the optional Apify structured board pull when `APIFY_TOKEN` is set (`node job-pull/apify-pull.mjs --out RAW.json --config config/apify.json` for LinkedIn/Naukri/Wellfound/YC, fed through the same prepare step; unset token → log `source unavailable`, never pretend it ran). For WebSearch, run the query matrix and collect raw JSON in a scratchpad, prepare it with `node job-pull/public-search-prepare.mjs --in RAW --out PREPARED`, then pass `--public-json PREPARED` to `run.mjs`. For connected Indeed MCP results, use the same prepare step and pass `--indeed-json PREPARED`.
3. **Curate.** Require exact freshness ≤72h; Primary ≤24h, Extended >24–72h. Apply liveness, geo, employment/pay, experience, dedup, score, company cap, and role-family balancing.
4. **Present Strict first.** Heading: `Strict Matches — N / target 10`. Each line: Role @ Company · work mode/location · freshness · family · score · rationale · link.
5. **Present shortage fallback separately.** Only when needed to approach 15-20 total. State exact relaxation: adjacent title, experience requirement up to 2 years, or both. Never relax geo/pay/liveness/freshness and never hide a strict shortfall.
6. **Show coverage summary.** Per-source fetched/dated/eligible/selected/failure counts; Primary/Extended split; Strict/fallback counts; gate/dedup/diversity drops; unavailable Indeed status.
7. **Hand off — do not act.** Tell Onkar: "Choose the 7-8 you want. Check `Apply?` on those rows in Notion, then run `/make-applications`." Never check it yourself.
8. **Surface follow-ups.** Invoke `followups` read-only. Draft nothing unless asked.
9. **Weekly audit prompt.** When seven days have elapsed since last coverage audit, ask Onkar for five missed alert URLs. Do not connect email.

## Rules

- Manual once daily for now. Add automation only when Onkar later asks.
- Target 15-20 curated rows, at least 10 Strict when inventory supports it; report truthful shortfalls.
- Onsite/hybrid must be Pune metro. Remote must explicitly permit India/APAC/worldwide-with-India-ok.
- Full-time and explicitly paid internships only.
- No posting older than 72h or lacking usable posting time enters curated output.
- Discovery + surfacing only. Resume compilation, applications, and outreach remain separate manual steps.
- Keep `Apply?` unchecked and links intact. Never fabricate missing data.
