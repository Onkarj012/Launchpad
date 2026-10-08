import { integerInRange } from './match-scorer.mjs';
import { createHash } from 'node:crypto';
import { decodeEntities } from '../vendor/career-ops/providers/_html-entities.mjs';

export const CANDIDATE_SCHEMA_VERSION = 'CandidateV1';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const EMPLOYMENT_TYPES = new Map([
  ['full time', 'full-time'],
  ['full-time', 'full-time'],
  ['fulltime', 'full-time'],
  ['permanent', 'full-time'],
  ['intern', 'internship'],
  ['internship', 'internship'],
  ['paid internship', 'internship'],
  ['part time', 'part-time'],
  ['part-time', 'part-time'],
  ['contract', 'contract'],
  ['contractor', 'contract'],
  ['temporary', 'temporary'],
]);

export class CandidateValidationError extends Error {
  constructor(errors) {
    super(`Invalid CandidateV1: ${errors.join('; ')}`);
    this.name = 'CandidateValidationError';
    this.errors = errors;
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function preserveText(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function canonicalizeUrl(value) {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|source$|ref$)/i.test(key)) parsed.searchParams.delete(key);
  }
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}

function normalizePostedAt(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))) return value;
  throw new CandidateValidationError(['postedAt must be a full ISO-8601 timestamp or null']);
}

function normalizeOptionalTimestamp(value, field) {
  if (value == null || value === '') return null;
  try {
    return normalizePostedAt(value);
  } catch {
    throw new CandidateValidationError([`${field} must be a full ISO-8601 timestamp or null`]);
  }
}

export function isIsoTimestamp(value) {
  return value == null || (typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value)));
}

function normalizeWorkMode(value) {
  const text = nonEmptyString(value)?.toLowerCase() || '';
  if (/remote|work from home|distributed|anywhere/.test(text)) return 'remote';
  if (/hybrid/.test(text)) return 'hybrid';
  if (/on[ -]?site|in[ -]?office|office based|office-based/.test(text)) return 'onsite';
  return null;
}

function normalizeEmploymentType(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return EMPLOYMENT_TYPES.get(key) || null;
}

function finiteYears(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

const HARD_EXPERIENCE_CUE_RE = /\b(?:minimum(?:\s+of)?|at\s+least|must\s+have|require(?:d|s)?|requirements?:|experience:)(?=[^A-Za-z]|$)/i;
const PREFERENCE_RE = /\b(?:preferred|nice\s+to\s+have|bonus|desirable|advantage)\b/i;
const EXPERIENCE_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const EXPERIENCE_VALUE = String.raw`(?:\d+(?:\.\d+)?|(?:${EXPERIENCE_WORDS.join('|')})(?:\s*\(\d+\))?)`;
const EXPERIENCE_UNIT = String.raw`(?:years?|yrs?)(?:\(s\))?(?![A-Za-z])`;
// A match must start at the lower bound, never at the tail of a range.
const EXPERIENCE_NUMBER = String.raw`(?<![\d.])(?<lower>${EXPERIENCE_VALUE})(?:\s*(?<plus>\+)|\s*(?<separator>to|[-–—])\s*(?<upper>${EXPERIENCE_VALUE}))?`;

// Convert an experience quantity without changing the retained JD evidence.
function experienceNumber(value) {
  const quantity = value.toLowerCase().replace(/\s*\(\d+\)$/, '');
  const word = EXPERIENCE_WORDS.indexOf(quantity);
  return word >= 0 ? word : Number(quantity);
}

/** Convert provider HTML/encoded text into the plain text used by parsers. */
export function stripHtmlToText(value) {
  if (typeof value !== 'string') return '';
  return decodeEntities(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// Keep applicant requirements and discard education, tenure, and preferences.
function experienceMatch(match, text) {
  const groups = match.groups || {};
  const lower = experienceNumber(groups.lower);
  const upper = groups.upper == null ? (groups.plus ? null : lower) : experienceNumber(groups.upper);
  const start = match.index ?? 0;
  const end = start + match[0].length;
  const numberStart = start + match[0].indexOf(groups.lower);
  if (/\d\s*(?:[-–—]|to)\s*$/i.test(text.slice(0, numberStart))) return null;
  const clauseStart = [...text.slice(0, start).matchAll(/(?<!\b(?:B\.E|B\.S|M\.S))\.\s|[!?;]/gi)].at(-1)?.index ?? -1;
  const prefix = text.slice(Math.max(clauseStart + 1, numberStart - 180), numberStart);
  const suffix = text.slice(end).replace(/^\.(?=\s)/, '').split(/[.!?;,]/, 1)[0].slice(0, 60);
  const requirementTail = text.slice(numberStart).split(/[.!?;,]/, 1)[0].slice(0, 140);
  if (/\b(?:education(?:al)?|qualification|school(?:ing)?|academic|degree)\b/i.test(match[0].slice(0, match[0].indexOf(groups.lower)))
    || /^\s*(?:of\s+)?(?:(?:full[ -]?time|formal|academic)\s+)*(?:education(?:al)?|schooling|study|studies)\b/i.test(suffix)) return null;
  const bachelorDegree = /\b(?:bachelor(?:['’]s)?|b\.?\s?tech|b\.?\s?e\.?|b\.?\s?s\.?|b\.?\s?sc\.?|undergraduate|graduate\s+degree)\b/i;
  const advancedDegree = /\b(?:master(?:['’]s|s)?|m\.?\s?tech|m\.?\s?s\.?|mba|ph\.?\s?d\.?|doctorate)\b/i;
  const degreeClause = text.slice(clauseStart + 1).split(/(?<!\b(?:B\.E|B\.S|M\.S))\.\s|[!?;]/i, 1)[0];
  if (/\bdegree\b[^.!?;]*\bor\s+(?:equivalent\s+)?$/i.test(prefix)
    && bachelorDegree.test(prefix) && !advancedDegree.test(degreeClause)) return null;
  const cue = [...prefix.slice(-80).matchAll(new RegExp(HARD_EXPERIENCE_CUE_RE.source, 'gi'))].at(-1);
  const preference = [...prefix.slice(-80).matchAll(new RegExp(PREFERENCE_RE.source, 'gi'))].at(-1);
  const afterPreference = /^\s*(?:is\s+|are\s+)?(?:preferred|desirable|a\s+bonus|an?\s+advantage|nice\s+to\s+have)\b/i.test(suffix);
  const experiencePreference = /\bexperience\b(?:(?!\b(?:required|must|mandatory|and|but)\b)[^.!?;,]){0,60}\b(?:preferred|desirable|bonus|advantage|nice\s+to\s+have)\b/i.test(requirementTail);
  const beforePreference = preference && (!cue || preference.index > cue.index);
  if (afterPreference || experiencePreference || beforePreference) return null;
  if (/\b(?:supported|warrantied)\s+for\s*$/i.test(prefix)) return null;
  // Company tenure is evidence about the employer, not the applicant.
  if (/\b(?:we|company|organisation|organization|corporation|group|business|firm|team)\b[^.!?;]*\b(?:has|have|with|brings?|boasts?|spanning)\b[^.!?;]*$/i.test(prefix)
    && !/\b(?:you|candidate|applicant|engineer|developer|seeking|looking|expect|requires?|requirements?|must\s+have)\b[^.!?;]*$/i.test(prefix)) return null;
  return { minYears: lower, maxYears: upper, evidence: match[0].trim().replace(/\s+/g, ' ') };
}

// Extract the strictest applicant experience requirement from the JD.
export function extractExperienceYears(text) {
  const cleaned = stripHtmlToText(text);
  if (!cleaned) return null;
  const matches = [];
  const forward = new RegExp(
    String.raw`(?:minimum(?:\s+of)?|at\s+least|must\s+have|require(?:d|s)?|requirements?:|experience:)(?=[^A-Za-z]|$)[^\d.!?;]{0,40}?\b${EXPERIENCE_NUMBER}\s*${EXPERIENCE_UNIT}`,
    'gi',
  );
  for (const match of cleaned.matchAll(forward)) {
    const parsed = experienceMatch(match, cleaned);
    if (parsed) matches.push(parsed);
  }

  const reverse = new RegExp(
    String.raw`\b${EXPERIENCE_NUMBER}(?:\s+[A-Za-z][A-Za-z'/-]*){0,4}\s+${EXPERIENCE_UNIT}(?:\s+[A-Za-z][A-Za-z'/-]*){0,4}\s+experience(?:d)?\b`,
    'gi',
  );
  for (const match of cleaned.matchAll(reverse)) {
    const parsed = experienceMatch(match, cleaned);
    if (parsed) matches.push(parsed);
  }

  const activityRequirement = new RegExp(
    String.raw`\b${EXPERIENCE_NUMBER}\s*${EXPERIENCE_UNIT}(?:\s+of)?(?:\s+(?:professional|hands-on|relevant|industry))?(?:\s+[A-Za-z][A-Za-z+.#/-]*){0,3}\s+(?:experience|development|engineering|building|developing|designing|working|programming|coding|implementing|maintaining)\b`,
    'gi',
  );
  for (const match of cleaned.matchAll(activityRequirement)) {
    const parsed = experienceMatch(match, cleaned);
    if (parsed) matches.push(parsed);
  }
  const requiredYears = new RegExp(String.raw`\b${EXPERIENCE_NUMBER}\s*${EXPERIENCE_UNIT}\s+(?:is\s+)?required\b`, 'gi');
  for (const match of cleaned.matchAll(requiredYears)) {
    const parsed = experienceMatch(match, cleaned);
    if (parsed) matches.push(parsed);
  }
  if (!matches.length) return null;
  return matches.reduce((best, current) => current.minYears > best.minYears ? current : best);
}

// Detect recruiting on a client's behalf without mistaking client work for hiring.
export function hiringEmployerConflict(description) {
  const cleaned = stripHtmlToText(description);
  const applicant = String.raw`(?:[A-Za-z-]+\s+){0,6}(?:candidates?|applicants?|engineers?|developers?|professionals?|talent)\b`;
  const recruiting = cleaned.match(new RegExp(String.raw`\b(?:our|the|a|an)\s+client\s+(?:is|are)\s+(?:currently\s+)?(?:hiring|recruiting|(?:looking\s+for|seeking)\s+${applicant})\b|\b(?:hiring|recruiting)\s+(?:on\s+behalf\s+of|for)\s+(?:(?:our|a|an|the)\s+)?client\b|\bseeking\s+${applicant}\s+for\s+(?:(?:our|a|an|the)\s+)?client\b`, 'i'));
  return recruiting ? { reason: 'destination-hiring-employer-unverified', evidence: recruiting[0] } : null;
}

function parseExperienceString(value) {
  const text = nonEmptyString(value);
  if (!text) return { minYears: null, maxYears: null, evidence: null };
  const range = text.match(/(\d+(?:\.\d+)?)\s*(?:[-–—]|to)\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)/i);
  if (range) return { minYears: Number(range[1]), maxYears: Number(range[2]), evidence: text };
  const plus = text.match(/(\d+(?:\.\d+)?)\s*\+\s*(?:years?|yrs?)/i);
  if (plus) return { minYears: Number(plus[1]), maxYears: null, evidence: text };
  const one = text.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?)/i);
  if (one) return { minYears: Number(one[1]), maxYears: Number(one[1]), evidence: text };
  return { minYears: null, maxYears: null, evidence: text };
}

function normalizeExperience(raw) {
  const value = raw?.experience;
  if (typeof value === 'string') return parseExperienceString(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const explicit = {
      minYears: finiteYears(value.minYears ?? value.minimumYears ?? value.min),
      maxYears: finiteYears(value.maxYears ?? value.maximumYears ?? value.max),
      evidence: preserveText(value.evidence),
    };
    if (explicit.minYears != null || explicit.maxYears != null || explicit.evidence) return explicit;
    return extractExperienceYears(raw?.description ?? raw?.descriptionPlain ?? raw?.jd ?? raw?.body) || explicit;
  }
  const explicit = {
    minYears: finiteYears(raw?.minYears ?? raw?.minimumYears ?? raw?.experienceMinYears),
    maxYears: finiteYears(raw?.maxYears ?? raw?.maximumYears ?? raw?.experienceMaxYears),
    evidence: preserveText(raw?.experienceEvidence),
  };
  if (explicit.minYears != null || explicit.maxYears != null || explicit.evidence) return explicit;
  return extractExperienceYears(raw?.description ?? raw?.descriptionPlain ?? raw?.jd ?? raw?.body)
    || { minYears: null, maxYears: null, evidence: null };
}

function normalizeEmployment(raw) {
  const value = raw?.employment;
  const type = normalizeEmploymentType(typeof value === 'string' ? value : value?.type ?? raw?.employmentType ?? raw?.type);
  const paidValue = typeof value === 'object' && value !== null ? value.paid : raw?.paid;
  const paid = typeof paidValue === 'boolean' ? paidValue : null;
  const evidence = preserveText(typeof value === 'object' && value !== null ? value.evidence : raw?.employmentEvidence ?? raw?.payEvidence);
  return { type, paid, evidence };
}

function normalizeLiveness(raw, { runAt = null, currentFeedIsLive = false } = {}) {
  const value = raw?.liveness;
  let status = null;
  let checkedAt = null;
  let evidence = null;
  if (typeof value === 'string') status = value;
  else if (value && typeof value === 'object') {
    status = value.status;
    checkedAt = value.checkedAt;
    evidence = value.evidence;
  }
  status = nonEmptyString(status);
  if (status) {
    const canonical = /^(active|live)$/i.test(status) ? 'Active' : /^(expired|dead)$/i.test(status) ? 'Expired' : 'Not Verified';
    checkedAt = checkedAt == null ? null : normalizePostedAt(checkedAt);
    return { status: canonical, checkedAt, evidence: preserveText(evidence) };
  }
  if (currentFeedIsLive) {
    return {
      status: 'Active',
      checkedAt: runAt == null ? null : normalizePostedAt(runAt),
      evidence: 'current-feed-record',
    };
  }
  return { status: 'Not Verified', checkedAt: null, evidence: null };
}

function normalizeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

function normalizeSourceCategory(value, sourceKind) {
  const raw = nonEmptyString(value)?.toLowerCase();
  const aliases = new Map([
    ['direct', 'direct-company'],
    ['direct-company', 'direct-company'],
    ['ats-direct', 'direct-company'],
    ['vc', 'vc-portfolio'],
    ['vc-portfolio', 'vc-portfolio'],
    ['india-niche', 'india-niche'],
    ['niche-public', 'india-niche'],
    ['broad-remote', 'broad-remote'],
    ['aggregator', 'aggregator'],
  ]);
  if (raw && aliases.has(raw)) return aliases.get(raw);
  if (sourceKind === 'ats-direct') return 'direct-company';
  if (sourceKind === 'niche-public') return 'india-niche';
  return 'aggregator';
}

function normalizeSalary(value, raw) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const minimum = Number(source.minimum ?? source.min ?? raw?.salaryMin);
  const maximum = Number(source.maximum ?? source.max ?? raw?.salaryMax);
  return {
    minimum: Number.isFinite(minimum) ? minimum : null,
    maximum: Number.isFinite(maximum) ? maximum : null,
    currency: nonEmptyString(source.currency ?? raw?.salaryCurrency),
    period: nonEmptyString(source.period ?? raw?.salaryPeriod),
    evidence: preserveText(source.evidence ?? (typeof value === 'string' ? value : raw?.salaryEvidence)),
  };
}

function normalizeRemoteEligibility(value, raw) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const supplied = source.status ?? value ?? raw?.remoteEligible;
  let status = 'Not Verified';
  if (supplied === true || /^(india[- ]?eligible|eligible|yes|allowed)$/i.test(String(supplied ?? ''))) status = 'India Eligible';
  if (supplied === false || /^(not[- ]?eligible|ineligible|no|denied)$/i.test(String(supplied ?? ''))) status = 'Not Eligible';
  return { status, evidence: preserveText(source.evidence ?? raw?.remoteEligibilityEvidence) };
}

function normalizeBooleanEvidence(value, evidenceValue) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const supplied = source.available ?? source.value ?? value;
  const available = typeof supplied === 'boolean' ? supplied : null;
  return { available, evidence: preserveText(source.evidence ?? evidenceValue) };
}

function normalizeTimezoneOverlap(value, raw) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const hours = Number(source.minimumHours ?? source.hours ?? raw?.timezoneOverlapHours);
  return {
    status: nonEmptyString(source.status ?? (typeof value === 'string' ? value : null)) || 'Not Verified',
    minimumHours: Number.isFinite(hours) ? hours : null,
    evidence: preserveText(source.evidence ?? raw?.timezoneOverlapEvidence),
  };
}

function normalizeApplicationResolution(raw, sourceKind, canonicalUrl) {
  const supplied = raw?.originalApplicationUrl ?? raw?.originalApplyUrl ?? raw?.applicationUrl ?? raw?.applyUrl;
  const originalApplicationUrl = canonicalizeUrl(supplied);
  const rawResolution = raw?.applicationResolution && typeof raw.applicationResolution === 'object' ? raw.applicationResolution : {};
  const direct = sourceKind === 'ats-direct';
  const status = originalApplicationUrl ? 'Resolved Original' : direct ? 'Direct ATS' : 'Unresolved';
  return {
    originalApplicationUrl: originalApplicationUrl || (direct ? canonicalUrl : null),
    resolution: {
      status,
      evidence: preserveText(rawResolution.evidence ?? raw?.originalApplicationEvidence),
    },
  };
}

export function validateCandidate(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { valid: false, errors: ['candidate must be an object'] };
  if (candidate.schemaVersion !== CANDIDATE_SCHEMA_VERSION) errors.push('schemaVersion must be CandidateV1');
  for (const field of ['canonicalUrl', 'company', 'title']) {
    if (!nonEmptyString(candidate[field])) errors.push(`${field} is required`);
  }
  if (candidate.canonicalUrl && !/^https?:\/\//i.test(candidate.canonicalUrl)) errors.push('canonicalUrl must be http(s)');
  if (!isIsoTimestamp(candidate.postedAt)) errors.push('postedAt must be a full ISO-8601 timestamp or null');
  for (const field of ['discoveredAt', 'crawledAt', 'firstSeenAt']) {
    if (!isIsoTimestamp(candidate[field])) errors.push(`${field} must be a full ISO-8601 timestamp or null`);
  }
  if (candidate.jobId != null && typeof candidate.jobId !== 'string') errors.push('jobId must be a string or null');
  if (candidate.provider != null && typeof candidate.provider !== 'string') errors.push('provider must be a string or null');
  if (candidate.source != null && typeof candidate.source !== 'string') errors.push('source must be a string or null');
  if (candidate.description != null && typeof candidate.description !== 'string') errors.push('description must be a string or null');
  if (!candidate.employment || typeof candidate.employment !== 'object') errors.push('employment is required');
  if (!candidate.experience || typeof candidate.experience !== 'object') errors.push('experience is required');
  if (!candidate.liveness || typeof candidate.liveness !== 'object') errors.push('liveness is required');
  if (candidate.fingerprint != null && !/^[0-9a-f]{16}$/.test(candidate.fingerprint)) errors.push('fingerprint must be 16 lowercase hex characters or null');
  if (candidate.matchScore != null && (!Number.isInteger(candidate.matchScore) || candidate.matchScore < 0 || candidate.matchScore > 100)) errors.push('matchScore must be 0-100 or null');
  if (candidate.responseLikelihood != null && (!Number.isInteger(candidate.responseLikelihood) || candidate.responseLikelihood < 0 || candidate.responseLikelihood > 20)) errors.push('responseLikelihood must be 0-20 or null');
  if (candidate.conversionScore != null && (!Number.isFinite(candidate.conversionScore) || candidate.conversionScore < 0 || candidate.conversionScore > 100)) errors.push('conversionScore must be 0-100 or null');
  if (candidate.originalApplicationUrl != null && !/^https?:\/\//i.test(candidate.originalApplicationUrl)) errors.push('originalApplicationUrl must be http(s) or null');
  return { valid: errors.length === 0, errors };
}

export function assertCandidate(candidate) {
  const result = validateCandidate(candidate);
  if (!result.valid) throw new CandidateValidationError(result.errors);
  return candidate;
}

export function normalizeCandidate(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CandidateValidationError(['candidate input must be an object']);
  const source = typeof raw.source === 'string' ? raw.source : options.source ?? null;
  const provider = typeof raw.provider === 'string' ? raw.provider : options.provider ?? null;
  const originalUrl = raw.url ?? raw.canonicalUrl;
  const canonicalUrl = canonicalizeUrl(originalUrl);
  const description = preserveText(raw.description ?? raw.descriptionPlain ?? raw.jd ?? raw.body);
  const postedAt = normalizePostedAt(raw.postedAt ?? raw.firstPublished ?? raw.createdAt);
  const experience = normalizeExperience(raw);
  const employment = normalizeEmployment(raw);
  const sourceKind = nonEmptyString(raw.sourceKind ?? options.sourceKind) || 'aggregator';
  const application = normalizeApplicationResolution(raw, sourceKind, canonicalUrl);
  const candidate = {
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
    canonicalUrl,
    url: nonEmptyString(originalUrl),
    source,
    provider,
    jobId: raw.jobId == null && raw.id == null ? null : String(raw.jobId ?? raw.id),
    identityAliases: Array.isArray(raw.identityAliases) ? raw.identityAliases.filter((alias) => typeof alias === 'string' && alias.trim()) : [],
    firstSeenAt: normalizeOptionalTimestamp(raw.firstSeenAt ?? raw.first_seen_at, 'firstSeenAt'),
    company: nonEmptyString(raw.company ?? raw.companyName),
    title: nonEmptyString(raw.title ?? raw.role),
    location: preserveText(raw.location),
    workMode: normalizeWorkMode(raw.workMode ?? raw.work_mode ?? raw.location),
    description,
    evidence: normalizeEvidence(raw.evidence),
    postedAt,
    discoveredAt: normalizeOptionalTimestamp(raw.discoveredAt ?? options.discoveredAt ?? options.runAt, 'discoveredAt'),
    crawledAt: normalizeOptionalTimestamp(raw.crawledAt ?? raw.scrapedAt ?? options.crawledAt, 'crawledAt'),
    employment,
    experience,
    liveness: normalizeLiveness(raw, options),
    fingerprint: /^[0-9a-f]{16}$/.test(raw.fingerprint || '') ? raw.fingerprint : null,
    sourceKind,
    sourceCategory: normalizeSourceCategory(raw.sourceCategory ?? options.sourceCategory, sourceKind),
    originalApplicationUrl: application.originalApplicationUrl,
    applicationResolution: application.resolution,
    remoteEligibility: normalizeRemoteEligibility(raw.remoteEligibility, raw),
    salary: normalizeSalary(raw.salary, raw),
    timezoneOverlap: normalizeTimezoneOverlap(raw.timezoneOverlap, raw),
    eor: normalizeBooleanEvidence(raw.eor, raw.eorEvidence),
    equipment: normalizeBooleanEvidence(raw.equipment, raw.equipmentEvidence),
    matchScore: null,
    scoreOrigin: 'source-input',
    componentScores: raw.componentScores ?? null,
    descriptionAvailable: typeof raw.descriptionAvailable === 'boolean' ? raw.descriptionAvailable : null,
    scoringFailed: raw.scoringFailed === true || raw.scoringStatus === 'scoring-failed' || (raw.responseLikelihood != null && String(raw.responseLikelihood).trim() !== '' && integerInRange(raw.responseLikelihood, 0, 20) === null) || (raw.matchScore != null && String(raw.matchScore).trim() !== '' && integerInRange(raw.matchScore, 0, 100) === null) || (raw.score != null && String(raw.score).trim() !== '' && integerInRange(raw.score, 0, 100) === null),
    scoringFailureReason: raw.scoringFailureReason ?? null,
    scoringStatus: raw.scoringStatus ?? null,
    rationale: preserveText(raw.rationale),
    hook: preserveText(raw.hook ?? raw.strongestHook),
    responseLikelihood: integerInRange(raw.responseLikelihood, 0, 20),
    conversionScore: Number.isFinite(Number(raw.conversionScore)) ? Number(raw.conversionScore) : null,
    conversionFactors: raw.conversionFactors && typeof raw.conversionFactors === 'object' ? { ...raw.conversionFactors } : null,
    conversionSignals: raw.conversionSignals && typeof raw.conversionSignals === 'object'
      ? { ...raw.conversionSignals }
      : {
        humanContact: raw.humanContact === true,
        projectConnection: raw.projectConnection === true,
      },
    autoSuggest: false,
  };
  return assertCandidate(candidate);
}

// Remove scoring claims at every discovery lane boundary.
export function discoveryCandidate(candidate) {
  return { ...assertCandidate(candidate), matchScore: null, score: null, scoreOrigin: 'source-input', autoSuggest: false };
}

export function normalizedKey(value) {
  return String(value ?? '')
    .toLocaleLowerCase('en-US')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function companyTitleLocationKey(candidate) {
  return [candidate.company, candidate.title, candidate.location].map(normalizedKey).join('|');
}

// Normalize Workday URL slugs and previously normalized ledger IDs alike.
export function normalizeRequisitionId(provider, value) {
  const id = String(value ?? '');
  if (normalizedKey(provider) !== 'workday') return id;
  return id.match(/(?:^|[_ ])([A-Za-z]{1,4}[- ]?\d{3,}|\d{5,})(?:[- ]\d+)?$/)?.[1] ?? id;
}

// Normalize a provider identity without changing keys for other providers.
export function normalizeIdentityKey(value) {
  const parts = String(value ?? '').split('|');
  if (parts.length !== 2) return String(value ?? '');
  return `${normalizedKey(parts[0])}|${normalizedKey(normalizeRequisitionId(parts[0], parts[1]))}`;
}

// Return the current identity and every proven pre-resolution identity.
export function candidateIdentityKeys(candidate) {
  return [...new Set([candidateDedupKey(candidate), ...(candidate.identityAliases || [])].map(normalizeIdentityKey).filter(Boolean))];
}

// Compare employer names while allowing missing names and common company suffixes.
export function companiesCompatible(left, right) {
  if (!String(left ?? '').trim() || !String(right ?? '').trim()) return true;
  const suffixes = /\b(?:inc|ltd|limited|pvt|private|llc|corp|corporation|technologies|technology|solutions|india|co)\b/g;
  const a = normalizedKey(left).replace(suffixes, '').replace(/\s+/g, ' ').trim();
  const b = normalizedKey(right).replace(suffixes, '').replace(/\s+/g, ' ').trim();
  return a === b || Boolean(a && b && (a.includes(b) || b.includes(a)));
}

// Match current or retained identities against either ledger generation.
export function candidateMatchesLedgerRow(candidate, row) {
  if (!companiesCompatible(candidate.company, row.company)) return false;
  const keys = candidateIdentityKeys(candidate);
  const rowKeys = [row.dedup_key ?? row.dedupKey, candidateRequisitionKey({ provider: row.provider, jobId: row.job_id ?? row.jobId ?? row.provider_job_id })];
  return rowKeys.some((key) => key && keys.includes(normalizeIdentityKey(key)));
}

export function candidateRequisitionKey(candidate) {
  const provider = normalizedKey(candidate.provider);
  const jobId = normalizedKey(normalizeRequisitionId(provider, candidate.jobId ?? candidate.providerJobId ?? candidate.requisitionId));
  if (provider && jobId) return `${provider}|${jobId}`;
  return null;
}

/**
 * Durable identity prefers provider + requisition/job id so two Workday
 * requisitions at the same company/title/location stay distinct. Canonical
 * URL is the next fallback; company|title|location is last-resort only.
 */
export function candidateDedupKey(candidate) {
  const requisition = candidateRequisitionKey(candidate);
  if (requisition) return requisition;
  const url = canonicalizeUrl(candidate.canonicalUrl || candidate.url);
  if (url) return `url|${url}`;
  return companyTitleLocationKey(candidate);
}

export function buildPayloadRecord(candidate, selection = {}) {
  assertCandidate(candidate);
  return {
    Role: candidate.title,
    Company: candidate.company,
    'JD Link': candidate.canonicalUrl,
    'Original Application URL': candidate.originalApplicationUrl,
    'Application Resolution': candidate.applicationResolution?.status ?? 'Unresolved',
    'Application Resolution Evidence': candidate.applicationResolution?.evidence ?? null,
    'Application Ready': candidate.applicationReady === true,
    Location: candidate.location,
    'Posted Date': candidate.postedAt,
    'Posted At': candidate.postedAt,
    'Discovered At': candidate.discoveredAt,
    'Crawled At': candidate.crawledAt,
    'JD Text': candidate.description,
    'Job ID': candidate.jobId,
    Source: candidate.source,
    'Source Rarity': candidate.sourceKind,
    'Source Category': candidate.sourceCategory,
    'Source Provider': candidate.provider,
    Liveness: candidate.liveness.status,
    'Match Score': candidate.matchScore,
    'Conversion Score': candidate.conversionScore,
    'Conversion Factors': candidate.conversionFactors,
    Rationale: candidate.rationale,
    Hook: candidate.hook,
    'Response Likelihood': candidate.responseLikelihood,
    'Auto-Suggest': candidate.autoSuggest,
    'Experience Asked': candidate.experience.evidence,
    'Remote Eligibility': candidate.remoteEligibility?.status ?? 'Not Verified',
    'Remote Eligibility Evidence': candidate.remoteEligibility?.evidence ?? null,
    Salary: candidate.salary,
    'Timezone Overlap': candidate.timezoneOverlap,
    EOR: candidate.eor,
    Equipment: candidate.equipment,
    'Apply?': false,
    Status: 'Discovered',
    'Resume Status': 'Not Started',
    'Selection Tier': selection.tier ?? null,
    'Freshness Window': selection.freshnessWindow ?? null,
    'Role Family': selection.roleFamily ?? null,
    Relaxations: Array.isArray(selection.relaxations) ? [...selection.relaxations] : [],
    'Employment Type': candidate.employment.type,
    'Eligibility Evidence': Array.isArray(selection.evidenceCodes) ? [...selection.evidenceCodes] : [],
    'Run ID': selection.runId ?? null,
  };
}

export function validatePayloadRecord(payload) {
  const errors = [];
  for (const field of ['Role', 'Company', 'JD Link', 'Status', 'Resume Status']) {
    if (payload?.[field] == null || payload[field] === '') errors.push(`${field} is required`);
  }
  if (payload?.['Apply?'] !== false) errors.push('Apply? must remain false');
  if (payload?.Status !== 'Discovered') errors.push('Status must remain Discovered');
  if (payload?.['Resume Status'] !== 'Not Started') errors.push('Resume Status must remain Not Started');
  return { valid: errors.length === 0, errors };
}

export function stableCandidateId(candidate) {
  return createHash('sha256').update(`${candidate.canonicalUrl}\0${candidate.jobId ?? ''}\0${candidateDedupKey(candidate)}`).digest('hex').slice(0, 16);
}
