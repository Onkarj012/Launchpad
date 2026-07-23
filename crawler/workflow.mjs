import { discoverBraveSearch } from './brave-search.mjs';
import { discoverCompanyCareers } from './company-careers.mjs';
import { resolveJobIdentity } from './identity.mjs';
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
  const verificationQueue = persistedWorkflow?.verificationQueue ?? verificationFromSources;
  const entries = records.map((observation) => observation._crawlerReserveEntry || {
    candidate: observation,
    identity: observation._crawlerIdentity,
    novelty: observation._crawlerNovelty || { newToMe: observation._crawlerIdentity?.novelty === 'new_to_me' },
    eligibility: observation.eligibility || {},
    freshness: observation.freshness || {},
  });
  const selection = selectDailyReserve(entries, reserveOptions);
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
  if (!durable.idempotent) {
    const workflowTelemetry = {
      ...durable.telemetry,
      workflow: { verificationQueue: jsonSafe(verificationQueue), sourceTelemetry: jsonSafe(sourceTelemetry), sourceYield: jsonSafe(sourceYield) },
    };
    const status = durable.run.status;
    const updatedRun = finishCrawlRun(store, runId, {
      status,
      counts: durable.run.counts,
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
