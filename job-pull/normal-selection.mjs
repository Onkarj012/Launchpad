import { pickDailyEntries } from './select.mjs';
import { autoSuggestFor } from './match-scorer.mjs';
import { sourceQuality } from './dedup.mjs';
import { applicationReadiness } from './normal-readiness.mjs';
import { scoreState, scoringQueueRecord, splitScoredEntries } from './mode-scoring.mjs';

function ageHours(entry) { return Number(entry.freshness?.ageHours ?? entry.candidate?.freshness?.ageHours); }

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
  if (!Number.isFinite(age) || age < 0 || entry.freshness?.eligible === false || entry.freshness?.window === 'VerifyQueue') return null;
  const strict = eligibility.strict === true || String(eligibility.tier || candidate.selectionTier).toLowerCase() === 'strict';
  if (!eligibility.eligible) return null;
  if (strict && age <= 72) return 'strict-hot-0-72h';
  if (strict && age <= 168) return 'strict-3-7d';
  if (strict && age <= 336) return 'strict-backfill-8-14d';
  if (age <= 72) return 'relaxed-hot-0-72h';
  if (age <= 168) return 'relaxed-3-7d';
  if (age <= 336) return 'relaxed-backfill-8-14d';
  return null;
}

const WATERFALL = Object.freeze([
  'strict-hot-0-72h',
  'strict-3-7d',
  'strict-backfill-8-14d',
  'relaxed-hot-0-72h',
  'relaxed-3-7d',
  'relaxed-backfill-8-14d',
]);

export { WATERFALL, waterfallBand };

// Select verified scored roles with the shared daily waterfall and diversity policy.
export function selectNormalApplications(entries, { minimum = 10, preferred = 12, maximum = 20, maximumPerCompany = 2, maximumFamilyShare = 0.4, previousDailyCandidates = [], includeEorContract = false } = {}) {
  const evaluated = entries.map((entry) => {
    const candidate = entry.candidate || entry;
    const eligibility = entry.eligibility || candidate.eligibility || null;
    const freshness = entry.freshness || candidate.freshness || null;
    const readiness = entry.readiness || applicationReadiness(candidate, eligibility);
    return { ...entry, candidate, eligibility, freshness, readiness, waterfallBand: waterfallBand({ ...entry, candidate, eligibility, freshness }) };
  });
  const ready = evaluated.filter((entry) => (includeEorContract || entry.eligibility?.employment?.lane !== 'eor-contract') && entry.readiness.ready && entry.waterfallBand);
  const { scored, scoringQueue, scoredCount, unscoredCount, scoringFailedCount } = splitScoredEntries(ready);
  const queues = new Map(WATERFALL.map((band) => [band, []]));
  for (const entry of scored) queues.get(entry.waterfallBand).push(entry);
  for (const queue of queues.values()) queue.sort(compareFit);
  const target = Math.min(maximum, scored.length);
  const ordered = WATERFALL.flatMap((band) => queues.get(band));
  const picked = pickDailyEntries(ordered, target, { maximumPerCompany, maximumFamilyShare, previousDailyCandidates });
  // Attach the same readiness and ranking evidence to results and shortlist rows.
  function resultFor(entry) {
    const candidate = entry.candidate;
    const strict = entry.waterfallBand.startsWith('strict-');
    const selectionTier = strict ? 'Strict' : 'Backfill';
    const matchScore = scoreState(entry).score;
    return {
      ...candidate, matchScore, score: matchScore,
      autoSuggest: autoSuggestFor({ ...candidate, selectionTier, freshnessWindow: entry.freshness?.window }, matchScore, candidate.responseLikelihood),
      rationale: candidate.rationale ?? null,
      hook: candidate.hook ?? candidate.strongestHook ?? null,
      strongestHook: candidate.strongestHook ?? candidate.hook ?? null,
      responseLikelihood: candidate.responseLikelihood ?? null,
      applicationReady: true, applicationReadiness: 'Ready', selectionTier,
      freshnessWindow: entry.freshness?.window || null,
      waterfallBand: entry.waterfallBand,
      roleFamily: candidate.roleFamily || entry.eligibility?.roleFamily || 'adjacent-engineering',
      relaxations: strict ? [] : [...new Set([...(entry.eligibility?.relaxations || []), `waterfall:${entry.waterfallBand}`])],
      readinessEvidence: entry.readiness.evidence,
    };
  }
  const results = ordered.map(resultFor);
  const selected = picked.map(resultFor);
  const selectedCount = selected.length;
  return {
    selected,
    results,
    diversity: { availableFamilies: new Set(scored.map((entry) => entry.candidate.roleFamily || entry.eligibility?.roleFamily || 'adjacent-engineering')).size,
      selectedFamilies: new Set(selected.map((candidate) => candidate.roleFamily)).size,
      maximumFamilyShare, observedMaximumFamilyShare: selected.length ? Math.max(...Object.values(selected.reduce((counts, candidate) => ({ ...counts, [candidate.roleFamily]: (counts[candidate.roleFamily] || 0) + 1 }), {}))) / selected.length : 0 },
    strictSelected: selected.filter((candidate) => candidate.selectionTier === 'Strict').length,
    strictShortfall: Math.max(0, 10 - selected.filter((candidate) => candidate.selectionTier === 'Strict').length),
    readyPoolCount: scored.length,
    scoringQueue: scoringQueue.map(scoringQueueRecord),
    scoredCount,
    unscoredCount,
    scoringFailedCount,
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
