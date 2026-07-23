import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCHEDULE_CONFIG,
  buildSchedulePlans,
  executeSchedulePlan,
  serializeSchedulePlans,
  validateStageDependencies,
} from '../../crawler/schedules.mjs';

test('orders stages by dependencies while preserving configured order for independent stages', () => {
  const plans = buildSchedulePlans({
    schedules: {
      demo: {
        cadence: { kind: 'manual', timezone: 'Asia/Kolkata' },
        stages: [
          { id: 'finish', dependsOn: ['prepare'] },
          { id: 'prepare' },
          { id: 'independent' },
        ],
      },
    },
  });

  assert.deepEqual(plans.demo.order, ['prepare', 'finish', 'independent']);
  assert.deepEqual(plans.demo.stages.map((stage) => stage.identity), [
    'demo.prepare', 'demo.finish', 'demo.independent',
  ]);
});

test('rejects missing, disabled, duplicate, and cyclic stage dependencies', () => {
  assert.throws(() => validateStageDependencies([
    { id: 'consumer', dependsOn: ['missing'] },
  ]), /missing dependency/i);

  assert.throws(() => validateStageDependencies([
    { id: 'source', enabled: false },
    { id: 'consumer', dependsOn: ['source'] },
  ]), /disabled dependency/i);

  assert.throws(() => validateStageDependencies([
    { id: 'same' }, { id: 'same' },
  ]), /duplicate stage/i);

  assert.throws(() => validateStageDependencies([
    { id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] },
  ]), /cycle/i);
});

test('builds the complete morning plan with cadence, identities, dependencies, and safe handoff flags', () => {
  const { morning } = buildSchedulePlans();

  assert.equal(morning.schemaVersion, 'LaunchpadCrawlerSchedulePlanV1');
  assert.deepEqual(morning.cadence, {
    kind: 'daily', timezone: 'Asia/Kolkata', window: { start: '04:30', end: '07:30' },
  });
  assert.deepEqual(morning.order, [
    'ats-warm', 'ats-expanded', 'career-pages', 'brave-startup',
    'connector-imports', 'normalize-verify', 'selection',
  ]);
  assert.equal(morning.stages.find((stage) => stage.id === 'normalize-verify').dependsOn.length, 5);
  assert.deepEqual(morning.safety, { network: false, scheduling: false, autoApply: false });
});

test('builds a lightweight midday plan with only refresh, connector, and processing stages', () => {
  const { midday } = buildSchedulePlans();

  assert.deepEqual(midday.cadence, {
    kind: 'daily', timezone: 'Asia/Kolkata', at: '12:30',
  });
  assert.deepEqual(midday.order, [
    'ats-refresh', 'career-pages-refresh', 'connector-imports', 'normalize-verify', 'selection',
  ]);
  assert.equal(midday.stages.some((stage) => stage.id === 'brave-startup'), false);
  assert.equal(midday.stages.find((stage) => stage.id === 'selection').dependsOn[0], 'normalize-verify');
});

test('disabled stages are omitted and cannot silently leave an enabled dependent runnable', () => {
  const plans = buildSchedulePlans({
    schedules: {
      morning: { stages: { 'brave-startup': { enabled: false } } },
    },
  });

  assert.equal(plans.morning.order.includes('brave-startup'), false);
  assert.equal(plans.morning.order.includes('normalize-verify'), false);
  assert.equal(plans.morning.order.includes('selection'), false);
  assert.ok(plans.morning.disabledStageIds.includes('brave-startup'));
});

test('serialization is deterministic and contains no executable scheduling hooks', () => {
  const first = serializeSchedulePlans(buildSchedulePlans(DEFAULT_SCHEDULE_CONFIG));
  const second = serializeSchedulePlans(buildSchedulePlans(DEFAULT_SCHEDULE_CONFIG));

  assert.equal(first, second);
  assert.deepEqual(Object.keys(JSON.parse(first)), ['schemaVersion', 'plans']);
  assert.doesNotMatch(first, /setTimeout|setInterval|fetch\(/i);
});

test('executes enabled stages in dependency order and skips blocked dependents', async () => {
  const plan = buildSchedulePlans().morning;
  const calls = [];
  const result = await executeSchedulePlan(plan, {
    handlers: Object.fromEntries(plan.stages.map((stage) => [stage.id, async () => {
      calls.push(stage.id);
      if (stage.id === 'connector-imports') throw new Error('connector unavailable');
      return { status: 'completed' };
    }])),
  });

  assert.deepEqual(calls, ['ats-warm', 'ats-expanded', 'career-pages', 'brave-startup', 'connector-imports']);
  assert.equal(result.stages['connector-imports'].status, 'failed');
  assert.equal(result.stages['normalize-verify'].status, 'blocked');
  assert.equal(result.stages.selection.status, 'blocked');
  assert.equal(result.status, 'degraded');
});
