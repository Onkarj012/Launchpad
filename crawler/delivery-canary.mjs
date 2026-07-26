import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateDeliveryCanary } from './canary-evaluator.mjs';

export const DELIVERY_CANARY_SCHEMA = 'LaunchpadDeliveryCanaryV1';
export const CANARY_CAUSES = Object.freeze([
  'historical suppression',
  'readiness',
  'company cap',
  'diversity',
  'shortfall',
  'scorer infrastructure failure',
  'scoring failure',
  'unattributed',
]);

function count(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function runDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('canary clock must be a valid date');
  return date.toISOString();
}

function causeValue(causes, names) {
  for (const name of names) {
    if (causes?.[name] != null) return count(causes[name]);
  }
  return 0;
}

function causeTotal(causes, names) {
  return names.reduce((total, name) => (
    causes?.[name] != null ? total + count(causes[name]) : total
  ), 0);
}

function allocate(delta, candidates) {
  const loss = Math.max(0, delta);
  if (!loss) {
    return delta < 0
      ? [{ cause: 'unattributed', count: Math.abs(delta), note: 'stage count increased' }]
      : [];
  }
  let remaining = loss;
  const attributions = [];
  for (const [cause, available] of candidates) {
    const assigned = Math.min(remaining, Math.max(0, count(available)));
    if (assigned) attributions.push({ cause, count: assigned });
    remaining -= assigned;
  }
  if (remaining) attributions.push({ cause: 'unattributed', count: remaining });
  return attributions;
}

function snapshotTransition(previousRuns, current) {
  const prior = [...previousRuns].reverse().find((run) => run.historySnapshot?.status === 'missing');
  if (!prior || current.historySnapshot.status !== 'loaded') return null;
  return {
    before: count(prior.counts?.shortlist),
    after: count(current.counts?.shortlist),
    note: 'Expected drop after the v4 history snapshot is populated; this is the snapshot working, not a regression.',
    beforeRunId: prior.runId,
    afterRunId: current.runId,
  };
}

function duplicateRequisitionCollisions(shortlist = []) {
  const seen = new Set();
  let collisions = 0;
  for (const candidate of shortlist) {
    const requisition = candidate.requisitionId ?? candidate.providerJobId ?? candidate.jobId;
    if (!requisition) continue;
    const key = `${candidate.provider ?? ''}|${requisition}`;
    if (seen.has(key)) collisions += 1;
    else seen.add(key);
  }
  return collisions;
}

function selectedSuppressedRoles(run) {
  const suppressed = new Set((run.historicalSuppressions ?? []).flatMap((row) => [
    row.canonicalUrl,
    row.candidate?.canonicalUrl,
    row.dedupKey,
  ]).filter(Boolean));
  return (run.shortlist ?? []).filter((candidate) => (
    candidate.suppression?.suppressed === true
    || candidate.historicalSuppressed === true
    || suppressed.has(candidate.canonicalUrl)
  )).length;
}

function sourceOutagesReportedHealthy(run) {
  return (run.sourceManifests ?? []).filter((manifest) => (
    ['ok', 'empty', 'success', 'succeeded', 'healthy'].includes(String(manifest.status).toLowerCase())
    && ((manifest.errors ?? []).length > 0
      || Number(manifest.failed ?? manifest.telemetry?.failed ?? manifest.telemetry?.adapterFailures ?? 0) > 0)
  )).length;
}

function fatalScorerInfrastructureFailures(run) {
  const scorer = run.scoring?.scorer;
  const scoringFatal = run.outcome?.fatal === true
    && run.outcome?.errors?.some((error) => error.stage === 'scoring');
  return scoringFatal && scorer?.degraded === true ? 1 : 0;
}

function unattributedLoss(run, deltas) {
  const dco = run.telemetry?.dco?.funnel?.reconciliation?.unresolvedCount;
  if (dco != null) return count(dco);
  return deltas.reduce((sum, delta) => sum + delta.attributions
    .filter((item) => item.cause === 'unattributed')
    .reduce((subtotal, item) => subtotal + count(item.count), 0), 0);
}

export function buildDeliveryCanary({ run, clock, previousRuns = [] } = {}) {
  if (!run || typeof run !== 'object') throw new TypeError('buildDeliveryCanary requires the unified run result');
  const runAt = runAtFrom(clock ?? run.runAt ?? new Date());
  const counts = {
    eligible: count(run.counts?.eligible ?? run.reconciliation?.eligible),
    scoredPool: count(run.counts?.scored ?? run.reconciliation?.scored),
    ready: count(run.counts?.ready ?? run.reconciliation?.ready),
    shortlist: count(run.counts?.selected ?? run.reconciliation?.selected ?? run.shortlist?.length),
  };
  const reconciliation = run.reconciliation?.causes ?? {};
  const eligibleToReady = reconciliation.eligibleToReady ?? {};
  const readyToScored = reconciliation.readyToScored ?? {};
  const scoredToSelected = reconciliation.scoredToSelected ?? {};
  const explicit = run.canaryAttribution ?? {};
  const scoringLoss = causeTotal(readyToScored, ['UNSCORED', 'SCORING_FAILED']);
  // Degraded infrastructure and healthy per-row failures are mutually exclusive labels.
  const scoringFailureCause = run.scoring?.scorer?.degraded === true
    ? 'scorer infrastructure failure'
    : 'scoring failure';
  const delta = (from, to, candidates) => ({
    from,
    to,
    fromCount: counts[from],
    toCount: counts[to],
    delta: counts[from] - counts[to],
    attributions: allocate(counts[from] - counts[to], candidates),
  });
  const current = {
    schemaVersion: DELIVERY_CANARY_SCHEMA,
    runId: run.runId ?? `canary-${runAt}`,
    runAt,
    counts,
    deltas: [
      delta('eligible', 'ready', [
        ['historical suppression', run.counts?.historicalSuppressed ?? causeValue(eligibleToReady, ['HISTORICAL_SUPPRESSION'])],
        ['readiness', causeValue(eligibleToReady, ['NOT_APPLICATION_READY', 'READINESS'])],
      ]),
      delta('ready', 'scoredPool', [
        [scoringFailureCause, scoringLoss],
        ['readiness', causeValue(readyToScored, ['READINESS'])],
      ]),
      delta('scoredPool', 'shortlist', [
        ['company cap', explicit.companyCap ?? causeValue(scoredToSelected, ['COMPANY_CAP', 'COMPANY_LIMIT'])],
        ['diversity', explicit.diversity ?? causeValue(scoredToSelected, ['DIVERSITY'])],
        ['shortfall', explicit.shortfall ?? run.shortfall?.missing ?? causeValue(scoredToSelected, ['SHORTFALL'])],
      ]),
    ],
    historySnapshot: {
      status: run.v4HistorySnapshot?.status ?? 'not-recorded',
      path: run.v4HistorySnapshot?.path ?? null,
      shortlistSize: counts.shortlist,
      shortlistBeforePopulation: null,
      shortlistAfterPopulation: null,
      note: null,
    },
    valid: run.canaryValid !== false && Boolean(run.runId),
    codeConfigVersion: run.canaryVersion ?? run.receipt?.codeConfigVersion ?? null,
  };
  current.engineering = {
    fatalScorerInfrastructureFailures: fatalScorerInfrastructureFailures(run),
    sourceOutagesReportedHealthy: sourceOutagesReportedHealthy(run),
    selectedSuppressedRoles: selectedSuppressedRoles(run),
    rolesSurfacedBeforeCommit: run.delivery?.surfacedBeforeCommit === true ? 1 : 0,
    duplicateRequisitionCollisions: duplicateRequisitionCollisions(run.shortlist),
    unattributedFunnelLoss: unattributedLoss(run, current.deltas),
    durationMs: run.telemetry?.dco?.operations?.durationMs ?? run.crawlerDeadline?.elapsedMs ?? null,
    reportComplete: run.delivery?.commitStatus === 'committed'
      && Boolean(run.delivery?.markdownPath)
      && Boolean(run.delivery?.jsonPath)
      && Boolean(run.delivery?.hashes?.markdown)
      && Boolean(run.delivery?.hashes?.json),
    reportPaths: {
      markdown: run.delivery?.markdownPath ?? null,
      json: run.delivery?.jsonPath ?? null,
    },
  };
  const transition = snapshotTransition(previousRuns, current);
  if (current.historySnapshot.status === 'missing') {
    current.historySnapshot.shortlistBeforePopulation = counts.shortlist;
    current.historySnapshot.note = 'Baseline before the v4 history snapshot is populated.';
  }
  if (transition) {
    current.historySnapshot.shortlistBeforePopulation = transition.before;
    current.historySnapshot.shortlistAfterPopulation = transition.after;
    current.historySnapshot.note = transition.note;
    current.historySnapshot.transition = transition;
  }
  return current;
}

function runAtFrom(clock) {
  const value = typeof clock === 'function'
    ? clock()
    : typeof clock?.now === 'function' ? clock.now() : clock;
  return runDate(value ?? new Date());
}

export function createJsonCanaryStore(filePath = 'logs/delivery-canary.json') {
  const resolved = path.resolve(filePath);
  return {
    path: resolved,
    readRuns() {
      if (!fs.existsSync(resolved)) return [];
      const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.runs) ? parsed.runs : [];
    },
    append(run) {
      const runs = this.readRuns().filter((item) => item.runId !== run.runId);
      runs.push(run);
      runs.sort((left, right) => String(left.runAt).localeCompare(String(right.runAt)));
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, `${JSON.stringify({ schemaVersion: DELIVERY_CANARY_SCHEMA, runs }, null, 2)}\n`, 'utf8');
      return run;
    },
  };
}

export function recordDeliveryCanary({ run, clock, store } = {}) {
  const previousRuns = store?.readRuns?.() ?? [];
  const record = buildDeliveryCanary({ run, clock, previousRuns });
  store?.append?.(record);
  return record;
}

export function compareDeliveryCanaryRuns(input = []) {
  const runs = Array.isArray(input) ? input : input?.runs ?? [];
  const ordered = [...runs].sort((left, right) => String(left.runAt).localeCompare(String(right.runAt)));
  const dayOverDay = ordered.slice(1).map((current, index) => {
    const previous = ordered[index];
    return {
      fromRunId: previous.runId,
      toRunId: current.runId,
      fromDate: previous.runAt,
      toDate: current.runAt,
      deltas: Object.fromEntries(Object.keys(current.counts ?? {}).map((key) => [
        key,
        count(current.counts?.[key]) - count(previous.counts?.[key]),
      ])),
      snapshotTransition: current.historySnapshot?.transition ?? null,
    };
  });
  return {
    schemaVersion: 'LaunchpadDeliveryCanaryComparisonV1',
    runCount: ordered.length,
    runs: ordered,
    dayOverDay,
  };
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const [command = 'compare', ...args] = process.argv.slice(2);
  if (!['compare', 'evaluate'].includes(command)) {
    process.stderr.write('Usage: node crawler/delivery-canary.mjs <compare|evaluate> --log <path>\n');
    process.exitCode = 2;
  } else {
    const index = args.indexOf('--log');
    const store = createJsonCanaryStore(index >= 0 ? args[index + 1] : undefined);
    const result = command === 'evaluate'
      ? evaluateDeliveryCanary(store.readRuns())
      : compareDeliveryCanaryRuns(store.readRuns());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
