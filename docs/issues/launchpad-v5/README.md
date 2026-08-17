# Launchpad v5 historical implementation issue pack

Parent specification: [Launchpad v5](../../spec/launchpad-v5.md)

This directory preserves the older local **01–11** v5-foundation issue pack. These numbers are not LP-001–LP-019. The Markdown files are specifications/history, not a current tracker. GitHub is the live issue-status authority, and [../../STATUS.md](../../STATUS.md) is the sole repository execution-status index.

## Dependency order

```text
01 → 02 → 03
          ├── 04
          ├── 05
          ├── 06
          ├── 07 → 08 → 09
          └── 10
                     ↘
                       11
```

Issues 04, 05, 06, 07, and 10 were designed to begin independently after issue 03. Issue 08 follows 07, issue 09 follows 03 and 08, and issue 11 is the final integration/live-gate issue.

The v5 foundation has substantial local implementation and deterministic coverage, but no local issue checkbox or README status proves a live credentialed Notion smoke, authenticated browser smoke, clean release, production canary streak, or promotion. v3/v4 remain historical read-only systems.

## Issues

1. [Establish the fixture-driven v5 workflow spine](./01-establish-v5-workflow-spine.md)
2. [Provision Notion v5 through the scoped local gateway](./02-provision-notion-v5-gateway.md)
3. [Deliver India-first Normal mode end to end](./03-deliver-india-first-normal-mode.md)
4. [Add the separate internship application lane](./04-add-internship-application-lane.md)
5. [Deliver Startup mode end to end](./05-deliver-startup-mode.md)
6. [Deliver global Remote mode end to end](./06-deliver-global-remote-mode.md)
7. [Automate resume queues and application-state synchronization](./07-automate-resume-queues-and-sync.md)
8. [Deliver free-first outreach and follow-ups](./08-deliver-outreach-and-followups.md)
9. [Deliver the manually invoked LinkedIn hiring-post rescue](./09-deliver-linkedin-leads-rescue.md)
10. [Retain optional Indian-portal Apify rescue profiles](./10-retain-apify-rescue-profiles.md)
11. [Complete the v5 go-live and canonical skill handoff](./11-complete-v5-go-live.md)
