import { sourceQuality } from './dedup.mjs';
import { applicationReadiness } from './normal-readiness.mjs';
import { WATERFALL, waterfallBand } from './normal-selection.mjs';

function fitScore(entry) {
  const candidate = entry.candidate || entry;
  return Number(candidate.matchScore ?? candidate.score ?? entry.matchScore ?? entry.score ?? 0);
}

function startupRank(entry) { return Number((entry.candidate || entry).startupPriority ?? 0); }

function compareStartup(left, right) {
  const priority = startupRank(right) - startupRank(left);
  if (priority) return priority;
  const fit = fitScore(right) - fitScore(left);
  if (fit) return fit;
  const conversion = Number((right.candidate || right).conversionScore ?? 0) - Number((left.candidate || left).conversionScore ?? 0);
  if (conversion) return conversion;
  const quality = sourceQuality(right.candidate || right) - sourceQuality(left.candidate || left);
  if (quality) return quality;
  const posted = String((right.candidate || right).postedAt || '').localeCompare(String((left.candidate || left).postedAt || ''));
  if (posted) return posted;
  return String((left.candidate || left).canonicalUrl || '').localeCompare(String((right.candidate || right).canonicalUrl || ''));
}

/** Startup ranking changes only tie/order preference; shared gates stay immutable. */
export function selectStartupApplications(entries, { minimum = 10, preferred = 12, maximum = 20, maximumPerCompany = 2 } = {}) {
  const ready = entries.map((entry) => {
    const candidate = entry.candidate || entry;
    const eligibility = entry.eligibility || candidate.eligibility || null;
    const freshness = entry.freshness || candidate.freshness || null;
    const readiness = applicationReadiness(candidate, eligibility);
    return { ...entry, candidate, eligibility, freshness, readiness, waterfallBand: waterfallBand({ ...entry, candidate, eligibility, freshness }) };
  }).filter((entry) => entry.readiness.ready && entry.waterfallBand);
  const queues = new Map(WATERFALL.map((band) => [band, []]));
  for (const entry of ready) queues.get(entry.waterfallBand).push(entry);
  for (const queue of queues.values()) queue.sort(compareStartup);
  const target = Math.min(maximum, ready.length);
  const selected = [];
  const companyCounts = new Map();
  const seen = new Set();
  for (const band of WATERFALL) {
    for (const entry of queues.get(band)) {
      if (selected.length >= target) break;
      const candidate = entry.candidate;
      const company = String(candidate.company || '').toLocaleLowerCase();
      if (seen.has(candidate.canonicalUrl) || (companyCounts.get(company) || 0) >= maximumPerCompany) continue;
      seen.add(candidate.canonicalUrl);
      companyCounts.set(company, (companyCounts.get(company) || 0) + 1);
      const strict = entry.waterfallBand.startsWith('strict-');
      selected.push({
        ...candidate,
        applicationReady: true,
        applicationReadiness: 'Ready',
        selectionTier: strict ? 'Strict' : 'Backfill',
        freshnessWindow: entry.freshness?.window || null,
        waterfallBand: entry.waterfallBand,
        relaxations: strict ? [] : [...new Set([...(entry.eligibility?.relaxations || []), `waterfall:${entry.waterfallBand}`])],
        readinessEvidence: entry.readiness.evidence,
      });
    }
    if (selected.length >= target) break;
  }
  return {
    selected,
    readyPoolCount: ready.length,
    minimum,
    preferred: Math.min(preferred, maximum),
    maximum,
    target,
    shortfall: Math.max(0, minimum - selected.length),
    preferredShortfall: Math.max(0, Math.min(preferred, maximum) - selected.length),
    bands: selected.reduce((counts, candidate) => ({ ...counts, [candidate.waterfallBand]: (counts[candidate.waterfallBand] || 0) + 1 }), {}),
    familyCounts: selected.reduce((counts, candidate) => ({ ...counts, [candidate.roleFamily || 'unknown']: (counts[candidate.roleFamily || 'unknown'] || 0) + 1 }), {}),
    startupSources: selected.reduce((counts, candidate) => {
      for (const lane of candidate.startupSourceLanes || [candidate.startupLaneId || 'unknown']) counts[lane] = (counts[lane] || 0) + 1;
      return counts;
    }, {}),
  };
}

