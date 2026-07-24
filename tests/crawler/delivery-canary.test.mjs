import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDeliveryCanary,
  compareDeliveryCanaryRuns,
  createJsonCanaryStore,
  recordDeliveryCanary,
} from '../../crawler/delivery-canary.mjs';
import { verifySafetyContracts } from '../../crawler/safety-contract.mjs';

const RUN_AT = '2026-07-25T06:30:00.000Z';

function run(overrides = {}) {
  return {
    runId: 'morning-2026-07-25',
    runAt: RUN_AT,
    counts: { eligible: 10, scored: 4, ready: 5, selected: 1 },
    reconciliation: {
      causes: {
        eligibleToReady: { HISTORICAL_SUPPRESSION: 2, NOT_APPLICATION_READY: 1 },
        readyToScored: {},
        scoredToSelected: { COMPANY_CAP: 1, DIVERSITY: 1 },
      },
    },
    shortfall: { missing: 1 },
    v4HistorySnapshot: { status: 'missing', path: '/tmp/v4-history.json' },
    ...overrides,
  };
}

test('records per-run counts and names every delta cause, including unattributed remainder', () => {
  const record = buildDeliveryCanary({ run: run() });

  assert.deepEqual(record.counts, { eligible: 10, scoredPool: 4, ready: 5, shortlist: 1 });
  assert.deepEqual(record.deltas[0].attributions, [
    { cause: 'historical suppression', count: 2 },
    { cause: 'readiness', count: 1 },
    { cause: 'unattributed', count: 2 },
  ]);
  assert.deepEqual(record.deltas[1].attributions, [{ cause: 'unattributed', count: 1 }]);
  assert.deepEqual(record.deltas[2].attributions, [
    { cause: 'company cap', count: 1 },
    { cause: 'diversity', count: 1 },
    { cause: 'shortfall', count: 1 },
  ]);
});

test('compares two or more recorded runs day over day', () => {
  const first = buildDeliveryCanary({ run: run() });
  const second = buildDeliveryCanary({
    run: run({ runId: 'morning-2026-07-26', runAt: '2026-07-26T06:30:00.000Z', counts: { eligible: 12, scored: 8, ready: 9, selected: 3 } }),
  });
  const comparison = compareDeliveryCanaryRuns([first, second]);

  assert.equal(comparison.runCount, 2);
  assert.deepEqual(comparison.dayOverDay[0].deltas, { eligible: 2, scoredPool: 4, ready: 4, shortlist: 2 });
});

test('persists the snapshot before/after transition without seeding canary records', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'launchpad-canary-'));
  const file = path.join(directory, 'delivery-canary.json');
  const store = createJsonCanaryStore(file);
  assert.deepEqual(store.readRuns(), []);

  const before = recordDeliveryCanary({ run: run(), clock: () => RUN_AT, store });
  const after = recordDeliveryCanary({
    run: run({ runId: 'morning-2026-07-26', runAt: '2026-07-26T06:30:00.000Z', counts: { eligible: 10, scored: 3, ready: 4, selected: 2 }, v4HistorySnapshot: { status: 'loaded', path: '/tmp/v4-history.json' } }),
    clock: () => '2026-07-26T06:30:00.000Z',
    store,
  });

  assert.equal(before.historySnapshot.shortlistBeforePopulation, 1);
  assert.equal(after.historySnapshot.shortlistBeforePopulation, 1);
  assert.equal(after.historySnapshot.shortlistAfterPopulation, 2);
  assert.match(after.historySnapshot.note, /snapshot working, not a regression/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).runs.length, 2);
});

test('safety-contract verification passes current code and fails a violated contract', () => {
  const passing = verifySafetyContracts({ root: process.cwd() });
  assert.equal(passing.passed, true);
  const configPath = 'config/launchpad-v5.commands.json';
  const config = readFileSync(path.join(process.cwd(), configPath), 'utf8').replace('"autoApply": false', '"autoApply": true');
  const failing = verifySafetyContracts({ root: process.cwd(), files: { [configPath]: config } });
  assert.equal(failing.passed, false);
  assert.ok(failing.checks.some((check) => check.id === 'no-auto-apply' && !check.ok));
});
