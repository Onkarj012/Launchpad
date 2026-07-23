import { prepareRecord } from './public-search-prepare.mjs';
import { importPublicSearchCandidates } from './adapters/public-search.mjs';

/**
 * Apify-only preparation seam. The generic public-search preparer intentionally
 * has a small record shape; this wrapper reattaches actor provenance after that
 * validation so it reaches the shared candidate normalizer intact.
 */
export function prepareApifyRecord(raw, now = new Date()) {
  const prepared = prepareRecord(raw, now);
  if (!prepared) return null;
  const record = {
    ...prepared,
    source: raw.source ?? prepared.source,
    sourceKind: raw.sourceKind ?? prepared.sourceKind,
    sourceCategory: raw.sourceCategory ?? null,
    provider: raw.provider ?? null,
    actorId: raw.actorId ?? null,
    actorLabel: raw.actorLabel ?? null,
    profile: raw.profile ?? null,
    discoveryUrl: raw.discoveryUrl ?? prepared.url,
    discoverySource: raw.discoverySource ?? raw.source ?? null,
    discoveryCategory: raw.discoveryCategory ?? raw.sourceCategory ?? null,
  };
  for (const field of [
    'originalApplicationUrl', 'originalApplicationEvidence', 'applicationResolution',
    'discoveredAt', 'crawledAt', 'remoteEligibility', 'salary', 'timezoneOverlap',
    'eor', 'equipment', 'humanContact', 'projectConnection', 'workMode',
    'experience', 'employment', 'eligible',
  ]) {
    if (raw[field] !== undefined) record[field] = raw[field];
  }
  return record;
}

export function prepareApifyRecords(rawRecords, now = new Date()) {
  const kept = [];
  const skipped = [];
  for (const [index, raw] of rawRecords.entries()) {
    const record = prepareApifyRecord(raw, now);
    if (!record) {
      skipped.push({ index, reason: 'record must be an object' });
      continue;
    }
    try {
      importPublicSearchCandidates([record]);
      kept.push(record);
    } catch (error) {
      skipped.push({ index, reason: error.message });
    }
  }
  return { kept, skipped };
}
