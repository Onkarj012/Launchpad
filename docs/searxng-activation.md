# SearXNG activation for Launchpad

SearXNG is a discovery lane, not an application source. It finds previously
unknown employers and original career pages. Every result remains a lead until
Launchpad resolves the employer/ATS URL and passes liveness, geography,
experience, employment, and freshness checks.

## Fastest setup: local Docker

Prerequisite: Docker Desktop is installed and running.

1. Create a directory outside this repository:

   ```bash
   mkdir -p "$HOME/Services/searxng/config" "$HOME/Services/searxng/data"
   cd "$HOME/Services/searxng"
   ```

2. Start the official image:

   ```bash
   docker run --name launchpad-searxng -d \
     --restart unless-stopped \
     -p 127.0.0.1:8080:8080 \
     -v "$HOME/Services/searxng/config:/etc/searxng" \
     -v "$HOME/Services/searxng/data:/var/cache/searxng" \
     docker.io/searxng/searxng:latest
   ```

3. In `config/settings.yml`, ensure JSON output is enabled:

   ```yaml
   use_default_settings: true

   search:
     formats:
       - html
       - json

   server:
     bind_address: "0.0.0.0"
     limiter: false
   ```

4. Restart and verify:

   ```bash
   docker restart launchpad-searxng
   curl --get 'http://127.0.0.1:8080/search' \
     --data-urlencode 'q=AI Engineer India fresher careers' \
     --data 'format=json'
   ```

   The response must be JSON containing a `results` array.

5. Change `sources.searxng.enabled` to `true` in
   `config/crawler-v2.json`. Keep the endpoint as
   `http://127.0.0.1:8080`.

6. Validate and run a bounded discovery:

   ```bash
   node crawler/cli.mjs validate --config config/crawler-v2.json
   node crawler/cli.mjs run morning \
     --config config/crawler-v2.json \
     --run-id "searxng-smoke-$(date +%F)"
   ```

## Operational boundary

- A local instance works only while this Mac and Docker are running.
- Do not expose port 8080 publicly without authentication, TLS, and rate
  limiting.
- Search snippets never become application-ready records.
- The configured daily budget is 20 queries with at most 10 results per query.
- Chromium remains a fallback only for verified JavaScript-only career pages.

## What it adds

- Unknown-employer discovery beyond the curated ATS watchlist.
- YC, Wellfound, Cutshort, Peerlist, VC-portfolio, startup ATS, and remote-India
  query coverage.
- Original career-page and ATS leads that can be promoted into the direct
  watchlist after verification.
- Query and result telemetry, so low-yield searches can be removed after the
  seven-day calibration.

It does not improve JD parsing by itself and it does not bypass geography,
experience, liveness, deduplication, or manual-application controls.
