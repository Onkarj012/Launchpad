import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAgentPlist,
  buildScheduleAgents,
  installSchedules,
} from '../../crawler/install-schedule.mjs';

function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixtureOptions() {
  return {
    repoRoot: '/fixture/repo root',
    cliPath: '/fixture/repo root/crawler/cli.mjs',
    nodePath: '/fixture/bin/node',
    logDir: tempDir('launchpad-schedule-logs-'),
    launchAgentsDir: tempDir('launchpad-launch-agents-'),
  };
}

test('generates morning (04:30) and midday (12:30) plists from the schedules.mjs cadence, without calling launchctl', () => {
  const options = fixtureOptions();
  const agents = buildScheduleAgents(options);
  assert.equal(agents.length, 2);

  const morning = agents.find((agent) => agent.schedule === 'morning');
  const midday = agents.find((agent) => agent.schedule === 'midday');
  assert.equal(morning.label, 'com.launchpad.crawler.morning');
  assert.equal(midday.label, 'com.launchpad.crawler.midday');
  assert.equal(morning.hour, 4);
  assert.equal(morning.minute, 30);
  assert.equal(midday.hour, 12);
  assert.equal(midday.minute, 30);

  for (const agent of agents) {
    assert.ok(agent.content.includes(`<string>${agent.label}</string>`));
    assert.ok(agent.content.includes('<string>/fixture/bin/node</string>'));
    assert.ok(agent.content.includes('<string>/fixture/repo root/crawler/cli.mjs</string>'));
    assert.ok(agent.content.includes('<string>run</string>'));
    assert.ok(agent.content.includes(`<string>${agent.schedule}</string>`));
    assert.ok(agent.content.includes('<string>--mode</string>'));
    assert.ok(agent.content.includes('<string>normal</string>'));
    assert.ok(agent.content.includes('<string>--location-preset</string>'));
    assert.ok(agent.content.includes('<string>pune</string>'));
    assert.ok(agent.content.includes(`<integer>${agent.hour}</integer>`));
    assert.ok(agent.content.includes(`<integer>${agent.minute}</integer>`));
    assert.ok(agent.plistPath.startsWith(options.launchAgentsDir));
    assert.ok(agent.outLog.startsWith(options.logDir));
    assert.ok(agent.errLog.startsWith(options.logDir));
  }
});

test('single-agent build rejects an unsupported schedule id', () => {
  assert.throws(() => buildAgentPlist({ schedule: 'evening' }), /unsupported crawler schedule/);
});

test('dry-run never writes a plist file or invokes launchctl', () => {
  const options = fixtureOptions();
  let calls = 0;
  const launchctl = () => { calls += 1; return { status: 0, stdout: '', stderr: '' }; };

  const result = installSchedules({ dryRun: true, launchctl, uid: 501, agents: buildScheduleAgents(options) });
  assert.equal(result.dryRun, true);
  assert.equal(calls, 0);
  assert.ok(result.agents.every((agent) => agent.dryRun === true && agent.installed === false));
  assert.equal(fs.readdirSync(options.launchAgentsDir).length, 0);
});

test('install is idempotent: it boots out any existing service before bootstrap, using an injected launchctl stub', () => {
  const options = fixtureOptions();
  const calls = [];
  const launchctl = (args) => {
    calls.push(args);
    if (args[0] === 'bootout') return { status: 1, stdout: '', stderr: 'No such process' }; // not previously loaded
    return { status: 0, stdout: '', stderr: '' };
  };

  const result = installSchedules({ dryRun: false, launchctl, uid: 501, agents: buildScheduleAgents(options) });
  assert.equal(result.domain, 'gui/501');
  assert.equal(result.agents.length, 2);
  assert.ok(result.agents.every((agent) => agent.installed === true));

  // bootout then bootstrap, per agent, in order — never a raw load that would error on a second run.
  const morningCalls = calls.filter((args) => args.some((item) => String(item).includes('com.launchpad.crawler.morning')));
  assert.equal(morningCalls[0][0], 'bootout');
  assert.equal(morningCalls[1][0], 'bootstrap');

  for (const agent of result.agents) {
    assert.ok(fs.existsSync(agent.plistPath));
    assert.equal(fs.readFileSync(agent.plistPath, 'utf8'), agent.content);
  }
});

test('a failed bootstrap is reported as not installed rather than thrown', () => {
  const options = fixtureOptions();
  const launchctl = (args) => (args[0] === 'bootstrap' ? { status: 1, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' } : { status: 0, stdout: '', stderr: '' });

  const result = installSchedules({ dryRun: false, launchctl, uid: 501, agents: buildScheduleAgents(options) });
  assert.ok(result.agents.every((agent) => agent.installed === false));
  assert.ok(result.agents.every((agent) => agent.bootstrap.status === 1));
});
