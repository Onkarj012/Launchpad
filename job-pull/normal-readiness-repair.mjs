import { applicationReadiness } from './normal-readiness.mjs';

const REPAIRABLE_BLOCKERS = new Set([
  'JOB_DESCRIPTION_MISSING',
  'ORIGINAL_APPLICATION_URL_MISSING',
  'ORIGINAL_APPLICATION_NOT_RESOLVED',
  'ORIGINAL_APPLICATION_EVIDENCE_MISSING',
  'LOCATION_EVIDENCE_MISSING',
  'EMPLOYMENT_TYPE_MISSING',
  'TRUSTED_POSTED_DATE_MISSING',
  'LIVENESS_NOT_VERIFIED',
]);

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function priorityFor(candidate) {
  const eligibility = candidate.eligibility || {};
  const freshness = candidate.freshness || {};
  let priority = 0;
  if (eligibility.strict === true) priority += 100;
  if (freshness.window === 'Hot') priority += 50;
  else if (freshness.window === 'Active') priority += 35;
  else if (freshness.window === 'Backfill') priority += 10;
  if (candidate.sourceKind === 'ats-direct') priority += 25;
  if (eligibility.geo?.code === 'GEO_PUNE_METRO' || /\bpune\b/i.test(candidate.location || '')) priority += 20;
  else if (eligibility.geo?.pass === true || /\bindia\b/i.test(candidate.location || '')) priority += 10;
  return priority;
}

function repairTargets(candidate, blockers) {
  const targets = [];
  if (blockers.includes('JOB_DESCRIPTION_MISSING')) targets.push('description');
  if (blockers.some((blocker) => blocker.startsWith('ORIGINAL_APPLICATION_'))) targets.push('originalApplicationUrl');
  if (blockers.includes('LOCATION_EVIDENCE_MISSING')) targets.push('location');
  if (blockers.includes('EMPLOYMENT_TYPE_MISSING')) targets.push('employmentType');
  if (blockers.includes('TRUSTED_POSTED_DATE_MISSING')) targets.push('trustedDate');
  if (blockers.includes('LIVENESS_NOT_VERIFIED')) targets.push('liveness');
  if (!text(candidate.jobId) && !text(candidate.requisitionId) && !text(candidate.providerJobId)) targets.push('requisitionId');
  return [...new Set(targets)];
}

export function classifyReadinessRepair(candidate) {
  const eligibility = candidate.eligibility || null;
  const freshness = candidate.freshness || null;
  const shared = applicationReadiness(candidate, eligibility);
  const blockers = [...shared.reasons];
  if (!text(candidate.description)) blockers.push('JOB_DESCRIPTION_MISSING');
  if (!text(candidate.location)) blockers.push('LOCATION_EVIDENCE_MISSING');
  if (!text(candidate.employment?.type)) blockers.push('EMPLOYMENT_TYPE_MISSING');
  if (!text(candidate.postedAt) || freshness?.eligible === false) blockers.push('TRUSTED_POSTED_DATE_MISSING');
  const namedBlockers = [...new Set(blockers)].filter(Boolean);
  const ready = namedBlockers.length === 0;
  const repairable = !ready
    && Boolean(text(candidate.discoveryUrl) || text(candidate.canonicalUrl) || text(candidate.url))
    && namedBlockers.every((blocker) => REPAIRABLE_BLOCKERS.has(blocker));
  return {
    ready,
    repairable,
    status: ready ? 'ready' : repairable ? 'repairable' : 'rejected',
    blockers: namedBlockers,
    targets: repairTargets(candidate, namedBlockers),
    priority: priorityFor(candidate),
    evidence: shared.evidence,
  };
}

function mergeRepair(candidate, repair, attemptedAt) {
  const patch = repair?.candidate && typeof repair.candidate === 'object' ? repair.candidate : repair;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return candidate;
  const repairEvidence = patch.repairEvidence ?? repair?.repairEvidence ?? null;
  return {
    ...candidate,
    ...patch,
    employment: { ...candidate.employment, ...(patch.employment || {}) },
    liveness: { ...candidate.liveness, ...(patch.liveness || {}) },
    applicationResolution: { ...candidate.applicationResolution, ...(patch.applicationResolution || {}) },
    evidence: {
      ...candidate.evidence,
      ...(patch.evidence || {}),
      readinessRepair: {
        status: 'attempted',
        attemptedAt,
        evidence: repairEvidence,
      },
    },
  };
}

function deadlinePromise(timeoutMs, controller) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('readiness repair deadline exhausted');
      error.code = 'REPAIR_DEADLINE_EXHAUSTED';
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function boundedRepair(candidate, repairCandidate, context, remainingMs) {
  const controller = new AbortController();
  const deadline = deadlinePromise(Math.max(1, remainingMs), controller);
  try {
    return await Promise.race([
      repairCandidate(candidate, { ...context, signal: controller.signal }),
      deadline.promise,
    ]);
  } finally {
    deadline.cancel();
  }
}

function rejection(candidate, classification, extra = {}) {
  return {
    canonicalUrl: candidate.canonicalUrl,
    company: candidate.company,
    title: candidate.title,
    discoveryUrl: candidate.discoveryUrl || candidate.canonicalUrl,
    originalApplicationUrl: candidate.originalApplicationUrl || null,
    provider: candidate.provider || null,
    source: candidate.source || null,
    applicationResolution: candidate.applicationResolution || null,
    liveness: candidate.liveness || null,
    blockers: classification.blockers.length ? classification.blockers : ['READINESS_NOT_VERIFIED'],
    priority: classification.priority,
    ...extra,
  };
}

/**
 * Bounded, transport-free readiness repair. Callers inject the resolver and
 * hydrator; without one, candidates are classified and queued but no I/O runs.
 */
export async function repairReadinessPool(candidates = [], {
  repairCandidate = null,
  maxRequests = 20,
  now = new Date().toISOString(),
  maximumDurationMs = 30_000,
  deadlineAtMs = null,
  monotonicClock = Date.now,
} = {}) {
  const startMs = monotonicClock();
  const duration = Math.max(0, Number.isFinite(Number(maximumDurationMs)) ? Number(maximumDurationMs) : 30_000);
  const ownDeadline = startMs + duration;
  const deadline = deadlineAtMs != null && Number.isFinite(Number(deadlineAtMs))
    ? Math.min(ownDeadline, Number(deadlineAtMs))
    : ownDeadline;
  const budget = Math.max(0, Number.isInteger(Number(maxRequests)) ? Number(maxRequests) : 20);
  const ordered = [...(Array.isArray(candidates) ? candidates : [])]
    .map((candidate, index) => ({ candidate, index, classification: classifyReadinessRepair(candidate) }))
    .sort((left, right) => right.classification.priority - left.classification.priority || left.index - right.index);
  const scorerPool = [];
  const repairQueue = [];
  const rejected = [];
  let attempted = 0;
  let repaired = 0;
  let deadlineExhausted = false;

  for (const entry of ordered) {
    let { candidate, classification } = entry;
    if (classification.ready) {
      scorerPool.push({ ...candidate, readinessRepair: classification });
      continue;
    }

    let queueReason = null;
    if (!classification.repairable) queueReason = 'READINESS_UNREPAIRABLE';
    else if (typeof repairCandidate !== 'function') queueReason = 'REPAIR_HANDLER_UNAVAILABLE';
    else if (attempted >= budget) queueReason = 'REPAIR_BUDGET_EXHAUSTED';
    else {
      const remainingMs = deadline - monotonicClock();
      if (remainingMs <= 0) {
        queueReason = 'REPAIR_DEADLINE_EXHAUSTED';
        deadlineExhausted = true;
      } else {
        attempted++;
        try {
          const repair = await boundedRepair(candidate, repairCandidate, {
            targets: classification.targets,
            deadlineAtMs: deadline,
            remainingMs,
          }, remainingMs);
          candidate = mergeRepair(candidate, repair, now);
          classification = classifyReadinessRepair(candidate);
          if (classification.ready) {
            repaired++;
            scorerPool.push({ ...candidate, readinessRepair: classification });
            continue;
          }
          queueReason = 'REPAIR_INCOMPLETE';
        } catch (error) {
          queueReason = error?.code === 'REPAIR_DEADLINE_EXHAUSTED' ? error.code : 'REPAIR_FAILED';
          if (queueReason === 'REPAIR_DEADLINE_EXHAUSTED') deadlineExhausted = true;
        }
      }
    }

    const record = rejection(candidate, classification, { queueReason });
    rejected.push(record);
    if (classification.repairable && classification.priority > 0) repairQueue.push(record);
  }

  return {
    scorerPool,
    repairQueue,
    rejected,
    telemetry: {
      input: ordered.length,
      ready: scorerPool.length,
      attempted,
      repaired,
      rejected: rejected.length,
      queued: repairQueue.length,
      maxRequests: budget,
      deadlineAtMs: deadline,
      deadlineExhausted,
    },
  };
}
