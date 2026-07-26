import { readFileSync } from 'node:fs';
import { CandidateValidationError, normalizeCandidate } from '../candidate.mjs';

export class SourceContractError extends Error {
  constructor(source, message) {
    super(`${source} scanner contract error: ${message}`);
    this.name = 'SourceContractError';
    this.source = source;
  }
}

export function parseJsonOutput(source, stdout) {
  try {
    return JSON.parse(String(stdout || '').trim());
  } catch {
    throw new SourceContractError(source, 'expected JSON on stdout; the scanner may not implement --json yet');
  }
}

export function recordsFromResult(source, result) {
  if (Array.isArray(result)) return result;
  for (const key of ['offers', 'candidates', 'jobs', 'results']) {
    if (Array.isArray(result?.[key])) return result[key];
  }
  throw new SourceContractError(source, 'JSON result must contain an offers, candidates, jobs, or results array');
}

export function readJsonInput(input, source) {
  if (typeof input === 'object' && input !== null) return input;
  if (typeof input !== 'string' || !input) throw new SourceContractError(source, 'fixture path or JSON value is required');
  try {
    return JSON.parse(readFileSync(input, 'utf8'));
  } catch (error) {
    throw new SourceContractError(source, `could not read JSON fixture: ${error.message}`);
  }
}

export function deriveProvider(raw, fallback = null) {
  if (typeof raw.provider === 'string' && raw.provider.trim()) return raw.provider.trim().toLowerCase();
  const source = `${String(raw.source || '')} ${String(raw.url || raw.canonicalUrl || '')}`.toLowerCase();
  for (const provider of ['greenhouse', 'lever', 'ashby', 'workday', 'workable', 'smartrecruiters', 'breezy', 'recruitee']) {
    if (source.includes(provider)) return provider;
  }
  return fallback;
}

export function sourceManifest(sourceId, kind, patch = {}) {
  return {
    sourceId,
    kind,
    attempted: true,
    status: 'ok',
    fetched: 0,
    dated: 0,
    active: 0,
    notVerified: 0,
    eligible: 0,
    duplicate: 0,
    failed: 0,
    selected: 0,
    errors: [],
    ...patch,
  };
}

export function normalizeSourceRecords(records, options = {}) {
  return records.map((raw, index) => {
    try {
      return normalizeCandidate(raw, optionsForRecord(raw, options));
    } catch (error) {
      if (error instanceof CandidateValidationError) {
        throw new SourceContractError(options.source || 'source', `record ${index + 1}: ${error.message}`);
      }
      throw error;
    }
  });
}

function optionsForRecord(raw, options) {
  const provider = deriveProvider(raw, raw.provider ?? options.provider);
  const sourceKind = raw.sourceKind ?? (['greenhouse', 'lever', 'ashby', 'workday', 'workable', 'smartrecruiters', 'breezy', 'recruitee'].includes(provider)
    ? 'ats-direct'
    : options.sourceKind);
  return {
    source: raw.source ?? options.source,
    provider,
    sourceKind,
    sourceCategory: raw.sourceCategory ?? options.sourceCategory,
    runAt: options.runAt,
    currentFeedIsLive: options.currentFeedIsLive ?? false,
  };
}

export function finalizeManifest(manifest, candidates) {
  const next = { ...manifest, fetched: candidates.length };
  next.dated = candidates.filter((candidate) => candidate.postedAt != null).length;
  next.active = candidates.filter((candidate) => candidate.liveness.status === 'Active').length;
  next.notVerified = candidates.filter((candidate) => candidate.liveness.status === 'Not Verified').length;
  return next;
}
