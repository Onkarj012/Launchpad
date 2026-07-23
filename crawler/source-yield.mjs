const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
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
  return { schemaVersion: 'LaunchpadSourceYieldV1', sources, totals, calibration: { minimumRunsForPause: minimumRuns, automaticPause: false } };
}

export default buildSourceYieldReport;
