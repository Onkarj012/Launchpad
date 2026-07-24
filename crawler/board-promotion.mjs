const DEFAULT_MIN_OCCURRENCES = 3;
const DEFAULT_MIN_DISTINCT_DATES = 2;

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
}

function dateOnly(value) {
  const time = value == null ? NaN : Date.parse(String(value));
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

function keyFor(discovery, host) {
  const provider = discovery?.provider ? String(discovery.provider).toLowerCase() : 'unknown';
  return `${provider}:${host}`;
}

/**
 * Fold repeated SearXNG/resolver discoveries of the same employer ATS host
 * into durable counts and, once a host clears the threshold, a proposed
 * board-registry entry. This performs no filesystem or network access and
 * never mutates config/crawler-v2.json; callers decide whether and how to
 * persist the returned state and act on a proposal.
 */
export function buildBoardPromotionProposals(discoveries = [], priorState = {}, options = {}) {
  const minOccurrences = Math.max(1, Number(options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES));
  const minDistinctDates = Math.max(1, Number(options.minDistinctDates ?? DEFAULT_MIN_DISTINCT_DATES));
  const runAt = options.runAt ?? new Date().toISOString();
  const state = JSON.parse(JSON.stringify(priorState ?? {}));
  const proposals = [];

  for (const discovery of discoveries) {
    const host = hostOf(discovery?.url ?? discovery?.canonicalUrl);
    if (!host) continue;
    const key = keyFor(discovery, host);
    const entry = state[key] ||= { host, provider: discovery.provider ?? null, company: discovery.company ?? null, occurrences: 0, dates: [], evidenceUrls: [] };
    entry.occurrences += 1;
    entry.company ||= discovery.company ?? null;
    entry.provider ||= discovery.provider ?? null;
    const day = dateOnly(discovery.discoveredAt ?? runAt);
    if (day && !entry.dates.includes(day)) entry.dates.push(day);
    const url = discovery.url ?? discovery.canonicalUrl;
    if (url && entry.evidenceUrls.length < 5 && !entry.evidenceUrls.includes(url)) entry.evidenceUrls.push(url);
  }

  for (const [key, entry] of Object.entries(state)) {
    if (entry.proposedAt || entry.occurrences < minOccurrences || entry.dates.length < minDistinctDates) continue;
    entry.proposedAt = runAt;
    proposals.push({
      key, host: entry.host, provider: entry.provider, company: entry.company,
      occurrences: entry.occurrences, distinctDates: entry.dates.length, evidenceUrls: entry.evidenceUrls,
      suggestedBoard: { provider: entry.provider, company: entry.company, url: entry.evidenceUrls[0] ?? null, enabled: false, probeStatus: 'proposed' },
      noAutoApply: true,
    });
  }

  return {
    proposals, state,
    manifest: { schemaVersion: 'BoardPromotionManifestV1', runAt, tracked: Object.keys(state).length, proposed: proposals.length, noAutoApply: true },
  };
}

export default buildBoardPromotionProposals;
