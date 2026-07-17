import { recordsFromResult, finalizeManifest, normalizeSourceRecords, readJsonInput, sourceManifest } from './common.mjs';

export function importPublicSearchCandidates(input, { runAt = new Date().toISOString(), sourceKind = 'niche-public', source = 'public-search' } = {}) {
  const result = readJsonInput(input, 'public-search');
  const records = recordsFromResult('public-search', result);
  const candidates = normalizeSourceRecords(records, { source, sourceKind, runAt, currentFeedIsLive: false });
  return { candidates, manifest: finalizeManifest(sourceManifest('public-search', 'public-search'), candidates) };
}
