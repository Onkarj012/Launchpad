import { discoverBraveSearch } from './brave-search.mjs';
import { discoverCompanyCareers } from './company-careers.mjs';
import { filterHistoricalCandidates } from './historical-suppression.mjs';
import { canonicalizeApplicationUrl, normalizeText, resolveJobIdentity } from './identity.mjs';
import { selectDailyReserve } from './reserve.mjs';
import { buildSourceYieldReport } from './source-yield.mjs';
import {
  crawlRun,
  finishCrawlRun,
  readCrawlerRunData,
} from './run.mjs';

const nowAt = (clock) => {
  const value = typeof clock?.now === 'function' ? clock.now() : new Date();
  return value instanceof Date ? value.toISOString() : String(value);
};

const asArray = (value) => Array.isArray(value) ? value : [];
const jsonSafe = (value) => JSON.parse(JSON.stringify(value));
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
  if (eligibility.experience?.manualReview === true || eligibility.experience?.code === 'EXPERIENCE_NOT_STATED_MANUAL_REVIEW') {
    reasons.push(eligibility.experience.code || 'EXPERIENCE_NOT_STATED_MANUAL_REVIEW');
  }
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

function verificationRecord(entry, reasons) {
  const candidate = candidateOf(entry);
  return {
    url: queueUrl(candidate),
    company: candidate.company,
    title: candidate.title,
    provider: candidate.provider,
    source: candidate.source,
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
  sourcePlans = [],
  careerSites = [],
  careerOptions = {},
  careerTransport,
  brave = null,
  braveOptions = {},
  braveTransport,
  prepareEntry,
  reserveOptions = {},
} = {}) {
  if (!store) throw new TypeError('crawlWorkflow requires an open crawler store');
  if (!runId) throw new TypeError('crawlWorkflow requires runId');
  if (typeof prepareEntry !== 'undefined' && typeof prepareEntry !== 'function') throw new TypeError('prepareEntry must be a function');

  const runAt = nowAt(clock);
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
        const identity = resolveJobIdentity(observation, { existingJobs: knownJobs, lifecycleRows: priorLifecycleRows });
        const decorated = {
          ...observation,
          _crawlerIdentity: identity,
          _crawlerNovelty: { newToMe: identity.novelty === 'new_to_me' },
        };
        if (typeof prepareEntry === 'function') {
          const prepared = prepareEntry(observation, identity, { runAt, source: plan, context });
          if (prepared != null) decorated._crawlerReserveEntry = prepared.candidate
            ? { ...prepared, identity, novelty: { newToMe: identity.novelty === 'new_to_me' } }
            : { candidate: observation, ...prepared, identity, novelty: { newToMe: identity.novelty === 'new_to_me' } };
        }
        knownJobs.push({ ...observation, jobKey: identity.identity.jobKey, fingerprint: identity.fingerprint });
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
      fetch: async ({ clock: sourceClock }) => {
        const priorCursor = sourceCursor(priorState, 'career-sites');
        const result = await discoverCompanyCareers({
          ...careerOptions,
          companies: careerSites,
          transport: careerTransport,
          runAt,
          clock: sourceClock,
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
      fetch: async () => {
        const result = await discoverBraveSearch({ ...braveOptions, ...brave, transport: braveTransport, runAt });
        return sourceResult(result, result.manifest?.telemetry);
      },
    }));
  }

  const durable = await crawlRun({ store, sourcePlans: composedPlans, priorState, config, clock, runId, schedule });
  const data = readCrawlerRunData(store, runId);
  const persistedWorkflow = durable.telemetry?.workflow;
  const records = data.observations.map((record) => ({
    ...record.raw,
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
  const historicalSuppressedEntries = entries.filter((entry) => !keptCandidates.has(candidateOf(entry)));
  const nonHistoricalEntries = entries.filter((entry) => keptCandidates.has(candidateOf(entry)));
  const selection = selectDailyReserve(nonHistoricalEntries, reserveOptions);
  const selectedCandidates = new Set(selection.reserve.map((item) => item.candidate));
  const recordsByKey = new Map(records.map((record) => [candidateKey(record), record]));
  const historicalKeys = new Set(historicalSuppressedEntries.map((entry) => candidateKey(candidateOf(entry))));
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
    const key = queueUrl(item);
    if (key && verificationKeys.has(key)) return;
    if (key) verificationKeys.add(key);
    verificationQueue.push(item);
  };
  for (const item of (persistedWorkflow?.verificationQueue ?? verificationFromSources)) addVerification(item);
  for (const entry of nonHistoricalEntries) {
    if (selectedCandidates.has(candidateOf(entry))) continue;
    const reasons = entryReasons(entry, selection);
    if (!reasons.length) continue;
    const item = verificationRecord(entry, reasons);
    addVerification(item, candidateOf(entry));
  }
  const handoff = {
    schemaVersion: 'LaunchpadV5CrawlerHandoffV1',
    noAutoApply: true,
    writesPlanned: false,
    shortlist: selection.shortlist.map((item) => ({ jobKey: item.identity?.identity?.jobKey ?? item.candidate?.canonicalUrl, candidate: item.candidate })),
    reserveQueue: selection.reserveQueue.map((item) => ({ jobKey: item.identity?.identity?.jobKey ?? item.candidate?.canonicalUrl, candidate: item.candidate })),
  };

  const persistedSourceTelemetry = durable.telemetry?.workflow?.sourceTelemetry;
  const sourceTelemetry = persistedSourceTelemetry ?? Object.fromEntries(Object.entries(durable.telemetry?.sources ?? {}).map(([sourceId, telemetry]) => [
    sourceId,
    { ...telemetry, detail: sourceTelemetryDetails[sourceId] ?? null },
  ]));
  const sourceYield = buildSourceYieldReport(records, sourceTelemetry, config.sourceYield);
  // Reserve/verification counts are durable so schedule-health can report them
  // for a completed run without recomputing selection from raw observations.
  const rejectedTotal = Object.values(selection.excluded || {}).reduce((sum, value) => sum + number(value), 0);
  const workflowCounts = { ready: selection.shortlist.length, verification: verificationQueue.length, rejected: rejectedTotal, historicalSuppressed: historicalResult.suppressed.length };
  if (!durable.idempotent) {
    const workflowTelemetry = {
      ...durable.telemetry,
      workflow: {
        verificationQueue: jsonSafe(verificationQueue),
        unresolvedLeads: jsonSafe(unresolvedLeads),
        historicalSuppressions: jsonSafe(historicalResult.suppressed),
        sourceTelemetry: jsonSafe(sourceTelemetry),
        sourceYield: jsonSafe(sourceYield),
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
    idempotent: durable.idempotent,
    run: durable.run,
    stages: durable.stages,
    observations: records,
    jobs: data.jobs,
    verificationQueue: jsonSafe(verificationQueue),
    unresolvedLeads: jsonSafe(unresolvedLeads),
    historicalSuppressions: jsonSafe(historicalResult.suppressed),
    counts: workflowCounts,
    reserve: selection.reserve,
    shortlist: selection.shortlist,
    shortfall: selection.shortfall,
    sourceTelemetry: jsonSafe(sourceTelemetry),
    sourceYield: jsonSafe(persistedWorkflow?.sourceYield ?? sourceYield),
    plannedDownstreamHandoff: handoff,
    failures: durable.failures,
  };
}

export const runCrawlerWorkflow = crawlWorkflow;
export default crawlWorkflow;
