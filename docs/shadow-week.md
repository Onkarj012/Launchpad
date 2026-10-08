# Shadow week schedule

The isolated crawler config uses `.local/launchpad-crawler/shadow-week/crawler.sqlite` and its own copy of the board registry. The daily command receives `--config config/crawler-v2-shadow-week.json` and does not receive `--execute-writes`; Notion writes are unavailable in this schedule.

Preview the two launchd definitions without installing them:

```sh
node crawler/cli.mjs install-schedule --dry-run --schedule-definition config/shadow-week-schedule.json
```

When Onkar authorizes installation, run this from the repository root:

```sh
node crawler/cli.mjs install-schedule --schedule-definition config/shadow-week-schedule.json
```

This creates two per-user launchd agents at 07:45 and 13:15 Asia/Kolkata. Start the seven-day shadow period on the installation date. launchd repeats daily, so remove both agents after the seventh day with one command:

```sh
sh scripts/remove-shadow-week-schedule.sh
```

The removal command unloads both shadow agents and deletes only their two plist files from `~/Library/LaunchAgents`. It does not affect the regular crawler schedule.
