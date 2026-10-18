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
  parseDailyWriteOptions,
  parseDiscoveryProfileArgs,
  runReadinessTests,
} from '../../crawler/cli.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
// Keep fake CLI runs from writing reports into the shared checkout.
const isolatedReportArgs = (root) => ['--report', path.join(root, 'reports', 'fake-run.html')];
const testNotifier = () => ({ sent: true, reason: null });

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

test('strict daily write options accept only the morning production normal Pune profile', () => {
  const valid = [
    'daily', 'morning',
    '--env', 'production',
    '--mode', 'normal',
    '--location-preset', 'pune',
    '--execute-writes',
    '--credential-file', '/tmp/launchpad-notion-token',
    '--journal', '/tmp/launchpad-transaction-journal.jsonl',
    '--shortlist-limit', '1',
  ];
  assert.deepEqual(parseDailyWriteOptions(valid, 'morning'), {
    executeWrites: true,
    credentialFile: '/tmp/launchpad-notion-token',
    journalPath: '/tmp/launchpad-transaction-journal.jsonl',
    shortlistLimit: 1,
  });

  const replaceValue = (args, option, nextValue) => {
    const copy = [...args];
    copy[copy.indexOf(option) + 1] = nextValue;
    return copy;
  };
  const rejected = [
    [['daily', 'midday', ...valid.slice(2)], 'midday', /requires daily morning/],
    [replaceValue(valid, '--env', 'dev'), 'morning', /requires --env production/],
    [replaceValue(valid, '--env', 'live-test'), 'morning', /requires --env production/],
    [[...valid, '--config', '/tmp/custom.json'], 'morning', /rejects arbitrary --config/],
    [replaceValue(valid, '--mode', 'startup'), 'morning', /requires --mode normal/],
    [replaceValue(valid, '--mode', 'remote'), 'morning', /requires --mode normal/],
    [replaceValue(valid, '--location-preset', 'india'), 'morning', /requires --location-preset pune/],
    [replaceValue(valid, '--credential-file', 'relative-token'), 'morning', /credential-file must be an absolute path/],
    [replaceValue(valid, '--journal', 'relative-journal.jsonl'), 'morning', /journal must be an absolute path/],
    [['daily', '--env', 'production', '--credential-file', '/tmp/token'], 'morning', /require --execute-writes/],
    [['daily', '--env', 'production', '--mode', 'normal', '--location-preset', 'pune', '--execute-writes'], 'morning', /requires --credential-file and --journal/],
    [replaceValue(valid, '--shortlist-limit', '0'), 'morning', /shortlist-limit must be an integer between 1 and 20/],
  ];
  for (const [args, schedule, expected] of rejected) {
    assert.throws(() => parseDailyWriteOptions(args, schedule), expected);
  }
});

test('strict write CLI keeps credential paths lazy when runner returns no-write', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-strict-shadow-'));
  let gatewayFactoryCalls = 0;
  let received = null;
  let emitted = null;
  const credentialFile = path.join(root, 'missing-token');
  const journalPath = path.join(root, 'missing-journal.jsonl');
  const exitCode = await main([
    'daily', 'morning',
    '--env', 'production',
    '--mode', 'normal',
    '--location-preset', 'pune',
    '--execute-writes',
    '--credential-file', credentialFile,
    '--journal', journalPath,
    '--shortlist-limit', '1',
    '--run-id', 'strict-no-write-shadow',
    '--lock-path', path.join(root, 'daily.lock'), ...isolatedReportArgs(root),
  ], {
    dailyRunner: async (options) => {
      received = options;
      return {
        runId: 'strict-no-write-shadow',
        outcome: { status: 'ok' },
        deliveryReconciliation: { status: 'no-write' },
      };
    },
    notionGatewayFactory: () => { gatewayFactoryCalls += 1; throw new Error('must stay lazy'); },
    emit: (result) => { emitted = result; },
    notify: () => { throw new Error('no-write must not notify'); },
  });

  assert.equal(exitCode, 0);
  assert.equal(received.executeWrites, true);
  assert.equal(received.credentialFile, credentialFile);
  assert.equal(received.journalPath, journalPath);
  assert.equal(received.shortlistLimit, 1);
  assert.equal(typeof received.notionGatewayFactory, 'function');
  assert.equal(gatewayFactoryCalls, 0);
  assert.equal(emitted.notificationReceipt, null);
});

test('notification failure degrades write output and persists an invalid canary', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-notification-failure-'));
  const canaryLog = path.join(root, 'delivery-canary.json');
  const notificationLog = path.join(root, 'notification-receipts.jsonl');
  let emitted = null;
  const deliveryPlan = {
    status: 'planned',
    shortlist: [{ dedupKey: 'workday|req-1' }],
    plannedNotionOperations: [{ dedupKey: 'workday|req-1' }],
    selectedCount: 1,
    plannedV5OperationCount: 1,
  };
  const counts = {
    selected: 1,
    shortlist: 1,
    plannedV5Operations: 1,
    newlyCommitted: 1,
    alreadyCommitted: 0,
    failed: 0,
    recoveryBlocked: 0,
    deliveredKeys: 1,
    opportunityLedgerSurfaced: 1,
    opportunityLedgerRepaired: 0,
    canaryShortlist: 1,
    notification: null,
  };
  const exitCode = await main([
    'daily', 'morning',
    '--env', 'production',
    '--mode', 'normal',
    '--location-preset', 'pune',
    '--execute-writes',
    '--credential-file', path.join(root, 'missing-token'),
    '--journal', path.join(root, 'missing-journal.jsonl'),
    '--run-id', 'notification-failure',
    '--lock-path', path.join(root, 'daily.lock'),
    '--canary-log', canaryLog,
    '--notification-log', notificationLog, ...isolatedReportArgs(root),
  ], {
    dailyRunner: async () => ({
      runId: 'notification-failure',
      outcome: { status: 'ok', fatal: false, degraded: false, errors: [] },
      shortlist: deliveryPlan.shortlist,
      deliveryPlan,
      transaction: {
        status: 'committed',
        newlyCommitted: ['workday|req-1'],
        alreadyCommitted: [],
        failed: [],
        recovery: [],
        deliveredKeys: ['workday|req-1'],
      },
      deliveryReconciliation: {
        status: 'completed',
        counts,
        sourceCoverage: { completed: ['ats-enterprise'], interrupted: [], failed: [], not_started: [] },
        rejectionReasons: [],
      },
      deliveryCanary: {
        runId: 'notification-failure',
        runAt: '2026-08-30T06:30:00.000Z',
        valid: true,
        invalidReasons: [],
        counts: { shortlist: 1 },
        persisted: false,
      },
    }),
    emit: (result) => { emitted = result; },
    notify: () => ({ sent: false, reason: 'desktop unavailable' }),
  });

  assert.equal(exitCode, 0);
  assert.equal(emitted.outcome.status, 'degraded');
  assert.equal(emitted.deliveryCanary.valid, false);
  assert.equal(emitted.deliveryCanary.preparedValid, true);
  assert.equal(emitted.deliveryCanary.persisted, true);
  assert.ok(emitted.deliveryCanary.invalidReasons.some((reason) => /notification failed/.test(reason)));
  assert.ok(emitted.deliveryReconciliation.mismatchReasons.includes('NOTIFICATION_FAILED'));
  const persisted = JSON.parse(readFileSync(canaryLog, 'utf8'));
  assert.equal(persisted.runs.length, 1);
  assert.equal(persisted.runs[0].valid, false);
});

test('daily command invokes the unified runner and emits its operator result with local canary evidence', async () => {
  let received = null;
  let emitted = null;
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-'));
  const evidencePath = path.join(root, 'canary-evidence.json');
  const evidence = { schemaVersion: 'LaunchpadDeliveryCanaryEvidenceV1', runId: 'command-daily-1' };
  writeFileSync(evidencePath, JSON.stringify(evidence));
  const exitCode = await main(['daily', 'midday', '--env', 'dev', '--mode', 'remote', '--location-preset', 'pune', '--run-id', 'command-daily-1', '--canary-evidence', evidencePath, '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root), ...isolatedReportArgs(root)], {
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

test('daily command writes the local HTML report beside its configured database', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-report-'));
  const configPath = path.join(root, 'crawler.json');
  const databasePath = path.join(root, 'state', 'crawler.sqlite');
  writeFileSync(configPath, JSON.stringify(baseConfig(databasePath)));
  const runId = 'command-daily-report';
  const reportPath = path.join(root, 'state', 'reports', `${runId}.html`);
  const exitCode = await main([
    'daily', '--config', configPath, '--env', 'dev', '--run-id', runId,
    '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root),
  ], {
    dailyRunner: async () => ({ runId, runAt: '2026-10-08T02:15:00.000Z', modes: {} }),
    emit: () => {},
    notify: testNotifier,
  });

  assert.equal(exitCode, 0);
  assert.equal(existsSync(reportPath), true);
  assert.match(readFileSync(reportPath, 'utf8'), /Launchpad daily report/);
});

test('daily command passes missing canary evidence as nonfatal invalid evidence', async () => {
  let received = null;
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-'));
  const missingPath = path.join(root, 'missing-canary-evidence.json');
  const exitCode = await main(['daily', '--env', 'dev', '--canary-evidence', missingPath, '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root), ...isolatedReportArgs(root)], {
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
  const exitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-scorer-default', '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root), ...isolatedReportArgs(root)], {
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
  const exitCode = await main(['daily', '--env', 'dev', '--no-scorer', '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root), ...isolatedReportArgs(root)], {
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
  const exitCode = await main(['daily', '--env', 'dev', '--scores-json', 'scores/manual.json', '--no-scorer', '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root), ...isolatedReportArgs(root)], {
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
  const exitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-fatal', '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root), ...isolatedReportArgs(root)], {
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
  const exitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-fresh', '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root), ...isolatedReportArgs(root)], {
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
  const exitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-no-fresh', '--lock-path', path.join(root, 'daily.lock'), ...notificationArgs(root), ...isolatedReportArgs(root)], {
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
  const fatalExitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-notifier-failure', '--lock-path', path.join(fatalRoot, 'daily.lock'), ...notificationArgs(fatalRoot), ...isolatedReportArgs(fatalRoot)], {
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
  const persistenceExitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-persistence-failure', '--lock-path', path.join(persistenceRoot, 'daily.lock'), '--notification-log', persistenceRoot, ...isolatedReportArgs(persistenceRoot)], {
    dailyRunner: async () => ({ runId: 'command-daily-persistence-failure', outcome: { status: 'ok' } }),
    emit: (result) => { persistenceEmitted = result; },
    notify: testNotifier,
  });
  assert.equal(persistenceExitCode, 0);
  assert.equal(persistenceEmitted.notificationReceipt.persistence.persisted, false);
  assert.equal(persistenceEmitted.notificationReceipt.outcome.fatal, false);
});

test('daily CLI emits one partial envelope without notification or notification persistence', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-partial-'));
  let emitted = null;
  let notifications = 0;
  const exitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-partial', '--lock-path', path.join(root, 'daily.lock'), '--notification-log', path.join(root, 'notifications.json'), ...isolatedReportArgs(root)], {
    dailyRunner: async () => ({ runId: 'command-daily-partial', outcome: { status: 'partial' }, terminalEnvelope: { schemaVersion: 'LaunchpadDailyTerminalEnvelopeV1', status: 'partial', writesPlanned: false } }),
    emit: (result) => { emitted = result; },
    notify: () => { notifications += 1; },
  });
  assert.equal(exitCode, 0);
  assert.equal(notifications, 0);
  assert.equal(emitted.terminalEnvelope.status, 'partial');
  assert.equal(emitted.notificationReceipt, null);
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
