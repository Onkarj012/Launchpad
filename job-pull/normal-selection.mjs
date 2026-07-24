import { sourceQuality } from './dedup.mjs';
import { applicationReadiness } from './normal-readiness.mjs';

function ageHours(entry) { return Number(entry.freshness?.ageHours ?? entry.candidate?.freshness?.ageHours); }

function scoreState(entry) {
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

function fitScore(entry) {
  return scoreState(entry).score ?? Number.NEGATIVE_INFINITY;
}

function compareFit(left, right) {
  const leftCandidate = left.candidate || left;
  const rightCandidate = right.candidate || right;
  const score = fitScore(right) - fitScore(left);
  if (score) return score;
  const conversion = Number(rightCandidate.conversionScore ?? 0) - Number(leftCandidate.conversionScore ?? 0);
  if (conversion) return conversion;
  const response = Number(rightCandidate.responseLikelihood ?? 0) - Number(leftCandidate.responseLikelihood ?? 0);
  if (response) return response;
  const quality = sourceQuality(rightCandidate) - sourceQuality(leftCandidate);
  if (quality) return quality;
  const posted = String(rightCandidate.postedAt || '').localeCompare(String(leftCandidate.postedAt || ''));
  if (posted) return posted;
  return String(leftCandidate.canonicalUrl || '').localeCompare(String(rightCandidate.canonicalUrl || ''));
}

function waterfallBand(entry) {
  const candidate = entry.candidate || entry;
  const eligibility = entry.eligibility || candidate.eligibility || {};
  const age = ageHours(entry);
  if (!Number.isFinite(age)) return null;
  if (eligibility.strict && age <= 24) return 'strict-0-24h';
  if (eligibility.strict && age <= 72) return 'strict-24-72h';
  if (eligibility.strict && age <= 168) return 'strict-3-7d';
  if (eligibility.eligible && age <= 72 && eligibility.experience?.relaxed) return 'relaxed-fresh-up-to-2-years';
  if (eligibility.eligible && age <= 72 && eligibility.title?.relaxed) return 'relaxed-fresh-adjacent';
  if (eligibility.eligible && age <= 168) return 'relaxed-3-7d';
  if (eligibility.eligible && age <= 336) return 'relaxed-backfill-8-14d';
  return null;
}

const WATERFALL = Object.freeze([
  'strict-0-24h',
  'strict-24-72h',
  'strict-3-7d',
  'relaxed-fresh-up-to-2-years',
  'relaxed-fresh-adjacent',
  'relaxed-3-7d',
  'relaxed-backfill-8-14d',
]);

export { WATERFALL, waterfallBand };

/** Select 10 minimum, 12 preferred, and at most 20 without family quotas. */
export function selectNormalApplications(entries, { minimum = 10, preferred = 12, maximum = 20, maximumPerCompany = 2 } = {}) {
  const ready = entries
    .map((entry) => {
      const candidate = entry.candidate || entry;
      const eligibility = entry.eligibility || candidate.eligibility || null;
      const freshness = entry.freshness || candidate.freshness || null;
      const readiness = applicationReadiness(candidate, eligibility);
      return { ...entry, candidate, eligibility, freshness, readiness, waterfallBand: waterfallBand({ ...entry, candidate, eligibility, freshness }) };
    })
    .filter((entry) => entry.readiness.ready && entry.waterfallBand);
  const scored = ready.filter((entry) => scoreState(entry).status === 'scored');
  const scoringQueue = ready.filter((entry) => scoreState(entry).status !== 'scored');
  const queues = new Map(WATERFALL.map((band) => [band, []]));
  for (const entry of scored) queues.get(entry.waterfallBand).push(entry);
  for (const queue of queues.values()) queue.sort(compareFit);
  const target = Math.min(maximum, scored.length);
  const selected = [];
  const companyCounts = new Map();
  const seen = new Set();
  for (const band of WATERFALL) {
    for (const entry of queues.get(band)) {
      if (selected.length >= target) break;
      const candidate = entry.candidate;
      const key = candidate.canonicalUrl;
      const company = String(candidate.company || '').toLocaleLowerCase();
      if (seen.has(key) || (companyCounts.get(company) || 0) >= maximumPerCompany) continue;
      seen.add(key);
      companyCounts.set(company, (companyCounts.get(company) || 0) + 1);
      const strict = entry.waterfallBand.startsWith('strict-');
      const relaxations = strict ? [] : [
        ...(entry.eligibility?.relaxations || []),
        `waterfall:${entry.waterfallBand}`,
      ];
      selected.push({
        ...candidate,
        matchScore: scoreState(entry).score,
        score: scoreState(entry).score,
        rationale: candidate.rationale ?? null,
        hook: candidate.hook ?? candidate.strongestHook ?? null,
        strongestHook: candidate.strongestHook ?? candidate.hook ?? null,
        responseLikelihood: candidate.responseLikelihood ?? null,
        applicationReady: true,
        applicationReadiness: 'Ready',
        selectionTier: strict ? 'Strict' : 'Backfill',
        freshnessWindow: entry.freshness?.window || null,
        waterfallBand: entry.waterfallBand,
        relaxations: [...new Set(relaxations)],
        readinessEvidence: entry.readiness.evidence,
      });
    }
    if (selected.length >= target) break;
  }
  const selectedCount = selected.length;
  return {
    selected,
    readyPoolCount: scored.length,
    scoringQueue: scoringQueue.map((entry) => ({
      ...entry.candidate,
      scoringStatus: scoreState(entry).status,
      scoringQueueReason: scoreState(entry).status === 'scoring-failed' ? 'INVALID_MATCH_SCORE' : 'MATCH_SCORE_REQUIRED',
      ...(scoreState(entry).status === 'scoring-failed' && (entry.candidate.scoringError || entry.candidate.scoringFailureReason)
        ? { scoringFailureReason: entry.candidate.scoringError || entry.candidate.scoringFailureReason }
        : {}),
      autoSuggest: false,
    })),
    scoredCount: scored.length,
    unscoredCount: scoringQueue.filter((entry) => scoreState(entry).status === 'unscored').length,
    scoringFailedCount: scoringQueue.filter((entry) => scoreState(entry).status === 'scoring-failed').length,
    readyCount: ready.length,
    minimum,
    preferred: Math.min(preferred, maximum),
    maximum,
    target,
    shortfall: Math.max(0, minimum - selectedCount),
    preferredShortfall: Math.max(0, Math.min(preferred, maximum) - selectedCount),
    bands: selected.reduce((counts, candidate) => ({ ...counts, [candidate.waterfallBand]: (counts[candidate.waterfallBand] || 0) + 1 }), {}),
    familyCounts: selected.reduce((counts, candidate) => ({ ...counts, [candidate.roleFamily || 'unknown']: (counts[candidate.roleFamily || 'unknown'] || 0) + 1 }), {}),
  };
}
