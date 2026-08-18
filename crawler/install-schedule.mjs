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
  releaseRevision = null,
  releasePath = null,
  scheduleConfig = DEFAULT_SCHEDULE_CONFIG,
} = {}) {
  if (!SCHEDULE_IDS.includes(schedule)) throw new Error(`unsupported crawler schedule: ${schedule}`);
  const { hour, minute } = scheduleTime(schedule, scheduleConfig);
  const outLog = path.join(logDir, `${schedule}.out.log`);
  const errLog = path.join(logDir, `${schedule}.err.log`);
  const args = [nodePath, cliPath, 'daily', schedule, '--env', 'production', '--mode', mode, '--location-preset', locationPreset];
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
    ...(releaseRevision ? { releaseRevision } : {}),
    ...(releasePath ? { releasePath } : {}),
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

function invokeLaunchctl(launchctl, args) {
  try {
    return statusOf(launchctl(args));
  } catch (error) {
    return { status: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), threw: true };
  }
}

function snapshotPlist(plistPath) {
  const exists = fs.existsSync(plistPath);
  return { exists, bytes: exists ? fs.readFileSync(plistPath) : null };
}

function restorePlist(plistPath, snapshot) {
  if (snapshot.exists) {
    fs.writeFileSync(plistPath, snapshot.bytes);
    return { restored: true, exists: true };
  }
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  return { restored: true, exists: false };
}

function recoveryForTouched({ touched, snapshots, launchctl, domain }) {
  const agents = [];
  let recovered = true;
  for (const agent of [...touched].reverse()) {
    const snapshot = snapshots.get(agent.plistPath);
    const serviceTarget = `${domain}/${agent.label}`;
    const bootout = invokeLaunchctl(launchctl, ['bootout', serviceTarget]);
    let plist;
    let bootstrap = null;
    try {
      plist = restorePlist(agent.plistPath, snapshot);
      if (snapshot.exists) bootstrap = invokeLaunchctl(launchctl, ['bootstrap', domain, agent.plistPath]);
    } catch (error) {
      plist = { restored: false, exists: fs.existsSync(agent.plistPath) };
      bootstrap = { status: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), threw: true };
    }
    const agentRecovered = bootout.status === 0 || bootout.status !== null
      ? plist.restored && (!snapshot.exists || bootstrap?.status === 0)
      : false;
    if (!agentRecovered) recovered = false;
    agents.push({ label: agent.label, plistPath: agent.plistPath, priorPlistExisted: snapshot.exists, bootout, plist, bootstrap, recovered: agentRecovered });
  }
  return { attempted: true, recovered, agents };
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
  if (dryRun) return {
    schemaVersion: 'LaunchpadCrawlerInstallScheduleV1',
    domain,
    dryRun,
    agents: agents.map((agent) => ({ ...agent, dryRun: true, installed: false })),
    noAutoApply: true,
  };

  const results = [];
  const touched = [];
  const snapshots = new Map();
  let failure = null;

  for (let index = 0; index < agents.length; index += 1) {
    const agent = agents[index];
    const serviceTarget = `${domain}/${agent.label}`;
    const snapshot = snapshotPlist(agent.plistPath);
    snapshots.set(agent.plistPath, snapshot);
    touched.push(agent);
    fs.mkdirSync(path.dirname(agent.plistPath), { recursive: true });
    fs.mkdirSync(path.dirname(agent.outLog), { recursive: true });
    fs.writeFileSync(agent.plistPath, agent.content, 'utf8');
    const bootout = invokeLaunchctl(launchctl, ['bootout', serviceTarget]);
    const bootstrap = invokeLaunchctl(launchctl, ['bootstrap', domain, agent.plistPath]);
    const result = {
      ...agent,
      dryRun: false,
      installed: bootstrap.status === 0,
      domain,
      serviceTarget,
      bootout,
      bootstrap,
    };
    results.push(result);
    if (bootstrap.status !== 0) {
      failure = { index, label: agent.label, plistPath: agent.plistPath, stage: 'bootstrap', result: bootstrap };
      break;
    }
  }

  if (failure) {
    for (let index = results.length; index < agents.length; index += 1) {
      const agent = agents[index];
      results.push({ ...agent, dryRun: false, installed: false, domain, serviceTarget: `${domain}/${agent.label}`, skipped: true });
    }
    const recovery = recoveryForTouched({ touched, snapshots, launchctl, domain });
    return {
      schemaVersion: 'LaunchpadCrawlerInstallScheduleV1',
      domain,
      dryRun: false,
      agents: results,
      failure,
      recovery,
      recovered: recovery.recovered,
      noAutoApply: true,
    };
  }

  return {
    schemaVersion: 'LaunchpadCrawlerInstallScheduleV1',
    domain,
    dryRun: false,
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
