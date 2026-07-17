export const FRESHNESS_WINDOWS = Object.freeze({ PRIMARY: 'Primary', EXTENDED: 'Extended', UNDATED: 'undated' });

function parseTimestamp(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function classifyFreshness(candidateOrPostedAt, options = {}) {
  const postedAt = typeof candidateOrPostedAt === 'object' ? candidateOrPostedAt?.postedAt : candidateOrPostedAt;
  const nowValue = options.now ?? new Date().toISOString();
  const nowMs = parseTimestamp(nowValue);
  const postedMs = parseTimestamp(postedAt);
  const primaryMaximumHours = options.primaryMaximumHours ?? options.primaryMaxHours ?? 24;
  const extendedMaximumHours = options.extendedMaximumHours ?? options.extendedMaxHours ?? 72;
  if (postedMs == null) {
    return { eligible: true, window: FRESHNESS_WINDOWS.UNDATED, ageHours: null, code: 'FRESHNESS_UNDATED_KEPT', evidence: 'Not Verified' };
  }
  if (nowMs == null) throw new Error('freshness run clock must be a valid timestamp');
  const ageHours = (nowMs - postedMs) / 3_600_000;
  if (ageHours < 0) {
    return { eligible: false, window: null, ageHours, code: 'FRESHNESS_FUTURE_POSTED_AT', evidence: postedAt };
  }
  if (ageHours <= primaryMaximumHours) {
    return { eligible: true, window: FRESHNESS_WINDOWS.PRIMARY, ageHours, code: 'FRESHNESS_PRIMARY_0_24H', evidence: postedAt };
  }
  if (ageHours <= extendedMaximumHours) {
    return { eligible: true, window: FRESHNESS_WINDOWS.EXTENDED, ageHours, code: 'FRESHNESS_EXTENDED_24_72H', evidence: postedAt };
  }
  return { eligible: false, window: null, ageHours, code: 'FRESHNESS_OLDER_THAN_72H', evidence: postedAt };
}

export function annotateFreshness(candidate, options = {}) {
  const freshness = classifyFreshness(candidate, options);
  return { ...candidate, freshness };
}
