#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateDedupKey, canonicalizeUrl } from './candidate.mjs';
import { readOpportunityLedger, recordSurfaced } from './opportunity-ledger.mjs';

function valuesAfter(argv, flag) {
  return argv.flatMap((value, index) => value === flag ? [argv[index + 1]] : []).filter(Boolean);
}

function jsonFiles(root) {
  if (!existsSync(root)) return [];
  const stats = statSync(root);
  if (stats.isFile()) return root.endsWith('.json') ? [root] : [];
  if (!stats.isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    return jsonFiles(path.join(root, entry.name));
  });
}

function candidateFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const canonicalUrl = canonicalizeUrl(value.canonicalUrl ?? value.url);
  const company = typeof value.company === 'string' ? value.company.trim() : '';
  const title = typeof (value.title ?? value.role) === 'string' ? (value.title ?? value.role).trim() : '';
  if (!canonicalUrl || !company || !title) return null;
  return {
    canonicalUrl,
    company,
    title,
    location: typeof value.location === 'string' ? value.location : '',
    provider: typeof value.provider === 'string' ? value.provider : '',
  };
}

export function surfacedCandidates(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const candidates = [
    ...(Array.isArray(result.shortlist) ? result.shortlist : []),
    ...(Array.isArray(result.records) ? result.records.map((record) => record?.candidate ?? record) : []),
    ...(Array.isArray(result.applicationShortlist?.selected) ? result.applicationShortlist.selected : []),
  ].map(candidateFrom).filter(Boolean);
  const unique = new Map();
  for (const candidate of candidates) unique.set(candidateDedupKey(candidate), candidate);
  return [...unique.values()];
}

export function collectHistory(roots) {
  const candidates = new Map();
  const files = [...new Set(roots.flatMap(jsonFiles))];
  let parsedFiles = 0;
  let skippedFiles = 0;
  for (const file of files) {
    try {
      const result = JSON.parse(readFileSync(file, 'utf8'));
      parsedFiles++;
      for (const candidate of surfacedCandidates(result)) candidates.set(candidateDedupKey(candidate), candidate);
    } catch {
      skippedFiles++;
    }
  }
  return { candidates: [...candidates.values()], files: files.length, parsedFiles, skippedFiles };
}

export function main(argv = process.argv.slice(2)) {
  const roots = valuesAfter(argv, '--root');
  if (!roots.length || argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node job-pull/seed-opportunity-history.mjs --root PATH [--root PATH ...] [--now ISO]');
    return roots.length ? 0 : 1;
  }
  const nowIndex = argv.indexOf('--now');
  const now = nowIndex >= 0 ? argv[nowIndex + 1] : new Date().toISOString();
  const collected = collectHistory(roots);
  const before = readOpportunityLedger().rows.length;
  const recorded = recordSurfaced(collected.candidates, { now });
  const after = readOpportunityLedger().rows.length;
  console.log(JSON.stringify({
    roots,
    files: collected.files,
    parsedFiles: collected.parsedFiles,
    skippedFiles: collected.skippedFiles,
    candidates: collected.candidates.length,
    rowsBefore: before,
    rowsAfter: after,
    recorded: recorded.rows.length,
  }, null, 2));
  return 0;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
