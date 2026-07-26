import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDailyNormal } from '../../crawler/daily-runner.mjs';
import { buildSourcePlans } from '../../crawler/operator.mjs';
import { openCrawlerStore } from '../../crawler/run.mjs';

function fixtureConfig(root) {
  const reverseWarmSetPath = path.join(root, 'reverse-warm-set.json');
  writeFileSync(reverseWarmSetPath, JSON.stringify({ boards: {} }));
  return {
    schemaVersion: 'LaunchpadCrawlerConfigV1',
    databasePath: path.join(root, 'crawler.sqlite'),
    reverseWarmSetPath,
    sources: {
      atsBatch1: { boards: [] },
      atsBatch2: { boards: [{ provider: 'pinpoint', slug: 'morning-only' }] },
      enterprise: { boards: [{ provider: 'workday', board: 'morning-only' }] },
      careerSites: [],
      brave: { enabled: false },
      indeed: { enabled: false },
      indiaStartup: { enabled: false },
      commercialRescue: { enabled: false },
    },
  };
}

test('daily run propagates the profile and reuses one deterministic identity', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-run-identity-'));
  const config = fixtureConfig(root);
  const options = {
    config,
    clock: { now: () => '2026-07-24T00:30:00.000Z' },
    schedule: 'midday',
    mode: 'normal',
    locationPreset: 'pune',
    scorer: null,
  };

  const first = await runDailyNormal(options);
  const second = await runDailyNormal(options);

  assert.equal(first.crawlerV2Profile.schedule, 'midday');
  assert.equal(first.crawlerV2Profile.locationPreset, 'pune');
  assert.equal(first.crawlerV2Operator.profile.mode, 'normal');
  assert.equal(first.crawlerV2Run.runId, second.crawlerV2Run.runId);
  assert.equal(first.crawlerV2Run.runId, 'midday-2026-07-24-crawler-v2');

  const store = openCrawlerStore(config.databasePath);
  try {
    assert.equal(store.prepare('SELECT COUNT(*) AS count FROM crawl_runs WHERE schedule = ?').get('midday').count, 1);
  } finally {
    store.close();
  }
});

test('midday source plans exclude morning-only lanes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-midday-plan-'));
  const config = fixtureConfig(root);
  const plans = buildSourcePlans({
    config,
    transport: async () => ({ status: 200, body: '' }),
    runAt: '2026-07-24T07:00:00.000Z',
    clock: { now: () => '2026-07-24T07:00:00.000Z' },
    schedule: 'midday',
    profile: { mode: 'normal', locationPreset: 'pune', schedule: 'midday' },
  });

  assert.equal(plans.some((plan) => ['ats-batch-2', 'ats-enterprise', 'brave-search', 'india-startup'].includes(plan.id)), false);
});
