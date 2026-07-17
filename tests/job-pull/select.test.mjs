import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../job-pull/config.mjs';
import { selectCandidates } from '../../job-pull/select.mjs';

const config = loadConfig();

function entry(index, { tier = 'strict', window = 'Primary', family = 'ai-llm-agentic', company = `Company ${index}` } = {}) {
  return {
    canonicalUrl: `https://example.test/${index}`,
    company: company,
    title: `${family} role ${index}`,
    postedAt: '2026-07-14T10:00:00.000Z',
    sourceKind: 'ats-direct',
    selectionTier: tier,
    freshnessWindow: window,
    roleFamily: family,
    companyKey: company.toLowerCase(),
    score: 100 - index,
    eligibility: { eligible: true, tier, roleFamily: family, companyKey: company.toLowerCase(), relaxations: tier === 'relaxed' ? ['adjacent-title'] : [], evidenceCodes: [] },
    freshness: { eligible: true, window, ageHours: index },
  };
}

test('selection is strict primary, strict extended, then relaxed fallback', () => {
  const entries = [];
  for (let index = 0; index < 5; index++) entries.push(entry(index, { tier: 'strict', window: 'Primary', family: ['ai-llm-agentic', 'ml', 'backend-python'][index % 3] }));
  for (let index = 5; index < 10; index++) entries.push(entry(index, { tier: 'strict', window: 'Extended', family: ['full-stack-ai', 'general-new-grad-swe', 'paid-internship'][index % 3] }));
  for (let index = 10; index < 15; index++) entries.push(entry(index, { tier: 'relaxed', window: 'Primary', family: ['ai-llm-agentic', 'ml', 'backend-python'][index % 3] }));
  const result = selectCandidates(entries, config);
  assert.equal(result.selected.length, 15);
  assert.equal(result.strictSelected, 10);
  assert.equal(result.relaxedSelected, 5);
  assert.equal(result.strictShortfall, 0);
  assert.equal(result.selected.slice(0, 5).every((candidate) => candidate.freshnessWindow === 'Primary'), true);
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
