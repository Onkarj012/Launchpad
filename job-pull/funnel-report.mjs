/**
 * Mutually exclusive first-failure funnel reporting.
 *
 * Each normalized observation is counted in exactly one first-failure (or
 * terminal-survival) bucket. Overlapping gate evidence is reported separately
 * under alsoFailed and never mixed into the mutually exclusive totals.
 * Narrative text is derived only from stored counters.
 */

import { WORKDAY_DEFAULT_LOCATION_KEYWORDS } from '../crawler/ats-enterprise.mjs';

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Policy gate order for first-failure assignment (master_prompt §2 hard gates). */
export const FIRST_FAILURE_GATE_ORDER = Object.freeze([
  'geo',
  'title',
  'experience',
  'employment',
  'salary',
  'liveness',
  'verifyQueue',
  'freshnessRejected',
  'historicalSuppressed',
  'suppressedBackfillAlreadySeen',
  'suppressedCooldown',
  'suppressedActioned',
  'suppressedRejected',
  'notSelected',
  'selected',
]);

const EMPTY_FIRST_FAILURES = () => Object.fromEntries(FIRST_FAILURE_GATE_ORDER.map((key) => [key, 0]));

function gateResult(eligibility, name) {
  return eligibility?.[name] || null;
}

function failedGateCode(result) {
  if (!result || result.pass !== false) return null;
  return result.code || 'GATE_REJECTED';
}

/**
 * Collect every failed eligibility/freshness code for overlapping evidence.
 * Order matches first-failure priority so index 0 is the first failure.
 */
export function collectFailureEvidence(entry = {}) {
  const eligibility = entry.eligibility || {};
  const freshness = entry.freshness || {};
  const ordered = [];
  const push = (bucket, code) => {
    if (code) ordered.push({ bucket, code });
  };

  push('geo', failedGateCode(gateResult(eligibility, 'geo')));
  push('title', failedGateCode(gateResult(eligibility, 'title')));
  push('experience', failedGateCode(gateResult(eligibility, 'experience')));
  push('employment', failedGateCode(gateResult(eligibility, 'employment')));
  push('salary', failedGateCode(gateResult(eligibility, 'salary')));
  push('liveness', failedGateCode(gateResult(eligibility, 'liveness')));

  if (freshness.verifyQueue === true || freshness.window === 'VerifyQueue') {
    push('verifyQueue', freshness.code || 'FRESHNESS_UNDATED_VERIFY_QUEUE');
  } else if (freshness.eligible === false || freshness.window === 'Rejected') {
    push('freshnessRejected', freshness.code || 'FRESHNESS_OLDER_THAN_14D');
  }

  const suppressionCode = entry.suppression?.code || entry.suppressionCode || '';
  if (entry.historicalSuppressed === true || suppressionCode === 'HISTORICAL_SUPPRESSED') {
    push('historicalSuppressed', suppressionCode || 'HISTORICAL_SUPPRESSED');
  } else if (suppressionCode === 'SUPPRESSED_BACKFILL_ALREADY_SEEN') {
    push('suppressedBackfillAlreadySeen', suppressionCode);
  } else if (suppressionCode === 'SUPPRESSED_COOLDOWN_7D') {
    push('suppressedCooldown', suppressionCode);
  } else if (suppressionCode === 'SUPPRESSED_ACTIONED') {
    push('suppressedActioned', suppressionCode);
  } else if (suppressionCode === 'SUPPRESSED_REJECTED') {
    push('suppressedRejected', suppressionCode);
  } else if (entry.suppression?.suppressed === true && suppressionCode) {
    push('suppressedCooldown', suppressionCode);
  }

  return ordered;
}

/**
 * Assign one mutually exclusive first-failure (or survival) bucket per observation.
 */
export function assignFirstFailure(entry = {}) {
  const evidence = collectFailureEvidence(entry);
  if (evidence.length) {
    return {
      bucket: evidence[0].bucket,
      code: evidence[0].code,
      alsoFailed: evidence.slice(1).map((item) => ({ bucket: item.bucket, code: item.code })),
    };
  }
  if (entry.selected === true) {
    return { bucket: 'selected', code: 'SELECTED', alsoFailed: [] };
  }
  return { bucket: 'notSelected', code: entry.notSelectedCode || 'NOT_SELECTED', alsoFailed: [] };
}

function blankAlsoFailed() {
  return {
    byBucket: EMPTY_FIRST_FAILURES(),
    byCode: {},
    total: 0,
  };
}

/**
 * Build a reconciled funnel report from classified observations + lifecycle inputs.
 *
 * @param {object} input
 * @param {Array} input.observations - classified entries with eligibility/freshness/suppression
 * @param {object} [input.lifecycle] - optional precomputed lifecycle counts
 * @param {object} [input.sourceHealth] - optional source and board health telemetry
 */
export function buildFunnelReport({ observations = [], lifecycle = {}, sourceHealth = {} } = {}) {
  const normalized = observations.length;
  const firstFailures = EMPTY_FIRST_FAILURES();
  const firstFailureCodes = {};
  const alsoFailed = blankAlsoFailed();
  const freshnessClasses = {
    Hot: 0,
    Active: 0,
    Backfill: 0,
    VerifyQueue: 0,
    Rejected: 0,
    workdayUncorroborated: 0,
  };
  const freshnessClassesByProvider = {};
  const indiaHiringCompanyKeys = new Set();

  let eligible = 0;
  let historicallySuppressed = 0;
  let ready = 0;
  let selected = 0;

  for (const entry of observations) {
    const candidate = entry.candidate || {};
    const freshness = entry.freshness || {};
    const provider = String(candidate.provider ?? '').trim() || 'unknown';
    if (!freshnessClassesByProvider[provider]) {
      freshnessClassesByProvider[provider] = {
        Hot: 0,
        Active: 0,
        Backfill: 0,
        VerifyQueue: 0,
        Rejected: 0,
        workdayUncorroborated: 0,
      };
    }
    const providerFreshnessClasses = freshnessClassesByProvider[provider];
    if (freshness.window && Object.prototype.hasOwnProperty.call(freshnessClasses, freshness.window)) {
      freshnessClasses[freshness.window] += 1;
      providerFreshnessClasses[freshness.window] += 1;
    }
    if (freshness.workdayUncorroborated === true
      || freshness.code === 'FRESHNESS_WORKDAY_UNCORROBORATED_VERIFY_QUEUE') {
      freshnessClasses.workdayUncorroborated += 1;
      providerFreshnessClasses.workdayUncorroborated += 1;
    }
    if (entry.eligibility?.eligible === true) eligible += 1;
    const indiaLocated = WORKDAY_DEFAULT_LOCATION_KEYWORDS.some((keyword) => String(candidate.location ?? '').toLowerCase().includes(keyword));
    const companyKey = String(candidate.company ?? '').trim().toLowerCase();
    if (entry.eligibility?.eligible === true && indiaLocated && companyKey) {
      indiaHiringCompanyKeys.add(companyKey);
    }
    if (entry.historicalSuppressed === true
      || entry.suppression?.code === 'HISTORICAL_SUPPRESSED') {
      historicallySuppressed += 1;
    }
    if (entry.ready === true || entry.candidate?.applicationReady === true || entry.applicationReady === true) {
      ready += 1;
    }
    if (entry.selected === true) selected += 1;

    const assignment = assignFirstFailure(entry);
    firstFailures[assignment.bucket] = (firstFailures[assignment.bucket] || 0) + 1;
    firstFailureCodes[assignment.code] = (firstFailureCodes[assignment.code] || 0) + 1;
    for (const extra of assignment.alsoFailed) {
      alsoFailed.byBucket[extra.bucket] = (alsoFailed.byBucket[extra.bucket] || 0) + 1;
      alsoFailed.byCode[extra.code] = (alsoFailed.byCode[extra.code] || 0) + 1;
      alsoFailed.total += 1;
    }
  }

  const firstFailureTotal = Object.values(firstFailures).reduce((sum, value) => sum + number(value), 0);
  const reconciled = firstFailureTotal === normalized;

  const lifecycleCounts = {
    fetched: number(lifecycle.fetched ?? normalized),
    dated: number(lifecycle.dated ?? observations.filter((entry) => entry.candidate?.postedAt != null).length),
    sourceFiltered: number(lifecycle.sourceFiltered ?? lifecycle.fetched ?? normalized),
    normalized,
    eligible: number(lifecycle.eligible ?? eligible),
    freshnessClassified: normalized,
    freshnessClasses,
    freshnessClassesByProvider,
    indiaHiringCompanies: indiaHiringCompanyKeys.size,
    newlyActionable: number(lifecycle.newlyActionable ?? 0),
    newlyDated: number(lifecycle.newlyDated ?? 0),
    newlyActionableTracked: lifecycle.newlyActionable != null,
    historicalSuppressed: number(lifecycle.historicalSuppressed ?? historicallySuppressed),
    suppressedCooldown: number(lifecycle.suppressedCooldown ?? firstFailures.suppressedCooldown),
    suppressedBackfillAlreadySeen: number(
      lifecycle.suppressedBackfillAlreadySeen ?? firstFailures.suppressedBackfillAlreadySeen,
    ),
    suppressedActioned: number(lifecycle.suppressedActioned ?? firstFailures.suppressedActioned),
    verifyQueue: number(lifecycle.verifyQueue ?? firstFailures.verifyQueue),
    workdayUncorroboratedVerifyQueue: number(
      lifecycle.workdayUncorroboratedVerifyQueue ?? freshnessClasses.workdayUncorroborated,
    ),
    ready: number(lifecycle.ready ?? ready),
    scored: number(lifecycle.scored ?? 0),
    selected: number(lifecycle.selected ?? selected),
  };

  const report = {
    schemaVersion: 'LaunchpadFunnelReportV1',
    lifecycle: lifecycleCounts,
    firstFailures,
    firstFailureCodes,
    alsoFailed,
    sourceHealth,
    reconciliation: {
      normalized,
      firstFailureTotal,
      ok: reconciled,
      delta: firstFailureTotal - normalized,
    },
  };
  report.narrative = formatFunnelNarrative(report);
  return report;
}

/**
 * Human-readable narrative derived only from report counters (never free-hand claims).
 */
export function formatFunnelNarrative(report) {
  const life = report?.lifecycle || {};
  const first = report?.firstFailures || {};
  const also = report?.alsoFailed || {};
  const lines = [];

  lines.push(
    `Fetched ${number(life.fetched)} records; dated ${number(life.dated)}; source-filtered ${number(life.sourceFiltered)}; normalized observations ${number(life.normalized)}.`,
  );
  lines.push(
    `Eligible ${number(life.eligible)}; verify-queue ${number(life.verifyQueue)} (Workday uncorroborated ${number(life.workdayUncorroboratedVerifyQueue)}); ready ${number(life.ready)}; selected ${number(life.selected)}.`,
  );

  if (life.newlyActionableTracked) {
    lines.push(`Newly actionable ${number(life.newlyActionable)}.`);
  } else {
    lines.push('Newly actionable not yet tracked: 0.');
  }

  const failureParts = FIRST_FAILURE_GATE_ORDER
    .filter((bucket) => number(first[bucket]) > 0)
    .map((bucket) => `${bucket}=${number(first[bucket])}`);
  lines.push(
    failureParts.length
      ? `First-failure exits (mutually exclusive, sum=${number(report.reconciliation?.firstFailureTotal)}): ${failureParts.join(', ')}.`
      : `First-failure exits (mutually exclusive, sum=${number(report.reconciliation?.firstFailureTotal)}): none.`,
  );

  if (number(also.total) > 0) {
    const alsoParts = Object.entries(also.byBucket || {})
      .filter(([, count]) => number(count) > 0)
      .map(([bucket, count]) => `${bucket}=${number(count)}`);
    lines.push(`Also failed (overlapping evidence, not in first-failure totals): ${alsoParts.join(', ')}.`);
  } else {
    lines.push('Also failed (overlapping evidence, not in first-failure totals): none.');
  }

  lines.push(
    `Historical suppressions ${number(life.historicalSuppressed)}; cooldown suppressions ${number(life.suppressedCooldown)}; previously-observed backfill suppressions ${number(life.suppressedBackfillAlreadySeen)}.`,
  );

  if (report.reconciliation?.ok) {
    lines.push(`Reconciliation OK: first-failure total ${number(report.reconciliation.firstFailureTotal)} equals normalized ${number(report.reconciliation.normalized)}.`);
  } else {
    lines.push(
      `Reconciliation FAILED: first-failure total ${number(report.reconciliation?.firstFailureTotal)} vs normalized ${number(report.reconciliation?.normalized)} (delta ${number(report.reconciliation?.delta)}).`,
    );
  }

  return lines.join('\n');
}

export default buildFunnelReport;
