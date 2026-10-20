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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
    && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const [, yearText, monthText, dayText] = /^(\d{4})-(\d{2})-(\d{2})/.exec(value) || [];
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function classifyFreshness(candidateOrPostedAt, options = {}) {
  const candidate = candidateOrPostedAt && typeof candidateOrPostedAt === 'object' ? candidateOrPostedAt : null;
  const isWorkday = candidate?.provider?.toLowerCase?.() === 'workday';
  const isPersonio = candidate?.provider?.toLowerCase?.() === 'personio';
  const workdayHasVerifiedDate = candidate?.evidence?.freshness?.kind === 'workday-startDate';
  const resolverDateEvidence = candidate?.evidence?.resolver && candidate?.evidence?.dateEvidence;
  const candidateDateEvidence = resolverDateEvidence || candidate?.dateEvidence;
  const hasOriginalResolverEvidence = candidateDateEvidence && Object.hasOwn(candidateDateEvidence, 'originalPublication');
  const rawPostedAt = candidate
    ? hasOriginalResolverEvidence ? candidateDateEvidence.originalPublication?.value ?? null : candidate.postedAt
    : candidateOrPostedAt;
  const workdayUncorroborated = Boolean(isWorkday && !workdayHasVerifiedDate && rawPostedAt != null);
  const personioUncorroborated = Boolean(isPersonio && candidate?.evidence?.dateConfidence === 'provider-unverified' && rawPostedAt != null);
  const postedAt = (isWorkday && !workdayHasVerifiedDate) || personioUncorroborated
    ? null
    : rawPostedAt;
  const nowValue = options.now ?? new Date().toISOString();
  const nowMs = parseTimestamp(nowValue);
  const postedMs = parseTimestamp(postedAt);
  const hotMaximumHours = options.hotMaximumHours ?? 72;
  const activeMaximumDays = options.activeMaximumDays ?? 7;
  const backfillMaximumDays = options.backfillMaximumDays ?? 14;
  if (postedMs == null) {
    const firstSeenMs = parseTimestamp(candidate?.firstSeenAt);
    if (firstSeenMs != null) {
      if (nowMs == null) throw new Error('freshness run clock must be a valid timestamp');
      const ageHours = (nowMs - firstSeenMs) / 3_600_000;
      if (ageHours > backfillMaximumDays * 24) return { eligible: false, window: FRESHNESS_WINDOWS.REJECTED, ageHours, code: 'FRESHNESS_OLDER_THAN_14D', evidence: candidate.firstSeenAt, ageSource: 'first-seen' };
    }
    return {
      eligible: false,
      window: FRESHNESS_WINDOWS.VERIFY_QUEUE,
      ageHours: null,
      code: workdayUncorroborated
        ? 'FRESHNESS_WORKDAY_UNCORROBORATED_VERIFY_QUEUE'
        : personioUncorroborated
          ? 'FRESHNESS_PERSONIO_UNCORROBORATED_VERIFY_QUEUE'
        : 'FRESHNESS_UNDATED_VERIFY_QUEUE',
      evidence: workdayUncorroborated ? 'workday-postedOn-uncorroborated' : personioUncorroborated ? 'personio-provider-date-uncorroborated' : 'Not Verified',
      verifyQueue: true,
      workdayUncorroborated,
      personioUncorroborated,
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
