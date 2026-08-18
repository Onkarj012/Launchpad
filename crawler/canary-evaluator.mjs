import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DELIVERY_CANARY_EVALUATION_SCHEMA = 'LaunchpadDeliveryCanaryEvaluationV1';
export const DEFAULT_CANARY_RUNS = 7;
export const ROUTINE_DURATION_LIMIT_MS = 45 * 60 * 1000;

export const DEFAULT_CANARY_ENTRYPOINTS = Object.freeze([
  'crawler/daily-runner.mjs',
  'crawler/cli.mjs',
]);

const RELATIVE_IMPORT = /(?:import|export)\s+(?:[^'"\n]+from\s+)?['"](\.\.?\/[^'"]+)['"]/g;

export function collectTrackedModuleGraph(entrypoints = DEFAULT_CANARY_ENTRYPOINTS, { root = process.cwd() } = {}) {
  const files = new Set();
  const queue = [...entrypoints];
  while (queue.length) {
    const relative = queue.pop();
    if (files.has(relative)) continue;
    const resolved = path.resolve(root, relative);
    if (!fs.existsSync(resolved)) {
      throw new Error(`canary fingerprint missing tracked file: ${relative}`);
    }
    files.add(relative);
    if (!/\.(mjs|js|cjs)$/.test(relative)) continue;
    const source = fs.readFileSync(resolved, 'utf8');
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const spec = match[1].split('?')[0];
      const imported = path.normalize(path.join(path.dirname(relative), spec)).replaceAll('\\', '/');
      const withExt = [imported, `${imported}.mjs`, `${imported}.js`, path.join(imported, 'index.mjs')]
        .map((candidate) => candidate.replaceAll('\\', '/'))
        .find((candidate) => fs.existsSync(path.resolve(root, candidate)));
      if (withExt) queue.push(withExt);
    }
  }
  return [...files].sort();
}

export const DEFAULT_CANARY_CODE_PATHS = Object.freeze([
  'crawler/daily-runner.mjs',
  'crawler/operator.mjs',
  'crawler/ats-warm.mjs',
  'crawler/ats-batch-1.mjs',
  'crawler/ats-batch-2.mjs',
  'crawler/ats-enterprise.mjs',
  'crawler/brave-search.mjs',
  'crawler/chromium-fallback.mjs',
  'crawler/commercial-rescue.mjs',
  'crawler/connector-inbox.mjs',
  'crawler/discovery-profile.mjs',
  'crawler/indeed-inbox.mjs',
  'crawler/india-startup-lanes.mjs',
  'crawler/original-listing-resolver.mjs',
  'crawler/reserve.mjs',
  'crawler/run.mjs',
  'crawler/schedules.mjs',
  'crawler/theirstack.mjs',
  'crawler/v4-history-snapshot.mjs',
  'crawler/vc-portfolio-watchlist.mjs',
  'crawler/yc-discovery.mjs',
  'crawler/bounded-concurrency.mjs',
  'crawler/workflow.mjs',
  'crawler/delivery-canary.mjs',
  'crawler/canary-evaluator.mjs',
  'crawler/cli.mjs',
  'crawler/board-registry.mjs',
  'crawler/board-rotation-state.mjs',
  'crawler/historical-suppression.mjs',
  'crawler/identity.mjs',
  'career-ops/providers/workday.mjs',
  'config/crawler-v2.json',
  'config/reverse-warm-set.json',
  'config/vc-portfolio-watchlist.json',
  'config/job-pull.json',
  'config/conversion-plan.json',
  'config/board-registry.json',
  'config/match-score.schema.json',
  'job-pull/config.mjs',
  'job-pull/warm-set.mjs',
  'job-pull/run.mjs',
  'job-pull/candidate.mjs',
  'job-pull/eligibility.mjs',
  'job-pull/freshness.mjs',
  'job-pull/dedup.mjs',
  'job-pull/conversion-score.mjs',
  'job-pull/match-scorer.mjs',
  'job-pull/opportunity-ledger.mjs',
  'job-pull/mode-scoring.mjs',
  'job-pull/normal-mode.mjs',
  'job-pull/normal-readiness.mjs',
  'job-pull/normal-sources.mjs',
  'job-pull/normal-selection.mjs',
  'job-pull/workday-enrichment.mjs',
  'job-pull/startup-mode.mjs',
  'job-pull/startup-sources.mjs',
  'job-pull/startup-enrichment.mjs',
  'job-pull/startup-selection.mjs',
  'job-pull/remote-mode.mjs',
  'job-pull/remote-sources.mjs',
  'job-pull/remote-enrichment.mjs',
  'job-pull/remote-selection.mjs',
  'job-pull/remote-adapters/himalayas.mjs',
  'job-pull/remote-adapters/jobicy.mjs',
  'job-pull/remote-adapters/remoteok.mjs',
  'job-pull/remote-adapters/remotive.mjs',
  'job-pull/remote-adapters/weworkremotely.mjs',
  'career-ops/providers/himalayas.mjs',
  'career-ops/providers/jobicy.mjs',
  'career-ops/providers/weworkremotely.mjs',
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function computeCanaryVersion({
  config = {},
  root = process.cwd(),
  codePaths,
  entrypoints = DEFAULT_CANARY_ENTRYPOINTS,
} = {}) {
  const paths = codePaths
    ? [...codePaths]
    : [...new Set([...collectTrackedModuleGraph(entrypoints, { root }), ...DEFAULT_CANARY_CODE_PATHS])];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(stable(config)));
  for (const relative of [...paths].sort()) {
    const resolved = path.resolve(root, relative);
    if (!fs.existsSync(resolved)) {
      throw new Error(`canary fingerprint missing tracked file: ${relative}`);
    }
    hash.update(relative);
    hash.update(fs.readFileSync(resolved));
  }
  return `sha256:${hash.digest('hex')}`;
}

function orderedRuns(input) {
  return (Array.isArray(input) ? input : input?.runs ?? [])
    .slice()
    .sort((left, right) => String(left.runAt).localeCompare(String(right.runAt)));
}

const DISCOVERY_PROFILE_FIELDS = Object.freeze(['schedule', 'mode', 'locationPreset']);
const DISCOVERY_PROFILE_VALUES = Object.freeze({
  schedule: new Set(['morning', 'midday']),
  mode: new Set(['normal', 'startup', 'remote']),
  locationPreset: new Set(['india', 'pune']),
});

export function normalizeCanaryDiscoveryProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const normalized = {};
  for (const field of DISCOVERY_PROFILE_FIELDS) {
    if (typeof profile[field] !== 'string') return null;
    const value = profile[field].trim().toLowerCase();
    if (!DISCOVERY_PROFILE_VALUES[field].has(value)) return null;
    normalized[field] = value;
  }
  return normalized;
}

function sameDiscoveryProfile(left, right) {
  return DISCOVERY_PROFILE_FIELDS.every((field) => left?.[field] === right?.[field]);
}

function currentVersionStreak(runs) {
  if (!runs.length) return { version: null, discoveryProfile: null, runs: [], invalidRunIds: [] };
  const latest = runs.at(-1);
  const version = latest?.codeConfigVersion ?? null;
  const discoveryProfile = normalizeCanaryDiscoveryProfile(latest?.discoveryProfile);
  const streak = [];
  const invalidRunIds = [];
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    const runProfile = normalizeCanaryDiscoveryProfile(run?.discoveryProfile);
    if (run?.valid !== true || !discoveryProfile || !runProfile
      || (run.codeConfigVersion ?? null) !== version
      || !sameDiscoveryProfile(runProfile, discoveryProfile)) {
      if (run?.valid !== true || !runProfile) invalidRunIds.push(run?.runId ?? null);
      break;
    }
    streak.unshift(run);
  }
  return { version, discoveryProfile, runs: streak, invalidRunIds: invalidRunIds.filter(Boolean) };
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

function manualInventoryGate(runs) {
  const failing = runs.filter((run) => run.engineering?.manualInventoryMatch !== true);
  return {
    id: 'manual-inventory-match',
    description: 'Every valid run matches the manually verified delivery inventory.',
    passed: runs.length > 0 && failing.length === 0,
    evidence: {
      evaluatedRunIds: runs.map((run) => run.runId),
      failingRunIds: failing.map((run) => run.runId),
      observed: Object.fromEntries(runs.map((run) => [run.runId, run.engineering?.manualInventoryMatch === true])),
      required: true,
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
    manualInventoryGate(runs),
    {
      id: 'seven-consecutive-valid-runs',
      description: 'Seven consecutive valid runs share one recorded code/config version and normalized discovery profile.',
      passed: runs.length >= requiredRuns && Boolean(streak.version) && Boolean(streak.discoveryProfile),
      evidence: {
        requiredRuns,
        consecutiveRuns: runs.length,
        runIds: runs.map((run) => run.runId),
        version: streak.version,
        discoveryProfile: streak.discoveryProfile,
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
      discoveryProfile: streak.discoveryProfile,
      runIds: runs.map((run) => run.runId),
      invalidRunIds: streak.invalidRunIds,
      evaluatedRunCount: allRuns.length,
    },
    gates,
  };
}

export default evaluateDeliveryCanary;
