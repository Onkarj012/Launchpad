# Launchpad v5 implementation issues

Parent specification: [Launchpad v5](../../spec/launchpad-v5.md)

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

Issues 04, 05, 06, 07, and 10 can begin independently after issue 03. Issue 08 follows 07, issue 09 follows 03 and 08, and issue 11 is the final integration and go-live gate.

Issues 01–11 have local implementation and deterministic coverage in this worktree. Their shared status is `locally-complete-live-gated`: local contracts are testable, while credentialed Notion smoke, authenticated browser smoke, and production verification remain open. No issue status below claims live success.

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
