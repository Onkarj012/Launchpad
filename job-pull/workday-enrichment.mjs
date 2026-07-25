import { makeHttpCtx } from '../career-ops/providers/_http.mjs';
import { fetchWorkdayJobDetail } from '../career-ops/providers/workday.mjs';
import { WORKDAY_DEFAULT_LOCATION_KEYWORDS } from '../crawler/ats-enterprise.mjs';
import { canonicalizeUrl, extractExperienceYears, stripHtmlToText } from './candidate.mjs';

async function parallelEach(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

function markUnverified(candidate) {
  candidate.postedAt = null;
  candidate.evidence = {
    ...candidate.evidence,
    freshness: { kind: 'workday-unverified' },
  };
  candidate.liveness = { status: 'Not Verified', checkedAt: null, evidence: null };
}

/** Enrich Workday candidates in place with verified start dates and JD text. */
export async function enrichWorkdayCandidates(
  candidates,
  { now = Date.now(), ctx = makeHttpCtx(), concurrency = 4, cache = new Map(), maxRequests = 50 } = {},
) {
  void now;
  if (!Array.isArray(candidates)) return candidates;
  const workdayCandidates = candidates.filter((candidate) => candidate?.provider === 'workday');
  const limit = Number.isInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 4) : 4;
  const httpCtx = ctx ?? makeHttpCtx();
  const budget = Math.max(0, Number.isFinite(Number(maxRequests)) ? Number(maxRequests) : 50);
  const ordered = workdayCandidates
    .map((candidate, index) => ({ candidate, index, indiaLocated: WORKDAY_DEFAULT_LOCATION_KEYWORDS.some((keyword) => String(candidate.location ?? '').toLowerCase().includes(keyword)) }))
    .sort((a, b) => Number(b.indiaLocated) - Number(a.indiaLocated) || a.index - b.index)
    .map(({ candidate }) => candidate);
  const selected = ordered.slice(0, budget);
  for (const candidate of ordered.slice(budget)) {
    markUnverified(candidate);
    candidate.evidence = { ...candidate.evidence, detailHydration: { status: 'skipped', reason: 'budget-exhausted' } };
  }

  await parallelEach(selected, limit, async (candidate) => {
    const key = canonicalizeUrl(candidate.canonicalUrl ?? candidate.url) ?? candidate.url;
    let detailPromise = cache.get(key);
    if (!detailPromise) {
      detailPromise = fetchWorkdayJobDetail(candidate.url ?? candidate.canonicalUrl, httpCtx);
      cache.set(key, detailPromise);
    }

    let detail;
    try {
      detail = await detailPromise;
    } catch {
      markUnverified(candidate);
      return;
    }

    if (detail?.jobDescription) {
      candidate.description = stripHtmlToText(detail.jobDescription);
      const experience = extractExperienceYears(candidate.description);
      if (experience) candidate.experience = experience;
    }

    const parsedStartDate = detail?.startDate == null ? NaN : Date.parse(detail.startDate);
    if (!Number.isNaN(parsedStartDate)) {
      candidate.postedAt = new Date(parsedStartDate).toISOString();
      candidate.evidence = {
        ...candidate.evidence,
        freshness: { kind: 'workday-startDate', detailUrl: detail.detailUrl },
      };
      return;
    }
    markUnverified(candidate);
  });

  return candidates;
}
