import { normalizedKey } from './candidate.mjs';
import { sourceQuality } from './dedup.mjs';
import { applicationReadiness } from './normal-readiness.mjs';

const NORMAL_WATERFALL = Object.freeze([
  'Strict Hot',
  'Strict Active',
  'Strict Backfill',
  'Fallback Hot',
  'Fallback Active',
  'Fallback Backfill',
]);

const WATERFALL = Object.freeze([
  'strict-0-24h',
  'strict-24-72h',
  'strict-3-7d',
  'relaxed-fresh-up-to-2-years',
  'relaxed-fresh-adjacent',
  'relaxed-3-7d',
  'relaxed-backfill-8-14d',
]);

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

function compareFit(left, right) {
  const leftCandidate = left.candidate || left;
  const rightCandidate = right.candidate || right;
  const score = scoreState(right).score - scoreState(left).score;
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

function normalWaterfallBand(entry) {
  const candidate = entry.candidate || entry;
  const eligibility = entry.eligibility || candidate.eligibility || {};
  const freshness = entry.freshness || candidate.freshness || {};
  if (!freshness.eligible || !['Hot', 'Active', 'Backfill'].includes(freshness.window)) return null;
  if (eligibility.strict) return `Strict ${freshness.window}`;
  if (eligibility.eligible) return `Fallback ${freshness.window}`;
  return null;
}

// Compatibility contract for Remote mode, whose provider-delay waterfall is
// intentionally based on the earlier age buckets. Normal selection uses the
// explicit six-phase policy above and does not consume this helper.
function waterfallBand(entry) {
  const candidate = entry.candidate || entry;
  const eligibility = entry.eligibility || candidate.eligibility || {};
  const freshness = entry.freshness || candidate.freshness || {};
  const age = Number(freshness.ageHours ?? candidate.freshness?.ageHours);
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

function familyFor(entry) {
  return entry.candidate?.roleFamily
    || entry.roleFamily
    || entry.eligibility?.roleFamily
    || entry.candidate?.eligibility?.roleFamily
    || 'unknown';
}

function companyFor(entry) {
  return normalizedKey(entry.candidate?.company ?? entry.company);
}

function selectedCandidate(entry, { section = 'Application Ready' } = {}) {
  const candidate = entry.candidate;
  const strict = entry.waterfallBand.startsWith('Strict ');
  const relaxations = strict ? [] : [
    ...(entry.eligibility?.relaxations || []),
    `waterfall:${entry.waterfallBand}`,
  ];
  return {
    ...candidate,
    matchScore: scoreState(entry).score,
    score: scoreState(entry).score,
    rationale: candidate.rationale ?? null,
    hook: candidate.hook ?? candidate.strongestHook ?? null,
    strongestHook: candidate.strongestHook ?? candidate.hook ?? null,
    responseLikelihood: candidate.responseLikelihood ?? null,
    applicationReady: section === 'Application Ready',
    applicationReadiness: section === 'Application Ready' ? 'Ready' : 'Shortage-Only Stretch',
    selectionSection: section,
    selectionTier: strict ? 'Strict' : 'Fallback',
    freshnessWindow: entry.freshness?.window || null,
    waterfallBand: entry.waterfallBand,
    roleFamily: familyFor(entry),
    relaxations: [...new Set(relaxations)],
    readinessEvidence: entry.readiness.evidence,
  };
}

function exclusion(entry, code, evidence) {
  return {
    candidate: {
      ...entry.candidate,
      applicationReady: false,
      applicationReadiness: 'Excluded by Normal selection policy',
      autoSuggest: false,
    },
    canonicalUrl: entry.candidate.canonicalUrl,
    company: entry.candidate.company,
    family: familyFor(entry),
    waterfallBand: entry.waterfallBand,
    score: scoreState(entry).score,
    code,
    evidence,
  };
}

function countsBy(items, keyFor) {
  return Object.fromEntries([...items.reduce((counts, item) => {
    const key = keyFor(item);
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map()).entries()]);
}

function choosePhase(phase, selectedEntries, target, {
  maximumPerCompany,
  familyTargetMaximum,
  familyAlternatives,
  companyCounts,
  familyCounts,
  exclusions,
}) {
  const remaining = [...phase].sort(compareFit);
  while (remaining.length && selectedEntries.length < target) {
    for (let index = remaining.length - 1; index >= 0; index--) {
      const entry = remaining[index];
      const company = companyFor(entry);
      if ((companyCounts.get(company) || 0) < maximumPerCompany) continue;
      exclusions.push(exclusion(entry, 'SELECTION_COMPANY_CAP', {
        company,
        maximumPerCompany,
      }));
      remaining.splice(index, 1);
    }
    if (!remaining.length) break;
    const underFamilyTarget = familyAlternatives
      ? remaining.filter((entry) => (familyCounts.get(familyFor(entry)) || 0) < familyTargetMaximum)
      : remaining;
    const candidates = underFamilyTarget.length ? underFamilyTarget : remaining;
    candidates.sort((left, right) => {
      const familyDifference = (familyCounts.get(familyFor(left)) || 0) - (familyCounts.get(familyFor(right)) || 0);
      return familyDifference || compareFit(left, right);
    });
    const chosen = candidates[0];
    remaining.splice(remaining.indexOf(chosen), 1);
    selectedEntries.push(chosen);
    const company = companyFor(chosen);
    const family = familyFor(chosen);
    companyCounts.set(company, (companyCounts.get(company) || 0) + 1);
    familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
  }
  return remaining;
}

export { NORMAL_WATERFALL, WATERFALL, waterfallBand };

/**
 * Select the Normal application-ready section. The score floor is hard;
 * shortage-only stretch rows remain visible but never create application
 * operations. Family share is a composition target, while company cap is hard.
 */
export function selectNormalApplications(entries, {
  minimum = 10,
  preferred = 12,
  maximum = 20,
  maximumPerCompany = 2,
  maximumFamilyShare = 0.4,
  strictTarget = 10,
  scoreFloor = 65,
  stretchFloor = 50,
} = {}) {
  const ready = entries
    .map((entry) => {
      const candidate = entry.candidate || entry;
      const eligibility = entry.eligibility || candidate.eligibility || null;
      const freshness = entry.freshness || candidate.freshness || null;
      const readiness = applicationReadiness(candidate, eligibility);
      return {
        ...entry,
        candidate,
        eligibility,
        freshness,
        readiness,
        waterfallBand: normalWaterfallBand({ ...entry, candidate, eligibility, freshness }),
      };
    })
    .filter((entry) => entry.readiness.ready && entry.waterfallBand);
  const scored = ready.filter((entry) => scoreState(entry).status === 'scored');
  const scoringQueueEntries = ready.filter((entry) => scoreState(entry).status !== 'scored');
  const normal = scored.filter((entry) => scoreState(entry).score >= scoreFloor);
  const stretchEntries = scored.filter((entry) => scoreState(entry).score >= stretchFloor && scoreState(entry).score < scoreFloor);
  const belowFloor = scored.filter((entry) => scoreState(entry).score < stretchFloor);
  const target = Math.min(maximum, normal.length);
  const familyInventory = new Set(normal.map(familyFor));
  const familyAlternatives = familyInventory.size > 1;
  const familyTargetMaximum = Math.max(1, Math.floor(Math.max(1, target) * maximumFamilyShare));
  const selectedEntries = [];
  const exclusions = [];
  const companyCounts = new Map();
  const familyCounts = new Map();

  for (const band of NORMAL_WATERFALL) {
    const phase = normal.filter((entry) => entry.waterfallBand === band);
    choosePhase(phase, selectedEntries, target, {
      maximumPerCompany,
      familyTargetMaximum,
      familyAlternatives,
      companyCounts,
      familyCounts,
      exclusions,
    });
  }

  const selectedSet = new Set(selectedEntries);
  for (const entry of normal) {
    if (selectedSet.has(entry) || exclusions.some((item) => item.canonicalUrl === entry.candidate.canonicalUrl)) continue;
    const company = companyFor(entry);
    if ((companyCounts.get(company) || 0) >= maximumPerCompany) {
      exclusions.push(exclusion(entry, 'SELECTION_COMPANY_CAP', {
        company,
        maximumPerCompany,
      }));
      continue;
    }
    const family = familyFor(entry);
    const familyAtTarget = familyAlternatives && (familyCounts.get(family) || 0) >= familyTargetMaximum;
    exclusions.push(exclusion(
      entry,
      familyAtTarget ? 'SELECTION_FAMILY_DIVERSITY_TARGET' : 'SELECTION_MAXIMUM_REACHED',
      familyAtTarget
        ? { family, maximumShare: maximumFamilyShare, targetMaximum: familyTargetMaximum }
        : { maximum },
    ));
  }
  for (const entry of stretchEntries) {
    exclusions.push(exclusion(entry, 'MATCH_SCORE_STRETCH_50_64', {
      stretchFloor,
      scoreFloor,
      section: 'Shortage-Only Stretch',
    }));
  }
  for (const entry of belowFloor) {
    exclusions.push(exclusion(entry, 'MATCH_SCORE_BELOW_50', { stretchFloor }));
  }

  const selected = selectedEntries.map((entry) => selectedCandidate(entry));
  const stretch = [...stretchEntries]
    .sort((left, right) => NORMAL_WATERFALL.indexOf(left.waterfallBand) - NORMAL_WATERFALL.indexOf(right.waterfallBand) || compareFit(left, right))
    .map((entry) => selectedCandidate(entry, { section: 'Shortage-Only Stretch' }));
  const strictSelected = selected.filter((candidate) => candidate.selectionTier === 'Strict').length;
  const selectionLossCounts = countsBy(exclusions, (item) => item.code);
  const selectedFamilyCounts = countsBy(selected, (candidate) => candidate.roleFamily || 'unknown');
  const selectedCompanyCounts = countsBy(selected, (candidate) => normalizedKey(candidate.company));
  const scoringQueue = scoringQueueEntries.map((entry) => ({
    ...entry.candidate,
    scoringStatus: scoreState(entry).status,
    scoringQueueReason: scoreState(entry).status === 'scoring-failed' ? 'INVALID_MATCH_SCORE' : 'MATCH_SCORE_REQUIRED',
    ...(scoreState(entry).status === 'scoring-failed' && (entry.candidate.scoringError || entry.candidate.scoringFailureReason)
      ? { scoringFailureReason: entry.candidate.scoringError || entry.candidate.scoringFailureReason }
      : {}),
    autoSuggest: false,
  }));

  return {
    selected,
    stretch,
    exclusions,
    reconciliationCounts: selectionLossCounts,
    readyPoolCount: normal.length,
    scoredCount: scored.length,
    scoringQueue,
    unscoredCount: scoringQueueEntries.filter((entry) => scoreState(entry).status === 'unscored').length,
    scoringFailedCount: scoringQueueEntries.filter((entry) => scoreState(entry).status === 'scoring-failed').length,
    readyCount: ready.length,
    minimum,
    preferred: Math.min(preferred, maximum),
    maximum,
    target,
    shortfall: Math.max(0, minimum - selected.length),
    preferredShortfall: Math.max(0, Math.min(preferred, maximum) - selected.length),
    scorePolicy: {
      normalFloor: scoreFloor,
      stretchFloor,
      stretchCount: stretch.length,
      belowFloorCount: belowFloor.length,
    },
    strictComposition: {
      requirement: `at least ${strictTarget} Strict roles`,
      target: strictTarget,
      selected: strictSelected,
      shortfall: Math.max(0, strictTarget - strictSelected),
      met: strictSelected >= strictTarget,
    },
    familyComposition: {
      maximumShare: maximumFamilyShare,
      targetMaximum: familyTargetMaximum,
      alternativesExist: familyAlternatives,
      counts: selectedFamilyCounts,
      met: !familyAlternatives || Object.values(selectedFamilyCounts).every((count) => count <= familyTargetMaximum),
    },
    bands: countsBy(selected, (candidate) => candidate.waterfallBand),
    familyCounts: selectedFamilyCounts,
    companyCounts: selectedCompanyCounts,
  };
}
