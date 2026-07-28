import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DELIVERY_CANARY_EVALUATION_SCHEMA = 'LaunchpadDeliveryCanaryEvaluationV1';
export const DEFAULT_CANARY_RUNS = 7;
export const ROUTINE_DURATION_LIMIT_MS = 45 * 60 * 1000;

const DEFAULT_CODE_PATHS = Object.freeze([
  'crawler/daily-runner.mjs',
  'crawler/daily-report.mjs',
  'crawler/workflow.mjs',
  'crawler/delivery-canary.mjs',
  'crawler/canary-evaluator.mjs',
  'crawler/cli.mjs',
  'config/crawler-v2.json',
  'config/match-score.schema.json',
  'job-pull/match-scorer.mjs',
  'job-pull/normal-mode.mjs',
  'job-pull/normal-selection.mjs',
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function computeCanaryVersion({
  config = {},
  root = process.cwd(),
  codePaths = DEFAULT_CODE_PATHS,
} = {}) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(stable(config)));
  for (const relative of [...codePaths].sort()) {
    const resolved = path.resolve(root, relative);
    hash.update(relative);
    hash.update(fs.existsSync(resolved) ? fs.readFileSync(resolved) : 'MISSING');
  }
  return `sha256:${hash.digest('hex')}`;
}

function orderedRuns(input) {
  return (Array.isArray(input) ? input : input?.runs ?? [])
    .slice()
    .sort((left, right) => String(left.runAt).localeCompare(String(right.runAt)));
}

function currentVersionStreak(runs) {
  if (!runs.length) return { version: null, runs: [], invalidRunIds: [] };
  const latest = runs.at(-1);
  const version = latest?.codeConfigVersion ?? null;
  const streak = [];
  const invalidRunIds = [];
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run?.valid !== true || (run.codeConfigVersion ?? null) !== version) {
      if (run?.valid !== true) invalidRunIds.push(run?.runId ?? null);
      break;
    }
    streak.unshift(run);
  }
  return { version, runs: streak, invalidRunIds: invalidRunIds.filter(Boolean) };
}

function versionChanges(runs) {
  const changes = [];
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1];
    const current = runs[index];
    if (previous.codeConfigVersion === current.codeConfigVersion) continue;
    changes.push({
      fromRunId: previous.runId,
      toRunId: current.runId,
      fromVersion: previous.codeConfigVersion ?? null,
      toVersion: current.codeConfigVersion ?? null,
    });
  }
  return changes;
}

function zeroGate(id, description, runs, field) {
  const failing = runs.filter((run) => !Number.isFinite(Number(run.engineering?.[field])) || Number(run.engineering[field]) !== 0);
  return {
    id,
    description,
    passed: runs.length > 0 && failing.length === 0,
    evidence: {
      evaluatedRunIds: runs.map((run) => run.runId),
      failingRunIds: failing.map((run) => run.runId),
      observed: Object.fromEntries(runs.map((run) => [run.runId, Number.isFinite(Number(run.engineering?.[field])) ? Number(run.engineering[field]) : null])),
      required: 0,
    },
  };
}

function durationGate(runs, limitMs) {
  const failing = runs.filter((run) => (
    !Number.isFinite(Number(run.engineering?.durationMs))
    || Number(run.engineering.durationMs) >= limitMs
  ));
  return {
    id: 'routine-duration',
    description: 'Every routine valid run completes in under 45 minutes.',
    passed: runs.length > 0 && failing.length === 0,
    evidence: {
      evaluatedRunIds: runs.map((run) => run.runId),
      failingRunIds: failing.map((run) => run.runId),
      durationMsByRun: Object.fromEntries(runs.map((run) => [run.runId, run.engineering?.durationMs ?? null])),
      limitMs,
      comparison: 'strictly-less-than',
    },
  };
}

function reportGate(runs) {
  const failing = runs.filter((run) => run.engineering?.reportComplete !== true);
  return {
    id: 'complete-local-report',
    description: 'Every valid run has a committed Markdown report and JSON sidecar.',
    passed: runs.length > 0 && failing.length === 0,
    evidence: {
      evaluatedRunIds: runs.map((run) => run.runId),
      failingRunIds: failing.map((run) => run.runId),
      reports: Object.fromEntries(runs.map((run) => [run.runId, {
        complete: run.engineering?.reportComplete === true,
        paths: run.engineering?.reportPaths ?? { markdown: null, json: null },
      }])),
    },
  };
}

export function evaluateDeliveryCanary(input = [], {
  requiredRuns = DEFAULT_CANARY_RUNS,
  durationLimitMs = ROUTINE_DURATION_LIMIT_MS,
} = {}) {
  const allRuns = orderedRuns(input);
  const streak = currentVersionStreak(allRuns);
  const runs = streak.runs;
  const changes = versionChanges(allRuns);
  const gates = [
    zeroGate('fatal-scorer-infrastructure', 'Zero fatal scorer infrastructure failures.', runs, 'fatalScorerInfrastructureFailures'),
    zeroGate('source-outage-truthfulness', 'Zero source outages reported as healthy.', runs, 'sourceOutagesReportedHealthy'),
    zeroGate('selected-suppression', 'Zero selected roles already suppressed.', runs, 'selectedSuppressedRoles'),
    zeroGate('post-commit-surfacing', 'Zero roles surfaced before delivery commit.', runs, 'rolesSurfacedBeforeCommit'),
    zeroGate('duplicate-requisition', 'Zero duplicate requisition collisions.', runs, 'duplicateRequisitionCollisions'),
    zeroGate('funnel-reconciliation', 'Zero unattributed funnel loss.', runs, 'unattributedFunnelLoss'),
    durationGate(runs, durationLimitMs),
    reportGate(runs),
    {
      id: 'seven-consecutive-valid-runs',
      description: 'Seven consecutive valid runs share one recorded code/config version.',
      passed: runs.length >= requiredRuns && Boolean(streak.version),
      evidence: {
        requiredRuns,
        consecutiveRuns: runs.length,
        runIds: runs.map((run) => run.runId),
        version: streak.version,
        versionChanges: changes,
      },
    },
  ];
  return {
    schemaVersion: DELIVERY_CANARY_EVALUATION_SCHEMA,
    passed: gates.every((gate) => gate.passed),
    streak: {
      count: runs.length,
      required: requiredRuns,
      version: streak.version,
      runIds: runs.map((run) => run.runId),
      invalidRunIds: streak.invalidRunIds,
      evaluatedRunCount: allRuns.length,
    },
    gates,
  };
}

export default evaluateDeliveryCanary;
