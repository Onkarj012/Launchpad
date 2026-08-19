# Deliver global Remote mode end to end

Status: locally-complete-live-gated

## Parent

[Launchpad v5 specification](../../spec/launchpad-v5.md)

## User stories covered

11–14, 27–31

## What to build

Make the remote-focused morning workflow discover and verify fully remote roles that can engage someone working from India. Use native Himalayas, Jobicy, We Work Remotely, and Remotive sources together with eligible ATS, YC, Wellfound, and bounded remote searches. Support direct employment, EOR, and stable full-time-equivalent contracting while rejecting bare Remote labels, incompatible citizenship restrictions, gigs, and unpredictable freelance arrangements.

Use supported provider pagination and preserve each provider's freshness limitations in ranking and telemetry.

## Acceptance criteria

- [ ] Running morning in Remote mode uses the remote source plan and records Remote as the discovery mode.
- [ ] Himalayas uses documented limits/pagination; Jobicy and WWR use native feeds; Remotive inventory is not treated as first-24-hour discovery.
- [ ] Remote readiness requires explicit India, compatible APAC, worldwide/global, or a verified EOR/full-time-contractor arrangement available in India.
- [ ] All timezones are accepted, while citizenship, country, payroll, and engagement restrictions are preserved as evidence.
- [ ] Stable Contractor/EOR is a distinct eligible employment category; gig, commission, temporary freelance, and unstable contracting are rejected.
- [ ] Remote Roles exposes employment structure, authorization evidence, freshness, source, and original application.
- [ ] Provider failures degrade coverage visibly but do not make the run fatal.
- [ ] Contract and high-level tests cover region ambiguity, citizenship exclusions, EOR, contractor stability, provider dates, pagination, and v5 writes.

## Blocked by

[03 — Deliver India-first Normal mode end to end](./03-deliver-india-first-normal-mode.md)
