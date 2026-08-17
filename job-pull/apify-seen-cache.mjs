import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const APIFY_SEEN_CACHE_SCHEMA = 1;
export const DEFAULT_APIFY_SEEN_CACHE_PATH = '.local/launchpad-crawler/apify-seen-cache.json';

export function emptyApifySeenCache() {
  return { schemaVersion: APIFY_SEEN_CACHE_SCHEMA, updatedAt: null, profiles: {} };
}

export function loadApifySeenCache(file = DEFAULT_APIFY_SEEN_CACHE_PATH) {
  if (!existsSync(file)) return emptyApifySeenCache();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    const cache = emptyApifySeenCache();
    if (raw && typeof raw === 'object' && raw.profiles && typeof raw.profiles === 'object') {
      for (const [profile, ids] of Object.entries(raw.profiles)) {
        if (Array.isArray(ids)) cache.profiles[profile] = [...new Set(ids.map(String))];
      }
      cache.updatedAt = raw.updatedAt || null;
    }
    return cache;
  } catch {
    return emptyApifySeenCache();
  }
}

export function saveApifySeenCache(file = DEFAULT_APIFY_SEEN_CACHE_PATH, cache, nowIso) {
  const out = { schemaVersion: APIFY_SEEN_CACHE_SCHEMA, updatedAt: nowIso, profiles: {} };
  for (const [profile, ids] of Object.entries(cache?.profiles ?? {})) out.profiles[profile] = [...new Set((ids ?? []).map(String))].sort();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  return out;
}

/** A record's stable dedup identity for the seen cache: its canonical URL if mapped, else its raw discovery URL. */
export function seenKeyFor(record) {
  return String(record?.canonicalUrl || record?.url || record?.discoveryUrl || '').trim() || null;
}
