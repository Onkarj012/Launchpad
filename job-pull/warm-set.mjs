#!/usr/bin/env node

/**
 * warm-set.mjs — the warm-board cache for the reverse ATS scan (user layer).
 *
 * The full reverse scan (career-ops/scan-ats-full.mjs) walks ~13k public ATS
 * boards blind, every run, because no vendor publishes a global "recently
 * posted" feed. But in practice only a tiny fraction of boards ever produce a
 * Pune/India-remote-eligible match. The warm set is that fraction: the boards
 * that have already yielded ≥1 eligible role. The daily scan hits only these
 * (minutes, not an hour); a periodic full scan discovers new productive boards
 * and promotes them in.
 *
 * This lives in job-pull/ (user layer) on purpose — career-ops scripts are
 * system layer and get overwritten by `update-system.mjs`. It reuses the
 * stable provider modules + the SSRF-guarded entry synthesis from scan-ats-full.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { entryOnHost } from '../vendor/career-ops/scan-ats-full.mjs';

export const WARM_SET_SCHEMA_VERSION = 1;
export const WARM_ATS = ['greenhouse', 'lever', 'ashby', 'workday'];

// Same conservative charset scan-ats-full uses before URL interpolation.
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

// How a warm-set entry (a slug, or a tenant|instance|site triple for workday)
// becomes an SSRF-checked synthetic PortalEntry the provider can fetch. Mirrors
// SOURCES[*].toEntry in scan-ats-full.mjs (which is module-local, not exported).
export const ENTRY_BUILDERS = {
  greenhouse: (slug) => SLUG_RE.test(String(slug))
    ? entryOnHost(String(slug), `https://job-boards.greenhouse.io/${slug}`, h => h === 'job-boards.greenhouse.io')
    : null,
  lever: (slug) => SLUG_RE.test(String(slug))
    ? entryOnHost(String(slug), `https://jobs.lever.co/${slug}`, h => h === 'jobs.lever.co')
    : null,
  ashby: (slug) => SLUG_RE.test(String(slug))
    ? entryOnHost(String(slug), `https://jobs.ashbyhq.com/${slug}`, h => h === 'jobs.ashbyhq.com')
    : null,
  workday: (line) => {
    const [tenant, instance, site] = String(line).split('|');
    if (![tenant, instance, site].every(p => p && SLUG_RE.test(p))) return null;
    return entryOnHost(
      tenant,
      `https://${tenant}.${instance}.myworkdayjobs.com/${site}`,
      h => h === `${tenant}.${instance}.myworkdayjobs.com` && h.endsWith('.myworkdayjobs.com'),
    );
  },
};

/**
 * Identify which warm board a posting URL belongs to, as { ats, key }.
 * `key` is the value stored in the warm set (slug, or workday triple).
 * Returns null for custom-domain / unrecognized URLs (e.g. a company's own
 * careers site fronting Greenhouse — the slug isn't recoverable there).
 */
export function boardKeyFromUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const seg = u.pathname.split('/').filter(Boolean);
  if (u.hostname === 'job-boards.greenhouse.io' && seg[0] && SLUG_RE.test(seg[0])) return { ats: 'greenhouse', key: seg[0] };
  if (u.hostname === 'jobs.lever.co' && seg[0] && SLUG_RE.test(seg[0])) return { ats: 'lever', key: seg[0] };
  if (u.hostname === 'jobs.ashbyhq.com' && seg[0] && SLUG_RE.test(seg[0])) return { ats: 'ashby', key: seg[0] };
  if (u.hostname.endsWith('.myworkdayjobs.com')) {
    // host = tenant.instance.myworkdayjobs.com ; site is the first path segment.
    const [tenant, instance] = u.hostname.split('.');
    const site = seg[0];
    if (tenant && instance && site && [tenant, instance, site].every(p => SLUG_RE.test(p))) {
      return { ats: 'workday', key: `${tenant}|${instance}|${site}` };
    }
  }
  return null;
}

/** Empty warm set skeleton. */
export function emptyWarmSet() {
  return {
    schemaVersion: WARM_SET_SCHEMA_VERSION,
    updatedAt: null,
    boards: { greenhouse: [], lever: [], ashby: [], workday: [] },
  };
}

/** Load a warm set from disk, or return an empty skeleton if absent/unreadable. */
export function loadWarmSet(file) {
  if (!existsSync(file)) return emptyWarmSet();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    const set = emptyWarmSet();
    if (raw && typeof raw === 'object' && raw.boards) {
      for (const ats of WARM_ATS) {
        if (Array.isArray(raw.boards[ats])) set.boards[ats] = [...new Set(raw.boards[ats].map(String))];
      }
      set.updatedAt = raw.updatedAt || null;
    }
    return set;
  } catch {
    return emptyWarmSet();
  }
}

/** Persist a warm set (sorted, deduped) with an injected timestamp. */
export function saveWarmSet(file, set, nowIso) {
  const out = {
    schemaVersion: WARM_SET_SCHEMA_VERSION,
    updatedAt: nowIso,
    boards: {},
  };
  for (const ats of WARM_ATS) {
    out.boards[ats] = [...new Set((set.boards?.[ats] || []).map(String))].sort();
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  return out;
}

/** Total board count across all ATS. */
export function warmSetSize(set) {
  return WARM_ATS.reduce((n, ats) => n + (set.boards?.[ats]?.length || 0), 0);
}

/**
 * Build synthetic PortalEntry objects for one ATS from the warm set, dropping
 * any entry that fails the SSRF host check. Returns [{ name, careers_url }].
 */
export function warmEntries(set, ats) {
  const build = ENTRY_BUILDERS[ats];
  if (!build) return [];
  return (set.boards?.[ats] || []).map(build).filter(Boolean);
}

/**
 * Add boards derived from a list of offer URLs into the set (mutates + returns
 * the set, plus the count actually added). Used to promote productive boards
 * discovered by a full scan.
 */
export function promoteFromUrls(set, urls) {
  let added = 0;
  for (const url of urls) {
    const hit = boardKeyFromUrl(url);
    if (!hit) continue;
    const list = set.boards[hit.ats] || (set.boards[hit.ats] = []);
    if (!list.includes(hit.key)) { list.push(hit.key); added++; }
  }
  return { set, added };
}

/**
 * Seed a warm set from career-ops scan-history.tsv — every URL that was ever
 * `added` names a board that produced an eligible match at least once.
 * Custom-domain URLs (no recoverable slug) are skipped. Pure aside from read.
 */
export function warmSetFromScanHistory(tsvPath) {
  const set = emptyWarmSet();
  if (!existsSync(tsvPath)) return set;
  const lines = readFileSync(tsvPath, 'utf-8').split('\n').slice(1);
  const urls = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    urls.push(line.split('\t')[0]);
  }
  promoteFromUrls(set, urls);
  return set;
}
