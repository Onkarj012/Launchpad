import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseJsonOutput, recordsFromResult, deriveProvider, finalizeManifest, normalizeSourceRecords, readJsonInput, sourceManifest, SourceContractError } from './common.mjs';

// The tiered warm scanner (user layer) — daily runs hit only the warm set of
// productive boards; `full: true` delegates to the 13k-board discovery crawl.
const WARM_SCAN_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'reverse-warm-scan.mjs');

export const REVERSE_ATS = ['greenhouse', 'lever', 'ashby', 'workday'];

export function reverseAtsCandidatesFromJson(result, { runAt = new Date().toISOString() } = {}) {
  const records = recordsFromResult('reverse-ats', result);
  const candidates = normalizeSourceRecords(records, {
    source: 'reverse-ats',
    sourceKind: 'ats-direct',
    runAt,
    currentFeedIsLive: true,
  });
  const attemptedProviders = Array.isArray(result?.sources) ? result.sources : REVERSE_ATS;
  const attemptedSeeds = Array.isArray(result?.seeds) ? result.seeds : [];
  const unreachableBoards = Number(result?.unreachableBoards || 0);
  const degradedDatasets = Object.values(result?.datasetStatus || {}).some((status) => status !== 'ok');
  const manifest = finalizeManifest(sourceManifest('reverse-ats', 'reverse-ats', {
    status: unreachableBoards > 0 || degradedDatasets ? 'degraded' : 'ok',
    providers: attemptedProviders,
    seeds: attemptedSeeds,
    providerAttempts: REVERSE_ATS.map((provider) => ({
      provider,
      attempted: attemptedProviders.includes(provider),
      status: attemptedProviders.includes(provider)
        ? (result?.datasetStatus?.[provider] || (unreachableBoards > 0 ? 'degraded' : 'ok'))
        : 'not-attempted',
    })),
    seedAttempts: ['yc', 'a16z'].map((seed) => ({ seed, attempted: attemptedSeeds.includes(seed), status: attemptedSeeds.includes(seed) ? 'ok' : 'not-attempted' })),
    failed: unreachableBoards,
    errors: unreachableBoards > 0 ? [`${unreachableBoards} reverse ATS boards unreachable`] : [],
  }), candidates);
  return { candidates, manifest };
}

export function runReverseAtsScan({ careerOpsDir, runAt = new Date().toISOString(), sinceDays = 3, full = false, promote = false, execute = execFileSync, jsonResult = null } = {}) {
  if (jsonResult != null) return reverseAtsCandidatesFromJson(jsonResult, { runAt });
  if (!careerOpsDir) throw new SourceContractError('reverse-ats', 'careerOpsDir is required when no fixture is supplied');
  let stdout;
  try {
    // Default: warm scan (only boards proven to yield eligible matches — minutes).
    // full: the 13k-board discovery crawl (~1hr); promote grows the warm set.
    const args = [WARM_SCAN_SCRIPT, '--ats', REVERSE_ATS.join(','), '--since', String(sinceDays)];
    if (full) {
      args.push('--full');
      if (promote) args.push('--promote');
    }
    args.push('--json');
    stdout = execute(process.execPath, args, { cwd: careerOpsDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    throw new SourceContractError('reverse-ats', `process failed: ${error.message}`);
  }
  return reverseAtsCandidatesFromJson(parseJsonOutput('reverse-ats', stdout), { runAt });
}

export function reverseAtsCandidatesFromFixture(input, options = {}) {
  return reverseAtsCandidatesFromJson(readJsonInput(input, 'reverse-ats'), options);
}
