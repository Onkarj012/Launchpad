import { createHash } from 'node:crypto';
import { extractExperienceYears } from './candidate.mjs';

export const SENIORITY_PROMPT_VERSION = 'seniority-adjudication-v1';
export const SENIORITY_MODEL_VERSION = 'gpt-5.6-luna';
export const SENIORITY_DETERMINISTIC_VERSION = 'deterministic-seniority-v1';

const DECISIONS = new Set(['eligible', 'ineligible', 'uncertain']);
const REQUIREMENT_KINDS = new Set([
  'total-professional',
  'technology-specific',
  'domain-specific',
  'preferred',
  'ambiguous',
]);
const PREFERRED_PATTERN = /\b(preferred|nice to have|bonus|desirable|advantage)\b/i;
const STRONG_TOTAL_PATTERN = /\b(total|overall|industry experience|work experience|software development experience|production software)\b/i;
const TECHNOLOGY_PATTERN = /\b(python|java(?:script)?|typescript|react|node(?:\.js)?|c\+\+|c#|golang|rust|aws|azure|gcp|kubernetes|terraform|sql|pytorch|tensorflow)\b/i;
const DOMAIN_PATTERN = /\b(ai|artificial intelligence|machine learning|ml|llm|nlp|backend|frontend|full[ -]?stack|data engineering|fintech|healthcare|cybersecurity)\b/i;

function descriptionFor(candidate) {
  return typeof candidate?.description === 'string' ? candidate.description : '';
}

function finiteMinimum(value) {
  if (value == null || value === '') return null;
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function confidenceValue(value) {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

function contextFor(description, quote) {
  if (!quote) return description;
  const index = description.indexOf(quote);
  if (index < 0) return quote;
  return description.slice(Math.max(0, index - 100), Math.min(description.length, index + quote.length + 100));
}

function deterministicRequirementKind(description, quote) {
  const context = contextFor(description, quote);
  if (PREFERRED_PATTERN.test(context)) return 'preferred';
  if (STRONG_TOTAL_PATTERN.test(context)) return 'total-professional';
  if (TECHNOLOGY_PATTERN.test(context)) return 'technology-specific';
  if (DOMAIN_PATTERN.test(context)) return 'domain-specific';
  if (/\bprofessional experience\b/i.test(context)) return 'total-professional';
  if (/\b(requirements?|minimum|at least|must have|required)\b/i.test(context)) return 'total-professional';
  return 'ambiguous';
}

/** The existing regex extraction is retained as an observable signal only. */
export function deterministicSenioritySignal(candidate) {
  const description = descriptionFor(candidate);
  const parsed = extractExperienceYears(description);
  if (!parsed) {
    return {
      found: false,
      minimumYears: null,
      maximumYears: null,
      evidenceQuote: '',
      requirementKind: 'ambiguous',
    };
  }
  const evidenceQuote = description.includes(parsed.evidence) ? parsed.evidence : '';
  return {
    found: true,
    minimumYears: parsed.minYears,
    maximumYears: parsed.maxYears,
    evidenceQuote,
    requirementKind: deterministicRequirementKind(description, evidenceQuote || parsed.evidence),
  };
}

export function seniorityJdFingerprint(candidate) {
  return createHash('sha256').update(descriptionFor(candidate)).digest('hex');
}

function localModelOutput(signal) {
  if (!signal.found) {
    return {
      seniorityDecision: 'eligible',
      requirementKind: 'ambiguous',
      minimumYears: null,
      evidenceQuote: '',
      confidence: 0.7,
      reasonCode: 'SENIORITY_NO_MINIMUM_FOUND',
    };
  }
  if (signal.requirementKind === 'preferred') {
    return {
      seniorityDecision: 'eligible',
      requirementKind: 'preferred',
      minimumYears: signal.minimumYears,
      evidenceQuote: signal.evidenceQuote,
      confidence: 0.8,
      reasonCode: 'SENIORITY_PREFERRED_ONLY',
    };
  }
  if (signal.requirementKind === 'total-professional') {
    return {
      seniorityDecision: signal.minimumYears >= 3 ? 'ineligible' : 'eligible',
      requirementKind: signal.requirementKind,
      minimumYears: signal.minimumYears,
      evidenceQuote: signal.evidenceQuote,
      confidence: 0.85,
      reasonCode: signal.minimumYears >= 3 ? 'SENIORITY_TOTAL_MINIMUM_3_PLUS' : 'SENIORITY_TOTAL_MINIMUM_WITHIN_POLICY',
    };
  }
  if (['technology-specific', 'domain-specific'].includes(signal.requirementKind)
    && signal.minimumYears <= 2) {
    return {
      seniorityDecision: 'eligible',
      requirementKind: signal.requirementKind,
      minimumYears: signal.minimumYears,
      evidenceQuote: signal.evidenceQuote,
      confidence: 0.8,
      reasonCode: 'SENIORITY_SPECIFIC_MINIMUM_WITHIN_POLICY',
    };
  }
  return {
    seniorityDecision: 'uncertain',
    requirementKind: signal.requirementKind,
    minimumYears: signal.minimumYears,
    evidenceQuote: signal.evidenceQuote,
    confidence: 0.6,
    reasonCode: signal.requirementKind === 'technology-specific'
      ? 'SENIORITY_TECHNOLOGY_SPECIFIC_VERIFY'
      : signal.requirementKind === 'domain-specific'
        ? 'SENIORITY_DOMAIN_SPECIFIC_VERIFY'
        : 'SENIORITY_AMBIGUOUS_VERIFY',
  };
}

function invalidAssessment(candidate, signal, reasonCode, details, versions) {
  return {
    seniorityDecision: 'uncertain',
    requirementKind: 'ambiguous',
    minimumYears: signal.minimumYears,
    evidenceQuote: signal.evidenceQuote,
    confidence: 0,
    reasonCode,
    accepted: false,
    requiresVerification: true,
    validationError: details,
    deterministicSignal: signal,
    ...versions,
    jdFingerprint: seniorityJdFingerprint(candidate),
  };
}

/**
 * Validate model output and apply deterministic safety postconditions. A bad
 * evidence quote rejects the adjudication output and keeps the candidate in
 * verification; it can never silently become eligible or ineligible.
 */
export function adjudicateSeniority(candidate, output, {
  promptVersion = SENIORITY_PROMPT_VERSION,
  modelVersion = SENIORITY_MODEL_VERSION,
} = {}) {
  const description = descriptionFor(candidate);
  const signal = deterministicSenioritySignal(candidate);
  const versions = { promptVersion, modelVersion };
  const decision = output?.seniorityDecision;
  const requirementKind = output?.requirementKind;
  const minimumYears = finiteMinimum(output?.minimumYears);
  const evidenceQuote = typeof output?.evidenceQuote === 'string' ? output.evidenceQuote : null;
  const confidence = confidenceValue(output?.confidence);
  const reasonCode = typeof output?.reasonCode === 'string' && output.reasonCode.trim()
    ? output.reasonCode.trim()
    : null;
  if (!DECISIONS.has(decision)
    || !REQUIREMENT_KINDS.has(requirementKind)
    || output?.minimumYears != null && minimumYears == null
    || evidenceQuote == null
    || confidence == null
    || !reasonCode) {
    return invalidAssessment(candidate, signal, 'SENIORITY_MODEL_OUTPUT_INVALID', 'required field or enum is invalid', versions);
  }
  if (evidenceQuote && !description.includes(evidenceQuote)) {
    return invalidAssessment(candidate, signal, 'SENIORITY_EVIDENCE_QUOTE_NOT_IN_JD', 'evidenceQuote is not a literal JD substring', versions);
  }
  if (minimumYears != null && !evidenceQuote) {
    return invalidAssessment(candidate, signal, 'SENIORITY_EVIDENCE_QUOTE_REQUIRED', 'minimumYears requires an exact JD quote', versions);
  }

  let finalDecision = decision;
  let finalKind = requirementKind;
  let finalReason = reasonCode;
  let finalMinimum = minimumYears;
  let finalQuote = evidenceQuote;

  // A clear total-professional hard minimum is never overridable by the model.
  if (signal.requirementKind === 'total-professional' && signal.minimumYears >= 3 && signal.evidenceQuote) {
    finalDecision = 'ineligible';
    finalKind = 'total-professional';
    finalMinimum = signal.minimumYears;
    finalQuote = signal.evidenceQuote;
    finalReason = 'SENIORITY_TOTAL_MINIMUM_3_PLUS';
  } else if (finalKind === 'total-professional' && finalMinimum >= 3) {
    finalDecision = 'ineligible';
    finalReason = 'SENIORITY_TOTAL_MINIMUM_3_PLUS';
  } else if (finalKind === 'preferred') {
    finalDecision = 'eligible';
    finalReason = 'SENIORITY_PREFERRED_ONLY';
  } else if (finalKind === 'ambiguous' && (finalMinimum != null || finalDecision === 'uncertain')) {
    finalDecision = 'uncertain';
    finalReason = 'SENIORITY_AMBIGUOUS_VERIFY';
  } else if (finalMinimum >= 3 && ['technology-specific', 'domain-specific'].includes(finalKind)) {
    finalDecision = 'uncertain';
    finalReason = finalKind === 'technology-specific'
      ? 'SENIORITY_TECHNOLOGY_SPECIFIC_VERIFY'
      : 'SENIORITY_DOMAIN_SPECIFIC_VERIFY';
  }

  return {
    seniorityDecision: finalDecision,
    requirementKind: finalKind,
    minimumYears: finalMinimum,
    evidenceQuote: finalQuote,
    confidence,
    reasonCode: finalReason,
    accepted: true,
    requiresVerification: finalDecision === 'uncertain',
    deterministicSignal: signal,
    ...versions,
    jdFingerprint: seniorityJdFingerprint(candidate),
  };
}

export async function classifySeniority(candidate, {
  classifyModel = null,
  cache = new Map(),
  promptVersion = SENIORITY_PROMPT_VERSION,
  modelVersion = SENIORITY_MODEL_VERSION,
} = {}) {
  const effectiveModelVersion = typeof classifyModel === 'function'
    ? modelVersion
    : SENIORITY_DETERMINISTIC_VERSION;
  const jdFingerprint = seniorityJdFingerprint(candidate);
  const cacheKey = `${jdFingerprint}:${promptVersion}:${effectiveModelVersion}`;
  if (cache.has(cacheKey)) return { ...structuredClone(cache.get(cacheKey)), cacheHit: true, cacheKey };
  const signal = deterministicSenioritySignal(candidate);
  const output = typeof classifyModel === 'function'
    ? await classifyModel({
      title: candidate.title ?? null,
      description: descriptionFor(candidate),
      deterministicSignal: signal,
      promptVersion,
      modelVersion,
    })
    : localModelOutput(signal);
  const assessment = {
    ...adjudicateSeniority(candidate, output, { promptVersion, modelVersion: effectiveModelVersion }),
    source: typeof classifyModel === 'function' ? 'model' : 'deterministic-fallback',
    cacheHit: false,
    cacheKey,
  };
  cache.set(cacheKey, structuredClone(assessment));
  return assessment;
}

export async function classifySeniorityPool(candidates, options = {}) {
  const cache = options.cache || new Map();
  const pool = [];
  for (const candidate of candidates || []) {
    const seniorityAssessment = await classifySeniority(candidate, { ...options, cache });
    pool.push({ ...candidate, seniorityAssessment });
  }
  return {
    pool,
    telemetry: {
      assessed: pool.length,
      eligible: pool.filter((candidate) => candidate.seniorityAssessment.seniorityDecision === 'eligible').length,
      ineligible: pool.filter((candidate) => candidate.seniorityAssessment.seniorityDecision === 'ineligible').length,
      uncertain: pool.filter((candidate) => candidate.seniorityAssessment.seniorityDecision === 'uncertain').length,
      invalid: pool.filter((candidate) => candidate.seniorityAssessment.accepted === false).length,
      promptVersion: options.promptVersion || SENIORITY_PROMPT_VERSION,
      modelVersion: typeof options.classifyModel === 'function'
        ? options.modelVersion || SENIORITY_MODEL_VERSION
        : SENIORITY_DETERMINISTIC_VERSION,
    },
  };
}
