import {
  candidateDedupKey,
  normalizeCandidate,
} from '../job-pull/candidate.mjs';

export const CONNECTOR_INBOX_SCHEMA_VERSION = 'LaunchpadConnectorInboxV1';
export const CONNECTOR_PROVIDERS = Object.freeze(['indeed', 'apna', 'whatjobs']);

const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function quarantineEntry(index, errors, record = null) {
  return { index, errors, record };
}

function validateEnvelope(envelope) {
  const errors = [];
  if (!isObject(envelope)) return ['envelope must be an object'];
  if (envelope.schemaVersion !== CONNECTOR_INBOX_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CONNECTOR_INBOX_SCHEMA_VERSION}`);
  }
  const provider = clean(envelope.provider)?.toLowerCase();
  if (!CONNECTOR_PROVIDERS.includes(provider)) {
    errors.push(`provider must be one of: ${CONNECTOR_PROVIDERS.join(', ')}`);
  }
  if (!Array.isArray(envelope.records)) errors.push('records must be an array');
  return errors;
}

function validateRecord(record) {
  const errors = [];
  if (!isObject(record)) return ['record must be an object'];
  const providerJobId = clean(record.providerJobId ?? record.provider_job_id ?? record.jobId);
  const url = clean(record.url ?? record.canonicalUrl);
  if (!providerJobId && !url) errors.push('providerJobId or url is required');
  if (!clean(record.title ?? record.role)) errors.push('title is required');
  if (!clean(record.company ?? record.companyName)) errors.push('company is required');
  if (!url) errors.push('url is required by CandidateV1');
  if (!Object.hasOwn(record, 'postedAt')) errors.push('postedAt is required (use null when unknown)');
  if (record.postedAt != null && !clean(String(record.postedAt))) errors.push('postedAt must be an ISO timestamp or null');
  return errors;
}

function identityKeys(candidate, provider, providerJobId) {
  const keys = [];
  if (providerJobId) keys.push(`provider-job:${provider}:${providerJobId}`);
  if (candidate.canonicalUrl) keys.push(`url:${candidate.canonicalUrl}`);
  // Provider IDs and canonical URLs are authoritative. The shape fallback
  // must retain material posting evidence so distinct connector rows that
  // lack either primary identity do not collapse merely because their title,
  // company, and location match.
  keys.push(`candidate:${candidateDedupKey(candidate)}|postedAt:${candidate.postedAt ?? 'unknown'}`);
  return keys;
}

function manifest(provider, runAt, counts) {
  return {
    schemaVersion: 'LaunchpadConnectorInboxManifestV1',
    inboxSchemaVersion: CONNECTOR_INBOX_SCHEMA_VERSION,
    provider,
    runAt,
    noAutoApply: true,
    networkUsed: false,
    ...counts,
  };
}

/**
 * Normalize an already-collected connector envelope. This function deliberately
 * performs no filesystem, network, policy-gate, or external-write operation.
 */
export function normalizeConnectorEnvelope(envelope, { runAt = new Date().toISOString() } = {}) {
  const observations = [];
  const quarantine = [];
  const envelopeErrors = validateEnvelope(envelope);
  if (envelopeErrors.length) {
    quarantine.push(quarantineEntry(null, envelopeErrors, envelope));
    return {
      observations,
      quarantine,
      manifest: manifest(clean(envelope?.provider)?.toLowerCase() ?? null, runAt, {
        received: 0,
        imported: 0,
        quarantined: quarantine.length,
        duplicates: 0,
      }),
    };
  }

  const provider = envelope.provider.trim().toLowerCase();
  const seen = new Set();
  let duplicates = 0;

  for (const [index, record] of envelope.records.entries()) {
    const errors = validateRecord(record);
    if (errors.length) {
      quarantine.push(quarantineEntry(index, errors, record));
      continue;
    }

    const providerJobId = clean(record.providerJobId ?? record.provider_job_id ?? record.jobId);
    try {
      const candidate = normalizeCandidate({
        ...record,
        provider,
        source: record.source ?? `connector:${provider}`,
        jobId: providerJobId,
        sourceKind: 'aggregator',
        sourceCategory: 'aggregator',
        discoveredAt: record.discoveredAt ?? runAt,
        crawledAt: record.crawledAt ?? runAt,
        evidence: {
          ...(isObject(record.evidence) ? record.evidence : {}),
          classification: 'lead',
          connector: provider,
          connectorSchemaVersion: CONNECTOR_INBOX_SCHEMA_VERSION,
        },
      }, { runAt, provider, sourceKind: 'aggregator', sourceCategory: 'aggregator' });
      const keys = identityKeys(candidate, provider, providerJobId);
      if (keys.some((key) => seen.has(key))) {
        duplicates += 1;
        quarantine.push(quarantineEntry(index, ['duplicate connector observation'], record));
        continue;
      }
      keys.forEach((key) => seen.add(key));

      observations.push({
        ...candidate,
        providerJobId,
        classification: 'lead',
        raw: record,
        provenance: {
          ...(isObject(envelope.provenance) ? envelope.provenance : {}),
          ...(isObject(record.provenance) ? record.provenance : {}),
          provider,
          connectorSchemaVersion: CONNECTOR_INBOX_SCHEMA_VERSION,
        },
        internship: record.internship ?? null,
        stipend: record.stipend ?? null,
      });
    } catch (error) {
      quarantine.push(quarantineEntry(index, [error.message], record));
    }
  }

  return {
    observations,
    quarantine,
    manifest: manifest(provider, runAt, {
      received: envelope.records.length,
      imported: observations.length,
      quarantined: quarantine.length,
      duplicates,
    }),
  };
}

export default normalizeConnectorEnvelope;
