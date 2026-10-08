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
import { buildScheduleAgents, installSchedules } from './install-schedule.mjs';
import { computeCanaryVersion } from './canary-evaluator.mjs';
import { promoteSchedule, rollbackSchedule } from './release-manager.mjs';
import { buildScheduleHealthReport } from './schedule-health.mjs';
import { createJsonCanaryStore, loadDeliveryCanaryEvidence } from './delivery-canary.mjs';
import { acquireCrawlerRunLock } from './run-lock.mjs';
import { dailyRunIdentity } from './scheduler.mjs';
import { buildAvenueTrialReport } from './source-yield.mjs';
import { writeLocalDailyHtmlReport } from './local-lead-report.mjs';
import {
  DEFAULT_NOTIFICATION_LOG,
  notifyDesktop,
  notifyRunOutcome,
  persistNotificationReceipt,
} from './notify.mjs';
import { buildDeliveryReconciliation } from '../job-pull/mode-scoring.mjs';
import { createNotionV5Gateway, loadExternalCredential } from '../notion-v5/gateway.mjs';
import { assertExternalAuditReceiptPath, auditV5Journal, createTransactionJournal, writeAuditReceipt } from '../notion-v5/transaction.mjs';

function value(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

const ENV_CONFIG_PATHS = Object.freeze({
  production: 'config/crawler-v2.json',
  'live-test': 'config/crawler-v2-live-test.json',
  dev: 'config/crawler-v2-dev.json',
});

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
    const visit = (currentDirectory, currentRelative) => {
      for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        const entryRelative = path.join(currentRelative, entry.name);
        if (entry.isDirectory()) visit(path.join(currentDirectory, entry.name), entryRelative);
        else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(entryRelative);
      }
    };
    visit(directory, relative);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export function runReadinessTests({
  root = process.cwd(),
  inventory = discoverReadinessTests(root),
  spawn = spawnSync,
} = {}) {
  const files = [...inventory];
  if (files.length === 0) {
    return {
      inventory: files,
      status: null,
      signal: null,
      error: 'readiness test inventory is empty',
      stdout: '',
      stderr: '',
      testTotal: 0,
      passed: false,
    };
  }
  const result = spawn(process.execPath, ['--test', ...files], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  const stdout = String(result?.stdout ?? '');
  const stderr = String(result?.stderr ?? '');
  const testOutput = `${stdout}\n${stderr}`;
  const testTotal = Number(testOutput.match(/# tests\s+(\d+)/)?.[1] ?? 0);
  return {
    inventory: files,
    status: result?.status ?? null,
    signal: result?.signal ?? null,
    error: result?.error?.message ?? null,
    stdout,
    stderr,
    testTotal,
    passed: result?.status === 0 && testTotal > 0,
  };
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

export function parseDailyWriteOptions(args, schedule = 'morning') {
  const executeWrites = args.includes('--execute-writes');
  const credentialFile = explicitOption(args, '--credential-file');
  const journalPath = explicitOption(args, '--journal');
  const shortlistValue = explicitOption(args, '--shortlist-limit');
  const shortlistLimit = shortlistValue == null ? null : Number(shortlistValue);
  if (shortlistValue != null && (!Number.isInteger(shortlistLimit) || shortlistLimit < 1 || shortlistLimit > 20)) {
    throw new Error('--shortlist-limit must be an integer between 1 and 20');
  }
  if (!executeWrites && (credentialFile || journalPath)) {
    throw new Error('--credential-file and --journal require --execute-writes');
  }
  if (executeWrites) {
    const environment = explicitOption(args, '--env');
    const mode = String(value(args, '--mode', 'normal')).trim().toLowerCase();
    const locationPreset = String(value(args, '--location-preset', 'india')).trim().toLowerCase();
    if (String(schedule).trim().toLowerCase() !== 'morning') throw new Error('--execute-writes requires daily morning');
    if (environment !== 'production') throw new Error('--execute-writes requires --env production');
    if (explicitOption(args, '--config')) throw new Error('--execute-writes rejects arbitrary --config');
    if (mode !== 'normal') throw new Error('--execute-writes requires --mode normal');
    if (locationPreset !== 'pune') throw new Error('--execute-writes requires --location-preset pune');
    if (!credentialFile || !journalPath) throw new Error('--execute-writes requires --credential-file and --journal');
    if (!path.isAbsolute(credentialFile)) throw new Error('--credential-file must be an absolute path');
    if (!path.isAbsolute(journalPath)) throw new Error('--journal must be an absolute path');
  }
  return { executeWrites, credentialFile, journalPath, shortlistLimit };
}

export function parseAuditV5JournalArgs(args) {
  const credentialFile = explicitOption(args, '--credential-file');
  const journalPath = explicitOption(args, '--journal');
  const receiptPath = explicitOption(args, '--receipt');
  if (!credentialFile || !journalPath || !receiptPath) throw new Error('audit-v5-journal requires --credential-file, --journal, and --receipt');
  for (const [name, filePath] of [['--credential-file', credentialFile], ['--journal', journalPath], ['--receipt', receiptPath]]) {
    if (!path.isAbsolute(filePath)) throw new Error(`${name} must be an absolute path`);
  }
  return { credentialFile, journalPath, receiptPath };
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
  if (config.sources.hn?.enabled) ids.push('hn-discovery');
  if (config.sources.yc?.enabled) ids.push('yc-discovery');
  return ids;
}

function localReadiness(config, args) {
  const inventory = discoverReadinessTests();
  const runTests = args.includes('--run-tests');
  const testRun = runTests ? runReadinessTests({ inventory }) : null;
  const testOutput = `${testRun?.stdout ?? ''}\n${testRun?.stderr ?? ''}`;
  const testTotal = testRun?.testTotal ?? 0;
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
    testsPassed: runTests && !inventoryEmpty && testRun?.passed === true,
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
  evidence.testSummary = {
    ...evidence.testSummary,
    inventory,
    status: testRun?.status ?? null,
    signal: testRun?.signal ?? null,
    error: testRun?.error ?? null,
  };
  return {
    evidence,
    assessment: assessProductionReadiness(evidence),
    testExitCode: testRun?.status ?? null,
    testRun,
  };
}

export async function main(argv = process.argv.slice(2), {
  dailyRunner = runDailyNormal,
  notionGatewayFactory = createNotionV5Gateway,
  emit = output,
  notify = notifyDesktop,
  releaseApi = { promoteSchedule, rollbackSchedule },
} = {}) {
  const command = argv[0] ?? 'help';
  if (['help', '--help', '-h'].includes(command)) {
    process.stdout.write(buildCrawlerHelp());
    return 0;
  }
  if (command === 'audit-v5-journal') {
    const options = parseAuditV5JournalArgs(argv);
    assertExternalAuditReceiptPath(options.receiptPath);
    const credential = loadExternalCredential(options.credentialFile);
    const journal = createTransactionJournal({ journalPath: options.journalPath, requireExisting: true });
    const gateway = notionGatewayFactory({ live: true, credentialFile: options.credentialFile, journalPath: options.journalPath });
    const receipt = await auditV5Journal({ journal, gateway, secrets: [credential] });
    const writtenReceipt = writeAuditReceipt(options.receiptPath, receipt, undefined, [credential]);
    emit({ ...receipt, receiptPath: writtenReceipt });
    return receipt.phase4.blocked ? 1 : 0;
  }
  if (command === 'trial-yield') {
    const runsPath = explicitOption(argv, '--runs');
    if (!runsPath) throw new Error('trial-yield requires --runs FILE');
    const input = JSON.parse(fs.readFileSync(path.resolve(runsPath), 'utf8'));
    const runs = Array.isArray(input) ? input : input.runs;
    if (!Array.isArray(runs)) throw new Error('trial-yield requires an array of retained crawler reports');
    emit(buildAvenueTrialReport(runs, { trialStartDate: explicitOption(argv, '--trial-start') }));
    return 0;
  }
  const dailySchedule = command === 'daily' ? positional(argv)[1] ?? 'morning' : null;
  const dailyWriteOptions = command === 'daily'
    ? parseDailyWriteOptions(argv, dailySchedule)
    : null;
  const commandConfigPath = argv[0] === 'promote-schedule' && !explicitOption(argv, '--config') && !explicitOption(argv, '--env')
    ? 'config/crawler-v2.json'
    : resolveCrawlerConfigPath(argv);
  const { config, path: configPath } = loadCrawlerConfig(commandConfigPath);
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
    const schedule = dailySchedule;
    const writeOptions = dailyWriteOptions;
    const canaryEvidencePath = explicitOption(argv, '--canary-evidence');
    const canaryEvidence = loadDeliveryCanaryEvidence(canaryEvidencePath);
    const canaryStore = createJsonCanaryStore(value(argv, '--canary-log', 'logs/delivery-canary.json'));
    const lock = acquireCrawlerRunLock(value(argv, '--lock-path', path.join(config.databasePath ? path.dirname(config.databasePath) : '.local/launchpad-crawler', 'daily.lock')));
    try {
      const mode = value(argv, '--mode', 'normal');
      const locationPreset = value(argv, '--location-preset', 'india');
      const result = await dailyRunner({
        config,
        schedule,
        mode,
        locationPreset,
        runId: value(argv, '--run-id') ?? dailyRunIdentity({ schedule, mode, locationPreset }),
        scores: value(argv, '--scores-json'),
        // Production default: the in-run codex scorer is ON (docs/spec/match-scoring.md).
        // --no-scorer preserves the offline pre-scorer behaviour for debugging/replay;
        // --scores-json rows still win per-row inside normal-mode regardless.
        scorer: argv.includes('--no-scorer') ? null : 'codex',
        canaryEvidence,
        canaryStore,
        executeWrites: writeOptions.executeWrites,
        credentialFile: writeOptions.credentialFile,
        journalPath: writeOptions.journalPath,
        shortlistLimit: writeOptions.shortlistLimit,
        deferCanaryPersistence: writeOptions.executeWrites,
        notionGatewayFactory: writeOptions.executeWrites
          ? () => notionGatewayFactory({
            live: true,
            credentialFile: writeOptions.credentialFile,
            journalPath: writeOptions.journalPath,
          })
          : null,
      });
      const reportRunId = result.runId ?? value(argv, '--run-id') ?? dailyRunIdentity({ schedule, mode, locationPreset });
      const reportPath = explicitOption(argv, '--report')
        ?? path.join(path.dirname(path.resolve(config.databasePath)), 'reports', `${String(reportRunId).replace(/[^a-zA-Z0-9._-]/g, '_')}.html`);
      fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
      writeLocalDailyHtmlReport(result, reportPath);
      const terminalStatus = result.terminalEnvelope?.status ?? (result.outcome?.status === 'fatal' ? 'failed' : 'completed');
      const exitCode = terminalStatus === 'failed' ? 1 : 0;
      if (terminalStatus === 'partial' || result.deliveryReconciliation?.status === 'no-write') {
        emit({ ...result, notificationReceipt: null });
        return exitCode;
      }
      const freshCount = (result.shortlist ?? []).filter((candidate) => candidate.selectionTier === 'Strict' && ['Hot', 'Active'].includes(candidate.freshnessWindow)).length;
      const receipt = notifyRunOutcome({
        runId: result.runId ?? value(argv, '--run-id'),
        status: result.outcome?.status,
        outcome: result.outcome,
        schedule,
        mode,
        locationPreset,
        freshCount,
        error: result.outcome?.errors?.[0]?.message ?? result.outcome?.errors?.[0],
        notify,
      });
      const persistence = persistNotificationReceipt(receipt, value(argv, '--notification-log', DEFAULT_NOTIFICATION_LOG));
      const notificationReceipt = { ...receipt, persistence };
      const notificationFailed = notificationReceipt.sent !== true || notificationReceipt.persistence?.persisted !== true;
      let outcome = result.outcome;
      let deliveryCanary = result.deliveryCanary;
      let canaryPersistenceError = result.canaryPersistenceError ?? null;
      if (notificationFailed) {
        const error = {
          stage: 'notification',
          name: 'NotificationDeliveryError',
          message: notificationReceipt.reason
            ?? notificationReceipt.persistence?.reason
            ?? 'notification receipt was not delivered and persisted',
        };
        outcome = {
          ...(result.outcome ?? {}),
          status: 'degraded',
          fatal: false,
          degraded: true,
          errors: [...(result.outcome?.errors ?? []), error],
        };
        if (deliveryCanary) {
          deliveryCanary = {
            ...deliveryCanary,
            valid: false,
            preparedValid: deliveryCanary.valid === true,
            invalidReasons: [...(deliveryCanary.invalidReasons ?? []), `notification failed: ${error.message}`],
            persisted: false,
          };
        }
      }
      if (writeOptions.executeWrites && deliveryCanary) {
        try {
          canaryStore.append(deliveryCanary);
          deliveryCanary = { ...deliveryCanary, persisted: true };
        } catch (error) {
          canaryPersistenceError = {
            stage: 'delivery-canary-persistence',
            name: error.name || 'Error',
            code: error.code ?? null,
            message: error.message || String(error),
          };
          outcome = {
            ...(outcome ?? {}),
            status: 'degraded',
            fatal: false,
            degraded: true,
            errors: [...(outcome?.errors ?? []), canaryPersistenceError],
          };
          deliveryCanary = {
            ...deliveryCanary,
            valid: false,
            preparedValid: deliveryCanary.valid === true,
            invalidReasons: [...(deliveryCanary.invalidReasons ?? []), `canary persistence failed: ${canaryPersistenceError.message}`],
            persisted: false,
          };
        }
      }
      const currentDelivery = result.deliveryReconciliation;
      const deliveryReconciliation = currentDelivery
        ? buildDeliveryReconciliation({
          status: outcome?.degraded ? 'degraded' : currentDelivery.status,
          deliveryPlan: result.deliveryPlan,
          sourceCoverage: currentDelivery.sourceCoverage,
          rejectionReasons: currentDelivery.rejectionReasons,
          transaction: result.transaction,
          surfacedCount: currentDelivery.counts.opportunityLedgerSurfaced,
          ledgerRepairedCount: currentDelivery.counts.opportunityLedgerRepaired,
          canaryCount: deliveryCanary?.counts?.shortlist ?? currentDelivery.counts.canaryShortlist,
          canaryStatus: deliveryCanary?.valid === true ? 'valid' : 'invalid',
          notificationCount: 1,
          notificationStatus: notificationFailed ? 'failed' : 'sent',
          notificationReceipt,
        })
        : null;
      const terminalEnvelope = result.terminalEnvelope
        ? { ...result.terminalEnvelope, deliveryReconciliation }
        : result.terminalEnvelope;
      emit({ ...result, outcome, deliveryCanary, canaryPersistenceError, terminalEnvelope, deliveryReconciliation, notificationReceipt });
      return exitCode;
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
    const definitionPath = explicitOption(argv, '--schedule-definition');
    const definition = definitionPath ? JSON.parse(fs.readFileSync(definitionPath, 'utf8')) : null;
    const agents = definition ? buildScheduleAgents({
      configPath: definition.configPath,
      logDir: definition.logDir,
      labelPrefix: definition.labelPrefix,
      scheduleConfig: definition.scheduleConfig,
    }) : undefined;
    const result = installSchedules({ dryRun, agents });
    emit(result);
    return result.agents.every((agent) => agent.dryRun || agent.installed) ? 0 : 1;
  }
  if (command === 'promote-schedule') {
    const revision = explicitOption(argv, '--revision');
    if (!revision) throw new Error('--revision requires a full 40-hex commit');
    const canaryEvidence = loadDeliveryCanaryEvidence(value(argv, '--canary-log', 'logs/delivery-canary.json'));
    const result = await releaseApi.promoteSchedule({
      sourceRoot: process.cwd(),
      revision,
      canaryRecords: Array.isArray(canaryEvidence) ? canaryEvidence : canaryEvidence?.runs ?? [],
      canaryVersion: computeCanaryVersion({ config, root: process.cwd() }),
      config,
      releaseRoot: value(argv, '--release-root', undefined),
      releaseState: value(argv, '--release-state', undefined),
      mode: value(argv, '--mode', 'normal'),
      locationPreset: value(argv, '--location-preset', 'india'),
      dryRun: argv.includes('--dry-run'),
    });
    emit(result);
    return result.promoted || result.dryRun ? 0 : 1;
  }
  if (command === 'rollback-schedule') {
    const result = await releaseApi.rollbackSchedule({
      sourceRoot: process.cwd(),
      releaseState: value(argv, '--release-state', undefined),
      dryRun: argv.includes('--dry-run'),
    });
    emit(result);
    return result.rolledBack || result.dryRun ? 0 : 1;
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
