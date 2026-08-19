const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export function buildCalibrationReport(runs = [], { minimumDays = 7 } = {}) {
  const source = Array.isArray(runs) ? runs : [];
  const bySource = new Map();
  for (const run of source) {
    for (const row of run?.sourceTelemetry ? Object.values(run.sourceTelemetry) : []) {
      const id = row.sourceId || row.source || 'unknown';
      const current = bySource.get(id) || { sourceId: id, requests: 0, fetched: 0, ready: 0, verification: 0, rejected: 0, selected: 0, runs: 0 };
      current.requests += number(row.requests ?? row.budgetUsed);
      current.fetched += number(row.fetched);
      current.ready += number(row.applicationReady ?? row.ready);
      current.verification += number(row.verification ?? row.verificationQueue);
      current.rejected += number(row.rejected);
      current.selected += number(row.selected);
      current.runs += 1;
      bySource.set(id, current);
    }
  }
  const ready = source.reduce((sum, run) => sum + number(run?.counts?.applicationReady ?? run?.reserve?.length), 0);
  return {
    schemaVersion: 'LaunchpadCalibrationReportV1',
    runs: source.length,
    minimumDays,
    consecutiveOperationalDays: source.length,
    readyRoles: ready,
    applicationReadyYield: source.length ? ready / source.length : 0,
    sourceTelemetry: [...bySource.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    decisions: source.length < minimumDays ? { status: 'insufficient-window', reason: `requires ${minimumDays} operational days` } : { status: 'evidence-ready', reason: 'review precision and application-ready yield' },
    noGateRelaxation: true,
    noAutoApply: true,
    noAutoSend: true,
  };
}

export default buildCalibrationReport;
