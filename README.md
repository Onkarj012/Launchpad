# Launchpad v5

Onkar Jadhav's job-search system: discover roles → score against targeting → prepare a truthful resume → track the application lifecycle. The local v5 operator contract is in [docs/SYSTEM-REFERENCE.md](docs/SYSTEM-REFERENCE.md); the handoff is [docs/launchpad-v5-operator-handoff.md](docs/launchpad-v5-operator-handoff.md).

## Quick start

```sh
node launchpad-v5.mjs help
node launchpad-v5.mjs validate
node launchpad-v5.mjs rehearse
node crawler/cli.mjs help
node crawler/cli.mjs validate
```

## Launchpad Crawler v2

Crawler v2 is the durable, discovery-only morning crawler. It stores crawl
history in SQLite, suppresses previously observed jobs across run IDs, honors
discovered `robots.txt` rules, uses shared per-host limits, and returns a
planning-only shortlist handoff.

Configure [config/crawler-v2.json](config/crawler-v2.json) before the first run:

- Add public ATS boards to `atsBatch1.boards`, `atsBatch2.boards`, or
  `enterprise.boards`.
- Add `{ "company": "...", "websiteUrl": "https://..." }` entries to
  `careerSites`.
- Enable Brave only after setting `BRAVE_SEARCH_API_KEY`; queries remain leads
  until an original employer listing is resolved.
- Enable the Indeed inbox only after placing a dated `IndeedConnectorV1` export
  under `connector-inbox/indeed/`.
- Keep commercial rescue disabled until a profile and cost limit are explicitly
  approved.

Operator commands:

```sh
# Validate configuration without crawling
node crawler/cli.mjs validate

# Inspect the intended stage order
node crawler/cli.mjs plan morning
node crawler/cli.mjs plan midday

# Run discovery. Use a unique run ID for each real run.
node crawler/cli.mjs run morning --run-id 2026-07-23-morning
node crawler/cli.mjs run midday --run-id 2026-07-23-midday

# Generate an honest local readiness result
node crawler/cli.mjs readiness --run-tests
```

The default SQLite path is `.local/launchpad-crawler/crawler.sqlite`, which is
ignored by Git. The morning command runs every configured discovery lane;
midday omits broad expanded ATS, Brave, and startup discovery. Scheduling is
owned by the local operator: invoke these commands from `launchd`, cron, or
another scheduler only after a bounded live smoke run succeeds.

Crawler output never submits an application, checks `Apply?`, writes a sent
message, or performs authenticated LinkedIn crawling.

Daily agent surface:

- `/morning` runs Normal by default; `/morning startup` and `/morning remote` are focused modes.
- `/make-applications` reads the user-controlled v5 `Make Resume` queue and compiles locally.
- `/outreach` prepares free-first drafts and never sends.
- `/linkedin-leads` is an explicit read-only rescue, never part of morning.
- `/followups` surfaces or drafts v5 cadence actions; `/sync` synchronizes observed `Applied?` and confirmed outcomes.
- Apify is an explicit, default-off rescue profile only (`node job-pull/apify-pull.mjs --profile <stable-name> --out RAW.json`).

## Daily contract

All modes share original-application resolution, active liveness, geography, employment, experience, fee/bond, freshness, scoring, and deduplication gates. Normal emphasizes India-first discovery. Startup adds company-stage and funding/hiring evidence. Remote emphasizes India-compatible remote, stable EOR, and full-time-equivalent contractor roles. Internships are separate, with INR 30,000+ Preferred and INR 25,000–29,999 Lower-Stipend tiers.

The shortlist targets minimum 10, preferred 12, maximum 20. Unresolved roles remain in Needs Verification and never count. Source failures are reported; core integrity failures stop before writes. A shortfall may suggest `/linkedin-leads`, but it never launches the rescue automatically.

## v5 stores and state

The fixed manifest scopes the gateway to Applications v5, Companies v5, Outreach v5, Activity v5, and Referrals v5. Applications owns the role lifecycle and user-owned `Make Resume` / `Applied?` inputs. Outreach owns application × person × channel sequences. Activity owns idempotent dated events.

Live writes require explicit operator authorization, an external protected credential, an external transaction journal, and reserve → write → verify → commit. There is no legacy fallback. Historical systems remain untouched; no migration, archive, or delete action is part of this release.

## Resume and outreach guardrails

- Resume compilation is local-only. Use the frozen `resumes/templates/Onkar_Template.tex` and approved `resumes/master/Master_Resume_ATS.tex` evidence.
- Keep `.tex`, matrix, and provenance sidecars under `resumes/sources/<date>/`; `resumes/output/<date>/` contains PDFs only.
- Never check `Make Resume` or `Applied?`, infer an application submission, invent a fact/contact, auto-apply, send email, or send a LinkedIn message.
- Outreach cadence is Day 0, 3, 10, 17 and stops on reply, rejection, opt-out, withdrawal, closure, or offer.

## Verification suites

The Phase 0 crawler release baseline is documented in
[docs/crawler-v2-operational-baseline.md](docs/crawler-v2-operational-baseline.md)
and is the following single scoped command:

```sh
node --test tests/crawler/*.test.mjs tests/job-pull/normal-mode.test.mjs tests/job-pull/startup-mode.test.mjs tests/job-pull/remote-mode.test.mjs tests/notion-v5/gateway.test.mjs tests/job-pull/dedup.test.mjs
```

The broader verification commands remain available for full local checks:

```sh
node --test tests/job-pull/*.test.mjs
node --test tests/crawler/*.test.mjs
node --test tests/notion-v5/*.test.mjs
node --test tests/resume-v5/*.test.mjs
node --test tests/outreach-v5/*.test.mjs
node --test tests/v5/*.test.mjs
node tests/resume/verify.mjs
git diff --check
```

The local rehearsal and deterministic suites do not prove a live Notion write, credentialed smoke, authenticated browser smoke, or production morning run. Those remain explicit live gates.
