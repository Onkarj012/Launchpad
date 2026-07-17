import { recordsFromResult, finalizeManifest, normalizeSourceRecords, readJsonInput, sourceManifest, SourceContractError } from './common.mjs';

export function indeedUnavailable(reason = 'Indeed connector has not supplied records') {
  return {
    candidates: [],
    manifest: sourceManifest('indeed', 'indeed-connector', {
      status: 'unavailable',
      attempted: false,
      reasonCode: 'INDEED_CONNECTOR_UNAVAILABLE',
      errors: [reason],
    }),
  };
}

export function importIndeedCandidates(input, { runAt = new Date().toISOString() } = {}) {
  if (input == null) return indeedUnavailable();
  const result = readJsonInput(input, 'indeed');
  const records = recordsFromResult('indeed', result);
  const candidates = normalizeSourceRecords(records, { source: 'indeed', sourceKind: 'aggregator', runAt, currentFeedIsLive: false });
  return { candidates, manifest: finalizeManifest(sourceManifest('indeed', 'indeed-connector'), candidates) };
}

export function indeedAdapter({ records = null, runAt } = {}) {
  return importIndeedCandidates(records, { runAt });
}
