# Crawler v2 operator runbook

## Profiles

```sh
node crawler/cli.mjs plan morning --mode normal --location-preset pune
node crawler/cli.mjs plan morning --mode startup --location-preset pune
node crawler/cli.mjs plan morning --mode remote --location-preset india
node crawler/cli.mjs plan midday --mode normal --location-preset pune
```

`Normal`, `Startup`, and `Remote` share the same readiness gates. Pune changes source priority and query hints only; it is not a fourth eligibility implementation.

## Discovery run

```sh
node crawler/cli.mjs run morning --mode normal --location-preset pune --run-id YYYY-MM-DD-normal-pune
node crawler/cli.mjs run midday --mode normal --location-preset pune --run-id YYYY-MM-DD-midday-pune
```

Runs are discovery-only. They never apply, send, generate resumes, or write Notion records. Search and connector records remain verification leads until resolved to an original employer or ATS listing.

## Recovery and interpretation

- Reuse the same run ID to obtain an idempotent result.
- `verificationQueue` is not application-ready inventory.
- A shortfall is reported honestly; do not relax geography, experience, freshness, liveness, compensation, or original-URL gates.
- Historical v4 rows are read-only identity inputs and are never migrated, changed, or deleted.
- Review source telemetry by source, mode, and preset after seven operational days before changing source frequency.

## Handoff boundary

The crawler returns a planning-only v5 handoff. Any later Notion transaction requires explicit operator authorization and the protected v5 transaction path. Applications and outreach remain user-controlled.
