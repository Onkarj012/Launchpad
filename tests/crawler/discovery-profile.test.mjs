import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiscoveryProfile,
  DISCOVERY_PROFILE_SCHEMA_VERSION,
} from '../../crawler/discovery-profile.mjs';
import {
  crawlerDiscoveryPlan,
  runCrawlerOperator,
} from '../../crawler/operator.mjs';
import {
  discoverReadinessTests,
  main,
  parseDiscoveryProfileArgs,
  runReadinessTests,
} from '../../crawler/cli.mjs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

const notificationArgs = (root) => ['--notification-log', path.join(root, 'notification-receipts.jsonl')];
const testNotifier = () => ({ sent: false, reason: 'test notifier' });

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

test('readiness executes the discovered inventory directly without shell expansion', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'readiness-inventory-'));
  for (const relative of [
    'tests/crawler/second.test.mjs',
    'tests/crawler/first.test.mjs',
    'tests/crawler/nested/deep.test.mjs',
    'tests/job-pull/third.test.mjs',
  ]) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  const inventory = discoverReadinessTests(root);
  let invocation = null;
  const result = runReadinessTests({
    root,
    inventory,
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, signal: null, stdout: '# tests 3\n', stderr: '' };
    },
  });
  assert.deepEqual(inventory, [
    'tests/crawler/first.test.mjs',
    'tests/crawler/nested/deep.test.mjs',
    'tests/crawler/second.test.mjs',
    'tests/job-pull/third.test.mjs',
  ]);
  assert.deepEqual(invocation.args, ['--test', ...inventory]);
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.options.shell, false);
  assert.equal(result.testTotal, 3);
  assert.equal(result.passed, true);
});

test('readiness fails closed for empty, failing, and zero-test runs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'readiness-empty-'));
  const empty = runReadinessTests({ root, spawn: () => { throw new Error('must not spawn'); } });
  assert.equal(empty.passed, false);
  assert.equal(empty.testTotal, 0);
  assert.match(empty.error, /inventory is empty/);

  const failing = runReadinessTests({
    root,
    inventory: ['tests/crawler/only.test.mjs'],
    spawn: () => ({ status: 1, stdout: '# tests 1\n', stderr: 'failure' }),
  });
  assert.equal(failing.passed, false);

  const zero = runReadinessTests({
    root,
    inventory: ['tests/crawler/only.test.mjs'],
    spawn: () => ({ status: 0, stdout: '# tests 0\n', stderr: '' }),
  });
  assert.equal(zero.passed, false);
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

test('daily command invokes the unified runner and emits its operator result with local canary evidence', async () => {
  let received = null;
  let emitted = null;
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-'));
  const evidencePath = path.join(root, 'canary-evidence.json');
  const evidence = { schemaVersion: 'LaunchpadDeliveryCanaryEvidenceV1', runId: 'command-daily-1' };
  writeFileSync(evidencePath, JSON.stringify(evidence));
  const exitCode = await main(['daily', 'midday', '--env', 'dev', '--mode', 'remote', '--location-preset', 'pune', '--run-id', 'command-daily-1', '--canary-evidence', evidencePath, '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root)], {
    dailyRunner: async (options) => {
      received = options;
      return { schemaVersion: 'LaunchpadV5NormalModeV1', outcome: { status: 'ok' } };
    },
    emit: (result) => { emitted = result; },
    notify: testNotifier,
  });
  assert.equal(exitCode, 0);
  assert.equal(received.runId, 'command-daily-1');
  assert.equal(received.config.schemaVersion, 'LaunchpadCrawlerConfigV1');
  assert.equal(received.schedule, 'midday');
  assert.equal(received.mode, 'remote');
  assert.equal(received.locationPreset, 'pune');
  assert.deepEqual(received.canaryEvidence, evidence);
  assert.equal(emitted.outcome.status, 'ok');
  assert.deepEqual(emitted.notificationReceipt.discoveryProfile, {
    schedule: 'midday', mode: 'remote', locationPreset: 'pune',
  });
  assert.deepEqual(emitted.notificationReceipt.outcome, { status: 'ok', fatal: false, degraded: false });
  assert.equal(emitted.notificationReceipt.runId, 'command-daily-1');
  assert.equal(emitted.notificationReceipt.persistence.persisted, true);
  const persistedReceipt = JSON.parse(readFileSync(emitted.notificationReceipt.persistence.path, 'utf8').trim());
  const { persistence, ...receiptWithoutPersistence } = emitted.notificationReceipt;
  assert.deepEqual(persistedReceipt, receiptWithoutPersistence);
});

test('daily command passes missing canary evidence as nonfatal invalid evidence', async () => {
  let received = null;
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-'));
  const missingPath = path.join(root, 'missing-canary-evidence.json');
  const exitCode = await main(['daily', '--env', 'dev', '--canary-evidence', missingPath, '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root)], {
    dailyRunner: async (options) => {
      received = options;
      return { schemaVersion: 'LaunchpadV5NormalModeV1', outcome: { status: 'ok' } };
    },
    emit: () => {},
    notify: testNotifier,
  });
  assert.equal(exitCode, 0);
  assert.match(received.canaryEvidence.loadError, /failed to load canary evidence/);
});

test('daily command activates the codex scorer by default', async () => {
  let received = null;
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-'));
  const exitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-scorer-default', '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root)], {
    dailyRunner: async (options) => {
      received = options;
      return { schemaVersion: 'LaunchpadV5NormalModeV1', outcome: { status: 'ok' } };
    },
    emit: () => {},
    notify: testNotifier,
  });
  assert.equal(exitCode, 0);
  assert.equal(received.scorer, 'codex');
});

test('daily --no-scorer passes no scorer to the runner', async () => {
  let received = null;
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-'));
  const exitCode = await main(['daily', '--env', 'dev', '--no-scorer', '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root)], {
    dailyRunner: async (options) => {
      received = options;
      return { schemaVersion: 'LaunchpadV5NormalModeV1', outcome: { status: 'ok' } };
    },
    emit: () => {},
    notify: testNotifier,
  });
  assert.equal(exitCode, 0);
  assert.equal(received.scorer, null);
});

test('daily --scores-json with --no-scorer passes the scores path through and no scorer', async () => {
  let received = null;
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-'));
  const exitCode = await main(['daily', '--env', 'dev', '--scores-json', 'scores/manual.json', '--no-scorer', '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root)], {
    dailyRunner: async (options) => {
      received = options;
      return { schemaVersion: 'LaunchpadV5NormalModeV1', outcome: { status: 'ok' } };
    },
    emit: () => {},
    notify: testNotifier,
  });
  assert.equal(exitCode, 0);
  assert.equal(received.scores, 'scores/manual.json');
  assert.equal(received.scorer, null);
});

test('daily command notifies once when the run is fatal', async () => {
  const notifications = [];
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-'));
  const exitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-fatal', '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root)], {
    dailyRunner: async () => ({
      runId: 'command-daily-fatal',
      outcome: { status: 'fatal', errors: [{ message: 'source timeout' }] },
    }),
    emit: () => {},
    notify: (details) => { notifications.push(details); },
  });
  assert.equal(exitCode, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Launchpad — run failed');
  assert.match(notifications[0].message, /command-daily-fatal/);
  assert.match(notifications[0].message, /source timeout/);
});

test('daily command notifies once for fresh Strict Hot/Active matches', async () => {
  const notifications = [];
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-'));
  const exitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-fresh', '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root)], {
    dailyRunner: async () => ({
      runId: 'command-daily-fresh',
      outcome: { status: 'ok' },
      shortlist: [
        { selectionTier: 'Strict', freshnessWindow: 'Hot' },
        { selectionTier: 'Strict', freshnessWindow: 'Active' },
      ],
    }),
    emit: () => {},
    notify: (details) => { notifications.push(details); },
  });
  assert.equal(exitCode, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Launchpad — daily run');
  assert.match(notifications[0].message, /command-daily-fresh/);
  assert.match(notifications[0].message, /2 fresh matches/);
});

test('daily command still notifies a terminal receipt when there are no fresh strict matches', async () => {
  const notifications = [];
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-'));
  const exitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-no-fresh', '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root)], {
    dailyRunner: async () => ({
      runId: 'command-daily-no-fresh',
      outcome: { status: 'ok' },
      shortlist: [
        { selectionTier: 'strict', freshnessWindow: 'Warm' },
        { selectionTier: 'broad', freshnessWindow: 'Hot' },
      ],
    }),
    emit: () => {},
    notify: (details) => { notifications.push(details); },
  });
  assert.equal(exitCode, 0);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /command-daily-no-fresh/);
  assert.match(notifications[0].message, /0 fresh matches/);
});

test('daily keeps terminal exit codes and emits receipts when delivery or persistence fails', async () => {
  const fatalRoot = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-'));
  let fatalEmitted = null;
  const fatalExitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-notifier-failure', '--lock-path', path.join(fatalRoot, 'daily.lock'), ...notificationArgs(fatalRoot)], {
    dailyRunner: async () => ({ runId: 'command-daily-notifier-failure', outcome: { status: 'fatal' } }),
    emit: (result) => { fatalEmitted = result; },
    notify: () => { throw new Error('desktop unavailable'); },
  });
  assert.equal(fatalExitCode, 1);
  assert.equal(fatalEmitted.notificationReceipt.sent, false);
  assert.match(fatalEmitted.notificationReceipt.reason, /desktop unavailable/);
  assert.equal(fatalEmitted.notificationReceipt.persistence.persisted, true);

  const persistenceRoot = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-'));
  let persistenceEmitted = null;
  const persistenceExitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-persistence-failure', '--lock-path', path.join(persistenceRoot, 'daily.lock'), '--notification-log', persistenceRoot], {
    dailyRunner: async () => ({ runId: 'command-daily-persistence-failure', outcome: { status: 'ok' } }),
    emit: (result) => { persistenceEmitted = result; },
    notify: testNotifier,
  });
  assert.equal(persistenceExitCode, 0);
  assert.equal(persistenceEmitted.notificationReceipt.persistence.persisted, false);
  assert.equal(persistenceEmitted.notificationReceipt.outcome.fatal, false);
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
