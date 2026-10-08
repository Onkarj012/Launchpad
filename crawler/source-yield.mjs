const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
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

export default buildSourceYieldReport;
