import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { deduplicateCandidates } from '../../job-pull/dedup.mjs';

function candidate(overrides = {}) {
  return normalizeCandidate({
    url: 'https://jobs.example.test/role/1?utm_source=mail', source: 'aggregator', sourceKind: 'aggregator', provider: 'board', id: '1',
    company: 'Example Co', title: 'Backend Engineer', location: 'Pune', postedAt: '2026-07-14T08:00:00.000Z',
    description: 'Build reliable Python backend services, APIs, data pipelines, and production systems with a collaborative engineering team. Work with product, design, and platform engineers to ship observable services, improve reliability, review code, document decisions, and operate production workloads for customers across India and global markets.',
    employment: { type: 'full-time' }, liveness: { status: 'Active' }, ...overrides,
  });
}

test('ATS-direct wins canonical URL and provider/job-id collisions', () => {
  const aggregator = candidate({ source: 'Indeed', sourceKind: 'aggregator', provider: 'indeed' });
  const direct = candidate({ source: 'greenhouse-api', sourceKind: 'ats-direct', provider: 'greenhouse' });
  const result = deduplicateCandidates([aggregator, direct]);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].provider, 'greenhouse');
  assert.equal(result.duplicates[0].code, 'DEDUP_CANONICAL_URL');
});

test('company/title/location, ledger, and description SimHash are dedup keys', () => {
  const first = candidate({ url: 'https://one.example.test/1', provider: 'one', id: 'one' });
  const sameKey = candidate({ url: 'https://two.example.test/2', provider: 'two', id: 'two', description: null });
  const ledgerMatch = candidate({ url: 'https://three.example.test/3', company: 'Ledger Co', title: 'ML Engineer', location: 'Remote India' });
  const simhash = candidate({ url: 'https://zzz.example.test/4', company: 'Different Co', title: 'Different Role', location: 'Remote India', description: first.description });
  const result = deduplicateCandidates([first, sameKey, ledgerMatch, simhash], {
    ledgerRows: [{ dedup_key: 'ledger co|ml engineer|remote india', state: 'committed' }],
    simHashSimilarity: 0.93,
  });
  assert.equal(result.kept.length, 1);
  assert.equal(result.duplicates.some((item) => item.code === 'DEDUP_COMPANY_TITLE_LOCATION'), true);
  assert.equal(result.duplicates.some((item) => item.code === 'DEDUP_EXISTING_LEDGER'), true);
  assert.equal(result.duplicates.some((item) => item.code === 'DEDUP_SIMHASH'), true);
  assert.equal(result.fingerprintCoverage.fingerprinted, 3);
});
