# Deliver the manually invoked LinkedIn hiring-post rescue

Status: locally-complete-live-gated

## Parent

[Launchpad v5 specification](../../spec/launchpad-v5.md)

## User stories covered

36–40, 59, 63–66

## What to build

Provide a manually invoked Codex computer-use workflow for LinkedIn hiring posts that normal job boards can miss. It searches bounded role/hiring queries in the user's existing authenticated session, reads posts only, captures forms/referral/DM invitations and associated hiring people, and returns structured leads.

A discovered job must resolve to an active original application and pass shared freshness, eligibility, scoring, readiness, and deduplication before it reaches Applications v5. Associated people use the normal Outreach evidence and duplicate contract.

## Acceptance criteria

- [ ] The workflow is invoked explicitly and is never launched automatically by morning discovery.
- [ ] Computer use is read-only: no login automation, application submission, connection, follow, reaction, comment, or message.
- [ ] Queries are bounded and output preserves post URL, author, role/company relationship, timestamp evidence, raw hiring context, job/form link, and self-declared contact invitation.
- [ ] Posts may produce both an application lead and associated Outreach evidence rather than forcing exclusive buckets.
- [ ] Application leads traverse original-application resolution and all shared gates before v5 Ready status.
- [ ] Invalid, promotional, job-seeker, stale, unresolved, duplicate, or ineligible posts are reported rather than silently inserted.
- [ ] Morning suggests LinkedIn rescue when the verified pool remains materially short but does not execute it.
- [ ] Deterministic tests use captured post fixtures; real authenticated browsing is reserved for a manual smoke test.

## Blocked by

[03 — Deliver India-first Normal mode end to end](./03-deliver-india-first-normal-mode.md); [08 — Deliver free-first outreach and follow-ups](./08-deliver-outreach-and-followups.md)
