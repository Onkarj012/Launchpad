# Make the unified run the scheduled and command entrypoint

Status: proposed

## Parent

[Launchpad Unified Daily Delivery](../../spec/launchpad-unified-daily-delivery.md)

## User stories covered

9, 32, 36, 42

## What to build

Point the scheduled agents and the public morning command at the unified daily run, so that discovery and delivery are the same execution.

Today the generated launchd agents invoke the crawl command directly with production environment and normal mode, which never reaches v5 scoring, selection, or write planning. The public command contract names the Normal mode module for the morning command, and that module has no network primitive, so invoking it without injected source functions marks every required lane unavailable and returns an empty shortlist by construction. The unified run has no caller outside its own test.

Add a daily command to the crawler command surface that invokes the unified run and emits the same operator-facing result shape the other commands emit. Repoint the generated launchd agent arguments at it and reinstall the agents. Update the public command contract so the morning command names the unified run, and update the project map so the documented path and the executed path agree.

The run stays discovery-and-planning only. Write planning continues through the no-write gateway by default and live gateway execution stays behind the existing explicit opt-in.

## Acceptance criteria

- [ ] A daily command exists on the crawler command surface and invokes the unified run.
- [ ] Generated launchd agent arguments name the daily command; agents are reinstalled and verified.
- [ ] The public command contract names the unified run for the morning command.
- [ ] The project map describes the unified path and no longer describes three separate paths.
- [ ] The command performs no writes by default and cannot execute a live gateway without the existing explicit opt-in.
- [ ] Invoking the command with the production configuration reproduces what the scheduled agent runs.
- [ ] Existing crawler command tests continue to pass and the new command has coverage matching their pattern.

## Blocked by

[01 - Route the full scheduled crawl into v5 scoring](./01-route-full-crawl-into-v5-scoring.md)
