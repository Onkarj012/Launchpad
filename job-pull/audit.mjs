import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { canonicalizeUrl } from './candidate.mjs';
import { readLedger } from './ledger.mjs';

export const MISS_CLASSES = Object.freeze([
  'captured',
  'source-absent-or-failure',
  'indexing-lag',
  'date-parse',
  'title-geo-pay-false-negative',
  'dedup-false-positive',
  'liveness-uncertainty',
  'selection-cap',
]);

function readManifestFiles(paths) {
  return paths.flatMap((filePath) => {
    try {
      const value = JSON.parse(readFileSync(filePath, 'utf8'));
      return Array.isArray(value) ? value : [value];
    } catch {
      return [];
    }
  });
}

function manifestCandidates(manifests) {
  return manifests.flatMap((manifest) => [manifest.candidates, manifest.selected, manifest.offers, manifest.verifyQueue]
    .filter(Array.isArray)
    .flat());
}

function urlInLedger(url, rows) {
  const canonical = canonicalizeUrl(url);
  return rows.some((row) => canonical && canonicalizeUrl(row.canonical_url || row.url) === canonical);
}

export function classifyMiss(url, { manifests = [], ledgerRows = [], candidates = [] } = {}) {
  const canonical = canonicalizeUrl(url);
  if (!canonical || !/^https?:\/\//i.test(canonical)) return { url, classification: 'date-parse', reasonCode: 'AUDIT_URL_INVALID', evidence: null };
  if (urlInLedger(canonical, ledgerRows)) return { url, captured: true, classification: 'captured', reasonCode: 'AUDIT_LEDGER_MATCH', evidence: canonical };
  const matchingCandidates = candidates.filter((candidate) => canonicalizeUrl(candidate.canonicalUrl || candidate.url) === canonical);
  if (matchingCandidates.length) {
    const candidate = matchingCandidates[0];
    if (candidate.freshness?.code === 'FRESHNESS_UNDATED_VERIFY_QUEUE' || candidate.postedAt == null) return { url, classification: 'date-parse', reasonCode: 'AUDIT_UNDATED_OR_DATE_PARSE', evidence: candidate.postedAt ?? null };
    if (candidate.liveness?.status === 'Not Verified') return { url, classification: 'liveness-uncertainty', reasonCode: 'AUDIT_LIVENESS_NOT_VERIFIED', evidence: candidate.liveness.evidence || null };
    if (candidate.eligibility && !candidate.eligibility.eligible) return { url, classification: 'title-geo-pay-false-negative', reasonCode: candidate.eligibility.reasons?.[0] || 'AUDIT_GATE_REJECTION', evidence: candidate.eligibility };
    if (candidate.selectionTier == null || candidate.selected === false) return { url, classification: 'selection-cap', reasonCode: 'AUDIT_NOT_SELECTED', evidence: candidate.selectionReason || null };
  }
  const sourceManifests = manifests.filter((manifest) => manifest && manifest.sourceId);
  if (!sourceManifests.length) return { url, classification: 'source-absent-or-failure', reasonCode: 'AUDIT_NO_SOURCE_MANIFEST', evidence: null };
  if (sourceManifests.some((manifest) => manifest.status === 'failed' || manifest.errors?.length)) {
    return { url, classification: 'source-absent-or-failure', reasonCode: 'AUDIT_SOURCE_FAILED', evidence: sourceManifests.filter((manifest) => manifest.errors?.length).map((manifest) => manifest.sourceId) };
  }
  return { url, classification: 'indexing-lag', reasonCode: 'AUDIT_NOT_PRESENT_IN_RUN', evidence: sourceManifests.map((manifest) => manifest.sourceId) };
}

export function auditMissedLinks(urls, options = {}) {
  const manifests = options.manifests || [];
  const candidates = manifestCandidates(manifests);
  return urls.map((url) => classifyMiss(url, { ...options, manifests, candidates }));
}

function valuesAfter(args, name) {
  const output = [];
  for (let index = 0; index < args.length; index++) if (args[index] === name && args[index + 1]) output.push(args[++index]);
  return output;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv[0] === 'help') {
    console.log('Usage: node job-pull/audit.mjs --url URL [--url URL ...] [--manifest FILE] [--ledger FILE] [--dry-run]');
    return 0;
  }
  const urls = valuesAfter(argv, '--url');
  if (!urls.length) {
    console.error('audit requires at least one --url; no discovery or browser lookup is performed');
    return 1;
  }
  const manifestPaths = valuesAfter(argv, '--manifest');
  const manifests = readManifestFiles(manifestPaths);
  const ledgerPath = valuesAfter(argv, '--ledger')[0];
  const ledgerRows = ledgerPath && existsSync(ledgerPath) ? readLedger(ledgerPath).rows : [];
  console.log(JSON.stringify({ links: auditMissedLinks(urls, { manifests, ledgerRows }), dryRun: argv.includes('--dry-run') }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
