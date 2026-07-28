import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, loadConversionPlan, DEFAULT_CONFIG_PATH } from './config.mjs';
import { assertCandidate, buildPayloadRecord, candidateDedupKey, canonicalizeUrl, validatePayloadRecord } from './candidate.mjs';
import { classifyCandidate } from './eligibility.mjs';
import { annotateFreshness } from './freshness.mjs';
import { deduplicateCandidates } from './dedup.mjs';
import { selectCandidates } from './select.mjs';
import { selectApplicationShortlist } from './select.mjs';
import { scoreConversion } from './conversion-score.mjs';
import { readLedger } from './ledger.mjs';
import { readOpportunityLedger, recordSurfaced, suppressionFor } from './opportunity-ledger.mjs';
import { runTrackedScan, trackedCandidatesFromFixture } from './adapters/tracked.mjs';
import { runReverseAtsScan, reverseAtsCandidatesFromFixture } from './adapters/reverse-ats.mjs';
import { importPublicSearchCandidates } from './adapters/public-search.mjs';
import { importIndeedCandidates, indeedUnavailable } from './adapters/indeed.mjs';
import { enrichWorkdayCandidates } from './workday-enrichment.mjs';
import { buildFunnelReport } from './funnel-report.mjs';
import { mergeScoreRow } from './match-scorer.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CAREER_OPS_DIR = path.resolve(MODULE_DIR, '../career-ops');
const DEFAULT_STATE_PATH = path.resolve(MODULE_DIR, 'run-state.json');
const DEFAULT_LOCK_PATH = path.resolve(MODULE_DIR, 'run.lock');

export class RunError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RunError';
  }
}

function parseValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

export function parseArgs(argv = process.argv.slice(2)) {
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    dryRun: argv.includes('--dry-run'),
    noNotion: argv.includes('--no-notion'),
    force: argv.includes('--force'),
    json: argv.includes('--json') || argv.includes('--dry-run'),
    now: parseValue(argv, '--now', new Date().toISOString()),
    runId: parseValue(argv, '--run-id', randomUUID()),
    configPath: parseValue(argv, '--config', DEFAULT_CONFIG_PATH),
    ledgerPath: parseValue(argv, '--ledger', null),
    opportunityLedgerPath: parseValue(argv, '--opportunity-ledger', null),
    statePath: parseValue(argv, '--state', DEFAULT_STATE_PATH),
    lockPath: parseValue(argv, '--lock', DEFAULT_LOCK_PATH),
    careerOpsDir: parseValue(argv, '--career-ops-dir', DEFAULT_CAREER_OPS_DIR),
    trackedJson: parseValue(argv, '--tracked-json', null),
    reverseJson: parseValue(argv, '--reverse-json', null),
    publicJson: parseValue(argv, '--public-json', null),
    indeedJson: parseValue(argv, '--indeed-json', null),
    scoresJson: parseValue(argv, '--scores-json', null),
    reverseFull: argv.includes('--reverse-full'),
    reversePromote: argv.includes('--reverse-full') && !argv.includes('--no-reverse-promote'),
    outputPath: parseValue(argv, '--output', null),
    manifestPath: parseValue(argv, '--manifest-out', null),
  };
}

export function localRunDate(isoTimestamp, timeZone = 'Asia/Kolkata') {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) throw new RunError(`invalid run timestamp: ${isoTimestamp}`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function readState(statePath) {
  if (!existsSync(statePath)) return {};
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch (error) {
    throw new RunError(`could not read run state: ${error.message}`);
  }
}

function withRunLock(lockPath, callback) {
  if (existsSync(lockPath)) throw new RunError(`run lock exists: ${lockPath}`);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${process.pid}\n`, 'utf8');
  const release = () => {
    try { unlinkSync(lockPath); } catch { /* already removed */ }
  };
  try {
    const result = callback();
    if (result && typeof result.then === 'function') return result.finally(release);
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}

function sourceFailure(sourceId, kind, error) {
  return {
    sourceId,
    kind,
    attempted: true,
    status: 'failed',
    fetched: 0,
    dated: 0,
    active: 0,
    notVerified: 0,
    eligible: 0,
    duplicate: 0,
    failed: 1,
    selected: 0,
    errors: [error.message],
  };
}

function sourceNotConfigured(sourceId, kind) {
  return {
    sourceId,
    kind,
    attempted: false,
    status: 'not-configured',
    fetched: 0,
    dated: 0,
    active: 0,
    notVerified: 0,
    eligible: 0,
    duplicate: 0,
    failed: 0,
    selected: 0,
    errors: [],
  };
}

function manifestForCandidate(manifests, candidate) {
  const source = candidate.source || '';
  const provider = candidate.provider || '';
  if (/reverse|greenhouse-full|lever-full|ashby-full|workday-full/i.test(source)) return manifests.find((manifest) => manifest.sourceId === 'reverse-ats') || null;
  if (/tracked|greenhouse-api|lever-api|ashby-api|workday-api/i.test(source)) return manifests.find((manifest) => manifest.sourceId === 'tracked') || null;
  return manifests.find((manifest) => source === manifest.sourceId
    || source.startsWith(manifest.sourceId)
    || provider && manifest.sourceId === 'reverse-ats') || null;
}

export function applyScores(sources, scoreInput) {
  if (!scoreInput) return sources;
  const parsed = typeof scoreInput === 'string' ? JSON.parse(readFileSync(scoreInput, 'utf8')) : scoreInput;
  const rows = Array.isArray(parsed) ? parsed : parsed?.scores;
  if (!Array.isArray(rows)) throw new RunError('scores JSON must be an array or { scores: [...] }');
  const byUrl = new Map();
  for (const row of rows) {
    const url = canonicalizeUrl(row?.canonicalUrl ?? row?.url ?? row?.['JD Link']);
    if (!url) continue;
    byUrl.set(url, row);
  }
  return sources.map((source) => ({
    ...source,
    candidates: (source.candidates || []).map((candidate) => {
      const score = byUrl.get(candidate.canonicalUrl);
      if (!score) return candidate;
      const normalized = mergeScoreRow(candidate, score).candidate;
      const updated = {
        ...normalized,
        originalApplicationUrl: score.originalApplicationUrl ?? score.originalApplyUrl ?? candidate.originalApplicationUrl,
        originalApplicationEvidence: score.originalApplicationEvidence ?? candidate.applicationResolution?.evidence,
        applicationResolution: (score.originalApplicationUrl ?? score.originalApplyUrl)
          ? { status: 'Resolved Original', evidence: score.originalApplicationEvidence ?? candidate.applicationResolution?.evidence ?? null }
          : candidate.applicationResolution,
        conversionSignals: {
          ...(candidate.conversionSignals || {}),
          humanContact: score.humanContact === true || candidate.conversionSignals?.humanContact === true,
          projectConnection: score.projectConnection === true || candidate.conversionSignals?.projectConnection === true,
        },
      };
      return assertCandidate(updated);
    }),
  }));
}

export function runPipeline({ config, conversionPlan = loadConversionPlan(), now, runId, ledgerRows = [], opportunityLedgerRows = null, opportunityRows = null, opportunityLedgerPath, sources = [], dryRun = true }) {
  const allCandidates = sources.flatMap((source) => source.candidates || []);
  const manifests = sources.map((source) => ({ ...source.manifest }));
  for (const manifest of manifests) {
    if (!manifest.errors) manifest.errors = [];
  }
  const deduped = deduplicateCandidates(allCandidates, {
    ledgerRows,
    useSimHash: config.dedup.simHashEnabled,
    simHashSimilarity: config.dedup.simHashSimilarity,
  });
  for (const duplicate of deduped.duplicates) {
    const manifest = manifestForCandidate(manifests, duplicate.candidate);
    if (manifest) manifest.duplicate++;
  }

  const classified = deduped.kept.map((candidate) => {
    const freshness = annotateFreshness(candidate, {
      now,
      hotMaximumHours: config.freshness.hotMaximumHours,
      activeMaximumDays: config.freshness.activeMaximumDays,
      backfillMaximumDays: config.freshness.backfillMaximumDays,
    }).freshness;
    const eligibility = classifyCandidate(candidate, { ...config, salaryFloorLpa: conversionPlan.salaryFloorLpa });
    const conversion = scoreConversion(candidate, { freshnessWindow: freshness.window, eligibility, policy: conversionPlan.conversionScore });
    const scoredCandidate = assertCandidate({
      ...candidate,
      conversionScore: conversion.score,
      conversionTier: conversion.tier,
      conversionFactors: conversion.factors,
      applicationReady: conversion.applicationReady,
      applicationReadiness: conversion.applicationReadiness,
    });
    const entry = {
      candidate: scoredCandidate,
      freshness,
      eligibility,
      selectionTier: eligibility.tier,
      conversionTier: conversion.tier,
      freshnessWindow: freshness.window,
      roleFamily: eligibility.roleFamily,
      companyKey: eligibility.companyKey,
      score: Number(candidate.score ?? candidate.matchScore ?? 0),
    };
    const manifest = manifestForCandidate(manifests, candidate);
    if (manifest) {
      if (freshness.eligible && eligibility.liveness.pass) manifest.dated = (manifest.dated || 0);
      if (freshness.eligible && eligibility.eligible) manifest.eligible++;
    }
    return entry;
  });
  const scoringCandidates = classified.filter((entry) => entry.eligibility.eligible && entry.freshness.eligible);
  const opportunityRowsForRun = opportunityLedgerRows ?? opportunityRows ?? readOpportunityLedger(opportunityLedgerPath).rows;
  const suppressionCounts = {
    SUPPRESSED_ACTIONED: 0,
    SUPPRESSED_REJECTED: 0,
    SUPPRESSED_COOLDOWN_7D: 0,
    SUPPRESSED_BACKFILL_ALREADY_SEEN: 0,
  };
  const selectionPool = [];
  for (const entry of classified) {
    if (!entry.eligibility.eligible || !entry.freshness.eligible) continue;
    const key = candidateDedupKey(entry.candidate);
    const row = opportunityRowsForRun.find((candidate) => candidate.dedup_key === key);
    const suppression = entry.freshness.backfill && row
      ? { suppressed: true, code: 'SUPPRESSED_BACKFILL_ALREADY_SEEN' }
      : row ? suppressionFor(row, now) : { suppressed: false, code: '' };
    entry.suppression = suppression;
    if (suppression.suppressed) suppressionCounts[suppression.code]++;
    else selectionPool.push(entry);
  }
  const suppressed = Object.values(suppressionCounts).reduce((total, count) => total + count, 0);
  const selection = selectCandidates(selectionPool, config);
  const applicationShortlist = selectApplicationShortlist(selection.selected, config);
  const verifyQueue = classified
    .filter((entry) => entry.freshness.verifyQueue)
    .map((entry) => ({
      company: entry.candidate.company,
      title: entry.candidate.title,
      canonicalUrl: entry.candidate.canonicalUrl,
      provider: entry.candidate.provider,
      code: entry.freshness.code,
      workdayUncorroborated: entry.freshness.workdayUncorroborated === true,
    }));
  const gateExclusions = classified
    .filter((entry) => !entry.freshness.verifyQueue && (!entry.eligibility.eligible || !entry.freshness.eligible))
    .map((entry) => ({
      url: entry.candidate.canonicalUrl,
      code: !entry.freshness.eligible ? entry.freshness.code : entry.eligibility.reasons[0] || 'GATE_REJECTED',
      evidence: !entry.freshness.eligible ? entry.freshness.evidence : entry.eligibility.evidenceCodes,
    }));
  const selectedUrls = new Set(selection.selected.map((candidate) => candidate.canonicalUrl));
  for (const entry of classified) {
    entry.selected = selectedUrls.has(entry.candidate.canonicalUrl);
    entry.ready = entry.candidate.applicationReady === true;
    if (entry.selected) {
      const manifest = manifestForCandidate(manifests, entry.candidate);
      if (manifest) manifest.selected++;
    }
  }
  const strictCandidates = selection.selected.filter((candidate) => candidate.selectionTier === 'strict');
  const relaxedCandidates = selection.selected.filter((candidate) => candidate.selectionTier === 'relaxed');
  const records = selection.selected.map((candidate) => {
    const payload = buildPayloadRecord(candidate, {
      tier: candidate.selectionTier,
      freshnessWindow: candidate.freshnessWindow,
      roleFamily: candidate.roleFamily,
      relaxations: candidate.eligibility.relaxations,
      evidenceCodes: candidate.eligibility.evidenceCodes,
      runId,
    });
    const validation = validatePayloadRecord(payload);
    if (!validation.valid) throw new RunError(`payload validation failed for ${candidate.canonicalUrl}: ${validation.errors.join(', ')}`);
    return { candidate, payload };
  });
  if (!dryRun) {
    recordSurfaced(records.map((record) => record.candidate), { path: opportunityLedgerPath, now });
  }
  const sourceCounts = manifests.map((manifest) => ({ ...manifest }));
  const funnel = buildFunnelReport({
    observations: classified,
    lifecycle: {
      fetched: allCandidates.length,
      sourceFiltered: allCandidates.length,
      eligible: classified.filter((entry) => entry.eligibility.eligible).length,
      historicalSuppressed: 0,
      suppressedCooldown: suppressionCounts.SUPPRESSED_COOLDOWN_7D,
      suppressedBackfillAlreadySeen: suppressionCounts.SUPPRESSED_BACKFILL_ALREADY_SEEN,
      suppressedActioned: suppressionCounts.SUPPRESSED_ACTIONED,
      verifyQueue: verifyQueue.length,
      workdayUncorroboratedVerifyQueue: classified.filter((entry) => entry.freshness.workdayUncorroborated === true
        || entry.freshness.code === 'FRESHNESS_WORKDAY_UNCORROBORATED_VERIFY_QUEUE').length,
      ready: classified.filter((entry) => entry.ready).length,
      selected: records.length,
      newlyActionable: null,
    },
  });
  return {
    schemaVersion: 'JobPullRunV1',
    runId,
    runAt: now,
    notionWrites: false,
    dryRun,
    counts: {
      fetched: allCandidates.length,
      dated: allCandidates.filter((candidate) => candidate.postedAt != null).length,
      live: allCandidates.filter((candidate) => candidate.liveness.status === 'Active').length,
      notVerified: allCandidates.filter((candidate) => candidate.liveness.status === 'Not Verified').length,
      gatePassing: classified.filter((entry) => entry.eligibility.eligible && entry.freshness.eligible).length,
      deduped: deduped.kept.length,
      duplicates: deduped.duplicates.length,
      selected: records.length,
      scored: selection.scoredCount,
      unscored: selection.unscoredCount,
      scoringFailed: selection.scoringFailedCount,
      strictSelected: strictCandidates.length,
      relaxedSelected: relaxedCandidates.length,
      verifyQueue: verifyQueue.length,
      applicationShortlist: applicationShortlist.selected.length,
      suppressed,
      suppressedByCode: suppressionCounts,
      workdayUncorroboratedVerifyQueue: funnel.lifecycle.workdayUncorroboratedVerifyQueue,
    },
    funnel,
    strictShortfall: selection.strictShortfall,
    strictTarget: config.run.strictTarget,
    targetRange: [config.run.minimumTotal, config.run.maximumTotal],
    selection: {
      familyCounts: selection.familyCounts,
      companyCounts: selection.companyCounts,
      exclusions: selection.exclusions,
    },
    applicationShortlist,
    suppression: { count: suppressed, byCode: suppressionCounts },
    verifyQueue,
    exclusionAudit: {
      gate: gateExclusions,
      duplicate: deduped.duplicates.map((duplicate) => ({ url: duplicate.candidate.canonicalUrl, code: duplicate.code, evidence: duplicate.evidence })),
      selection: selection.exclusions,
    },
    sourceManifests: sourceCounts,
    fingerprintCoverage: deduped.fingerprintCoverage,
    scoring: {
      required: selection.unscoredCount > 0 || selection.scoringFailedCount > 0,
      scoredCount: selection.scoredCount,
      unscoredCount: selection.unscoredCount,
      scoringFailedCount: selection.scoringFailedCount,
      selectedCount: records.length,
    },
    scoringQueue: selection.scoringQueue,
    scoringCandidates: scoringCandidates.map((entry) => ({
      ...entry.candidate,
      eligibility: entry.eligibility,
      freshness: entry.freshness,
      selectionTier: entry.selectionTier,
      freshnessWindow: entry.freshnessWindow,
      roleFamily: entry.roleFamily,
    })),
    records,
    strictMatches: records.filter((record) => record.candidate.selectionTier === 'strict'),
    shortageFallback: records.filter((record) => record.candidate.selectionTier === 'relaxed'),
    diagnostics: {
      selectedUrls: [...selectedUrls],
      duplicateReasons: deduped.duplicates.map((duplicate) => ({ url: duplicate.candidate.canonicalUrl, code: duplicate.code })),
    },
  };
}

function sourceResultFromFixture(kind, fixture, now) {
  if (kind === 'tracked') return trackedCandidatesFromFixture(fixture, { runAt: now });
  if (kind === 'reverse-ats') return reverseAtsCandidatesFromFixture(fixture, { runAt: now });
  throw new RunError(`unknown fixture source ${kind}`);
}

function discover(options) {
  const sources = [];
  try {
    sources.push(options.trackedJson
      ? sourceResultFromFixture('tracked', options.trackedJson, options.now)
      : runTrackedScan({ careerOpsDir: options.careerOpsDir, runAt: options.now }));
  } catch (error) {
    sources.push({ candidates: [], manifest: sourceFailure('tracked', 'tracked-ats', error) });
  }
  try {
    sources.push(options.reverseJson
      ? sourceResultFromFixture('reverse-ats', options.reverseJson, options.now)
      : runReverseAtsScan({ careerOpsDir: options.careerOpsDir, runAt: options.now, full: options.reverseFull, promote: options.reversePromote }));
  } catch (error) {
    sources.push({ candidates: [], manifest: sourceFailure('reverse-ats', 'reverse-ats', error) });
  }
  if (options.publicJson) {
    try { sources.push(importPublicSearchCandidates(options.publicJson, { runAt: options.now })); }
    catch (error) { sources.push({ candidates: [], manifest: sourceFailure('public-search', 'public-search', error) }); }
  } else sources.push({ candidates: [], manifest: sourceNotConfigured('public-search', 'public-search') });
  if (options.indeedJson) {
    try { sources.push(importIndeedCandidates(options.indeedJson, { runAt: options.now })); }
    catch (error) { sources.push({ candidates: [], manifest: sourceFailure('indeed', 'indeed-connector', error) }); }
  } else sources.push(indeedUnavailable());
  return sources;
}

function hasNetworkAvailable(options) {
  // Both ATS sources are fixture-backed in this mode, and the optional sources
  // are also fixture-backed or absent, so enrichment must remain offline-safe.
  return !(options.dryRun && options.trackedJson && options.reverseJson);
}

function outputResult(result, outputPath, manifestPath) {
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, text, 'utf8');
  }
  if (manifestPath) {
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ runId: result.runId, runAt: result.runAt, sourceManifests: result.sourceManifests, counts: result.counts, verifyQueue: result.verifyQueue }, null, 2) + '\n', 'utf8');
  }
  return text;
}

function printHelp() {
  console.log(`Usage: node job-pull/run.mjs [options]

Manual, no-Notion discovery. Options:
  --dry-run --no-notion       safe local mode (default output is JSON)
  --tracked-json FILE         consume tracked scanner fixture/output
  --reverse-json FILE         consume reverse ATS fixture/output
  --public-json FILE          import public-search records
  --indeed-json FILE          import connector records; absent means unavailable
  --scores-json FILE          merge agent-produced scores by canonical URL before selection
  --reverse-full              run the 13k-board discovery crawl (~1hr) + grow warm set; default is the fast warm scan
  --no-reverse-promote        with --reverse-full, do not write newly-productive boards into the warm set
  --now ISO                   injected run clock
  --output FILE               write the complete local result JSON
  --manifest-out FILE         write source telemetry JSON
  --config FILE --ledger FILE --opportunity-ledger FILE --state FILE --force
`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const config = loadConfig(options.configPath);
  const conversionPlan = loadConversionPlan();
  const ledgerPath = options.ledgerPath || undefined;
  const ledgerRows = readLedger(ledgerPath).rows;
  const runState = readState(options.statePath);
  const runDate = localRunDate(options.now, config.timezone);
  if (config.run.onceDaily && runState.lastRunDate === runDate && !options.force && !options.dryRun) {
    throw new RunError(`manual daily pull already ran on ${runDate}; use --force to override`);
  }
  const execute = async () => {
    const sources = applyScores(discover(options), options.scoresJson);
    if (hasNetworkAvailable(options)) {
      await enrichWorkdayCandidates(sources.flatMap((source) => source.candidates || []), {
        now: Date.parse(options.now),
      });
    }
    const opportunityLedgerPath = options.opportunityLedgerPath || undefined;
    const result = runPipeline({ config, conversionPlan, now: options.now, runId: options.runId, ledgerRows, opportunityLedgerPath, sources, dryRun: options.dryRun });
    outputResult(result, options.outputPath, options.manifestPath);
    if (!options.dryRun) {
      mkdirSync(path.dirname(options.statePath), { recursive: true });
      writeFileSync(options.statePath, JSON.stringify({ lastRunDate: runDate, runId: options.runId, updatedAt: options.now }, null, 2) + '\n', 'utf8');
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  };
  return await withRunLock(options.lockPath, execute);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`job-pull: ${error.message}`); process.exitCode = 1; }
}
