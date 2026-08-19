import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateProfileCanaries,
  promoteSchedule,
  rollbackSchedule,
} from '../../crawler/release-manager.mjs';

const REVISION_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REVISION_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CANARY_VERSION = 'sha256:release-test';

function tempFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-release-'));
  const sourceRoot = path.join(root, 'source');
  const releaseRoot = path.join(root, 'releases');
  const releaseState = path.join(root, 'state', 'receipt.json');
  const releaseLogDir = path.join(root, 'logs');
  const launchAgentsDir = path.join(root, 'launch-agents');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(releaseRoot, { recursive: true });
  writeFileSync(path.join(sourceRoot, 'config.json'), '{}\n');
  return { sourceRoot, releaseRoot, releaseState, releaseLogDir, launchAgentsDir };
}

function fakeGitFactory(state) {
  return (args, options = {}) => {
    const cwd = path.resolve(options.cwd);
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { status: 0, stdout: cwd === path.resolve(state.sourceRoot) ? state.sourceRevision : state.releaseRevision, stderr: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return { status: 0, stdout: args[2].slice(0, 40), stderr: '' };
    }
    if (args[0] === 'worktree') {
      const releasePath = args[3];
      mkdirSync(path.join(releasePath, 'crawler'), { recursive: true });
      writeFileSync(path.join(releasePath, 'crawler', 'cli.mjs'), '#!/usr/bin/env node\n');
      state.releaseRevision = args[4];
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
}

function canaryRecords() {
  return ['morning', 'midday'].flatMap((schedule) => Array.from({ length: 7 }, (_, index) => ({
    runId: `${schedule}-${index}`,
    runAt: `2026-08-${String(index + 1).padStart(2, '0')}T06:30:00.000Z`,
    valid: true,
    codeConfigVersion: CANARY_VERSION,
    discoveryProfile: { schedule, mode: 'normal', locationPreset: 'india' },
    engineering: {
      fatalScorerInfrastructureFailures: 0,
      sourceOutagesReportedHealthy: 0,
      selectedSuppressedRoles: 0,
      rolesSurfacedBeforeCommit: 0,
      duplicateRequisitionCollisions: 0,
      unattributedFunnelLoss: 0,
      durationMs: 1_000,
      reportComplete: true,
      reportPaths: { markdown: '/tmp/report.md', json: '/tmp/report.json' },
      manualInventoryMatch: true,
    },
  })));
}

function promotionOptions(fixture, state, overrides = {}) {
  return {
    ...fixture,
    sourceRoot: fixture.sourceRoot,
    revision: state.sourceRevision,
    canaryRecords: canaryRecords(),
    canaryVersion: CANARY_VERSION,
    git: fakeGitFactory(state),
    npm: () => ({ status: 0, stdout: '', stderr: '' }),
    launchAgentsDir: fixture.launchAgentsDir,
    clock: () => '2026-08-18T10:00:00.000Z',
    ...overrides,
  };
}

test('promotes an exact clean worktree only after all profile canaries and bootstraps pass', () => {
  const fixture = tempFixture();
  const state = { sourceRoot: fixture.sourceRoot, sourceRevision: REVISION_A, releaseRevision: REVISION_A };
  const calls = [];
  const result = promoteSchedule(promotionOptions(fixture, state, {
    launchctl: (args) => {
      calls.push(args);
      return { status: args[0] === 'bootstrap' ? 0 : 1, stdout: '', stderr: '' };
    },
  }));

  assert.equal(result.promoted, true);
  assert.equal(result.receipt.currentRelease.exactRevision, REVISION_A);
  assert.equal(result.receipt.currentRelease.releasePath, path.join(fixture.releaseRoot, REVISION_A));
  assert.equal(result.receipt.installed, true);
  assert.equal(calls.filter((args) => args[0] === 'bootstrap').length, 2);
  assert.ok(result.install.agents.every((agent) => agent.releaseRevision === REVISION_A && agent.releasePath.endsWith(REVISION_A)));
  for (const file of ['morning', 'midday']) {
    const plist = readFileSync(path.join(fixture.launchAgentsDir, `com.launchpad.crawler.${file}.plist`), 'utf8');
    assert.match(plist, new RegExp(`<string>${fixture.releaseRoot}/${REVISION_A}/crawler/cli\\.mjs</string>`));
    assert.match(plist, new RegExp(`<string>${fixture.releaseRoot}/${REVISION_A}</string>`));
  }
});

test('mixed or missing profile evidence blocks before git, npm, plist, or launchctl work', () => {
  const fixture = tempFixture();
  let calls = 0;
  const result = promoteSchedule(promotionOptions(fixture, { sourceRoot: fixture.sourceRoot, sourceRevision: REVISION_A, releaseRevision: REVISION_A }, {
    canaryRecords: canaryRecords().filter((record) => record.discoveryProfile.schedule === 'morning'),
    git: () => { calls += 1; throw new Error('git must not run'); },
    npm: () => { calls += 1; throw new Error('npm must not run'); },
    launchctl: () => { calls += 1; throw new Error('launchctl must not run'); },
  }));
  assert.equal(result.promoted, false);
  assert.equal(result.blocked, true);
  assert.equal(calls, 0);
  assert.equal(existsSync(fixture.releaseState), false);
  assert.equal(existsSync(path.join(fixture.releaseRoot, REVISION_A)), false);
});

test('failed bootstrap leaves the prior receipt bytes unchanged', () => {
  const fixture = tempFixture();
  const state = { sourceRoot: fixture.sourceRoot, sourceRevision: REVISION_A, releaseRevision: REVISION_A };
  promoteSchedule(promotionOptions(fixture, state, { launchctl: () => ({ status: 0, stdout: '', stderr: '' }) }));
  const before = readFileSync(fixture.releaseState, 'utf8');
  state.sourceRevision = REVISION_B;
  const result = promoteSchedule(promotionOptions(fixture, state, {
    launchctl: (args) => ({ status: args[0] === 'bootstrap' && args.some((item) => String(item).includes('midday')) ? 1 : 0, stdout: '', stderr: 'failed' }),
  }));
  assert.equal(result.promoted, false);
  assert.equal(result.receiptWritten, false);
  assert.equal(readFileSync(fixture.releaseState, 'utf8'), before);
});

test('historical canary versions before the requested seven-day streak do not block promotion', () => {
  const profile = { schedule: 'morning', mode: 'normal', locationPreset: 'india' };
  const base = canaryRecords().filter((record) => record.discoveryProfile.schedule === 'morning');
  const records = [
    ...base.map((record, index) => ({ ...record, runId: `old-${index}`, codeConfigVersion: 'sha256:old', runAt: `2026-08-${String(index + 1).padStart(2, '0')}T06:30:00.000Z` })),
    ...base.map((record, index) => ({ ...record, runId: `new-${index}`, codeConfigVersion: CANARY_VERSION, runAt: `2026-08-${String(index + 8).padStart(2, '0')}T06:30:00.000Z` })),
  ];
  const result = evaluateProfileCanaries({ records, profiles: [profile], canaryVersion: CANARY_VERSION });
  assert.equal(result.passed, true);
  assert.equal(result.profiles[0].evaluation.streak.version, CANARY_VERSION);
  assert.equal(result.profiles[0].evaluation.streak.dayCount, 7);
});

test('malformed prior current or previous receipt metadata fails before any mutation', () => {
  for (const [label, receipt] of [
    ['current', {
      schemaVersion: 'LaunchpadScheduleReleaseReceiptV1',
      currentRelease: { revision: REVISION_A, releasePath: '', canaryVersion: CANARY_VERSION, installedProfiles: [{ schedule: 'morning', mode: 'normal', locationPreset: 'india' }], timestamp: '2026-08-18T10:00:00.000Z', action: 'promote' },
      previousRelease: null,
    }],
    ['previous', {
      schemaVersion: 'LaunchpadScheduleReleaseReceiptV1',
      currentRelease: { revision: REVISION_A, releasePath: path.join('/tmp', REVISION_A), canaryVersion: CANARY_VERSION, installedProfiles: [{ schedule: 'morning', mode: 'normal', locationPreset: 'india' }], timestamp: '2026-08-18T10:00:00.000Z', action: 'promote' },
      previousRelease: { revision: REVISION_B, releasePath: path.join('/tmp', REVISION_B), canaryVersion: '', installedProfiles: [{ schedule: 'morning', mode: 'normal', locationPreset: 'india' }], timestamp: '2026-08-18T10:00:00.000Z', action: 'promote' },
    }],
  ]) {
    const fixture = tempFixture();
    mkdirSync(path.dirname(fixture.releaseState), { recursive: true });
    writeFileSync(fixture.releaseState, `${JSON.stringify(receipt)}\n`);
    const before = readFileSync(fixture.releaseState, 'utf8');
    let calls = 0;
    assert.throws(() => promoteSchedule(promotionOptions(fixture, { sourceRoot: fixture.sourceRoot, sourceRevision: REVISION_B, releaseRevision: REVISION_B }, {
      git: () => { calls += 1; throw new Error(`${label} git must not run`); },
      npm: () => { calls += 1; throw new Error('npm must not run'); },
      launchctl: () => { calls += 1; throw new Error('launchctl must not run'); },
    })), /(release path|canary version) is missing/);
    assert.equal(calls, 0);
    assert.equal(readFileSync(fixture.releaseState, 'utf8'), before);
    assert.equal(existsSync(path.join(fixture.releaseRoot, REVISION_B)), false);
  }
});

test('re-promoting the exact current revision preserves the existing rollback target', () => {
  const fixture = tempFixture();
  const state = { sourceRoot: fixture.sourceRoot, sourceRevision: REVISION_A, releaseRevision: REVISION_A };
  const launchctl = () => ({ status: 0, stdout: '', stderr: '' });
  promoteSchedule(promotionOptions(fixture, state, { launchctl }));
  state.sourceRevision = REVISION_B;
  promoteSchedule(promotionOptions(fixture, state, { launchctl }));
  const result = promoteSchedule(promotionOptions(fixture, state, { launchctl }));
  assert.equal(result.promoted, true);
  assert.equal(result.receipt.currentRelease.revision, REVISION_B);
  assert.equal(result.receipt.previousRelease.revision, REVISION_A);
});

test('rollback verifies and restores the retained prior release, then swaps receipt metadata', () => {
  const fixture = tempFixture();
  const state = { sourceRoot: fixture.sourceRoot, sourceRevision: REVISION_A, releaseRevision: REVISION_A };
  const install = (options) => ({ schemaVersion: 'test', agents: options.agents.map((agent) => ({ ...agent, installed: true })) });
  promoteSchedule(promotionOptions(fixture, state, { install }));
  state.sourceRevision = REVISION_B;
  promoteSchedule(promotionOptions(fixture, state, { install }));
  const result = rollbackSchedule({
    sourceRoot: fixture.sourceRoot,
    releaseState: fixture.releaseState,
    releaseLogDir: fixture.releaseLogDir,
    launchAgentsDir: fixture.launchAgentsDir,
    git: fakeGitFactory({ ...state, releaseRevision: REVISION_A }),
    install,
    clock: () => '2026-08-19T10:00:00.000Z',
  });
  assert.equal(result.rolledBack, true);
  assert.equal(result.receipt.currentRelease.revision, REVISION_A);
  assert.equal(result.receipt.previousRelease.revision, REVISION_B);
  assert.equal(result.receipt.action, 'rollback');
});

test('dry-run does not create a checkout, install npm, write plists, call launchctl, or write receipt', () => {
  const fixture = tempFixture();
  const state = { sourceRoot: fixture.sourceRoot, sourceRevision: REVISION_A, releaseRevision: REVISION_A };
  const result = promoteSchedule(promotionOptions(fixture, state, {
    dryRun: true,
    git: () => { throw new Error('git must not run'); },
    npm: () => { throw new Error('npm must not run'); },
    launchctl: () => { throw new Error('launchctl must not run'); },
  }));
  assert.equal(result.dryRun, true);
  assert.equal(existsSync(path.join(fixture.releaseRoot, REVISION_A)), false);
  assert.equal(existsSync(fixture.releaseState), false);
  assert.equal(existsSync(fixture.launchAgentsDir), false);
});

test('release roots and state receipts cannot be inside the source repository', () => {
  const fixture = tempFixture();
  assert.throws(() => promoteSchedule(promotionOptions(fixture, { sourceRoot: fixture.sourceRoot, sourceRevision: REVISION_A, releaseRevision: REVISION_A }, {
    releaseRoot: path.join(fixture.sourceRoot, 'releases'),
  })), /outside source repo/);
  assert.throws(() => promoteSchedule(promotionOptions(fixture, { sourceRoot: fixture.sourceRoot, sourceRevision: REVISION_A, releaseRevision: REVISION_A }, {
    releaseState: path.join(fixture.sourceRoot, 'receipt.json'),
  })), /outside source repo/);
});

test('profile evaluator rejects wrong-version evidence even when the run gates are healthy', () => {
  const profile = { schedule: 'morning', mode: 'normal', locationPreset: 'india' };
  const records = canaryRecords().filter((record) => record.discoveryProfile.schedule === 'morning')
    .map((record) => ({ ...record, codeConfigVersion: 'sha256:wrong' }));
  const result = evaluateProfileCanaries({ records, profiles: [profile], canaryVersion: CANARY_VERSION });
  assert.equal(result.passed, false);
  assert.match(result.profiles[0].reasons.join(' '), /version/);
});
