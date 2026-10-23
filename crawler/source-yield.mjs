const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const SOURCE_IDS = {
  atsWarm: 'ats-warm', atsBatch1: 'ats-batch-1', atsBatch2: 'ats-batch-2', enterprise: 'ats-enterprise',
  indeed: 'indeed-inbox', connectorInbox: 'connector-inbox', theirstack: 'theirstack', startup: 'startup-mode',
  remote: 'remote-mode', portals: 'portal-discovery', indiaStartup: 'india-startup', searxng: 'searxng-search',
  brave: 'brave-search', careerSites: 'career-sites', commercialRescue: 'commercial-rescue', trackedAts: 'tracked-ats',
};

// Statuses for sources that were planned or configured but never fetched.
const NOT_STARTED_STATUSES = new Set(['pending', 'notStarted', 'not_started', 'unattempted', 'omitted_by_planner', 'omitted_by_runtime']);

// Preserve explicit failure and incomplete-scan evidence even when records were fetched.
function sourceHealth(value) {
  const detail = value.detail ?? value.manifest ?? value;
  const telemetry = detail.telemetry ?? {};
  const evidence = [value, detail, telemetry];
  const statuses = evidence.flatMap((entry) => [entry.status, entry.scanStatus]).filter(Boolean);
  const childFailure = [...(detail.sources ?? []), ...(telemetry.lanes ?? [])].map(sourceHealth).find((health) => health && health.state !== 'disabled');
  const reason = detail.reason ?? detail.reasonCode ?? value.error ?? detail.error ?? detail.errors?.[0] ?? childFailure?.reason;
  if (statuses.includes('disabled')) return { state: 'disabled', reason: reason ?? 'disabled-by-decision' };
  if (statuses.some((status) => ['failed', 'unavailable', 'completed_with_failures'].includes(status))
    || evidence.some((entry) => entry.error || entry.errors?.length || entry.failures?.length || number(entry.boardsFailed ?? entry.failed) > 0)) {
    return { state: 'failed', reason: reason ?? 'source-failed' };
  }
  if (statuses.includes('interrupted') || evidence.some((entry) => entry.interrupted === true)) return { state: 'interrupted', reason: reason ?? 'source-interrupted' };
  if (statuses.some((status) => ['truncated', 'checkpointed'].includes(status)) || evidence.some((entry) => entry.truncated === true || entry.naturalTerminal === false)) return { state: 'truncated', reason: reason ?? 'source-truncated' };
  if (statuses.some((status) => ['degraded', 'partial', 'incomplete'].includes(status))) return { state: 'degraded', reason: reason ?? 'source-degraded' };
  return childFailure ?? null;
}

// Report source outcomes separately from the execution states used by recovery.
export function buildSourceEndStates(sourceTelemetry = {}, sources = {}) {
  const states = {};
  // Include each provider's result from grouped source manifests.
  const add = (id, value) => {
    const detail = value.detail ?? value;
    const notStarted = NOT_STARTED_STATUSES.has(value.status);
    const reason = detail.reason ?? detail.reasonCode ?? value.error ?? detail.errors?.[0]
      ?? (notStarted ? 'source-not-started'
        : ['succeeded', 'ok', 'empty', 'degraded'].includes(value.status) ? 'no-records-returned'
          : value.status ? `source-${value.status}` : 'no-records-returned');
    states[id] = sourceHealth(value)
      ?? (notStarted ? { state: 'not_started', reason }
        : number(value.fetched ?? detail.fetched ?? value.observations) > 0 ? { state: 'ok' } : { state: 'empty', reason });
    for (const lane of detail.telemetry?.lanes ?? []) add(lane.sourceId, lane);
  };
  for (const [id, value] of Object.entries(sourceTelemetry)) add(id, value);
  for (const [key, id] of Object.entries(SOURCE_IDS)) {
    if (!Object.hasOwn(sources, key)) continue;
    if (sources[key]?.enabled === false) states[id] = { state: 'disabled', reason: 'disabled-in-config' };
    else states[id] ??= key === 'careerSites' && !sources[key]?.length
      ? { state: 'empty', reason: 'no-career-sites-configured' }
      : { state: 'not_started', reason: 'source-not-planned' };
  }
  for (const [key, provider] of Object.entries({ linkedin: 'linkedin-jobs', glassdoor: 'glassdoor', instahyre: 'instahyre', wellfound: 'wellfound' })) {
    const portal = sources.portals?.[key];
    if (!portal) continue;
    const id = `portal-${provider}`;
    if (sources.portals.enabled === false || portal.enabled === false) states[id] = { state: 'disabled', reason: 'disabled-in-config' };
    else states[id] ??= { state: 'not_started', reason: 'portal-not-run' };
  }
  return states;
}
const INDIA_LOCATION = /\b(india|ind|pune|bengaluru|bangalore|hyderabad|chennai|gurugram|gurgaon|noida|new delhi|delhi|ncr|mumbai|maharashtra|karnataka|telangana|tamil nadu)\b/i;
const keyFor = (candidate, fallback) => {
  const provider = candidate?.provider || fallback || 'unknown';
  const board = candidate?.evidence?.board || candidate?.company || 'unknown';
  return `${provider}:${String(board).trim().toLowerCase().replace(/\s+/g, '-')}`;
};

// Allow an explicitly enabled avenue for seven IST dates from its trial start.
export function isSourceTrialActive(source, runAt) {
  if (source?.enabled !== true || !/^\d{4}-\d{2}-\d{2}$/.test(source.trialStartDate || '')) return false;
  const start = Date.parse(`${source.trialStartDate}T00:00:00+05:30`);
  const now = Date.parse(runAt);
  return Number.isFinite(start) && new Date(start + 19800000).toISOString().slice(0, 10) === source.trialStartDate
    && now >= start && now < start + 7 * 86400000;
}

// Report each avenue's retained seven-day yield without inventing missing observations.
export function buildAvenueTrialReport(runs = [], { trialStartDate } = {}) {
  const startAt = `${trialStartDate}T00:00:00+05:30`;
  if (!isSourceTrialActive({ enabled: true, trialStartDate }, startAt)) throw new TypeError('requires valid trialStartDate');
  const expectedDates = Array.from({ length: 7 }, (_, index) => new Date(Date.parse(startAt) + 19800000 + index * 86400000).toISOString().slice(0, 10));
  const sources = ['hn-discovery', 'yc-discovery'].map((sourceId) => {
    const days = new Set();
    const seenRuns = new Set();
    const row = { sourceId, requests: 0, fetched: 0, leads: 0, verification: 0, applicationReady: 0 };
    for (const input of runs) {
      const run = input.crawler ?? input;
      const runAt = run.runAt ?? run.run?.startedAt;
      if (!isSourceTrialActive({ enabled: true, trialStartDate }, runAt)) continue;
      const key = run.runId ?? run.run?.runId;
      if (!key || seenRuns.has(key)) continue;
      seenRuns.add(key);
      const source = run.sourceTelemetry?.[sourceId];
      if (!source) continue;
      const detail = source.detail ?? {};
      const telemetry = detail.telemetry ?? {};
      const yields = run.sourceYield?.sources;
      row.requests += number(telemetry.requests);
      row.fetched += number(telemetry.fetched ?? telemetry.resultCount);
      row.leads += number(telemetry.extracted);
      row.verification += number(telemetry.unresolved);
      const healthy = ['ok', 'empty', 'succeeded'].includes(source.status)
        && sourceHealth(source) === null
        && (source.naturalTerminal ?? detail.naturalTerminal) === true
        && !source.truncated && !detail.truncated
        && Number.isFinite(telemetry.requests) && Array.isArray(yields);
      if (!healthy) continue;
      const date = new Date(Date.parse(runAt) + 19800000).toISOString().slice(0, 10);
      days.add(date);
      row.applicationReady += yields.filter((yieldRow) => yieldRow.provider === sourceId).reduce((sum, yieldRow) => sum + number(yieldRow.applicationReady), 0);
    }
    const complete = expectedDates.every((date) => days.has(date));
    return { ...row, daysObserved: days.size, missingDates: expectedDates.filter((date) => !days.has(date)), applicationReadyPerRequest: row.requests ? row.applicationReady / row.requests : null, decision: complete ? row.applicationReady ? 'keep' : 'drop' : 'insufficient-evidence' };
  });
  return { schemaVersion: 'LaunchpadAvenueTrialYieldV1', trialStartDate, trialEndDate: expectedDates.at(-1), timezone: 'Asia/Kolkata', sources, countScope: 'per-run observations, not unique roles across the week', requestScope: 'discovery requests only; employer resolver requests excluded', automaticPause: false, noAutoApply: true };
}

function blank(sourceId, candidate = {}) {
  return {
    sourceId,
    provider: candidate.provider || 'unknown',
    board: candidate.evidence?.board || null,
    company: candidate.company || null,
    fetched: 0,
    indiaBased: 0,
    targetTitle: 0,
    freshWithinSevenDays: 0,
    experienceCompatible: 0,
    applicationReady: 0,
    foreignDiscardedAtSource: 0,
  };
}

/**
 * Build the operator-facing source-quality funnel from fully prepared records.
 * A board is never auto-paused from one run; seven-day calibration decides that.
 */
export function buildSourceYieldReport(records = [], sourceTelemetry = {}, options = {}) {
  const rows = {};
  for (const record of records) {
    const preparedCandidate = record?._crawlerReserveEntry?.candidate || record;
    const candidate = ['hn-discovery', 'yc-discovery'].includes(record?.sourceId)
      ? { ...preparedCandidate, provider: record.sourceId }
      : preparedCandidate;
    const prepared = record?._crawlerReserveEntry || {};
    const sourceId = keyFor(candidate, record?.sourceId);
    const row = rows[sourceId] ||= blank(sourceId, candidate);
    row.fetched += 1;
    if (INDIA_LOCATION.test(String(candidate?.location || '')) || prepared.eligibility?.geo?.pass === true) row.indiaBased += 1;
    if (prepared.eligibility?.title?.pass === true) row.targetTitle += 1;
    if (prepared.freshness?.eligible === true && number(prepared.freshness?.ageHours) <= 168) row.freshWithinSevenDays += 1;
    if (prepared.eligibility?.experience?.pass === true && prepared.eligibility?.experience?.manualReview !== true) row.experienceCompatible += 1;
    if (candidate?.applicationReady === true || candidate?.readiness?.ready === true) row.applicationReady += 1;
  }

  for (const [laneId, telemetry] of Object.entries(sourceTelemetry || {})) {
    const details = telemetry?.detail?.sources || telemetry?.detail?.sourceYields || [];
    for (const detail of details) {
      const sourceId = `${detail.provider || laneId}:${String(detail.board || detail.source || 'unknown').toLowerCase()}`;
      const row = rows[sourceId] ||= blank(sourceId, { provider: detail.provider, company: detail.company, evidence: { board: detail.board } });
      row.fetched = Math.max(row.fetched, number(detail.fetched));
      row.foreignDiscardedAtSource += number(detail.foreignDiscardedAtSource ?? detail.foreignDiscarded);
      const foreignPassedThroughAtSource = number(detail.foreignPassedThroughAtSource);
      if (foreignPassedThroughAtSource) row.foreignPassedThroughAtSource = number(row.foreignPassedThroughAtSource) + foreignPassedThroughAtSource;
    }
  }

  const minimumFetched = number(options.minimumFetchedForReview || 100);
  const minimumRuns = number(options.minimumRunsForPause || 3);
  const sources = Object.values(rows).sort((a, b) => a.sourceId.localeCompare(b.sourceId)).map((row) => ({
    ...row,
    applicationReadyYield: row.fetched > 0 ? row.applicationReady / row.fetched : null,
    pauseRecommendation: {
      eligible: false,
      requiredRuns: minimumRuns,
      reason: row.fetched >= minimumFetched && row.applicationReady === 0
        ? `zero application-ready roles after ${row.fetched} fetched; monitor until ${minimumRuns} runs`
        : 'insufficient evidence for pause',
    },
  }));
  const totals = sources.reduce((sum, row) => {
    for (const field of ['fetched', 'indiaBased', 'targetTitle', 'freshWithinSevenDays', 'experienceCompatible', 'applicationReady', 'foreignDiscardedAtSource']) sum[field] += row[field];
    return sum;
  }, { fetched: 0, indiaBased: 0, targetTitle: 0, freshWithinSevenDays: 0, experienceCompatible: 0, applicationReady: 0, foreignDiscardedAtSource: 0 });
  const foreignPassedThroughAtSource = sources.reduce((sum, row) => sum + number(row.foreignPassedThroughAtSource), 0);
  if (foreignPassedThroughAtSource) totals.foreignPassedThroughAtSource = foreignPassedThroughAtSource;
  return { schemaVersion: 'LaunchpadSourceYieldV1', sources, totals, calibration: { minimumRunsForPause: minimumRuns, automaticPause: false } };
}

const NOT_VERIFIED = 'Not Verified';
const RECOVERY_SOURCE_ID = 'held-lead-recovery';
const STAGE_FIELDS = ['jdPresent', 'hardEligibilityPassed', 'validScore', 'scoringFailed', 'historySuppressed', 'verification', 'selected', 'routeRecovered'];
const ALLOCATION_NOTE = 'Not provided; fetched row volume does not establish marginal useful yield.';
// Upstream buckets that are hard eligibility gates. A row that stopped at one of them has not passed it.
const HARD_GATE_BUCKETS = ['geo', 'title', 'experience', 'employment', 'salary', 'liveness', 'freshnessRejected'];
// Verification reasons that say a hard gate could not be confirmed. Only other reasons count as eligibility passed.
const HARD_GATE_UNVERIFIED = /NOT_VERIFIED|NOT_EXPLICIT|UNCLEAR|Not Verified/;

// Keep a recorded number, or the explicit gap when the run did not record it.
const recordedNumber = (value) => (Number.isFinite(value) ? value : NOT_VERIFIED);
const unknownCost = () => ({ requests: NOT_VERIFIED, durationMs: NOT_VERIFIED, failures: NOT_VERIFIED, truncated: NOT_VERIFIED });
const zeroStages = () => Object.fromEntries(STAGE_FIELDS.map((field) => [field, 0]));

// Read one source's cost from telemetry without splitting it across queries.
function sourceCost(telemetry) {
  const detail = telemetry?.detail ?? {};
  const failures = Array.isArray(telemetry?.failures) ? telemetry.failures.length : telemetry?.failures;
  return {
    requests: recordedNumber([telemetry?.requests, detail.requests, detail.telemetry?.requests].find(Number.isFinite)),
    durationMs: recordedNumber(telemetry?.durationMs),
    failures: recordedNumber(failures),
    truncated: typeof telemetry?.truncated === 'boolean' ? telemetry.truncated : NOT_VERIFIED,
  };
}

// Count hard eligibility only from explicit pass evidence; a gate that stayed unverified or unknown is not a pass.
function passedHardGates(row) {
  if (row.stage === 'verification') return !HARD_GATE_UNVERIFIED.test(row.reason ?? NOT_VERIFIED);
  return ['finalSelection', 'eligible', 'scoringFailure', 'historySuppression'].includes(row.stage)
    && !HARD_GATE_BUCKETS.includes(row.upstreamStage);
}

// Map one requisition's receipt stage onto the funnel stages it reached.
function identityStages(row) {
  return {
    jdPresent: row.jdHash != null,
    hardEligibilityPassed: passedHardGates(row),
    validScore: Number.isFinite(row.score) && row.scoringStatus === 'scored',
    scoringFailed: row.stage === 'scoringFailure',
    historySuppressed: row.stage === 'historySuppression',
    verification: row.stage === 'verification',
    selected: row.selected === true,
  };
}

// Tell whether a query diagnostic shows the query actually ran; skipped and unstarted queries did not.
function queryRan(diagnostic) {
  return Boolean(diagnostic) && diagnostic.status !== 'skipped' && !NOT_STARTED_STATUSES.has(diagnostic.status)
    && !(diagnostic.pagesFetched === 0 && diagnostic.interrupted !== true);
}

// Count the queries a source ran from its execution telemetry, including zero-result queries; null when telemetry does not say.
function queriesRun(telemetry) {
  const diagnostics = telemetry?.detail?.telemetry?.queryDiagnostics;
  return Array.isArray(diagnostics) ? diagnostics.filter(queryRan).length : null;
}

// Attribute useful outcomes to each source and query. A requisition counts once per group and once overall.
export function buildUsefulSourceYield({ identityRows = [], sourceTelemetry = {}, sourceEndStates = {}, heldLeadRecovery = null } = {}) {
  const rows = Array.isArray(identityRows) ? identityRows : [];
  const groups = new Map();
  for (const row of rows) {
    const stages = identityStages(row);
    for (const item of row.provenance ?? []) {
      const sourceId = item.sourceId ?? item.source ?? NOT_VERIFIED;
      const kind = item.sourceId === RECOVERY_SOURCE_ID || item.source === RECOVERY_SOURCE_ID || item.recovery === true ? 'recovery' : 'discovery';
      const queryId = item.queryId ?? NOT_VERIFIED;
      const key = JSON.stringify([sourceId, queryId, kind]);
      if (!groups.has(key)) groups.set(key, { sourceId, queryId, kind, referenceCount: 0, identities: new Set(), stages: zeroStages() });
      const group = groups.get(key);
      group.referenceCount += 1;
      if (group.identities.has(row.identityHash)) continue;
      group.identities.add(row.identityHash);
      const itemStages = { ...stages, routeRecovered: item.recoveryOutcome === 'recovered' };
      for (const field of STAGE_FIELDS) if (itemStages[field]) group.stages[field] += 1;
    }
  }
  // Retain queries with execution evidence even when they returned no requisitions.
  for (const [sourceId, telemetry] of Object.entries(sourceTelemetry)) {
    const diagnostics = telemetry?.detail?.telemetry?.queryDiagnostics;
    for (const diagnostic of Array.isArray(diagnostics) ? diagnostics : []) {
      if (!queryRan(diagnostic)) continue;
      const queryId = diagnostic.queryId ?? diagnostic.query
        ?? (Number.isInteger(diagnostic.queryIndex) ? `query-index:${diagnostic.queryIndex}` : NOT_VERIFIED);
      if (queryId === NOT_VERIFIED) continue;
      const key = JSON.stringify([sourceId, queryId, 'discovery']);
      if (!groups.has(key)) groups.set(key, { sourceId, queryId, kind: 'discovery', referenceCount: 0, identities: new Set(), stages: zeroStages() });
    }
  }
  const groupList = [...groups.values()];
  const rowsBySource = new Map();
  for (const group of groupList) rowsBySource.set(group.sourceId, (rowsBySource.get(group.sourceId) ?? 0) + 1);
  const recoveryGroups = groupList.filter((group) => group.kind === 'recovery');
  const recoveryRequests = Array.isArray(heldLeadRecovery?.outcomes)
    ? heldLeadRecovery.outcomes.reduce((sum, outcome) => sum + (Number.isFinite(outcome?.requests) ? outcome.requests : 0), 0)
    : null;
  // Recovery requests come from held-lead outcomes, and only when one recovery group owns them.
  const costFor = (group) => {
    if (group.kind === 'recovery') return recoveryGroups.length === 1 && recoveryRequests != null ? { ...unknownCost(), requests: recoveryRequests } : unknownCost();
    // A source's cost belongs to one row only when it ran one query, or has no query split and one row; otherwise it is Not Verified.
    const telemetry = sourceTelemetry[group.sourceId];
    const queries = queriesRun(telemetry);
    const onlyRow = (rowsBySource.get(group.sourceId) ?? 0) <= 1;
    const ownsCost = onlyRow && (queries === 1 || (queries === null && group.queryId === NOT_VERIFIED));
    return ownsCost ? sourceCost(telemetry) : unknownCost();
  };
  // Sources with telemetry or an end state but no useful rows still get a row.
  const groupedSources = new Set(groupList.map((group) => group.sourceId));
  const idleSources = [...new Set([...Object.keys(sourceTelemetry ?? {}), ...Object.keys(sourceEndStates)])]
    .filter((sourceId) => !groupedSources.has(sourceId))
    .map((sourceId) => ({ sourceId, queryId: NOT_VERIFIED, kind: 'discovery', referenceCount: 0, identities: new Set(), stages: zeroStages() }));
  const sources = [...groupList, ...idleSources]
    .sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)) || String(a.queryId).localeCompare(String(b.queryId)) || a.kind.localeCompare(b.kind))
    .map((group) => ({
      sourceId: group.sourceId,
      queryId: group.queryId,
      kind: group.kind,
      referenceCount: group.referenceCount,
      uniqueRequisitions: group.identities.size,
      stages: group.stages,
      endState: sourceEndStates[group.sourceId]?.state ?? NOT_VERIFIED,
      endReason: sourceEndStates[group.sourceId]?.reason ?? NOT_VERIFIED,
      cost: costFor(group),
    }));
  const identityCount = Array.isArray(identityRows)
    ? new Set(rows.map((row) => row.identityHash).filter((hash) => hash && hash !== NOT_VERIFIED)).size
    : NOT_VERIFIED;
  return { schemaVersion: 'LaunchpadUsefulSourceYieldV1', scope: 'final-selection', identityCount, sources, allocationRecommendation: ALLOCATION_NOTE };
}

export default buildSourceYieldReport;
