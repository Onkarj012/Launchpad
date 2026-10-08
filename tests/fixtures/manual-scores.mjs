import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { mergeScoreRow } from '../../job-pull/match-scorer.mjs';

// Keep fixture totals separate from raw discovery records.
export function withManualFixtureScores(options) {
  const scores = [];
  const collect = (result) => {
    for (const row of result?.records || result?.candidates || []) {
      if (!row.scoringFailed && row.scoringStatus !== 'scoring-failed' && (row.matchScore != null || row.score != null)) scores.push({ canonicalUrl: row.canonicalUrl || row.url, matchScore: row.matchScore ?? row.score, responseLikelihood: row.responseLikelihood });
    }
    return result;
  };
  for (const result of Object.values(options.sourceFixtures || {})) collect(result);
  const sourceFunctions = Object.fromEntries(Object.entries(options.sourceFunctions || {}).map(([lane, fn]) => [lane, async (...args) => collect(await fn(...args))]));
  const supplied = Array.isArray(options.scores) ? options.scores : options.scores?.scores || [];
  scores.push(...supplied);
  return { ...options, scores, sourceFunctions };
}

// Apply manual scores only after candidate normalization.
export function scoredFixture(raw, options) {
  const candidate = normalizeCandidate(raw, options);
  return raw.matchScore == null && raw.score == null ? candidate : mergeScoreRow(candidate, raw).candidate;
}
