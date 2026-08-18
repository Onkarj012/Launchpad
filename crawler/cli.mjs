#!/usr/bin/env node

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildCrawlerHelp,
  crawlerDiscoveryPlan,
  loadCrawlerConfig,
  runCrawlerOperator,
} from './operator.mjs';
import { runDailyNormal } from './daily-runner.mjs';
import {
  assessProductionReadiness,
  buildLocalReadinessEvidence,
} from './readiness.mjs';
import { installSchedules } from './install-schedule.mjs';
import { buildScheduleHealthReport } from './schedule-health.mjs';
import { createJsonCanaryStore, loadDeliveryCanaryEvidence } from './delivery-canary.mjs';
import { acquireCrawlerRunLock } from './run-lock.mjs';
import { notifyDesktop, notifyRunOutcome } from './notify.mjs';

function value(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

const ENV_CONFIG_PATHS = Object.freeze({
  production: 'config/crawler-v2.json',
  'live-test': 'config/crawler-v2-live-test.json',
  dev: 'config/crawler-v2-dev.json',
});

export const READINESS_TEST_GLOBS = Object.freeze([
  'tests/crawler/*.test.mjs',
  'tests/job-pull/*.test.mjs',
  'tests/notion-v5/*.test.mjs',
  'tests/resume-v5/*.test.mjs',
  'tests/outreach-v5/*.test.mjs',
  'tests/v5/*.test.mjs',
]);

const READINESS_TEST_DIRS = Object.freeze([
  'tests/crawler',
  'tests/job-pull',
  'tests/notion-v5',
  'tests/resume-v5',
  'tests/outreach-v5',
  'tests/v5',
]);

export function discoverReadinessTests(root = process.cwd()) {
  const files = [];
  for (const relative of READINESS_TEST_DIRS) {
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).sort()) {
      if (name.endsWith('.test.mjs')) files.push(path.join(relative, name));
    }
  }
  return files;
}

function explicitOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const optionValue = args[index + 1];
  if (!optionValue || optionValue.startsWith('--')) throw new Error(`${name} requires a value`);
  return optionValue;
}

export function resolveCrawlerConfigPath(args) {
  const configPath = explicitOption(args, '--config');
  if (configPath) return configPath;
  const environment = explicitOption(args, '--env') ?? 'dev';
  if (!Object.hasOwn(ENV_CONFIG_PATHS, environment)) {
    throw new Error(`--env must be one of production, live-test, or dev; received: ${environment}`);
  }
  return ENV_CONFIG_PATHS[environment];
}

function positional(args) {
  return args.filter((item, index) => !item.startsWith('--') && (index === 0 || !args[index - 1].startsWith('--')));
}

export function parseDiscoveryProfileArgs(args, schedule = 'morning') {
  return {
    schedule,
    mode: value(args, '--mode', 'normal'),
    locationPreset: value(args, '--location-preset', 'india'),
  };
}

function output(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function configuredSourceIds(config) {
  const ids = [];
  if (config.sources.atsWarm?.boards?.length) ids.push('ats-warm');
  if (config.sources.atsBatch1?.boards?.length) ids.push('ats-batch-1');
  if (config.sources.atsBatch2?.boards?.length) ids.push('ats-batch-2');
  if (config.sources.enterprise?.boards?.length) ids.push('ats-enterprise');
  if (config.sources.careerSites?.length) ids.push('career-sites');
  if (config.sources.brave?.enabled) ids.push('brave-search');
  if (config.sources.searxng?.enabled) ids.push('searxng-search');
  if (config.sources.theirstack?.enabled) ids.push('theirstack');
  if (config.sources.indeed?.enabled) ids.push('indeed-inbox');
  if (config.sources.indiaStartup?.enabled) ids.push('india-startup');
  return ids;
}

function localReadiness(config, args) {
  const inventory = discoverReadinessTests();
  const runTests = args.includes('--run-tests');
  const testRun = runTests
    ? spawnSync(process.execPath, ['--test', ...READINESS_TEST_GLOBS], { cwd: process.cwd(), encoding: 'utf8', shell: true })
    : null;
  const testOutput = `${testRun?.stdout ?? ''}\n${testRun?.stderr ?? ''}`;
  const testTotal = Number(testOutput.match(/# tests (\d+)/)?.[1] ?? inventory.length);
  const inventoryEmpty = inventory.length === 0;
  const git = spawnSync('git', ['status', '--porcelain'], { cwd: process.cwd(), encoding: 'utf8' });
  const dirtyPaths = String(git.stdout ?? '').split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' });
  const receiptHash = `sha256:${createHash('sha256').update(testOutput).digest('hex')}`;
  const codeConfigVersion = `git:${String(revision.stdout ?? '').trim()}:dirty:${dirtyPaths.join('|') || 'clean'}`;
  const evidenceFile = value(args, '--operational-evidence');
  const operationalEvidence = evidenceFile ? JSON.parse(fs.readFileSync(path.resolve(evidenceFile), 'utf8')) : null;
  const braveKeyName = config.sources.brave?.apiKeyEnv ?? 'BRAVE_SEARCH_API_KEY';
  const theirStackKeyName = config.sources.theirstack?.apiKeyEnv ?? 'THEIRSTACK_API_KEY';
  const braveCredentialsAvailable = config.sources.brave?.enabled !== true || Boolean(process.env[braveKeyName]);
  const theirStackCredentialsAvailable = config.sources.theirstack?.enabled !== true || Boolean(process.env[theirStackKeyName]);
  const credentialsAvailable = braveCredentialsAvailable && theirStackCredentialsAvailable;
  const evidence = buildLocalReadinessEvidence({
    testsPassed: runTests && testRun.status === 0 && !inventoryEmpty && testTotal > 0,
    testTotal,
    dirtyPaths,
    operationalEvidence,
    sourceIds: configuredSourceIds(config),
    credentialsAvailable,
    evidenceProvenance: {
      schemaVersion: 'LaunchpadReadinessEvidenceV2',
      runId: `local-readiness-${receiptHash.slice(-12)}`,
      runAt: new Date().toISOString(),
      codeConfigVersion,
      receiptHash,
      recognized: true,
    },
  });
  return { evidence, assessment: assessProductionReadiness(evidence), testExitCode: testRun?.status ?? null };
}

export async function main(argv = process.argv.slice(2), { dailyRunner = runDailyNormal, emit = output, notify = notifyDesktop } = {}) {
  const command = argv[0] ?? 'help';
  if (['help', '--help', '-h'].includes(command)) {
    process.stdout.write(buildCrawlerHelp());
    return 0;
  }
  const { config, path: configPath } = loadCrawlerConfig(resolveCrawlerConfigPath(argv));
  if (command === 'validate') {
    emit({
      status: 'valid',
      configPath,
      databasePath: path.resolve(config.databasePath),
      sourceIds: configuredSourceIds(config),
      noAutoApply: true,
      noAutoSend: true,
    });
    return 0;
  }
  if (command === 'plan') {
    const schedule = positional(argv)[1] ?? 'morning';
    emit(crawlerDiscoveryPlan(config, parseDiscoveryProfileArgs(argv, schedule)));
    return 0;
  }
  if (command === 'daily') {
    const schedule = positional(argv)[1] ?? 'morning';
    const canaryEvidencePath = explicitOption(argv, '--canary-evidence');
    const canaryEvidence = loadDeliveryCanaryEvidence(canaryEvidencePath);
    const lock = acquireCrawlerRunLock(value(argv, '--lock-path', path.join(config.databasePath ? path.dirname(config.databasePath) : '.local/launchpad-crawler', 'daily.lock')));
    try {
      const result = await dailyRunner({
        config,
        schedule,
        mode: value(argv, '--mode', 'normal'),
        locationPreset: value(argv, '--location-preset', 'india'),
        runId: value(argv, '--run-id'),
        scores: value(argv, '--scores-json'),
        // Production default: the in-run codex scorer is ON (docs/spec/match-scoring.md).
        // --no-scorer preserves the offline pre-scorer behaviour for debugging/replay;
        // --scores-json rows still win per-row inside normal-mode regardless.
        scorer: argv.includes('--no-scorer') ? null : 'codex',
        canaryEvidence,
        canaryStore: createJsonCanaryStore(value(argv, '--canary-log', 'logs/delivery-canary.json')),
      });
      emit(result);
      const freshCount = (result.shortlist ?? []).filter((candidate) => candidate.selectionTier === 'Strict' && ['Hot', 'Active'].includes(candidate.freshnessWindow)).length;
      try {
        notifyRunOutcome({
          runId: result.runId,
          status: result.outcome?.status,
          schedule,
          mode: value(argv, '--mode', 'normal'),
          locationPreset: value(argv, '--location-preset', 'india'),
          freshCount,
          error: result.outcome?.errors?.[0]?.message ?? result.outcome?.errors?.[0],
          notify,
        });
      } catch {}
      return result.outcome?.status === 'fatal' ? 1 : 0;
    } finally {
      lock.release();
    }
  }
  if (command === 'run') {
    const schedule = positional(argv)[1] ?? 'morning';
    const profile = parseDiscoveryProfileArgs(argv, schedule);
    const result = await runCrawlerOperator({
      config,
      schedule,
      mode: profile.mode,
      locationPreset: profile.locationPreset,
      runId: value(argv, '--run-id'),
    });
    emit(result);
    return result.run.status === 'failed' ? 1 : 0;
  }
  if (command === 'readiness') {
    const result = localReadiness(config, argv);
    emit(result);
    return result.assessment.productionReady ? 0 : 1;
  }
  if (command === 'install-schedule') {
    const dryRun = argv.includes('--dry-run');
    const result = installSchedules({ dryRun });
    emit(result);
    return result.agents.every((agent) => agent.dryRun || agent.installed) ? 0 : 1;
  }
  if (command === 'schedule-health') {
    emit(buildScheduleHealthReport({ databasePath: config.databasePath }));
    return 0;
  }
  process.stderr.write(`Unknown crawler command: ${command}\n\n${buildCrawlerHelp()}`);
  return 2;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
