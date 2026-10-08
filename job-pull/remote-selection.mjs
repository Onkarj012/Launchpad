import { selectNormalApplications, WATERFALL, waterfallBand } from './normal-selection.mjs';

export const REMOTE_WATERFALL = WATERFALL;

// Keep freshness classes shared; provider delays are readiness evidence, not a tier relaxation.
export function remoteWaterfallBand(entry) {
  return waterfallBand(entry);
}

// Select only remote-ready rows through the shared daily policy.
export function selectRemoteApplications(entries, options = {}) {
  const selection = selectNormalApplications(entries.filter((entry) => (entry.candidate || entry).remoteReady === true), options);
  return {
    ...selection,
    eligibilityClasses: selection.selected.reduce((counts, candidate) => {
      const key = candidate.remoteEligibilityDecision?.classification || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
  };
}
