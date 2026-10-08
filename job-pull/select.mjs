import { normalizedKey } from './candidate.mjs';
import { scoreState } from './mode-scoring.mjs';
import { autoSuggestFor } from './match-scorer.mjs';
import { sourceQuality } from './dedup.mjs';

function selectionView(entry) {
  const eligibility = entry.eligibility || {};
  const freshness = entry.freshness || {};
  const candidate = entry.candidate || entry;
  const { status: scoringStatus, score } = scoreState(entry);
  return {
    candidate,
    eligibility,
    freshness,
    tier: entry.selectionTier || eligibility.tier || candidate.selectionTier || (eligibility.strict === true ? 'strict' : 'relaxed'),
    conversionTier: entry.conversionTier || (entry.candidate || entry).conversionTier || null,
    window: entry.freshnessWindow || freshness.window || null,
    family: entry.roleFamily || candidate.roleFamily || eligibility.roleFamily || 'adjacent-engineering',
    company: entry.companyKey || eligibility.companyKey || normalizedKey(candidate.company),
    score: scoringStatus === 'scored' ? score : null,
    scoringStatus,
  };
}

export function rankCandidate(entry) {
  const view = selectionView(entry);
  const candidate = view.candidate;
  const age = Number.isFinite(view.freshness.ageHours) ? view.freshness.ageHours : Number.POSITIVE_INFINITY;
  const conversionTierRank = { strong: 2, inspect: 1, skip: 0 }[view.conversionTier] ?? -1;
  return {
    score: view.score ?? Number.NEGATIVE_INFINITY,
    conversionTier: view.conversionTier,
    conversionTierRank,
    quality: sourceQuality(candidate),
    age,
    postedAt: candidate.postedAt || '',
    key: `${candidate.canonicalUrl || ''}\0${candidate.company || ''}\0${candidate.title || ''}`,
  };
}

// Compute the suggestion from validated scoring and selector facts.
function autoSuggest(view) {
  return view.scoringStatus === 'scored' && autoSuggestFor({ ...view.candidate, freshnessWindow: view.window, selectionTier: view.tier }, view.score, view.candidate.responseLikelihood);
}

function queueCandidate(view) {
  return {
    ...view.candidate,
    scoringStatus: view.scoringStatus,
    scoringQueueReason: view.scoringStatus === 'scoring-failed' ? 'INVALID_MATCH_SCORE' : 'MATCH_SCORE_REQUIRED',
    autoSuggest: false,
  };
}

function candidateKey(view) {
  const candidate = view.candidate;
  return candidate.canonicalUrl || candidate.url || [candidate.provider, candidate.company, candidate.title, candidate.location]
    .map((value) => String(value || '').trim().toLocaleLowerCase())
    .join('|');
}

function isVerifyQueue(view) {
  return view.freshness.verifyQueue === true || view.window === 'VerifyQueue';
}

function hasKnownBackfillAge(view) {
  const ageHours = Number(view.freshness.ageHours);
  return Number.isFinite(ageHours) && ageHours > 7 * 24 && ageHours <= 14 * 24;
}

function compareRank(a, b) {
  const left = rankCandidate(a);
  const right = rankCandidate(b);
  if (right.score !== left.score) return right.score - left.score;
  if (right.conversionTierRank !== left.conversionTierRank) return right.conversionTierRank - left.conversionTierRank;
  if (right.quality !== left.quality) return right.quality - left.quality;
  if (left.age !== right.age) return left.age - right.age;
  if (right.postedAt !== left.postedAt) return right.postedAt.localeCompare(left.postedAt);
  return left.key.localeCompare(right.key);
}

// Balance families inside each policy band before advancing to the next band.
export function pickDailyEntries(ordered, target, { maximumPerCompany = 2, maximumFamilyShare = 0.4, previousDailyCandidates = [] } = {}) {
  const selected = [];
  const companies = new Map();
  const families = new Map();
  const seen = new Set();
  for (const candidate of previousDailyCandidates) {
    const company = normalizedKey(candidate.company);
    const family = candidate.roleFamily || 'adjacent-engineering';
    companies.set(company, (companies.get(company) || 0) + 1);
    families.set(family, (families.get(family) || 0) + 1);
  }
  const cap = Math.max(1, Math.floor((target + previousDailyCandidates.length) * maximumFamilyShare));
  const view = (entry) => selectionView(entry);
  const canPick = (entry) => {
    const item = view(entry);
    return !seen.has(candidateKey(item)) && (companies.get(item.company) || 0) < maximumPerCompany;
  };
  const bands = [...new Set(ordered.map((entry) => entry.waterfallBand || `${String(view(entry).tier).toLowerCase()}:${view(entry).window}`))];
  for (const band of bands) {
    const pool = ordered.filter((entry) => (entry.waterfallBand || `${String(view(entry).tier).toLowerCase()}:${view(entry).window}`) === band);
    while (selected.length < target) {
      const available = pool.filter(canPick);
      if (!available.length) break;
      const represented = new Set(families.keys());
      const unseen = available.filter((entry) => !represented.has(view(entry).family));
      const balanced = available.filter((entry) => (families.get(view(entry).family) || 0) < cap);
      const choice = represented.size < 4 && unseen.length ? unseen[0] : balanced[0] || available[0];
      const item = view(choice);
      selected.push(choice);
      seen.add(candidateKey(item));
      companies.set(item.company, (companies.get(item.company) || 0) + 1);
      families.set(item.family, (families.get(item.family) || 0) + 1);
    }
  }
  // Preserve the policy waterfall and fit rank in the returned list.
  return selected.sort((left, right) => ordered.indexOf(left) - ordered.indexOf(right));
}

export function selectCandidates(entries, config) {
  const views = entries.map(selectionView);
  const verifyQueue = views.filter(isVerifyQueue);
  const eligible = views.filter((entry) => entry.eligibility?.eligible === true
    && entry.freshness?.eligible === true
    && !isVerifyQueue(entry)
    && (entry.window !== 'Backfill' || hasKnownBackfillAge(entry)));
  const scored = eligible.filter((entry) => entry.scoringStatus === 'scored');
  const targetCount = Math.min(config.run.maximumTotal, Math.max(config.run.minimumTotal, scored.length));
  const exclusions = [];
  const phases = [
    ['strict', 'Hot'],
    ['strict', 'Active'],
    ['strict', 'Backfill'],
    ['relaxed', 'Hot'],
    ['relaxed', 'Active'],
    ['relaxed', 'Backfill'],
  ];
  const ordered = phases.flatMap(([tier, window]) => scored.filter((entry) => entry.tier === tier && entry.window === window).sort(compareRank));
  const selected = pickDailyEntries(ordered, targetCount, config.run);
  for (const entry of scored) {
    if (!selected.includes(entry) && selected.filter((picked) => picked.company === entry.company).length >= config.run.maximumPerCompany) {
      exclusions.push({ candidate: entry.candidate, code: 'SELECTION_COMPANY_CAP', evidence: entry.company });
    }
  }

  const strictEligible = scored.filter((entry) => entry.tier === 'strict').length;
  const strictSelected = selected.filter((entry) => entry.tier === 'strict').length;
  const relaxedSelected = selected.filter((entry) => entry.tier === 'relaxed').length;
  const selectedKeys = new Set(selected.map(candidateKey));
  const scoringQueue = eligible.filter((entry) => entry.scoringStatus !== 'scored' && !selectedKeys.has(candidateKey(entry)));
  const verifyQueueKeys = new Set(verifyQueue.map(candidateKey));
  const scoringQueueKeys = new Set(scoringQueue.map(candidateKey));
  const selectedVerifyQueue = [...selectedKeys].filter((key) => verifyQueueKeys.has(key));
  const selectedScoringQueue = [...selectedKeys].filter((key) => scoringQueueKeys.has(key));
  if (selectedVerifyQueue.length || selectedScoringQueue.length) {
    throw new Error('selection invariant failed: selected overlaps VerifyQueue or scoringQueue');
  }
  const familyCounts = {};
  const companyCounts = {};
  for (const entry of selected) {
    familyCounts[entry.family] = (familyCounts[entry.family] || 0) + 1;
    companyCounts[entry.company] = (companyCounts[entry.company] || 0) + 1;
  }
  return {
    selected: selected.map((entry) => ({
      ...entry.candidate,
      eligibility: entry.eligibility,
      freshness: entry.freshness,
      selectionTier: entry.tier,
      freshnessWindow: entry.window,
      roleFamily: entry.family,
      companyKey: entry.company,
      matchScore: entry.score,
      score: entry.score,
      rationale: entry.candidate.rationale ?? null,
      hook: entry.candidate.hook ?? entry.candidate.strongestHook ?? null,
      strongestHook: entry.candidate.strongestHook ?? entry.candidate.hook ?? null,
      responseLikelihood: entry.candidate.responseLikelihood ?? null,
      autoSuggest: autoSuggest(entry),
      conversionTier: entry.conversionTier,
    })),
    strictSelected,
    strictEligible,
    strictShortfall: Math.max(0, config.run.strictTarget - strictSelected),
    relaxedSelected,
    targetCount,
    familyCounts,
    companyCounts,
    exclusions,
    scoringQueue: scoringQueue.map(queueCandidate),
    verifyQueue: verifyQueue.map((entry) => entry.candidate),
    selectionInvariants: {
      selectedVerifyQueue,
      selectedScoringQueue,
    },
    scoredCount: scored.length,
    unscoredCount: scoringQueue.filter((entry) => entry.scoringStatus === 'unscored').length,
    scoringFailedCount: scoringQueue.filter((entry) => entry.scoringStatus === 'scoring-failed').length,
  };
}

function shortlistRoleGroup(entry) {
  const family = selectionView(entry).family;
  if (family === 'ai-llm-agentic' || family === 'ml') return 'ai';
  if (family === 'backend-python' || family === 'full-stack-ai') return 'backendFullStack';
  if (family === 'general-new-grad-swe' || family === 'paid-internship') return 'newGrad';
  return 'adjacent';
}

function directOrVc(entry) {
  return ['direct-company', 'vc-portfolio'].includes(selectionView(entry).candidate.sourceCategory);
}

function indiaNiche(entry) {
  return selectionView(entry).candidate.sourceCategory === 'india-niche';
}

function broadRemote(entry) {
  return selectionView(entry).candidate.sourceCategory === 'broad-remote';
}

/**
 * Produce a separate manual application list from the daily discovery pool. Quotas
 * are attempted in priority order and every unmet target is reported instead
 * of filling the list with unresolved or unverified aggregator postings.
 */
export function selectApplicationShortlist(entries, config) {
  const policy = config.applicationShortlist;
  const ready = entries
    .filter((entry) => selectionView(entry).candidate.applicationReady === true && selectionView(entry).scoringStatus === 'scored')
    .sort(compareRank);
  const selected = [];
  const counts = { roles: { ai: 0, backendFullStack: 0, newGrad: 0, adjacent: 0 }, directOrVc: 0, indiaNiche: 0, broadRemote: 0, stretch: 0 };
  const companyCounts = new Map();
  const canSelect = (entry) => {
    if (selected.includes(entry)) return false;
    const view = selectionView(entry);
    if ((companyCounts.get(view.company) || 0) >= config.run.maximumPerCompany) return false;
    if (broadRemote(entry) && counts.broadRemote >= policy.sourceTargets.broadRemoteMaximum) return false;
    if (view.tier === 'relaxed' && counts.stretch >= policy.maximumStretch) return false;
    return true;
  };
  const add = (entry) => {
    const view = selectionView(entry);
    selected.push(entry);
    companyCounts.set(view.company, (companyCounts.get(view.company) || 0) + 1);
    counts.roles[shortlistRoleGroup(entry)]++;
    if (directOrVc(entry)) counts.directOrVc++;
    if (indiaNiche(entry)) counts.indiaNiche++;
    if (broadRemote(entry)) counts.broadRemote++;
    if (view.tier === 'relaxed') counts.stretch++;
  };
  const pick = (predicate, amount) => {
    for (const entry of ready) {
      if (selected.length >= policy.targetCount || amount <= 0) break;
      if (canSelect(entry) && predicate(entry)) {
        add(entry);
        amount--;
      }
    }
  };

  pick(directOrVc, policy.sourceTargets.directOrVcMinimum);
  pick(indiaNiche, policy.sourceTargets.indiaNicheMinimum);
  for (const [group, target] of Object.entries(policy.roleTargets)) pick((entry) => shortlistRoleGroup(entry) === group, Math.max(0, target - counts.roles[group]));
  pick(() => true, policy.targetCount - selected.length);

  const shortfalls = {
    targetCount: Math.max(0, policy.targetCount - selected.length),
    roles: Object.fromEntries(Object.entries(policy.roleTargets).map(([group, target]) => [group, Math.max(0, target - counts.roles[group])])),
    directOrVc: Math.max(0, policy.sourceTargets.directOrVcMinimum - counts.directOrVc),
    indiaNiche: Math.max(0, policy.sourceTargets.indiaNicheMinimum - counts.indiaNiche),
  };
  return {
    targetCount: policy.targetCount,
    selected: selected.map((entry) => ({
      ...selectionView(entry).candidate,
      applicationShortlistRoleGroup: shortlistRoleGroup(entry),
      conversionTier: selectionView(entry).conversionTier,
    })),
    counts,
    shortfalls,
    readyPoolCount: ready.length,
  };
}

export function sortCandidates(entries) {
  return [...entries].sort(compareRank);
}
