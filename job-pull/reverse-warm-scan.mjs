#!/usr/bin/env node

/**
 * reverse-warm-scan.mjs — tiered reverse ATS scan (user layer).
 *
 * DEFAULT (warm) mode: fetch only the boards in config/reverse-warm-set.json —
 * the boards that have already produced an eligible match. Minutes, not the
 * ~1hr a full 13k-board crawl costs. Emits the exact same --json contract as
 * career-ops/scan-ats-full.mjs, so job-pull's reverse-ats adapter consumes it
 * unchanged.
 *
 * --full mode: delegate to scan-ats-full.mjs (the real 13k discovery crawl),
 * then (with --promote) fold any board that produced an eligible match back
 * into the warm set. Run this weekly / on demand to keep the warm set current.
 *
 * --seed-from-history: rebuild the warm set from career-ops scan-history.tsv
 * and exit. Use once to bootstrap, or any time to re-derive from scratch.
 *
 * Zero LLM tokens — pure HTTP + JSON, reusing career-ops provider modules.
 *
 * Usage:
 *   node reverse-warm-scan.mjs --json --dry-run              # daily warm scan
 *   node reverse-warm-scan.mjs --full --promote --json       # weekly discovery + grow warm set
 *   node reverse-warm-scan.mjs --seed-from-history           # bootstrap warm set
 *   node reverse-warm-scan.mjs --since 7 --json              # widen freshness window
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import yaml from 'js-yaml';

import { makeHttpCtx } from '../vendor/career-ops/providers/_http.mjs';
import greenhouse from '../vendor/career-ops/providers/greenhouse.mjs';
import lever from '../vendor/career-ops/providers/lever.mjs';
import ashby from '../vendor/career-ops/providers/ashby.mjs';
import workday from '../vendor/career-ops/providers/workday.mjs';
import { buildTitleFilter, buildLocationFilter, loadSeenUrls } from '../vendor/career-ops/scan.mjs';
import {
  classifyPostingDate,
  serializeAtsOffer,
  ATS_JSON_SCHEMA_VERSION,
} from '../vendor/career-ops/scan-ats-full.mjs';
import {
  WARM_ATS,
  loadWarmSet,
  saveWarmSet,
  warmSetSize,
  warmEntries,
  promoteFromUrls,
  warmSetFromScanHistory,
} from './warm-set.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const VENDORED_CAREER_OPS_DIR = path.join(REPO_ROOT, 'vendor', 'career-ops');
const DEFAULT_WARM_SET = path.join(REPO_ROOT, 'config', 'reverse-warm-set.json');
const DEFAULT_PORTALS = path.join(REPO_ROOT, 'config', 'career-ops-portals.yml');
const DEFAULT_SCAN_HISTORY = path.join(process.cwd(), 'data', 'scan-history.tsv');

const PROVIDERS = { greenhouse, lever, ashby, workday };
const CONCURRENCY = 20;

function valueOf(args, flag, fallback = null) {
  const i = args.indexOf(flag);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const kv = args.find(a => a.startsWith(flag + '='));
  return kv ? kv.split('=').slice(1).join('=') : fallback;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    sinceDays: Number(valueOf(args, '--since')) || 3,
    warmSetPath: valueOf(args, '--warm-set', DEFAULT_WARM_SET),
    portalsPath: valueOf(args, '--portals', DEFAULT_PORTALS),
    ats: (valueOf(args, '--ats') || WARM_ATS.join(',')).split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    json: args.includes('--json'),
    dryRun: args.includes('--dry-run'),
    promote: args.includes('--promote'),
    verbose: args.includes('--verbose'),
    full: args.includes('--full'),
    seedFromHistory: args.includes('--seed-from-history'),
  };
}

async function parallelEach(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) await fn(items[i++]);
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

// ── warm scan ───────────────────────────────────────────────────────

async function warmScan(opts, log) {
  if (!existsSync(opts.portalsPath)) {
    throw new Error(`portals.yml not found at ${opts.portalsPath} — the warm scan reuses its title_filter/location_filter.`);
  }
  const config = yaml.load(readFileSync(opts.portalsPath, 'utf-8'));
  const titleFilter = buildTitleFilter(config?.title_filter);
  const locationFilter = buildLocationFilter(config?.location_filter);

  const set = loadWarmSet(opts.warmSetPath);
  const cutoff = Date.now() - opts.sinceDays * 86_400_000;
  const { seen: seenUrls } = loadSeenUrls();
  const ctx = { ...makeHttpCtx(), sinceMs: cutoff, includeUndated: false };

  const offers = [];
  let companiesScanned = 0;
  let unreachable = 0;
  let droppedNoDate = 0;
  const datasetStatus = {};

  for (const ats of opts.ats) {
    const provider = PROVIDERS[ats];
    if (!provider) continue;
    const entries = warmEntries(set, ats);
    datasetStatus[ats] = 'ok';
    companiesScanned += entries.length;
    log(`⚙  ${ats} — ${entries.length} warm boards`);

    await parallelEach(entries, CONCURRENCY, async (entry) => {
      let jobs;
      try {
        jobs = await provider.fetch(entry, ctx);
      } catch (err) {
        unreachable++;
        if (opts.verbose) log(`  ✗ ${ats}/${entry.name}: ${err.message}`);
        return;
      }
      for (const job of jobs) {
        if (!job.url || !job.title) continue;
        const dateClass = classifyPostingDate(job, cutoff);
        if (dateClass === 'stale') continue;
        if (dateClass === 'undated') { droppedNoDate++; continue; }
        if (!titleFilter(job.title)) continue;
        if (!locationFilter(job.location)) continue;
        if (seenUrls.has(job.url)) continue;
        seenUrls.add(job.url);
        offers.push({ ...job, source: `${ats}-warm`, dateStatus: 'dated' });
      }
    });
  }

  offers.sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));

  return {
    schemaVersion: ATS_JSON_SCHEMA_VERSION,
    runAt: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    mode: 'warm',
    sources: opts.ats,
    seeds: [],
    sinceDays: opts.sinceDays,
    warmBoards: warmSetSize(set),
    companiesAvailable: warmSetSize(set),
    companiesScanned,
    capHit: false,
    datasetStatus,
    postingsKept: offers.length,
    postingsDroppedNoDate: droppedNoDate,
    unreachableBoards: unreachable,
    saved: false,
    offers: offers.map(serializeAtsOffer),
  };
}

// ── full scan (delegate + promote) ──────────────────────────────────

function fullScan(opts, log) {
  const script = path.join(VENDORED_CAREER_OPS_DIR, 'scan-ats-full.mjs');
  const args = [script, '--ats', opts.ats.join(','), '--seeds', 'yc,a16z', '--since', String(opts.sinceDays), '--dry-run', '--json'];
  log(`Delegating to full reverse scan: scan-ats-full.mjs (${opts.ats.join(',')})`);
  const execute = opts.execute || execFileSync;
  const stdout = execute(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, CAREER_OPS_PORTALS: path.resolve(opts.portalsPath) },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const result = JSON.parse(stdout.trim());
  result.mode = 'full';

  if (opts.promote && Array.isArray(result.offers) && result.offers.length) {
    const set = loadWarmSet(opts.warmSetPath);
    const { added } = promoteFromUrls(set, result.offers.map(o => o.url).filter(Boolean));
    result.warmPromoted = added;
    if (added && !opts.dryRun) {
      saveWarmSet(opts.warmSetPath, set, new Date().toISOString());
      log(`Promoted ${added} new productive board(s) into warm set → ${warmSetSize(set)} total`);
    } else if (added) {
      log(`Would promote ${added} new board(s) (dry-run — not written)`);
    }
  }
  return result;
}

function seedFromHistory(opts, log, readHistory = warmSetFromScanHistory) {
  const set = readHistory(opts.scanHistoryPath || DEFAULT_SCAN_HISTORY);
  if (!opts.dryRun) saveWarmSet(opts.warmSetPath, set, new Date().toISOString());
  const msg = `Seeded warm set from scan-history: ${warmSetSize(set)} boards${opts.dryRun ? ' (dry-run — not written)' : ` → ${opts.warmSetPath}`}`;
  if (opts.json) process.stdout.write(JSON.stringify({ seeded: true, warmBoards: warmSetSize(set), boards: set.boards }) + '\n');
  else log(msg);
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  const log = opts.json ? (...a) => console.error(...a) : (...a) => console.log(...a);

  if (opts.seedFromHistory) {
    seedFromHistory(opts, log);
    return;
  }

  const result = opts.full ? fullScan(opts, log) : await warmScan(opts, log);

  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  log(`\n${'━'.repeat(45)}`);
  log(`Reverse ${result.mode} scan — ${result.date}`);
  log(`Boards scanned: ${result.companiesScanned} | matches: ${result.postingsKept} | unreachable: ${result.unreachableBoards}`);
  if (result.warmPromoted) log(`Warm set grew by ${result.warmPromoted}`);
  for (const o of result.offers || []) {
    const posted = o.postedAt ? String(o.postedAt).slice(0, 10) : 'n/a';
    log(`  + [${o.source}] ${posted} | ${o.company} | ${o.title} | ${o.location || 'N/A'}\n    ${o.url}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

export { warmScan, fullScan, seedFromHistory };
