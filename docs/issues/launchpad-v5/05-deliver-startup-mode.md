# Deliver Startup mode end to end

Status: locally-complete-live-gated

## Parent

[Launchpad v5 specification](../../spec/launchpad-v5.md)

## User stories covered

25–26, 28–30, 47

## What to build

Make the startup-focused morning workflow prioritize startup-tagged employer boards, VC portfolio boards, YC, Wellfound, Indian startup directories, and companies discovered through verified funding or hiring announcements. Funding within the previous 18 months enriches company evidence and ranking but never substitutes for a fresh, active job posting.

Resolved roles must traverse the same eligibility, scoring, deduplication, readiness, shortage, and transactional v5 paths as Normal mode.

## Acceptance criteria

- [ ] Running morning in Startup mode uses the startup source plan and records Startup as the discovery mode.
- [ ] VC portfolio, YC, Wellfound, Indian startup-directory, startup watchlist, and verified funding/hiring-signal lanes are attempted and reported.
- [ ] Company stage uses Startup, Scale-up, Mid-size, or Enterprise with evidence and verification time.
- [ ] Funding within 18 months is stored as a company hiring signal; a stronger under-six-month signal can be distinguished.
- [ ] Funding evidence never supplies or refreshes a job posting date.
- [ ] Every selected role resolves to an active original application and passes the shared immutable gates.
- [ ] Startup Roles and Company records expose the intended stage, funding, source, careers/ATS, and remote-policy fields.
- [ ] High-level tests prove Startup source emphasis, company enrichment, deduplication, and v5 output without changing shared gates.

## Blocked by

[03 — Deliver India-first Normal mode end to end](./03-deliver-india-first-normal-mode.md)
