import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHistoricalSuppressionIndex,
  filterHistoricalCandidates,
  suppressHistoricalCandidate,
} from '../../crawler/historical-suppression.mjs';

const historical = [
  {
    provider: 'Greenhouse',
    provider_job_id: 'GH-42',
    canonical_url: 'https://jobs.example.test/acme/42?utm_source=old',
    company: 'Acme  Inc.',
    title: 'AI Engineer',
    location: 'Pune, India',
    state: 'applied',
  },
];

test('builds normalized immutable identity input without changing v4 rows', () => {
  const before = structuredClone(historical);
  const index = buildHistoricalSuppressionIndex(historical);

  assert.deepEqual(historical, before);
  assert.equal(index.keys.provider_job_id['greenhouse|gh 42'].length, 1);
  assert.equal(index.keys.canonical_url['https://jobs.example.test/acme/42'].length, 1);
  assert.equal(index.keys.company_title_location['acme inc|ai engineer|pune india'].length, 1);
  assert.equal(index.immutable, true);
  assert.equal(index.v4Writes, false);
});

test('returns suppression evidence for provider, URL, and shape matches', () => {
  const index = buildHistoricalSuppressionIndex(historical);
  const result = suppressHistoricalCandidate({
    provider: 'greenhouse',
    providerJobId: 'gh-42',
    url: 'https://jobs.example.test/acme/42',
    company: 'Acme Inc',
    title: 'AI Engineer',
    location: 'Pune India',
  }, index);

  assert.equal(result.suppressed, true);
  assert.equal(result.code, 'SUPPRESSED_HISTORICAL');
  assert.deepEqual(result.evidence.matchTypes, [
    'provider_job_id', 'canonical_url', 'company_title_location',
  ]);
  assert.equal(result.evidence.historicalRowIndex, 0);
  assert.equal(result.evidence.immutable, true);
  assert.equal(result.evidence.v4Writes, false);
});

test('does not suppress a candidate with no historical identity match', () => {
  const result = suppressHistoricalCandidate({
    provider: 'lever', providerJobId: 'new-1', url: 'https://jobs.example.test/new',
    company: 'New Co', title: 'Backend Engineer', location: 'Pune',
  }, buildHistoricalSuppressionIndex(historical));

  assert.equal(result.suppressed, false);
  assert.equal(result.code, 'NO_HISTORICAL_MATCH');
  assert.equal(result.evidence, null);
});

test('fails closed when a historical key collides', () => {
  const index = buildHistoricalSuppressionIndex([
    { provider: 'lever', providerJobId: 'same', company: 'One', title: 'Engineer', location: 'Pune' },
    { provider: 'lever', providerJobId: 'same', company: 'Two', title: 'Engineer', location: 'Pune' },
  ]);
  const result = suppressHistoricalCandidate({ provider: 'lever', providerJobId: 'same' }, index);

  assert.equal(result.suppressed, false);
  assert.equal(result.code, 'AMBIGUOUS_COLLISION');
  assert.deepEqual(result.evidence.ambiguous[0].rowIndexes, [0, 1]);
});

test('fails closed when different unique keys point to different historical rows', () => {
  const index = buildHistoricalSuppressionIndex([
    { provider: 'greenhouse', providerJobId: 'one', url: 'https://jobs.example.test/one', company: 'Acme', title: 'Engineer', location: 'Pune' },
    { provider: 'greenhouse', providerJobId: 'two', url: 'https://jobs.example.test/two', company: 'Beta', title: 'Engineer', location: 'Pune' },
  ]);
  const result = suppressHistoricalCandidate({
    provider: 'greenhouse', providerJobId: 'one', url: 'https://jobs.example.test/two',
    company: 'Acme', title: 'Engineer', location: 'Pune',
  }, index);

  assert.equal(result.suppressed, false);
  assert.equal(result.code, 'AMBIGUOUS_COLLISION');
});

test('filterHistoricalCandidates routes ambiguous matches to verification, not suppress or keep', () => {
  const candidate = {
    provider: 'lever',
    providerJobId: 'same',
    company: 'Ambiguous Co',
    title: 'AI Engineer',
    location: 'Pune',
    canonicalUrl: 'https://jobs.example.test/ambiguous',
  };
  const result = filterHistoricalCandidates([candidate], [
    { provider: 'lever', providerJobId: 'same', company: 'One', title: 'Engineer', location: 'Pune', state: 'applied' },
    { provider: 'lever', providerJobId: 'same', company: 'Two', title: 'Engineer', location: 'Pune', state: 'rejected' },
  ]);

  assert.equal(result.kept.length, 0);
  assert.equal(result.suppressed.length, 0);
  assert.equal(result.ambiguous.length, 1);
  assert.equal(result.ambiguous[0].code, 'AMBIGUOUS_COLLISION');
  assert.equal(result.ambiguous[0].candidate, candidate);
});
