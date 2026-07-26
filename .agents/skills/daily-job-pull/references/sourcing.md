# Sourcing reference — daily-job-pull

Mechanical source and query detail. Targeting/scoring lives in `master_prompt.md`; executable values live in `config/job-pull.json`.

## Source order and trust

1. Direct ATS/company feed: Greenhouse, Lever, Ashby, Workday.
2. Curated public/niche feed: startup and remote/APAC boards.
3. Broad board/search result: LinkedIn, Naukri, Wellfound, Instahyre, Indeed.

Collision precedence: `ATS-direct > Niche/public board > Aggregator`. Prefer a source with exact `postedAt`, conclusive liveness, stable Job ID, and complete JD.

## Reverse ATS discovery (tiered)

No ATS vendor publishes a global "recently posted" feed, so discovering a new posting means fetching a board's JSON. Blindly fetching all ~13k public boards every run costs ~1hr and throws away 99.9% of the work — historically only ~14 boards ever produce a Pune/India-remote-eligible match. So the scan is tiered:

**Daily (default) — warm scan.** Fetches only `config/reverse-warm-set.json`, the boards that have already yielded an eligible match. Seconds, not an hour.

```bash
node job-pull/reverse-warm-scan.mjs --since 3 --json        # standalone
node job-pull/run.mjs --dry-run --no-notion                 # inside the pipeline (warm by default)
```

**Weekly / on demand — full discovery.** Runs the blind Greenhouse/Lever/Ashby/Workday crawl (delegates to `career-ops/scan-ats-full.mjs`, `--seeds yc,a16z` included) and auto-promotes any newly-productive board into the warm set. Run it weekly, or sooner if the warm set has gone several days with no fresh hits.

```bash
node job-pull/reverse-warm-scan.mjs --full --promote --json  # standalone
node job-pull/run.mjs --dry-run --no-notion --reverse-full   # inside the pipeline
```

**Bootstrap / rebuild the warm set** from the added-URL log:

```bash
node job-pull/reverse-warm-scan.mjs --seed-from-history
```

Both modes emit the identical `--json` contract the `reverse-ats` adapter consumes. Record stale/unavailable datasets and unreachable board counts.

Public directory source (full mode only): `github.com/Feashliaa/job-board-aggregator`. Treat as mutable external data; host/slug validation in `scan-ats-full.mjs` and the SSRF host check reused by `warm-set.mjs` remain mandatory.

## WebSearch query matrix

Run each strict role family against each source family and both geo families. Use recency filtering where supported.

### Capture contract

Capture raw records with `link`/`url`/`jobUrl`, `company`/`org`, and `title`/`position` fields.
Run `node job-pull/public-search-prepare.mjs --in RAW --out PREPARED`; it converts dates and skips invalid records.
Pass the prepared file to `run.mjs` as `--public-json PREPARED` (or `--indeed-json PREPARED` for Indeed MCP output).

### ATS domains

- `boards.greenhouse.io` and `job-boards.greenhouse.io`
- `jobs.lever.co`
- `jobs.ashbyhq.com`
- `myworkdayjobs.com`

Templates:

```text
site:<ats-domain> "<role term>" ("Pune" OR "Hinjawadi" OR "Pimpri-Chinchwad")
site:<ats-domain> "<role term>" ("remote India" OR "India remote" OR APAC OR worldwide)
```

### Broad India/startup boards

- `linkedin.com/jobs`
- `naukri.com`
- `wellfound.com`
- `instahyre.com`
- `cutshort.io` (also covered structurally via the `cutshort` Apify actor below — WebSearch is the fallback when `APIFY_TOKEN` is unset)
- `peerlist.io/jobs` — no Apify actor exists for this; WebSearch/direct-browse only
- `hirist.tech` (also covered via the `hirist` Apify actor)
- untracked company career pages: `"careers" OR "we're hiring"`

Templates:

```text
site:<board> "<role term>" (fresher OR "new grad" OR graduate OR "0-1 year" OR internship) (Pune OR Hinjawadi OR PCMC)
site:<board> "<role term>" (fresher OR "new grad" OR graduate OR "0-1 year" OR internship) ("remote India" OR APAC OR worldwide)
("careers" OR "we're hiring") "<role term>" (Pune OR "remote India" OR APAC) -site:linkedin.com -site:naukri.com
```

Internship queries must include `(paid OR stipend OR salary)`; the actual JD must still provide pay evidence.

Excluded: `internshala.com` — stale/unreliable postings.

### VC portfolio boards

No Apify actor exists for these. Verified 2026-07-21: Peak XV, Accel, Blume, and Khosla all run the same "Powered by Consider" board platform, and Lightspeed confirms the same `?locations=` filter pattern — fetch these URLs directly instead of a `site:` WebSearch. Direct fetch avoids the SPA-indexing-lag problem `site:` search has on these boards (see the freshness note below): fewer missed listings, no snippet-only dates.

- `https://careers.peakxv.com/jobs?q=<role term>&locations=India`
- `https://jobs.accel.com/jobs?q=<role term>&locations=India`
- `https://jobs.blume.vc/jobs?q=<role term>`
- `https://jobs.lsvp.com/jobs?q=<role term>&locations=India` (confirmed pattern via a live `Gurgaon, India` filter)
- `https://jobs.khoslaventures.com/jobs?q=<role term>`
- `https://www.ycombinator.com/jobs/role/<role-slug>/india` — YC uses per-role path segments, not a `?q=` param; e.g. `/jobs/role/software-engineer/india`
- `https://indianstartups.work` — real aggregator, organized by VC fund and company, not query-searchable; browse and scan for role matches instead of templating a query

Fetch each URL directly (WebFetch or equivalent), not a WebSearch `site:` query — these are client-rendered boards a search engine may not have freshly indexed.

A VC-board hit is a lead, not an apply-ready source: always resolve to the portfolio company's own career page/ATS link before it enters the shortlist, same as any other aggregator-tier discovery.

## Geo evidence

### Onsite/hybrid accepted

Pune metro only: Pune, Pimpri-Chinchwad/PCMC, Hinjawadi/Hinjewadi, Wakad, Baner, Kharadi, Magarpatta, Viman Nagar, Talawade, and nearby explicit Pune tech corridors.

Bangalore/Bengaluru, Mumbai, Hyderabad, or any other city without a Pune location option → reject.

### Remote accepted

Must explicitly say India, APAC/Asia-Pacific, or worldwide/global without excluding India. Reject bare `Remote`, US/Canada/EU/UK/LATAM-only, incompatible country lists, or unclear eligibility.

Search snippets do not prove geo eligibility. Preserve evidence from ATS/feed/JD.

## Freshness evidence

- Primary: age ≤24h at one captured run timestamp.
- Extended: age >24h and ≤72h.
- Older or undated: not curated.
- Prefer ATS `publishedAt`/`first_published`/`createdAt`/Workday `postedOn` over board-relative text.
- Do not infer posting time from discovery time or email alert time.

## ATS endpoints

- Greenhouse: `GET https://boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true`
- Lever: `GET https://api.lever.co/v0/postings/<slug>?mode=json`
- Ashby: `GET https://api.ashbyhq.com/posting-api/job-board/<slug>`
- Workday: use normalized provider endpoint derived from tenant/instance/site; never guess a tenant triple.

A 404/empty slug is logged and skipped. Flag repeated failures for manual pruning; never auto-delete watchlist entries.

## Slug parsing

- Greenhouse: `boards.greenhouse.io/<slug>/jobs/<id>` or `job-boards.greenhouse.io/<slug>/jobs/<id>`
- Lever: `jobs.lever.co/<slug>/<id>`
- Ashby: `jobs.ashbyhq.com/<slug>/<id>`
- Workday requires tenant/instance/site plus posting path; use provider normalization.

## Public feeds

Prioritize providers with usable dates and explicit geo: Jobicy, We Work Remotely, The Muse, JobStreet/SEEK, Glints, Remotive, Himalayas, EchoJobs, Hacker News. RemoteOK/Working Nomads results lacking exact dates cannot enter curated output until date enrichment succeeds. We Work Remotely, Remotive, and Himalayas are also available structurally via Apify (see below) — prefer the Apify path when `APIFY_TOKEN` is set, WebSearch as fallback.

No Apify actor exists for Arc (`arc.dev`), Uplers, or Contra — WebSearch/direct-browse only. Arc and Uplers apply the same explicit-India-eligibility check as any remote board; Contra is contract/independent work, not full-time — tag and score accordingly, it does not count toward the full-time application shortlist.

## Indeed

Indeed is optional until MCP is connected. Probe availability; if missing, report it and continue. When available, query each strict role family for Pune metro and explicit India/APAC remote. Tag as Aggregator; apply same freshness, geo, liveness, dedup, and eligibility rules.

## Apify structured board pull (optional)

Optional layer for LinkedIn/Naukri/Wellfound/YC/Foundit/Internshala/Hirist/Cutshort/Himalayas/Remotive/We Work Remotely via `config/apify.json`-configured Apify actors — a structured alternative to WebSearch for boards that don't expose a public feed. Requires `APIFY_TOKEN` in the environment; skip entirely and report `source unavailable` when unset.

```bash
node job-pull/apify-pull.mjs --out RAW.json --config config/apify.json
node job-pull/public-search-prepare.mjs --in RAW.json --out PREPARED.json
node job-pull/run.mjs --public-json PREPARED.json
```

`apify-pull.mjs` starts each enabled actor, polls to completion (10s interval, 10min timeout per actor), fetches its dataset, and maps items into the same RAW record shape (`url`/`company`/`title`/`postedAt`/`location`/`description`) `public-search-prepare.mjs` already consumes — no changes to the existing ingestion path. A per-actor failure (bad schema, timeout, quota) is non-fatal: it's logged and the run continues with the remaining actors. Tag output as Aggregator; apply the same freshness, geo, liveness, dedup, and eligibility rules as any other aggregator source. The YC actor's posted-date field is unconfirmed against a live run (see `_TODO` note in `config/apify.json`) — treat its freshness as unverified until checked.

## Dedup

```text
Dedup Key = normalize(company) + "|" + normalize(title) + "|" + normalize(location)
normalize = lowercase, strip punctuation, collapse whitespace, normalize known aliases
```

Dedup sequence: canonical URL → provider+Job ID → Dedup Key → committed/pending ledger → JD fingerprint when description exists. Use `fingerprint-core.mjs` for fingerprint similarity. `detect-reposts.mjs` detects repost patterns; it is not universal SimHash cluster output.

## Weekly coverage audit

Onkar supplies five missed alert links weekly. Compare them to source manifests and ledger; classify miss as source absent/failure, indexing lag, date parse, title/geo/pay false negative, dedup false positive, liveness uncertainty, or selection cap. Audit never reads email, weakens gates automatically, or writes links to Notion.
