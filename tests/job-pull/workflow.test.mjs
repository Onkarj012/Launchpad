import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateDedupKey, normalizeCandidate } from '../../job-pull/candidate.mjs';
import { runV5Workflow } from '../../job-pull/workflow.mjs';

const NOW = '2026-07-23T06:30:00.000Z';

function candidate(index, overrides = {}) {
  return normalizeCandidate({
    url: `https://jobs.example.test/${index}`,
    source: 'greenhouse-full',
    sourceKind: 'ats-direct',
    provider: 'greenhouse',
    id: String(index),
    company: `Fixture Co ${index}`,
    title: 'AI Engineer',
    location: 'Pune',
    postedAt: NOW,
    employment: { type: 'full-time' },
    experience: { minYears: 0, maxYears: 1 },
    liveness: { status: 'Active', evidence: 'fixture' },
    ...overrides,
  });
}

function sourceResults() {
  return [{
    candidates: [candidate(1), candidate(2, { postedAt: null })],
    manifest: {
      sourceId: 'tracked',
      kind: 'tracked-ats',
      status: 'ok',
      errors: [],
    },
  }];
}

function fakeGateway() {
  const calls = [];
  return {
    calls,
    planWrites(request) {
      calls.push(request);
      return { status: 'planned', operations: request.operations };
    },
  };
}

test('fixture workflow returns a stable no-write operator result', () => {
  const gateway = fakeGateway();
  const result = runV5Workflow({
    sourceResults: sourceResults(),
    clock: () => NOW,
    runId: 'fixture-run',
    notionGateway: gateway,
  });

  assert.deepEqual(Object.keys(result), [
    'schemaVersion', 'runId', 'runAt', 'mode', 'shortlist', 'verificationQueue',
    'sourceManifests', 'sourceTelemetry', 'shortfall', 'plannedNotionOperations',
    'outcome', 'counts',
  ]);
  assert.equal(result.schemaVersion, 'LaunchpadV5WorkflowV1');
  assert.equal(result.mode, 'normal');
  assert.equal(result.shortlist.length, 1);
  assert.equal(result.shortlist[0].canonicalUrl, 'https://jobs.example.test/1');
  assert.deepEqual(result.verificationQueue, [{
    company: 'Fixture Co 2',
    title: 'AI Engineer',
    canonicalUrl: 'https://jobs.example.test/2',
    provider: 'greenhouse',
  }]);
  assert.equal(result.shortfall.selected, 1);
  assert.equal(result.shortfall.missing, 9);
  assert.match(result.shortfall.explanation, /short by 9/);
  assert.equal(result.sourceManifests[0].sourceId, 'tracked');
  assert.deepEqual(result.sourceTelemetry, result.sourceManifests);
  assert.equal(result.plannedNotionOperations.length, 1);
  assert.equal(result.plannedNotionOperations[0].operation, 'create');
  assert.equal(result.outcome.status, 'ok');
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].mode, 'normal');
});

test('normal is the default and startup and remote carry mode identity', () => {
  for (const mode of ['normal', 'startup', 'remote']) {
    assert.equal(runV5Workflow({ sourceResults: sourceResults(), clock: () => NOW, mode }).mode, mode);
  }
  assert.equal(runV5Workflow({ sourceResults: sourceResults(), clock: () => NOW }).mode, 'normal');
  assert.throws(() => runV5Workflow({ sourceResults: sourceResults(), clock: () => NOW, mode: 'internship' }), /invalid v5 mode/);
});

test('source degradation is visible but does not block valid planned operations', () => {
  const gateway = fakeGateway();
  const sources = sourceResults();
  sources.push({
    candidates: [],
    manifest: { sourceId: 'optional-feed', kind: 'fixture', status: 'failed', errors: ['fixture unavailable'] },
  });
  const result = runV5Workflow({ sourceResults: sources, clock: () => NOW, notionGateway: gateway });

  assert.equal(result.outcome.status, 'degraded');
  assert.equal(result.outcome.fatal, false);
  assert.deepEqual(result.sourceManifests[1].errors, ['fixture unavailable']);
  assert.equal(result.plannedNotionOperations.length, 1);
  assert.equal(gateway.calls.length, 1);
});

test('manifest or ledger integrity failure is fatal and prevents planned writes', () => {
  const gateway = fakeGateway();
  const result = runV5Workflow({
    sourceResults: [{ candidates: [candidate(1)], manifest: { sourceId: 'tracked', errors: 'not-an-array' } }],
    ledgerRows: [{ dedup_key: 'bad', company: '', role: '', state: 'bogus' }],
    clock: () => NOW,
    notionGateway: gateway,
  });

  assert.equal(result.outcome.status, 'fatal');
  assert.equal(result.outcome.fatal, true);
  assert.deepEqual(result.plannedNotionOperations, []);
  assert.equal(gateway.calls.length, 0);
  assert.ok(result.outcome.errors.some((error) => /manifest|ledger/i.test(error.message)));
});

test('opportunity ledger suppression is preserved and invalid opportunity state is fatal', () => {
  const eligibleSources = [{
    candidates: [candidate(1), candidate(2)],
    manifest: { sourceId: 'tracked', errors: [] },
  }];
  const suppressedRows = [
    {
      dedup_key: candidateDedupKey(candidate(1)), company: 'Fixture Co 1', role: 'AI Engineer',
      action_state: 'applied', last_surfaced_at: NOW,
    },
    {
      dedup_key: candidateDedupKey(candidate(2)), company: 'Fixture Co 2', role: 'AI Engineer',
      action_state: 'none', last_surfaced_at: '2026-07-20T06:30:00.000Z',
    },
  ];
  const gateway = fakeGateway();
  const suppressed = runV5Workflow({
    sourceResults: eligibleSources,
    opportunityLedgerRows: suppressedRows,
    clock: () => NOW,
    notionGateway: gateway,
  });

  assert.equal(suppressed.outcome.status, 'ok');
  assert.deepEqual(suppressed.shortlist, []);
  assert.deepEqual(suppressed.plannedNotionOperations, []);
  assert.equal(suppressed.counts.suppressed, 2);
  assert.equal(gateway.calls.length, 1);

  const invalidGateway = fakeGateway();
  const invalid = runV5Workflow({
    sourceResults: eligibleSources,
    opportunityLedgerRows: [{ ...suppressedRows[0], action_state: 'bogus' }],
    clock: () => NOW,
    notionGateway: invalidGateway,
  });
  assert.equal(invalid.outcome.status, 'fatal');
  assert.deepEqual(invalid.plannedNotionOperations, []);
  assert.equal(invalidGateway.calls.length, 0);
  assert.match(invalid.outcome.errors[0].message, /opportunity ledger/i);
});

test('manifest and gateway plan integrity failures are fatal and prevent planned writes', () => {
  for (const counter of ['fetched', 'dated', 'active', 'notVerified', 'eligible', 'duplicate', 'failed', 'selected']) {
    const gateway = fakeGateway();
    const result = runV5Workflow({
      sourceResults: [{ candidates: [candidate(1)], manifest: { sourceId: 'tracked', [counter]: Number.NaN, errors: [] } }],
      clock: () => NOW,
      notionGateway: gateway,
    });
    assert.equal(result.outcome.status, 'fatal', counter);
    assert.deepEqual(result.plannedNotionOperations, [], counter);
    assert.equal(gateway.calls.length, 0, counter);
  }

  const duplicateGateway = fakeGateway();
  const duplicate = runV5Workflow({
    sourceResults: [
      { candidates: [candidate(1)], manifest: { sourceId: 'tracked', errors: [] } },
      { candidates: [], manifest: { sourceId: 'tracked', errors: [] } },
    ],
    clock: () => NOW,
    notionGateway: duplicateGateway,
  });
  assert.equal(duplicate.outcome.status, 'fatal');
  assert.deepEqual(duplicate.plannedNotionOperations, []);
  assert.equal(duplicateGateway.calls.length, 0);

  const alteringGateway = {
    calls: [],
    planWrites(request) {
      this.calls.push(request);
      return { status: 'planned', operations: request.operations.slice(0, -1) };
    },
  };
  const altered = runV5Workflow({ sourceResults: sourceResults(), clock: () => NOW, notionGateway: alteringGateway });
  assert.equal(altered.outcome.status, 'fatal');
  assert.deepEqual(altered.plannedNotionOperations, []);
  assert.equal(alteringGateway.calls.length, 1);
  assert.match(altered.outcome.errors[0].message, /authoritative operations/i);
});
