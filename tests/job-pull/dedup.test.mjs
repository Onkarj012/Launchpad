import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { deduplicateCandidates } from '../../job-pull/dedup.mjs';

const RICH_DESCRIPTION = 'Build reliable Python backend services, APIs, data pipelines, and production systems with a collaborative engineering team. Work with product, design, and platform engineers to ship observable services, improve reliability, review code, document decisions, and operate production workloads for customers across India and global markets.';

function candidate(overrides = {}) {
  return normalizeCandidate({
    url: 'https://jobs.example.test/role/1?utm_source=mail',
    source: 'aggregator',
    sourceKind: 'aggregator',
    provider: 'board',
    id: '1',
    company: 'Example Co',
    title: 'Backend Engineer',
    location: 'Pune',
    postedAt: '2026-07-14T08:00:00.000Z',
    description: RICH_DESCRIPTION,
    employment: { type: 'full-time' },
    liveness: { status: 'Active' },
    ...overrides,
  });
}

test('a thin direct row and rich secondary row merge into one rich candidate', () => {
  const direct = candidate({
    url: 'https://jobs.greenhouse.io/example/jobs/req-1',
    source: 'greenhouse-api',
    sourceKind: 'ats-direct',
    provider: 'greenhouse',
    id: 'req-1',
    description: null,
  });
  const secondary = candidate({
    url: 'https://board.example.test/example-backend',
    source: 'india-niche-board',
    sourceKind: 'niche-public',
    provider: 'board',
    id: 'board-1',
    originalApplicationUrl: direct.canonicalUrl,
    applicationResolution: { status: 'Resolved Original', evidence: 'board links to employer ATS' },
  });
  const result = deduplicateCandidates([secondary, direct]);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].provider, 'greenhouse');
  assert.equal(result.kept[0].description, RICH_DESCRIPTION);
  assert.equal(result.kept[0].jobId, 'req-1');
  assert.equal(result.kept[0].evidence.dedup.facts.description.source, 'india-niche-board');
  assert.equal(result.decisions[0].changedFields.includes('description'), true);
  assert.equal(result.duplicates[0].code, 'DEDUP_COMPANY_TITLE_LOCATION');
});

test('unrelated employers cannot merge from boilerplate SimHash similarity', () => {
  const first = candidate({ url: 'https://one.example.test/1', company: 'First Co', provider: 'one', id: 'one' });
  const unrelated = candidate({ url: 'https://two.example.test/2', company: 'Other Co', provider: 'two', id: 'two' });
  const ledgerMatch = candidate({ url: 'https://three.example.test/3', company: 'Ledger Co', title: 'ML Engineer', location: 'Remote India' });
  const result = deduplicateCandidates([first, unrelated, ledgerMatch], {
    ledgerRows: [{ dedup_key: 'ledger co|ml engineer|remote india', state: 'committed' }],
    simHashSimilarity: 0.93,
  });
  assert.equal(result.kept.length, 2);
  assert.equal(result.duplicates.some((item) => item.code === 'DEDUP_SIMHASH'), false);
  assert.equal(result.duplicates.some((item) => item.code === 'DEDUP_EXISTING_LEDGER'), true);
});

test('requisition identity survives an employer URL and provider job ID change', () => {
  const oldUrl = candidate({
    url: 'https://jobs.greenhouse.io/example/jobs/old-url',
    source: 'greenhouse-api',
    sourceKind: 'ats-direct',
    provider: 'greenhouse',
    id: 'provider-old',
    requisitionId: 'REQ-2026-42',
  });
  const newUrl = candidate({
    url: 'https://job-boards.greenhouse.io/example/jobs/new-url',
    source: 'greenhouse-api',
    sourceKind: 'ats-direct',
    provider: 'greenhouse',
    id: 'provider-new',
    requisitionId: 'REQ-2026-42',
  });
  const result = deduplicateCandidates([oldUrl, newUrl]);
  assert.equal(result.kept.length, 1);
  assert.equal(result.duplicates[0].code, 'DEDUP_REQUISITION_ID');
  assert.equal(result.kept[0].requisitionId, 'REQ-2026-42');
  assert.deepEqual(
    new Set(result.kept[0].identityAliases.map((identity) => identity.jobId)),
    new Set(['provider-old', 'provider-new']),
  );
});
