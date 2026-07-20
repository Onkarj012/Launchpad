const DEFAULT_WEIGHTS = {
  responsibilitiesAndStack: 25,
  experienceEligibility: 20,
  indiaLocationEligibility: 15,
  projectConnection: 15,
  directOrVcSource: 10,
  humanContact: 10,
  postingFreshness: 5,
};

const DEFAULT_BANDS = {
  readyForManualReview: 75,
  manualInspect: 65,
};

function bounded(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function weightSet(policy = {}) {
  return { ...DEFAULT_WEIGHTS, ...(policy.weights || {}) };
}

function bandSet(policy = {}) {
  return { ...DEFAULT_BANDS, ...(policy.bands || {}) };
}

export function conversionTier(score, bands = DEFAULT_BANDS) {
  const thresholds = { ...DEFAULT_BANDS, ...(bands || {}) };
  if (Number.isFinite(score) && score >= thresholds.readyForManualReview) return 'strong';
  if (Number.isFinite(score) && score >= thresholds.manualInspect) return 'inspect';
  return 'skip';
}

function directOrVcPoints(category, weights) {
  return ['direct-company', 'vc-portfolio'].includes(category) ? weights.directOrVcSource : 0;
}

function freshnessPoints(window, weights) {
  const multiplier = { Hot: 1, Active: 0.6, Backfill: 0.2 }[window] ?? 0;
  return Math.round(weights.postingFreshness * multiplier);
}

function experiencePoints(eligibility, weights) {
  const experience = eligibility?.experience;
  if (!experience?.pass || experience.manualReview) return 0;
  return experience.strict ? weights.experienceEligibility : Math.round(weights.experienceEligibility / 2);
}

function geographyPoints(eligibility, weights) {
  return eligibility?.geo?.pass ? weights.indiaLocationEligibility : 0;
}

/**
 * Scores conversion potential from explicit, auditable inputs. It never
 * changes Apply? and never treats an unresolved or unverified lead as ready.
 */
export function scoreConversion(candidate, { freshnessWindow = null, eligibility = null, policy = {} } = {}) {
  const weights = weightSet(policy);
  const bands = bandSet(policy);
  const matchScore = Number.isFinite(candidate.matchScore) ? candidate.matchScore : 0;
  const signals = candidate.conversionSignals || {};
  const originalResolved = Boolean(candidate.originalApplicationUrl)
    && /^(Direct ATS|Resolved Original)$/.test(candidate.applicationResolution?.status || '');
  const live = candidate.liveness?.status === 'Active';
  const applicationReady = originalResolved && live;
  const responsibilitySignal = Number.isFinite(Number(signals.responsibilitiesAndStack))
    ? Number(signals.responsibilitiesAndStack)
    : matchScore;
  const factors = {
    responsibilitiesAndStack: Math.round(weights.responsibilitiesAndStack * bounded(responsibilitySignal, 0, 100) / 100),
    experienceEligibility: experiencePoints(eligibility, weights),
    indiaLocationEligibility: geographyPoints(eligibility, weights),
    projectConnection: signals.projectConnection === true ? weights.projectConnection : 0,
    directOrVcSource: directOrVcPoints(candidate.sourceCategory, weights),
    humanContact: signals.humanContact === true ? weights.humanContact : 0,
    postingFreshness: freshnessPoints(freshnessWindow, weights),
  };
  const score = Object.values(factors).reduce((total, value) => total + value, 0);
  const boundedScore = bounded(score, 0, 100);
  return {
    score: boundedScore,
    tier: conversionTier(boundedScore, bands),
    factors,
    applicationReady,
    applicationReadiness: applicationReady ? 'Ready' : originalResolved ? 'Liveness Unverified' : 'Original Application Unresolved',
  };
}
