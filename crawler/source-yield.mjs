const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const SOURCE_IDS = {
  atsWarm: 'ats-warm', atsBatch1: 'ats-batch-1', atsBatch2: 'ats-batch-2', enterprise: 'ats-enterprise',
  indeed: 'indeed-inbox', connectorInbox: 'connector-inbox', theirstack: 'theirstack', startup: 'startup-mode',
  remote: 'remote-mode', portals: 'portal-discovery', indiaStartup: 'india-startup', searxng: 'searxng-search',
  brave: 'brave-search', careerSites: 'career-sites', commercialRescue: 'commercial-rescue', trackedAts: 'tracked-ats',
};

// Report source outcomes separately from the execution states used by recovery.
export function buildSourceEndStates(sourceTelemetry = {}, sources = {}) {
  const states = {};
  // Include each provider's result from grouped source manifests.
  const add = (id, value) => {
    const detail = value.detail ?? value;
    const reason = detail.reason ?? detail.reasonCode ?? value.error ?? detail.errors?.[0]
      ?? (['succeeded', 'ok', 'empty', 'degraded'].includes(value.status) ? 'no-records-returned'
        : value.status ? `source-${value.status}` : 'no-records-returned');
    states[id] = detail.status === 'disabled'
      ? { state: 'disabled', reason: detail.reason ?? 'disabled-by-decision' }
      : number(value.fetched ?? detail.fetched ?? value.observations) > 0
        ? { state: 'ok' } : { state: 'empty', reason };
    for (const lane of detail.telemetry?.lanes ?? []) add(lane.sourceId, lane);
  };
  for (const [id, value] of Object.entries(sourceTelemetry)) add(id, value);
  for (const [key, id] of Object.entries(SOURCE_IDS)) {
    if (!Object.hasOwn(sources, key)) continue;
    if (sources[key]?.enabled === false) states[id] = { state: 'disabled', reason: 'disabled-in-config' };
    else states[id] ??= { state: 'empty', reason: key === 'careerSites' && !sources[key]?.length
      ? 'no-career-sites-configured' : 'source-not-planned' };
  }
  for (const [key, provider] of Object.entries({ linkedin: 'linkedin-jobs', glassdoor: 'glassdoor', instahyre: 'instahyre', wellfound: 'wellfound' })) {
    const portal = sources.portals?.[key];
    if (!portal) continue;
    const id = `portal-${provider}`;
    if (sources.portals.enabled === false || portal.enabled === false) states[id] = { state: 'disabled', reason: 'disabled-in-config' };
    else states[id] ??= { state: 'empty', reason: 'portal-not-run' };
  }
  return states;
}
const INDIA_LOCATION = /\b(india|ind|pune|bengaluru|bangalore|hyderabad|chennai|gurugram|gurgaon|noida|new delhi|delhi|ncr|mumbai|maharashtra|karnataka|telangana|tamil nadu)\b/i;
const keyFor = (candidate, fallback) => {
  const provider = candidate?.provider || fallback || 'unknown';
  const board = candidate?.evidence?.board || candidate?.company || 'unknown';
  return `${provider}:${String(board).trim().toLowerCase().replace(/\s+/g, '-')}`;
};

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
    const candidate = record?._crawlerReserveEntry?.candidate || record;
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

export default buildSourceYieldReport;
