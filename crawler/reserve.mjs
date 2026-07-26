const DEFAULTS = Object.freeze({ minimum: 10, preferred: 12, maximum: 15, reachMaximum: 2 });
const FRESH_TIERS = Object.freeze(['strict-0-24h', 'strict-24-72h', 'strict-3-7d', 'paid-internship-or-fresher', 'controlled-reach', 'backfill-7-14d']);

const candidateOf = (entry) => entry?.candidate || entry || {};
const factsOf = (entry, name, resolver) => {
  if (typeof resolver === 'function') return resolver(candidateOf(entry), entry) || {};
  if (resolver instanceof Map) return resolver.get(candidateOf(entry).canonicalUrl) || {};
  return entry?.[name] || candidateOf(entry)?.[name] || {};
};

function ageOf(entry, freshness) {
  const value = freshness.ageHours ?? freshness.age ?? entry.ageHours ?? candidateOf(entry).ageHours;
  const age = Number(value);
  return Number.isFinite(age) && age >= 0 ? age : null;
}

function freshnessTier(entry, eligibility, freshness) {
  const age = ageOf(entry, freshness);
  if (age == null || freshness.eligible === false || freshness.valid === false) return null;
  const internship = candidateOf(entry).employment?.type === 'internship'
    || eligibility.roleFamily === 'paid-internship'
    || eligibility.internship === true;
  const fresher = eligibility.fresher === true || candidateOf(entry).isFresher === true;
  const reach = eligibility.reach === true;
  if (age <= 24 && eligibility.strict === true && !internship && !fresher && !reach) return 'strict-0-24h';
  if (age <= 72 && eligibility.strict === true && !internship && !fresher && !reach) return 'strict-24-72h';
  if (age <= 168 && eligibility.strict === true && !internship && !fresher && !reach) return 'strict-3-7d';
  if (age <= 168 && (internship || fresher)) return 'paid-internship-or-fresher';
  if (age <= 168 && reach) return 'controlled-reach';
  if (age <= 336 && (freshness.backfill === true || freshness.window === 'Backfill')) return 'backfill-7-14d';
  return null;
}

function fitCompare(left, right) {
  const a = left.candidate;
  const b = right.candidate;
  for (const field of ['matchScore', 'conversionScore', 'responseLikelihood']) {
    const difference = Number(b[field] ?? 0) - Number(a[field] ?? 0);
    if (difference) return difference;
  }
  const posted = String(b.postedAt || '').localeCompare(String(a.postedAt || ''));
  if (posted) return posted;
  return String(a.canonicalUrl || '').localeCompare(String(b.canonicalUrl || '')) || left.index - right.index;
}

function rejection(result, key) { result.excluded[key] = (result.excluded[key] || 0) + 1; }

/**
 * Selects a pure, durable-ready daily pool from already-normalized v5 entries.
 * Identity/novelty and eligibility are facts supplied by upstream policy; this
 * module only consumes them and never resolves, rescues, or mutates candidates.
 */
export function selectDailyReserve(entries = [], options = {}) {
  const limits = { ...DEFAULTS, ...options };
  const result = { excluded: {}, rescue: { suggested: false, invoked: false } };
  const seen = new Set();
  const admissible = [];

  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const candidate = candidateOf(entry);
    const identity = factsOf(entry, 'identity', options.identity);
    const novelty = factsOf(entry, 'novelty', options.novelty);
    const eligibility = factsOf(entry, 'eligibility', options.eligibility);
    const freshness = factsOf(entry, 'freshness', options.freshness);
    const key = candidate.canonicalUrl || candidate.url || `${candidate.company || ''}|${candidate.title || ''}|${candidate.location || ''}`;
    if (!key || seen.has(key)) { rejection(result, 'duplicate'); continue; }
    seen.add(key);
    if (novelty.newToMe !== true && identity.novelty !== 'new_to_me' && identity.newToMe !== true
      && identity.code !== 'NEWLY_ACTIONABLE' && novelty.code !== 'NEWLY_ACTIONABLE') {
      rejection(result, 'notNewToMe');
      continue;
    }
    if (eligibility.eligible !== true) { rejection(result, eligibility.reasonCode || 'ineligible'); continue; }
    if (candidate.applicationReady === false || ['Unresolved', 'Needs Verification'].includes(candidate.applicationResolution?.status)) { rejection(result, 'unresolved'); continue; }
    const tier = freshnessTier(entry, eligibility, freshness);
    if (!tier) {
      rejection(result, ageOf(entry, freshness) == null ? 'undated' : 'stale');
      continue;
    }
    if (eligibility.reach === true && (eligibility.reachMinimumYears ?? eligibility.experience?.minYears) > 2) { rejection(result, 'reachExperience'); continue; }
    if ((candidate.employment?.type === 'internship' || eligibility.roleFamily === 'paid-internship') && candidate.employment?.paid === false) { rejection(result, 'unpaid'); continue; }
    admissible.push({ entry, candidate, eligibility, freshness, tier, index });
  }

  const reaches = admissible.filter((item) => item.tier === 'controlled-reach').sort(fitCompare);
  const selectedReaches = reaches.slice(0, limits.reachMaximum);
  for (const item of reaches.slice(limits.reachMaximum)) rejection(result, 'reachCap');
  const eligible = admissible.filter((item) => item.tier !== 'controlled-reach' || selectedReaches.includes(item));
  const strict = FRESH_TIERS.filter((tier) => tier.startsWith('strict-'))
    .flatMap((tier) => eligible.filter((item) => item.tier === tier).sort(fitCompare));
  const internships = eligible.filter((item) => item.tier === 'paid-internship-or-fresher').sort(fitCompare);
  const backfill = eligible.filter((item) => item.tier === 'backfill-7-14d').sort(fitCompare);
  // Backfill is allowed only while the strict seven-day goal is still unmet.
  const reserveLimit = Math.max(0, limits.maximum);
  const strictPreferredMax = Math.max(0, Number(options.strictPreferredMax ?? 8));
  const internshipPreferredMax = Math.max(0, Number(options.internshipPreferredMax ?? 3));
  const initialStrict = strict.slice(0, strictPreferredMax);
  const initialInternships = internships.slice(0, internshipPreferredMax);
  const preferredFresh = [...initialStrict, ...initialInternships, ...selectedReaches];
  const preferredSet = new Set(preferredFresh);
  const remainingFresh = [...strict, ...internships].filter((item) => !preferredSet.has(item));
  const pool = [...preferredFresh, ...remainingFresh].slice(0, reserveLimit);
  const freshCount = pool.length;
  if (freshCount < limits.minimum) pool.push(...backfill.slice(0, reserveLimit - pool.length));
  const reserve = pool.slice(0, reserveLimit).map((item) => ({
    ...item.candidate,
    ...item.entry,
    candidate: item.candidate,
    freshnessTier: item.tier,
    selectionTier: item.tier.startsWith('strict-') ? 'Strict' : item.tier === 'backfill-7-14d' ? 'Backfill' : 'Reserve',
    newToMe: true,
  }));
  const shortlist = reserve.slice(0, limits.minimum);
  const reserveQueue = reserve.slice(limits.minimum);
  const reserveFreshCount = reserve.filter((item) => item.freshnessTier !== 'backfill-7-14d').length;
  const composition = {
    strictFullTime: reserve.filter((item) => item.freshnessTier.startsWith('strict-')).length,
    paidInternshipOrFresher: reserve.filter((item) => item.freshnessTier === 'paid-internship-or-fresher').length,
    controlledReaches: reserve.filter((item) => item.freshnessTier === 'controlled-reach').length,
  };
  const counts = {
    minimum: limits.minimum, preferred: limits.preferred, maximum: limits.maximum,
    reserve: reserve.length, shortlist: shortlist.length, reserveQueue: reserveQueue.length,
    newToMeWithin7Days: reserveFreshCount, backfill: reserve.filter((item) => item.freshnessTier === 'backfill-7-14d').length,
  };
  return {
    schemaVersion: 'LaunchpadV5DailyReserveV1', reserve, shortlist, selected: shortlist,
    reserveQueue, replacementOrder: reserveQueue, composition, counts,
    shortfall: {
      minimumMissing: Math.max(0, limits.minimum - reserveFreshCount),
      reservePreferredMissing: Math.max(0, limits.preferred - reserve.length),
      reasons: [
        ...(reserveFreshCount < limits.minimum ? ['MINIMUM_NEW_TO_ME_7D_SHORTFALL'] : []),
        ...(reserve.length < limits.preferred ? ['PREFERRED_RESERVE_SHORTFALL'] : []),
      ],
      autoRescue: false,
    },
    excluded: result.excluded,
    rescue: result.rescue,
  };
}

export const buildDailyReserve = selectDailyReserve;
export const selectReserve = selectDailyReserve;
