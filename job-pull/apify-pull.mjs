#!/usr/bin/env node

/**
 * apify-pull.mjs — optional structured job-board pull via Apify actors (user layer).
 *
 * Runs a set of configured Apify actors (LinkedIn/Naukri/Wellfound/YC scrapers
 * by default, see config/apify.json), polls each run to completion, fetches
 * its dataset, and maps each item through a per-actor fieldMap into the RAW
 * record shape job-pull/public-search-prepare.mjs already consumes (url/link/
 * jobUrl, company/org, title/position, postedAt/posted/date, location,
 * description). Write the merged array with --out, then run the existing
 * pipeline unchanged:
 *
 *   node job-pull/apify-pull.mjs --out RAW.json
 *   node job-pull/public-search-prepare.mjs --in RAW.json --out PREPARED.json
 *   node job-pull/run.mjs --public-json PREPARED.json
 *
 * Optional. Needs APIFY_TOKEN in the environment; a per-actor failure is
 * non-fatal (logged, run continues) so one broken actor never blocks the rest.
 * Does not touch run.mjs, select.mjs, or eligibility.mjs.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class RunError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RunError';
  }
}

const API_BASE = 'https://api.apify.com/v2';
const POLL_INTERVAL_MS = 10_000;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

function parseValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

export function parseArgs(argv = process.argv.slice(2)) {
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    out: parseValue(argv, '--out'),
    config: parseValue(argv, '--config', 'config/apify.json'),
    actor: parseValue(argv, '--actor'),
  };
}

export const HELP = `Usage: node job-pull/apify-pull.mjs --out RAW.json [--config config/apify.json] [--actor <id>]

Runs configured Apify actors, waits for each to finish, and writes merged
dataset items (mapped into the public-search RAW record shape) to --out.
Requires APIFY_TOKEN in the environment. Optional layer — feed the output
through job-pull/public-search-prepare.mjs same as any other RAW source.`;

/** Read a dot-path value off a nested object; returns undefined if missing. */
export function readPath(obj, dotPath) {
  if (!dotPath) return undefined;
  return String(dotPath).split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

/** Map one Apify dataset item through an actor's fieldMap into a RAW record. */
export function mapItem(item, fieldMap, label) {
  if (!item || typeof item !== 'object' || !fieldMap) return null;
  const record = {
    url: readPath(item, fieldMap.url) ?? null,
    company: readPath(item, fieldMap.company) ?? null,
    title: readPath(item, fieldMap.title) ?? null,
    postedAt: readPath(item, fieldMap.postedAt) ?? null,
    location: readPath(item, fieldMap.location) ?? null,
    description: readPath(item, fieldMap.description) ?? null,
    sourceKind: 'aggregator',
    source: `apify-${label || 'actor'}`,
  };
  for (const field of [
    'discoveredAt', 'crawledAt', 'originalApplicationUrl', 'remoteEligibility',
    'salary', 'timezoneOverlap', 'eor', 'equipment', 'humanContact', 'projectConnection',
  ]) {
    if (fieldMap[field]) record[field] = readPath(item, fieldMap[field]);
  }
  if (fieldMap.sourceKind) record.sourceKind = readPath(item, fieldMap.sourceKind) ?? record.sourceKind;
  if (fieldMap.sourceCategory) record.sourceCategory = readPath(item, fieldMap.sourceCategory) ?? null;
  return record;
}

/** Validate the shape of config/apify.json; throws RunError on structural issues. */
export function validateConfig(config) {
  if (!config || typeof config !== 'object' || !Array.isArray(config.actors)) {
    throw new RunError('apify config must be an object with an "actors" array');
  }
  config.actors.forEach((actor, index) => {
    if (!actor || typeof actor !== 'object') throw new RunError(`actors[${index}] must be an object`);
    if (!actor.id || typeof actor.id !== 'string') throw new RunError(`actors[${index}].id is required`);
    if (!actor.fieldMap || typeof actor.fieldMap !== 'object') throw new RunError(`actors[${index}].fieldMap is required`);
    for (const key of ['url', 'company', 'title']) {
      if (!actor.fieldMap[key]) throw new RunError(`actors[${index}].fieldMap.${key} is required`);
    }
  });
  return config;
}

function readConfig(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new RunError(`could not read Apify config: ${error.message}`);
  }
  return validateConfig(parsed);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runActor(actor, token, fetchImpl = fetch) {
  const startRes = await fetchImpl(`${API_BASE}/acts/${encodeURIComponent(actor.id)}/runs?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(actor.input || {}),
  });
  if (!startRes.ok) throw new RunError(`start failed: ${startRes.status} ${await startRes.text().catch(() => '')}`);
  const startBody = await startRes.json();
  const runId = startBody?.data?.id;
  if (!runId) throw new RunError('actor run response missing data.id');

  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let status = startBody.data.status;
  let datasetId = startBody.data.defaultDatasetId;
  while (status && !['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
    if (Date.now() > deadline) throw new RunError(`timed out after ${RUN_TIMEOUT_MS / 1000}s waiting for run ${runId}`);
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await fetchImpl(`${API_BASE}/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
    if (!pollRes.ok) throw new RunError(`poll failed: ${pollRes.status}`);
    const pollBody = await pollRes.json();
    status = pollBody?.data?.status;
    datasetId = pollBody?.data?.defaultDatasetId ?? datasetId;
  }
  if (status !== 'SUCCEEDED') throw new RunError(`run ended with status ${status || 'UNKNOWN'}`);
  if (!datasetId) throw new RunError('run succeeded but no defaultDatasetId was returned');

  const itemsRes = await fetchImpl(`${API_BASE}/datasets/${datasetId}/items?clean=true&format=json&token=${encodeURIComponent(token)}`);
  if (!itemsRes.ok) throw new RunError(`dataset fetch failed: ${itemsRes.status}`);
  const items = await itemsRes.json();
  return Array.isArray(items) ? items : [];
}

/** Run every enabled actor in config, mapping dataset items into RAW records. Per-actor failure is non-fatal. */
export async function pullAll(config, token, { actorFilter = null, fetchImpl = fetch, log = () => {} } = {}) {
  const records = [];
  const summary = {};
  for (const actor of config.actors) {
    if (actor.enabled === false) continue;
    if (actorFilter && actor.id !== actorFilter) continue;
    const label = actor.label || actor.id;
    try {
      const items = await runActor(actor, token, fetchImpl);
      const mapped = items.map((item) => {
        const record = mapItem(item, actor.fieldMap, label);
        if (!record) return null;
        record.sourceKind = actor.sourceKind ?? record.sourceKind;
        record.sourceCategory = actor.sourceCategory ?? record.sourceCategory;
        return record;
      }).filter(Boolean);
      records.push(...mapped);
      summary[label] = { fetched: mapped.length, failed: false };
    } catch (error) {
      log(`  ✗ ${label}: ${error.message}`);
      summary[label] = { fetched: 0, failed: true, error: error.message };
    }
  }
  return { records, summary };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log(HELP); return; }
  if (!options.out) throw new RunError('--out FILE is required');

  const token = process.env.APIFY_TOKEN;
  if (!token) throw new RunError('APIFY_TOKEN environment variable is not set — Apify pull requires an API token');

  const config = readConfig(options.config);
  const { records, summary } = await pullAll(config, token, {
    actorFilter: options.actor,
    log: (...a) => console.error(...a),
  });

  writeFileSync(options.out, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ out: options.out, total: records.length, actors: summary }));
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
