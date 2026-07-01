# Sourcing reference — daily-job-pull

Mechanical detail for Steps 1-4. Targeting (role terms, geo) lives in `master_prompt.md` § 2 — don't duplicate it here, reference it.

## Dorks (Layer 1)

ATS domains to restrict to:
- `boards.greenhouse.io`
- `jobs.lever.co`
- `jobs.ashbyhq.com`

Query template: `site:<ats-domain> "<role term>" (<geo terms>)`

Geo terms: `Pune OR "remote India" OR "remote, India" OR India`

Example queries (run one per role term × ATS domain):
```
site:boards.greenhouse.io "AI engineer" (Pune OR "remote India")
site:jobs.lever.co "machine learning engineer" India
site:jobs.ashbyhq.com "software engineer" "new grad" India
site:boards.greenhouse.io "backend engineer" python (Pune OR remote India)
```

Prefer the search tool's recency filter where available; otherwise rely on Step 6 freshness parsing.

## Slug parsing

Every dork hit's URL already contains the company slug:
- Greenhouse: `boards.greenhouse.io/<slug>/jobs/<id>` → slug = path segment 1
- Lever: `jobs.lever.co/<slug>/<id>` → slug = path segment 1
- Ashby: `jobs.ashbyhq.com/<slug>/<id>` → slug = path segment 1

## ATS endpoints (Layer 2)

- Greenhouse: `GET https://boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true`
- Lever: `GET https://api.lever.co/v0/postings/<slug>?mode=json`
- Ashby: `GET https://api.ashbyhq.com/posting-api/job-board/<slug>`

A 404 or empty result = dead/wrong slug. Log and move on; don't retry. Periodically prune slugs that 404 on 3+ consecutive runs from `companies.json` (flag for the user, don't auto-delete).

## Dedup hash

```
Dedup Key = normalize(company) + "|" + normalize(title) + "|" + normalize(location)
normalize = lowercase, strip punctuation, collapse whitespace, drop "(remote)" / seniority noise (e.g. "senior", "sr.", "jr.")
```

Source rarity precedence on collision (best wins, replace the JD link with the winner's): `ATS-direct > Niche board > Aggregator`. `Source` values `Greenhouse` / `Lever` / `Ashby` map to `Source Rarity = ATS-direct`; Indeed maps to `Aggregator`.
