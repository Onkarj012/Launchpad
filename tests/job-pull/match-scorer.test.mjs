import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MatchScorerError, createCodexScorer, execCodex, scoreCandidates } from '../../job-pull/match-scorer.mjs';

function candidate(index, overrides = {}) {
  return {
    canonicalUrl: `https://jobs.example.test/roles/${index}`,
    title: 'AI Engineer',
    company: `Company ${index}`,
    location: 'Pune, India',
    description: 'Build Python and FastAPI LLM services with RAG and pgvector.',
    postedAt: '2026-07-24T06:30:00.000Z',
    freshnessWindow: 'Hot',
    selectionTier: 'strict',
    ...overrides,
  };
}

function scoreRow(row, overrides = {}) {
  return {
    canonicalUrl: row.canonicalUrl,
    matchScore: 72,
    rationale: 'Python/FastAPI stack overlap; new-grad friendly.',
    strongestHook: 'Shipped a RAG support bot used in production.',
    responseLikelihood: 12,
    autoSuggest: false,
    descriptionAvailable: true,
    ...overrides,
  };
}

function fakeScoreChunk(handler) {
  const calls = [];
  const scoreChunk = async (rows, context) => {
    calls.push({ rows, context });
    return handler(rows, context);
  };
  scoreChunk.calls = calls;
  return scoreChunk;
}

test('chunking splits 25 candidates into three sequential calls (12/12/1)', async () => {
  const candidates = Array.from({ length: 25 }, (_, index) => candidate(index + 1));
  const scoreChunk = fakeScoreChunk((rows) => rows.map((row) => scoreRow(row)));
  const result = await scoreCandidates(candidates, { scoreChunk });
  assert.equal(scoreChunk.calls.length, 3);
  assert.deepEqual(scoreChunk.calls.map((call) => call.rows.length), [12, 12, 1]);
  assert.equal(result.chunks, 3);
  assert.equal(result.failures.length, 0);
  assert.equal(result.scored.length, 25);
  assert.ok(result.scored.every((merged) => merged.matchScore === 72));
});

test('a merged candidate carries matchScore, rationale, hook, strongestHook and responseLikelihood', async () => {
  const original = candidate(1);
  const scoreChunk = fakeScoreChunk((rows) => rows.map((row) => scoreRow(row, {
    matchScore: 88,
    rationale: 'Exact stack match.',
    strongestHook: 'Lead engineer on a shipped product.',
    responseLikelihood: 17,
  })));
  const result = await scoreCandidates([original], { scoreChunk });
  const [merged] = result.scored;
  assert.equal(merged.matchScore, 88);
  assert.equal(merged.rationale, 'Exact stack match.');
  assert.equal(merged.hook, 'Lead engineer on a shipped product.');
  assert.equal(merged.strongestHook, 'Lead engineer on a shipped product.');
  assert.equal(merged.responseLikelihood, 17);
  assert.equal(merged.title, 'AI Engineer');
  assert.equal(merged.canonicalUrl, original.canonicalUrl);
  assert.equal(original.matchScore, undefined);
});

test('a candidate without a description is flagged descriptionAvailable: false and capped at the honest partial score', async () => {
  const scoreChunk = fakeScoreChunk((rows) => rows.map((row) => scoreRow(row, {
    matchScore: 90,
    descriptionAvailable: row.descriptionAvailable,
  })));
  const result = await scoreCandidates([candidate(1, { description: undefined })], { scoreChunk });
  assert.equal(scoreChunk.calls[0].rows[0].descriptionAvailable, false);
  assert.equal(result.scored[0].matchScore, 45);
});

test('autoSuggest is computed in JS from pipeline facts and never from the model boolean', async () => {
  const freshStrict = candidate(1);
  const backfill = candidate(2, { freshnessWindow: 'Backfill' });
  const scoreChunk = fakeScoreChunk((rows) => rows.map((row) => scoreRow(row, {
    matchScore: 90,
    responseLikelihood: 18,
    autoSuggest: row.canonicalUrl === freshStrict.canonicalUrl ? false : true,
  })));
  const result = await scoreCandidates([freshStrict, backfill], { scoreChunk });
  assert.equal(result.scored[0].autoSuggest, true);
  assert.equal(result.scored[1].autoSuggest, false);
});

test('a missing codex binary degrades with an explicit reason code instead of throwing', async () => {
  const scorer = createCodexScorer({ codexBinary: '/definitely/not/a/real/codex-binary' });
  const result = await scorer([candidate(1)]);
  assert.equal(result.degraded, true);
  assert.equal(result.reasonCode, 'SCORER_BINARY_MISSING');
  assert.deepEqual(result.failures, [{ canonicalUrl: 'https://jobs.example.test/roles/1', reason: 'SCORER_BINARY_MISSING' }]);
  assert.equal(result.scored[0].matchScore, undefined);
});

test('one failing chunk records its rows and does not abort the remaining chunks', async () => {
  const candidates = Array.from({ length: 25 }, (_, index) => candidate(index + 1));
  const scoreChunk = fakeScoreChunk((rows, { chunkIndex }) => {
    if (chunkIndex === 1) throw new MatchScorerError('codex exited 1: boom', 'SCORER_EXEC_FAILED');
    return rows.map((row) => scoreRow(row));
  });
  const result = await scoreCandidates(candidates, { scoreChunk });
  assert.equal(scoreChunk.calls.length, 3);
  assert.equal(result.chunks, 3);
  assert.equal(result.degraded, false);
  assert.equal(result.failures.length, 12);
  assert.ok(result.failures.every((failure) => failure.reason === 'SCORER_EXEC_FAILED'));
  assert.equal(result.scored.filter((merged) => typeof merged.matchScore === 'number').length, 13);
});

test('all timed-out chunks degrade the run with a SCORER_TIMEOUT reason code', async () => {
  const candidates = Array.from({ length: 25 }, (_, index) => candidate(index + 1));
  const scoreChunk = fakeScoreChunk(() => { throw new MatchScorerError('timed out', 'SCORER_TIMEOUT'); });
  const result = await scoreCandidates(candidates, { scoreChunk });
  assert.equal(scoreChunk.calls.length, 3);
  assert.equal(result.chunks, 3);
  assert.equal(result.degraded, true);
  assert.equal(result.reasonCode, 'SCORER_TIMEOUT');
  assert.equal(result.failures.length, 25);
});

test('one timed-out chunk among successful chunks remains a partial failure', async () => {
  const candidates = Array.from({ length: 25 }, (_, index) => candidate(index + 1));
  const scoreChunk = fakeScoreChunk((rows, { chunkIndex }) => {
    if (chunkIndex === 1) throw new MatchScorerError('timed out', 'SCORER_TIMEOUT');
    return rows.map((row) => scoreRow(row));
  });
  const result = await scoreCandidates(candidates, { scoreChunk });
  assert.equal(scoreChunk.calls.length, 3);
  assert.equal(result.degraded, false);
  assert.equal(result.reasonCode, null);
  assert.equal(result.failures.length, 12);
  assert.equal(result.scored.filter((merged) => typeof merged.matchScore === 'number').length, 13);
});

test('timeout errors include a trimmed stderr tail or an explicit empty marker', async () => {
  const stderr = `prefix\n${'x'.repeat(2500)}\n`;
  await assert.rejects(
    () => execCodex((binary, args, options, callback) => callback({ killed: true, signal: 'SIGTERM' }, '', stderr), '/bin/codex', [], 42),
    (error) => {
      assert.equal(error.reasonCode, 'SCORER_TIMEOUT');
      assert.ok(error.message.endsWith('x'.repeat(2000)));
      assert.ok(!error.message.endsWith('x'.repeat(2001)));
      return true;
    },
  );
  await assert.rejects(
    () => execCodex((binary, args, options, callback) => callback({ killed: true, signal: 'SIGTERM' }, '', ''), '/bin/codex', [], 42),
    (error) => error.reasonCode === 'SCORER_TIMEOUT' && error.message.endsWith('no stderr'),
  );
});

test('production scorer ignores user config, sets reasoning effort, and honors timeout precedence', async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'launchpad-match-scorer-'));
  const previousTimeout = process.env.MATCH_SCORER_TIMEOUT_MS;
  process.env.MATCH_SCORER_TIMEOUT_MS = '4321';
  const calls = [];
  const execFileImpl = (binary, args, options, callback) => {
    calls.push({ binary, args, options });
    const outputFile = args[args.indexOf('-o') + 1];
    writeFileSync(outputFile, JSON.stringify({ scores: [scoreRow({ canonicalUrl: candidate(calls.length).canonicalUrl })] }));
    callback(null, '', '');
  };
  try {
    const scorer = createCodexScorer({ codexBinary: process.execPath, workDir, reasoningEffort: 'medium', execFileImpl });
    await scorer([candidate(1)]);
    const explicit = createCodexScorer({ codexBinary: process.execPath, workDir, timeoutMs: 99, execFileImpl });
    await explicit([candidate(2)]);
  } finally {
    if (previousTimeout === undefined) delete process.env.MATCH_SCORER_TIMEOUT_MS;
    else process.env.MATCH_SCORER_TIMEOUT_MS = previousTimeout;
  }
  assert.ok(calls[0].args.includes('--ignore-user-config'));
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('-c'), calls[0].args.indexOf('-c') + 2), ['-c', 'model_reasoning_effort=medium']);
  assert.equal(calls[0].options.timeout, 4321);
  assert.equal(calls[1].options.timeout, 99);
});

test('chunk artifacts are run-isolated and stale output is removed before spawn', async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'launchpad-match-scorer-isolation-'));
  const outputFiles = [];
  const outputWasAbsent = [];
  const execFileImpl = (binary, args, options, callback) => {
    const outputFile = args[args.indexOf('-o') + 1];
    outputFiles.push(outputFile);
    outputWasAbsent.push(!existsSync(outputFile));
    writeFileSync(outputFile, JSON.stringify({ scores: [scoreRow({ canonicalUrl: candidate(outputFiles.length).canonicalUrl })] }));
    callback(null, '', '');
  };
  const scorer = createCodexScorer({ codexBinary: process.execPath, workDir, execFileImpl });
  await scorer([candidate(1)], { runId: 'run-a' });
  await scorer([candidate(2)], { runId: 'run-a' });
  await scorer([candidate(3)], { runId: 'run-b' });
  assert.equal(outputFiles[0], outputFiles[1]);
  assert.notEqual(outputFiles[0], outputFiles[2]);
  assert.deepEqual(outputWasAbsent, [true, true, true]);
});

test('spawn failure is a broken scorer and preserves captured stderr', async () => {
  const scorer = createCodexScorer({
    codexBinary: process.execPath,
    workDir: mkdtempSync(path.join(os.tmpdir(), 'launchpad-match-scorer-spawn-')),
    execFileImpl: (binary, args, options, callback) => callback(
      { code: 'ENOENT', message: 'spawn failed' },
      '',
      'launchd could not execute codex',
    ),
  });
  const result = await scorer([candidate(1)], { runId: 'spawn-run' });
  assert.equal(result.degraded, true);
  assert.equal(result.reasonCode, 'SCORER_SPAWN_FAILED');
  assert.deepEqual(result.failures, [{
    canonicalUrl: candidate(1).canonicalUrl,
    reason: 'SCORER_SPAWN_FAILED',
    stderr: 'launchd could not execute codex',
  }]);
  assert.equal(result.scored[0].scoringFailureReason, 'SCORER_SPAWN_FAILED');
});

test('range validation accepts clean integer strings and fails invalid rows without clamping', async () => {
  const rows = [candidate(1), candidate(2)];
  const scoreChunk = fakeScoreChunk((jobs) => [
    scoreRow(jobs[0], { matchScore: '91', responseLikelihood: '18' }),
    scoreRow(jobs[1], { matchScore: 91, responseLikelihood: 78 }),
  ]);
  const result = await scoreCandidates(rows, { scoreChunk });
  assert.equal(result.scored[0].matchScore, 91);
  assert.equal(result.scored[0].responseLikelihood, 18);
  assert.equal(result.scored[1].matchScore, null);
  assert.equal(result.scored[1].scoringFailureReason, 'SCORER_INVALID_RANGE');
  assert.deepEqual(result.failures, [{
    canonicalUrl: candidate(2).canonicalUrl,
    reason: 'SCORER_INVALID_RANGE',
    stderr: null,
  }]);
});

test('whole-scoring deadline bounds the batch and scorer input carries available evidence metadata', async () => {
  let scoringRow;
  const scoreChunk = fakeScoreChunk((rows) => {
    [scoringRow] = rows;
    return new Promise(() => {});
  });
  const result = await scoreCandidates([candidate(1, {
    description: 'x'.repeat(5000),
    sourceKind: 'ats-direct',
    companyStage: 'Scale-up',
    companyStageEvidence: 'verified company profile',
    companySize: 120,
    companySizeEvidence: 'verified headcount',
  })], {
    scoreChunk,
    runAt: '2026-07-26T04:30:00.000Z',
    wholeTimeoutMs: 10,
  });
  assert.equal(result.reasonCode, 'SCORER_DEADLINE_EXCEEDED');
  assert.equal(result.degraded, true);
  assert.equal(scoringRow.runAt, '2026-07-26T04:30:00.000Z');
  assert.equal(scoringRow.sourceKind, 'ats-direct');
  assert.equal(scoringRow.companyStageEvidence, 'verified company profile');
  assert.equal(scoringRow.companySizeEvidence, 'verified headcount');
  assert.equal(scoringRow.descriptionIncludedChars, 4000);
  assert.equal(scoringRow.descriptionTruncated, true);
});
