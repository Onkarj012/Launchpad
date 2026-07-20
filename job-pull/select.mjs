import { normalizedKey } from './candidate.mjs';
import { sourceQuality } from './dedup.mjs';

function selectionView(entry) {
  const eligibility = entry.eligibility || {};
  const freshness = entry.freshness || {};
  return {
    candidate: entry.candidate || entry,
    eligibility,
    freshness,
    tier: entry.selectionTier || eligibility.tier || null,
    conversionTier: entry.conversionTier || (entry.candidate || entry).conversionTier || null,
    window: entry.freshnessWindow || freshness.window || null,
    family: entry.roleFamily || eligibility.roleFamily || 'adjacent-engineering',
    company: entry.companyKey || eligibility.companyKey || normalizedKey((entry.candidate || entry).company),
  };
}

export function rankCandidate(entry) {
  const view = selectionView(entry);
  const candidate = view.candidate;
  const score = Number(entry.conversionScore ?? candidate.conversionScore ?? entry.score ?? candidate.score ?? candidate.matchScore ?? 0);
  const age = Number.isFinite(view.freshness.ageHours) ? view.freshness.ageHours : Number.POSITIVE_INFINITY;
  const conversionTierRank = { strong: 2, inspect: 1, skip: 0 }[view.conversionTier] ?? -1;
  return {
    score,
    conversionTier: view.conversionTier,
    conversionTierRank,
    quality: sourceQuality(candidate),
    age,
    postedAt: candidate.postedAt || '',
    key: `${candidate.canonicalUrl || ''}\0${candidate.company || ''}\0${candidate.title || ''}`,
  };
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

function makeFamilyQueues(pool) {
  const groups = new Map();
  for (const entry of pool) {
    const view = selectionView(entry);
    if (!groups.has(view.family)) groups.set(view.family, []);
    groups.get(view.family).push(entry);
  }
  for (const group of groups.values()) group.sort(compareRank);
  return groups;
}

function familyCapFor(targetCount, share) {
  if (targetCount < 3) return 1;
  return Math.max(1, Math.floor(targetCount * share));
}

function pickBalanced(pool, selected, exclusions, targetCount, policy) {
  const queues = makeFamilyQueues(pool);
  const counts = new Map();
  const companyCounts = new Map();
  for (const entry of selected) {
    const view = selectionView(entry);
    counts.set(view.family, (counts.get(view.family) || 0) + 1);
    companyCounts.set(view.company, (companyCounts.get(view.company) || 0) + 1);
  }
  const familyCap = familyCapFor(targetCount, policy.run.maximumFamilyShare);
  const familyAlternatives = queues.size > 1;
  let added = 0;

  while (selected.length < targetCount) {
    const availableFamilies = [...queues.entries()]
      .filter(([, queue]) => queue.length > 0)
      .sort(([familyA, queueA], [familyB, queueB]) => {
        const countA = counts.get(familyA) || 0;
        const countB = counts.get(familyB) || 0;
        if (countA !== countB) return countA - countB;
        return compareRank(queueA[0], queueB[0]);
      });
    if (!availableFamilies.length) break;
    let chosen = null;
    for (const [family, queue] of availableFamilies) {
      const view = selectionView(queue[0]);
      if ((companyCounts.get(view.company) || 0) >= policy.run.maximumPerCompany) {
        exclusions.push({ candidate: view.candidate, code: 'SELECTION_COMPANY_CAP', evidence: view.company });
        queue.shift();
        continue;
      }
      if (familyAlternatives && (counts.get(family) || 0) >= familyCap) {
        // Defer, don't discard. A later volume-fill pass may use this candidate
        // only after other families and earlier strict phases are exhausted.
        continue;
      }
      chosen = [family, queue.shift()];
      break;
    }
    if (!chosen) break;
    const [family, entry] = chosen;
    const view = selectionView(entry);
    selected.push(entry);
    counts.set(family, (counts.get(family) || 0) + 1);
    companyCounts.set(view.company, (companyCounts.get(view.company) || 0) + 1);
    added++;
  }
  return added;
}

function fillForVolume(pool, selected, exclusions, targetCount, policy) {
  const companyCounts = new Map();
  for (const entry of selected) {
    const view = selectionView(entry);
    companyCounts.set(view.company, (companyCounts.get(view.company) || 0) + 1);
  }
  for (const entry of [...pool].sort(compareRank)) {
    if (selected.length >= targetCount) break;
    if (selected.includes(entry)) continue;
    const view = selectionView(entry);
    if ((companyCounts.get(view.company) || 0) >= policy.run.maximumPerCompany) {
      if (!exclusions.some((item) => item.candidate === view.candidate && item.code === 'SELECTION_COMPANY_CAP')) {
        exclusions.push({ candidate: view.candidate, code: 'SELECTION_COMPANY_CAP', evidence: view.company });
      }
      continue;
    }
    selected.push(entry);
    companyCounts.set(view.company, (companyCounts.get(view.company) || 0) + 1);
  }
}

export function selectCandidates(entries, config) {
  const all = entries.map(selectionView).filter((entry) => entry.eligibility?.eligible && entry.freshness?.eligible);
  const targetCount = Math.min(config.run.maximumTotal, Math.max(config.run.minimumTotal, all.length));
  const selected = [];
  const exclusions = [];
  const phases = [
    ['strict', 'Hot'],
    ['strict', 'Active'],
    ['strict', 'Backfill'],
    ['relaxed', 'Hot'],
    ['relaxed', 'Active'],
    ['relaxed', 'Backfill'],
  ];
  for (const [tier, window] of phases) {
    if (selected.length >= targetCount) break;
    const sourceEntries = all.filter((entry) => entry.tier === tier && entry.window === window);
    const remaining = sourceEntries.filter((entry) => !selected.includes(entry));
    pickBalanced(remaining, selected, exclusions, targetCount, config);
  }
  // Diversity is a ranking constraint, not a reason to miss daily volume. Fill
  // remaining slots in the same strict/freshness order after alternatives were
  // exhausted, while retaining the hard company cap.
  for (const [tier, window] of phases) {
    if (selected.length >= targetCount) break;
    fillForVolume(all.filter((entry) => entry.tier === tier && entry.window === window), selected, exclusions, targetCount, config);
  }

  const strictEligible = all.filter((entry) => entry.tier === 'strict').length;
  const strictSelected = selected.filter((entry) => entry.tier === 'strict').length;
  const relaxedSelected = selected.filter((entry) => entry.tier === 'relaxed').length;
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
      score: Number(entry.score ?? entry.candidate.score ?? entry.candidate.matchScore ?? 0),
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
 * Produce a separate, apply-ready list from the 25-35 discovery pool. Quotas
 * are attempted in priority order and every unmet target is reported instead
 * of filling the list with unresolved or unverified aggregator postings.
 */
export function selectApplicationShortlist(entries, config) {
  const policy = config.applicationShortlist;
  const ready = entries
    .filter((entry) => selectionView(entry).candidate.applicationReady === true)
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
