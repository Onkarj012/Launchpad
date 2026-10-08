import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCrawlerConfig } from '../../crawler/operator.mjs';
import { cloneJsonSafe, persistedCrawlerConfig, startCrawlRun, openCrawlerStore } from '../../crawler/run.mjs';

test('production registry config starts a durable run without changing global JSON limits', () => {
  const { config } = loadCrawlerConfig('config/crawler-v2.json');
  assert.throws(() => cloneJsonSafe(config), /JSON size limit/);
  const store = openCrawlerStore(':memory:');
  try {
    const { run } = startCrawlRun(store, { runId: 'production-config-proof', config });
    assert.deepEqual(run.config.sources, config.sources);
    assert.equal(run.config.boardRegistry.boardCount, config.boardRegistry.boards.length);
    assert.match(run.config.boardRegistry.fingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(run.config.boardRegistry.boards, undefined);
    assert.deepEqual(persistedCrawlerConfig(config), run.config);
    const changed = structuredClone(config);
    changed.boardRegistry.boards[0].company += ' changed';
    assert.notEqual(persistedCrawlerConfig(changed).boardRegistry.fingerprint, run.config.boardRegistry.fingerprint);
    assert.throws(() => startCrawlRun(store, { runId: 'production-config-proof', config: changed }), /registry fingerprint changed/);
  } finally { store.close(); }
});

test('persisted config rejects oversized settings, registry entries, collections, and cycles before DB access', () => {
  const cycle = {}; cycle.self = cycle;
  const huge = Array(10_001).fill(0);
  const cases = [
    { arbitrary: huge }, { arbitrary: cycle },
    { boardRegistry: { boards: [cycle] } },
    { boardRegistry: { boards: [huge] } },
    { boardRegistry: { boards: Array(1001).fill({ id: 'x' }) } },
    { boardRegistry: { boards: [{ description: 'x'.repeat(2_000_001) }] } },
    { boardRegistry: { boards: [], metadata: cycle } },
  ];
  for (const config of cases) {
    assert.throws(() => startCrawlRun({ prepare() { assert.fail('DB accessed'); } }, { runId: 'invalid', config }), /limit|cycle/);
  }
});
