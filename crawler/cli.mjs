#!/usr/bin/env node

import fs from 'node:fs';
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
import { createJsonCanaryStore } from './delivery-canary.mjs';
import { crawlerRunLockPath, withCrawlerRunLock } from './run-lock.mjs';

function value(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

const ENV_CONFIG_PATHS = Object.freeze({
  production: path.resolve('config/crawler-v2.json'),
  'live-test': path.resolve('config/crawler-v2-live-test.json'),
  dev: path.resolve('config/crawler-v2-dev.json'),
});

export const AUTHORITATIVE_PRODUCTION = Object.freeze({
  environment: 'production',
  configPath: ENV_CONFIG_PATHS.production,
  databasePath: path.resolve('.local/launchpad-crawler/crawler.sqlite'),
});

function explicitOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const optionValue = args[index + 1];
  if (!optionValue || optionValue.startsWith('--')) throw new Error(`${name} requires a value`);
  return optionValue;
}

export function resolveCrawlerEnvironment(args = []) {
  const configPath = explicitOption(args, '--config');
  const environmentOption = explicitOption(args, '--env');
  if (environmentOption && !Object.hasOwn(ENV_CONFIG_PATHS, environmentOption)) {
    throw new Error(`--env must be one of production, live-test, or dev; received: ${environmentOption}`);
  }
  if (configPath) {
    const resolvedConfigPath = path.resolve(configPath);
    const inferredEnvironment = Object.entries(ENV_CONFIG_PATHS)
      .find(([, candidate]) => candidate === resolvedConfigPath)?.[0] ?? null;
    if (environmentOption && inferredEnvironment && inferredEnvironment !== environmentOption) {
      throw new Error(`ambiguous crawler environment mapping: --env ${environmentOption} requires ${ENV_CONFIG_PATHS[environmentOption]}, received ${resolvedConfigPath}`);
    }
    if (environmentOption && resolvedConfigPath !== ENV_CONFIG_PATHS[environmentOption]) {
      throw new Error(`ambiguous crawler environment mapping: --env ${environmentOption} requires ${ENV_CONFIG_PATHS[environmentOption]}, received ${resolvedConfigPath}`);
    }
    return { environment: environmentOption ?? inferredEnvironment ?? 'custom', configPath: resolvedConfigPath };
  }
  const environment = environmentOption ?? 'production';
  return { environment, configPath: ENV_CONFIG_PATHS[environment] };
}

export function resolveCrawlerConfigPath(args) {
  return resolveCrawlerEnvironment(args).configPath;
}

export function validateCrawlerEnvironmentMapping({ environment, configPath, config } = {}) {
  const resolvedConfigPath = path.resolve(configPath);
  const databasePath = path.resolve(config?.databasePath ?? '');
  if (!databasePath || databasePath === path.resolve('.')) {
    throw new Error(`invalid ${environment} environment mapping: databasePath is required`);
  }
  if (environment === 'production') {
    if (resolvedConfigPath !== AUTHORITATIVE_PRODUCTION.configPath || databasePath !== AUTHORITATIVE_PRODUCTION.databasePath) {
      throw new Error(`invalid production environment mapping: expected config ${AUTHORITATIVE_PRODUCTION.configPath} and database ${AUTHORITATIVE_PRODUCTION.databasePath}; received config ${resolvedConfigPath} and database ${databasePath}`);
    }
    if (/live-test\.sqlite$/i.test(databasePath)) {
      throw new Error(`invalid production environment mapping: production cannot use ${databasePath}`);
    }
  }
  if (environment === 'dev' && databasePath !== path.resolve('.local/launchpad-crawler/dev.sqlite')) {
    throw new Error(`invalid dev environment mapping: expected database ${path.resolve('.local/launchpad-crawler/dev.sqlite')}; received ${databasePath}`);
  }
  if (environment === 'live-test' && !/live-test\.sqlite$/i.test(databasePath)) {
    throw new Error(`invalid live-test environment mapping: expected a *live-test.sqlite database; received ${databasePath}`);
  }
  return databasePath;
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
  if (config.sources.indeed?.enabled) ids.push('indeed-inbox');
  if (config.sources.indiaStartup?.enabled) ids.push('india-startup');
  return ids;
}

function localReadiness(config, args) {
  const runTests = args.includes('--run-tests');
  const testRun = runTests
    ? spawnSync(process.execPath, ['--test', 'tests/crawler/*.test.mjs'], { cwd: process.cwd(), encoding: 'utf8', shell: true })
    : null;
  const testOutput = `${testRun?.stdout ?? ''}\n${testRun?.stderr ?? ''}`;
  const testTotal = Number(testOutput.match(/# tests (\d+)/)?.[1] ?? 0);
  const git = spawnSync('git', ['status', '--porcelain'], { cwd: process.cwd(), encoding: 'utf8' });
  const dirtyPaths = String(git.stdout ?? '').split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
  const evidenceFile = value(args, '--operational-evidence');
  const operationalEvidence = evidenceFile ? JSON.parse(fs.readFileSync(path.resolve(evidenceFile), 'utf8')) : null;
  const braveKeyName = config.sources.brave?.apiKeyEnv ?? 'BRAVE_SEARCH_API_KEY';
  const credentialsAvailable = config.sources.brave?.enabled !== true || Boolean(process.env[braveKeyName]);
  const evidence = buildLocalReadinessEvidence({
    testsPassed: runTests && testRun.status === 0,
    testTotal,
    dirtyPaths,
    operationalEvidence,
    sourceIds: configuredSourceIds(config),
    credentialsAvailable,
  });
  return { evidence, assessment: assessProductionReadiness(evidence), testExitCode: testRun?.status ?? null };
}

export async function main(argv = process.argv.slice(2), { dailyRunner = runDailyNormal, emit = output } = {}) {
  const command = argv[0] ?? 'help';
  if (['help', '--help', '-h'].includes(command)) {
    process.stdout.write(buildCrawlerHelp());
    return 0;
  }
  const environmentSelection = resolveCrawlerEnvironment(argv);
  const { config, path: configPath } = loadCrawlerConfig(environmentSelection.configPath);
  const databasePath = validateCrawlerEnvironmentMapping({
    environment: environmentSelection.environment,
    configPath,
    config,
  });
  if (command === 'validate') {
    emit({
      status: 'valid',
      configPath,
      databasePath,
      environment: environmentSelection.environment,
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
    const profile = parseDiscoveryProfileArgs(argv, schedule);
    const result = await dailyRunner({
      config,
      configPath,
      databasePath,
      environment: environmentSelection.environment,
      schedule,
      mode: profile.mode,
      locationPreset: profile.locationPreset,
      runId: value(argv, '--run-id'),
      scores: value(argv, '--scores-json'),
      // Production default: the in-run codex scorer is ON (docs/spec/match-scoring.md).
      // --no-scorer preserves the offline pre-scorer behaviour for debugging/replay;
      // --scores-json rows still win per-row inside normal-mode regardless.
      scorer: argv.includes('--no-scorer') ? null : 'codex',
      canaryStore: createJsonCanaryStore(value(argv, '--canary-log', 'logs/delivery-canary.json')),
    });
    const outputResult = {
      ...result,
      receipt: result.receipt ?? {
        schemaVersion: 'LaunchpadCrawlerRunReceiptV1',
        configPath,
        databasePath,
        environment: environmentSelection.environment,
        schedule,
        mode: profile.mode,
        locationPreset: profile.locationPreset,
        runId: result.crawlerV2Run?.runId ?? value(argv, '--run-id'),
        noAutoApply: true,
        noAutoSend: true,
      },
    };
    emit(outputResult);
    return outputResult.outcome?.status === 'fatal' ? 1 : 0;
  }
  if (command === 'run') {
    const schedule = positional(argv)[1] ?? 'morning';
    const profile = parseDiscoveryProfileArgs(argv, schedule);
    const result = await withCrawlerRunLock(
      crawlerRunLockPath(databasePath),
      () => runCrawlerOperator({
        config,
        schedule,
        mode: profile.mode,
        locationPreset: profile.locationPreset,
        runId: value(argv, '--run-id'),
      }),
      { schedule, mode: profile.mode, locationPreset: profile.locationPreset },
    );
    const outputResult = {
      ...result,
      receipt: {
        schemaVersion: 'LaunchpadCrawlerRunReceiptV1',
        configPath,
        databasePath,
        environment: environmentSelection.environment,
        schedule,
        mode: profile.mode,
        locationPreset: profile.locationPreset,
        runId: result.run?.runId ?? value(argv, '--run-id'),
        noAutoApply: true,
        noAutoSend: true,
      },
    };
    emit(outputResult);
    return outputResult.run.status === 'failed' ? 1 : 0;
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
    emit(buildScheduleHealthReport({ databasePath }));
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
