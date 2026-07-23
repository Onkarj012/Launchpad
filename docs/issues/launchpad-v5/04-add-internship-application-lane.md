# Add the separate internship application lane

Status: locally-complete-live-gated

## Parent

[Launchpad v5 specification](../../spec/launchpad-v5.md)

## User stories covered

16–19, 46, 49–50

## What to build

Carry internships through the same discovery and readiness path while keeping them operationally distinct from full-time employment. Extract stipend evidence and classify eligible Pune-metro or remote internships into Preferred Internship or Lower-Stipend Internship. Surface unresolved compensation only for verification and never use it to satisfy the daily application-ready minimum.

The result must be understandable in the morning report and filterable in the dedicated Notion Internship view without weakening the main employment gates.

## Acceptance criteria

- [ ] Internships at INR 30,000 per month or more are classified Preferred Internship.
- [ ] Internships at INR 25,000–29,999 are classified Lower-Stipend Internship.
- [ ] Internships below INR 25,000 are rejected and unknown stipends enter Needs Verification.
- [ ] Only Pune-metro onsite/hybrid or eligible remote internships can become application-ready.
- [ ] Internship employment category, stipend amount/evidence, tier, freshness, and readiness are persisted to v5.
- [ ] The Internship view clearly separates preferred and lower-stipend rows from full-time and Contractor/EOR roles.
- [ ] Fixture-backed tests cover exact boundary values, unknown/ambiguous compensation, location, and transactional write behavior.

## Blocked by

[03 — Deliver India-first Normal mode end to end](./03-deliver-india-first-normal-mode.md)
