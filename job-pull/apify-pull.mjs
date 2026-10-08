#!/usr/bin/env node

/**
 * Optional, explicitly invoked Apify rescue pull.
 *
 * This module is deliberately not imported by the daily mode runners. A rescue
 * run must name one or more stable profiles with --profile; an empty selection
 * performs no network work and does not require APIFY_TOKEN.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_APIFY_SEEN_CACHE_PATH,
  loadApifySeenCache,
  saveApifySeenCache,
  seenKeyFor,
} from './apify-seen-cache.mjs';
import {
  DEFAULT_APIFY_BUDGET_STATE_PATH,
  loadApifyBudgetState,
  saveApifyBudgetState,
  budgetBlockReason,
  recordApifyRun,
} from './apify-budget-state.mjs';

export class RunError extends Error {
  constructor(message, code = 'run-error') {
    super(message);
    this.name = 'RunError';
    this.code = code;
  }
}

export const API_BASE = 'https://api.apify.com/v2';
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_RETURNED_ITEMS = 250;
const MAX_RESCUE_MONTHLY_BUDGET_USD = 15;
const MAX_RESCUE_RUN_COST_USD = 1;
const NATIVE_REMOTE_LABELS = new Set(['himalayas', 'remotive', 'we-work-remotely']);

function parseValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function parseValues(args, name) {
  return args.flatMap((value, index) => value === name ? String(args[index + 1] ?? '').split(',') : [])
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const profiles = parseValues(argv, '--profile');
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    out: parseValue(argv, '--out'),
    config: parseValue(argv, '--config', 'config/apify.json'),
    profile: profiles[0] || null,
    profiles,
  };
}

export const HELP = `Usage: node job-pull/apify-pull.mjs --profile <stable-name>[,<stable-name>...] --out RAW.json [--config config/apify.json]

Runs only explicitly selected, disabled-by-default Apify rescue profiles. The
preflight report is printed before execution. No profile means no Apify call;
selected profiles require APIFY_TOKEN. Feed RAW.json through the Apify-specific
preparation seam before the shared candidate pipeline.`;

/** Read a dot-path value off a nested object; returns undefined if missing. */
export function readPath(obj, dotPath) {
  if (!dotPath) return undefined;
  return String(dotPath).split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

function actorAndFieldMap(fieldMapOrActor, metadata = {}) {
  const actor = fieldMapOrActor?.fieldMap ? fieldMapOrActor : metadata.actor || {};
  return { actor, fieldMap: fieldMapOrActor?.fieldMap ? fieldMapOrActor.fieldMap : fieldMapOrActor };
}

function firstMapped(item, fieldMap, key, fallbacks = []) {
  const mapped = fieldMap?.[key] ? readPath(item, fieldMap[key]) : undefined;
  if (mapped != null && mapped !== '') return mapped;
  for (const fallback of fallbacks) {
    const value = readPath(item, fallback);
    if (value != null && value !== '') return value;
  }
  return undefined;
}

/** Map one Apify dataset item into the raw public-search shape plus provenance. */
export function mapItem(item, fieldMapOrActor, label, metadata = {}) {
  if (!item || typeof item !== 'object') return null;
  const { actor, fieldMap } = actorAndFieldMap(fieldMapOrActor, metadata);
  if (!fieldMap || typeof fieldMap !== 'object') return null;
  const sourceLabel = label || actor.label || actor.profile || actor.id || 'actor';
  const source = actor.source || `apify-${sourceLabel}`;
  const url = firstMapped(item, fieldMap, 'url');
  const discoveryUrl = firstMapped(item, fieldMap, 'discoveryUrl', ['discoveryUrl', 'discoveryURL']) ?? url ?? null;
  const record = {
    url: url ?? discoveryUrl,
    company: firstMapped(item, fieldMap, 'company') ?? null,
    title: firstMapped(item, fieldMap, 'title') ?? null,
    postedAt: firstMapped(item, fieldMap, 'postedAt') ?? null,
    location: firstMapped(item, fieldMap, 'location') ?? null,
    description: firstMapped(item, fieldMap, 'description') ?? null,
    sourceKind: firstMapped(item, fieldMap, 'sourceKind') ?? actor.sourceKind ?? 'aggregator',
    sourceCategory: firstMapped(item, fieldMap, 'sourceCategory') ?? actor.sourceCategory ?? null,
    source,
    provider: firstMapped(item, fieldMap, 'provider', ['provider']) ?? actor.provider ?? sourceLabel,
    actorId: actor.id || null,
    actorLabel: sourceLabel,
    profile: actor.profile || null,
    discoveryUrl,
    discoverySource: firstMapped(item, fieldMap, 'discoverySource', ['discoverySource']) ?? source,
    discoveryCategory: firstMapped(item, fieldMap, 'discoveryCategory', ['discoveryCategory'])
      ?? actor.sourceCategory ?? null,
  };

  const originalApplicationUrl = firstMapped(item, fieldMap, 'originalApplicationUrl', [
    'originalApplicationUrl', 'originalApplyUrl', 'applicationUrl',
  ]);
  if (originalApplicationUrl != null) record.originalApplicationUrl = originalApplicationUrl;
  const originalApplicationEvidence = firstMapped(item, fieldMap, 'originalApplicationEvidence', [
    'originalApplicationEvidence', 'applicationResolution.evidence',
  ]);
  if (originalApplicationEvidence != null) record.originalApplicationEvidence = originalApplicationEvidence;

  for (const field of [
    'discoveredAt', 'crawledAt', 'remoteEligibility', 'salary', 'timezoneOverlap',
    'eor', 'equipment', 'humanContact', 'projectConnection', 'workMode', 'employment',
    'experience', 'eligible',
  ]) {
    const value = firstMapped(item, fieldMap, field, [field]);
    if (value !== undefined) record[field] = value;
  }
  return record;
}

/** Validate the shape of an Apify rescue config. */
export function validateConfig(config) {
  if (!config || typeof config !== 'object' || !Array.isArray(config.actors)) {
    throw new RunError('apify config must be an object with an "actors" array', 'config');
  }
  const returnedCap = Number(config.rescue?.maxReturnedItemsPerProfile ?? DEFAULT_MAX_RETURNED_ITEMS);
  if (!Number.isInteger(returnedCap) || returnedCap < 1) throw new RunError('rescue.maxReturnedItemsPerProfile must be a positive integer', 'config');
  const monthlyBudgetUsd = Number(config.rescue?.monthlyBudgetUsd ?? MAX_RESCUE_MONTHLY_BUDGET_USD);
  if (!Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd <= 0 || monthlyBudgetUsd > MAX_RESCUE_MONTHLY_BUDGET_USD) throw new RunError('rescue.monthlyBudgetUsd must be between 0 and 15', 'config');
  const maxRunCostUsd = Number(config.rescue?.maxRunCostUsd ?? MAX_RESCUE_RUN_COST_USD);
  if (!Number.isFinite(maxRunCostUsd) || maxRunCostUsd <= 0 || maxRunCostUsd > MAX_RESCUE_RUN_COST_USD) throw new RunError('rescue.maxRunCostUsd must be between 0 and 1', 'config');
  const maxRunsPerMonth = Number(config.rescue?.maxRunsPerMonth ?? 15);
  if (!Number.isInteger(maxRunsPerMonth) || maxRunsPerMonth < 1 || maxRunsPerMonth > 15) throw new RunError('rescue.maxRunsPerMonth must be an integer between 1 and 15', 'config');
  const profiles = new Set();
  config.actors.forEach((actor, index) => {
    if (!actor || typeof actor !== 'object') throw new RunError(`actors[${index}] must be an object`, 'config');
    if (!actor.id || typeof actor.id !== 'string') throw new RunError(`actors[${index}].id is required`, 'config');
    if (!actor.profile || typeof actor.profile !== 'string') throw new RunError(`actors[${index}].profile is required`, 'config');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(actor.profile)) throw new RunError(`actors[${index}].profile must be a stable kebab-case name`, 'config');
    if (profiles.has(actor.profile)) throw new RunError(`duplicate rescue profile ${actor.profile}`, 'config');
    profiles.add(actor.profile);
    if (NATIVE_REMOTE_LABELS.has(String(actor.label || '').toLowerCase())) {
      throw new RunError(`native remote actor ${actor.label} cannot be an Apify rescue profile`, 'config');
    }
    if (!actor.fieldMap || typeof actor.fieldMap !== 'object') throw new RunError(`actors[${index}].fieldMap is required`, 'config');
    for (const key of ['url', 'company', 'title']) {
      if (!actor.fieldMap[key]) throw new RunError(`actors[${index}].fieldMap.${key} is required`, 'config');
    }
  });
  return config;
}

export function readConfig(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new RunError(`could not read Apify config: ${error.message}`, 'config');
  }
  return validateConfig(parsed);
}

function normalizeProfiles(profileInput) {
  const values = Array.isArray(profileInput) ? profileInput : profileInput ? [profileInput] : [];
  return [...new Set(values.flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean))];
}

/** Return actors selected by stable profile name; no input means an empty selection. */
export function selectProfiles(config, profileInput = []) {
  validateConfig(config);
  const names = normalizeProfiles(profileInput);
  if (!names.length) return [];
  const byProfile = new Map(config.actors.map((actor) => [actor.profile, actor]));
  const unknown = names.filter((name) => !byProfile.has(name));
  if (unknown.length) throw new RunError(`unknown Apify rescue profile(s): ${unknown.join(', ')}`, 'profile-selection');
  const maxProfiles = Number(config.rescue?.maxProfilesPerRun ?? Infinity);
  if (names.length > maxProfiles) throw new RunError(`Apify rescue selection exceeds maxProfilesPerRun (${maxProfiles})`, 'profile-selection');
  return names.map((name) => byProfile.get(name));
}

function numericInputValues(input, keys) {
  return keys.flatMap((key) => Number.isFinite(Number(input?.[key])) ? [Number(input[key])] : []);
}

function expectedItems(actor) {
  const input = actor.input || {};
  const direct = numericInputValues(input, ['maxItems', 'maxResults', 'maxJobs', 'maxItemsPerKeyword', 'maxResultsPerKeyword']);
  const perQuery = input.keyword || input.searchQueries || input.keywords || input.roles || [];
  if (direct.length) {
    const largest = Math.max(...direct);
    const multiplied = input.maxItemsPerKeyword || input.maxResultsPerKeyword
      ? largest * Math.max(1, perQuery.length)
      : 0;
    return Math.max(largest, multiplied);
  }
  return null;
}

function expectedQueries(actor) {
  const input = actor.input || {};
  for (const key of ['keyword', 'searchQueries', 'keywords', 'roles', 'categoryUrls']) {
    if (Array.isArray(input[key])) return input[key].length;
  }
  return input.searchQuery ? 1 : 0;
}

/** Report scope and credit/runtime exposure before any actor execution. */
export function buildPreflight(config, profileInput = []) {
  validateConfig(config);
  const selected = selectProfiles(config, profileInput);
  const actorIds = new Set();
  const duplicateActorIds = [];
  selected.forEach((actor) => {
    if (actorIds.has(actor.id)) duplicateActorIds.push(actor.id);
    actorIds.add(actor.id);
  });
  const maxRuntimeSeconds = Number(config.rescue?.runTimeoutSeconds ?? DEFAULT_RUN_TIMEOUT_MS / 1000);
  const returnedCap = Number(config.rescue?.maxReturnedItemsPerProfile ?? DEFAULT_MAX_RETURNED_ITEMS);
  const maxRecords = selected.reduce((sum, actor) => sum + Math.min(expectedItems(actor) || 0, returnedCap), 0);
  const maxQueries = selected.reduce((sum, actor) => sum + expectedQueries(actor), 0);
  const actorRuns = actorIds.size;
  return {
    status: selected.length ? 'ready' : 'not-invoked',
    selectedProfiles: selected.map((actor) => actor.profile),
    requestedProfiles: selected.length,
    actorRuns,
    duplicateActorIds,
    expectedScope: {
      profiles: selected.map((actor) => actor.profile),
      actors: [...actorIds],
      queries: maxQueries,
      maxRecords,
      maxRuntimeSeconds: actorRuns * maxRuntimeSeconds,
    },
    creditRuntimeExposure: {
      tokenRequired: selected.length > 0,
      maxActorRuns: actorRuns,
      maxDatasetItems: maxRecords,
      maxRuntimeSeconds: actorRuns * maxRuntimeSeconds,
    },
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseText(response) {
  return typeof response.text === 'function' ? response.text().catch(() => '') : Promise.resolve('');
}

function apiError(message) { return new RunError(message, 'api-failure'); }

function clockMillis(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  if (!Number.isNaN(parsed)) return parsed;
  throw new RunError('invalid injected Apify clock value', 'clock');
}

async function jsonResponse(response, stage) {
  try { return await response.json(); }
  catch (error) { throw new RunError(`${stage} response schema drift: ${error.message}`, 'schema-drift'); }
}

/** Run one actor. Timing/polling are injectable so timeout and partial-failure contracts stay bounded. */
export async function runActor(actor, token, fetchImpl = fetch, {
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  sleepImpl = sleep,
  clock = () => Date.now(),
  maxReturnedItems = DEFAULT_MAX_RETURNED_ITEMS,
  datasetOffset = 0,
  maxTotalChargeUsd = 1,
} = {}) {
  const chargeLimit = Math.min(Number(maxTotalChargeUsd) || MAX_RESCUE_RUN_COST_USD, MAX_RESCUE_RUN_COST_USD);
  const startUrl = new URL(`${API_BASE}/acts/${encodeURIComponent(actor.id)}/runs`);
  startUrl.searchParams.set('token', token);
  startUrl.searchParams.set('maxTotalChargeUsd', String(chargeLimit));
  const startRes = await fetchImpl(startUrl.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(actor.input || {}),
  });
  if (!startRes.ok) throw apiError(`start failed: ${startRes.status} ${await responseText(startRes)}`);
  const startBody = await jsonResponse(startRes, 'actor run');
  const runId = startBody?.data?.id;
  if (!runId) throw new RunError('actor run response schema drift: missing data.id', 'schema-drift');

  const startedAt = clockMillis(clock);
  const deadline = startedAt + runTimeoutMs;
  let status = startBody.data.status;
  let datasetId = startBody.data.defaultDatasetId;
  let actualCostUsd = Number(startBody?.data?.usage?.costUsd ?? startBody?.data?.costUsd ?? startBody?.data?.totalCostUsd);
  while (status && !['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
    if (clockMillis(clock) > deadline) throw new RunError(`timed out after ${runTimeoutMs / 1000}s waiting for run ${runId}`, 'timeout');
    if (pollIntervalMs > 0) await sleepImpl(pollIntervalMs);
    const pollRes = await fetchImpl(`${API_BASE}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
    if (!pollRes.ok) throw apiError(`poll failed: ${pollRes.status} ${await responseText(pollRes)}`);
    const pollBody = await jsonResponse(pollRes, 'actor poll');
    status = pollBody?.data?.status;
    datasetId = pollBody?.data?.defaultDatasetId ?? datasetId;
    if (!Number.isFinite(actualCostUsd)) actualCostUsd = Number(pollBody?.data?.usage?.costUsd ?? pollBody?.data?.costUsd ?? pollBody?.data?.totalCostUsd);
    if (!status) throw new RunError('actor poll response schema drift: missing data.status', 'schema-drift');
  }
  if (status === 'TIMED-OUT') throw new RunError(`run ended with status ${status}`, 'timeout');
  if (status !== 'SUCCEEDED') throw new RunError(`run ended with status ${status || 'UNKNOWN'}`, 'api-failure');
  if (!datasetId) throw new RunError('run succeeded but no defaultDatasetId was returned', 'schema-drift');

  const limit = Math.max(1, Math.trunc(Number(maxReturnedItems)) || DEFAULT_MAX_RETURNED_ITEMS);
  const offset = Math.max(0, Math.trunc(Number(datasetOffset)) || 0);
  const itemsRes = await fetchImpl(`${API_BASE}/datasets/${datasetId}/items?clean=true&format=json&limit=${limit}&offset=${offset}&token=${encodeURIComponent(token)}`);
  if (!itemsRes.ok) throw apiError(`dataset fetch failed: ${itemsRes.status} ${await responseText(itemsRes)}`);
  const items = await jsonResponse(itemsRes, 'dataset');
  if (!Array.isArray(items)) throw new RunError('dataset response schema drift: expected an array', 'schema-drift');
  return { items: items.slice(0, limit), actualCostUsd: Number.isFinite(actualCostUsd) ? actualCostUsd : null, offset, limit };
}

function failureReason(error) {
  return error?.code || 'actor-failure';
}

function eligibleCount(records) {
  const known = records.filter((record) => typeof record.eligible === 'boolean');
  return { eligible: known.length ? known.filter((record) => record.eligible).length : null, eligibleKnown: known.length > 0 };
}

function actorTelemetry(actor, patch = {}) {
  return {
    profile: actor.profile,
    actorId: actor.id,
    label: actor.label || actor.profile,
    source: actor.source || `apify-${actor.label || actor.profile}`,
    sourceCategory: actor.sourceCategory || null,
    status: 'not-run',
    fetched: 0,
    prepared: 0,
    eligible: null,
    eligibleKnown: false,
    latencyMs: 0,
    failureReason: null,
    ...patch,
  };
}

/** Run explicitly selected profiles. Individual actor failures are visible and nonfatal. */
export async function pullAll(config, token, {
  profile = null,
  profiles = null,
  fetchImpl = fetch,
  log = () => {},
  clock = () => Date.now(),
  sleepImpl = sleep,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  runTimeoutMs = null,
  seenCachePath = DEFAULT_APIFY_SEEN_CACHE_PATH,
  seenCache = null,
  budgetStatePath = DEFAULT_APIFY_BUDGET_STATE_PATH,
  budgetState = null,
} = {}) {
  validateConfig(config);
  const selectionInput = profiles ?? profile;
  const selected = selectProfiles(config, selectionInput);
  const preflight = buildPreflight(config, selectionInput);
  const seenCacheInjected = seenCache !== null;
  if (!seenCacheInjected) seenCache = loadApifySeenCache(seenCachePath);
  const budgetStateInjected = budgetState !== null;
  if (!budgetStateInjected) budgetState = loadApifyBudgetState(budgetStatePath);
  const summary = {};
  const records = [];
  const seenActorIds = new Set();
  if (!selected.length) return { status: 'not-invoked', records, summary, actors: [], preflight };

  for (const actor of selected) {
    const key = actor.profile;
    if (seenActorIds.has(actor.id)) {
      const duplicate = actorTelemetry(actor, { failureReason: 'duplicate-actor-id' });
      summary[key] = duplicate;
      log(`  ! ${key}: duplicate actor ID ${actor.id}; skipped duplicate call`);
      continue;
    }
    seenActorIds.add(actor.id);
    if (!token) {
      const unavailable = actorTelemetry(actor, { status: 'unavailable', failureReason: 'missing-token' });
      summary[key] = unavailable;
      log(`  ! ${key}: APIFY_TOKEN is not set`);
      continue;
    }
    const maxRunCostUsd = Number(config.rescue?.maxRunCostUsd ?? MAX_RESCUE_RUN_COST_USD);
    const estimatedCostUsd = Number(actor.estimatedCostUsd) || maxRunCostUsd;
    const nowIso = new Date(clockMillis(clock)).toISOString();
    const blockReason = budgetBlockReason({
      state: budgetState, nowIso, estimatedCostUsd,
      monthlyBudgetUsd: config.rescue?.monthlyBudgetUsd ?? MAX_RESCUE_MONTHLY_BUDGET_USD,
      maxRunsPerMonth: config.rescue?.maxRunsPerMonth ?? 15,
      maxRunCostUsd,
    });
    if (blockReason) {
      const blocked = actorTelemetry(actor, { status: 'unavailable', failureReason: blockReason });
      summary[key] = blocked;
      log(`  ! ${key}: blocked by ${blockReason}`);
      continue;
    }
    const startedAt = clockMillis(clock);
    try {
      const retrieval = budgetState.retrieval?.[actor.profile] ?? { nextOffset: 0 };
      const datasetOffset = Math.max(0, Number(retrieval.nextOffset) || 0);
      const actorResult = await runActor(actor, token, fetchImpl, {
        pollIntervalMs,
        runTimeoutMs: runTimeoutMs ?? Number(config.rescue?.runTimeoutSeconds ?? DEFAULT_RUN_TIMEOUT_MS / 1000) * 1000,
        sleepImpl,
        clock,
        maxReturnedItems: config.rescue?.maxReturnedItemsPerProfile ?? DEFAULT_MAX_RETURNED_ITEMS,
        datasetOffset,
        maxTotalChargeUsd: maxRunCostUsd,
      });
      const items = actorResult.items;
      const mapped = [];
      let invalid = 0;
      for (const item of items) {
        const record = mapItem(item, actor, actor.label);
        if (record) mapped.push(record);
        else invalid += 1;
      }
      const seenIds = new Set(seenCache.profiles[actor.profile] ?? []);
      let skippedSeen = 0;
      for (let index = mapped.length - 1; index >= 0; index -= 1) {
        if (seenIds.has(seenKeyFor(mapped[index]))) {
          mapped.splice(index, 1);
          skippedSeen += 1;
        }
      }
      const knownEligibility = eligibleCount(mapped);
      const degraded = invalid > 0;
      summary[key] = actorTelemetry(actor, {
        status: degraded ? 'degraded' : 'ok',
        fetched: items.length,
        prepared: mapped.length,
        skippedSeen,
        ...knownEligibility,
        latencyMs: Math.max(0, clockMillis(clock) - startedAt),
        failureReason: degraded ? 'partial-failure' : null,
      });
      records.push(...mapped);
      recordApifyRun(budgetState, nowIso, estimatedCostUsd, {
        estimatedItems: expectedItems(actor) || 0,
        actualItems: items.length,
        actualCostUsd: actorResult.actualCostUsd,
      });
      budgetState.retrieval = budgetState.retrieval || {};
      budgetState.retrieval[actor.profile] = {
        nextOffset: datasetOffset + items.length,
        lastOffset: datasetOffset,
        lastReturnedItems: items.length,
        estimatedItems: expectedItems(actor) || null,
        actualItems: items.length,
      };
      const profileSeen = seenCache.profiles[actor.profile] || (seenCache.profiles[actor.profile] = []);
      seenCache.profiles[actor.profile] = [...new Set([
        ...profileSeen,
        ...mapped.map(seenKeyFor).filter(Boolean),
      ])];
      if (degraded) log(`  ! ${key}: ${invalid} record(s) had schema drift and were skipped`);
    } catch (error) {
      const telemetry = actorTelemetry(actor, {
        status: 'failed',
        latencyMs: Math.max(0, clockMillis(clock) - startedAt),
        failureReason: failureReason(error),
        error: error.message,
      });
      summary[key] = telemetry;
      log(`  ✗ ${key}: ${error.message}`);
    }
  }

  const actors = Object.values(summary);
  const failures = actors.filter((actor) => ['failed', 'degraded'].includes(actor.status) || actor.failureReason === 'duplicate-actor-id');
  const unavailable = actors.filter((actor) => actor.status === 'unavailable');
  const status = failures.length ? (failures.length < actors.length ? 'degraded' : 'failed')
    : unavailable.length ? 'unavailable' : 'ok';
  if (!seenCacheInjected) saveApifySeenCache(seenCachePath, seenCache, new Date(clockMillis(clock)).toISOString());
  if (!budgetStateInjected) saveApifyBudgetState(budgetStatePath, budgetState, new Date(clockMillis(clock)).toISOString());
  return { status, records, summary, actors, preflight };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log(HELP); return; }
  if (!options.out) throw new RunError('--out FILE is required', 'arguments');

  const config = readConfig(options.config);
  const selectedProfiles = options.profiles;
  const preflight = buildPreflight(config, selectedProfiles);
  console.error(JSON.stringify({ event: 'apify-preflight', ...preflight }));
  const token = process.env.APIFY_TOKEN || null;
  const result = await pullAll(config, token, {
    profiles: selectedProfiles,
    log: (...args) => console.error(...args),
  });
  writeFileSync(options.out, `${JSON.stringify(result.records, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ out: options.out, status: result.status, total: result.records.length, preflight: result.preflight, actors: result.summary }));
  return result;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
