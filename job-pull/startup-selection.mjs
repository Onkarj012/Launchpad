import { selectNormalApplications } from './normal-selection.mjs';

// Apply shared fit, freshness and diversity rules to the startup-ready pool.
export function selectStartupApplications(entries, options = {}) {
  const selection = selectNormalApplications(entries, options);
  return {
    ...selection,
    startupSources: selection.selected.reduce((counts, candidate) => {
      for (const lane of candidate.startupSourceLanes || [candidate.startupLaneId || 'unknown']) counts[lane] = (counts[lane] || 0) + 1;
      return counts;
    }, {}),
  };
}
