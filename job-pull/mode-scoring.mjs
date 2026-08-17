export const BROKEN_SCORER_REASON_CODES = new Set([
  'SCORER_BINARY_MISSING', 'SCORER_BINARY_NOT_ABSOLUTE', 'SCORER_AUTH_FAILED',
  'SCORER_SPAWN_FAILED', 'SCORER_EXEC_FAILED', 'SCORER_OUTPUT_INVALID', 'SCORER_CARDINALITY_MISMATCH',
  'SCORER_URL_MISMATCH', 'SCORER_TIMEOUT', 'SCORER_DEADLINE_EXCEEDED', 'SCORER_ABORTED',
]);

export function hasUsableMatchScore(candidate) {
  const raw = candidate?.matchScore ?? candidate?.score;
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return false;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

export function scoreState(entry) {
  const candidate = entry.candidate || entry;
  const values = entry.candidate
    ? [candidate.matchScore, candidate.score, entry.matchScore]
    : [entry.matchScore, entry.score];
  const rawScore = values.find((value) => value !== null && value !== undefined);
  if (candidate.scoringFailed === true || candidate.scoringStatus === 'scoring-failed') return { status: 'scoring-failed', score: null };
  if (rawScore === undefined || rawScore === null || rawScore === '' || (typeof rawScore === 'string' && !rawScore.trim())) return { status: 'unscored', score: null };
  if (typeof rawScore === 'boolean') return { status: 'scoring-failed', score: null };
  const score = Number(rawScore);
  return Number.isFinite(score) && score >= 0 && score <= 100
    ? { status: 'scored', score }
    : { status: 'scoring-failed', score: null };
}

export function scoringQueueRecord(entry) {
  const state = scoreState(entry);
  return {
    ...entry.candidate,
    scoringStatus: state.status,
    scoringQueueReason: state.status === 'scoring-failed' ? 'INVALID_MATCH_SCORE' : 'MATCH_SCORE_REQUIRED',
    ...(state.status === 'scoring-failed' && (entry.candidate.scoringError || entry.candidate.scoringFailureReason)
      ? { scoringFailureReason: entry.candidate.scoringError || entry.candidate.scoringFailureReason }
      : {}),
    autoSuggest: false,
  };
}

export function splitScoredEntries(entries) {
  const scored = entries.filter((entry) => scoreState(entry).status === 'scored');
  const scoringQueue = entries.filter((entry) => scoreState(entry).status !== 'scored');
  return {
    scored,
    scoringQueue,
    scoredCount: scored.length,
    unscoredCount: scoringQueue.filter((entry) => scoreState(entry).status === 'unscored').length,
    scoringFailedCount: scoringQueue.filter((entry) => scoreState(entry).status === 'scoring-failed').length,
  };
}

export async function scorePoolInRun(candidates, scorer, { runId = null, runAt = null } = {}) {
  if (typeof scorer !== 'function') return { pool: candidates, telemetry: null };
  const unscored = candidates.filter((candidate) => !hasUsableMatchScore(candidate));
  if (!unscored.length) return { pool: candidates, telemetry: { attempted: 0, chunks: 0, failures: [], degraded: false, reasonCode: null } };
  let scoring;
  try {
    scoring = await scorer(unscored, { runId, runAt });
  } catch (error) {
    return {
      pool: candidates,
      telemetry: {
        attempted: unscored.length,
        chunks: 0,
        failures: unscored.map((candidate) => ({ canonicalUrl: candidate.canonicalUrl, reason: error.reasonCode || error.code || 'SCORER_EXEC_FAILED' })),
        degraded: true,
        reasonCode: error.reasonCode || error.code || 'SCORER_EXEC_FAILED',
        error: error.message || String(error),
      },
    };
  }
  const merged = new Map((Array.isArray(scoring?.scored) ? scoring.scored : [])
    .filter((candidate) => candidate?.canonicalUrl)
    .map((candidate) => [candidate.canonicalUrl, candidate]));
  const failures = new Map((Array.isArray(scoring?.failures) ? scoring.failures : [])
    .filter((failure) => failure?.canonicalUrl)
    .map((failure) => [failure.canonicalUrl, failure]));
  return {
    pool: candidates.map((candidate) => ({
      ...candidate,
      ...(merged.has(candidate.canonicalUrl) ? merged.get(candidate.canonicalUrl) : {}),
      ...(failures.has(candidate.canonicalUrl) ? { scoringFailureReason: failures.get(candidate.canonicalUrl).reason || 'SCORER_FAILED' } : {}),
    })),
    telemetry: {
      attempted: unscored.length,
      chunks: Number.isFinite(Number(scoring?.chunks)) ? Number(scoring.chunks) : 0,
      failures: Array.isArray(scoring?.failures) ? scoring.failures : [],
      degraded: scoring?.degraded === true,
      reasonCode: scoring?.reasonCode ?? null,
    },
  };
}

export function scorerIsBroken(telemetry) {
  const failures = Array.isArray(telemetry?.failures) ? telemetry.failures : [];
  if (telemetry?.degraded === true && BROKEN_SCORER_REASON_CODES.has(telemetry.reasonCode)) return true;
  return telemetry?.attempted > 0 && failures.length / telemetry.attempted > 0.5;
}

export function scoringGateError(ErrorClass, selection, scorerTelemetry = null) {
  const causes = selection.scoringQueue.map((candidate) => {
    const reason = candidate.scoringFailureReason || candidate.scoringQueueReason;
    return `${candidate.company} — ${candidate.title}: ${reason}`;
  });
  const failures = Array.isArray(scorerTelemetry?.failures) ? scorerTelemetry.failures : [];
  const scorerCause = scorerTelemetry
    ? `; scorer broken: reason-code=${scorerTelemetry.reasonCode ?? 'none'}, degraded=${scorerTelemetry.degraded}, attempted=${scorerTelemetry.attempted}, failed=${failures.length}`
    : '';
  return new ErrorClass(
    `complete scoring required before selection: unscored=${selection.unscoredCount}, scoring-failed=${selection.scoringFailedCount}${scorerCause}${causes.length ? `; ${causes.join('; ')}` : ''}`,
    'scoring',
  );
}

function reconciliationLine({ eligible, scored, ready, selected, causes }) {
  const causeText = Object.entries(causes)
    .flatMap(([stage, stageCauses]) => Object.entries(stageCauses).map(([cause, count]) => `${stage}:${cause}=${count}`))
    .join(',');
  return `eligible=${eligible}; scored=${scored}; ready=${ready}; selected=${selected}; causes=${causeText || 'none'}`;
}

export function buildReconciliation({ eligible, historicalSuppressed, selection, selected, runFailed = false }) {
  const ready = selection.readyCount;
  const scored = selection.scoredCount;
  const notReady = Math.max(0, eligible - historicalSuppressed - ready);
  const readyNotScored = Math.max(0, ready - scored);
  const selectedGap = Math.max(0, scored - selected);
  const causes = {
    eligibleToReady: {
      HISTORICAL_SUPPRESSION: historicalSuppressed,
      NOT_APPLICATION_READY: notReady,
    },
    readyToScored: {
      UNSCORED: selection.unscoredCount,
      SCORING_FAILED: selection.scoringFailedCount,
    },
    scoredToSelected: {
      ...(runFailed ? { RUN_FAILED_INCOMPLETE_SCORING: selectedGap } : { SELECTION_RULES: selectedGap }),
    },
  };
  return {
    eligible,
    scored,
    ready,
    selected,
    causes,
    deltas: {
      eligibleToReady: eligible - ready,
      readyToScored: readyNotScored,
      scoredToSelected: selectedGap,
    },
    line: reconciliationLine({ eligible, scored, ready, selected, causes }),
  };
}
