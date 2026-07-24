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

test('suppresses duplicates deterministically by provider id, URL, and identity', () => {
  const result = normalizeConnectorEnvelope(envelope([
    baseRecord(),
    baseRecord({ providerJobId: 'apna-2', url: 'https://apna.co/job/other' }),
    baseRecord({ providerJobId: 'apna-3', url: 'https://apna.co/job/third', title: 'AI Engineer' }),
  ]));

  assert.equal(result.observations.length, 1);
  assert.equal(result.manifest.duplicates, 2);
  assert.deepEqual(result.observations[0].raw, baseRecord());
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
