# Phase 7: run the seven-date immutable canary

Status: proposed

## Parent

[Launchpad full production implementation plan](../../plans/launchpad-full-production-implementation.md), Phase 7

## What to run

Manually run the same immutable release on seven distinct valid UTC dates. Keep revision, lockfile install, production config fingerprint, source registry, normalized profile, manifest, journal identity, and report schema unchanged throughout the streak.

Each date must end as `completed` with at least five qualified roles or `completed_shortfall` with retained manual inventory proof. A degraded or pending-shortfall date does not count. Revision or config change restarts the streak.

## Evidence retained per date

- Matching Markdown and JSON report pair.
- Source manifests and budget telemetry.
- Observation and resolver accounting.
- Workday DETAIL accounting.
- Funnel and company-cap exclusions.
- Selected, planned, and delivered key reconciliation.
- Transaction and opportunity-ledger result.
- Notification receipt.
- Inventory identity.
- Manual inventory evidence where needed.
- Clean revision and config fingerprint.

## Acceptance criteria

- [ ] Seven distinct valid UTC dates exist on one immutable release and normalized profile.
- [ ] Every date is `completed` or `completed_shortfall`.
- [ ] Every `completed_shortfall` date has retained manual inventory confirmation and complete machine accounting.
- [ ] No `degraded` or `shortfall_pending_review` date counts.
- [ ] Report pairs, digests, inventory identities, fingerprints, transaction results, and notifications validate for all seven dates.
- [ ] Selected, planned, delivered, surfaced, and reported keys reconcile for all seven dates.
- [ ] User-owned fields remain unchanged.

## Stop point

Report seven-date evidence. Promotion still requires separate approval.

## Blocked by

Phase 6 clean immutable candidate.
