import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { computeCanaryVersion, evaluateDeliveryCanary, normalizeCanaryDiscoveryProfile } from './canary-evaluator.mjs';
import { BROKEN_SCORER_REASON_CODES } from '../job-pull/mode-scoring.mjs';
import { fileURLToPath } from 'node:url';

export const DELIVERY_CANARY_SCHEMA = 'LaunchpadDeliveryCanaryV1';
export const DELIVERY_CANARY_EVIDENCE_SCHEMA = 'LaunchpadDeliveryCanaryEvidenceV1';
export const DELIVERY_CANARY_SIDECAR_SCHEMA = 'LaunchpadDeliveryCanarySidecarV1';
export const CANARY_ENGINEERING_ZERO_GATES = Object.freeze([
  'fatalScorerInfrastructureFailures',
  'sourceOutagesReportedHealthy',
  'selectedSuppressedRoles',
  'rolesSurfacedBeforeCommit',
  'duplicateRequisitionCollisions',
  'unattributedFunnelLoss',
]);
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

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function revisionAt(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 && nonemptyString(result.stdout) ? result.stdout.trim() : null;
}

function resolveReportPath(filePath, root, pathApi = path) {
  if (!nonemptyString(filePath)) return null;
  const resolved = pathApi.resolve(root, filePath);
  const relative = pathApi.relative(root, resolved);
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative)) ? resolved : null;
}

function validateReportFile(kind, filePath, { root, fsApi = fs, pathApi = path }) {
  const label = `canary evidence engineering.reportPaths.${kind}`;
  if (!nonemptyString(filePath)) return { resolved: null, reason: `${label} must be nonempty` };
  const resolved = resolveReportPath(filePath, root, pathApi);
  if (!resolved) return { resolved: null, reason: `${label} must resolve under approved root ${root}` };
  let stats;
  try {
    const inspect = typeof fsApi.lstatSync === 'function' ? fsApi.lstatSync.bind(fsApi) : fsApi.statSync.bind(fsApi);
    stats = inspect(resolved);
  } catch {
    return { resolved, reason: `${label} report is missing: ${resolved}` };
  }
  if (!stats.isFile()) return { resolved, reason: `${label} report is not a regular file: ${resolved}` };
  if (stats.size <= 0) return { resolved, reason: `${label} report is empty: ${resolved}` };
  return { resolved, reason: null };
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function reviewCandidate(candidate) {
  return {
    dedupKey: candidate?.dedupKey ?? null,
    canonicalUrl: candidate?.canonicalUrl ?? candidate?.url ?? null,
    company: candidate?.company ?? null,
    title: candidate?.title ?? candidate?.role ?? null,
    provider: candidate?.provider ?? candidate?.sourceProvider ?? null,
    sourceJobId: candidate?.sourceJobId ?? candidate?.providerJobId ?? candidate?.jobId ?? null,
    originalApplicationUrl: candidate?.originalApplicationUrl ?? null,
    matchScore: candidate?.matchScore ?? null,
    conversionScore: candidate?.conversionScore ?? null,
    responseLikelihood: candidate?.responseLikelihood ?? null,
    freshness: candidate?.freshnessWindow ?? candidate?.waterfallBand ?? candidate?.freshnessTier ?? null,
    selectionTier: candidate?.selectionTier ?? null,
    readiness: candidate?.applicationReadiness ?? candidate?.readiness ?? candidate?.applicationReady ?? null,
    rationale: candidate?.rationale ?? null,
    hook: candidate?.hook ?? null,
    payload: candidate?.payload ?? null,
    provenance: candidate?.provenance ?? null,
  };
}

export function computeDeliveryInventoryIdentity(shortlist = [], plannedNotionOperations = []) {
  if (!Array.isArray(shortlist)) throw new TypeError('delivery shortlist must be an array');
  if (!Array.isArray(plannedNotionOperations)) throw new TypeError('planned Notion operations must be an array');
  const inventory = {
    shortlist: shortlist.map(reviewCandidate),
    plannedNotionOperations,
  };
  return sha256(JSON.stringify(stable(inventory)));
}

function validateReportBinding({
  markdownPath,
  jsonPath,
  evidence,
  runId,
  codeConfigVersion,
  expectedRevision,
  inventoryIdentity,
  fsApi = fs,
}) {
  const reasons = [];
  let markdownBytes;
  try {
    markdownBytes = fsApi.readFileSync(markdownPath);
  } catch (error) {
    reasons.push(`failed to read canary Markdown report ${markdownPath}: ${error.message}`);
  }
  let sidecar;
  try {
    sidecar = JSON.parse(fsApi.readFileSync(jsonPath, 'utf8'));
  } catch (error) {
    reasons.push(`failed to parse canary JSON sidecar ${jsonPath}: ${error.message}`);
  }
  if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
    if (sidecar !== undefined) reasons.push('canary JSON sidecar must be an object');
    return { reasons, sidecar: null };
  }
  if (sidecar.schemaVersion !== DELIVERY_CANARY_SIDECAR_SCHEMA) reasons.push(`unrecognized canary JSON sidecar schema: ${sidecar.schemaVersion ?? 'missing'}`);
  const fields = [
    ['runId', runId],
    ['codeConfigVersion', codeConfigVersion],
    ['revision', expectedRevision],
    ['inventoryIdentity', inventoryIdentity],
  ];
  for (const [field, expected] of fields) {
    if (sidecar[field] !== expected) reasons.push(`canary JSON sidecar ${field} mismatch: expected ${expected ?? 'missing'}, received ${sidecar[field] ?? 'missing'}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(sidecar.markdownDigest ?? '')) {
    reasons.push('canary JSON sidecar markdownDigest must be sha256:<64 lowercase hex>');
  } else if (markdownBytes && sidecar.markdownDigest !== sha256(markdownBytes)) {
    reasons.push(`canary JSON sidecar markdownDigest mismatch for actual Markdown report: expected ${sha256(markdownBytes)}, received ${sidecar.markdownDigest}`);
  }
  return { reasons, sidecar };
}

export function loadDeliveryCanaryEvidence(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    return {
      schemaVersion: null,
      loadError: `failed to load canary evidence from ${resolved}: ${error.message}`,
    };
  }
}

export function validateDeliveryCanaryEvidence(evidence, {
  runId,
  codeConfigVersion,
  expectedRevision,
  inventoryIdentity,
  reportRoot = process.cwd(),
  fsApi = fs,
  pathApi = path,
} = {}) {
  const reasons = [];
  const engineering = evidence?.engineering;
  const reproducibility = evidence?.reproducibility;
  const approvedRoot = pathApi.resolve(reportRoot);
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    reasons.push('canary evidence must be an object');
  } else {
    if (nonemptyString(evidence.loadError)) reasons.push(evidence.loadError);
    if (evidence.schemaVersion !== DELIVERY_CANARY_EVIDENCE_SCHEMA) reasons.push(`unrecognized canary evidence schema: ${evidence.schemaVersion ?? 'missing'}`);
    if (evidence.runId !== runId) reasons.push(`canary evidence runId mismatch: expected ${runId}, received ${evidence.runId ?? 'missing'}`);
    if (evidence.codeConfigVersion !== codeConfigVersion) reasons.push(`canary evidence codeConfigVersion mismatch: expected ${codeConfigVersion}, received ${evidence.codeConfigVersion ?? 'missing'}`);
    if (!nonemptyString(inventoryIdentity)) reasons.push('current run inventoryIdentity must be nonempty');
    if (!nonemptyString(evidence.inventoryIdentity)) reasons.push('canary evidence inventoryIdentity must be nonempty');
    else if (evidence.inventoryIdentity !== inventoryIdentity) reasons.push(`canary evidence inventoryIdentity mismatch: expected ${inventoryIdentity ?? 'missing'}, received ${evidence.inventoryIdentity}`);
    if (!engineering || typeof engineering !== 'object' || Array.isArray(engineering)) {
      reasons.push('canary evidence engineering counters are missing');
    } else {
      for (const field of CANARY_ENGINEERING_ZERO_GATES) {
        if (!Number.isFinite(engineering[field])) reasons.push(`canary evidence engineering.${field} must be finite`);
      }
      if (!Number.isFinite(engineering.durationMs)) reasons.push('canary evidence engineering.durationMs must be finite');
      if (engineering.reportComplete !== true) reasons.push('canary evidence engineering.reportComplete must be true');
      const reportFiles = Object.fromEntries(['markdown', 'json'].map((kind) => [kind, validateReportFile(kind, engineering.reportPaths?.[kind], {
        root: approvedRoot,
        fsApi,
        pathApi,
      })]));
      for (const report of Object.values(reportFiles)) if (report.reason) reasons.push(report.reason);
      if (!reportFiles.markdown.reason && !reportFiles.json.reason) {
        const binding = validateReportBinding({
          markdownPath: reportFiles.markdown.resolved,
          jsonPath: reportFiles.json.resolved,
          evidence,
          runId,
          codeConfigVersion,
          expectedRevision,
          inventoryIdentity,
          fsApi,
        });
        reasons.push(...binding.reasons);
      }
      if (engineering.manualInventoryMatch !== true) reasons.push('canary evidence engineering.manualInventoryMatch must be true');
    }
    if (!reproducibility || typeof reproducibility !== 'object' || Array.isArray(reproducibility)) {
      reasons.push('canary evidence reproducibility details are missing');
    } else {
      if (!nonemptyString(expectedRevision)) reasons.push('expected canary revision must be nonempty');
      if (reproducibility.revision !== expectedRevision) reasons.push(`canary evidence reproducibility.revision mismatch: expected ${expectedRevision ?? 'missing'}, received ${reproducibility.revision ?? 'missing'}`);
      if (reproducibility.clean !== true) reasons.push('canary evidence reproducibility.clean must be true');
      if (!Array.isArray(reproducibility.dirtyPaths)) reasons.push('canary evidence reproducibility.dirtyPaths must be an array');
      else if (reproducibility.dirtyPaths.length !== 0) reasons.push('canary evidence reproducibility.dirtyPaths must be empty');
    }
  }
  return {
    valid: reasons.length === 0,
    reasons,
    engineering: engineering && typeof engineering === 'object' && !Array.isArray(engineering) ? engineering : {},
    reproducibility: reproducibility && typeof reproducibility === 'object' && !Array.isArray(reproducibility)
      ? reproducibility
      : { revision: null, clean: false, dirtyPaths: [] },
  };
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function runOutcomeReasons(run) {
  const reasons = [];
  const status = typeof run.outcome?.status === 'string' ? run.outcome.status.trim().toLowerCase() : null;
  if (run.outcome?.fatal === true || status === 'fatal') reasons.push('run outcome is fatal; canary promotion requires an ok run');
  if (run.outcome?.degraded === true || (status && status !== 'ok' && status !== 'fatal')) {
    reasons.push(`run outcome is degraded (${status ?? 'degraded'}); canary promotion requires status ok and degraded=false`);
  }
  if (!status) reasons.push('run outcome.status must be recorded as ok for canary promotion');
  return reasons;
}

function sourceManifestList(run) {
  if (Array.isArray(run.sourceManifests)) return run.sourceManifests;
  if (Array.isArray(run.sourceTelemetry)) return run.sourceTelemetry;
  if (run.sourceTelemetry && typeof run.sourceTelemetry === 'object') return Object.entries(run.sourceTelemetry).map(([sourceId, telemetry]) => ({ sourceId, ...telemetry }));
  return [];
}

function failedSourceCount(run) {
  const manifests = sourceManifestList(run);
  const failed = manifests.filter((manifest) => String(manifest?.status ?? '').trim().toLowerCase() === 'failed').length;
  const telemetryFailures = manifests.reduce((total, manifest) => total + count(manifest?.telemetry?.failures), 0);
  const nestedTelemetryFailures = manifests.reduce((total, manifest) => total + Object.values(manifest?.telemetry?.sources ?? {})
    .filter((source) => String(source?.status ?? '').trim().toLowerCase() === 'failed').length, 0);
  const failedLaneCount = list(run.shortfall?.failedLanes).length;
  return Math.max(failed, telemetryFailures, nestedTelemetryFailures, failedLaneCount);
}

function scorerFailureCount(run) {
  const scorer = run.scoring?.scorer;
  const reasonCodes = new Set([
    scorer?.reasonCode,
    ...list(scorer?.failures).map((failure) => failure?.reason ?? failure?.reasonCode ?? failure?.code),
    ...list(run.scoringQueue).map((candidate) => candidate?.scoringFailureReason),
  ].filter(Boolean));
  const broken = [...reasonCodes].some((code) => BROKEN_SCORER_REASON_CODES.has(code));
  const scoringFatal = (run.outcome?.fatal === true || String(run.outcome?.status ?? '').toLowerCase() === 'fatal')
    && list(run.outcome?.errors).some((error) => error?.stage === 'scoring' || /scor(?:er|ing)/i.test(error?.message ?? ''));
  return broken || scoringFatal ? 1 : 0;
}

function candidateKey(candidate) {
  if (candidate?.dedupKey) return candidate.dedupKey;
  if (candidate?.canonicalUrl ?? candidate?.url) return candidate.canonicalUrl ?? candidate.url;
  const providerKey = [candidate?.provider, candidate?.sourceJobId ?? candidate?.providerJobId ?? candidate?.jobId].filter(Boolean).join('|');
  return providerKey || null;
}

function selectedSuppressedCount(run) {
  const selected = new Set(list(run.shortlist).map(candidateKey).filter(Boolean));
  const suppressed = list(run.historicalSuppressions).map(candidateKey).filter(Boolean);
  return suppressed.filter((key) => selected.has(key)).length;
}

function rolesSurfacedBeforeCommitCount(run) {
  if (run.transaction?.committed === false && list(run.surfaced?.rows).length) return list(run.surfaced.rows).length;
  if (run.deliveryCommitted === false && list(run.surfaced?.rows).length) return list(run.surfaced.rows).length;
  return 0;
}

function duplicateRequisitionCollisionCount(run) {
  const explicit = run.duplicateRequisitionCollisions ?? run.identityCollisions ?? run.ambiguousHistoricalCollisions;
  return Array.isArray(explicit) ? explicit.length : Number.isFinite(Number(explicit)) ? Number(explicit) : 0;
}

function unattributedFunnelLossCount(run, deltas) {
  const attributed = run.reconciliation?.deltas
    ? deltas.reduce((total, stage) => total + stage.attributions
      .filter((item) => item.cause === 'unattributed')
      .reduce((sum, item) => sum + count(item.count), 0), 0)
    : 0;
  const funnelDelta = run.funnel?.reconciliation?.ok === false
    ? Math.max(1, Math.abs(count(run.funnel.reconciliation.delta)))
    : 0;
  return Math.max(attributed, funnelDelta);
}

function deriveEngineeringCounters(run, deltas) {
  return {
    fatalScorerInfrastructureFailures: scorerFailureCount(run),
    sourceOutagesReportedHealthy: failedSourceCount(run),
    selectedSuppressedRoles: selectedSuppressedCount(run),
    rolesSurfacedBeforeCommit: rolesSurfacedBeforeCommitCount(run),
    duplicateRequisitionCollisions: duplicateRequisitionCollisionCount(run),
    unattributedFunnelLoss: unattributedFunnelLossCount(run, deltas),
  };
}

function mergeEngineeringCounters(engineering, derived) {
  const effective = { ...engineering };
  const reasons = [];
  for (const field of CANARY_ENGINEERING_ZERO_GATES) {
    const observed = count(derived[field]);
    if (observed <= 0) continue;
    const reported = Number.isFinite(Number(engineering?.[field])) ? Number(engineering[field]) : 0;
    effective[field] = Math.max(reported, observed);
    if (reported < observed) reasons.push(`canary evidence engineering.${field} under-reports machine-observable run truth: reported ${reported}, derived ${observed}`);
  }
  return { engineering: effective, reasons };
}

function engineeringZeroGateReasons(engineering) {
  const reasons = [];
  for (const field of CANARY_ENGINEERING_ZERO_GATES) {
    const value = engineering?.[field];
    if (!Number.isFinite(value)) {
      reasons.push(`effective canary engineering.${field} must be finite and exactly 0, received ${String(value)}`);
    } else if (value !== 0) {
      reasons.push(`effective canary engineering.${field} must be exactly 0, received ${value}`);
    }
  }
  return reasons;
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

export function buildDeliveryCanary({
  run,
  clock,
  previousRuns = [],
  root = process.cwd(),
  expectedRevision = revisionAt(root),
  reportRoot = root,
  fsApi = fs,
  pathApi = path,
} = {}) {
  if (!run || typeof run !== 'object') throw new TypeError('buildDeliveryCanary requires the unified run result');
  const runAt = runAtFrom(clock ?? run.runAt ?? new Date());
  const runId = run.runId ?? `canary-${runAt}`;
  const codeConfigVersion = run.codeConfigVersion ?? computeCanaryVersion({ config: run.canaryConfig ?? {}, root });
  const inventoryIdentity = run.inventoryIdentity;
  const discoveryProfile = normalizeCanaryDiscoveryProfile(run.discoveryProfile);
  const evidence = validateDeliveryCanaryEvidence(run.canaryEvidence, {
    runId,
    codeConfigVersion,
    expectedRevision,
    inventoryIdentity,
    reportRoot,
    fsApi,
    pathApi,
  });
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
  const deltas = [
    delta('eligible', 'ready', [
      ['historical suppression', run.counts?.historicalSuppressed ?? causeValue(eligibleToReady, ['HISTORICAL_SUPPRESSION'])],
      ['readiness', causeValue(eligibleToReady, ['NOT_APPLICATION_READY', 'READINESS'])],
    ]),
    delta('ready', 'scoredPool', [
      [scoringFailureCause, scoringLoss],
      ['readiness', causeValue(readyToScored, ['READINESS'])],
    ]),
    delta('scoredPool', 'shortlist', [
      ['company cap', explicit.companyCap ?? causeValue(scoredToSelected, ['COMPANY_CAP', 'COMPANY_LIMIT', 'SELECTION_RULES', 'RUN_FAILED_INCOMPLETE_SCORING'])],
      ['diversity', explicit.diversity ?? causeValue(scoredToSelected, ['DIVERSITY'])],
      ['shortfall', explicit.shortfall ?? (causeValue(scoredToSelected, ['SHORTFALL']) || run.shortfall?.missing)],
    ]),
  ];
  const derivedEngineering = deriveEngineeringCounters(run, deltas);
  const effectiveEngineering = mergeEngineeringCounters(evidence.engineering, derivedEngineering);
  const current = {
    schemaVersion: DELIVERY_CANARY_SCHEMA,
    runId,
    runAt,
    counts,
    deltas,
    historySnapshot: {
      status: run.v4HistorySnapshot?.status ?? 'not-recorded',
      path: run.v4HistorySnapshot?.path ?? null,
      shortlistSize: counts.shortlist,
      shortlistBeforePopulation: null,
      shortlistAfterPopulation: null,
      note: null,
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
  const profileReasons = discoveryProfile ? [] : ['discoveryProfile must include valid schedule, mode, and locationPreset'];
  const outcomeReasons = runOutcomeReasons(run);
  const zeroGateReasons = engineeringZeroGateReasons(effectiveEngineering.engineering);
  current.valid = evidence.valid
    && profileReasons.length === 0
    && outcomeReasons.length === 0
    && effectiveEngineering.reasons.length === 0
    && zeroGateReasons.length === 0;
  current.invalidReasons = [
    ...evidence.reasons,
    ...profileReasons,
    ...outcomeReasons,
    ...effectiveEngineering.reasons,
    ...zeroGateReasons,
  ];
  current.codeConfigVersion = codeConfigVersion;
  current.discoveryProfile = discoveryProfile;
  current.inventoryIdentity = inventoryIdentity ?? null;
  current.outcome = {
    status: run.outcome?.status ?? null,
    fatal: run.outcome?.fatal === true,
    degraded: run.outcome?.degraded === true,
  };
  current.engineering = effectiveEngineering.engineering;
  current.derivedEngineering = derivedEngineering;
  current.revision = evidence.reproducibility.revision ?? null;
  current.clean = evidence.reproducibility.clean === true;
  current.dirtyPaths = Array.isArray(evidence.reproducibility.dirtyPaths) ? [...evidence.reproducibility.dirtyPaths] : [];
  return current;
}

function runAtFrom(clock) {
  const value = typeof clock === 'function'
    ? clock()
    : typeof clock?.now === 'function' ? clock.now() : clock;
  return runDate(value ?? new Date());
}

function assertCanaryPathWritable(resolved, fsApi = fs, pathApi = path) {
  if (fsApi.existsSync(resolved)) {
    fsApi.accessSync(resolved, fs.constants.W_OK);
    return;
  }
  let parent = pathApi.dirname(resolved);
  while (!fsApi.existsSync(parent)) {
    const next = pathApi.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  fsApi.accessSync(parent, fs.constants.W_OK);
}

function assertNoCanaryConflict(runs, run) {
  const existing = runs.find((item) => item.runId === run.runId);
  if (!existing) return null;
  if (JSON.stringify(existing) !== JSON.stringify(run)) {
    const error = new Error(`canary run ID already exists with different content: ${run.runId}`);
    error.code = 'CANARY_RUN_ID_CONFLICT';
    throw error;
  }
  return existing;
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
    preflight(run) {
      const runs = this.readRuns();
      const existing = assertNoCanaryConflict(runs, run);
      if (!existing) assertCanaryPathWritable(resolved);
      return { runs, existing };
    },
    append(run) {
      const runs = this.readRuns();
      const existing = assertNoCanaryConflict(runs, run);
      if (existing) return existing;
      runs.push(run);
      runs.sort((left, right) => String(left.runAt).localeCompare(String(right.runAt)));
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      const temporary = `${resolved}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: DELIVERY_CANARY_SCHEMA, runs }, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, resolved);
      return run;
    },
  };
}

export function prepareDeliveryCanary({ run, clock, store, ...validationOptions } = {}) {
  const previousRuns = store?.readRuns?.() ?? [];
  const record = buildDeliveryCanary({ run, clock, previousRuns, ...validationOptions });
  const preflight = store?.preflight?.(record);
  if (!store?.preflight) assertNoCanaryConflict(previousRuns, record);
  return { record, preflight: preflight ?? { runs: previousRuns, existing: null } };
}

export function recordDeliveryCanary({ run, clock, store, ...validationOptions } = {}) {
  const { record } = prepareDeliveryCanary({ run, clock, store, ...validationOptions });
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
    if (command === 'evaluate' && result.passed !== true) process.exitCode = 1;
  }
}
