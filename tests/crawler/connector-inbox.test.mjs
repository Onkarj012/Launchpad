import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTOR_INBOX_SCHEMA_VERSION,
  normalizeConnectorEnvelope,
} from '../../crawler/connector-inbox.mjs';

const baseRecord = (overrides = {}) => ({
  providerJobId: 'apna-1',
  title: 'AI Engineer',
  company: 'Acme Labs',
  url: 'https://apna.co/job/ai-engineer-1',
  postedAt: '2026-07-24T08:00:00.000Z',
  location: 'Pune, India',
  description: 'Build AI products.',
  ...overrides,
});

const envelope = (records, overrides = {}) => ({
  schemaVersion: CONNECTOR_INBOX_SCHEMA_VERSION,
  provider: 'apna',
  provenance: { exportId: 'fixture-1' },
  records,
  ...overrides,
});

test('normalizes a connector envelope without external access', () => {
  const result = normalizeConnectorEnvelope(envelope([baseRecord({ stipend: { amount: 30000, currency: 'INR' } })]), {
    runAt: '2026-07-24T09:00:00.000Z',
  });

  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].sourceKind, 'aggregator');
  assert.equal(result.observations[0].classification, 'lead');
  assert.equal(result.observations[0].providerJobId, 'apna-1');
  assert.deepEqual(result.observations[0].raw.stipend, { amount: 30000, currency: 'INR' });
  assert.equal(result.observations[0].provenance.exportId, 'fixture-1');
  assert.equal(result.manifest.networkUsed, false);
});

test('quarantines malformed rows while valid siblings survive', () => {
  const result = normalizeConnectorEnvelope(envelope([
    baseRecord(),
    baseRecord({ providerJobId: null, title: '' }),
    baseRecord({ providerJobId: 'apna-2', url: 'https://apna.co/job/ai-engineer-2', postedAt: null }),
  ]));

  assert.equal(result.observations.length, 2);
  assert.equal(result.quarantine.length, 1);
  assert.equal(result.observations[1].postedAt, null);
});

test('deduplicates by durable provider ID or canonical URL while preserving distinct requisitions', () => {
  const first = baseRecord({
    providerJobId: 'apna-1',
    url: 'https://apna.co/job/ai-engineer-1',
  });
  const duplicateByProviderJobId = baseRecord({
    providerJobId: 'apna-1',
    url: 'https://apna.co/job/ai-engineer-1-mirror',
  });
  const duplicateByCanonicalUrl = baseRecord({
    providerJobId: 'apna-4',
    url: first.url,
  });
  const distinctSecondRequisition = baseRecord({
    providerJobId: 'apna-2',
    url: 'https://apna.co/job/ai-engineer-2',
  });
  const distinctThirdRequisition = baseRecord({
    providerJobId: 'apna-3',
    url: 'https://apna.co/job/ai-engineer-3',
  });

  const result = normalizeConnectorEnvelope(envelope([
    first,
    duplicateByProviderJobId,
    duplicateByCanonicalUrl,
    distinctSecondRequisition,
    distinctThirdRequisition,
  ]));

  assert.equal(result.observations.length, 3);
  assert.equal(result.manifest.duplicates, 2);
  assert.deepEqual(result.observations.map(({ providerJobId, canonicalUrl }) => ({ providerJobId, canonicalUrl })), [
    { providerJobId: 'apna-1', canonicalUrl: first.url },
    { providerJobId: 'apna-2', canonicalUrl: distinctSecondRequisition.url },
    { providerJobId: 'apna-3', canonicalUrl: distinctThirdRequisition.url },
  ]);
  assert.deepEqual(result.observations[0].raw, first);
  assert.deepEqual(result.quarantine.map(({ index, record }) => ({ index, record })), [
    { index: 1, record: duplicateByProviderJobId },
    { index: 2, record: duplicateByCanonicalUrl },
  ]);
});

test('rejects invalid envelope schema and provider without throwing', () => {
  const result = normalizeConnectorEnvelope({
    schemaVersion: 'Wrong',
    provider: 'linkedin',
    records: [],
  });

  assert.equal(result.observations.length, 0);
  assert.equal(result.quarantine.length, 1);
  assert.match(result.quarantine[0].errors.join(' '), /schemaVersion/);
  assert.match(result.quarantine[0].errors.join(' '), /provider/);
});

test('normalizes a ziprecruiter connector envelope into observations', () => {
  const result = normalizeConnectorEnvelope(envelope([
    baseRecord({
      providerJobId: 'zr-1',
      url: 'https://www.ziprecruiter.com/jobs/ai-engineer-1',
    }),
  ], { provider: 'ziprecruiter' }), {
    runAt: '2026-07-24T09:00:00.000Z',
  });

  assert.equal(result.observations.length, 1);
  assert.equal(result.quarantine.length, 0);
  assert.equal(result.observations[0].provider, 'ziprecruiter');
  assert.equal(result.observations[0].providerJobId, 'zr-1');
  assert.equal(result.observations[0].sourceKind, 'aggregator');
  assert.equal(result.observations[0].classification, 'lead');
  assert.equal(result.manifest.imported, 1);
});

test('normalizes a dice connector envelope into observations', () => {
  const result = normalizeConnectorEnvelope(envelope([
    baseRecord({
      providerJobId: 'dice-1',
      url: 'https://www.dice.com/job-detail/ai-engineer-1',
    }),
  ], { provider: 'dice' }), {
    runAt: '2026-07-24T09:00:00.000Z',
  });

  assert.equal(result.observations.length, 1);
  assert.equal(result.quarantine.length, 0);
  assert.equal(result.observations[0].provider, 'dice');
  assert.equal(result.observations[0].providerJobId, 'dice-1');
  assert.equal(result.observations[0].sourceKind, 'aggregator');
  assert.equal(result.observations[0].classification, 'lead');
  assert.equal(result.manifest.imported, 1);
});

test('normalizes a jobs-and-careers connector envelope into observations', () => {
  const result = normalizeConnectorEnvelope(envelope([
    baseRecord({
      providerJobId: 'jac-1',
      url: 'https://jobsandcareers.example/job/ai-engineer-1',
    }),
  ], { provider: 'jobs-and-careers' }), {
    runAt: '2026-07-24T09:00:00.000Z',
  });

  assert.equal(result.observations.length, 1);
  assert.equal(result.quarantine.length, 0);
  assert.equal(result.observations[0].provider, 'jobs-and-careers');
  assert.equal(result.observations[0].providerJobId, 'jac-1');
  assert.equal(result.observations[0].sourceKind, 'aggregator');
  assert.equal(result.observations[0].classification, 'lead');
  assert.equal(result.manifest.imported, 1);
});

test('null postedAt normalizes without back-filling run timestamp', () => {
  const runAt = '2026-07-24T09:00:00.000Z';
  const result = normalizeConnectorEnvelope(envelope([
    baseRecord({
      providerJobId: 'apna-null-posted',
      url: 'https://apna.co/job/ai-engineer-null-posted',
      postedAt: null,
    }),
  ]), { runAt });

  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].postedAt, null);
  assert.notEqual(result.observations[0].postedAt, runAt);
  assert.equal(result.observations[0].discoveredAt, runAt);
});
