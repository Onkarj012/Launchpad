export const FRESHNESS_WINDOWS = Object.freeze({
  HOT: 'Hot',
  ACTIVE: 'Active',
  BACKFILL: 'Backfill',
  VERIFY_QUEUE: 'VerifyQueue',
  REJECTED: 'Rejected',
});

function parseTimestamp(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function classifyFreshness(candidateOrPostedAt, options = {}) {
  const candidate = candidateOrPostedAt && typeof candidateOrPostedAt === 'object' ? candidateOrPostedAt : null;
  const isWorkday = candidate?.provider?.toLowerCase?.() === 'workday';
  const workdayHasVerifiedDate = candidate?.evidence?.freshness?.kind === 'workday-startDate';
  const postedAt = isWorkday && !workdayHasVerifiedDate
    ? null
    : candidate ? candidate.postedAt : candidateOrPostedAt;
  const nowValue = options.now ?? new Date().toISOString();
  const nowMs = parseTimestamp(nowValue);
  const postedMs = parseTimestamp(postedAt);
  const hotMaximumHours = options.hotMaximumHours ?? 72;
  const activeMaximumDays = options.activeMaximumDays ?? 7;
  const backfillMaximumDays = options.backfillMaximumDays ?? 14;
  if (postedMs == null) {
    return {
      eligible: false,
      window: FRESHNESS_WINDOWS.VERIFY_QUEUE,
      ageHours: null,
      code: 'FRESHNESS_UNDATED_VERIFY_QUEUE',
      evidence: 'Not Verified',
      verifyQueue: true,
    };
  }
  if (nowMs == null) throw new Error('freshness run clock must be a valid timestamp');
  const ageHours = (nowMs - postedMs) / 3_600_000;
  if (ageHours < 0) {
    return { eligible: false, window: null, ageHours, code: 'FRESHNESS_FUTURE_POSTED_AT', evidence: postedAt };
  }
  if (ageHours <= hotMaximumHours) {
    return { eligible: true, window: FRESHNESS_WINDOWS.HOT, ageHours, code: 'FRESHNESS_HOT_0_72H', evidence: postedAt };
  }
  if (ageHours <= activeMaximumDays * 24) {
    return { eligible: true, window: FRESHNESS_WINDOWS.ACTIVE, ageHours, code: 'FRESHNESS_ACTIVE_3_7D', evidence: postedAt };
  }
  if (ageHours <= backfillMaximumDays * 24) {
    return { eligible: true, window: FRESHNESS_WINDOWS.BACKFILL, ageHours, code: 'FRESHNESS_BACKFILL_8_14D', evidence: postedAt, backfill: true };
  }
  return { eligible: false, window: FRESHNESS_WINDOWS.REJECTED, ageHours, code: 'FRESHNESS_OLDER_THAN_14D', evidence: postedAt };
}

export function annotateFreshness(candidate, options = {}) {
  const freshness = classifyFreshness(candidate, options);
  return { ...candidate, freshness };
}
