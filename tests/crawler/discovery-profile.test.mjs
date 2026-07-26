import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiscoveryProfile,
  DISCOVERY_PROFILE_SCHEMA_VERSION,
} from '../../crawler/discovery-profile.mjs';
import {
  crawlerDiscoveryPlan,
  loadCrawlerConfig,
  runCrawlerOperator,
} from '../../crawler/operator.mjs';
import {
  AUTHORITATIVE_PRODUCTION,
  main,
  parseDiscoveryProfileArgs,
  resolveCrawlerEnvironment,
  validateCrawlerEnvironmentMapping,
} from '../../crawler/cli.mjs';
import { crawlerRunLockPath, withCrawlerRunLock } from '../../crawler/run-lock.mjs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const baseConfig = (databasePath) => ({
  schemaVersion: 'LaunchpadCrawlerConfigV1',
  databasePath,
  sources: {
    atsBatch1: { boards: [] },
    atsBatch2: { boards: [] },
    enterprise: { boards: [] },
    careerSites: [],
    brave: { enabled: false },
    indeed: { enabled: false },
    indiaStartup: { enabled: false },
    commercialRescue: { enabled: false },
  },
});

test('normalizes profile choices and rejects unsupported values', () => {
  const profile = buildDiscoveryProfile({ mode: ' STARTUP ', locationPreset: 'PUNE', schedule: 'MIDDAY' });
  assert.equal(profile.schemaVersion, DISCOVERY_PROFILE_SCHEMA_VERSION);
  assert.equal(profile.mode, 'startup');
  assert.equal(profile.locationPreset, 'pune');
  assert.equal(profile.schedule, 'midday');
  assert.throws(() => buildDiscoveryProfile({ mode: 'daily' }), /Unsupported mode/);
});

test('Pune changes source priority and hints without changing shared gate policy', () => {
  const india = buildDiscoveryProfile({ mode: 'normal', locationPreset: 'india' });
  const pune = buildDiscoveryProfile({ mode: 'normal', locationPreset: 'pune' });
  assert.deepEqual(pune.sourcePlan.lanes, india.sourcePlan.lanes);
  assert.equal(pune.gatePolicy, india.gatePolicy);
  assert.deepEqual(pune.sourcePlan.priority.slice(0, 2), ['pune-employers', 'pune-pcmc']);
  assert.ok(pune.sourcePlan.queryHints.includes('Pune'));
});

test('CLI and plan plumbing preserve defaults and expose explicit profile flags', () => {
  assert.deepEqual(parseDiscoveryProfileArgs(['plan', 'morning']), {
    schedule: 'morning', mode: 'normal', locationPreset: 'india',
  });
  assert.deepEqual(parseDiscoveryProfileArgs(['plan', 'midday', '--mode', 'remote', '--location-preset', 'pune'], 'midday'), {
    schedule: 'midday', mode: 'remote', locationPreset: 'pune',
  });

  const plan = crawlerDiscoveryPlan(baseConfig('/tmp/profile-plan.sqlite'), {
    schedule: 'morning', mode: 'startup', locationPreset: 'pune',
  });
  assert.equal(plan.profile.mode, 'startup');
  assert.equal(plan.profile.locationPreset, 'pune');
});

test('daily command invokes the unified runner with its schedule profile and emits its operator result', async () => {
  let received = null;
  let emitted = null;
  const exitCode = await main(['daily', 'midday', '--env', 'dev', '--mode', 'startup', '--location-preset', 'pune', '--run-id', 'command-daily-1'], {
    dailyRunner: async (options) => {
      received = options;
      return { schemaVersion: 'LaunchpadV5NormalModeV1', outcome: { status: 'ok' } };
    },
    emit: (result) => { emitted = result; },
  });
  assert.equal(exitCode, 0);
  assert.equal(received.runId, 'command-daily-1');
  assert.equal(received.schedule, 'midday');
  assert.equal(received.mode, 'startup');
  assert.equal(received.locationPreset, 'pune');
  assert.equal(received.config.schemaVersion, 'LaunchpadCrawlerConfigV1');
  assert.equal(emitted.outcome.status, 'ok');
});

test('daily command activates the codex scorer by default', async () => {
  let received = null;
  const exitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-scorer-default'], {
    dailyRunner: async (options) => {
      received = options;
      return { schemaVersion: 'LaunchpadV5NormalModeV1', outcome: { status: 'ok' } };
    },
    emit: () => {},
  });
  assert.equal(exitCode, 0);
  assert.equal(received.scorer, 'codex');
});

test('daily --no-scorer passes no scorer to the runner', async () => {
  let received = null;
  const exitCode = await main(['daily', '--env', 'dev', '--no-scorer'], {
    dailyRunner: async (options) => {
      received = options;
      return { schemaVersion: 'LaunchpadV5NormalModeV1', outcome: { status: 'ok' } };
    },
    emit: () => {},
  });
  assert.equal(exitCode, 0);
  assert.equal(received.scorer, null);
});

test('daily --scores-json with --no-scorer passes the scores path through and no scorer', async () => {
  let received = null;
  const exitCode = await main(['daily', '--env', 'dev', '--scores-json', 'scores/manual.json', '--no-scorer'], {
    dailyRunner: async (options) => {
      received = options;
      return { schemaVersion: 'LaunchpadV5NormalModeV1', outcome: { status: 'ok' } };
    },
    emit: () => {},
  });
  assert.equal(exitCode, 0);
  assert.equal(received.scores, 'scores/manual.json');
  assert.equal(received.scorer, null);
});

test('operator passes profile metadata into workflow config and result metadata', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-profile-'));
  const result = await runCrawlerOperator({
    config: baseConfig(path.join(root, 'crawler.sqlite')),
    runId: 'profile-run',
    mode: 'remote',
    locationPreset: 'pune',
    clock: { now: () => '2026-07-24T10:00:00.000Z' },
  });
  assert.equal(result.profile.mode, 'remote');
  assert.equal(result.profile.locationPreset, 'pune');
  assert.equal(result.operator.profile.mode, 'remote');
  assert.equal(result.operator.profile.locationPreset, 'pune');
});

test('production environment resolves the authoritative config and database pair', () => {
  const selection = resolveCrawlerEnvironment(['daily', 'morning', '--env', 'production']);
  const { config } = loadCrawlerConfig(selection.configPath);
  assert.equal(selection.environment, 'production');
  assert.equal(selection.configPath, AUTHORITATIVE_PRODUCTION.configPath);
  assert.equal(validateCrawlerEnvironmentMapping({ ...selection, config }), AUTHORITATIVE_PRODUCTION.databasePath);
});

test('production environment rejects a live-test database path', () => {
  assert.throws(() => validateCrawlerEnvironmentMapping({
    environment: 'production',
    configPath: AUTHORITATIVE_PRODUCTION.configPath,
    config: { databasePath: '.local/launchpad-crawler/live-test.sqlite' },
  }), /invalid production environment mapping/);
});

test('ambiguous environment mapping fails startup clearly', async () => {
  await assert.rejects(
    () => main(['validate', '--env', 'production', '--config', 'config/crawler-v2-dev.json']),
    /ambiguous crawler environment mapping/,
  );
});

test('daily receipt contains the resolved config and database paths', async () => {
  let emitted = null;
  await main(['daily', 'midday', '--env', 'dev'], {
    dailyRunner: async () => ({ outcome: { status: 'ok' } }),
    emit: (result) => { emitted = result; },
  });
  assert.equal(emitted.receipt.configPath, path.resolve('config/crawler-v2-dev.json'));
  assert.equal(emitted.receipt.databasePath, path.resolve('.local/launchpad-crawler/dev.sqlite'));
});

test('a concurrent second crawler run is refused by the lock', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-run-lock-'));
  const lockPath = crawlerRunLockPath(path.join(root, 'crawler.sqlite'));
  withCrawlerRunLock(lockPath, () => {
    assert.throws(
      () => withCrawlerRunLock(lockPath, () => {}),
      /crawler run refused: another run is already active/,
    );
  });
});
