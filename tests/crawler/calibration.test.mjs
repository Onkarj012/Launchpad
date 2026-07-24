import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCalibrationReport } from '../../crawler/calibration.mjs';

test('calibration aggregates source yield without relaxing gates', () => {
  const report = buildCalibrationReport([
    { counts: { applicationReady: 2 }, sourceTelemetry: { searx: { sourceId: 'searx', fetched: 10, ready: 2 } } },
    { counts: { applicationReady: 1 }, sourceTelemetry: { searx: { sourceId: 'searx', fetched: 5, ready: 1 }, ats: { sourceId: 'ats', fetched: 4, ready: 0 } } },
  ]);
  assert.equal(report.runs, 2);
  assert.equal(report.readyRoles, 3);
  assert.equal(report.sourceTelemetry.find((row) => row.sourceId === 'searx').fetched, 15);
  assert.equal(report.noGateRelaxation, true);
  assert.equal(report.decisions.status, 'insufficient-window');
});
