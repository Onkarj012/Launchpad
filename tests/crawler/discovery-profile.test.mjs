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
import { main, parseDiscoveryProfileArgs, READINESS_TEST_GLOBS } from '../../crawler/cli.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

test('readiness uses the complete canonical deterministic Node test suite', () => {
  assert.deepEqual(READINESS_TEST_GLOBS, [
    'tests/crawler/*.test.mjs',
    'tests/job-pull/*.test.mjs',
    'tests/notion-v5/*.test.mjs',
    'tests/resume-v5/*.test.mjs',
    'tests/outreach-v5/*.test.mjs',
    'tests/v5/*.test.mjs',
  ]);
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
  const exitCode = await main(['daily', 'midday', '--env', 'dev', '--mode', 'remote', '--location-preset', 'pune', '--run-id', 'command-daily-1', '--canary-evidence', evidencePath, '--lock-path', path.join(root, 'daily.lock')], {
    dailyRunner: async (options) => {
      received = options;
      return { schemaVersion: 'LaunchpadV5NormalModeV1', outcome: { status: 'ok' } };
    },
    emit: (result) => { emitted = result; },
  });
  assert.equal(exitCode, 0);
  assert.equal(received.runId, 'command-daily-1');
  assert.equal(received.config.schemaVersion, 'LaunchpadCrawlerConfigV1');
  assert.equal(received.schedule, 'midday');
  assert.equal(received.mode, 'remote');
  assert.equal(received.locationPreset, 'pune');
  assert.deepEqual(received.canaryEvidence, evidence);
  assert.equal(emitted.outcome.status, 'ok');
});

test('daily command passes missing canary evidence as nonfatal invalid evidence', async () => {
  let received = null;
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-'));
  const missingPath = path.join(root, 'missing-canary-evidence.json');
  const exitCode = await main(['daily', '--env', 'dev', '--canary-evidence', missingPath, '--lock-path', path.join(root, 'daily.lock')], {
    dailyRunner: async (options) => {
      received = options;
      return { schemaVersion: 'LaunchpadV5NormalModeV1', outcome: { status: 'ok' } };
    },
    emit: () => {},
  });
  assert.equal(exitCode, 0);
  assert.match(received.canaryEvidence.loadError, /failed to load canary evidence/);
});

test('daily command activates the codex scorer by default', async () => {
  let received = null;
  const exitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-scorer-default', '--lock-path', path.join(mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-')), 'daily.lock')], {
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
  const exitCode = await main(['daily', '--env', 'dev', '--no-scorer', '--lock-path', path.join(mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-')), 'daily.lock')], {
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
  const exitCode = await main(['daily', '--env', 'dev', '--scores-json', 'scores/manual.json', '--no-scorer', '--lock-path', path.join(mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-')), 'daily.lock')], {
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

test('daily command notifies once when the run is fatal', async () => {
  const notifications = [];
  const exitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-fatal', '--lock-path', path.join(mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-')), 'daily.lock')], {
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
  const exitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-fresh', '--lock-path', path.join(mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-')), 'daily.lock')], {
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
  const exitCode = await main(['daily', '--env', 'dev', '--run-id', 'command-daily-no-fresh', '--lock-path', path.join(mkdtempSync(path.join(os.tmpdir(), 'crawler-command-lock-')), 'daily.lock')], {
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
