#!/bin/sh
set -eu

uid=$(id -u)
agents_dir="$HOME/Library/LaunchAgents"

for suffix in morning midday; do
  label="com.launchpad.shadow-week.$suffix"
  launchctl bootout "gui/$uid/$label" 2>/dev/null || true
  rm -f "$agents_dir/$label.plist"
done
