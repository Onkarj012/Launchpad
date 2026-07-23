# Issue tracker: GitHub

Issues and specifications for this repository live in GitHub Issues at `Onkarj012/Launchpad`. Use the `gh` CLI from this checkout so the repository is inferred from `origin`.

## Conventions

- Create issues with `gh issue create`.
- Read issues and their discussion with `gh issue view <number> --comments`.
- List issues with `gh issue list`, including labels and comments when a workflow needs triage state.
- Apply or remove labels with `gh issue edit`.
- Close issues with `gh issue close`.
- When an engineering skill says to publish to the issue tracker, create a GitHub issue.
- When an engineering skill requests the relevant ticket, fetch the corresponding GitHub issue and its comments.

## Pull requests as a triage surface

Pull requests are not treated as incoming feature requests by default.

## Wayfinding operations

- A wayfinding map is a GitHub issue labelled `wayfinder:map`.
- Child tickets use GitHub sub-issues when available; otherwise the map owns a task list and each child links back to the map.
- Use native GitHub issue dependencies when available. Otherwise record blockers in a `Blocked by:` line.
- The frontier consists of open, unassigned children with no open blockers.
- Claim work by assigning the issue before implementation.
