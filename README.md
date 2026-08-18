# Launchpad v5

Onkar Jadhav's job-search system: discover roles → score against targeting → prepare a truthful resume → track the application lifecycle. Read [docs/STATUS.md](docs/STATUS.md) first for the current execution position. The executable contract is in [docs/SYSTEM-REFERENCE.md](docs/SYSTEM-REFERENCE.md), and the operator handoff is [docs/launchpad-v5-operator-handoff.md](docs/launchpad-v5-operator-handoff.md).

## Current release position

The unified daily implementation exists in the dirty working tree. Launchpad readiness Phase 00 resume queue wiring is locally verified by focused tests, but the system is **not production-ready, live-verified, or promoted**. GitHub issues are the live status authority; local issue packs, audits, probes, and plans are specifications or history.

Launchpad v5 is the sole active runtime contract. v3 and v4 are historical read-only systems with no write, migration, archive, delete, or runtime fallback path.

## Quick start

```sh
node launchpad-v5.mjs help
node launchpad-v5.mjs validate
node launchpad-v5.mjs rehearse
node crawler/cli.mjs help
node crawler/cli.mjs validate
```

`rehearse` uses deterministic fixtures and injected local fakes. It does not prove live Notion, browser, scheduler, source-yield, or production behavior.

## Unified daily commands

```sh
node crawler/cli.mjs daily morning --mode normal  --location-preset india --run-id <unique-id>
node crawler/cli.mjs daily morning --mode startup --location-preset pune  --run-id <unique-id>
node crawler/cli.mjs daily morning --mode remote   --location-preset india --run-id <unique-id>
node crawler/cli.mjs daily midday  --mode normal  --location-preset pune  --run-id <unique-id>
node crawler/cli.mjs daily midday  --mode startup --location-preset india --run-id <unique-id>
node crawler/cli.mjs daily midday  --mode remote   --location-preset india --run-id <unique-id>
```

The daily path performs one shared crawl, then passes the shared inventory to the requested Normal, Startup, or Remote selector. Midday Remote intentionally skips native remote-feed fetching and selects from the shared midday ATS/delta inventory.

All modes share normalization, original-application resolution, eligibility/readiness, scoring, opportunity-ledger suppression, and final-shortlist-only surfacing. Mode-specific code ranks the already-gated pool. Crawler SQLite stores discovery/observation state; it no longer owns cooldown surfacing policy.

Workday freshness is fail-safe: a usable DETAIL `startDate` is trusted. LIST `postedOn` remains undated and enters `VerifyQueue`.

## Crawler operations

```sh
# Configuration and stage inspection
node crawler/cli.mjs validate
node crawler/cli.mjs plan morning --mode normal --location-preset pune
node crawler/cli.mjs plan midday --mode remote --location-preset india

# Discovery-only crawler path, separate from unified daily selection
node crawler/cli.mjs run morning --mode normal --location-preset pune --run-id <unique-id>

# Local readiness calculation and all six deterministic suite groups
node crawler/cli.mjs readiness --run-tests
```

The default SQLite path is `.local/launchpad-crawler/crawler.sqlite`, ignored by Git. The repository can generate/install local macOS launchd agents, but checked-in code and tests do not prove the current machine has the working-tree schedule installed or operating. Do not claim installed scheduling without retained machine evidence.

## Agent surface

- `/morning` delegates to unified daily Normal by default; `/morning startup` and `/morning remote` select focused modes.
- `/make-applications` reads the user-controlled v5 `Make Resume` queue and compiles locally.
- `/outreach` performs free-first research and prepares draft content; the active workflow has no guaranteed Gmail draft adapter or send provider.
- `/linkedin-leads` is an explicit read-only rescue and never runs automatically.
- `/followups` surfaces or drafts cadence actions; `/sync` observes user-set `Applied?` and confirmed outcomes.
- Apify is explicit, default-off rescue only: `node job-pull/apify-pull.mjs --profile <stable-name> --out RAW.json`.

## v5 stores and state

The fixed manifest scopes the gateway to Applications v5, Companies v5, Outreach v5, Activity v5, and Referrals v5. The working-tree validator requires exactly ten directed reciprocal relation entries. This is a local manifest claim, not a claim that the dirty relation set completed a live credentialed smoke.

Applications owns the role lifecycle and user-owned `Make Resume` / `Applied?` inputs. Companies owns reusable evidence. Outreach owns application × person × channel sequences. Activity owns idempotent events. Referrals owns referral evidence and outcomes.

Live writes require explicit operator authorization, a protected external credential, an external transaction journal, and reserve → write → verify → commit. There is no legacy fallback.

## Resume and outreach guardrails

- Resume compilation is local-only. Use the frozen `resumes/templates/Onkar_Template.tex` and approved `resumes/master/Master_Resume_ATS.tex` evidence.
- Keep `.tex`, matrix, and provenance sidecars under `resumes/sources/<date>/`; `resumes/output/<date>/` contains PDFs only.
- Never check `Make Resume` or `Applied?`, infer a submission, invent a fact/contact, auto-apply, send email, send a LinkedIn message, or claim a Gmail draft without adapter evidence.
- External actions are allowed only through a separately explicit, authorized, scoped path.

## Verification map

The readiness command covers:

```sh
node --test tests/crawler/*.test.mjs
node --test tests/job-pull/*.test.mjs
node --test tests/notion-v5/*.test.mjs
node --test tests/resume-v5/*.test.mjs
node --test tests/outreach-v5/*.test.mjs
node --test tests/v5/*.test.mjs
```

Additional local checks:

```sh
node launchpad-v5.mjs validate
node crawler/safety-contract.mjs
node tests/resume/verify.mjs
git diff --check
```

Avoid publishing test counts unless the exact command, date, revision, and dirty/clean state are retained. Local validation does not establish a credentialed Notion smoke, clean committed baseline, production canary streak, push, or promotion.
