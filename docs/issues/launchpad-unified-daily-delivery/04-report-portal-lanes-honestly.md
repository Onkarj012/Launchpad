# Report portal lanes honestly and score resolved portal leads

Status: proposed

## Parent

[Launchpad Unified Daily Delivery](../../spec/launchpad-unified-daily-delivery.md)

## User stories covered

12, 13, 14, 15, 16

## What to build

Stop reporting every run as degraded because of capabilities Launchpad does not have, and let portal leads that were already resolved into direct listings reach scoring.

Seven Indian portal lanes are declared required. They have no automatable source function and the mode layer has no network primitive, so they are permanently unavailable, every run reports itself degraded, and shortfall reasons carry seven permanent entries. The signal is worthless: a genuinely failing lane is indistinguishable from a lane that was never satisfiable.

Reclassify those lanes as optional with an explicit reason code stating that they require live injection. Preserve their identity and their manifests so live-injected portal runs behave exactly as they do today.

Separately, portal leads that the original-listing resolver already converted into a direct employer or ATS listing are real candidates. Route them into the web-discovery lane with their provider provenance retained, so a delivered role can still be attributed to the portal that surfaced it. Unresolved leads stay in the verification queue and cannot be selected.

## Acceptance criteria

- [ ] Portal lanes are optional and carry a reason code stating they require live injection.
- [ ] A run with no portal injection does not report degraded outcome and does not emit portal shortfall reasons.
- [ ] A live-injected portal run produces the same lane manifests and candidate handling as before this change.
- [ ] A portal lead resolved to a direct employer or ATS listing is scored, retaining the provider that surfaced it.
- [ ] An unresolved portal lead remains in the verification queue and cannot be selected.
- [ ] Genuinely failing lanes still report failed or degraded status with their errors.

## Blocked by

[01 - Route the full scheduled crawl into v5 scoring](./01-route-full-crawl-into-v5-scoring.md)
