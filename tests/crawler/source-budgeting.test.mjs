import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  crawlRun,
  openCrawlerStore,
  registerSourcePlans,
  startCrawlRun,
} from '../../crawler/run.mjs';
import {
  createSourceDeadline,
  planSourceBudgets,
  validateExecutionBudget,
} from '../../crawler/deadline.mjs';
import { validateCrawlerConfig } from '../../crawler/operator.mjs';

const executionFields = [
  'wholeRunDeadlineMs',
  'discoveryBudgetMs',
  'downstreamReserveMs',
  'handoffReserveMs',
  'scorerFloorMs',
  'perSourceMaxDurationMs',
  'minimumSourceStartAllocationMs',
];

function budgetClock() {
  let current = Date.parse('2026-08-29T00:00:00.000Z');
  let monotonic = 0;
  let scheduled = null;
  return {
    now: () => new Date(current).toISOString(),
    monotonicNow: () => monotonic,
    advance: (milliseconds) => { monotonic += milliseconds; current += milliseconds; },
    setTimeout: (callback) => { scheduled = callback; return callback; },
    clearTimeout: (callback) => { if (scheduled === callback) scheduled = null; },
    runTimeout: () => { const callback = scheduled; scheduled = null; callback?.(); },
    async sleep(milliseconds) { monotonic += milliseconds; current += milliseconds; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test('production and dev execution configs satisfy the fair budgeting invariants', () => {
  for (const file of ['config/crawler-v2.json', 'config/crawler-v2-dev.json']) {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const field of executionFields) assert.ok(Number.isInteger(config.execution[field]) && config.execution[field] > 0, `${file}: ${field}`);
    validateCrawlerConfig(config);
    validateExecutionBudget(config.execution);
    assert.ok(config.execution.scorerFloorMs <= config.execution.downstreamReserveMs);
    assert.ok(config.execution.discoveryBudgetMs + config.execution.downstreamReserveMs + config.execution.handoffReserveMs <= config.execution.wholeRunDeadlineMs);
  }
});

test('source planning gives each planned source a positive start allocation or explicit omission', () => {
  const result = planSourceBudgets([
    { id: 'one', fetch: async () => ({}) },
    { id: 'two', fetch: async () => ({}) },
    { id: 'three', fetch: async () => ({}) },
  ], {
    wholeRunDeadlineMs: 20,
    discoveryBudgetMs: 2,
    downstreamReserveMs: 10,
    handoffReserveMs: 8,
    scorerFloorMs: 5,
    perSourceMaxDurationMs: 10,
    minimumSourceStartAllocationMs: 1,
  });

  assert.ok(result.plans.some((source) => source.budget.status === 'omitted_by_planner'));
  for (const source of result.plans) {
    if (source.budget.status === 'planned') assert.ok(source.budget.startAllocationMs > 0);
    else assert.equal(source.budget.status, 'omitted_by_planner');
  }
});

test('source deadline reads a live parent remaining budget', () => {
  let parentRemaining = 80;
  const deadline = createSourceDeadline({ remainingMs: () => parentRemaining }, 200, Date.now());
  assert.ok(deadline.remainingMs() <= 80);
  parentRemaining = 7;
  assert.ok(deadline.remainingMs() <= 7);
});

test('source deadline uses an injected epoch clock for parent and child elapsed time', () => {
  const startedAt = Date.parse('2026-08-29T00:00:00.000Z');
  let current = startedAt;
  const deadline = createSourceDeadline(
    { deadlineMs: startedAt + 100 },
    60,
    startedAt,
    () => current,
  );

  assert.equal(deadline.remainingMs(), 60);
  current += 25;
  assert.equal(deadline.remainingMs(), 35);
  current += 80;
  assert.equal(deadline.remainingMs(), 0);
});

test('source deadline uses an injected timer for a non-wall-clock absolute deadline', async () => {
  const store = openCrawlerStore(':memory:');
  const startedAt = Date.parse('2026-08-29T00:00:00.000Z');
  let current = startedAt;
  let scheduled = null;
  let cleared = null;
  const clock = {
    now: () => new Date(current).toISOString(),
    monotonicNow: () => 0,
    setTimeout: (callback, delay) => {
      scheduled = { callback, delay };
      return scheduled;
    },
    clearTimeout: (timer) => { cleared = timer; },
  };

  try {
    const result = await crawlRun({
      store,
      runId: 'injected-deadline-timer',
      clock,
      deadline: { deadlineMs: startedAt + 100 },
      config: { execution: {
        wholeRunDeadlineMs: 100, discoveryBudgetMs: 20, downstreamReserveMs: 40,
        handoffReserveMs: 40, scorerFloorMs: 40, perSourceMaxDurationMs: 20,
        minimumSourceStartAllocationMs: 1,
      } },
      sourcePlans: [{
        id: 'timer-source',
        lane: 'test',
        fetch: async ({ signal }) => {
          assert.equal(scheduled.delay, 20);
          scheduled.callback();
          assert.equal(signal.reason.code, 'SOURCE_MAX_DURATION_EXCEEDED');
          return { observations: [], manifest: {} };
        },
      }],
    });

    assert.equal(result.telemetry.sources['timer-source'].status, 'truncated');
    assert.equal(cleared, scheduled);
  } finally {
    store.close();
  }
});

test('a started source is truncated at its maximum duration and retains telemetry', async () => {
  const store = openCrawlerStore(':memory:');
  try {
    const clock = budgetClock();
    const sourceCompletion = deferred();
    const result = await crawlRun({
      store,
      runId: 'source-max-duration',
      config: {
        execution: {
          wholeRunDeadlineMs: 500,
          discoveryBudgetMs: 300,
          downstreamReserveMs: 100,
          handoffReserveMs: 100,
          scorerFloorMs: 100,
          perSourceMaxDurationMs: 20,
          minimumSourceStartAllocationMs: 1,
        },
      },
      sourcePlans: [{
        id: 'slow-source',
        lane: 'test',
        fetch: async ({ signal }) => {
          signal.addEventListener('abort', () => sourceCompletion.resolve({ observations: [], manifest: {} }), { once: true });
          clock.runTimeout();
          return sourceCompletion.promise;
        },
      }],
      clock,
    });
    const telemetry = result.telemetry.sources['slow-source'];
    assert.equal(telemetry.status, 'truncated');
    assert.equal(telemetry.capHit, 'maxDuration');
    assert.equal(telemetry.durationMs, 0);
    assert.equal(telemetry.budget.maxDurationMs, 20);
  } finally {
    store.close();
  }
});

test('source budget exhaustion stays truncated when an adapter checkpoints as interrupted', async () => {
  const store = openCrawlerStore(':memory:');
  try {
    const clock = budgetClock();
    let secondSourceCalls = 0;
    const result = await crawlRun({
      store,
      runId: 'checkpointed-source-budget',
      config: {
        execution: {
          wholeRunDeadlineMs: 500,
          discoveryBudgetMs: 300,
          downstreamReserveMs: 100,
          handoffReserveMs: 100,
          scorerFloorMs: 100,
          perSourceMaxDurationMs: 20,
          minimumSourceStartAllocationMs: 1,
        },
      },
      sourcePlans: [
        {
          id: 'checkpointing-source',
          lane: 'test',
          fetch: async ({ signal }) => new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({
              observations: [],
              cursor: { page: 2 },
              interrupted: true,
              manifest: { interrupted: true },
            }), { once: true });
            clock.runTimeout();
          }),
        },
        {
          id: 'later-source',
          lane: 'test',
          fetch: async () => {
            secondSourceCalls += 1;
            return { observations: [], manifest: { naturalTerminal: true } };
          },
        },
      ],
      clock,
    });

    assert.equal(result.telemetry.sources['checkpointing-source'].status, 'truncated');
    assert.equal(result.telemetry.sources['checkpointing-source'].capHit, 'maxDuration');
    assert.deepEqual(result.telemetry.sources['checkpointing-source'].continuationCursor, { page: 2 });
    assert.equal(result.telemetry.sources['later-source'].status, 'succeeded');
    assert.equal(secondSourceCalls, 1);
  } finally {
    store.close();
  }
});

test('pending source telemetry after planning fails closed as not_started_bug', async () => {
  const store = openCrawlerStore(':memory:');
  try {
    startCrawlRun(store, { runId: 'not-started-bug', clock: { now: () => '2026-08-29T00:00:00.000Z' } });
    registerSourcePlans(store, 'not-started-bug', [{ id: 'pending-source', lane: 'test', fetch: async () => ({}) }], { clock: { now: () => '2026-08-29T00:00:00.000Z' } });
    await assert.rejects(
      () => crawlRun({ store, runId: 'not-started-bug', sourcePlans: [], clock: { now: () => '2026-08-29T00:00:00.000Z' } }),
      (error) => error.code === 'NOT_STARTED_BUG' && error.message.includes('not_started_bug'),
    );
    const row = store.prepare('SELECT status, error FROM source_telemetry WHERE run_id = ? AND source_id = ?').get('not-started-bug', 'pending-source');
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'not_started_bug');
  } finally {
    store.close();
  }
});

test('runtime budgeting recycles an early source shortfall without spending the later reserve', async () => {
  const store = openCrawlerStore(':memory:');
  try {
    const clock = budgetClock();
    const result = await crawlRun({
      store,
      runId: 'runtime-recycling',
      config: {
        execution: {
          wholeRunDeadlineMs: 500,
          discoveryBudgetMs: 120,
          downstreamReserveMs: 100,
          handoffReserveMs: 100,
          scorerFloorMs: 100,
          perSourceMaxDurationMs: 200,
          minimumSourceStartAllocationMs: 10,
        },
      },
      sourcePlans: [
        { id: 'early', lane: 'test', fetch: async () => { clock.advance(10); return { observations: [], manifest: {} }; } },
        { id: 'late', lane: 'test', fetch: async () => ({ observations: [], manifest: {} }) },
      ],
      clock,
    });
    const early = result.telemetry.sources.early;
    const late = result.telemetry.sources.late;
    assert.equal(early.actualDurationMs, 10);
    assert.equal(early.laterSourceReserveMs, 10);
    assert.equal(early.runtimeAllowanceMs, 110);
    assert.equal(early.recycledMs, 50);
    assert.equal(late.runtimeAllowanceMs, 110);
    assert.equal(late.recycledMs, 50);
    assert.equal(early.runtimeAllowanceMs + early.laterSourceReserveMs, 120);
  } finally {
    store.close();
  }
});

test('a source with no safe runtime allowance is explicitly omitted', async () => {
  const store = openCrawlerStore(':memory:');
  try {
    const clock = budgetClock();
    let calls = 0;
    const result = await crawlRun({
      store,
      runId: 'runtime-zero-safe-allowance',
      config: {
        execution: {
          wholeRunDeadlineMs: 500,
          discoveryBudgetMs: 40,
          downstreamReserveMs: 100,
          handoffReserveMs: 100,
          scorerFloorMs: 100,
          perSourceMaxDurationMs: 100,
          minimumSourceStartAllocationMs: 10,
        },
      },
      sourcePlans: [
        { id: 'consuming', lane: 'test', fetch: async () => { clock.advance(40); return {}; } },
        { id: 'too-small', lane: 'test', maxDurationMs: 5, fetch: async () => { calls += 1; return {}; } },
        { id: 'last', lane: 'test', maxDurationMs: 5, fetch: async () => ({}) },
      ],
      clock,
    });
    assert.equal(calls, 0);
    assert.equal(result.telemetry.sources['too-small'].status, 'omitted_by_runtime');
    assert.ok(result.telemetry.sources['too-small'].runtimeAllowanceMs < 10);
    assert.equal(result.telemetry.sources['too-small'].actualDurationMs, 0);
  } finally {
    store.close();
  }
});

test('later reserve uses each cap and starts a cap-below-minimum source', async () => {
  const store = openCrawlerStore(':memory:');
  try {
    const clock = budgetClock();
    let currentCalls = 0;
    const result = await crawlRun({
      store,
      runId: 'cap-aware-reserve',
      clock,
      config: { execution: {
        wholeRunDeadlineMs: 100, discoveryBudgetMs: 20, downstreamReserveMs: 40,
        handoffReserveMs: 40, scorerFloorMs: 40, perSourceMaxDurationMs: 50,
        minimumSourceStartAllocationMs: 10,
      } },
      sourcePlans: [
        { id: 'capped-current', lane: 'test', maxDurationMs: 5, fetch: async () => { currentCalls += 1; return {}; } },
        { id: 'capped-later', lane: 'test', maxDurationMs: 5, fetch: async () => ({}) },
      ],
    });
    assert.equal(currentCalls, 1);
    assert.equal(result.telemetry.sources['capped-current'].status, 'succeeded');
    assert.equal(result.telemetry.sources['capped-current'].runtimeAllowanceMs, 5);
    assert.equal(result.telemetry.sources['capped-current'].laterSourceReserveMs, 5);
    assert.equal(result.telemetry.sources['capped-later'].status, 'succeeded');
  } finally {
    store.close();
  }
});
