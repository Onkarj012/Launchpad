import { extractExperienceYears, normalizedKey } from './candidate.mjs';

const TITLE_PATTERNS = [
  { family: 'ai-llm-agentic', strict: /\b(ai engineer|artificial intelligence engineer|llm engineer|gen(?:erative)?[ -]?ai engineer|agentic ai engineer|ai agent engineer|nlp engineer|prompt engineer|ai developer|genai|gen ai developer|ai\/ml)\b/i },
  { family: 'ml', strict: /\b(machine learning engineer|ml engineer|applied ml engineer|deep learning engineer|computer vision engineer|data scientist|ml developer|machine learning developer)\b/i },
  { family: 'backend-python', strict: /\b(backend|back-end|python engineer|python developer|backend developer|back-end developer|api engineer)\b/i },
  { family: 'full-stack-ai', strict: /\b(full[ -]?stack|full[ -]?stack engineer|full[ -]?stack developer)\b/i },
  { family: 'general-new-grad-swe', strict: /\b(software engineer|software developer|software development engineer|swe|developer engineer|member of technical staff|junior (?:software )?(?:developer|engineer)|associate (?:software )?(?:engineer|developer)|graduate engineer)\b/i },
];

const ADJACENT_PATTERN = /\b(data engineer|platform engineer|application engineer|implementation engineer|solutions engineer|forward[ -]?deployed engineer|research engineer|automation engineer)\b/i;
const INTERNSHIP_PATTERN = /\b(intern|internship|trainee)\b/i;
const REMOTE_PATTERN = /\b(remote|work from home|distributed|anywhere)\b/i;
const HYBRID_PATTERN = /\bhybrid\b/i;
const ONSITE_PATTERN = /\b(on[ -]?site|in[ -]?office|office[ -]?based|office-based)\b/i;
const UNPAID_PATTERN = /\b(unpaid|un-paid|equity[ -]?only|commission[ -]?only|volunteer)\b/i;
const PAID_PATTERN = /\b(paid|stipend|stipended|salary|compensation|per month|per annum|\$|₹|inr)\b/i;
function textFor(candidate) {
  return [candidate.title, candidate.location, candidate.workMode, candidate.description, candidate.employment?.evidence, candidate.experience?.evidence]
    .filter((value) => typeof value === 'string')
    .join(' · ');
}

function evidence(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function classifyWorkMode(candidate) {
  const location = evidence(candidate.location) || '';
  const combined = `${location} ${candidate.workMode || ''}`.trim();
  const lower = combined.toLowerCase();
  if (candidate.workMode === 'remote' || REMOTE_PATTERN.test(combined)) return { mode: 'remote', evidence: location || candidate.workMode || null };
  if (candidate.workMode === 'hybrid' || HYBRID_PATTERN.test(combined)) return { mode: 'hybrid', evidence: location || candidate.workMode || null };
  if (candidate.workMode === 'onsite' || ONSITE_PATTERN.test(combined)) return { mode: 'onsite', evidence: location || candidate.workMode || null };
  // A location field containing ONLY a bare country/region token (no city/state)
  // is an ATS convention for remote-within-that-scope (e.g. Ashby "India").
  // Anything with additional text (a city, state, or SEZ) is a real office location.
  if (/^(india|indian|apac|asia[ -]?pacific|worldwide|world wide|global|anywhere)$/i.test(location.trim())) return { mode: 'remote', evidence: location };
  if (lower) return { mode: 'onsite', evidence: location };
  return { mode: 'unknown', evidence: null };
}

function hasAlias(text, aliases) {
  const lower = text.toLowerCase();
  return aliases.some((alias) => {
    const normalized = alias.toLowerCase().trim();
    if (!normalized) return false;
    return lower.includes(normalized);
  });
}

function remoteScopeStatus(text, policy) {
  const lower = text.toLowerCase();
  const denied = policy.geo.remoteDeniedScopes.filter((scope) => lower.includes(scope.toLowerCase()));
  const hasIndia = /\bindia\b|\bindian\b/.test(lower);
  const hasAllowed = policy.geo.remoteAllowedScopes.some((scope) => lower.includes(scope.toLowerCase())) || hasIndia;
  const excludesIndia = /excluding\s+india|not\s+(?:open|available)\s+to\s+india|india\s+excluded/.test(lower);
  if (excludesIndia) return { pass: false, code: 'GEO_REMOTE_EXCLUDES_INDIA', evidence: text };
  if (denied.length && !hasIndia && !/worldwide|world wide|global|anywhere/.test(lower)) {
    return { pass: false, code: 'GEO_REMOTE_REGION_RESTRICTED', evidence: denied.join(', ') };
  }
  if (!hasAllowed) return { pass: false, code: 'GEO_REMOTE_SCOPE_UNCLEAR', evidence: text || null };
  return { pass: true, code: 'GEO_REMOTE_INDIA_COMPATIBLE', evidence: text || null };
}

export function classifyGeo(candidate, policy) {
  const workMode = classifyWorkMode(candidate);
  const location = evidence(candidate.location) || '';
  const geoText = `${location} ${candidate.description || ''}`.trim();
  if (workMode.mode === 'remote') return { ...remoteScopeStatus(geoText, policy), mode: 'remote' };
  if (workMode.mode === 'hybrid' || workMode.mode === 'onsite') {
    if (hasAlias(location, policy.geo.puneMetroAliases)) {
      return { pass: true, code: 'GEO_PUNE_METRO', evidence: location, mode: workMode.mode };
    }
    return { pass: false, code: workMode.mode === 'hybrid' ? 'GEO_HYBRID_NOT_PUNE' : 'GEO_ONSITE_NOT_PUNE', evidence: location || null, mode: workMode.mode };
  }
  return { pass: true, strict: false, code: 'GEO_NOT_VERIFIED', evidence: 'Not Verified', mode: 'unknown' };
}

function employmentFromText(candidate) {
  const text = textFor(candidate);
  const internship = INTERNSHIP_PATTERN.test(text);
  const fullTime = /\bfull[ -]?time\b|permanent/i.test(text);
  const unpaid = UNPAID_PATTERN.test(text);
  const paid = PAID_PATTERN.test(text) && !unpaid;
  return { internship, fullTime, unpaid, paid, text };
}

export function classifyEmployment(candidate, policy) {
  const raw = employmentFromText(candidate);
  const type = candidate.employment?.type || (raw.internship ? 'internship' : raw.fullTime ? 'full-time' : null);
  const explicitPaid = candidate.employment?.paid === true || raw.paid;
  const explicitUnpaid = candidate.employment?.paid === false || raw.unpaid;
  if (explicitUnpaid && policy.employment.rejectUnpaid) {
    return { pass: false, code: 'EMPLOYMENT_UNPAID', evidence: candidate.employment?.evidence || raw.text };
  }
  if (type && !policy.employment.allowedTypes.includes(type)) {
    return { pass: false, code: 'EMPLOYMENT_TYPE_NOT_ALLOWED', evidence: candidate.employment?.evidence || type };
  }
  // Ordinary engineering postings often omit a work-type field from list APIs.
  // Keep them eligible unless the text explicitly says a disallowed type; retain
  // null evidence so downstream output never fabricates "full-time".
  if (!type && !raw.internship) {
    if (/\b(part[ -]?time|contract(?:or)?|temporary|volunteer)\b/i.test(raw.text)) {
      return { pass: false, code: 'EMPLOYMENT_TYPE_NOT_ALLOWED', evidence: raw.text };
    }
    return { pass: true, code: 'EMPLOYMENT_FULL_TIME_NOT_VERIFIED', evidence: null };
  }
  if (type === 'internship') {
    if (policy.employment.internshipRequiresExplicitPaid && !explicitPaid) {
      return { pass: false, code: 'INTERNSHIP_PAY_NOT_EXPLICIT', evidence: candidate.employment?.evidence || null };
    }
    return { pass: true, code: 'EMPLOYMENT_PAID_INTERNSHIP', evidence: candidate.employment?.evidence || raw.text };
  }
  return { pass: true, code: 'EMPLOYMENT_FULL_TIME', evidence: candidate.employment?.evidence || type };
}

function parsedExperience(candidate) {
  const knownMin = Number.isFinite(candidate.experience?.minYears) ? candidate.experience.minYears : null;
  const knownMax = Number.isFinite(candidate.experience?.maxYears) ? candidate.experience.maxYears : null;
  if (knownMin != null || knownMax != null) return { min: knownMin ?? knownMax, max: knownMax ?? knownMin, evidence: candidate.experience?.evidence || null };
  const parsed = extractExperienceYears(`${candidate.title || ''} ${candidate.description || ''}`);
  if (!parsed) return { min: null, max: null, evidence: null };
  return { min: parsed.minYears, max: parsed.maxYears, evidence: parsed.evidence };
}

export function classifyExperience(candidate, policy) {
  const parsed = parsedExperience(candidate);
  if (parsed.min != null && parsed.min >= policy.experience.hardRejectMinimumYears) {
    return { pass: false, strict: false, relaxed: false, code: 'EXPERIENCE_HARD_MIN_3_PLUS', evidence: parsed.evidence, minYears: parsed.min, maxYears: parsed.max };
  }
  if (parsed.min != null && parsed.min > policy.experience.relaxedMaximumYears) {
    return { pass: false, strict: false, relaxed: false, code: 'EXPERIENCE_ABOVE_RELAXED_LIMIT', evidence: parsed.evidence, minYears: parsed.min, maxYears: parsed.max };
  }
  if (parsed.min == null || parsed.min <= policy.experience.strictMaximumYears) {
    return {
      pass: true,
      strict: true,
      relaxed: false,
      code: parsed.min == null ? 'EXPERIENCE_NOT_STATED' : 'EXPERIENCE_STRICT_0_1',
      evidence: parsed.evidence,
      minYears: parsed.min,
      maxYears: parsed.max,
    };
  }
  return {
    pass: true,
    strict: false,
    relaxed: true,
    code: 'EXPERIENCE_RELAXED_UP_TO_2',
    evidence: parsed.evidence,
    minYears: parsed.min,
    maxYears: parsed.max,
  };
}

export function classifyTitle(candidate) {
  const title = candidate.title || '';
  if (INTERNSHIP_PATTERN.test(title)) {
    if (/\b(ai|artificial intelligence|llm|machine learning|ml|backend|python|software|full[ -]?stack|swe)\b/i.test(title)) {
      return { pass: true, strict: true, relaxed: false, family: 'paid-internship', code: 'TITLE_PAID_INTERNSHIP', evidence: title };
    }
    return { pass: false, strict: false, relaxed: false, family: null, code: 'TITLE_OFF_TARGET_INTERNSHIP', evidence: title };
  }
  for (const entry of TITLE_PATTERNS) {
    if (entry.strict.test(title)) return { pass: true, strict: true, relaxed: false, family: entry.family, code: 'TITLE_TARGET', evidence: title };
  }
  if (ADJACENT_PATTERN.test(title)) return { pass: true, strict: false, relaxed: true, family: 'adjacent-engineering', code: 'TITLE_ADJACENT_RELAXED', evidence: title };
  return { pass: false, strict: false, relaxed: false, family: null, code: 'TITLE_OFF_TARGET', evidence: title || null };
}

export function classifyRoleFamily(candidate, titleResult = classifyTitle(candidate)) {
  if (titleResult.family === 'full-stack-ai') {
    const body = `${candidate.title || ''} ${candidate.description || ''}`;
    if (/\b(ai|llm|ml|machine learning|agentic|gen\s*ai|rag)\b/i.test(body)) return 'full-stack-ai';
    return 'general-new-grad-swe';
  }
  if (titleResult.family) return titleResult.family;
  const body = `${candidate.title || ''} ${candidate.description || ''}`;
  if (/\b(ai|llm|machine learning|ml|agentic|gen\s*ai)\b/i.test(body)) return 'ai-llm-agentic';
  return 'adjacent-engineering';
}

export function classifyLiveness(candidate) {
  const value = candidate.liveness || {};
  if (value.status === 'Active') return { pass: true, code: 'LIVENESS_ACTIVE', evidence: value.evidence || null };
  if (value.status === 'Expired') return { pass: false, code: 'LIVENESS_EXPIRED', evidence: value.evidence || null };
  // Browserless discovery keeps inconclusive URLs as Not Verified. Only a
  // confirmed dead posting fails this gate; uncertainty remains visible.
  return { pass: true, code: 'LIVENESS_NOT_VERIFIED', evidence: value.evidence || 'Not Verified' };
}

export function classifyCandidate(candidate, policy) {
  const geo = classifyGeo(candidate, policy);
  const employment = classifyEmployment(candidate, policy);
  const experience = classifyExperience(candidate, policy);
  const title = classifyTitle(candidate);
  const liveness = classifyLiveness(candidate);
  const hardPass = geo.pass && employment.pass && experience.pass && title.pass && liveness.pass;
  const strict = hardPass && geo.strict !== false && title.strict && experience.strict;
  const relaxed = hardPass && !strict && (geo.strict === false || title.relaxed || experience.relaxed);
  const reasons = [geo, employment, experience, title, liveness].filter((result) => !result.pass).map((result) => result.code);
  const evidenceCodes = [geo.code, employment.code, experience.code, title.code, liveness.code];
  const relaxations = [];
  if (hardPass && !title.strict) relaxations.push('adjacent-title');
  if (hardPass && !experience.strict) relaxations.push('experience-up-to-2-years');
  const roleFamily = classifyRoleFamily(candidate, title);
  return {
    eligible: strict || relaxed,
    strict,
    relaxed,
    tier: strict ? 'strict' : relaxed ? 'relaxed' : null,
    roleFamily,
    workMode: geo.mode,
    geo,
    employment,
    experience,
    title,
    liveness,
    reasons,
    evidenceCodes,
    relaxations,
    companyKey: normalizedKey(candidate.company),
    familyKey: roleFamily,
  };
}
