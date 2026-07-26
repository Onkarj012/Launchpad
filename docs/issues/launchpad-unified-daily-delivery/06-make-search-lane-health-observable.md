# Make search-lane health observable, then restore the second provider

Status: proposed

## Parent

[Launchpad Unified Daily Delivery](../../spec/launchpad-unified-daily-delivery.md)

## User stories covered

21, 22, 23

## What to build

Make a zero-result search lane diagnosable, then re-enable the second search provider once it is.

The primary search provider is enabled and reachable, and its job queries return zero results. The cause is unknown because the diagnostic already exists and is discarded: the search transport receives the upstream unresponsive-engine list on every response and drops it before it reaches lane telemetry. A blocked upstream engine and a healthy engine with genuinely no matches currently look identical.

Surface unresponsive engine data and response status per query in lane telemetry. Do not change query strings before engine health is observable — upstream engine blocking is the leading hypothesis and configuration format support is the second, and changing queries first would confound both.

Once the primary provider is diagnosable, re-enable the second search provider. Its discovery plan already exists and enabling it is configuration and credential work. Enable it separately so any yield change is attributable to one provider.

## Acceptance criteria

- [ ] Unresponsive engine data and response status are reported per query in lane telemetry.
- [ ] A zero-result response with healthy engines is reported differently from one with blocked engines.
- [ ] The cause of the current zero-result condition is identified and recorded.
- [ ] Query strings are unchanged until engine health is observable.
- [ ] The second search provider is enabled only after the first is diagnosable, and is enabled in its own change.
- [ ] Search diagnostics are covered by fake-transport tests with no live dependency.

## Blocked by

None - can start immediately
