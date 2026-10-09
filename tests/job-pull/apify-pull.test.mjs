import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPath, mapItem, validateConfig, RunError, buildPreflight, parseArgs, pullAll, readConfig, selectProfiles } from '../../job-pull/apify-pull.mjs';
import { emptyApifySeenCache, loadApifySeenCache, saveApifySeenCache } from '../../job-pull/apify-seen-cache.mjs';
import { budgetBlockReason, emptyApifyBudgetState, loadApifyBudgetState, saveApifyBudgetState } from '../../job-pull/apify-budget-state.mjs';
import { prepareApifyRecords } from '../../job-pull/apify-prepare.mjs';
import { prepare } from '../../job-pull/public-search-prepare.mjs';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { runV5Workflow } from '../../job-pull/workflow.mjs';

const CONFIG = readConfig('config/apify.json');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function successfulFetch(items = []) {
  return async (url, options) => {
    if (options?.method === 'POST') return response({ data: { id: 'run-1', status: 'RUNNING' } });
    if (url.includes('/actor-runs/')) return response({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'dataset-1' } });
    return response(items);
  };
}

test('readPath resolves dot-paths, including nested objects and missing keys', () => {
  assert.equal(readPath({ a: { b: { c: 'x' } } }, 'a.b.c'), 'x');
  assert.equal(readPath({ a: 1 }, 'a.b.c'), undefined);
  assert.equal(readPath({ jobUrl: 'https://example.test/1' }, 'jobUrl'), 'https://example.test/1');
});

test('mapItem shapes a raw dataset item into the RAW record contract', () => {
  const fieldMap = {
    url: 'jobUrl',
    company: 'companyName',
    title: 'jobTitle',
    postedAt: 'publishedAt',
    location: 'location',
    description: 'jobDescription',
  };
  const item = {
    jobUrl: 'https://example.test/job/1',
    companyName: 'Acme',
    jobTitle: 'AI Engineer',
    publishedAt: '2026-07-14T00:00:00.000Z',
    location: 'Pune, India',
    jobDescription: 'Build things.',
  };
  const record = mapItem(item, fieldMap, 'linkedin');
  assert.equal(record.url, 'https://example.test/job/1');
  assert.equal(record.company, 'Acme');
  assert.equal(record.title, 'AI Engineer');
  assert.equal(record.postedAt, '2026-07-14T00:00:00.000Z');
  assert.equal(record.location, 'Pune, India');
  assert.equal(record.description, 'Build things.');
  assert.equal(record.sourceKind, 'aggregator');
  assert.equal(record.source, 'apify-linkedin');

  // missing item / fieldMap short-circuit to null
  assert.equal(mapItem(null, fieldMap, 'linkedin'), null);
  assert.equal(mapItem(item, null, 'linkedin'), null);
});

test('mapItem preserves optional application and work-condition fields only when mapped', () => {
  const record = mapItem({
    url: 'https://example.test/1', company: 'Acme', title: 'AI Engineer', original: 'https://jobs.acme.test/1', salary: '₹10 LPA',
  }, {
    url: 'url', company: 'company', title: 'title', originalApplicationUrl: 'original', salary: 'salary',
  }, 'naukri');
  assert.equal(record.originalApplicationUrl, 'https://jobs.acme.test/1');
  assert.equal(record.salary, '₹10 LPA');
  assert.equal(record.equipment, undefined);
});

test('profile selection is explicit, stable, bounded, and disabled profiles remain invokable', () => {
  assert.deepEqual(parseArgs(['--profile', 'naukri-fresher,hirist-fresher', '--out', 'raw.json']).profiles, ['naukri-fresher', 'hirist-fresher']);
  assert.deepEqual(selectProfiles(CONFIG, []).map((actor) => actor.profile), []);
  assert.deepEqual(selectProfiles(CONFIG, 'naukri-fresher').map((actor) => actor.profile), ['naukri-fresher']);
  assert.equal(selectProfiles(CONFIG, 'naukri-fresher')[0].enabled, false);
  assert.throws(() => selectProfiles(CONFIG, 'not-a-profile'), /unknown Apify rescue profile/);
  assert.equal(CONFIG.actors.some((actor) => ['himalayas', 'remotive', 'we-work-remotely'].includes(actor.label)), false);
});

test('preflight reports expected scope and credit/runtime exposure without executing', () => {
  const preflight = buildPreflight(CONFIG, ['linkedin-jobs', 'naukri-fresher']);
  assert.equal(preflight.status, 'ready');
  assert.deepEqual(preflight.selectedProfiles, ['linkedin-jobs', 'naukri-fresher']);
  assert.equal(preflight.actorRuns, 2);
  assert.equal(preflight.expectedScope.maxRecords, 250);
  assert.equal(preflight.creditRuntimeExposure.tokenRequired, true);
  assert.equal(preflight.creditRuntimeExposure.maxRuntimeSeconds, 1200);
  assert.equal(buildPreflight(CONFIG).status, 'not-invoked');
});

test('mapItem and Apify preparation preserve actor, label, category, discovery URL, and original application provenance', () => {
  const actor = {
    profile: 'naukri-fresher', id: 'blackfalcondata~naukri-jobs-feed', label: 'naukri',
    sourceCategory: 'india-niche', sourceKind: 'niche-public',
    fieldMap: { url: 'portalUrl', discoveryUrl: 'portalUrl', company: 'company', title: 'title', description: 'description' },
  };
  const raw = {
    portalUrl: 'https://naukri.example/jobs/1', company: 'Acme', title: 'AI Engineer', description: 'Build AI.',
    originalApplicationUrl: 'https://careers.acme.example/jobs/1',
    originalApplicationEvidence: 'Employer ATS URL supplied by portal detail.',
  };
  const mapped = mapItem(raw, actor, actor.label);
  assert.equal(mapped.source, 'apify-naukri');
  assert.equal(mapped.actorId, actor.id);
  assert.equal(mapped.actorLabel, 'naukri');
  assert.equal(mapped.sourceCategory, 'india-niche');
  assert.equal(mapped.discoveryUrl, raw.portalUrl);
  assert.equal(mapped.originalApplicationUrl, raw.originalApplicationUrl);
  assert.equal(mapped.originalApplicationEvidence, raw.originalApplicationEvidence);

  const prepared = prepareApifyRecords([{ ...mapped, postedAt: '2026-07-23' }]);
  assert.equal(prepared.skipped.length, 0);
  assert.equal(prepared.kept[0].source, 'apify-naukri');
  assert.equal(prepared.kept[0].actorLabel, 'naukri');
  assert.equal(prepared.kept[0].sourceCategory, 'india-niche');
  assert.equal(prepared.kept[0].discoveryUrl, raw.portalUrl);
  assert.equal(prepared.kept[0].originalApplicationUrl, raw.originalApplicationUrl);
  assert.equal(prepared.kept[0].originalApplicationEvidence, raw.originalApplicationEvidence);
});

test('validateConfig rejects malformed actor entries and accepts a well-formed config', () => {
  assert.throws(() => validateConfig(null), RunError);
  assert.throws(() => validateConfig({ actors: 'nope' }), RunError);
  assert.throws(() => validateConfig({ actors: [{ id: 'x' }] }), RunError); // missing fieldMap
  assert.throws(() => validateConfig({ actors: [{ fieldMap: { url: 'u', company: 'c', title: 't' } }] }), RunError); // missing id
  assert.throws(
    () => validateConfig({ actors: [{ id: 'x', fieldMap: { url: 'u', company: 'c' } }] }),
    RunError,
  ); // missing fieldMap.title

  const good = { actors: [{ id: 'acme~scraper', profile: 'acme-test', label: 'acme', fieldMap: { url: 'u', company: 'c', title: 't' } }] };
  assert.equal(validateConfig(good), good);
});

test('a mapped Apify record passes public-search-prepare.mjs unchanged', () => {
  const fieldMap = {
    url: 'jobUrl',
    company: 'companyName',
    title: 'jobTitle',
    postedAt: 'publishedAt',
    location: 'location',
    description: 'jobDescription',
  };
  const item = {
    jobUrl: 'https://example.test/job/42',
    companyName: 'Acme',
    jobTitle: 'Backend Engineer',
    publishedAt: '2026-07-15',
    location: 'Pune, India',
    jobDescription: 'Ship the backend.',
  };
  const record = mapItem(item, fieldMap, 'linkedin');
  const result = prepare([record]);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].url, 'https://example.test/job/42');
  assert.equal(result.kept[0].company, 'Acme');
  assert.equal(result.kept[0].postedAt, '2026-07-15T00:00:00.000Z');
});

test('selected rescue pull reports honest success telemetry and does not run unselected profiles', async () => {
  let calls = 0;
  const result = await pullAll(CONFIG, 'token-fixture', {
    profile: 'linkedin-jobs',
    fetchImpl: async (...args) => { calls += 1; return successfulFetch([{ jobUrl: 'https://jobs.example/1', companyName: 'Acme', jobTitle: 'AI Engineer', jobDescription: 'Build AI.' }])(...args); },
    pollIntervalMs: 0,
    clock: () => 1000,
    seenCache: emptyApifySeenCache(),
    budgetState: emptyApifyBudgetState(),
  });
  assert.equal(calls, 3);
  assert.equal(result.status, 'ok');
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.summary['linkedin-jobs'], {
    profile: 'linkedin-jobs', actorId: 'cheap_scraper~linkedin-job-scraper', label: 'linkedin', source: 'apify-linkedin',
    sourceCategory: 'india-niche', status: 'ok', fetched: 1, prepared: 1, skippedSeen: 0, eligible: null, eligibleKnown: false,
    latencyMs: 0, failureReason: null,
  });
  assert.equal(result.summary['naukri-fresher'], undefined);
});

test('Apify seen cache round-trips through a file with deduped sorted profile keys', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apify-seen-cache-'));
  const file = path.join(dir, 'nested', 'cache.json');
  try {
    const saved = saveApifySeenCache(file, { profiles: { linkedin: ['b', 'a', 'b', 42] } }, '2026-08-04T00:00:00.000Z');
    assert.deepEqual(saved, {
      schemaVersion: 1,
      updatedAt: '2026-08-04T00:00:00.000Z',
      profiles: { linkedin: ['42', 'a', 'b'] },
    });
    assert.equal(readFileSync(file, 'utf8').endsWith('\n'), true);
    assert.deepEqual(loadApifySeenCache(file), saved);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Apify budget gate allows usage under all caps and reports each cap independently', () => {
  const nowIso = '2026-08-04T00:00:00.000Z';
  const limits = { monthlyBudgetUsd: 5, maxRunsPerMonth: 6, maxRunCostUsd: 0.75 };
  assert.equal(budgetBlockReason({ state: { months: { '2026-08': { runs: 2, spendUsd: 1 } } }, nowIso, estimatedCostUsd: 0.5, ...limits }), null);
  assert.equal(budgetBlockReason({ state: { months: { '2026-08': { runs: 6, spendUsd: 1 } } }, nowIso, estimatedCostUsd: 0, ...limits }), 'MONTHLY_RUN_CAP_EXCEEDED');
  assert.equal(budgetBlockReason({ state: { months: { '2026-08': { runs: 2, spendUsd: 4.75 } } }, nowIso, estimatedCostUsd: 0.5, ...limits }), 'MONTHLY_BUDGET_CAP_EXCEEDED');
  assert.equal(budgetBlockReason({ state: { months: { '2026-08': { runs: 2, spendUsd: 1 } } }, nowIso, estimatedCostUsd: 0.76, ...limits }), 'RUN_COST_CAP_EXCEEDED');
});

test('rescue config sets the ticket run and monthly spend caps', () => {
  assert.equal(CONFIG.rescue.maxRunCostUsd, 1);
  assert.equal(CONFIG.rescue.monthlyBudgetUsd, 15);
  assert.throws(() => validateConfig({ ...CONFIG, rescue: { ...CONFIG.rescue, maxRunCostUsd: 1.01 } }), RunError);
  assert.throws(() => validateConfig({ ...CONFIG, rescue: { ...CONFIG.rescue, monthlyBudgetUsd: 15.01 } }), RunError);
});

test('each Apify actor run sends the hard charge limit to Apify', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options?.method === 'POST') return response({ data: { id: 'run-cap', status: 'SUCCEEDED', defaultDatasetId: 'dataset-cap' } });
    return response([]);
  };
  const config = {
    rescue: { maxProfilesPerRun: 1, runTimeoutSeconds: 1, monthlyBudgetUsd: 15, maxRunsPerMonth: 15, maxRunCostUsd: 1 },
    actors: [{ profile: 'demo', id: 'demo~actor', label: 'demo', fieldMap: { url: 'url', company: 'company', title: 'title' } }],
  };

  await pullAll(config, 'token-fixture', {
    profile: 'demo', fetchImpl, pollIntervalMs: 0, clock: () => '2026-08-04T00:00:00.000Z',
    seenCache: emptyApifySeenCache(), budgetState: emptyApifyBudgetState(),
  });

  assert.equal(new URL(calls[0].url).searchParams.get('maxTotalChargeUsd'), '1');
});

test('monthly budget blocks a rescue run that would exceed fifteen dollars', async () => {
  let calls = 0;
  const budgetState = { ...emptyApifyBudgetState(), months: { '2026-08': { runs: 14, spendUsd: 14.5 } } };
  const result = await pullAll({
    rescue: { maxProfilesPerRun: 1, runTimeoutSeconds: 1, monthlyBudgetUsd: 15, maxRunsPerMonth: 15, maxRunCostUsd: 1 },
    actors: [{ profile: 'demo', id: 'demo~actor', label: 'demo', estimatedCostUsd: 1, fieldMap: { url: 'url', company: 'company', title: 'title' } }],
  }, 'token-fixture', {
    profile: 'demo', fetchImpl: async () => { calls += 1; throw new Error('budget must block before Apify'); },
    clock: () => '2026-08-04T00:00:00.000Z', seenCache: emptyApifySeenCache(), budgetState,
  });

  assert.equal(calls, 0);
  assert.equal(result.summary.demo.failureReason, 'MONTHLY_BUDGET_CAP_EXCEEDED');
});

test('monthly spend uses reported Apify cost when available', async () => {
  const budgetState = emptyApifyBudgetState();
  await pullAll({
    rescue: { maxProfilesPerRun: 1, runTimeoutSeconds: 1, monthlyBudgetUsd: 15, maxRunsPerMonth: 15, maxRunCostUsd: 1 },
    actors: [{ profile: 'demo', id: 'demo~actor', label: 'demo', estimatedCostUsd: 1, fieldMap: { url: 'url', company: 'company', title: 'title' } }],
  }, 'token-fixture', {
    profile: 'demo', fetchImpl: async (url, options) => {
      if (options?.method === 'POST') return response({ data: { id: 'run-cost', status: 'RUNNING' } });
      if (url.includes('/actor-runs/')) return response({ data: { id: 'run-cost', status: 'SUCCEEDED', defaultDatasetId: 'dataset-cost', costUsd: 0.4 } });
      return response([]);
    },
    pollIntervalMs: 0, clock: () => '2026-08-04T00:00:00.000Z',
    seenCache: emptyApifySeenCache(), budgetState,
  });

  assert.equal(budgetState.months['2026-08'].spendUsd, 0.4);
  assert.equal(budgetState.months['2026-08'].estimatedSpendUsd, 1);
});

test('failed and timed out runs with run IDs consume monthly budget, while runs without IDs do not', async () => {
  const config = {
    rescue: { maxProfilesPerRun: 1, runTimeoutSeconds: 1, monthlyBudgetUsd: 15, maxRunsPerMonth: 15, maxRunCostUsd: 1 },
    actors: [{ profile: 'demo', id: 'demo~actor', label: 'demo', estimatedCostUsd: 0.8, fieldMap: { url: 'url', company: 'company', title: 'title' } }],
  };
  const nowIso = '2026-08-04T00:00:00.000Z';
  const failedBudget = emptyApifyBudgetState();
  const failed = await pullAll(config, 'token-fixture', {
    profile: 'demo', fetchImpl: async (url, options) => options?.method === 'POST'
      ? response({ data: { id: 'failed-run', status: 'RUNNING' } })
      : response({ data: { id: 'failed-run', status: 'FAILED' } }),
    pollIntervalMs: 0, clock: () => nowIso, seenCache: emptyApifySeenCache(), budgetState: failedBudget,
  });
  assert.equal(failed.summary.demo.status, 'failed');
  assert.equal(failedBudget.months['2026-08'].runs, 1);
  assert.equal(failedBudget.months['2026-08'].spendUsd, 0.8);

  let clock = Date.parse(nowIso);
  const timedOutBudget = emptyApifyBudgetState();
  const timedOut = await pullAll(config, 'token-fixture', {
    profile: 'demo', fetchImpl: async (url, options) => options?.method === 'POST'
      ? response({ data: { id: 'timed-out-run', status: 'RUNNING' } })
      : response({ data: { id: 'timed-out-run', status: 'RUNNING' } }),
    pollIntervalMs: 0, runTimeoutMs: 1, clock: () => ++clock, seenCache: emptyApifySeenCache(), budgetState: timedOutBudget,
  });
  assert.equal(timedOut.summary.demo.failureReason, 'timeout');
  assert.equal(timedOutBudget.months['2026-08'].runs, 1);
  assert.equal(timedOutBudget.months['2026-08'].spendUsd, 0.8);

  const noIdBudget = emptyApifyBudgetState();
  await pullAll(config, 'token-fixture', {
    profile: 'demo', fetchImpl: async () => response({ data: { status: 'FAILED' } }),
    clock: () => nowIso, seenCache: emptyApifySeenCache(), budgetState: noIdBudget,
  });
  assert.equal(noIdBudget.months['2026-08'], undefined);
});

test('failed Apify run usage still blocks the next run cap check', async () => {
  let calls = 0;
  const budgetState = emptyApifyBudgetState();
  const config = {
    rescue: { maxProfilesPerRun: 1, runTimeoutSeconds: 1, monthlyBudgetUsd: 15, maxRunsPerMonth: 1, maxRunCostUsd: 1 },
    actors: [{ profile: 'demo', id: 'demo~actor', label: 'demo', estimatedCostUsd: 1, fieldMap: { url: 'url', company: 'company', title: 'title' } }],
  };
  await pullAll(config, 'token-fixture', {
    profile: 'demo', fetchImpl: async (url, options) => {
      calls += 1;
      return options?.method === 'POST'
        ? response({ data: { id: 'capped-failure', status: 'RUNNING' } })
        : response({ data: { id: 'capped-failure', status: 'FAILED' } });
    },
    pollIntervalMs: 0, clock: () => '2026-08-04T00:00:00.000Z', seenCache: emptyApifySeenCache(), budgetState,
  });
  const next = await pullAll(config, 'token-fixture', {
    profile: 'demo', fetchImpl: async () => { calls += 1; throw new Error('run cap must block before Apify'); },
    clock: () => '2026-08-04T00:00:00.000Z', seenCache: emptyApifySeenCache(), budgetState,
  });
  const costLimited = await pullAll({
    rescue: { ...config.rescue, maxRunsPerMonth: 15, monthlyBudgetUsd: 1 },
    actors: [{ ...config.actors[0], estimatedCostUsd: 0.5 }],
  }, 'token-fixture', {
    profile: 'demo', fetchImpl: async () => { calls += 1; throw new Error('dollar cap must block before Apify'); },
    clock: () => '2026-08-04T00:00:00.000Z', seenCache: emptyApifySeenCache(), budgetState,
  });

  assert.equal(calls, 2);
  assert.equal(next.summary.demo.failureReason, 'MONTHLY_RUN_CAP_EXCEEDED');
  assert.equal(costLimited.summary.demo.failureReason, 'MONTHLY_BUDGET_CAP_EXCEEDED');
});

test('pullAll blocks an actor at the monthly run cap without calling Apify', async () => {
  let calls = 0;
  const budgetState = { ...emptyApifyBudgetState(), months: { '2026-08': { runs: 6, spendUsd: 0 } } };
  const result = await pullAll({
    rescue: { maxProfilesPerRun: 1, runTimeoutSeconds: 1, monthlyBudgetUsd: 5, maxRunsPerMonth: 6, maxRunCostUsd: 0.75 },
    actors: [{ profile: 'demo', id: 'demo~actor', label: 'demo', estimatedCostUsd: 0.5, enabled: false, fieldMap: { url: 'url', company: 'company', title: 'title' } }],
  }, 'token-fixture', {
    profile: 'demo',
    fetchImpl: async () => { calls += 1; throw new Error('must not call Apify'); },
    clock: () => '2026-08-04T00:00:00.000Z',
    seenCache: emptyApifySeenCache(),
    budgetState,
  });
  assert.equal(calls, 0);
  assert.equal(result.summary.demo.status, 'unavailable');
  assert.equal(result.summary.demo.failureReason, 'MONTHLY_RUN_CAP_EXCEEDED');
});

test('pullAll records a successful actor run in injected Apify budget state', async () => {
  const budgetState = emptyApifyBudgetState();
  await pullAll({
    rescue: { maxProfilesPerRun: 1, runTimeoutSeconds: 1, monthlyBudgetUsd: 5, maxRunsPerMonth: 6, maxRunCostUsd: 0.75 },
    actors: [{ profile: 'demo', id: 'demo~actor', label: 'demo', estimatedCostUsd: 0.5, enabled: false, fieldMap: { url: 'url', company: 'company', title: 'title' } }],
  }, 'token-fixture', {
    profile: 'demo',
    fetchImpl: successfulFetch([{ url: 'https://jobs.example/new', company: 'Acme', title: 'AI Engineer' }]),
    pollIntervalMs: 0,
    clock: () => '2026-08-04T00:00:00.000Z',
    seenCache: emptyApifySeenCache(),
    budgetState,
  });
  assert.equal(budgetState.months['2026-08'].runs, 1);
  assert.equal(budgetState.months['2026-08'].spendUsd, 0.5);
});

test('Apify dataset retrieval is hard-capped, paginates from persisted offset, and reconciles estimated versus actual usage', async () => {
  const config = {
    rescue: { maxProfilesPerRun: 1, maxReturnedItemsPerProfile: 2, runTimeoutSeconds: 1, monthlyBudgetUsd: 5, maxRunsPerMonth: 6, maxRunCostUsd: 0.75 },
    actors: [{ profile: 'demo', id: 'demo~actor', label: 'demo', estimatedCostUsd: 0.5, enabled: false, input: { maxItems: 5 }, fieldMap: { url: 'url', company: 'company', title: 'title' } }],
  };
  const budgetState = emptyApifyBudgetState();
  const seenCache = emptyApifySeenCache();
  const offsets = [];
  const fetchImpl = async (url, options) => {
    if (options?.method === 'POST') return response({ data: { id: 'run-1', status: 'RUNNING' } });
    if (url.includes('/actor-runs/')) return response({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'dataset-1', costUsd: 0.2 } });
    const offset = Number(new URL(url).searchParams.get('offset'));
    offsets.push(offset);
    const items = offset === 0
      ? [1, 2, 3].map((id) => ({ url: `https://jobs.example/${id}`, company: 'Acme', title: `Engineer ${id}` }))
      : [{ url: 'https://jobs.example/3', company: 'Acme', title: 'Engineer 3' }];
    return response(items);
  };
  const first = await pullAll(config, 'token-fixture', { profile: 'demo', fetchImpl, pollIntervalMs: 0, clock: () => '2026-08-04T00:00:00.000Z', seenCache, budgetState });
  assert.equal(first.records.length, 2);
  assert.deepEqual(offsets, [0]);
  assert.equal(budgetState.retrieval.demo.nextOffset, 2);
  assert.equal(budgetState.months['2026-08'].estimatedItems, 5);
  assert.equal(budgetState.months['2026-08'].actualItems, 2);
  assert.equal(budgetState.months['2026-08'].actualSpendUsd, 0.2);

  const second = await pullAll(config, 'token-fixture', { profile: 'demo', fetchImpl, pollIntervalMs: 0, clock: () => '2026-08-04T00:00:00.000Z', seenCache, budgetState });
  assert.equal(second.records.length, 1);
  assert.deepEqual(offsets, [0, 2]);
  assert.equal(budgetState.retrieval.demo.lastOffset, 2);
  assert.equal(budgetState.retrieval.demo.nextOffset, 3);
});

test('Apify budget state round-trips through a temp file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apify-budget-state-'));
  const file = path.join(dir, 'nested', 'budget.json');
  const state = {
    ...emptyApifyBudgetState(),
    months: { '2026-08': { runs: 2, spendUsd: 1.5 } },
  };
  try {
    const saved = saveApifyBudgetState(file, state, '2026-08-04T00:00:00.000Z');
    assert.deepEqual(loadApifyBudgetState(file), saved);
    assert.equal(readFileSync(file, 'utf8').endsWith('\n'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pullAll filters prior seen records while retaining fetched and skippedSeen telemetry', async () => {
  const config = {
    rescue: { maxProfilesPerRun: 1, runTimeoutSeconds: 1 },
    actors: [{ profile: 'demo', id: 'demo~actor', label: 'demo', enabled: false, fieldMap: { url: 'url', company: 'company', title: 'title' } }],
  };
  const seenCache = { ...emptyApifySeenCache(), profiles: { demo: ['https://jobs.example/seen'] } };
  const result = await pullAll(config, 'token-fixture', {
    profile: 'demo',
    fetchImpl: successfulFetch([
      { url: 'https://jobs.example/seen', company: 'Acme', title: 'Seen Engineer' },
      { url: 'https://jobs.example/new', company: 'Acme', title: 'New Engineer' },
    ]),
    pollIntervalMs: 0,
    clock: () => 1000,
    seenCache,
    budgetState: emptyApifyBudgetState(),
  });
  assert.deepEqual(result.records.map((record) => record.url), ['https://jobs.example/new']);
  assert.equal(result.summary.demo.fetched, 2);
  assert.equal(result.summary.demo.prepared, 1);
  assert.equal(result.summary.demo.skippedSeen, 1);
});

test('pullAll mutates an injected seen cache and does not write its cache path', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apify-seen-cache-'));
  const cachePath = path.join(dir, 'cache.json');
  const seenCache = emptyApifySeenCache();
  const cacheReference = seenCache;
  try {
    await pullAll({
      rescue: { maxProfilesPerRun: 1, runTimeoutSeconds: 1 },
      actors: [{ profile: 'demo', id: 'demo~actor', label: 'demo', enabled: false, fieldMap: { url: 'url', company: 'company', title: 'title' } }],
    }, 'token-fixture', {
      profile: 'demo',
      fetchImpl: successfulFetch([{ url: 'https://jobs.example/new', company: 'Acme', title: 'New Engineer' }]),
      pollIntervalMs: 0,
      clock: () => 1000,
      seenCachePath: cachePath,
      seenCache,
      budgetState: emptyApifyBudgetState(),
    });
    assert.strictEqual(seenCache, cacheReference);
    assert.deepEqual(seenCache.profiles.demo, ['https://jobs.example/new']);
    assert.equal(existsSync(cachePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pullAll lets every record through with a fresh empty seen cache', async () => {
  const seenCache = emptyApifySeenCache();
  const result = await pullAll({
    rescue: { maxProfilesPerRun: 1, runTimeoutSeconds: 1 },
    actors: [{ profile: 'demo', id: 'demo~actor', label: 'demo', enabled: false, fieldMap: { url: 'url', company: 'company', title: 'title' } }],
  }, 'token-fixture', {
    profile: 'demo',
    fetchImpl: successfulFetch([
      { url: 'https://jobs.example/one', company: 'Acme', title: 'One Engineer' },
      { url: 'https://jobs.example/two', company: 'Acme', title: 'Two Engineer' },
    ]),
    pollIntervalMs: 0,
    clock: () => 1000,
    seenCache,
    budgetState: emptyApifyBudgetState(),
  });
  assert.equal(result.records.length, 2);
  assert.equal(result.summary.demo.skippedSeen, 0);
  assert.equal(result.summary.demo.prepared, 2);
});

test('duplicate actor IDs never cause a second Apify call and remain visible as degraded', async () => {
  const config = {
    rescue: { maxProfilesPerRun: 3, runTimeoutSeconds: 1 },
    actors: [
      { profile: 'one', id: 'same~actor', label: 'one', enabled: false, fieldMap: { url: 'url', company: 'company', title: 'title' } },
      { profile: 'two', id: 'same~actor', label: 'two', enabled: false, fieldMap: { url: 'url', company: 'company', title: 'title' } },
    ],
  };
  let calls = 0;
  const result = await pullAll(config, 'token-fixture', {
    profiles: ['one', 'two'],
    fetchImpl: async (...args) => { calls += 1; return successfulFetch([{ url: 'https://jobs.example/1', company: 'Acme', title: 'AI Engineer' }])(...args); },
    pollIntervalMs: 0,
    clock: () => 1000,
    seenCache: emptyApifySeenCache(),
    budgetState: emptyApifyBudgetState(),
  });
  assert.equal(calls, 3);
  assert.equal(result.status, 'degraded');
  assert.equal(result.summary.two.status, 'not-run');
  assert.equal(result.summary.two.failureReason, 'duplicate-actor-id');
});

test('missing token is unavailable, nonfatal, and makes no Apify calls', async () => {
  let calls = 0;
  const result = await pullAll(CONFIG, null, {
    profile: 'foundit-fresher',
    fetchImpl: async () => { calls += 1; throw new Error('must not call Apify'); },
    seenCache: emptyApifySeenCache(),
    budgetState: emptyApifyBudgetState(),
  });
  assert.equal(calls, 0);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.summary['foundit-fresher'].status, 'unavailable');
  assert.equal(result.summary['foundit-fresher'].failureReason, 'missing-token');
});

test('timeout and partial actor failure are reported without hiding a healthy actor', async () => {
  const timeoutConfig = {
    rescue: { maxProfilesPerRun: 3, runTimeoutSeconds: 1 },
    actors: [{ profile: 'slow', id: 'slow~actor', label: 'slow', enabled: false, fieldMap: { url: 'url', company: 'company', title: 'title' } }],
  };
  let time = 0;
  const timeout = await pullAll(timeoutConfig, 'token-fixture', {
    profile: 'slow',
    fetchImpl: async (url, options) => options?.method === 'POST'
      ? response({ data: { id: 'slow-run', status: 'RUNNING' } })
      : response({ data: { id: 'slow-run', status: 'RUNNING' } }),
    pollIntervalMs: 0,
    runTimeoutMs: 1000,
    clock: () => { const value = time; time += 1000; return value; },
    seenCache: emptyApifySeenCache(),
    budgetState: emptyApifyBudgetState(),
  });
  assert.equal(timeout.status, 'failed');
  assert.equal(timeout.summary.slow.failureReason, 'timeout');

  const partialConfig = {
    rescue: { maxProfilesPerRun: 3, runTimeoutSeconds: 1 },
    actors: [
      { profile: 'broken', id: 'broken~actor', label: 'broken', enabled: false, fieldMap: { url: 'url', company: 'company', title: 'title' } },
      { profile: 'healthy', id: 'healthy~actor', label: 'healthy', enabled: false, fieldMap: { url: 'url', company: 'company', title: 'title' } },
    ],
  };
  const partial = await pullAll(partialConfig, 'token-fixture', {
    profiles: ['broken', 'healthy'],
    fetchImpl: async (url, options) => options?.method === 'POST' && url.includes('broken')
      ? response({ error: 'credits exhausted' }, 402)
      : successfulFetch([{ url: 'https://jobs.example/2', company: 'Acme', title: 'Backend Engineer' }])(url, options),
    pollIntervalMs: 0,
    clock: () => 1000,
    seenCache: emptyApifySeenCache(),
    budgetState: emptyApifyBudgetState(),
  });
  assert.equal(partial.status, 'degraded');
  assert.equal(partial.summary.broken.failureReason, 'api-failure');
  assert.equal(partial.summary.healthy.status, 'ok');
  assert.equal(partial.records.length, 1);
});

test('dataset schema drift is a failed actor result, never a successful empty run', async () => {
  const config = {
    rescue: { maxProfilesPerRun: 1, runTimeoutSeconds: 1 },
    actors: [{ profile: 'drifted', id: 'drifted~actor', label: 'drifted', enabled: false, fieldMap: { url: 'url', company: 'company', title: 'title' } }],
  };
  const result = await pullAll(config, 'token-fixture', {
    profile: 'drifted',
    fetchImpl: async (url, options) => options?.method === 'POST'
      ? response({ data: { id: 'drift-run', status: 'SUCCEEDED', defaultDatasetId: 'drift-dataset' } })
      : response({ unexpected: 'object' }),
    pollIntervalMs: 0,
    clock: () => '2026-07-23T06:30:00.000Z',
    seenCache: emptyApifySeenCache(),
    budgetState: emptyApifyBudgetState(),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.records.length, 0);
  assert.equal(result.summary.drifted.failureReason, 'schema-drift');
});

test('daily normal/startup/remote contracts do not need a token or make Apify calls', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('daily mode must not call Apify'); };
  const candidate = normalizeCandidate({
    url: 'https://jobs.example/1', company: 'Acme', title: 'AI Engineer', location: 'Pune',
    postedAt: '2026-07-23T00:00:00.000Z', source: 'fixture', sourceKind: 'ats-direct', provider: 'greenhouse',
    employment: { type: 'full-time' }, experience: { minYears: 0, maxYears: 1 }, liveness: { status: 'Active', evidence: 'fixture' },
  });
  try {
    for (const mode of ['normal', 'startup', 'remote']) {
      const result = runV5Workflow({ mode, clock: () => '2026-07-23T06:30:00.000Z', sourceResults: [{ candidates: [candidate], manifest: { sourceId: `fixture-${mode}`, errors: [] } }] });
      assert.equal(result.mode, mode);
      assert.equal(result.outcome.fatal, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});
