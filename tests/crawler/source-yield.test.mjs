import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceYieldReport } from '../../crawler/source-yield.mjs';

test('reports the requested per-board quality funnel without auto-pausing', () => {
  const record = {
    provider: 'ashby',
    company: 'Example India',
    evidence: { board: 'example' },
    _crawlerReserveEntry: {
      candidate: { provider: 'ashby', company: 'Example India', evidence: { board: 'example' }, applicationReady: true },
      eligibility: { geo: { pass: true }, title: { pass: true }, experience: { pass: true } },
      freshness: { eligible: true, ageHours: 24 },
    },
  };
  const report = buildSourceYieldReport([record], {
    'ats-warm': {
      detail: { sources: [{ provider: 'ashby', board: 'example', company: 'Example India', fetched: 101, foreignDiscardedAtSource: 44 }] },
    },
  });

  assert.deepEqual(report.totals, {
    fetched: 101,
    indiaBased: 1,
    targetTitle: 1,
    freshWithinSevenDays: 1,
    experienceCompatible: 1,
    applicationReady: 1,
    foreignDiscardedAtSource: 44,
  });
  assert.equal(report.sources[0].applicationReadyYield, 1 / 101);
  assert.equal(report.sources[0].pauseRecommendation.eligible, false);
});

test('manual-review experience does not count as compatible or ready', () => {
  const report = buildSourceYieldReport([{
    provider: 'ashby',
    company: 'Example',
    evidence: { board: 'example' },
    _crawlerReserveEntry: {
      candidate: { provider: 'ashby', company: 'Example', evidence: { board: 'example' }, applicationReady: false },
      eligibility: { geo: { pass: true }, title: { pass: true }, experience: { pass: true, manualReview: true } },
      freshness: { eligible: true, ageHours: 200 },
    },
  }]);
  assert.equal(report.sources[0].experienceCompatible, 0);
  assert.equal(report.sources[0].applicationReady, 0);
  assert.equal(report.sources[0].freshWithinSevenDays, 0);
});
