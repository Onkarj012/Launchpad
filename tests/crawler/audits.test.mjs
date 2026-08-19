import test from 'node:test';
import assert from 'node:assert/strict';
import { auditRuns, classifyMissedRole, serializeAuditReport } from '../../crawler/audits.mjs';

const run = (runId, date, overrides = {}) => ({
  runId, finishedAt: `${date}T12:00:00.000Z`,
  sources: [
    { sourceId: 'ats', lane: 'ats', provider: 'greenhouse', fetched: 10, changed: 8, resolved: 6, verified: 5, duplicate: 1, suppressed: 1, selected: 3, failed: 0, applicationReady: 4, freshNew: 3 },
    { sourceId: 'search', lane: 'discovery', provider: 'brave', fetched: 4, changed: 4, resolved: 2, verified: 1, duplicate: 0, suppressed: 1, selected: 1, failed: 0, applicationReady: 1, freshNew: 1 },
  ],
  ...overrides,
});

test('audits multiple sanitized runs with exact source/provider counts and medians', () => {
  const report = auditRuns({ runs: [run('r1', '2026-07-21'), run('r2', '2026-07-22')] });
  assert.equal(report.runs.audited, 2);
  assert.deepEqual(report.yield.totals, {
    fetched: 28, changed: 24, resolved: 16, verified: 12, duplicate: 2,
    suppressed: 4, selected: 8, failed: 0, applicationReady: 10, freshNew: 8,
  });
  assert.deepEqual(report.yield.byProvider.greenhouse, { lane: 'ats', fetched: 20, changed: 16, resolved: 12, verified: 10, duplicate: 2, suppressed: 2, selected: 6, failed: 0, applicationReady: 8, freshNew: 6, applicationReadyYield: 0.4, freshNewYield: 0.3 });
  assert.equal(report.yield.medianApplicationReadyYield, 5 / 14);
  assert.equal(report.yield.medianFreshNewYield, 4 / 14);
  assert.equal(report.yield.daysWithTenFreshNew, 0);
});

test('missing metrics stay unknown and do not become zero or invented rates', () => {
  const report = auditRuns({ runs: [{ runId: 'empty', finishedAt: '2026-07-23T00:00:00.000Z', sources: [{ sourceId: 'x', lane: 'unknown', provider: 'unknown', fetched: 0 }] }] });
  assert.equal(report.yield.bySource.x.resolved, null);
  assert.equal(report.yield.bySource.x.applicationReadyYield, null);
  assert.ok(report.unknowns.includes('source:x.resolved'));
  assert.equal(report.quality.falsePositiveRate, null);
  assert.equal(report.conversion.applicationToResponse, null);
  assert.equal(report.releaseGate.pass, false);
});

test('missed roles classify only from supplied evidence', () => {
  assert.equal(classifyMissedRole({ url: 'u', queryMatched: false }).classification, 'query');
  assert.equal(classifyMissedRole({ url: 'u', queryMatched: true, discovered: false }).classification, 'discovery');
  assert.equal(classifyMissedRole({ url: 'u', discovered: true, resolved: false }).classification, 'resolution');
  assert.equal(classifyMissedRole({ url: 'u', resolved: true, parsed: false }).classification, 'parsing');
  assert.equal(classifyMissedRole({ url: 'u', parsed: true, eligible: false }).classification, 'gating');
  assert.equal(classifyMissedRole({ url: 'u', eligible: true, duplicate: true }).classification, 'dedup');
  assert.equal(classifyMissedRole({ url: 'u', eligible: true, duplicate: false, seenInWindow: false }).classification, 'timing');
  assert.equal(classifyMissedRole({ url: 'u' }).classification, 'unknown');
});

test('quality, contacts, conversion, and serialized report preserve supplied facts', () => {
  const report = auditRuns({
    runs: [run('r1', '2026-07-23', {
      quality: { invalidGeography: 1, invalidExperience: 1, falsePositives: 2, novelSurfaced: 7, previouslySurfacedAsNew: 1 },
      contacts: { selectedApplications: 3, researchedApplications: 2, verifiedContacts: 4 },
      conversion: { applications: 4, responses: 2, screens: 1 },
    })],
    missedRoles: [{ url: 'u', queryMatched: true, discovered: true, resolved: false }],
  });
  assert.equal(report.quality.falsePositiveRate, 2 / 7);
  assert.equal(report.quality.noveltyAccuracy, 6 / 7);
  assert.equal(report.contacts.verifiedYield, 4 / 3);
  assert.equal(report.conversion.applicationToResponse, 0.5);
  assert.deepEqual(report.missedRoles.counts, { query: 0, discovery: 0, resolution: 1, parsing: 0, gating: 0, dedup: 0, timing: 0, unknown: 0 });
  const serialized = serializeAuditReport(report);
  assert.equal(typeof serialized, 'string');
  assert.deepEqual(JSON.parse(serialized), report);
});
