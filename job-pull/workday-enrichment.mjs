import { makeHttpCtx } from '../career-ops/providers/_http.mjs';
import { fetchWorkdayJobDetail } from '../career-ops/providers/workday.mjs';
import { preselectWorkdayListRow } from '../crawler/ats-enterprise.mjs';
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

// Board identity for budget sharing: explicit key when present, else host plus
// first path segment of the posting URL (e.g. acme.wd1.myworkdayjobs.com/Careers).
function boardKeyOf(candidate) {
  const explicit = candidate.boardKey ?? candidate.board ?? candidate.source;
  if (explicit) return explicit;
  try {
    const parsed = new URL(candidate.canonicalUrl ?? candidate.url);
    const [firstSegment] = parsed.pathname.split('/').filter(Boolean);
    return firstSegment ? `${parsed.host}/${firstSegment}` : parsed.host;
  } catch {
    return null;
  }
}

/** Enrich Workday candidates in place with verified start dates and JD text. */
export async function enrichWorkdayCandidates(
  candidates,
  { now = Date.now(), ctx = makeHttpCtx(), concurrency = 4, cache = new Map(), maxRequests = 50 } = {},
) {
  if (!Array.isArray(candidates)) return candidates;
  const workdayCandidates = candidates.filter((candidate) => candidate?.provider === 'workday');
  const limit = Number.isInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 4) : 4;
  const httpCtx = ctx ?? makeHttpCtx();
  const budget = Math.max(0, Number.isFinite(Number(maxRequests)) ? Number(maxRequests) : 50);
  const boardGroupsByPriority = new Map();
  workdayCandidates.forEach((candidate, index) => {
    if (typeof candidate.description === 'string' && candidate.description.trim()) return;
    const selection = preselectWorkdayListRow(candidate);
    if (!selection.selected) {
      candidate.evidence = { ...candidate.evidence, detailHydration: { status: 'skipped', reason: selection.reason } };
      return;
    }

    if (!boardGroupsByPriority.has(selection.priority)) boardGroupsByPriority.set(selection.priority, new Map());
    const boardGroups = boardGroupsByPriority.get(selection.priority);
    const key = boardKeyOf(candidate);
    if (!boardGroups.has(key)) boardGroups.set(key, []);
    boardGroups.get(key).push({ candidate, index });
  });

  const ordered = [];
  for (const priority of [...boardGroupsByPriority.keys()].sort((a, b) => a - b)) {
    const boardGroups = boardGroupsByPriority.get(priority);
    const groups = [...boardGroups.values()];
    const maxGroupLength = Math.max(0, ...groups.map((group) => group.length));
    for (let round = 0; round < maxGroupLength; round++) {
      for (const group of groups) {
        if (round < group.length) {
          ordered.push(group[round].candidate);
        }
      }
    }
  }
  const selected = ordered.slice(0, budget);
  for (const candidate of ordered.slice(budget)) {
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
    } catch (err) {
      candidate.evidence = { ...candidate.evidence, detailHydration: { status: 'failed', reason: err?.constructor?.name ?? 'Error' } };
      return;
    }

    if (detail?.jobDescription) {
      candidate.description = stripHtmlToText(detail.jobDescription);
      const experience = extractExperienceYears(candidate.description);
      if (experience) candidate.experience = experience;
    }

    const parsedStartDate = detail?.startDate == null ? NaN : Date.parse(detail.startDate);
    const nowMs = Number(now);
    const hasUsableStartDate = Boolean(detail?.startDate && !Number.isNaN(parsedStartDate)
      && (Number.isNaN(nowMs) || parsedStartDate <= nowMs));
    if (hasUsableStartDate) {
      candidate.postedAt = new Date(parsedStartDate).toISOString();
      candidate.evidence = {
        ...candidate.evidence,
        freshness: { kind: 'workday-startDate', detailUrl: detail.detailUrl },
      };
      return;
    }
    candidate.evidence = { ...candidate.evidence, detailHydration: { status: 'succeeded', freshnessContribution: 'none' } };
  });

  return candidates;
}
