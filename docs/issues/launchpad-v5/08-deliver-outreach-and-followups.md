# Deliver free-first outreach and follow-ups

Status: locally-complete-live-gated

## Parent

[Launchpad v5 specification](../../spec/launchpad-v5.md)

## User stories covered

59–68

## What to build

Deliver a complete manual-send human-contact path for application-ready roles. Research one relevant current person per shortlisted application where possible using hiring authors, company/team pages, public professional profiles and emails, optional Apollo discovery, limited Hunter credits, and optional Vibe/Explorium credits. Deeply personalize the strongest five or six applications and prepare lighter contact paths for the remainder.

Persist one Outreach sequence per application, person, and channel. Keep table properties compact, store the full message in the page body, derive follow-up state from dated events, and require user confirmation for every send.

## Acceptance criteria

- [ ] Contact research records identity, current role, company relationship, public evidence, recommended channel, and confidence without inventing an email.
- [ ] The free-first source order is enforced; paid/credit tools are optional and failure does not block an application.
- [ ] The strongest five or six eligible applications receive deeply personalized drafts; remaining roles can receive lighter LinkedIn/public-email paths.
- [ ] Outreach duplicate identity is deterministic for application × person × channel.
- [ ] Table fields remain compact while the full draft is reviewable in the page body with relevant links.
- [ ] Drafting requires the exact role's Ready resume when an attachment is expected.
- [ ] Sent state changes only after user confirmation; agents never send email, InMail, DMs, connection requests, or referrals.
- [ ] Cadence produces Day 0, Day 3, Day 10, and Day 17 actions and stops on response, rejection, opt-out, or closure.
- [ ] Activity and Outreach remain coherent and drive the Follow-up Due view without competing manual booleans.
- [ ] Tests cover missing email, optional provider failures, duplicate guards, draft storage, manual send confirmation, cadence, stop conditions, and no-send guarantees.

## Blocked by

[07 — Automate resume queues and application-state synchronization](./07-automate-resume-queues-and-sync.md)
