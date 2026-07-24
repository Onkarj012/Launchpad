import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../job-pull/config.mjs';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { applyScores, localRunDate, runPipeline } from '../../job-pull/run.mjs';
import { classifyMiss } from '../../job-pull/audit.mjs';

const config = loadConfig();
const now = '2026-07-14T12:00:00.000Z';

function raw(index, { title = 'AI Engineer', postedAt = '2026-07-14T08:00:00.000Z', experience = { minYears: 0, maxYears: 1 }, location = 'Pune' } = {}) {
  return normalizeCandidate({
    url: `https://jobs.example.test/${index}`, source: 'greenhouse-full', sourceKind: 'ats-direct', provider: 'greenhouse', id: String(index),
    company: `Company ${index}`, title, location, postedAt, employment: { type: 'full-time' }, experience,
    liveness: { status: 'Active', evidence: 'fixture' }, matchScore: 80 - (index % 20),
  });
}

test('run pipeline emits strict/fallback records, manifests, caps, and payload-safe output', () => {
  const candidates = [];
  const strictTitles = ['AI Engineer', 'Machine Learning Engineer', 'Backend Engineer'];
  for (let index = 0; index < 5; index++) candidates.push(raw(index, { title: strictTitles[index % 3] }));
  for (let index = 5; index < 10; index++) candidates.push(raw(index, { title: strictTitles[index % 3], postedAt: '2026-07-11T12:00:00.000Z' }));
  for (let index = 10; index < 15; index++) candidates.push(raw(index, { title: 'Data Engineer', experience: { minYears: 2, maxYears: 2, evidence: '2 years' } }));
  const result = runPipeline({
    config,
    now,
    runId: 'run-fixture',
    sources: [{ candidates, manifest: { sourceId: 'reverse-ats', kind: 'reverse-ats', providers: ['greenhouse', 'lever', 'ashby', 'workday'], fetched: candidates.length, dated: candidates.length, active: candidates.length, notVerified: 0, eligible: 0, duplicate: 0, failed: 0, selected: 0, errors: [] } }],
  });
  assert.equal(result.counts.selected, 15);
  assert.equal(result.counts.strictSelected, 10);
  assert.equal(result.counts.relaxedSelected, 5);
  assert.equal(result.strictShortfall, 0);
  assert.equal(result.records.every((record) => record.payload['Apply?'] === false), true);
  assert.equal(result.records.every((record) => record.payload.Status === 'Discovered'), true);
  assert.equal(result.applicationShortlist.selected.every((candidate) => candidate.applicationReady), true);
  assert.equal(result.applicationShortlist.selected.length, 10);
  assert.deepEqual(result.sourceManifests[0].providers, ['greenhouse', 'lever', 'ashby', 'workday']);
});

test('undated candidates are surfaced in verifyQueue and never selected or rejected', () => {
  const candidate = raw(100, { postedAt: null });
  const result = runPipeline({
    config,
    now,
    runId: 'verify-queue-fixture',
    sources: [{ candidates: [candidate], manifest: { sourceId: 'reverse-ats', errors: [] } }],
  });
  assert.deepEqual(result.verifyQueue, [{
    company: candidate.company,
    title: candidate.title,
    canonicalUrl: candidate.canonicalUrl,
    provider: candidate.provider,
    code: 'FRESHNESS_UNDATED_VERIFY_QUEUE',
    workdayUncorroborated: false,
  }]);
  assert.equal(result.counts.selected, 0);
  assert.equal(result.counts.verifyQueue, 1);
  assert.equal(result.selection.exclusions.length, 0);
  assert.equal(result.exclusionAudit.gate.length, 0);
  assert.equal(result.scoringCandidates.length, 0);
});

test('score merge preserves agent scoring and daily date uses India timezone', () => {
  const candidate = raw(99);
  const sources = applyScores([{ candidates: [candidate], manifest: {} }], [{
    url: candidate.canonicalUrl,
    matchScore: 87,
    rationale: 'Strong Python and applied AI fit',
    hook: 'Lead with shipped agent systems',
    responseLikelihood: 16,
    autoSuggest: true,
    originalApplicationUrl: 'https://jobs.example.test/99/apply',
    humanContact: true,
    projectConnection: true,
  }]);
  assert.equal(sources[0].candidates[0].matchScore, 87);
  assert.equal(sources[0].candidates[0].autoSuggest, true);
  assert.equal(sources[0].candidates[0].applicationResolution.status, 'Resolved Original');
  assert.equal(sources[0].candidates[0].conversionSignals.humanContact, true);
  assert.equal(localRunDate('2026-07-14T20:00:00.000Z', config.timezone), '2026-07-15');
});

test('run telemetry separates scored, unscored, scoring-failed, and selected candidates', () => {
  const scored = raw(201);
  const unscored = raw(202);
  delete unscored.matchScore;
  const failed = { ...raw(203), scoringFailed: true };
  const result = runPipeline({
    config: { ...config, run: { ...config.run, minimumTotal: 1, maximumTotal: 3, strictTarget: 1 } },
    now,
    runId: 'scoring-telemetry-fixture',
    sources: [{ candidates: [scored, unscored, failed], manifest: { sourceId: 'reverse-ats', errors: [] } }],
  });
  assert.equal(result.counts.scored, 1);
  assert.equal(result.counts.unscored, 1);
  assert.equal(result.counts.scoringFailed, 1);
  assert.equal(result.counts.selected, 1);
  assert.deepEqual(result.scoring, { required: true, scoredCount: 1, unscoredCount: 1, scoringFailedCount: 1, selectedCount: 1 });
});

test('audit classifies supplied misses without discovery', () => {
  assert.equal(classifyMiss('not-a-url').classification, 'date-parse');
  assert.equal(classifyMiss('https://miss.example/1', { manifests: [] }).classification, 'source-absent-or-failure');
  assert.equal(classifyMiss('https://miss.example/1', { manifests: [{ sourceId: 'tracked', status: 'ok', errors: [] }] }).classification, 'indexing-lag');
  assert.equal(classifyMiss('https://miss.example/1', { ledgerRows: [{ canonical_url: 'https://miss.example/1', state: 'committed' }] }).classification, 'captured');
});
