import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class MatchScorerError extends Error {
  constructor(message, reasonCode = 'SCORER_FAILED') { super(message); this.name = 'MatchScorerError'; this.reasonCode = reasonCode; }
}

const DEFAULT_CHUNK_SIZE = 12;
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_WORK_DIR = path.join('.local', 'launchpad-crawler');
const DEFAULT_SCHEMA_PATH = path.join('config', 'match-score.schema.json');
const DEFAULT_MODEL = 'gpt-5.6-luna';
const MAX_DESCRIPTION_CHARS = 4000;
// Seniority (15) + Location/remote (10) + Response Likelihood (20) are the only
// rubric dimensions that can be scored honestly without JD text. Their partial
// sum is the cap for description-less rows — Skill match and Domain relevance
// are never guessed.
const NO_DESCRIPTION_MAX_SCORE = 15 + 10 + 20;

// The 04:30 launchd agent runs with a minimal environment; /opt/homebrew/bin is
// very likely not on PATH, so the codex binary is resolved by absolute path.
const CODEX_BINARY_CANDIDATES = Object.freeze([
  '/opt/homebrew/bin/codex',
  path.join(os.homedir(), '.local', 'bin', 'codex'),
  '/usr/local/bin/codex',
]);

const AUTH_FAILURE_PATTERN = /not logged in|unauthorized|forbidden|authentication|please log ?in|\b401\b|\b403\b/i;

/** Resolve the codex binary by absolute path; never invoke a bare `codex`. */
export function resolveCodexBinary(explicit = null) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  return CODEX_BINARY_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

function descriptionText(candidate) {
  const value = typeof candidate?.description === 'string' ? candidate.description.trim() : '';
  return value || null;
}

function jobRowForScoring(candidate) {
  const description = descriptionText(candidate);
  return {
    canonicalUrl: candidate.canonicalUrl ?? null,
    title: candidate.title ?? null,
    company: candidate.company ?? null,
    location: candidate.location ?? null,
    workMode: candidate.workMode ?? null,
    employmentType: candidate.employment?.type ?? null,
    experience: candidate.experience ?? null,
    postedAt: candidate.postedAt ?? null,
    source: candidate.source ?? null,
    provider: candidate.provider ?? null,
    selectionTier: candidate.selectionTier ?? candidate.eligibility?.tier ?? null,
    freshnessWindow: candidate.freshnessWindow ?? candidate.freshness?.window ?? null,
    descriptionAvailable: description !== null,
    description: description ? description.slice(0, MAX_DESCRIPTION_CHARS) : null,
  };
}

// Self-contained scoring prompt: codex runs `-s read-only --ephemeral`, so the
// rubric and identity are embedded here instead of read from master_prompt.md.
function buildScoringPrompt(chunkFile, rowCount) {
  return [
    'You are the Match Score engine for Onkar Jadhav\'s job-search pipeline. Score every job in the chunk file and return JSON that conforms to the required output schema.',
    '',
    `Input: read the JSON file at ${chunkFile}. It contains { "jobs": [...] } with ${rowCount} role(s). Each job carries a canonicalUrl — echo it back EXACTLY as the join key for that job's score row.`,
    '',
    'Candidate identity: Onkar Jadhav — B.Tech Computer Science new grad (graduating Jun 2026), based in Pune, India. Stack: Python, TypeScript, React/Next, FastAPI, RAG, agentic AI, ML, pgvector. Target titles: AI/LLM Engineer, Agentic AI Engineer, ML Engineer, Full-Stack (AI-leaning), Backend (Python), new-grad SWE. Location policy: Pune or remote-India.',
    '',
    'Rubric — weighted sum, five dimensions, total 0-100:',
    '- Skill match (35): overlap between the JD\'s required skills and the stack above.',
    '- Domain / role relevance (20): is the actual work AI/ML/backend/full-stack versus off-target.',
    '- Seniority fit (15): entry/fresher friendly = high; senior-only (but under the 3-year hard gate) = low.',
    '- Location / remote fit (10): remote-India / Pune / hybrid = high; onsite abroad = low.',
    '- Response Likelihood (20): small company (<200 people) + posted <48h ago + >=70% skill match + ATS-direct source = high; big company + stale posting + aggregator source = low.',
    '',
    'Rules:',
    '1. If a job\'s descriptionAvailable is false, no JD text was available: award ZERO for Skill match and Domain / role relevance — never guess them. Score only Seniority fit, Location / remote fit and Response Likelihood from the title, company and metadata, so the honest maximum total is 45.',
    '2. matchScore is the integer sum of the five dimension sub-scores.',
    '3. rationale: one line explaining the score.',
    '4. strongestHook: the single strongest hook to lead a tailored resume or email with.',
    '5. responseLikelihood: the Response Likelihood sub-score (0-20).',
    '6. autoSuggest: your opinion whether the role is a strong pick (matchScore >= 80, posted within the last week, new-grad-friendly, responseLikelihood >= 14). The pipeline recomputes this from pipeline facts; answer honestly anyway.',
    '7. descriptionAvailable: echo the input flag for the job.',
    '8. Never fabricate evidence. When a fact is unknown, score conservatively instead of guessing.',
    '',
    `Return exactly one scores row per input job (${rowCount} rows total).`,
  ].join('\n');
}

// Auto-Suggest is computed in JS from pipeline facts (freshness window and
// selection tier), never from the model's boolean. It is an opinion only and
// must never set Make Resume or Applied?.
function autoSuggestFor(candidate, matchScore, responseLikelihood) {
  const window = candidate.freshnessWindow ?? candidate.freshness?.window ?? null;
  const tier = candidate.selectionTier ?? candidate.eligibility?.tier ?? null;
  return Number(matchScore) >= 80
    && (window === 'Hot' || window === 'Active')
    && String(tier ?? '').toLowerCase() === 'strict'
    && Number(responseLikelihood) >= 14;
}

// Candidate-level merge mirroring applyScores (job-pull/run.mjs:153) field
// semantics, minus its original-application/contact side fields, which the
// scorer never touches. Returns null when the row carries no usable score.
function mergeScoreRow(candidate, row) {
  const score = Number(row?.matchScore ?? row?.score);
  if (!Number.isFinite(score)) return null;
  const descriptionAvailable = descriptionText(candidate) !== null;
  const matchScore = descriptionAvailable ? score : Math.min(score, NO_DESCRIPTION_MAX_SCORE);
  const hook = typeof (row.strongestHook ?? row.hook) === 'string' ? (row.strongestHook ?? row.hook) : null;
  const responseLikelihood = Number.isFinite(Number(row.responseLikelihood)) ? Number(row.responseLikelihood) : null;
  return {
    ...candidate,
    matchScore,
    rationale: typeof row.rationale === 'string' ? row.rationale : candidate.rationale,
    hook: hook ?? candidate.hook,
    strongestHook: hook ?? candidate.strongestHook,
    responseLikelihood: responseLikelihood ?? candidate.responseLikelihood,
    autoSuggest: autoSuggestFor(candidate, matchScore, responseLikelihood),
  };
}

/**
 * Score normalized candidates through an injected per-chunk scorer. Mutates
 * nothing; returns merged copies plus telemetry. Infra failures degrade the
 * run with an explicit reasonCode instead of throwing — the caller decides
 * the run outcome.
 */
export async function scoreCandidates(candidates, { scoreChunk, chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return { scored: [], failures: [], chunks: 0, degraded: false, reasonCode: null };
  if (typeof scoreChunk !== 'function') throw new MatchScorerError('scoreCandidates requires a scoreChunk(rows, context) function', 'SCORER_NOT_CONFIGURED');
  const size = Math.max(1, Math.trunc(Number(chunkSize)) || DEFAULT_CHUNK_SIZE);
  const chunks = [];
  for (let index = 0; index < list.length; index += size) chunks.push(list.slice(index, index + size));

  const failures = [];
  const failedUrls = new Set();
  const rowsByUrl = new Map();
  let chunksAttempted = 0;
  let degraded = false;
  let reasonCode = null;
  let aborted = false;
  let consecutiveInvalidOutput = 0;

  const recordChunkFailure = (chunk, reason) => {
    for (const candidate of chunk) {
      failures.push({ canonicalUrl: candidate.canonicalUrl ?? null, reason });
      failedUrls.add(candidate.canonicalUrl);
    }
  };

  // Nightly batch: chunks run sequentially, one failure never aborts the rest.
  for (let index = 0; index < chunks.length && !aborted; index++) {
    const chunk = chunks[index];
    let returned;
    try {
      chunksAttempted++;
      returned = await scoreChunk(chunk.map(jobRowForScoring), { chunkIndex: index, chunkCount: chunks.length });
    } catch (error) {
      const reason = error instanceof MatchScorerError ? error.reasonCode : 'SCORER_CHUNK_FAILED';
      if (reason === 'SCORER_BINARY_MISSING' || reason === 'SCORER_AUTH_FAILED') {
        // Run-level failures: every remaining chunk would fail identically.
        for (const rest of chunks.slice(index)) recordChunkFailure(rest, reason);
        degraded = true;
        reasonCode = reason;
        aborted = true;
        continue;
      }
      recordChunkFailure(chunk, reason);
      if (reason === 'SCORER_OUTPUT_INVALID') {
        consecutiveInvalidOutput++;
        if (consecutiveInvalidOutput >= 2) {
          // Output that is unparseable in a way that repeats means the scorer
          // is broken, not the chunk — degrade rather than burn the batch.
          for (const rest of chunks.slice(index + 1)) recordChunkFailure(rest, reason);
          degraded = true;
          reasonCode = reason;
          aborted = true;
        }
      } else {
        consecutiveInvalidOutput = 0;
      }
      continue;
    }
    const scoreRows = Array.isArray(returned) ? returned : returned?.scores;
    if (!Array.isArray(scoreRows)) {
      recordChunkFailure(chunk, 'SCORER_OUTPUT_INVALID');
      consecutiveInvalidOutput++;
      if (consecutiveInvalidOutput >= 2) {
        for (const rest of chunks.slice(index + 1)) recordChunkFailure(rest, 'SCORER_OUTPUT_INVALID');
        degraded = true;
        reasonCode = 'SCORER_OUTPUT_INVALID';
        aborted = true;
      }
      continue;
    }
    consecutiveInvalidOutput = 0;
    for (const row of scoreRows) {
      if (row && typeof row.canonicalUrl === 'string' && row.canonicalUrl && !rowsByUrl.has(row.canonicalUrl)) {
        rowsByUrl.set(row.canonicalUrl, row);
      }
    }
  }

  const scored = list.map((candidate) => {
    const row = rowsByUrl.get(candidate.canonicalUrl);
    if (!row) {
      // Rows the model omits stay unscored and land in failures.
      if (!failedUrls.has(candidate.canonicalUrl)) failures.push({ canonicalUrl: candidate.canonicalUrl ?? null, reason: 'SCORER_ROW_MISSING' });
      return { ...candidate };
    }
    const merged = mergeScoreRow(candidate, row);
    if (!merged) {
      failures.push({ canonicalUrl: candidate.canonicalUrl ?? null, reason: 'SCORER_ROW_INVALID' });
      return { ...candidate };
    }
    return merged;
  });

  return { scored, failures, chunks: chunksAttempted, degraded, reasonCode };
}

function execCodex(execFileImpl, binary, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFileImpl(binary, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        // A bounded timeout per chunk: a hung child cannot stall the 04:30 run.
        if (error.killed || error.signal === 'SIGTERM') {
          reject(new MatchScorerError(`codex chunk timed out after ${timeoutMs}ms`, 'SCORER_TIMEOUT'));
          return;
        }
        if (typeof error.code === 'number') {
          resolve({ code: error.code, stderr: String(stderr ?? '') });
          return;
        }
        reject(new MatchScorerError(`codex could not start: ${error.message}`, 'SCORER_SPAWN_FAILED'));
        return;
      }
      resolve({ code: 0, stderr: String(stderr ?? '') });
    });
  });
}

/**
 * Build the production scorer: an async scoreCandidates-compatible function
 * that chunks candidates through `codex exec` with schema-constrained output.
 * Constructing it never touches the filesystem or a child process; binary
 * resolution failure surfaces as a degraded SCORER_BINARY_MISSING result.
 */
export function createCodexScorer({
  codexBinary = null,
  model = DEFAULT_MODEL,
  workDir = DEFAULT_WORK_DIR,
  schemaPath = DEFAULT_SCHEMA_PATH,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  execFileImpl = execFile,
} = {}) {
  const binary = resolveCodexBinary(codexBinary);
  const resolvedWorkDir = path.resolve(workDir);
  const resolvedSchema = path.resolve(schemaPath);

  async function scoreChunk(rows, { chunkIndex = 0 } = {}) {
    if (!binary) throw new MatchScorerError('codex binary not found at any known absolute path; pass codexBinary or install codex', 'SCORER_BINARY_MISSING');
    mkdirSync(resolvedWorkDir, { recursive: true });
    const chunkFile = path.join(resolvedWorkDir, `scores-chunk-${chunkIndex}-jobs.json`);
    const outputFile = path.join(resolvedWorkDir, `scores-chunk-${chunkIndex}.json`);
    writeFileSync(chunkFile, `${JSON.stringify({ jobs: rows }, null, 2)}\n`, 'utf8');
    // argv array only — never a shell string, never interpolated job text.
    const args = [
      'exec',
      '-m', model,
      '-s', 'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--output-schema', resolvedSchema,
      '-o', outputFile,
      buildScoringPrompt(chunkFile, rows.length),
    ];
    const { code, stderr } = await execCodex(execFileImpl, binary, args, timeoutMs);
    if (code !== 0) {
      const detail = stderr.split(/\r?\n/).find((line) => line.trim()) ?? 'no stderr';
      if (AUTH_FAILURE_PATTERN.test(stderr)) throw new MatchScorerError(`codex authentication failed: ${detail}`, 'SCORER_AUTH_FAILED');
      throw new MatchScorerError(`codex exited ${code}: ${detail}`, 'SCORER_EXEC_FAILED');
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(outputFile, 'utf8'));
    } catch (error) {
      throw new MatchScorerError(`codex output at ${outputFile} is not valid JSON: ${error.message}`, 'SCORER_OUTPUT_INVALID');
    }
    const scores = Array.isArray(parsed) ? parsed : parsed?.scores;
    if (!Array.isArray(scores)) throw new MatchScorerError(`codex output at ${outputFile} has no scores array`, 'SCORER_OUTPUT_INVALID');
    return scores;
  }

  return (candidates, options = {}) => scoreCandidates(candidates, { ...options, scoreChunk });
}
