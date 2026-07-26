import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DAILY_REPORT_SCHEMA = 'LaunchpadDailyReportV1';

const UNKNOWN = 'Not Verified';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function valueOrNull(value) {
  return value === undefined || value === '' ? null : value;
}

function dateInIndia(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('daily report requires a valid runAt');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) ?? {};
}

function roleRecord(candidate, { ready }) {
  const seniority = firstObject(candidate.seniorityAssessment, candidate.seniorityScoringOpinion);
  const freshness = firstObject(candidate.freshness);
  const liveness = firstObject(candidate.liveness);
  const readiness = firstObject(candidate.readinessRepair, candidate.readiness, candidate.applicationReadiness);
  const readinessBlockers = [
    ...asArray(readiness.blockers),
    ...asArray(readiness.reasons),
    ...asArray(candidate.readinessBlockers),
    ...asArray(candidate.verificationBlockers),
  ];
  return {
    company: valueOrNull(candidate.company),
    title: valueOrNull(candidate.title),
    originalUrl: valueOrNull(candidate.originalApplicationUrl ?? candidate.canonicalUrl ?? candidate.discoveryUrl),
    liveness: {
      status: valueOrNull(liveness.status),
      verified: liveness.status === 'Active',
      checkedAt: valueOrNull(liveness.checkedAt ?? candidate.verifiedAt),
      evidence: valueOrNull(liveness.evidence),
    },
    freshness: {
      class: valueOrNull(candidate.freshnessWindow ?? freshness.window ?? candidate.waterfallBand),
      trusted: freshness.trusted === true
        || freshness.verified === true
        || ['Hot', 'Active', 'Backfill'].includes(candidate.freshnessWindow ?? freshness.window),
      postedAt: valueOrNull(candidate.postedAt),
      evidence: valueOrNull(freshness.evidence ?? candidate.evidence?.freshness),
    },
    seniority: {
      evidenceQuote: valueOrNull(seniority.evidenceQuote),
      decision: valueOrNull(seniority.seniorityDecision),
      reasonCode: valueOrNull(seniority.reasonCode),
    },
    matchScore: valueOrNull(candidate.matchScore),
    responseLikelihood: valueOrNull(candidate.responseLikelihood),
    strongestHook: valueOrNull(candidate.strongestHook ?? candidate.hook),
    readiness: {
      status: ready ? 'Ready' : valueOrNull(candidate.applicationReadiness ?? readiness.status),
      ready,
      blockers: [...new Set(readinessBlockers.filter(Boolean))],
    },
  };
}

function verificationRecord(row) {
  return {
    company: valueOrNull(row.company),
    title: valueOrNull(row.title),
    originalUrl: valueOrNull(row.originalApplicationUrl ?? row.discoveryUrl ?? row.canonicalUrl ?? row.url),
    blockers: [...new Set([...asArray(row.reasons), ...asArray(row.blockers)].filter(Boolean))],
    evidence: valueOrNull(row.evidence),
  };
}

function exactShortfall(shortfall, selectedCount) {
  const minimum = Number.isFinite(Number(shortfall?.minimum)) ? Number(shortfall.minimum) : 10;
  const selected = Number.isFinite(Number(shortfall?.selected)) ? Number(shortfall.selected) : selectedCount;
  const missing = Math.max(0, Number.isFinite(Number(shortfall?.missing))
    ? Number(shortfall.missing)
    : minimum - selected);
  const reasons = [...new Set(asArray(shortfall?.reasons).filter(Boolean))];
  return {
    minimum,
    selected,
    missing,
    reasons,
    explanation: missing
      ? `Selected ${selected} of the minimum ${minimum} application-ready roles; shortfall ${missing}. Reasons: ${reasons.length ? reasons.join(', ') : UNKNOWN}.`
      : `Selected ${selected} application-ready roles; minimum target ${minimum} met.`,
  };
}

function sourceHealth(run) {
  const crawler = run.crawlerV2Telemetry ?? {};
  return asArray(run.sourceManifests).map((manifest) => ({
    sourceId: valueOrNull(manifest.sourceId),
    status: valueOrNull(manifest.status),
    attempted: manifest.attempted !== false,
    configured: valueOrNull(manifest.boardsConfigured ?? crawler[manifest.sourceId]?.boardsConfigured),
    succeeded: valueOrNull(manifest.succeeded ?? crawler[manifest.sourceId]?.adapterSuccesses),
    degraded: manifest.status === 'degraded',
    failed: manifest.status === 'failed',
    omitted: valueOrNull(manifest.boardsOmitted ?? crawler[manifest.sourceId]?.boardsOmitted),
    rawRows: valueOrNull(manifest.fetched ?? crawler[manifest.sourceId]?.fetched),
    errors: asArray(manifest.errors),
  }));
}

export function buildDailyReport(run) {
  if (!run || typeof run !== 'object') throw new TypeError('daily report requires a run result');
  if (!run.runId) throw new TypeError('daily report requires runId');
  const selectedRoles = asArray(run.shortlist).map((candidate) => roleRecord(candidate, { ready: true }));
  const stretchRoles = asArray(run.stretchShortage).map((candidate) => roleRecord(candidate, { ready: false }));
  return {
    schemaVersion: DAILY_REPORT_SCHEMA,
    runId: run.runId,
    runAt: run.runAt,
    reportDate: dateInIndia(run.runAt),
    outcome: valueOrNull(run.outcome),
    selectedRoles,
    stretchRoles,
    verificationQueue: asArray(run.verificationQueue).map(verificationRecord),
    sourceHealth: sourceHealth(run),
    shortfall: exactShortfall(run.shortfall, selectedRoles.length),
    safety: {
      localOnly: true,
      noExternalWriteByDefault: true,
      noAutoApply: true,
      noAutoSend: true,
      userOwnedFieldsUnchanged: ['Make Resume', 'Applied?'],
    },
    delivery: {
      commitStatus: 'committed',
      surfacedStateCommitted: false,
    },
    telemetry: run.telemetry?.dco ? structuredClone(run.telemetry.dco) : null,
  };
}

function show(value) {
  if (value == null || value === '') return UNKNOWN;
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'None';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function roleMarkdown(role, index) {
  return [
    `### ${index + 1}. ${show(role.title)} at ${show(role.company)}`,
    '',
    `- Original employer/ATS URL: ${show(role.originalUrl)}`,
    `- Verified liveness: ${show(role.liveness.status)}; checked ${show(role.liveness.checkedAt)}; evidence ${show(role.liveness.evidence)}`,
    `- Trusted freshness: ${show(role.freshness.class)}; posted ${show(role.freshness.postedAt)}; evidence ${show(role.freshness.evidence)}`,
    `- Seniority: ${show(role.seniority.decision)}; exact evidence quote: ${show(role.seniority.evidenceQuote)}`,
    `- Match Score: ${show(role.matchScore)}`,
    `- Response Likelihood: ${show(role.responseLikelihood)}`,
    `- Strongest resume/outreach hook: ${show(role.strongestHook)}`,
    `- Readiness: ${show(role.readiness.status)}; blockers: ${show(role.readiness.blockers)}`,
    '',
  ].join('\n');
}

export function renderDailyReportMarkdown(receipt) {
  const selected = receipt.selectedRoles.length
    ? receipt.selectedRoles.map(roleMarkdown).join('\n')
    : 'No application-ready roles were selected.\n';
  const stretch = receipt.stretchRoles.length
    ? receipt.stretchRoles.map(roleMarkdown).join('\n')
    : 'No shortage-only stretch roles.\n';
  const verification = receipt.verificationQueue.length
    ? receipt.verificationQueue.map((row, index) => `${index + 1}. ${show(row.title)} at ${show(row.company)} — ${show(row.blockers)} — ${show(row.originalUrl)}`).join('\n')
    : 'No roles in verification queue.';
  const sources = receipt.sourceHealth.length
    ? receipt.sourceHealth.map((row) => `- ${show(row.sourceId)}: ${show(row.status)}; attempted=${row.attempted}; rawRows=${show(row.rawRows)}; errors=${show(row.errors)}`).join('\n')
    : 'No source-health records.';
  return [
    `# Launchpad daily report — ${receipt.reportDate}`,
    '',
    `Run ID: ${receipt.runId}`,
    '',
    '## Selected roles',
    '',
    selected,
    '## Shortage fallback and stretch',
    '',
    stretch,
    '## Verification queue',
    '',
    verification,
    '',
    '## Source health',
    '',
    sources,
    '',
    '## Shortfall',
    '',
    receipt.shortfall.explanation,
    '',
  ].join('\n');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeRunId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function durableWrite(filePath, contents, ops) {
  const descriptor = ops.openSync(filePath, 'wx', 0o600);
  try {
    ops.writeFileSync(descriptor, contents, 'utf8');
    ops.fsyncSync(descriptor);
  } finally {
    ops.closeSync(descriptor);
  }
}

function removeIfPresent(filePath, ops) {
  try {
    ops.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function commitDailyReport({
  run,
  directory = 'logs/daily',
  fileOps = {},
  beforeRename = null,
} = {}) {
  const ops = { ...fs, ...fileOps };
  const receipt = buildDailyReport(run);
  const resolvedDirectory = path.resolve(directory);
  const stem = `${receipt.reportDate}-launchpad`;
  const markdownPath = path.join(resolvedDirectory, `${stem}.md`);
  const jsonPath = path.join(resolvedDirectory, `${stem}.json`);
  if (ops.existsSync(jsonPath)) {
    const existing = JSON.parse(ops.readFileSync(jsonPath, 'utf8'));
    if (existing.runId !== run.runId) {
      throw new Error(`daily report path already committed by run ${existing.runId}`);
    }
    if (!ops.existsSync(markdownPath)) throw new Error(`daily report receipt exists without Markdown: ${jsonPath}`);
    return {
      idempotent: true,
      receipt: existing,
      markdownPath,
      jsonPath,
      hashes: {
        markdown: sha256(ops.readFileSync(markdownPath)),
        json: sha256(ops.readFileSync(jsonPath)),
      },
    };
  }
  ops.mkdirSync(resolvedDirectory, { recursive: true });
  const suffix = `${safeRunId(run.runId)}-${process.pid}`;
  const markdownTemp = path.join(resolvedDirectory, `.${stem}.${suffix}.md.tmp`);
  const jsonTemp = path.join(resolvedDirectory, `.${stem}.${suffix}.json.tmp`);
  const markdown = renderDailyReportMarkdown(receipt);
  if (receipt.telemetry?.operations) {
    receipt.telemetry.operations.localReportPaths = { markdown: markdownPath, json: jsonPath };
    receipt.telemetry.operations.localReportHashes = {
      markdown: sha256(markdown),
      json: null,
      hashScope: 'JSON payload before embedding localReportHashes.json',
    };
    const payloadBeforeChecksum = `${JSON.stringify(receipt, null, 2)}\n`;
    receipt.telemetry.operations.localReportHashes.json = sha256(payloadBeforeChecksum);
  }
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  let markdownRenamed = false;
  let jsonRenamed = false;
  try {
    durableWrite(markdownTemp, markdown, ops);
    durableWrite(jsonTemp, json, ops);
    beforeRename?.({ markdownTemp, jsonTemp, markdownPath, jsonPath });
    ops.renameSync(markdownTemp, markdownPath);
    markdownRenamed = true;
    ops.renameSync(jsonTemp, jsonPath);
    jsonRenamed = true;
    const directoryDescriptor = ops.openSync(resolvedDirectory, 'r');
    try {
      ops.fsyncSync(directoryDescriptor);
    } finally {
      ops.closeSync(directoryDescriptor);
    }
  } catch (error) {
    removeIfPresent(markdownTemp, ops);
    removeIfPresent(jsonTemp, ops);
    if (markdownRenamed && !jsonRenamed) removeIfPresent(markdownPath, ops);
    if (jsonRenamed && !markdownRenamed) removeIfPresent(jsonPath, ops);
    throw error;
  }
  return {
    idempotent: false,
    receipt,
    markdownPath,
    jsonPath,
    hashes: { markdown: sha256(markdown), json: sha256(json) },
  };
}

export default commitDailyReport;
