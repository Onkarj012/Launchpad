import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { mergeScoreRow, scoreCandidates } from '../../job-pull/match-scorer.mjs';
import { scoreState, scorePoolInRun } from '../../job-pull/mode-scoring.mjs';
import { selectNormalApplications } from '../../job-pull/normal-selection.mjs';
import { selectStartupApplications } from '../../job-pull/startup-selection.mjs';
import { selectRemoteApplications } from '../../job-pull/remote-selection.mjs';
import { selectApplicationShortlist, selectCandidates } from '../../job-pull/select.mjs';
import { loadConfig } from '../../job-pull/config.mjs';
import { dailyShortlistBudget, retainDailyShortlist } from '../../crawler/daily-runner.mjs';

// Build an explicit scored selector input with independent readiness facts.
function entry(index, { strict = true, ageHours = 1, family = 'ml', score = 85 } = {}) {
  const window = ageHours <= 72 ? 'Hot' : ageHours <= 168 ? 'Active' : 'Backfill';
  const tier = strict ? 'strict' : 'relaxed';
  return {
    candidate: { canonicalUrl: `https://jobs.example/${index}`, company: `Company ${index}`, title: 'ML Engineer',
      description: 'Build Python ML services.', matchScore: score, responseLikelihood: 18,
      scoreOrigin: 'explicit-scored-input', roleFamily: family, remoteReady: true, applicationReady: true,
      originalApplicationUrl: `https://jobs.example/${index}`, applicationResolution: { status: 'Direct ATS' },
      liveness: { status: 'Active' }, employment: { type: 'full-time' }, experience: { minYears: 0, maxYears: 1 } },
    eligibility: { eligible: true, strict, tier, roleFamily: family },
    freshness: { eligible: true, window, ageHours }, readiness: { ready: true, evidence: {} },
  };
}

test('raw 99.5 without JD cannot bypass scoring or normalization', async () => {
  const candidate = normalizeCandidate({ url: 'https://jobs.example/raw', company: 'Raw Co', title: 'ML Engineer', matchScore: 99.5 });
  assert.equal(candidate.matchScore, null);
  assert.equal(scoreState(candidate).status, 'scoring-failed');
  let attempts = 0;
  await scorePoolInRun([candidate], async () => { attempts++; return { scored: [], failures: [] }; });
  assert.equal(attempts, 1);
  const sourceInteger = normalizeCandidate({ url: 'https://jobs.example/raw', company: 'Raw Co', title: 'ML Engineer', matchScore: 99 });
  assert.equal(sourceInteger.matchScore, null);
  assert.equal(scoreState(sourceInteger).status, 'unscored');
  assert.equal(scoreState({ matchScore: 99, responseLikelihood: 20, description: 'Python ML' }).status, 'unscored');
  assert.equal(scoreState({ matchScore: 85, scoreOrigin: 'explicit-scored-input', description: 'Python ML' }).status, 'scoring-failed');
  const manual = mergeScoreRow(sourceInteger, { matchScore: 99, responseLikelihood: 18 }).candidate;
  assert.equal(scoreState(manual).score, 45);
  assert.equal(manual.autoSuggest, false);
});

test('score state handles absent, empty, boolean, fractional, range-invalid and failed cache fields', () => {
  for (const value of [undefined, null, '', '  ']) assert.equal(scoreState({ matchScore: value }).status, 'unscored');
  for (const value of [true, false, 99.5, -1, 101, [], {}]) assert.equal(scoreState({ matchScore: value }).status, 'scoring-failed');
  assert.equal(scoreState({ matchScore: 99, scoringFailed: true }).status, 'scoring-failed');
  const cached = { matchScore: 85, scoreOrigin: 'model-output', description: 'Python ML', descriptionAvailable: true, responseLikelihood: 18,
    rationale: 'Python overlap', strongestHook: 'Python ML skills', componentScores: { skillMatch: 30, domainRelevance: 15, seniorityFit: 12, locationFit: 10, responseLikelihood: 18 } };
  assert.equal(scoreState(cached).score, 85);
  assert.equal(scoreState({ ...cached, responseLikelihood: 20 }).status, 'scoring-failed');
  assert.equal(scoreState({ ...cached, description: null }).status, 'scoring-failed');
});

test('runtime rejects impossible sum zero with response 20 and requires all components', async () => {
  const candidate = entry(1).candidate;
  const result = await scoreCandidates([candidate], { scoreChunk: async () => [{ canonicalUrl: candidate.canonicalUrl,
    matchScore: 0, responseLikelihood: 20, componentScores: { skillMatch: 0, domainRelevance: 0, seniorityFit: 0, locationFit: 0, responseLikelihood: 20 },
    rationale: 'Python ML', strongestHook: 'Python skills', descriptionAvailable: true }] });
  assert.equal(result.scored[0].matchScore, null);
  assert.equal(result.failures[0].reason, 'SCORER_INCONSISTENT_TOTAL');
});

for (const [name, select] of [['normal', selectNormalApplications], ['startup', selectStartupApplications], ['remote', selectRemoteApplications]]) {
  test(`${name} keeps ten strict backfill before twenty fresh fallback`, () => {
    const entries = [ ...Array.from({ length: 10 }, (_, i) => entry(i, { ageHours: 240, score: 65 })),
      ...Array.from({ length: 20 }, (_, i) => entry(i + 10, { strict: false, score: 99 })) ];
    const selection = select(entries);
    assert.equal(selection.selected.length, 20);
    assert.equal(selection.selected.slice(0, 10).every((row) => row.selectionTier === 'Strict' && row.freshnessWindow === 'Backfill'), true);
    assert.equal(selection.strictShortfall, 0);
  });
  test(`${name} balances an available four-family pool and ranks Hot by fit`, () => {
    const entries = [...Array.from({ length: 20 }, (_, i) => entry(i, { score: 99 })),
      ...['backend-python', 'full-stack-ai', 'general-new-grad-swe'].flatMap((family, f) => Array.from({ length: 6 }, (_, i) => entry(20 + f * 6 + i, { family, score: 70, ageHours: 48 }))) ];
    const selection = select(entries);
    assert.equal(selection.selected.length, 20);
    assert.equal(Object.keys(selection.familyCounts).length, 4);
    assert.equal(Math.max(...Object.values(selection.familyCounts)), 8);
    const ranked = select([entry(101, { score: 60 }), entry(102, { score: 95, ageHours: 48 })]);
    assert.equal(ranked.selected[0].matchScore, 95);
  });
}

test('generic selector uses the same strict-first diversity boundary', () => {
  const entries = [...Array.from({ length: 10 }, (_, i) => entry(i, { ageHours: 240, score: 65 })),
    ...Array.from({ length: 20 }, (_, i) => entry(i + 10, { strict: false, score: 99 }))];
  const result = selectCandidates(entries, loadConfig());
  assert.equal(result.strictSelected, 10);
  assert.equal(result.selected.slice(0, 10).every((row) => row.selectionTier === 'Strict'), true);
});

test('IST daily allocation is cumulative across schedules/modes and retry-safe', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'daily-shortlist-')), 'allocation.json');
  const now = '2026-10-04T20:00:00Z';
  const morning = Array.from({ length: 12 }, (_, i) => entry(i).candidate);
  retainDailyShortlist(file, now, 'morning-normal', morning);
  assert.equal(dailyShortlistBudget(file, now, 'midday-remote').remaining, 8);
  assert.equal(dailyShortlistBudget(file, now, 'morning-normal').remaining, 20);
  retainDailyShortlist(file, now, 'morning-normal', morning);
  assert.equal(dailyShortlistBudget(file, now, 'midday-startup').remaining, 8);
  assert.throws(() => retainDailyShortlist(file, now, 'midday-remote', Array.from({ length: 9 }, (_, i) => entry(i + 12).candidate)), /capacity changed/);
  retainDailyShortlist(file, now, 'midday-remote', Array.from({ length: 8 }, (_, i) => entry(i + 12).candidate));
  assert.equal(dailyShortlistBudget(file, now, 'third-run').remaining, 0);
  assert.equal(dailyShortlistBudget(file, '2026-10-05T20:00:00Z', 'next-day').remaining, 20);
  writeFileSync(file, '{}');
  assert.throws(() => dailyShortlistBudget(file, now, 'broken'), /invalid daily/);
});

// Verify that morning allocations constrain later selections at the company boundary.
test('daily company capacity and family history survive into a later mode selection', () => {
  const pool = [entry(201), entry(202), entry(203, { family: 'backend-python' })];
  pool[0].candidate.company = 'Same Co';
  pool[1].candidate.company = 'Same Co';
  const result = selectNormalApplications(pool, { maximum: 8, previousDailyCandidates: [{ company: 'Same Co', roleFamily: 'ml' }, { company: 'Same Co', roleFamily: 'ml' }] });
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].company, 'Company 203');
});

test('retry cannot release already retained plan capacity by returning an empty list', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'daily-shortlist-retry-')), 'allocation.json');
  retainDailyShortlist(file, '2026-10-05T06:00:00Z', 'morning', [entry(1).candidate]);
  retainDailyShortlist(file, '2026-10-05T06:00:00Z', 'morning', []);
  assert.equal(dailyShortlistBudget(file, '2026-10-05T07:00:00Z', 'midday').remaining, 19);
});

// Exhaust the Strict band before using fallback diversity.
test('diversity cannot displace an available Strict band', () => {
  const pool = [...Array.from({ length: 24 }, (_, i) => entry(i)),
    ...['backend-python', 'full-stack-ai', 'adjacent-engineering'].flatMap((family, f) => Array.from({ length: 6 }, (_, i) => entry(30 + f * 6 + i, { family, strict: false })))];
  const result = selectNormalApplications(pool);
  assert.equal(result.strictSelected, 20);
  assert.equal(Object.keys(result.familyCounts).length, 1);
  assert.equal(result.selected.every((row) => row.selectionTier === 'Strict'), true);
});

test('rescoring clears a cached failure state and computes the component sum', async () => {
  const candidate = { ...entry(301).candidate, scoringStatus: 'scoring-failed', scoringFailed: true };
  const result = await scorePoolInRun([candidate], async (rows) => ({ scored: rows.map((row) => ({ ...row,
    matchScore: 85, responseLikelihood: 18, descriptionAvailable: true, rationale: 'Python ML requirements match', strongestHook: 'Python ML evidence',
    componentScores: { skillMatch: 30, domainRelevance: 15, seniorityFit: 12, locationFit: 10, responseLikelihood: 18 } })) }));
  assert.equal(scoreState(result.pool[0]).score, 85);
  assert.equal(result.pool[0].scoringFailed, false);
});

// The manual shortlist must obey the same usable-score boundary.
test('generic application shortlist rejects source scores and failed cached scores', () => {
  const source = { ...entry(401).candidate, scoreOrigin: 'source-input', applicationReady: true };
  const failed = { ...entry(402).candidate, scoringFailed: true, applicationReady: true };
  assert.equal(selectApplicationShortlist([source, failed], loadConfig()).selected.length, 0);
});

// A second caller must recheck company limits while committing its local allocation.
test('daily allocation rejects stale concurrent company inventory', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'daily-shortlist-company-')), 'allocation.json');
  const first = entry(501).candidate;
  const second = entry(502).candidate;
  first.company = 'Same Co'; second.company = 'Same Co';
  retainDailyShortlist(file, '2026-10-05T06:00:00Z', 'morning', [first, second]);
  assert.throws(() => retainDailyShortlist(file, '2026-10-05T07:00:00Z', 'midday', [{ ...entry(503).candidate, company: 'Same Co' }]), /company capacity changed/);
  assert.throws(() => retainDailyShortlist(file, '2026-10-05T07:00:00Z', 'midday', [first]), /capacity changed/);
});

for (const [name, select] of [['normal', selectNormalApplications], ['startup', selectStartupApplications], ['remote', selectRemoteApplications], ['generic', (entries) => selectCandidates(entries, loadConfig())]]) {
  test(`${name} exhausts Strict Hot before older diverse bands`, () => {
    const pool = [...Array.from({ length: 20 }, (_, i) => entry(i)),
      ...Array.from({ length: 20 }, (_, i) => entry(30 + i, { family: 'backend-python', ageHours: 240 }))];
    const result = select(pool);
    assert.equal(result.selected.length, 20);
    assert.equal(result.selected.every((row) => row.freshnessWindow === 'Hot'), true);
  });
}

test('discovery scoreOrigin claims do not grant scoring trust', () => {
  for (const scoreOrigin of ['explicit-scored-input', 'model-output']) {
    const candidate = normalizeCandidate({ url: 'https://jobs.example/forged', company: 'Forge Co', title: 'ML Engineer',
      description: 'Build ML services', scoreOrigin, matchScore: 99, responseLikelihood: 20, autoSuggest: true });
    assert.equal(candidate.matchScore, null);
    assert.equal(candidate.scoreOrigin, 'source-input');
    assert.equal(scoreState(candidate).status, 'unscored');
    assert.equal(scoreState(mergeScoreRow(candidate, { matchScore: 80, responseLikelihood: 15 }).candidate).status, 'scored');
  }
});

test('daily state rejects present malformed days and conflicting duplicate metadata', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'daily-shortlist-invalid-')), 'allocation.json');
  const now = '2026-10-06T06:00:00Z';
  for (const malformed of [null, false, 0, '', []]) {
    writeFileSync(file, JSON.stringify({ schemaVersion: 'DailyShortlistBudgetV1', days: { '2026-10-06': malformed } }));
    assert.throws(() => dailyShortlistBudget(file, now, 'new'), /invalid daily/);
  }
  const row = { key: 'same', company: 'Acme', family: 'ml', tier: 'strict' };
  for (const field of ['company', 'family', 'tier']) {
    writeFileSync(file, JSON.stringify({ schemaVersion: 'DailyShortlistBudgetV1', days: { '2026-10-06': { first: [row], second: [{ ...row, [field]: 'different' }] } } }));
    assert.throws(() => dailyShortlistBudget(file, now, 'new'), /conflicting daily/);
  }
  writeFileSync(file, JSON.stringify({ schemaVersion: 'DailyShortlistBudgetV1', days: {} }));
  assert.equal(dailyShortlistBudget(file, now, 'new').remaining, 20);
});
