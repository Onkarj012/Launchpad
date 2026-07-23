import { readLedger, validateLedger } from './ledger.mjs';
import { candidateDedupKey } from './candidate.mjs';
import { assertValidConfig, assertValidConversionPlan, loadConfig, loadConversionPlan } from './config.mjs';
import {
  ACTION_STATES,
  DEFAULT_OPPORTUNITY_LEDGER_PATH,
  readOpportunityLedger,
  validateOpportunityLedger,
} from './opportunity-ledger.mjs';
import { runPipeline } from './run.mjs';
import { isDeepStrictEqual } from 'node:util';

export const V5_MODES = Object.freeze(['normal', 'startup', 'remote']);
const MANIFEST_COUNTERS = Object.freeze(['fetched', 'dated', 'active', 'notVerified', 'eligible', 'duplicate', 'failed', 'selected']);

export class V5WorkflowError extends Error {
  constructor(message, stage = 'workflow') {
    super(message);
    this.name = 'V5WorkflowError';
    this.stage = stage;
  }
}

export function createNoWriteNotionGateway() {
  return {
    planWrites({ operations }) {
      return { status: 'planned', operations };
    },
  };
}

function normalizeMode(mode) {
  const normalized = String(mode ?? 'normal').toLowerCase();
  if (!V5_MODES.includes(normalized)) {
    throw new V5WorkflowError(`invalid v5 mode: ${mode}; expected normal, startup, or remote`, 'mode');
  }
  return normalized;
}

function readClock(clock) {
  const value = typeof clock === 'function' ? clock() : clock && typeof clock.now === 'function' ? clock.now() : clock;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new V5WorkflowError('invalid injected clock value', 'clock');
  return date.toISOString();
}

function manifestDefaults(manifest) {
  return {
    attempted: true,
    status: 'ok',
    fetched: 0,
    dated: 0,
    active: 0,
    notVerified: 0,
    eligible: 0,
    duplicate: 0,
    failed: 0,
    selected: 0,
    errors: [],
    ...manifest,
  };
}

function prepareSources(sourceResults) {
  if (!Array.isArray(sourceResults) || sourceResults.length === 0) {
    throw new V5WorkflowError('at least one fixture source result is required', 'manifest');
  }
  return sourceResults.map((source, index) => {
    if (!source || !Array.isArray(source.candidates)) {
      throw new V5WorkflowError(`source ${index + 1} candidates must be an array`, 'manifest');
    }
    if (!source.manifest || typeof source.manifest !== 'object' || Array.isArray(source.manifest)) {
      throw new V5WorkflowError(`source ${index + 1} manifest is required`, 'manifest');
    }
    const manifest = manifestDefaults(source.manifest);
    if (typeof manifest.sourceId !== 'string' || !manifest.sourceId.trim()) {
      throw new V5WorkflowError(`source ${index + 1} manifest sourceId is required`, 'manifest');
    }
    if (!['ok', 'degraded', 'failed', 'not-configured'].includes(manifest.status)) {
      throw new V5WorkflowError(`source ${manifest.sourceId} has invalid manifest status`, 'manifest');
    }
    if (!Array.isArray(manifest.errors)) {
      throw new V5WorkflowError(`source ${manifest.sourceId} manifest errors must be an array`, 'manifest');
    }
    for (const counter of MANIFEST_COUNTERS) {
      if (!Number.isFinite(manifest[counter]) || manifest[counter] < 0) {
        throw new V5WorkflowError(`source ${manifest.sourceId} has invalid manifest counter ${counter}`, 'manifest');
      }
    }
    return { candidates: source.candidates, manifest };
  });
}

function validateSourceIds(sources) {
  const seen = new Set();
  for (const source of sources) {
    if (seen.has(source.manifest.sourceId)) {
      throw new V5WorkflowError(`duplicate manifest sourceId ${source.manifest.sourceId}`, 'manifest');
    }
    seen.add(source.manifest.sourceId);
  }
  return sources;
}

function validateLedgerRows(rows) {
  if (!Array.isArray(rows)) throw new V5WorkflowError('ledger rows must be an array', 'ledger');
  const errors = [];
  const seen = new Map();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`row ${index + 1}: must be an object`);
      continue;
    }
    const state = row.state || 'committed';
    const key = row.dedup_key || row.dedupKey || '';
    if (!row.company) errors.push(`row ${index + 1}: company is empty`);
    if (!row.role) errors.push(`row ${index + 1}: role is empty`);
    if (!key) errors.push(`row ${index + 1}: dedup_key is empty`);
    if (!['pending', 'committed', 'aborted'].includes(state)) errors.push(`row ${index + 1}: invalid state ${state}`);
    if (key && seen.has(key) && state !== 'aborted' && seen.get(key).state !== 'aborted') {
      errors.push(`rows ${seen.get(key).index + 1} and ${index + 1}: duplicate dedup_key ${key}`);
    } else if (key) {
      seen.set(key, { index, state });
    }
  }
  if (errors.length) throw new V5WorkflowError(`ledger integrity failed: ${errors.join('; ')}`, 'ledger');
  return rows;
}

function loadLedgerRows({ ledgerPath, ledgerRows }) {
  if (ledgerPath) {
    const validation = validateLedger(ledgerPath);
    if (!validation.valid) throw new V5WorkflowError(`ledger integrity failed: ${validation.errors.join('; ')}`, 'ledger');
    return readLedger(ledgerPath).rows;
  }
  return validateLedgerRows(ledgerRows ?? []);
}

function validateOpportunityLedgerRows(rows) {
  if (!Array.isArray(rows)) throw new V5WorkflowError('opportunity ledger rows must be an array', 'opportunity-ledger');
  const errors = [];
  const seen = new Map();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`row ${index + 2}: must be an object`);
      continue;
    }
    if (!row.dedup_key) errors.push(`row ${index + 2}: dedup_key is empty`);
    if (!row.company) errors.push(`row ${index + 2}: company is empty`);
    if (!row.role) errors.push(`row ${index + 2}: role is empty`);
    if (!ACTION_STATES.includes(row.action_state)) errors.push(`row ${index + 2}: invalid action_state ${row.action_state}`);
    if (seen.has(row.dedup_key)) errors.push(`rows ${seen.get(row.dedup_key) + 2} and ${index + 2}: duplicate dedup_key ${row.dedup_key}`);
    else if (row.dedup_key) seen.set(row.dedup_key, index);
  }
  if (errors.length) throw new V5WorkflowError(`opportunity ledger integrity failed: ${errors.join('; ')}`, 'opportunity-ledger');
  return rows;
}

function loadOpportunityLedgerRows({ opportunityLedgerPath, opportunityLedgerRows }) {
  if (opportunityLedgerRows !== null && opportunityLedgerRows !== undefined) {
    return validateOpportunityLedgerRows(opportunityLedgerRows);
  }
  const ledgerPath = opportunityLedgerPath ?? DEFAULT_OPPORTUNITY_LEDGER_PATH;
  const validation = validateOpportunityLedger(ledgerPath);
  if (!validation.valid) {
    throw new V5WorkflowError(`opportunity ledger integrity failed: ${validation.errors.join('; ')}`, 'opportunity-ledger');
  }
  return readOpportunityLedger(ledgerPath).rows;
}

function sourceIssues(manifests) {
  return manifests.flatMap((manifest) => {
    const degraded = manifest.status !== 'ok' || manifest.errors.length > 0;
    if (!degraded) return [];
    return (manifest.errors.length ? manifest.errors : [`source status ${manifest.status}`]).map((message) => ({
      stage: 'source',
      sourceId: manifest.sourceId,
      message: String(message),
    }));
  });
}

function shortfallFor(pipeline, manifests) {
  const shortlist = pipeline.applicationShortlist;
  const reasons = [];
  if (shortlist.shortfalls.targetCount) reasons.push(`APPLICATION_READY_TARGET_SHORTFALL:${shortlist.shortfalls.targetCount}`);
  for (const [group, count] of Object.entries(shortlist.shortfalls.roles)) {
    if (count) reasons.push(`ROLE_GROUP_SHORTFALL:${group}:${count}`);
  }
  if (shortlist.shortfalls.directOrVc) reasons.push(`DIRECT_OR_VC_SHORTFALL:${shortlist.shortfalls.directOrVc}`);
  if (shortlist.shortfalls.indiaNiche) reasons.push(`INDIA_NICHE_SHORTFALL:${shortlist.shortfalls.indiaNiche}`);
  for (const manifest of manifests) {
    if (manifest.status !== 'ok' || manifest.errors.length) reasons.push(`SOURCE_DEGRADED:${manifest.sourceId}`);
  }
  const explanation = reasons.length
    ? `Application-ready shortlist is short by ${shortlist.shortfalls.targetCount}; ${reasons.join(', ')}.`
    : 'No application-ready shortlist shortfall.';
  return {
    target: shortlist.targetCount,
    selected: shortlist.selected.length,
    missing: shortlist.shortfalls.targetCount,
    strict: {
      target: pipeline.strictTarget,
      selected: pipeline.counts.strictSelected,
      missing: pipeline.strictShortfall,
    },
    details: shortlist.shortfalls,
    reasons,
    explanation,
  };
}

function fatalShortfall(config, message) {
  const target = config?.applicationShortlist?.targetCount ?? 10;
  return {
    target,
    selected: 0,
    missing: target,
    strict: { target: config?.run?.strictTarget ?? null, selected: 0, missing: null },
    details: null,
    reasons: ['FATAL_WORKFLOW'],
    explanation: `No shortlist was produced because the workflow failed: ${message}.`,
  };
}

function plannedOperations(pipeline, shortlist) {
  const recordsByUrl = new Map(pipeline.records.map((record) => [record.candidate.canonicalUrl, record]));
  return shortlist.map((candidate) => {
    const record = recordsByUrl.get(candidate.canonicalUrl);
    if (!record) throw new V5WorkflowError(`shortlist record missing for ${candidate.canonicalUrl}`, 'readiness');
    return {
      operation: 'create',
      resource: 'application',
      dedupKey: candidateDedupKey(candidate),
      payload: record.payload,
    };
  });
}

function errorRecord(error) {
  return {
    stage: error.stage || 'workflow',
    name: error.name || 'Error',
    message: error.message || String(error),
  };
}

function stableResult({ runId, runAt, mode, shortlist, verificationQueue, sourceManifests, shortfall, plannedNotionOperations, outcome, counts }) {
  return {
    schemaVersion: 'LaunchpadV5WorkflowV1',
    runId,
    runAt,
    mode,
    shortlist,
    verificationQueue,
    sourceManifests,
    sourceTelemetry: sourceManifests,
    shortfall,
    plannedNotionOperations,
    outcome,
    counts,
  };
}

export function runV5Workflow({
  mode = 'normal',
  clock = () => new Date().toISOString(),
  runId: suppliedRunId = null,
  sourceResults = [],
  notionGateway = createNoWriteNotionGateway(),
  config = null,
  conversionPlan = null,
  ledgerPath = null,
  ledgerRows = [],
  opportunityLedgerPath = null,
  opportunityLedgerRows = null,
} = {}) {
  const normalizedMode = normalizeMode(mode);
  const runAt = readClock(clock);
  const runId = suppliedRunId || `v5-${runAt}`;
  let sourceManifests = [];
  let loadedConfig = config;
  try {
    const sources = validateSourceIds(prepareSources(sourceResults));
    sourceManifests = sources.map((source) => source.manifest);
    loadedConfig ||= loadConfig();
    assertValidConfig(loadedConfig);
    const loadedConversionPlan = conversionPlan || loadConversionPlan();
    assertValidConversionPlan(loadedConversionPlan);
    const existingLedgerRows = loadLedgerRows({ ledgerPath, ledgerRows });
    const existingOpportunityLedgerRows = loadOpportunityLedgerRows({ opportunityLedgerPath, opportunityLedgerRows });
    const pipeline = runPipeline({
      config: loadedConfig,
      conversionPlan: loadedConversionPlan,
      now: runAt,
      runId,
      ledgerRows: existingLedgerRows,
      opportunityLedgerRows: existingOpportunityLedgerRows,
      sources,
      dryRun: true,
    });
    const operations = plannedOperations(pipeline, pipeline.applicationShortlist.selected);
    if (!notionGateway || typeof notionGateway.planWrites !== 'function') {
      throw new V5WorkflowError('notion gateway must implement planWrites', 'notion');
    }
    const authoritativeOperations = structuredClone(operations);
    const planned = notionGateway.planWrites({
      schemaVersion: 'LaunchpadV5PlanV1',
      mode: normalizedMode,
      runId,
      runAt,
      operations: structuredClone(authoritativeOperations),
    });
    const plannedNotionOperations = Array.isArray(planned) ? planned : planned?.operations;
    if (!Array.isArray(plannedNotionOperations)) {
      throw new V5WorkflowError('notion gateway planWrites must return an operations array', 'notion');
    }
    if (!isDeepStrictEqual(plannedNotionOperations, authoritativeOperations)) {
      throw new V5WorkflowError('notion gateway planWrites must return the authoritative operations unchanged', 'notion');
    }
    const issues = sourceIssues(pipeline.sourceManifests);
    const degraded = issues.length > 0;
    return stableResult({
      runId,
      runAt,
      mode: normalizedMode,
      shortlist: pipeline.applicationShortlist.selected,
      verificationQueue: pipeline.verifyQueue,
      sourceManifests: pipeline.sourceManifests,
      shortfall: shortfallFor(pipeline, pipeline.sourceManifests),
      plannedNotionOperations,
      outcome: { status: degraded ? 'degraded' : 'ok', fatal: false, degraded, errors: issues },
      counts: pipeline.counts,
    });
  } catch (error) {
    const failure = errorRecord(error);
    return stableResult({
      runId,
      runAt,
      mode: normalizedMode,
      shortlist: [],
      verificationQueue: [],
      sourceManifests,
      shortfall: fatalShortfall(loadedConfig, failure.message),
      plannedNotionOperations: [],
      outcome: { status: 'fatal', fatal: true, degraded: false, errors: [failure] },
      counts: null,
    });
  }
}
