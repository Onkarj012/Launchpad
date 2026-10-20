import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { candidateDedupKey, canonicalizeUrl, normalizeCandidate } from '../job-pull/candidate.mjs';
import { normalizeText } from './identity.mjs';

const IMPLEMENTATION_FILES = [
  'crawler/daily-runner.mjs', 'crawler/local-lead-report.mjs', 'crawler/daily-receipt.mjs',
  'crawler/workflow.mjs', 'crawler/run.mjs', 'crawler/source-yield.mjs', 'crawler/operator.mjs',
  'job-pull/run.mjs', 'job-pull/normal-mode.mjs', 'job-pull/startup-mode.mjs', 'job-pull/remote-mode.mjs',
  'job-pull/normal-selection.mjs', 'job-pull/select.mjs', 'job-pull/funnel-report.mjs', 'job-pull/candidate.mjs',
  'job-pull/mode-scoring.mjs', 'job-pull/match-scorer.mjs', 'job-pull/dedup.mjs', 'job-pull/normal-readiness.mjs', 'job-pull/eligibility.mjs',
  'tests/crawler/daily-runner.test.mjs', 'tests/crawler/local-lead-report.test.mjs',
  'tests/crawler/workflow.test.mjs',
  'tests/job-pull/funnel-report.test.mjs',
];
const POLICY_FILES = [
  'master_prompt.md', 'config/job-pull.json', 'config/conversion-plan.json',
  'config/launchpad-v5.commands.json', 'config/notion-v5.manifest.json', 'crawler/safety-contract.mjs',
];

// Hash bytes with SHA-256 and return an explicit algorithm prefix.
function hash(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

// Convert retained values to bounded text while omitting credential and payload fields.
export function safeText(value, depth = 0) {
  if (value == null) return 'Not Verified';
  if (typeof value === 'string') return value.slice(0, 2000);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (depth >= 3) return '[nested value]';
  if (Array.isArray(value)) return `[${value.slice(0, 12).map((item) => safeText(item, depth + 1)).join(', ')}]`;
  if (typeof value === 'object') {
    const safe = Object.fromEntries(Object.entries(value).filter(([key]) => !/(header|authorization|cookie|secret|token|body)/i.test(key)).slice(0, 20).map(([key, item]) => [key, safeText(item, depth + 1)]));
    return JSON.stringify(safe).slice(0, 2000);
  }
  return 'Not Verified';
}

// Keep error fields together so receipts and reports show the same safe cause.
export function formatError(error) {
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const details = [error.stage, error.name, error.message ?? error].filter((value) => value != null).map(safeText);
    return details.join(': ') || 'Not Verified';
  }
  return safeText(error);
}

// Format the final retained failure cause, including a structured fatal reason.
export function formatRunCause(fatalReason, errors = []) {
  if (fatalReason != null) return safeText(fatalReason);
  return errors.map(formatError).filter(Boolean).join('; ') || 'Not Verified';
}

// Hash candidate identity and retained text without storing URLs or raw evidence.
function observationFingerprint(raw) {
  let candidate = raw?.candidate ?? raw?.raw ?? raw;
  const observedAt = raw?.observedAt ?? candidate?.observedAt ?? null;
  try { candidate = normalizeCandidate(candidate); } catch {}
  const identity = candidateDedupKey(candidate);
  const evidence = [
    candidate.description,
    candidate.experience?.evidence,
    candidate.salary?.evidence,
    candidate.liveness?.evidence,
    candidate.applicationResolution?.evidence,
    candidate.evidence?.resolution?.reason,
    candidate.canonicalUrl,
    candidate.discoveryUrl,
    candidate.originalApplicationUrl,
  ];
  const identityHash = identity ? hash(identity) : 'Not Verified';
  const evidenceHashes = evidence.map((value) => value == null ? null : hash(String(value)));
  return {
    identityHash,
    provider: candidate.provider ?? null,
    source: candidate.source ?? null,
    observedAt,
    postedAt: candidate.postedAt ?? null,
    evidenceContentHash: hash(JSON.stringify({ identityHash, evidenceHashes, postedAt: candidate.postedAt ?? null })),
    evidenceHashes,
  };
}

// Return the canonical identity used by the funnel for any retained candidate row.
function candidateIdentity(raw) {
  const candidate = raw?.candidate ?? raw?.raw ?? raw;
  if (typeof candidate?.dedupKey === 'string' && candidate.dedupKey) return hash(candidate.dedupKey);
  try {
    const identity = candidateDedupKey(normalizeCandidate({
      ...candidate,
      canonicalUrl: candidate?.canonicalUrl ?? candidate?.discoveryUrl ?? candidate?.originalApplicationUrl,
    }));
    return identity ? hash(identity) : null;
  } catch {
    return null;
  }
}

// Keep canonical URLs available only as an in-memory bridge to history evidence.
function canonicalCandidateUrl(raw) {
  const candidate = raw?.candidate ?? raw?.raw ?? raw;
  return canonicalizeUrl(candidate?.canonicalUrl ?? candidate?.url ?? candidate?.discoveryUrl);
}

// Match the existing company, title, and location evidence emitted by history filtering.
function companyTitleLocation(raw) {
  const candidate = raw?.candidate ?? raw?.raw ?? raw;
  const parts = [candidate?.company, candidate?.title, candidate?.location].map((value) => normalizeText(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim());
  return parts.every(Boolean) ? parts.join('|') : null;
}

// Add retained evidence to an identity overlay without inventing an alias policy.
function addOverlay(overlays, keyHash, update) {
  if (!keyHash) return;
  const previous = overlays.get(keyHash) ?? {
    modes: [], score: null, scoreComponents: null, selectionTier: null,
    selected: false, selectionKnown: false, historicalSuppressed: false,
  };
  update(previous);
  overlays.set(keyHash, previous);
}

// Final selection is known only when each owned mode supplies its final shortlist.
function hasFinalSelectionEvidence(result) {
  const modes = result.modes ?? {};
  return ['startup', 'normal', 'remote'].every((mode) => Array.isArray(modes[mode]?.shortlist));
}

// Keep per-requisition stage and final selection details compact and safe.
function receiptIdentityRows(result) {
  const funnelRows = result.funnel?.identityRows;
  if (!Array.isArray(funnelRows)) return 'Not Verified';
  const rows = [
    ...funnelRows,
    ...(Array.isArray(result.funnel?.receiptLedgerSuppressions) ? result.funnel.receiptLedgerSuppressions.map((row) => ({
      identity: row.identity ?? 'Not Verified',
      provider: row.provider ?? null,
      source: row.source ?? null,
      observedAt: row.observedAt ?? null,
      postedAt: row.postedAt ?? null,
      jdHash: row.jdHash ?? null,
      evidenceHash: row.evidenceHash ?? null,
      alsoFailed: row.alsoFailed ?? [],
      score: row.score ?? null,
      provenance: row.provenance ?? [],
      bucket: 'historicalSuppressed',
      reason: row.code === 'DEDUP_EXISTING_LEDGER' ? row.code : 'Not Verified',
      historicalSuppressed: row.code === 'DEDUP_EXISTING_LEDGER',
    })) : []),
  ];
  const overlays = new Map();
  const canonicalIdentities = new Map();
  const historyIdentities = new Map();
  const observationProvenance = new Map();
  const allCandidates = [
    ...(result.observations ?? []),
    ...Object.values(result.modes ?? {}).flatMap((value) => value.results ?? []),
    ...Object.values(result.modes ?? {}).flatMap((value) => value.shortlist ?? []),
    ...(result.verificationQueue ?? []),
    ...(result.scoringQueue ?? []),
  ];
  for (const candidate of allCandidates) {
    const keyHash = candidateIdentity(candidate);
    const canonicalUrl = canonicalCandidateUrl(candidate);
    if (canonicalUrl && keyHash) canonicalIdentities.set(canonicalUrl, keyHash);
    const historyKey = companyTitleLocation(candidate);
    if (historyKey && keyHash) historyIdentities.set(historyKey, keyHash);
  }
  for (const candidate of result.observations ?? []) {
    const keyHash = candidateIdentity(candidate);
    if (keyHash) {
      const entries = observationProvenance.get(keyHash) ?? [];
      const entry = {
        provider: (candidate?.candidate ?? candidate)?.provider ?? null,
        source: (candidate?.candidate ?? candidate)?.source ?? null,
        sourceId: (candidate?.candidate ?? candidate)?.sourceId ?? (candidate?.candidate ?? candidate)?.discoverySource ?? null,
        observedAt: (candidate?.candidate ?? candidate)?.observedAt ?? null,
        postedAt: (candidate?.candidate ?? candidate)?.postedAt ?? null,
      };
      if (!entries.some((item) => JSON.stringify(item) === JSON.stringify(entry))) entries.push(entry);
      observationProvenance.set(keyHash, entries);
    }
  }
  const modes = result.modes ?? {};
  const finalSelectionKnown = hasFinalSelectionEvidence(result);
  const finalSelection = new Set();
  for (const [mode, value] of Object.entries(result.modes ?? {})) {
    for (const role of value.results ?? []) {
      const keyHash = candidateIdentity(role);
      addOverlay(overlays, keyHash, (previous) => {
        previous.modes.push(mode);
        previous.score = role.matchScore ?? role.score ?? previous.score;
        previous.scoreComponents = role.scoreComponents ?? role.components ?? previous.scoreComponents;
        previous.selectionTier = role.selectionTier ?? previous.selectionTier;
        previous.historicalSuppressed ||= role.historicalSuppressed === true;
      });
    }
    for (const role of value.shortlist ?? []) {
      const keyHash = candidateIdentity(role);
      if (keyHash) finalSelection.add(keyHash);
    }
  }
  for (const keyHash of finalSelection) addOverlay(overlays, keyHash, (previous) => {
    previous.selected = true;
    previous.selectionKnown = finalSelectionKnown;
  });
  if (finalSelectionKnown) {
    for (const role of allCandidates) addOverlay(overlays, candidateIdentity(role), (previous) => {
      previous.selectionKnown = true;
    });
  }
  for (const item of result.verificationQueue ?? []) {
    const keyHash = candidateIdentity(item);
    addOverlay(overlays, keyHash, (previous) => {
      previous.verification = true;
      previous.verificationReason = item.reasons ?? item.reason ?? item.code ?? item.evidence?.reason ?? null;
    });
  }
  for (const row of result.historicalSuppressions ?? []) {
    const matchKeys = [
      ...(Array.isArray(row.matchKeys) ? row.matchKeys : []),
      row.canonicalUrl,
      row.candidate?.canonicalUrl,
    ].filter((key) => typeof key === 'string' && key.trim());
    const candidateKeyHash = candidateIdentity(row);
    const canonicalUrl = canonicalCandidateUrl(row);
    if (canonicalUrl) matchKeys.push(canonicalUrl);
    const keyHashes = new Set([candidateKeyHash, canonicalUrl ? canonicalIdentities.get(canonicalUrl) : null]);
    for (let index = 0; index < matchKeys.length; index++) {
      const key = matchKeys[index];
      const url = canonicalizeUrl(key);
      if (url) {
        keyHashes.add(canonicalIdentities.get(url));
        keyHashes.add(hash(`url|${url}`));
      }
      if (row.matchTypes?.[index] === 'provider_job_id' && key.includes('|')) keyHashes.add(hash(key));
      if (row.matchTypes?.[index] === 'company_title_location') keyHashes.add(historyIdentities.get(key));
    }
    for (const keyHash of keyHashes) addOverlay(overlays, keyHash, (previous) => {
      previous.historicalSuppressed = true;
      previous.historyReason = row.code ?? 'SUPPRESSED_HISTORICAL';
    });
  }
  const scoringQueues = [result.scoringQueue, ...Object.values(result.modes ?? {}).map((value) => value.scoringQueue)];
  for (const queue of scoringQueues) {
    for (const item of Array.isArray(queue) ? queue : []) {
      const candidate = item.candidate ?? item;
      const keyHash = candidateIdentity(candidate);
      addOverlay(overlays, keyHash, (previous) => {
        previous.scoringFailure = item.scoringStatus === 'scoring-failed' || item.scoringFailed === true;
        previous.scoringReason = safeText(item.scoringFailureReason ?? item.scoringQueueReason
          ?? item.scoringReason ?? item.errorCode ?? (previous.scoringFailure ? 'SCORING_FAILED' : null));
      });
    }
  }
  const observations = rows.map((row) => {
    const overlay = overlays.get(row.identity);
    const selected = finalSelectionKnown && overlay?.selected === true;
    const hardRejection = ['geo', 'title', 'experience', 'employment', 'salary', 'liveness', 'freshnessRejected'].includes(row.bucket);
    const verificationRequiredFirstGate = Array.isArray(row.verificationRequiredGates)
      && row.verificationRequiredGates.includes(row.bucket);
    const hardRejectionFirst = hardRejection && !verificationRequiredFirstGate;
    const stage = hardRejectionFirst ? 'hardRejection'
      : selected ? 'finalSelection'
        : overlay?.verification || verificationRequiredFirstGate ? 'verification'
        : overlay?.historicalSuppressed || ['historicalSuppressed', 'suppressedCooldown', 'suppressedBackfillAlreadySeen', 'suppressedActioned', 'suppressedRejected'].includes(row.bucket) || row.historicalSuppressed ? 'historySuppression'
          : overlay?.scoringFailure ? 'scoringFailure'
            : row.bucket === 'verifyQueue' ? 'verification'
              : ['notSelected', 'selected'].includes(row.bucket) && overlay?.modes?.length ? 'eligible' : 'unknown';
    return {
      identityHash: row.identity,
      provider: row.provider,
      source: row.source,
      observedAt: row.observedAt,
      postedAt: row.postedAt,
      jdHash: row.jdHash,
      evidenceHash: row.evidenceHash,
      stage,
      reason: selected ? 'SELECTED' : stage === 'historySuppression' ? overlay?.historyReason ?? row.reason ?? 'HISTORICAL_SUPPRESSED'
        : stage === 'verification' ? safeText(overlay?.verificationReason ?? row.reason)
          : stage === 'scoringFailure' ? overlay?.scoringReason : stage === 'unknown' ? 'Not Verified' : row.reason,
      upstreamStage: row.bucket,
      upstreamReason: row.reason,
      alsoFailed: row.alsoFailed,
      selected,
      score: overlay?.score ?? row.score,
      scoreComponents: overlay?.scoreComponents ?? null,
      selectionTier: overlay?.selectionTier ?? null,
      modes: overlay?.modes ?? [],
      historicalSuppressed: overlay?.historicalSuppressed === true || row.historicalSuppressed,
      provenance: [...new Map([
        ...(Array.isArray(row.provenance) && row.provenance.length
          ? row.provenance.map((item) => ({ ...item }))
          : [{ provider: row.provider, source: row.source, observedAt: row.observedAt, postedAt: row.postedAt, jdHash: row.jdHash, evidenceHash: row.evidenceHash }]),
        ...(observationProvenance.get(row.identity) ?? []),
      ].map((item) => [JSON.stringify({
        provider: item.provider ?? null, source: item.source ?? null, sourceId: item.sourceId ?? null,
        observedAt: item.observedAt ?? null, postedAt: item.postedAt ?? null,
      }), item])).values()],
    };
  });
  const rank = { finalSelection: 8, hardRejection: 7, verification: 6, historySuppression: 5, scoringFailure: 4, eligible: 3, unknown: 0 };
  const unique = new Map();
  for (const row of observations) {
    const previous = unique.get(row.identityHash);
    if (!previous) unique.set(row.identityHash, row);
    else {
      previous.provenance.push(...row.provenance);
      previous.provenance = [...new Map(previous.provenance.map((item) => [JSON.stringify({
        provider: item.provider ?? null, source: item.source ?? null, sourceId: item.sourceId ?? null,
        observedAt: item.observedAt ?? null, postedAt: item.postedAt ?? null,
      }), item])).values()];
      if ((rank[row.stage] ?? 0) > (rank[previous.stage] ?? 0)) {
        previous.stage = row.stage;
        previous.reason = row.reason;
        previous.upstreamStage = row.upstreamStage;
        previous.upstreamReason = row.upstreamReason;
      }
      previous.selected ||= row.selected;
      previous.historicalSuppressed ||= row.historicalSuppressed;
      previous.modes = [...new Set([...previous.modes, ...row.modes])];
      previous.score ??= row.score;
      previous.selectionTier ??= row.selectionTier;
    }
  }
  return [...unique.values()];
}

// Keep the provenance input compact and free of raw request or header data.
function retainedEvidence(result) {
  const identityRows = receiptIdentityRows(result);
  return {
    runId: result.runId ?? null,
    runAt: result.runAt ?? result.run?.startedAt ?? null,
    status: result.terminalEnvelope?.status ?? result.outcome?.status ?? null,
    requestedCount: result.requestedCount ?? null,
    cause: formatRunCause(result.terminalEnvelope?.fatalReason ?? result.outcome?.fatalReason, result.outcome?.errors),
    counts: result.counts ?? null,
    funnel: result.funnel ?? null,
    sourceCoverage: result.terminalEnvelope?.sourceCoverage ?? result.sourceCoverage ?? null,
    sourceEndStates: result.terminalEnvelope?.sourceEndStates ?? result.sourceEndStates ?? null,
    sourceYield: result.sourceYield ?? null,
    scoring: result.scoring ?? null,
    identityRows,
    finalSelectionAvailable: hasFinalSelectionEvidence(result),
    observations: (result.observations ?? []).map(observationFingerprint),
    rejectionCounts: result.rejectionCounts ?? null,
    historicalSuppressions: result.historicalSuppressions?.length ?? null,
    historicalSuppressionIdentities: Array.isArray(identityRows)
      ? identityRows.filter((row) => row.historicalSuppressed).map((row) => row.identityHash)
      : 'Not Verified',
    modes: Object.fromEntries(Object.entries(result.modes ?? {}).map(([mode, value]) => [mode, {
      results: value.results?.map(candidateIdentity) ?? null,
      shortlist: value.shortlist?.map(candidateIdentity) ?? null,
    }])),
    finalSelectionAvailable: hasFinalSelectionEvidence(result),
    delivery: (() => {
      const value = result.deliveryReconciliation ?? result.terminalEnvelope?.deliveryReconciliation ?? {};
      const counts = value.counts && typeof value.counts === 'object'
        ? Object.fromEntries(Object.entries(value.counts).filter(([, count]) => Number.isFinite(count)))
        : null;
      return { status: value.status ?? null, counts, notification: value.notification?.status ?? null, canary: value.canary?.status ?? null };
    })(),
  };
}

// Build a local receipt with stage scopes that distinguish observation counts from delivery.
export function buildDailyReceipt(result) {
  const lifecycle = result.funnel?.lifecycle ?? {};
  const counts = result.counts ?? {};
  let dirtyState = 'unknown';
  try {
    const status = execFileSync('git', ['status', '--short', '--', ...IMPLEMENTATION_FILES, ...POLICY_FILES], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    dirtyState = status ? 'dirty' : 'clean';
  } catch {}
  const implementation = IMPLEMENTATION_FILES.map((file) => {
    try { return `${file}\0${readFileSync(new URL(`../${file}`, import.meta.url))}\0`; } catch { return `${file}\0Not Verified\0`; }
  }).join('');
  const retained = retainedEvidence(result);
  const stage = (value) => Number.isFinite(value) ? value : 'Not Verified';
  const raw = counts.fetched ?? lifecycle.fetched;
  const identityRows = receiptIdentityRows(result);
  const countStage = (stages) => Array.isArray(identityRows) ? identityRows.filter((row) => stages.includes(row.stage)).length : 'Not Verified';
  const reconciliation = result.deliveryReconciliation ?? result.terminalEnvelope?.deliveryReconciliation ?? {};
  const delivery = reconciliation.counts?.deliveredKeys;
  return {
    schemaVersion: 'LaunchpadDailyFunnelReceiptV1',
    retained: { identityRows, observations: (result.observations ?? []).map(observationFingerprint) },
    run: { id: result.runId ?? null, at: result.runAt ?? result.run?.startedAt ?? null, status: result.terminalEnvelope?.status ?? result.outcome?.status ?? 'Not Verified', cause: formatRunCause(result.terminalEnvelope?.fatalReason ?? result.outcome?.fatalReason, result.outcome?.errors), sourceCoverage: result.terminalEnvelope?.sourceCoverage ?? result.sourceCoverage ?? 'Not Verified' },
    scopes: {
      requestedCount: { count: stage(result.requestedCount), meaning: 'explicit retained requestedCount only' },
      rawObservations: { count: stage(raw), meaning: 'source-reported fetched observations; repeats may occur across sources and modes' },
      uniqueRequisitions: { count: stage(Array.isArray(identityRows) ? identityRows.filter((row) => row.identityHash !== 'Not Verified').length : null), meaning: 'distinct canonical requisition identities across retained observations' },
      eligible: { count: stage(counts.eligible ?? lifecycle.eligible), meaning: 'retained eligible candidates' },
      hardRejection: { count: countStage(['hardRejection']), meaning: 'unique requisitions rejected by a hard gate or freshness rule' },
      verification: { count: countStage(['verification']), meaning: 'unique requisitions held for manual verification' },
      scoringFailure: { count: countStage(['scoringFailure']), meaning: 'unique requisitions with an explicit scoring failure' },
      historySuppression: { count: countStage(['historySuppression']), meaning: 'unique requisitions suppressed by retained history' },
      finalSelection: { count: hasFinalSelectionEvidence(result) ? countStage(['finalSelection']) : 'Not Verified', meaning: 'unique requisitions in the final all-mode shortlist; crawler selection is not substituted' },
      confirmedDelivery: { count: stage(delivery), evidence: Object.keys(reconciliation).length ? {
        status: reconciliation.status ?? 'Not Verified', deliveredKeys: delivery ?? 'Not Verified',
        notificationStatus: reconciliation.notification?.status ?? 'Not Verified', canaryStatus: reconciliation.canary?.status ?? 'Not Verified',
      } : 'Not Verified' },
    },
    provenance: {
      implementationState: dirtyState,
      implementationHash: hash(implementation),
      implementationScope: 'Explicit receipt, report, workflow, run persistence, operator, readiness, selection, candidate, and scoring dependencies; bounded list, not a complete transitive dependency hash.',
      policyConfigHashes: Object.fromEntries(POLICY_FILES.map((file) => {
        try { return [file, hash(readFileSync(new URL(`../${file}`, import.meta.url)))]; } catch { return [file, 'Not Verified']; }
      })),
      retainedInputHash: hash(JSON.stringify(retained)),
      releaseClaim: 'none; local working-tree evidence',
    },
  };
}
