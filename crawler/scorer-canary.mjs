#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexScorer } from '../job-pull/match-scorer.mjs';

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

export async function runScorerCanary({ inputPath, runId = `scorer-canary-${Date.now()}`, wholeTimeoutMs = 120_000 } = {}) {
  if (!inputPath) throw new Error('--input is required');
  const parsed = JSON.parse(readFileSync(path.resolve(inputPath), 'utf8'));
  const candidates = Array.isArray(parsed) ? parsed : parsed?.candidates ?? parsed?.jobs;
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > 12) throw new Error('scorer canary input must contain 1-12 candidates');
  const inputHash = `sha256:${createHash('sha256').update(JSON.stringify(candidates)).digest('hex')}`;
  const scorer = createCodexScorer({ workDir: path.join('.local', 'launchpad-crawler', 'scoring-canary'), wholeTimeoutMs });
  const startedAt = Date.now();
  const result = await scorer(candidates, { runId, runAt: new Date(startedAt).toISOString() });
  const passed = result.degraded !== true
    && result.failures.length === 0
    && result.scored.length === candidates.length
    && result.scored.every((candidate) => Number.isInteger(candidate.matchScore));
  return {
    schemaVersion: 'LaunchpadScorerCanaryV1',
    runId,
    inputHash,
    inputCount: candidates.length,
    elapsedMs: Date.now() - startedAt,
    passed,
    telemetry: {
      chunks: result.chunks,
      failures: result.failures,
      degraded: result.degraded,
      reasonCode: result.reasonCode,
      scoredCount: result.scored.filter((candidate) => Number.isInteger(candidate.matchScore)).length,
    },
  };
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  runScorerCanary({ inputPath: option(process.argv.slice(2), '--input'), runId: option(process.argv.slice(2), '--run-id') ?? undefined })
    .then((result) => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exitCode = result.passed ? 0 : 1; })
    .catch((error) => { process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1; });
}
