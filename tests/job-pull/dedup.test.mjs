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

test('ATS-direct wins provider/job-id collisions', () => {
  const aggregator = candidate({ source: 'aggregator', sourceKind: 'aggregator', provider: 'greenhouse' });
  const direct = candidate({ source: 'greenhouse-api', sourceKind: 'ats-direct', provider: 'greenhouse' });
  const result = deduplicateCandidates([aggregator, direct]);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].provider, 'greenhouse');
  assert.equal(result.duplicates[0].code, 'DEDUP_PROVIDER_JOB_ID');
});

test('distinct durable requisitions never merge through a shared URL', () => {
  const first = candidate({ provider: 'workday', jobId: 'REQ-1' });
  const second = candidate({ provider: 'workday', jobId: 'REQ-2', description: first.description });
  assert.equal(deduplicateCandidates([
    { ...first, canonicalUrl: 'https://jobs.example.test/shared' },
    { ...second, canonicalUrl: 'https://jobs.example.test/shared' },
  ]).kept.length, 2);
});

test('company/title/location is last-resort only; distinct requisitions stay distinct', () => {
  const first = candidate({ url: 'https://one.example.test/1', provider: 'workday', jobId: 'R1' });
  const sameDesk = candidate({ url: 'https://two.example.test/2', provider: 'workday', jobId: 'R2', description: null });
  const unlabeled = candidate({ url: 'https://aaa.example.test/4', provider: null, id: null, jobId: null, description: first.description });
  const unlabeledDup = candidate({ url: 'https://five.example.test/5', provider: null, id: null, jobId: null, description: null });
  const ledgerMatch = candidate({ url: 'https://three.example.test/3', provider: null, id: null, jobId: null, company: 'Ledger Co', title: 'ML Engineer', location: 'Remote India' });
  const simhash = candidate({ url: 'https://zzz.example.test/4', provider: null, id: null, jobId: null, company: 'Different Co', title: 'Different Role', location: 'Remote India', description: first.description });
  const result = deduplicateCandidates([first, sameDesk, unlabeled, unlabeledDup, ledgerMatch, simhash], {
    ledgerRows: [{ dedup_key: 'ledger co|ml engineer|remote india', state: 'committed' }],
    simHashSimilarity: 0.93,
  });
  assert.equal(result.kept.some((item) => item.jobId === 'R1'), true);
  assert.equal(result.kept.some((item) => item.jobId === 'R2'), true);
  assert.equal(result.duplicates.some((item) => item.code === 'DEDUP_COMPANY_TITLE_LOCATION'), true);
  assert.equal(result.duplicates.some((item) => item.code === 'DEDUP_EXISTING_LEDGER'), true);
  assert.equal(result.duplicates.some((item) => item.code === 'DEDUP_SIMHASH'), true);
});

test('old Workday slug keys suppress new requisition IDs without merging distinct IDs', () => {
  for (const [slug, id] of [['Software-Engineer_JR284401', 'JR284401'], ['Software-Engineer_R-12345', 'R-12345'], ['Software-Engineer_REQ1234-1', 'REQ1234']]) {
    const current = candidate({ provider: 'workday', jobId: id });
    for (const row of [
      { dedup_key: `workday|${slug.toLowerCase().replace(/[^a-z0-9]+/g, ' ')}`, state: 'committed' },
      { dedup_key: `workday|${slug}`, provider: 'workday', job_id: slug, state: 'pending' },
    ]) assert.equal(deduplicateCandidates([current], { ledgerRows: [row] }).kept.length, 0, slug);
    assert.equal(deduplicateCandidates([current, candidate({ provider: 'workday', jobId: slug })]).kept.length, 1, slug);
  }
});

test('portal and ATS aliases deduplicate in either order and from persisted ledgers', () => {
  const resolved = candidate({ provider: 'greenhouse', jobId: '123', identityAliases: ['naukri|portal 9'] });
  const portal = candidate({ provider: 'naukri', jobId: 'portal-9' });
  const direct = candidate({ provider: 'greenhouse', jobId: '123' });
  for (const pair of [[resolved, portal], [portal, resolved], [resolved, direct], [direct, resolved, portal]]) assert.equal(deduplicateCandidates(pair).kept.length, 1);
  assert.equal(deduplicateCandidates([portal], { ledgerRows: [{ dedup_key: 'greenhouse|123', identity_aliases: JSON.stringify(resolved.identityAliases), state: 'committed' }] }).kept.length, 0);
  assert.equal(deduplicateCandidates([portal], { ledgerRows: [{ dedup_key: 'greenhouse|123', identity_aliases: JSON.stringify(resolved.identityAliases), state: 'aborted' }] }).kept.length, 1);
});
