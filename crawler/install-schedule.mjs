#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SCHEDULE_CONFIG } from './schedules.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(MODULE_DIR, '..');
export const CLI_PATH = path.join(MODULE_DIR, 'cli.mjs');
export const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
export const LOG_DIR = path.join(REPO_ROOT, '.local', 'launchpad-crawler', 'logs');
export const LABEL_PREFIX = 'com.launchpad.crawler';
export const SCHEDULE_IDS = ['morning', 'midday'];

function parseHourMinute(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) throw new Error(`schedule cadence must be HH:MM, received: ${value}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** The launchd trigger time for a schedule: the start of its window, or its single fire time. */
function scheduleTime(scheduleId, scheduleConfig = DEFAULT_SCHEDULE_CONFIG) {
  const cadence = scheduleConfig.schedules?.[scheduleId]?.cadence;
  if (!cadence) throw new Error(`unknown crawler schedule: ${scheduleId}`);
  return parseHourMinute(cadence.window?.start ?? cadence.at);
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plistString(value) {
  return `    <string>${xmlEscape(value)}</string>`;
}

/**
 * Build the launchd agent descriptor and plist XML for one crawler schedule.
 * Pure and side-effect free: writing/loading the plist is a separate step.
 */
export function buildAgentPlist({
  schedule,
  label = `${LABEL_PREFIX}.${schedule}`,
  repoRoot = REPO_ROOT,
  cliPath = CLI_PATH,
  nodePath = process.execPath,
  logDir = LOG_DIR,
  launchAgentsDir = LAUNCH_AGENTS_DIR,
  mode = 'normal',
  locationPreset = 'pune',
  scheduleConfig = DEFAULT_SCHEDULE_CONFIG,
} = {}) {
  if (!SCHEDULE_IDS.includes(schedule)) throw new Error(`unsupported crawler schedule: ${schedule}`);
  const { hour, minute } = scheduleTime(schedule, scheduleConfig);
  const outLog = path.join(logDir, `${schedule}.out.log`);
  const errLog = path.join(logDir, `${schedule}.err.log`);
  const args = [nodePath, cliPath, 'run', schedule, '--mode', mode, '--location-preset', locationPreset];
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(plistString).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(repoRoot)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
  return {
    schemaVersion: 'LaunchpadCrawlerLaunchAgentV1',
    schedule, label, hour, minute,
    plistPath: path.join(launchAgentsDir, `${label}.plist`),
    outLog, errLog, content,
    noAutoApply: true,
  };
}

export function buildScheduleAgents(options = {}) {
  return SCHEDULE_IDS.map((schedule) => buildAgentPlist({ schedule, ...options }));
}

function defaultLaunchctlRunner(args) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}

function currentUid() {
  if (typeof process.getuid === 'function') return process.getuid();
  const result = spawnSync('id', ['-u'], { encoding: 'utf8' });
  return Number(String(result.stdout ?? '').trim());
}

function statusOf(result) {
  return { status: result?.status ?? null, stdout: String(result?.stdout ?? '').trim(), stderr: String(result?.stderr ?? '').trim() };
}

/**
 * Generate and install both launchd agents under ~/Library/LaunchAgents.
 * Idempotent: an existing service is booted out (ignoring "not loaded" failure)
 * before bootstrap, so re-running never errors on "already loaded". With
 * dryRun, nothing is written or installed; the caller gets the plist content
 * to inspect. The launchctl invocation is injectable so tests never touch
 * this machine's real launchd state.
 */
export function installSchedules({
  dryRun = false,
  launchctl = defaultLaunchctlRunner,
  uid = currentUid(),
  agents = buildScheduleAgents(),
} = {}) {
  const domain = `gui/${uid}`;
  const results = agents.map((agent) => {
    if (dryRun) return { ...agent, dryRun: true, installed: false };
    fs.mkdirSync(path.dirname(agent.plistPath), { recursive: true });
    fs.mkdirSync(path.dirname(agent.outLog), { recursive: true });
    fs.writeFileSync(agent.plistPath, agent.content, 'utf8');
    const serviceTarget = `${domain}/${agent.label}`;
    const bootout = launchctl(['bootout', serviceTarget]);
    const bootstrap = launchctl(['bootstrap', domain, agent.plistPath]);
    return {
      ...agent,
      dryRun: false,
      installed: bootstrap.status === 0,
      domain,
      serviceTarget,
      bootout: statusOf(bootout),
      bootstrap: statusOf(bootstrap),
    };
  });
  return {
    schemaVersion: 'LaunchpadCrawlerInstallScheduleV1',
    domain,
    dryRun,
    agents: results,
    noAutoApply: true,
  };
}

function printDryRun(result) {
  for (const agent of result.agents) {
    process.stdout.write(`# ${agent.label} -> ${agent.plistPath}\n${agent.content}\n`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const result = installSchedules({ dryRun });
  if (dryRun) {
    printDryRun(result);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return result.agents.every((agent) => agent.dryRun || agent.installed) ? 0 : 1;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
