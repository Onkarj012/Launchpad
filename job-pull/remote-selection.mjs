import { sourceQuality } from './dedup.mjs';
import { applicationReadiness } from './normal-readiness.mjs';
import { scoreState, scoringQueueRecord, splitScoredEntries } from './mode-scoring.mjs';
import { waterfallBand } from './normal-selection.mjs';

export const REMOTE_WATERFALL = Object.freeze([
  'strict-0-24h',
  'remotive-delayed-0-24h',
  'strict-24-72h',
  'remotive-delayed-24-72h',
  'strict-3-7d',
  'remotive-delayed-3-7d',
  'relaxed-fresh-up-to-2-years',
  'relaxed-fresh-adjacent',
  'relaxed-3-7d',
  'relaxed-backfill-8-14d',
]);

function remotive(entry) { return String((entry.candidate || entry).provider || '').toLowerCase() === 'remotive'; }

export function remoteWaterfallBand(entry) {
  const normalBand = waterfallBand(entry);
  if (!normalBand) return null;
  if (!remotive(entry)) return normalBand;
  if (normalBand === 'strict-0-24h') return 'remotive-delayed-0-24h';
  if (normalBand === 'strict-24-72h') return 'remotive-delayed-24-72h';
  if (normalBand === 'strict-3-7d') return 'remotive-delayed-3-7d';
  return normalBand;
}

function fitScore(entry) {
  return scoreState(entry).score ?? Number.NEGATIVE_INFINITY;
}

function compareRemote(left, right) {
  const score = fitScore(right) - fitScore(left);
  if (score) return score;
  const conversion = Number((right.candidate || right).conversionScore ?? 0) - Number((left.candidate || left).conversionScore ?? 0);
  if (conversion) return conversion;
  const quality = sourceQuality(right.candidate || right) - sourceQuality(left.candidate || left);
  if (quality) return quality;
  const posted = String((right.candidate || right).postedAt || '').localeCompare(String((left.candidate || left).postedAt || ''));
  if (posted) return posted;
  return String((left.candidate || left).canonicalUrl || '').localeCompare(String((right.candidate || right).canonicalUrl || ''));
}

function isStrictBand(band) { return band === 'strict-0-24h' || band === 'strict-24-72h' || band === 'strict-3-7d'; }

/** Remote ranking keeps shared gates and freshness ordering, with Remotive's delayed-inventory rule explicit. */
export function selectRemoteApplications(entries, { minimum = 10, preferred = 12, maximum = 20, maximumPerCompany = 2 } = {}) {
  const ready = entries.map((entry) => {
    const candidate = entry.candidate || entry;
    const eligibility = entry.eligibility || candidate.eligibility || null;
    const freshness = entry.freshness || candidate.freshness || null;
    const readiness = applicationReadiness(candidate, eligibility);
    const remoteBand = remoteWaterfallBand({ ...entry, candidate, eligibility, freshness });
    return { ...entry, candidate, eligibility, freshness, readiness, remoteBand };
  }).filter((entry) => entry.candidate.remoteReady === true && entry.readiness.ready && entry.remoteBand);
  const { scored, scoringQueue, scoredCount, unscoredCount, scoringFailedCount } = splitScoredEntries(ready);

  const queues = new Map(REMOTE_WATERFALL.map((band) => [band, []]));
  for (const entry of scored) queues.get(entry.remoteBand)?.push(entry);
  for (const queue of queues.values()) queue.sort(compareRemote);

  const selected = [];
  const companyCounts = new Map();
  const seen = new Set();
  const target = Math.min(maximum, scored.length);
  for (const band of REMOTE_WATERFALL) {
    for (const entry of queues.get(band)) {
      if (selected.length >= target) break;
      const candidate = entry.candidate;
      const company = String(candidate.company || '').toLocaleLowerCase();
      if (seen.has(candidate.canonicalUrl) || (companyCounts.get(company) || 0) >= maximumPerCompany) continue;
      seen.add(candidate.canonicalUrl);
      companyCounts.set(company, (companyCounts.get(company) || 0) + 1);
      const strict = isStrictBand(band);
      const relaxations = strict ? [] : [
        ...(entry.eligibility?.relaxations || []),
        ...(band.startsWith('remotive-delayed') ? ['provider:remotive-first-24h-excluded'] : []),
        `waterfall:${band}`,
      ];
      selected.push({
        ...candidate,
        applicationReady: true,
        applicationReadiness: 'Ready',
        selectionTier: strict ? 'Strict' : 'Backfill',
        freshnessWindow: entry.freshness?.window || null,
        waterfallBand: band,
        relaxations: [...new Set(relaxations)],
        readinessEvidence: entry.readiness.evidence,
        remoteEligibilityClass: candidate.remoteEligibilityDecision?.classification || null,
        employmentStructure: candidate.remoteEmploymentCategory || null,
      });
    }
    if (selected.length >= target) break;
  }
  return {
    selected,
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
    shortfall: Math.max(0, minimum - selected.length),
    preferredShortfall: Math.max(0, Math.min(preferred, maximum) - selected.length),
    bands: selected.reduce((counts, candidate) => ({ ...counts, [candidate.waterfallBand]: (counts[candidate.waterfallBand] || 0) + 1 }), {}),
    familyCounts: selected.reduce((counts, candidate) => ({ ...counts, [candidate.roleFamily || 'unknown']: (counts[candidate.roleFamily || 'unknown'] || 0) + 1 }), {}),
    eligibilityClasses: selected.reduce((counts, candidate) => {
      const key = candidate.remoteEligibilityDecision?.classification || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
  };
}
