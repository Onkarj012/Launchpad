import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../job-pull/config.mjs';
import { selectApplicationShortlist, selectCandidates } from '../../job-pull/select.mjs';

const config = loadConfig();

function entry(index, { tier = 'strict', conversionTier = null, window = 'Hot', family = 'ai-llm-agentic', company = `Company ${index}` } = {}) {
  return {
    canonicalUrl: `https://example.test/${index}`,
    company,
    title: `${family} role ${index}`,
    postedAt: '2026-07-14T10:00:00.000Z',
    sourceKind: 'ats-direct',
    selectionTier: tier,
    conversionTier,
    freshnessWindow: window,
    roleFamily: family,
    companyKey: company.toLowerCase(),
    description: 'Build Python AI services.', scoreOrigin: 'explicit-scored-input', responseLikelihood: 15, score: 100 - index,
    eligibility: { eligible: true, tier, roleFamily: family, companyKey: company.toLowerCase(), relaxations: tier === 'relaxed' ? ['adjacent-title'] : [], evidenceCodes: [] },
    freshness: { eligible: true, window, ageHours: window === 'Backfill' ? 8 * 24 + index : index },
  };
}

test('selection is strict-Hot, strict-Active, strict-Backfill, then relaxed freshness fallback', () => {
  const entries = [];
  for (let index = 0; index < 5; index++) entries.push(entry(index, { tier: 'strict', window: 'Hot', family: ['ai-llm-agentic', 'ml', 'backend-python'][index % 3] }));
  for (let index = 5; index < 10; index++) entries.push(entry(index, { tier: 'strict', window: 'Active', family: ['full-stack-ai', 'general-new-grad-swe', 'paid-internship'][index % 3] }));
  for (let index = 10; index < 15; index++) entries.push(entry(index, { tier: 'strict', window: 'Backfill', family: ['ai-llm-agentic', 'ml', 'backend-python'][index % 3] }));
  for (let index = 15; index < 20; index++) entries.push(entry(index, { tier: 'relaxed', window: 'Hot', family: ['full-stack-ai', 'general-new-grad-swe', 'paid-internship'][index % 3] }));
  const result = selectCandidates(entries, config);
  assert.equal(result.selected.length, 20);
  assert.equal(result.strictSelected, 15);
  assert.equal(result.relaxedSelected, 5);
  assert.equal(result.strictShortfall, 0);
  assert.equal(result.selected.slice(0, 5).every((candidate) => candidate.selectionTier === 'Strict' && candidate.freshnessWindow === 'Hot'), true);
  assert.equal(result.selected.slice(0, 15).every((candidate) => candidate.selectionTier === 'Strict'), true);
  assert.equal(result.selected[15].selectionTier, 'Fallback');
  assert.equal(result.selected[15].freshnessWindow, 'Hot');
});

test('company cap and family balance are deterministic', () => {
  const entries = [];
  for (let index = 0; index < 5; index++) entries.push(entry(index, { company: 'Same Co', family: 'ai-llm-agentic' }));
  for (let index = 5; index < 10; index++) entries.push(entry(index, { company: `Other ${index}`, family: 'ml' }));
  for (let index = 10; index < 15; index++) entries.push(entry(index, { company: `Third ${index}`, family: 'backend-python' }));
  const result = selectCandidates(entries, config);
  assert.equal(result.companyCounts['same co'], 2);
  assert.ok(Math.max(...Object.values(result.familyCounts)) <= 5);
  assert.equal(result.selected.map((candidate) => candidate.canonicalUrl).join(','), selectCandidates(entries, config).selected.map((candidate) => candidate.canonicalUrl).join(','));
  assert.equal(result.exclusions.some((item) => item.code === 'SELECTION_COMPANY_CAP'), true);
});

test('family share yields to volume only after available diversity is used', () => {
  const entries = [];
  for (let index = 0; index < 10; index++) entries.push(entry(index, { family: 'ai-llm-agentic' }));
  for (let index = 10; index < 20; index++) entries.push(entry(index, { family: 'backend-python' }));
  const result = selectCandidates(entries, config);
  assert.equal(result.selected.length, 20);
  assert.equal(Object.keys(result.familyCounts).length, 2);
  assert.ok(result.familyCounts['ai-llm-agentic'] >= 8);
  assert.ok(result.familyCounts['backend-python'] >= 8);
});

test('strict shortfall reports shortage instead of inventing fallback', () => {
  const smallConfig = { ...config, run: { ...config.run, minimumTotal: 2, maximumTotal: 4, strictTarget: 3 } };
  const result = selectCandidates([
    entry(1, { family: 'ai-llm-agentic' }),
    entry(2, { family: 'ml' }),
    entry(3, { tier: 'relaxed', family: 'backend-python' }),
  ], smallConfig);
  assert.equal(result.strictSelected, 2);
  assert.equal(result.strictShortfall, 1);
  assert.equal(result.selected.length, 3);
});

test('unscored eligible candidates stay in an explicit scoring queue and never compete as zero', () => {
  const unscored = { ...entry(2), score: undefined, autoSuggest: true };
  const result = selectCandidates([entry(1), unscored], { ...config, run: { ...config.run, minimumTotal: 1, maximumTotal: 2, strictTarget: 1 } });
  assert.deepEqual(result.selected.map((candidate) => candidate.canonicalUrl), ['https://example.test/1']);
  assert.equal(result.selected[0].score, 99);
  assert.equal(result.scoringQueue.length, 1);
  assert.equal(result.scoringQueue[0].canonicalUrl, unscored.canonicalUrl);
  assert.equal(result.scoringQueue[0].scoringStatus, 'unscored');
  assert.equal(result.scoringQueue[0].score, undefined);
});

test('scored candidates carry Match Score evidence fields and valid Auto-Suggest', () => {
  const candidate = {
    ...entry(1),
    matchScore: 87,
    score: undefined,
    rationale: 'Strong Python and RAG overlap',
    hook: 'Shipped Stride and Lore Engine',
    responseLikelihood: 16,
    autoSuggest: true,
  };
  const result = selectCandidates([candidate], config);
  assert.equal(result.selected[0].matchScore, 87);
  assert.equal(result.selected[0].rationale, candidate.rationale);
  assert.equal(result.selected[0].strongestHook, candidate.hook);
  assert.equal(result.selected[0].responseLikelihood, 16);
  assert.equal(result.selected[0].autoSuggest, true);
});

test('company cap preserves the strongest scored roles regardless of input order', () => {
  const entries = [
    entry(1, { company: 'Same Co' }),
    entry(2, { company: 'Same Co' }),
    entry(3, { company: 'Same Co' }),
    entry(4, { company: 'Other Co' }),
    entry(5, { company: 'Third Co' }),
  ].map((item, index) => ({ ...item, score: [91, 99, 70, 80, 79][index] }));
  const smallConfig = { ...config, run: { ...config.run, minimumTotal: 5, maximumTotal: 5, strictTarget: 5 } };
  const first = selectCandidates(entries, smallConfig);
  const shuffled = selectCandidates([entries[4], entries[2], entries[0], entries[3], entries[1]], smallConfig);
  const sameCompany = (result) => result.selected.filter((candidate) => candidate.company === 'Same Co').map((candidate) => candidate.score).sort((a, b) => b - a);
  assert.deepEqual(sameCompany(first), [99, 91]);
  assert.deepEqual(sameCompany(shuffled), [99, 91]);
  assert.deepEqual(first.selected.map((candidate) => candidate.canonicalUrl).sort(), shuffled.selected.map((candidate) => candidate.canonicalUrl).sort());
});

test('Auto-Suggest is disabled for an unscored candidate', () => {
  const result = selectCandidates([{ ...entry(1), score: undefined, autoSuggest: true }], config);
  assert.equal(result.selected.length, 0);
  assert.equal(result.scoringQueue[0].autoSuggest, false);
});

test('selection keeps VerifyQueue and scoringQueue disjoint from selected rows', () => {
  const verify = {
    ...entry(20),
    freshness: { eligible: false, window: 'VerifyQueue', verifyQueue: true, ageHours: null },
  };
  const unscored = { ...entry(21), score: undefined };
  const result = selectCandidates([entry(1), verify, unscored], {
    ...config,
    run: { ...config.run, minimumTotal: 1, maximumTotal: 1, strictTarget: 1 },
  });
  const selectedKeys = new Set(result.selected.map((candidate) => candidate.canonicalUrl));
  assert.deepEqual(result.selected.map((candidate) => candidate.canonicalUrl), ['https://example.test/1']);
  assert.deepEqual(result.verifyQueue.map((candidate) => candidate.canonicalUrl), [verify.canonicalUrl]);
  assert.deepEqual(result.scoringQueue.map((candidate) => candidate.canonicalUrl), [unscored.canonicalUrl]);
  assert.equal(result.verifyQueue.some((candidate) => selectedKeys.has(candidate.canonicalUrl)), false);
  assert.equal(result.scoringQueue.some((candidate) => selectedKeys.has(candidate.canonicalUrl)), false);
  assert.deepEqual(result.selectionInvariants, { selectedVerifyQueue: [], selectedScoringQueue: [] });
});

test('selection requires a known 8-to-14-day age for Backfill', () => {
  const result = selectCandidates([{
    ...entry(30, { window: 'Backfill' }),
    freshness: { eligible: true, window: 'Backfill', ageHours: null },
  }], { ...config, run: { ...config.run, minimumTotal: 1, maximumTotal: 1 } });
  assert.equal(result.selected.length, 0);
  assert.equal(result.scoringQueue.length, 0);
});

test('application shortlist applies role/source targets only to verified original application URLs', () => {
  const entries = [];
  const groups = [
    ['ai-llm-agentic', 'direct-company'], ['ml', 'vc-portfolio'], ['ai-llm-agentic', 'india-niche'], ['ml', 'india-niche'],
    ['backend-python', 'direct-company'], ['full-stack-ai', 'india-niche'], ['general-new-grad-swe', 'direct-company'],
    ['paid-internship', 'direct-company'], ['adjacent-engineering', 'broad-remote'], ['backend-python', 'broad-remote'],
  ];
  groups.forEach(([family, sourceCategory], index) => entries.push({
    ...entry(index, { family, company: `Ready ${index}` }), sourceCategory, applicationReady: true,
    conversionScore: 100 - index,
  }));
  entries.push({ ...entry(99, { family: 'ai-llm-agentic', company: 'Unverified' }), sourceCategory: 'aggregator', applicationReady: false, conversionScore: 100 });
  const result = selectApplicationShortlist(entries, config);
  assert.equal(result.selected.length, 10);
  assert.equal(result.counts.directOrVc >= 4, true);
  assert.equal(result.counts.indiaNiche >= 3, true);
  assert.equal(result.counts.broadRemote, 2);
  assert.equal(result.selected.some((candidate) => candidate.company === 'Unverified'), false);
  assert.deepEqual(result.shortfalls, { targetCount: 0, roles: { ai: 0, backendFullStack: 0, newGrad: 0, adjacent: 0 }, directOrVc: 0, indiaNiche: 0 });
});

test('application shortlist reports missing quota inventory without using unresolved leads', () => {
  const result = selectApplicationShortlist([
    { ...entry(1, { family: 'ai-llm-agentic' }), sourceCategory: 'aggregator', applicationReady: false },
    { ...entry(2, { family: 'backend-python' }), sourceCategory: 'direct-company', applicationReady: true },
  ], config);
  assert.equal(result.selected.length, 1);
  assert.equal(result.shortfalls.targetCount, 9);
  assert.equal(result.shortfalls.directOrVc, 3);
  assert.equal(result.shortfalls.roles.ai, 4);
});

test('conversion tier breaks equal-score selection ties and is exposed in output', () => {
  const entries = ['strong', 'inspect', 'skip'].map((conversionTier, index) => ({
    ...entry(index, { conversionTier }),
    score: 100,
    conversionScore: 80,
  }));
  const result = selectCandidates(entries, config);
  assert.deepEqual(result.selected.map((candidate) => candidate.conversionTier), ['strong', 'inspect', 'skip']);
});

test('skip conversion tier still fills an application shortlist shortfall', () => {
  const result = selectApplicationShortlist([
    { ...entry(1, { conversionTier: 'skip' }), sourceCategory: 'direct-company', applicationReady: true },
  ], config);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].conversionTier, 'skip');
  assert.equal(result.shortfalls.targetCount, 9);
});
