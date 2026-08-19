const FUNNEL = ['fetched', 'changed', 'resolved', 'verified', 'duplicate', 'suppressed', 'selected', 'failed', 'applicationReady', 'freshNew'];
const MISS_CLASSES = ['query', 'discovery', 'resolution', 'parsing', 'gating', 'dedup', 'timing', 'unknown'];

const array = (value) => Array.isArray(value) ? value : [];
const number = (value) => {
  if (value === null || value === '' || value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
};
const first = (row, names) => {
  for (const name of names) {
    const value = number(row?.[name]);
    if (value !== null) return value;
  }
  return null;
};
const sourceRows = (run) => {
  if (Array.isArray(run?.sources)) return run.sources;
  const value = run?.sourceTelemetry ?? run?.telemetry?.sources ?? run?.telemetry;
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value).map(([sourceId, row]) => ({ sourceId, ...row }));
  return [];
};
const sourceName = (row) => String(row?.sourceId ?? row?.id ?? row?.source ?? 'unknown');
const providerName = (row) => String(row?.provider ?? row?.sourceProvider ?? row?.providerId ?? sourceName(row));
const laneName = (row) => String(row?.lane ?? row?.sourceLane ?? 'unknown');
const metric = (row, name) => first(row, [name, name === 'duplicate' ? 'duplicates' : name, name === 'applicationReady' ? 'application_ready' : name, name === 'freshNew' ? 'fresh_new' : name]);

function addKnown(rows, names) {
  const values = rows.map((row) => first(row, names));
  return values.some((value) => value === null) ? null : values.reduce((sum, value) => sum + value, 0);
}
function rate(numerator, denominator) {
  return numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null;
}
function median(values) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function labelOf(run) {
  const raw = run?.date ?? run?.runDate ?? run?.finishedAt ?? run?.startedAt;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
function allRunRows(runs) { return runs.flatMap(sourceRows); }
function qualityRows(runs) { return runs.map((run) => run.quality ?? run.qualityAudit ?? {}).filter((row) => row && Object.keys(row).length); }
function conversionRows(runs) { return runs.map((run) => run.conversion ?? run.lifecycle?.conversion ?? {}).filter((row) => row && Object.keys(row).length); }
function contactRows(runs) { return runs.map((run) => run.contacts ?? run.contactYield ?? {}).filter((row) => row && Object.keys(row).length); }

export function classifyMissedRole(role = {}) {
  let classification = 'unknown';
  if (role.queryMatched === false || role.queryMiss === true) classification = 'query';
  else if (role.queryMatched === true && (role.discovered === false || role.discoveryMiss === true)) classification = 'discovery';
  else if (role.discovered === true && (role.resolved === false || role.resolutionMiss === true)) classification = 'resolution';
  else if (role.resolved === true && (role.parsed === false || role.parsingMiss === true)) classification = 'parsing';
  else if (role.parsed === true && (role.eligible === false || role.gated === true)) classification = 'gating';
  else if (role.eligible === true && (role.duplicate === true || role.dedupMiss === true)) classification = 'dedup';
  else if (role.eligible === true && role.duplicate === false && (role.seenInWindow === false || role.timingMiss === true)) classification = 'timing';
  return { ...role, classification };
}

function buildSource(row) {
  const result = { lane: laneName(row) };
  for (const name of FUNNEL) result[name] = metric(row, name);
  result.applicationReadyYield = rate(result.applicationReady, result.fetched);
  result.freshNewYield = rate(result.freshNew, result.fetched);
  return result;
}

export function auditRuns({ runs = [], missedRoles = [] } = {}) {
  const sanitizedRuns = array(runs).filter(Boolean);
  const rows = allRunRows(sanitizedRuns);
  const bySource = {};
  const byProvider = {};
  for (const row of rows) {
    const source = sourceName(row);
    const provider = providerName(row);
    const merge = (target, key) => {
      if (!target[key]) target[key] = { lane: laneName(row), ...Object.fromEntries(FUNNEL.map((name) => [name, []])) };
      for (const name of FUNNEL) target[key][name].push(metric(row, name));
    };
    merge(bySource, source); merge(byProvider, provider);
  }
  const finishGroup = (groups) => Object.fromEntries(Object.entries(groups).map(([key, values]) => {
    const result = { lane: values.lane };
    for (const name of FUNNEL) result[name] = values[name].some((value) => value === null) ? null : values[name].reduce((sum, value) => sum + value, 0);
    result.applicationReadyYield = rate(result.applicationReady, result.fetched);
    result.freshNewYield = rate(result.freshNew, result.fetched);
    return [key, result];
  }));
  const runFunnel = sanitizedRuns.map((run) => {
    const runRows = sourceRows(run);
    const result = Object.fromEntries(FUNNEL.map((name) => [name, addKnown(runRows, [name, name === 'duplicate' ? 'duplicates' : name])]));
    return { ...result, applicationReadyYield: rate(result.applicationReady, result.fetched), freshNewYield: rate(result.freshNew, result.fetched), date: labelOf(run) };
  });
  const totals = Object.fromEntries(FUNNEL.map((name) => [name, addKnown(rows, [name, name === 'duplicate' ? 'duplicates' : name])]));
  const unknowns = [];
  for (const [source, values] of Object.entries(finishGroup(bySource))) for (const name of FUNNEL) if (values[name] === null) unknowns.push(`source:${source}.${name}`);
  const quality = qualityRows(sanitizedRuns);
  const invalidGeography = addKnown(quality, ['invalidGeography', 'invalid_geography']);
  const invalidExperience = addKnown(quality, ['invalidExperience', 'invalid_experience']);
  const falsePositives = addKnown(quality, ['falsePositives', 'false_positives']);
  const novelSurfaced = addKnown(quality, ['novelSurfaced', 'novel_surfaced']);
  const previouslySurfacedAsNew = addKnown(quality, ['previouslySurfacedAsNew', 'previously_surfaced_as_new']);
  const qualityReport = { invalidGeography, invalidExperience, falsePositives, novelSurfaced, previouslySurfacedAsNew, falsePositiveRate: rate(falsePositives, novelSurfaced), noveltyAccuracy: novelSurfaced === null || previouslySurfacedAsNew === null ? null : rate(novelSurfaced - previouslySurfacedAsNew, novelSurfaced) };
  const contacts = contactRows(sanitizedRuns);
  const contactReport = { selectedApplications: addKnown(contacts, ['selectedApplications', 'selected_applications']), researchedApplications: addKnown(contacts, ['researchedApplications', 'researched_applications']), verifiedContacts: addKnown(contacts, ['verifiedContacts', 'verified_contacts']), verifiedYield: null };
  contactReport.verifiedYield = rate(contactReport.verifiedContacts, contactReport.selectedApplications);
  const conversion = conversionRows(sanitizedRuns);
  const conversionReport = { applications: addKnown(conversion, ['applications']), responses: addKnown(conversion, ['responses']), screens: addKnown(conversion, ['screens']) };
  conversionReport.applicationToResponse = rate(conversionReport.responses, conversionReport.applications);
  conversionReport.responseToScreen = rate(conversionReport.screens, conversionReport.responses);
  const classified = array(missedRoles).map(classifyMissedRole);
  const missedCounts = Object.fromEntries(MISS_CLASSES.map((name) => [name, classified.filter((role) => role.classification === name).length]));
  const gates = [
    { name: 'novelty-accuracy', pass: qualityReport.noveltyAccuracy !== null && previouslySurfacedAsNew === 0, reason: qualityReport.noveltyAccuracy === null ? 'unknown' : `${previouslySurfacedAsNew} previously surfaced roles mislabeled as new` },
    { name: 'false-positive-rate', pass: qualityReport.falsePositiveRate !== null && qualityReport.falsePositiveRate <= 0.1, reason: qualityReport.falsePositiveRate === null ? 'unknown' : qualityReport.falsePositiveRate },
    { name: 'required-funnel-metrics', pass: unknowns.length === 0, reason: unknowns.length ? `${unknowns.length} unknown metrics` : 'complete' },
  ];
  for (const name of ['invalidGeography', 'invalidExperience', 'falsePositives', 'novelSurfaced', 'previouslySurfacedAsNew', 'falsePositiveRate', 'noveltyAccuracy']) if (qualityReport[name] === null) unknowns.push(`quality.${name}`);
  for (const name of ['selectedApplications', 'researchedApplications', 'verifiedContacts', 'verifiedYield']) if (contactReport[name] === null) unknowns.push(`contacts.${name}`);
  for (const name of ['applications', 'responses', 'screens', 'applicationToResponse', 'responseToScreen']) if (conversionReport[name] === null) unknowns.push(`conversion.${name}`);
  return {
    schemaVersion: 'LaunchpadV5CrawlerAuditV1', runs: { supplied: sanitizedRuns.length, audited: sanitizedRuns.length },
    yield: { totals, bySource: finishGroup(bySource), byProvider: finishGroup(byProvider), perRun: runFunnel, medianApplicationReadyYield: median(runFunnel.map((run) => run.applicationReadyYield)), medianFreshNewYield: median(runFunnel.map((run) => run.freshNewYield)), daysWithTenFreshNew: runFunnel.filter((run) => run.freshNew !== null && run.freshNew >= 10).length },
    quality: qualityReport, contacts: contactReport, conversion: conversionReport,
    missedRoles: { total: classified.length, counts: missedCounts, roles: classified }, unknowns,
    releaseGate: { pass: gates.every((check) => check.pass), checks: gates },
  };
}

export const buildAuditReport = auditRuns;
export const auditCrawlRuns = auditRuns;
export const auditMissedRoles = (roles = []) => roles.map(classifyMissedRole);
export const serializeAudit = serializeAuditReport;
export function serializeAuditReport(report) { return JSON.stringify(report, null, 2); }
export default auditRuns;
