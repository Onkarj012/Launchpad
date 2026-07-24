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
import {
  assessProductionReadiness,
  buildLocalReadinessEvidence,
} from './readiness.mjs';
import { installSchedules } from './install-schedule.mjs';
import { buildScheduleHealthReport } from './schedule-health.mjs';

function value(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
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

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? 'help';
  if (['help', '--help', '-h'].includes(command)) {
    process.stdout.write(buildCrawlerHelp());
    return 0;
  }
  const { config, path: configPath } = loadCrawlerConfig(value(argv, '--config', 'config/crawler-v2.json'));
  if (command === 'validate') {
    output({
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
    output(crawlerDiscoveryPlan(config, parseDiscoveryProfileArgs(argv, schedule)));
    return 0;
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
    output(result);
    return result.run.status === 'failed' ? 1 : 0;
  }
  if (command === 'readiness') {
    const result = localReadiness(config, argv);
    output(result);
    return result.assessment.productionReady ? 0 : 1;
  }
  if (command === 'install-schedule') {
    const dryRun = argv.includes('--dry-run');
    const result = installSchedules({ dryRun });
    output(result);
    return result.agents.every((agent) => agent.dryRun || agent.installed) ? 0 : 1;
  }
  if (command === 'schedule-health') {
    output(buildScheduleHealthReport({ databasePath: config.databasePath }));
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
