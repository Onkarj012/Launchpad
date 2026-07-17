import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseJsonOutput, recordsFromResult, deriveProvider, finalizeManifest, normalizeSourceRecords, readJsonInput, sourceManifest, SourceContractError } from './common.mjs';

export function trackedCandidatesFromJson(result, { runAt = new Date().toISOString() } = {}) {
  const records = recordsFromResult('tracked', result);
  const candidates = normalizeSourceRecords(records, { source: 'tracked-scan', sourceKind: 'ats-direct', runAt, currentFeedIsLive: true });
  const errors = Array.isArray(result?.errors) ? result.errors.map((error) => typeof error === 'string' ? error : `${error.company || 'source'}: ${error.error || 'unknown error'}`) : [];
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  return {
    candidates,
    manifest: finalizeManifest(sourceManifest('tracked', 'tracked-ats', {
      status: errors.length ? 'degraded' : 'ok',
      failed: errors.length,
      errors,
      warnings,
      stats: result?.stats || null,
    }), candidates),
  };
}

export function runTrackedScan({ careerOpsDir, runAt = new Date().toISOString(), execute = execFileSync, jsonResult = null } = {}) {
  if (jsonResult != null) return trackedCandidatesFromJson(jsonResult, { runAt });
  if (!careerOpsDir) throw new SourceContractError('tracked', 'careerOpsDir is required when no fixture is supplied');
  const script = path.resolve(careerOpsDir, 'scan.mjs');
  let stdout;
  try {
    stdout = execute(process.execPath, [script, '--dry-run', '--json'], { cwd: careerOpsDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    throw new SourceContractError('tracked', `process failed: ${error.message}`);
  }
  return trackedCandidatesFromJson(parseJsonOutput('tracked', stdout), { runAt });
}

export function trackedCandidatesFromFixture(input, options = {}) {
  return trackedCandidatesFromJson(readJsonInput(input, 'tracked'), options);
}
