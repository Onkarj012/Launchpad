import { discoverBraveSearch } from './brave-search.mjs';
import { discoverCompanyCareers, companyCareerProgress } from './company-careers.mjs';
import { filterHistoricalCandidates } from './historical-suppression.mjs';
import {
  canonicalizeApplicationUrl,
  isApplicationReady,
  lifecycleFromObservation,
  normalizeText,
  resolveJobIdentity,
} from './identity.mjs';
import { selectDailyReserve } from './reserve.mjs';
import { buildSourceYieldReport, buildSourceEndStates } from './source-yield.mjs';
import { buildFunnelReport } from '../job-pull/funnel-report.mjs';
import {
  crawlRun,
  cloneJsonSafe,
  cloneJsonCollection,
  cloneJsonEnvelope,
  TERMINAL_COLLECTIONS,
  finishCrawlRun,
  readCrawlerRunData,
} from './run.mjs';

const nowAt = (clock) => {
  const value = typeof clock?.now === 'function' ? clock.now() : new Date();
  return value instanceof Date ? value.toISOString() : String(value);
};

const asArray = (value) => Array.isArray(value) ? value : [];
const jsonSafe = (value, label = 'workflow value') => Array.isArray(value)
  ? cloneJsonCollection(value, label) : cloneJsonSafe(value, label);
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const VERIFICATION_EXCLUSIONS = new Set(['ineligible', 'unresolved', 'undated', 'stale']);
const HARD_REASON_PATTERNS = [
  /^GEO_/,
  /^TITLE_(?:SENIORITY_REJECT|OFF_TARGET)/,
  /^EXPERIENCE_(?:HARD_MIN|ABOVE_RELAXED)/,
  /^SALARY_BELOW_/,
  /^STIPEND_(?:BELOW|CURRENCY_NOT)/,
  /^EMPLOYMENT_(?:CATEGORY|UNPAID|TRAINING|TYPE)/,
  /^REMOTE_NOT_ELIGIBLE/,
  /^ONSITE_HYBRID_NOT_PUNE$/,
  /^LIVENESS_EXPIRED$/,
  /^FRESHNESS_(?:EXPIRED|OLDER_THAN_14D|FUTURE)/,
  /^FEES_OR_BOND/,
];
const VERIFICATION_REASON_PATTERNS = [
  /^EXPERIENCE_(?:NOT_STATED|NOT_VERIFIED)/,
  /^STIPEND_(?:UNVERIFIED|AMBIGUOUS|MISSING|CURRENCY_MISSING|PERIOD_NOT_SAFE)/,
  /^LIVENESS_NOT_VERIFIED$/,
  /^FRESHNESS_(?:NOT_VERIFIED|UNDATED)/,
  /^ORIGINAL_APPLICATION_/,
];
const CLOSED_STATES = new Set(['closed', 'inactive', 'filled', 'expired', 'removed', 'withdrawn']);
const PLACEHOLDER_COMPANIES = new Set(['unknown', 'unknown company', 'unresolved company', 'company unknown', 'n/a', 'na']);

const candidateOf = (entry) => entry?.candidate || entry || {};
const queueUrl = (value) => canonicalizeApplicationUrl(value?.url ?? value?.canonicalUrl ?? value?.discoveryUrl ?? value?.originalApplicationUrl ?? value?.applicationUrl);
const candidateKey = (value) => queueUrl(value) || [value?.provider, value?.providerJobId, value?.company, value?.title, value?.location].map((part) => normalizeText(part)).join('|');
const isHardReason = (reason) => HARD_REASON_PATTERNS.some((pattern) => pattern.test(String(reason)))
  || CLOSED_STATES.has(normalizeText(reason));
const isVerificationReason = (reason) => VERIFICATION_REASON_PATTERNS.some((pattern) => pattern.test(String(reason)));
const isPlaceholderCompany = (company) => PLACEHOLDER_COMPANIES.has(normalizeText(company))
  || /^(?:unknown|unresolved)(?:\s+(?:company|employer|organization))?$/.test(normalizeText(company));

const ACTIONED_HISTORY_STATES = new Set(['applied', 'contacted', 'interviewing', 'rejected']);
const SURFACED_HISTORY_STATES = new Set(['surfaced', 'cooldown']);

function emptyV4SnapshotTelemetry() {
  return { status: 'missing', path: null, generatedAt: null, rowCount: 0, error: null };
}

function normalizeV4SnapshotTelemetry(v4Snapshot) {
  if (!v4Snapshot || typeof v4Snapshot !== 'object') return emptyV4SnapshotTelemetry();
  const status = ['missing', 'stale', 'malformed', 'loaded'].includes(v4Snapshot.status)
    ? v4Snapshot.status
    : (v4Snapshot.missing ? 'missing' : 'loaded');
  return {
    status,
    path: v4Snapshot.path ?? null,
    generatedAt: v4Snapshot.generatedAt ?? null,
    rowCount: Number.isFinite(Number(v4Snapshot.rowCount))
      ? Number(v4Snapshot.rowCount)
      : Array.isArray(v4Snapshot.rows) ? v4Snapshot.rows.length : 0,
    error: v4Snapshot.error ?? null,
  };
}

function historyStateOf(value) {
  return normalizeText(value?.historicalState ?? value?.state ?? value?.status ?? value?.action_state ?? value?.actionState);
}

/**
 * Report novelty decisions by authority source. Does not re-decide novelty —
 * only tallies codes already produced by identity + historical suppression.
 */
function buildNoveltyBreakdown({ entries, historicalSuppressed, newlyActionableCount }) {
  const breakdown = {
    productionObservation: 0,
    surfacedHistory: 0,
    actionedHistory: 0,
    newlyActionable: number(newlyActionableCount),
  };
  for (const item of asArray(historicalSuppressed)) {
    const state = historyStateOf(item);
    if (ACTIONED_HISTORY_STATES.has(state)) breakdown.actionedHistory += 1;
    else breakdown.surfacedHistory += 1;
  }
  for (const entry of asArray(entries)) {
    const identity = entry?.identity || candidateOf(entry)?._crawlerIdentity || {};
    const code = String(identity.code || entry?.novelty?.code || '');
    if (code === 'NEWLY_ACTIONABLE' || entry?.novelty?.newlyActionable === true) continue;
    if (code.startsWith('SUPPRESSED_')) {
      const state = normalizeText(code.replace(/^SUPPRESSED_/, ''));
      if (ACTIONED_HISTORY_STATES.has(state)) {
        if (identity.authority === 'external_lifecycle_data') breakdown.actionedHistory += 1;
        else breakdown.productionObservation += 1;
      } else if (SURFACED_HISTORY_STATES.has(state)) {
        if (identity.authority === 'external_lifecycle_data') breakdown.surfacedHistory += 1;
        else breakdown.productionObservation += 1;
      } else {
        breakdown.productionObservation += 1;
      }
      continue;
    }
    if (identity.authority === 'crawler_identity_only' && identity.novelty === 'not_new' && code !== 'NEW_TO_ME' && code !== 'CLOSURE') {
      breakdown.productionObservation += 1;
    }
  }
  return breakdown;
}

function entryReasons(entry, selection) {
  const candidate = candidateOf(entry);
  const eligibility = entry?.eligibility || candidate.eligibility || {};
  const freshness = entry?.freshness || candidate.freshness || {};
  const readiness = candidate.readiness || candidate.applicationReadiness || {};
  const evidence = readiness.evidence || {};
  const reasonValues = [
    ...asArray(eligibility.reasons), eligibility.reasonCode,
    eligibility.geo?.code, eligibility.title?.code, eligibility.experience?.code,
    eligibility.salary?.code, eligibility.employment?.code, eligibility.liveness?.code,
    freshness.code, ...asArray(readiness.reasons), ...asArray(evidence.hardFailures),
    candidate.status, candidate.liveness?.status,
  ].filter(Boolean).map(String);
  if (reasonValues.some(isHardReason) || (eligibility.eligible === false && !reasonValues.some(isVerificationReason))) return [];
  if (!Object.entries(selection.excluded || {}).some(([reason, count]) => VERIFICATION_EXCLUSIONS.has(reason) && number(count) > 0)) return [];

  const reasons = [];
  const resolution = evidence.resolution || candidate.applicationResolution || {};
  if (candidate.applicationReady === false
    || ['Unresolved', 'Needs Verification'].includes(resolution.status)
    || (resolution.ready === false && (resolution.reasons || []).length)) {
    reasons.push(...asArray(resolution.reasons), 'ORIGINAL_APPLICATION_NOT_RESOLVED');
  }
  if (candidate.liveness?.status && !['Active', 'Expired'].includes(candidate.liveness.status)) reasons.push('LIVENESS_NOT_VERIFIED');
  if (freshness.verifyQueue === true || freshness.code === 'FRESHNESS_UNDATED_VERIFY_QUEUE'
    || freshness.code === 'FRESHNESS_NOT_VERIFIED' || (candidate.postedAt == null && freshness.eligible !== true)) {
    reasons.push(freshness.code || 'FRESHNESS_NOT_VERIFIED');
  }
  return [...new Set(reasons.filter((reason) => !isHardReason(reason)))];
}

function hasRealListingEvidence(candidate) {
  if (candidate?.sourceKind === 'ats-direct' || candidate?.classification === 'direct') return true;
  const status = candidate?.applicationResolution?.status;
  return Boolean(candidate?.originalApplicationUrl && ['Direct ATS', 'Resolved Original'].includes(status))
    || Boolean(candidate?.originalApplicationEvidence || candidate?.applicationResolution?.evidence || candidate?.evidence?.originalApplication);
}

function isUnresolvedPlaceholderLead(candidate) {
  const classification = candidate?.classification ?? candidate?.evidence?.classification;
  const sourceKind = candidate?.sourceKind ?? candidate?.evidence?.sourceKind;
  const nonDirect = classification !== 'direct'
    && (sourceKind === 'aggregator' || ['lead', 'unresolved', 'aggregator'].includes(classification));
  return nonDirect && isPlaceholderCompany(candidate?.company) && !hasRealListingEvidence(candidate);
}

function sourceCoverage(sourceTelemetry = {}) {
  const coverage = { completed: [], interrupted: [], failed: [], not_started: [] };
  for (const [sourceId, telemetry] of Object.entries(sourceTelemetry)) {
    const status = telemetry?.status;
    if (['succeeded', 'truncated'].includes(status)) coverage.completed.push(sourceId);
    else if (status === 'interrupted') coverage.interrupted.push(sourceId);
    else if (status === 'failed') coverage.failed.push(sourceId);
    else if (status === 'not_started' || status === 'pending' || status === 'omitted_by_runtime') coverage.not_started.push(sourceId);
  }
  for (const values of Object.values(coverage)) values.sort();
  return coverage;
}

function verificationRecord(entry, reasons) {
  const candidate = candidateOf(entry);
  return {
    url: queueUrl(candidate),
    company: candidate.company ?? null,
    title: candidate.title ?? null,
    provider: candidate.provider ?? null,
    source: candidate.source ?? null,
    reason: reasons[0],
    reasons,
    evidence: { eligibility: entry.eligibility || {}, freshness: entry.freshness || {}, readiness: candidate.readiness || null },
  };
}

function sourceCursor(priorState, sourceId) {
  return priorState?.sources?.[sourceId]?.cursor ?? null;
}

function sourceResult(result, telemetry = {}) {
  return {
    observations: asArray(result?.observations),
    manifest: {
      fetched: Number(telemetry.attempted ?? telemetry.budgetUsed ?? result?.observations?.length ?? 0),
      changed: Number(telemetry.changed ?? result?.observations?.length ?? 0),
      telemetry,
    },
    cursor: result?.conditionalState ? { conditionalState: result.conditionalState } : undefined,
    workflowVerificationQueue: asArray(result?.verificationQueue),
  };
}

/**
 * Compose crawler-v2 discovery into one durable, planning-only seam.
 * Eligibility and lifecycle/application authority remain injected facts owned by v5.
 */
export async function crawlWorkflow({
  store,
  runId,
  schedule = 'manual',
  config = {},
  clock = {},
  priorState = {},
  priorJobs = [],
  priorLifecycleRows = [],
  historicalRows = [],
  v4Snapshot = null,
  sourcePlans = [],
  careerSites = [],
  careerOptions = {},
  careerTransport,
  brave = null,
  braveOptions = {},
  braveTransport,
  prepareEntry,
  reserveOptions = {},
  signal = null,
  deadline = null,
} = {}) {
  if (!store) throw new TypeError('crawlWorkflow requires an open crawler store');
  if (!runId) throw new TypeError('crawlWorkflow requires runId');
  if (typeof prepareEntry !== 'undefined' && typeof prepareEntry !== 'function') throw new TypeError('prepareEntry must be a function');

  const runAt = nowAt(clock);
  const v4SnapshotTelemetry = normalizeV4SnapshotTelemetry(v4Snapshot);
  const durableJobs = readCrawlerRunData(store, runId).jobs;
  const knownJobsByKey = new Map();
  for (const row of [...durableJobs, ...asArray(priorJobs)]) {
    const key = row.jobKey || row.canonicalUrl || `${row.provider || ''}|${row.providerJobId || ''}`;
    if (key) knownJobsByKey.set(key, { ...row });
  }
  const knownJobs = [...knownJobsByKey.values()];
  const verificationFromSources = [];
  const sourceTelemetryDetails = {};
  const makeDecoratedPlan = (plan) => ({
    ...plan,
    fetch: async (context) => {
      const result = await plan.fetch(context);
      const observations = asArray(result?.observations).map((observation) => {
        // prepareEntry may attach readiness before novelty is decided; identity still
        // owns suppression and must not treat raw observe as surfaced.
        let working = observation;
        let prepared = null;
        if (typeof prepareEntry === 'function') {
          prepared = prepareEntry(observation, null, { runAt, source: plan, context });
          if (prepared != null) {
            const cand = prepared.candidate || observation;
            working = { ...observation };
            // Optional facts may be absent. Do not synthesize undefined fields:
            // the durable JSON boundary correctly rejects explicit undefined.
            for (const field of ['applicationReady', 'applicationResolution', 'readiness']) {
              const fact = cand[field] ?? observation[field];
              if (fact !== undefined) working[field] = fact;
            }
          }
        }
        const identity = resolveJobIdentity(working, { existingJobs: knownJobs, lifecycleRows: priorLifecycleRows });
        const novelty = {
          newToMe: identity.novelty === 'new_to_me',
          code: identity.code,
          newlyActionable: identity.code === 'NEWLY_ACTIONABLE',
        };
        const decorated = {
          ...working,
          _crawlerIdentity: identity,
          _crawlerNovelty: novelty,
          lifecycle: identity.lifecycle || lifecycleFromObservation(working),
        };
        if (prepared != null) {
          decorated._crawlerReserveEntry = prepared.candidate
            ? { ...prepared, identity, novelty }
            : { candidate: working, ...prepared, identity, novelty };
        }
        // In-run history: raw observation never implies surfaced/cooldown.
        knownJobs.push({
          ...working,
          jobKey: identity.identity.jobKey,
          fingerprint: identity.fingerprint,
          lifecycle: identity.lifecycle || lifecycleFromObservation(working),
          applicationReady: isApplicationReady(working),
        });
        return decorated;
      });
      verificationFromSources.push(...asArray(result?.verificationQueue));
      sourceTelemetryDetails[plan.id] = result?.manifest ?? result?.telemetry ?? {};
      return { ...result, observations, workflowVerificationQueue: asArray(result?.verificationQueue) };
    },
  });

  const composedPlans = sourcePlans.map(makeDecoratedPlan);
  if (careerSites.length) {
    if (typeof careerTransport !== 'function') throw new TypeError('careerTransport is required when careerSites are supplied');
    composedPlans.push(makeDecoratedPlan({
      id: 'career-sites', lane: 'career-site', trustClass: 'direct',
      capabilities: { incremental: true, robots: true, sitemap: true },
      ratePolicy: careerOptions.hostLimiterOptions ?? {},
      fetch: async ({ clock: sourceClock, signal: sourceSignal, deadline: sourceDeadline, checkpoint }) => {
        const priorCursor = sourceCursor(priorState, 'career-sites');
        const result = await discoverCompanyCareers({
          ...careerOptions,
          companies: careerSites,
          transport: careerTransport,
          runAt,
          clock: sourceClock,
          signal: sourceSignal,
          deadline: sourceDeadline,
          onProgress: checkpoint ? ({ sources: companies, telemetry }) => checkpoint({ manifestDelta: { telemetry: { ...telemetry, companies: companyCareerProgress(companies) } } }) : undefined,
          conditionalState: priorCursor?.conditionalState ?? priorCursor ?? {},
        });
        return sourceResult(result, result.telemetry);
      },
    }));
  }
  if (brave) {
    if (typeof braveTransport !== 'function') throw new TypeError('braveTransport is required when brave is supplied');
    composedPlans.push(makeDecoratedPlan({
      id: 'brave-search', lane: 'brave', trustClass: 'mixed',
      capabilities: { queryBudget: true, resolver: typeof braveOptions.resolveOriginalListing === 'function' },
      fetch: async ({ signal: sourceSignal, deadline: sourceDeadline }) => {
        const result = await discoverBraveSearch({ ...braveOptions, ...brave, transport: braveTransport, runAt, signal: sourceSignal, deadline: sourceDeadline });
        return sourceResult(result, result.manifest?.telemetry);
      },
    }));
  }

  const durable = await crawlRun({ store, sourcePlans: composedPlans, priorState, config, clock, runId, schedule, signal, deadline });
  const data = readCrawlerRunData(store, runId);
  const persistedWorkflow = durable.telemetry?.workflow;
  const jobsByKey = new Map(data.jobs.map((job) => [job.jobKey, job]));
  const records = data.observations.map((record) => ({
    ...record.raw,
    firstSeenAt: jobsByKey.get(record.jobKey)?.firstSeenAt ?? null,
    observationKey: record.observationKey,
    jobKey: record.jobKey,
    sourceId: record.sourceId,
    observedAt: record.observedAt,
    classification: record.classification,
  }));
  const entries = records.map((observation) => observation._crawlerReserveEntry || {
    candidate: observation,
    identity: observation._crawlerIdentity,
    novelty: observation._crawlerNovelty || { newToMe: observation._crawlerIdentity?.novelty === 'new_to_me' },
    eligibility: observation.eligibility || {},
    freshness: observation.freshness || {},
  });
  const historicalResult = filterHistoricalCandidates(entries.map((entry) => candidateOf(entry)), historicalRows);
  const keptCandidates = new Set(historicalResult.kept);
  const historicalAmbiguousCandidates = new Set(
    asArray(historicalResult.ambiguous).map((item) => item.candidate).filter(Boolean),
  );
  const historicalSuppressedEntries = entries.filter((entry) => {
    const candidate = candidateOf(entry);
    return !keptCandidates.has(candidate) && !historicalAmbiguousCandidates.has(candidate);
  });
  const historicalAmbiguousEntries = entries.filter((entry) => historicalAmbiguousCandidates.has(candidateOf(entry)));
  const nonHistoricalEntries = entries.filter((entry) => keptCandidates.has(candidateOf(entry)));
  const upstreamVerificationKeys = new Set([
    ...verificationFromSources,
    ...asArray(persistedWorkflow?.verificationQueue),
  ].map(candidateKey).filter(Boolean));
  const selection = selectDailyReserve(
    nonHistoricalEntries.filter((entry) => !upstreamVerificationKeys.has(candidateKey(candidateOf(entry)))),
    reserveOptions,
  );
  const selectedCandidates = new Set(selection.reserve.map((item) => item.candidate));
  const recordsByKey = new Map(records.map((record) => [candidateKey(record), record]));
  const historicalKeys = new Set(historicalSuppressedEntries.map((entry) => candidateKey(candidateOf(entry))));
  // SQLite records observations only. Final mode planning owns surfacing, and
  // the opportunity ledger is the cooldown authority.
  const jobs = data.jobs;
  const newlyActionableCount = nonHistoricalEntries.filter((entry) => entry.identity?.code === 'NEWLY_ACTIONABLE'
    || entry.novelty?.newlyActionable === true
    || entry.novelty?.code === 'NEWLY_ACTIONABLE').length;
  const noveltyBreakdown = buildNoveltyBreakdown({
    entries,
    historicalSuppressed: historicalResult.suppressed,
    newlyActionableCount,
  });
  const unresolvedLeads = [];
  const verificationKeys = new Set();
  const verificationQueue = [];
  const addVerification = (item, relatedCandidate = null) => {
    const candidate = relatedCandidate || item?.candidate || recordsByKey.get(candidateKey(item)) || item;
    if (historicalKeys.has(candidateKey(candidate))) return;
    if (isUnresolvedPlaceholderLead(candidate)) {
      unresolvedLeads.push({ ...item, lowQuality: true });
      return;
    }
    // Ambiguous identity collisions always fail closed into verification — never auto-surface.
    const identityCode = item?.identity?.code || candidate?._crawlerIdentity?.code;
    if (identityCode === 'AMBIGUOUS_COLLISION') {
      const key = queueUrl(item) || queueUrl(candidate);
      if (key && verificationKeys.has(key)) return;
      if (key) verificationKeys.add(key);
      verificationQueue.push({
        ...verificationRecord({ candidate, identity: item?.identity || candidate?._crawlerIdentity, eligibility: {}, freshness: {} }, ['AMBIGUOUS_IDENTITY_COLLISION']),
        reasons: ['AMBIGUOUS_IDENTITY_COLLISION'],
      });
      return;
    }
    const key = queueUrl(item);
    if (key && verificationKeys.has(key)) return;
    if (key) verificationKeys.add(key);
    verificationQueue.push(item);
  };
  for (const item of (persistedWorkflow?.verificationQueue ?? verificationFromSources)) addVerification(item);
  // Historical ambiguous matches: fail closed to verification, never auto-suppress or auto-merge.
  for (const entry of historicalAmbiguousEntries) {
    const candidate = candidateOf(entry);
    const key = candidateKey(candidate);
    if (key && verificationKeys.has(key)) continue;
    if (key) verificationKeys.add(key);
    verificationQueue.push({
      ...verificationRecord(entry, ['AMBIGUOUS_HISTORICAL_COLLISION']),
      reasons: ['AMBIGUOUS_HISTORICAL_COLLISION'],
      code: 'AMBIGUOUS_COLLISION',
      evidence: asArray(historicalResult.ambiguous).find((item) => item.candidate === candidate)?.evidence ?? null,
    });
  }
  for (const entry of nonHistoricalEntries) {
    if (entry.identity?.code === 'AMBIGUOUS_COLLISION') {
      addVerification(entry, candidateOf(entry));
      continue;
    }
    if (selectedCandidates.has(candidateOf(entry))) continue;
    const reasons = entryReasons(entry, selection);
    if (!reasons.length) continue;
    const item = verificationRecord(entry, reasons);
    addVerification(item, candidateOf(entry));
  }
  const selectedKeys = new Set(selection.shortlist.map((item) => candidateKey(candidateOf(item))));
  const verificationQueueKeys = new Set(verificationQueue.map(candidateKey).filter(Boolean));
  const selectedVerifyQueue = [...selectedKeys].filter((key) => verificationQueueKeys.has(key));
  if (selectedVerifyQueue.length) throw new Error('selection invariant failed: selected overlaps VerifyQueue');
  const handoff = {
    schemaVersion: 'LaunchpadV5CrawlerHandoffV1',
    noAutoApply: true,
    writesPlanned: false,
    shortlist: selection.shortlist.map((item) => ({ jobKey: item.identity?.identity?.jobKey ?? item.candidate?.canonicalUrl, candidate: item.candidate })),
    reserveQueue: selection.reserveQueue.map((item) => ({ jobKey: item.identity?.identity?.jobKey ?? item.candidate?.canonicalUrl, candidate: item.candidate })),
  };

  const persistedSourceTelemetry = durable.idempotent ? durable.telemetry?.workflow?.sourceTelemetry : null;
  const sourceTelemetry = persistedSourceTelemetry ?? Object.fromEntries(Object.entries(durable.telemetry?.sources ?? {}).map(([sourceId, telemetry]) => [
    sourceId,
    { ...telemetry, detail: sourceTelemetryDetails[sourceId] ?? null },
  ]));
  const sourceYield = buildSourceYieldReport(records, sourceTelemetry, config.sourceYield);
  const sourceEndStates = (durable.idempotent ? durable.telemetry?.workflow?.terminalEnvelope?.sourceEndStates : null)
    ?? buildSourceEndStates(sourceTelemetry, config.sources);
  // Reserve/verification counts are durable so schedule-health can report them
  // for a completed run without recomputing selection from raw observations.
  const rejectedTotal = Object.values(selection.excluded || {}).reduce((sum, value) => sum + number(value), 0);
  const shortlistKeys = new Set(selection.shortlist.map((item) => candidateKey(candidateOf(item))));
  const funnelObservations = entries.map((entry) => {
    const candidate = candidateOf(entry);
    const key = candidateKey(candidate);
    const historical = historicalKeys.has(key);
    return {
      candidate,
      eligibility: entry.eligibility || candidate.eligibility || {},
      freshness: entry.freshness || candidate.freshness || {},
      historicalSuppressed: historical,
      suppression: historical
        ? { suppressed: true, code: 'HISTORICAL_SUPPRESSED' }
        : entry.suppression || null,
      selected: shortlistKeys.has(key),
      ready: candidate.applicationReady === true || selection.reserve.some((item) => candidateOf(item) === candidate),
    };
  });
  const fetchedTotal = Object.values(sourceTelemetry || {}).reduce(
    (sum, row) => sum + number(row?.fetched ?? row?.attempted ?? row?.detail?.fetched),
    0,
  );
  const sourceHealth = Object.fromEntries(Object.entries(sourceTelemetry || {}).map(([sourceId, telemetry]) => {
    const health = {
      status: telemetry?.status ?? null,
      naturalTerminal: telemetry?.naturalTerminal === true,
      truncated: telemetry?.truncated === true,
      capHit: telemetry?.capHit ?? null,
      recordsNotExamined: telemetry?.recordsNotExamined ?? null,
    };
    if (telemetry?.continuationCursor != null) health.cursor = telemetry.continuationCursor;
    else if (telemetry?.startingCursor != null) health.cursor = telemetry.startingCursor;
    if (telemetry?.detail?.telemetry?.workdayDetail) health.workdayDetail = telemetry.detail.telemetry.workdayDetail;
    const boards = asArray(telemetry?.detail?.sources).map((board) => {
      const boardHealth = {
        board: board?.board ?? null,
        provider: board?.provider ?? null,
        status: board?.status ?? null,
        naturalTerminal: board?.naturalTerminal === true,
        truncated: board?.truncated === true,
        capHit: board?.capHit ?? null,
        recordsNotExamined: board?.recordsNotExamined ?? null,
      };
      const boardContinuationCursor = board?.continuationCursor
        ?? telemetry?.continuationCursor?.__cursor?.[board?.board]
        ?? telemetry?.continuationCursor?.[board?.board];
      if (boardContinuationCursor != null) boardHealth.cursor = boardContinuationCursor;
      else if (board?.startingCursor != null) boardHealth.cursor = board.startingCursor;
      return boardHealth;
    });
    if (boards.length) health.boards = boards;
    return [sourceId, health];
  }));
  const funnel = buildFunnelReport({
    observations: funnelObservations,
    lifecycle: {
      fetched: fetchedTotal || records.length,
      sourceFiltered: records.length,
      eligible: funnelObservations.filter((entry) => entry.eligibility?.eligible === true).length,
      historicalSuppressed: historicalResult.suppressed.length,
      verifyQueue: verificationQueue.length,
      workdayUncorroboratedVerifyQueue: funnelObservations.filter((entry) => entry.freshness?.workdayUncorroborated === true
        || entry.freshness?.code === 'FRESHNESS_WORKDAY_UNCORROBORATED_VERIFY_QUEUE').length,
      ready: selection.shortlist.length,
      selected: selection.shortlist.length,
      newlyActionable: newlyActionableCount,
      newlyDated: durable.newlyDated,
    },
    sourceHealth,
  });
  const workflowCounts = {
    ready: selection.shortlist.length,
    verification: verificationQueue.length,
    rejected: rejectedTotal,
    historicalSuppressed: historicalResult.suppressed.length,
    historicalAmbiguous: historicalResult.ambiguous?.length ?? 0,
    newlyActionable: newlyActionableCount,
    surfaced: selection.reserve.length,
    fetched: funnel.lifecycle.fetched,
    sourceFiltered: funnel.lifecycle.sourceFiltered,
    normalized: funnel.lifecycle.normalized,
    eligible: funnel.lifecycle.eligible,
    selected: funnel.lifecycle.selected,
    novelty: noveltyBreakdown,
  };
  const coverage = sourceCoverage(sourceTelemetry);
  const runtimeOmitted = coverage.not_started.some((sourceId) => sourceTelemetry[sourceId]?.status === 'omitted_by_runtime');
  const terminalStatus = durable.run.status === 'partial' || runtimeOmitted
    ? 'partial'
    : durable.run.status === 'failed'
      ? 'failed'
      : 'completed';
  const terminalEnvelope = {
    schemaVersion: 'LaunchpadDailyTerminalEnvelopeV1',
    status: terminalStatus,
    runId,
    writesPlanned: false,
    sourceCoverage: coverage,
    sourceEndStates,
    rejectionCounts: { ...(selection.excluded || {}) },
    rejectionReasons: Object.keys(selection.excluded || {}).sort(),
    fallback: selection.reserve.filter((candidate) => candidate.selectionTier === 'Fallback'),
    verificationQueue: jsonSafe(verificationQueue),
    scoredReady: selection.reserve.filter((candidate) => Number.isFinite(Number(candidate.matchScore)) && Number(candidate.matchScore) >= 0 && Number(candidate.matchScore) <= 100),
    scorePendingReady: selection.reserve.filter((candidate) => !Number.isFinite(Number(candidate.matchScore)) || Number(candidate.matchScore) < 0 || Number(candidate.matchScore) > 100),
    fatalReason: terminalStatus === 'failed' ? durable.run.error ?? null : null,
    lastDurableSourceState: coverage,
  };
  if (!durable.idempotent) {
    const workflowTelemetry = {
      ...durable.telemetry,
      v4Snapshot: jsonSafe(v4SnapshotTelemetry),
      novelty: jsonSafe(noveltyBreakdown),
      workflow: {
        verificationQueue: jsonSafe(verificationQueue),
        unresolvedLeads: jsonSafe(unresolvedLeads),
        historicalSuppressions: jsonSafe(historicalResult.suppressed),
        historicalAmbiguous: jsonSafe(historicalResult.ambiguous),
        sourceTelemetry: jsonSafe(sourceTelemetry),
        sourceYield: jsonSafe(sourceYield),
        funnel: jsonSafe(funnel),
        v4Snapshot: jsonSafe(v4SnapshotTelemetry),
        novelty: jsonSafe(noveltyBreakdown),
        terminalEnvelope: cloneJsonEnvelope(terminalEnvelope, 'terminal envelope', TERMINAL_COLLECTIONS.map((key) => [key])),
      },
    };
    const status = durable.run.status;
    const updatedRun = finishCrawlRun(store, runId, {
      status,
      counts: { ...durable.run.counts, ...workflowCounts },
      telemetry: workflowTelemetry,
      clock,
      error: durable.run.error,
    });
    durable.run = updatedRun;
    durable.telemetry = workflowTelemetry;
  }

  return {
    schemaVersion: 'LaunchpadV5CrawlerWorkflowV1',
    sourceEndStates,
    idempotent: durable.idempotent,
    run: durable.run,
    stages: durable.stages,
    observations: records,
    jobs,
    verificationQueue: jsonSafe(verificationQueue),
    unresolvedLeads: jsonSafe(unresolvedLeads),
    historicalSuppressions: jsonSafe(historicalResult.suppressed),
    historicalAmbiguous: jsonSafe(historicalResult.ambiguous),
    counts: workflowCounts,
    novelty: jsonSafe(noveltyBreakdown),
    v4Snapshot: jsonSafe(v4SnapshotTelemetry),
    funnel: jsonSafe(persistedWorkflow?.funnel ?? funnel),
    reserve: selection.reserve,
    shortlist: selection.shortlist,
    shortfall: selection.shortfall,
    sourceTelemetry: jsonSafe(sourceTelemetry),
    sourceYield: jsonSafe(persistedWorkflow?.sourceYield ?? sourceYield),
    plannedDownstreamHandoff: handoff,
    failures: durable.failures,
    selectionInvariants: { selectedVerifyQueue },
    terminalEnvelope,
  };
}

export const runCrawlerWorkflow = crawlWorkflow;
export default crawlWorkflow;
