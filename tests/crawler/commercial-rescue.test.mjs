import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommercialRescue } from '../../crawler/commercial-rescue.mjs';

const NOW = '2026-07-23T12:00:00.000Z';
const record = (id, overrides = {}) => ({
  canonicalUrl: `https://commercial.example.test/${id}`,
  title: `AI Engineer ${id}`,
  company: `Company ${id}`,
  location: 'Pune, India',
  postedAt: NOW,
  ...overrides,
});

test('a healthy verified free reserve does not invoke commercial rescue', async () => {
  let calls = 0;
  const result = await runCommercialRescue({
    enabled: true,
    freeLanesComplete: true,
    verifiedReserve: 12,
    source: async () => { calls += 1; return { records: [record('unused')] }; },
  });

  assert.equal(calls, 0);
  assert.equal(result.status, 'not-invoked');
  assert.equal(result.invoked, false);
  assert.equal(result.shortfall.before, 0);
});

test('a verified free shortfall invokes 24-hour inventory before seven-day expansion', async () => {
  const requests = [];
  const result = await runCommercialRescue({
    enabled: true,
    freeLanesComplete: true,
    verifiedReserve: 10,
    now: NOW,
    source: async (request) => {
      requests.push(request);
      return request.windowHours === 24
        ? { actorId: 'commercial-actor', records: [record('fresh')] }
        : { actorId: 'commercial-actor', records: [record('week')] };
    },
  });

  assert.deepEqual(requests.map((request) => request.windowHours), [24, 168]);
  assert.equal(requests[0].filters.country, 'India');
  assert.equal(requests[0].filters.city, 'Pune');
  assert.equal(result.records.length, 2);
  assert.equal(result.shortfall.before, 2);
  assert.equal(result.shortfall.after, 0);
  assert.equal(result.noAutoApply, true);
});

test('record and cost caps are applied across windows and agency exclusion is requested when supported', async () => {
  const requests = [];
  const result = await runCommercialRescue({
    enabled: true,
    freeLanesComplete: true,
    verifiedReserve: 0,
    now: NOW,
    maxRecords: 2,
    maxCostUsd: 1,
    source: {
      actorId: 'bounded-actor',
      supportsAgencyExclusion: true,
      async fetch(request) {
        requests.push(request);
        return { costUsd: 0.6, records: requests.length === 1
          ? [record('one')]
          : [record('agency', { isAgency: true }), record('two')] };
      },
    },
  });

  assert.equal(requests[0].excludeAgencies, true);
  assert.equal(result.records.length, 2);
  assert.equal(result.telemetry.recordsAccepted, 2);
  assert.equal(result.telemetry.costUsd, 1);
  assert.equal(result.telemetry.recordCap, 2);
  assert.equal(result.telemetry.costCapUsd, 1);
  assert.equal(result.telemetry.costCapReached, true);
});

test('unsupported agency exclusion is not falsely claimed and non-target records are filtered', async () => {
  const requests = [];
  const result = await runCommercialRescue({
    enabled: true,
    freeLanesComplete: true,
    verifiedReserve: 11,
    now: NOW,
    source: {
      actorId: 'plain-actor',
      async fetch(request) {
        requests.push(request);
        return { records: [record('pune'), record('delhi', { location: 'Delhi, India' }), record('us', { location: 'New York, USA' })] };
      },
    },
  });

  assert.equal(requests[0].excludeAgencies, undefined);
  assert.deepEqual(result.records.map((item) => item.canonicalUrl), ['https://commercial.example.test/pune']);
});

test('a failed 24-hour call degrades safely and attempts the seven-day fallback', async () => {
  const windows = [];
  const result = await runCommercialRescue({
    enabled: true,
    freeLanesComplete: true,
    verifiedReserve: 11,
    now: NOW,
    source: async ({ windowHours }) => {
      windows.push(windowHours);
      if (windowHours === 24) throw new Error('actor timeout');
      return { records: [record('fallback')], costUsd: 0.25 };
    },
  });

  assert.deepEqual(windows, [24, 168]);
  assert.equal(result.status, 'degraded');
  assert.equal(result.records.length, 1);
  assert.equal(result.failures[0].windowHours, 24);
  assert.equal(result.telemetry.actors[0].status, 'failed');
  assert.equal(result.telemetry.actors[1].status, 'succeeded');
  assert.equal(result.shortfall.after, 0);
});

test('disabled rescue and incomplete free lanes never call the injected source', async () => {
  let calls = 0;
  const source = async () => { calls += 1; return { records: [] }; };
  const disabled = await runCommercialRescue({ enabled: false, freeLanesComplete: true, verifiedReserve: 0, source });
  const incomplete = await runCommercialRescue({ enabled: true, freeLanesComplete: false, verifiedReserve: 0, source });

  assert.equal(calls, 0);
  assert.equal(disabled.status, 'disabled');
  assert.equal(incomplete.status, 'free-lanes-incomplete');
});
