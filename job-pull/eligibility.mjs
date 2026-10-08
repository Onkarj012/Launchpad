import { parseStipend } from './stipend.mjs';
import { extractExperienceYears, normalizedKey } from './candidate.mjs';
import { decodeEntities } from '../vendor/career-ops/providers/_html-entities.mjs';
import { classifyRemoteTimezone } from './remote-enrichment.mjs';

const TITLE_PATTERNS = [
  { family: 'ai-llm-agentic', strict: /\b(ai product engineer|applied ai engineer|ai software engineer|llm application engineer|ai automation engineer|ai integration engineer|junior ai engineer|ai solutions engineer|ai engineer|artificial intelligence engineer|llm engineer|gen(?:erative)?[ -]?ai engineer|agentic ai engineer|ai agent engineer|nlp engineer|prompt engineer|ai developer|genai|gen ai developer|ai\/ml)\b/i },
  { family: 'ml', strict: /\b(machine learning engineer|ml engineer|applied ml engineer|deep learning engineer|computer vision engineer|data scientist|ml developer|machine learning developer)\b/i },
  { family: 'backend-python', strict: /\b(backend|back-end|back end (?:engineer|developer)|python engineer|python developer|backend developer|back-end developer|api engineer)\b/i },
  { family: 'full-stack-ai', strict: /\b(ai[- ]native full[ -]?stack engineer|full[ -]?stack|full[ -]?stack engineer|full[ -]?stack developer)\b/i },
  { family: 'general-new-grad-swe', strict: /\b(software engineer i|software engineer|software developer|software development engineer|sde[ -]?i|swe|developer engineer|member of technical staff|junior (?:software (?:developer|engineer)|developer)|associate (?:software (?:engineer|developer)|developer)|graduate engineer|founding engineer|product engineer|java developer|c\+\+ developer|node(?:\.js)? developer)\b/i },
];

const ADJACENT_PATTERN = /\b(data engineer|platform engineer|application engineer|implementation engineer|solutions engineer|forward[ -]?deployed engineer|research engineer|automation engineer)\b/i;
const INTERNSHIP_PATTERN = /\b(intern|internship|trainee)\b/i;
const REMOTE_PATTERN = /\b(remote|work from home|distributed|anywhere)\b/i;
const HYBRID_PATTERN = /\bhybrid\b/i;
const ONSITE_PATTERN = /\b(on[ -]?site|in[ -]?office|office[ -]?based|office-based)\b/i;
const UNPAID_PATTERN = /\b(unpaid|un-paid|equity[ -]?only|commission[ -]?only)\b/i;
const TRAINING_FEE_OR_BOND_PATTERN = /\b(training[ -]+fees?|registration\s+fees?|joining\s+fees?|security\s+deposits?|(?:non[- ]?refundable|refundable)(?:\s+security)?\s+deposits?(?=[^.!?]{0,80}\bjoining\b)|(?:service|employment)(?:\s+agreement)?\s+bond|bonded\s+(?:employment|role|position)|bond\s+(?:of|for)\s+\d+\s+years?|bond\s+period|genuine\s+payment\s+required\s+before)\b/i;
const PAID_PATTERN = /\b(paid|stipend|stipended|salary|compensation|per month|per annum|\$|₹|inr)\b/i;
const FOREIGN_REMOTE_REGION_PATTERN = /\b(?:authorized\s+to\s+work\s+in\s+(?:the\s+)?(?:u\.?s\.?|united states|u\.?k\.?|united kingdom|eu|canada|australia)|(?:u\.?s\.?|united states|u\.?k\.?|united kingdom|eu|canada)\s+work\s+authorization|must\s+(?:be\s+located|reside)\s+in\s+(?:the\s+)?(?:u\.?s\.?|united states|u\.?k\.?|eu|canada)|(?:u\.?s\.?|united states|u\.?k\.?|eu|canada|australia)\s+only|anywhere\s+in\s+(?:the\s+)?(?:u\.?s\.?|united states|u\.?k\.?|eu|canada))(?=$|[^a-z])/i;
const EXPLICIT_FOREIGN_REMOTE_LOCATION_PATTERN = /\b(?:north america|u\.?s\.?a?|united states|canada|united kingdom|u\.?k\.?|europe|european union|e\.?u\.?|austria|poland|germany|france|spain|italy|netherlands|australia|new zealand|latin america|latam|united arab emirates|u\.?a\.?e\.?)\b/i;
const FOREIGN_COUNTRY_CODE_REMOTE_LOCATION_PATTERN = /^(?!IN\b|IND\b|APAC\b)[A-Z]{2,3}(?:[\s,;/_-].*)?\bremote\b/i;
const GLOBAL_SCOPE_PATTERN = /\b(worldwide|world\s+wide|global|anywhere)\b/gi;
const FRESHER_EXPERIENCE_PATTERN = /\b(freshers?|new[- ]grad|recent graduate|graduate engineer|graduate trainee|campus|entry[- ]level|junior|associate|trainee|0\s*[-–]\s*1\s+years?|0\s+to\s+1\s+years?)\b/i;
const SENIORITY_PATTERN = /\b(senior|sr\.?|staff|lead|principal|architect|director|head of|vp|vice president|manager)\b/i;
const FRESHER_TITLE_PATTERN = /\b(freshers?|new[- ]grad(?:uate)?|recent graduate|graduate|entry[- ]level|junior|trainee|campus)\b/i;
const INR_CURRENCY_PATTERN = /^(?:inr|₹)$/i;
const ANNUAL_PERIOD_PATTERN = /^(?:annual|annually|year|yearly|per year|per annum)$/i;
const AMBIGUOUS_PUNE_AREAS = ['sus', 'maan'];
const EXCLUDED_PUNE_AREAS = ['chakan', 'talegaon', 'ranjangaon', 'shikrapur'];
const PUNE_LOCATION_CONTEXT_PATTERN = /\b(?:maharashtra|mh|41[12]\d{3})\b/i;
const NIGHT_SHIFT_PATTERN = /\b(?:night[ -]?shifts?|rotating[ -]?shifts?|overnight)\b/i;
const IMMEDIATE_JOINER_PATTERN = /\b(?:immediate[ -]?join(?:ers?|ing)|join\s+immediately)\b/i;
const SHORT_NOTICE_PATTERN = /\b(?:notice(?:\s+period)?\s*(?:(?:of|is|up\s+to|within|maximum)\s*)?[:=-]?\s*|join\s+within\s+)(\d+)(?:\s*(?:[-–]|to)\s*(\d+))?\s*[- ]?\s*days?\b|\b(\d+)(?:\s*(?:[-–]|to)\s*(\d+))?\s*[- ]?\s*days?\s+notice\b/gi;

function textFor(candidate) {
  return [candidate.title, candidate.location, candidate.workMode, candidate.description, candidate.employment?.evidence, candidate.experience?.evidence]
    .filter((value) => typeof value === 'string')
    .join(' · ');
}

function evidence(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function classifySalary(candidate, policy = {}) {
  if (candidate.employment?.type === 'internship' || INTERNSHIP_PATTERN.test(candidate.title || '')) {
    return { pass: true, code: 'SALARY_INTERNSHIP_STIPEND_GATE', evidence: null };
  }
  const salary = candidate.salary || {};
  const usable = Number.isFinite(salary.maximum) ? salary.maximum : Number.isFinite(salary.minimum) ? salary.minimum : null;
  const currency = evidence(salary.currency);
  const period = evidence(salary.period);
  // null/unset floor means no compensation gate (master_prompt: blank = don't filter on comp).
  // Number(null) is 0, so treat null/empty as NaN rather than a zero floor.
  const floorLpa = policy.salaryFloorLpa == null || policy.salaryFloorLpa === ''
    ? NaN
    : Number(policy.salaryFloorLpa);
  if (!Number.isFinite(floorLpa)) {
    return { pass: true, code: 'SALARY_FLOOR_DISABLED', evidence: null };
  }
  if (usable == null || (currency && !INR_CURRENCY_PATTERN.test(currency)) || !period || !ANNUAL_PERIOD_PATTERN.test(period)) {
    return { pass: true, code: 'SALARY_NOT_VERIFIED', evidence: null };
  }
  if (usable < floorLpa * 100000) {
    return { pass: false, code: 'SALARY_BELOW_FLOOR', evidence: salary.evidence || `${usable} ${currency || 'INR'} ${period}` };
  }
  return { pass: true, code: 'SALARY_FLOOR_MET', evidence: salary.evidence || null };
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

// Match complete location names across provider punctuation.
function hasAlias(text, aliases) {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  return aliases.some((alias) => {
    const normalized = alias.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!normalized) return false;
    return lower.includes(` ${normalized} `);
  });
}

function isIndiaCompatibleRegion(value, policy) {
  const normalized = value.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (/^(?:india|indian|pune)\b/.test(normalized)) return true;
  return policy.geo.remoteAllowedScopes.some((scope) => {
    const allowed = scope.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    return normalized === allowed || normalized.startsWith(`${allowed} `);
  });
}

function isRegionQualifiedGlobalToken(text, match, policy) {
  const after = text.slice(match.index + match[0].length);
  const followingRegion = after.match(/^\s+(?:in|within)\s+(?:the\s+)?([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,3})/i);
  if (followingRegion) return !isIndiaCompatibleRegion(followingRegion[1], policy);
  const precedingRegion = text.slice(0, match.index).match(/\(\s*([^()]{1,40})\s*\)\s*$/);
  if (precedingRegion) return !isIndiaCompatibleRegion(precedingRegion[1], policy);
  const trailingRegion = after.match(/^\s*\(\s*([^()]{1,40})\s*\)/);
  if (trailingRegion) return !isIndiaCompatibleRegion(trailingRegion[1], policy);
  return false;
}

function hasAllowedGlobalScope(text, policy) {
  return [...text.matchAll(GLOBAL_SCOPE_PATTERN)].some((match) => !isRegionQualifiedGlobalToken(text, match, policy));
}

function remoteScopeStatus(text, location, policy, remoteEligibility = null) {
  const lower = text.toLowerCase();
  const locationLower = location.toLowerCase();
  const locationHasAllowedScope = /\bindia\b|\bindian\b|\bpune\b/i.test(location)
    || policy.geo.remoteAllowedScopes.some((scope) => locationLower.includes(scope.toLowerCase()));
  const explicitForeignRequirement = text.match(/\b(?:must|should|need to)\s+be\s+(?:based|located)\s+in\s+(?:the\s+)?(austria|poland|germany|france|spain|italy|netherlands|australia|new zealand|united states|u\.?s\.?a?|canada|united kingdom|u\.?k\.?|european union|e\.?u\.?)\b/i);
  if (explicitForeignRequirement && remoteEligibility?.status !== 'India Eligible') {
    return { pass: false, code: 'GEO_REMOTE_REGION_RESTRICTED', evidence: explicitForeignRequirement[0] };
  }
  if ((EXPLICIT_FOREIGN_REMOTE_LOCATION_PATTERN.test(location) || FOREIGN_COUNTRY_CODE_REMOTE_LOCATION_PATTERN.test(location))
    && !locationHasAllowedScope && remoteEligibility?.status !== 'India Eligible') {
    return { pass: false, code: 'GEO_REMOTE_REGION_RESTRICTED', evidence: location };
  }
  const denied = policy.geo.remoteDeniedScopes.filter((scope) => lower.includes(scope.toLowerCase()));
  const hasIndia = /\b(?:india|indian|pune)\b/i.test(location)
    || /\b(?:work|working|hire|hiring|role|position|candidate|applicant|based|located|reside|residing|available|open|eligible|payroll|employment|employer of record|eor)\b[^.!?\n]{0,80}\b(?:india|indian)\b/i.test(text)
    || /\b(?:india|indian)\b[^.!?\n]{0,80}\b(?:remote|work|working|hire|hiring|role|position|candidate|applicant|based|located|reside|residing|available|open|eligible|payroll|employment|employer of record|eor)\b/i.test(text);
  const hasAllowed = policy.geo.remoteAllowedScopes.some((scope) => {
    if (/^(worldwide|world wide|global|anywhere)$/i.test(scope.trim())) {
      if (locationLower.includes(scope.toLowerCase())) return true;
      return hasAllowedGlobalScope(text, policy)
        && /\b(?:remote(?:ly)?\s+(?:worldwide|globally)|(?:worldwide|globally)\s+remote|work(?:ing)?\s+(?:remotely\s+)?(?:from\s+)?anywhere|(?:hire|hiring|open|available|eligible)\s+(?:to\s+)?(?:candidates?\s+)?(?:worldwide|globally))\b/i.test(text);
    }
    return lower.includes(scope.toLowerCase());
  }) || hasIndia;
  const foreignMatch = text.match(FOREIGN_REMOTE_REGION_PATTERN);
  const excludesIndia = /excluding\s+india|not\s+(?:open|available)\s+to\s+india|india\s+excluded/.test(lower);
  if (foreignMatch) return { pass: false, code: 'GEO_REMOTE_REGION_RESTRICTED', evidence: foreignMatch[0].trim() };
  if (excludesIndia) return { pass: false, code: 'GEO_REMOTE_EXCLUDES_INDIA', evidence: text };
  if (denied.length && !hasIndia && !hasAllowed) {
    return { pass: false, code: 'GEO_REMOTE_REGION_RESTRICTED', evidence: denied.join(', ') };
  }
  if (remoteEligibility?.status === 'India Eligible') {
    return { pass: true, code: 'GEO_REMOTE_INDIA_COMPATIBLE', evidence: remoteEligibility.evidence || 'structured remote eligibility' };
  }
  if (!hasAllowed) return { pass: false, code: 'GEO_REMOTE_SCOPE_UNCLEAR', evidence: text || null };
  return { pass: true, code: 'GEO_REMOTE_INDIA_COMPATIBLE', evidence: text || null };
}

export function classifyGeo(candidate, policy) {
  const workMode = classifyWorkMode(candidate);
  const location = evidence(candidate.location) || '';
  const geoText = [candidate.title, location, candidate.workMode, candidate.description]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .trim();
  if (workMode.mode === 'remote') return { ...remoteScopeStatus(geoText, location, policy, candidate.remoteEligibility), mode: 'remote' };
  if (workMode.mode === 'hybrid' || workMode.mode === 'onsite') {
    // Explicit separators mark alternate offices; commas also occur inside addresses.
    const options = location.split(/[;|/\n]|\s+or\s+/i);
    const hasPuneOption = options.some((option) => {
      if (hasAlias(option, EXCLUDED_PUNE_AREAS)) return false;
      const aliases = policy.geo.puneMetroAliases.filter((alias) => !AMBIGUOUS_PUNE_AREAS.includes(alias.toLowerCase().trim())
        || PUNE_LOCATION_CONTEXT_PATTERN.test(option));
      return hasAlias(option, aliases);
    });
    if (hasPuneOption) {
      return { pass: true, code: 'GEO_PUNE_METRO', evidence: location, mode: workMode.mode };
    }
    return { pass: false, code: workMode.mode === 'hybrid' ? 'GEO_HYBRID_NOT_PUNE' : 'GEO_ONSITE_NOT_PUNE', evidence: location || null, mode: workMode.mode };
  }
  // A listing without an explicit work mode or eligible geography cannot be
  // actioned safely. Keep the evidence observable and reject it at the gate.
  return { pass: false, strict: false, code: 'GEO_NOT_VERIFIED', evidence: 'Not Verified', mode: 'unknown' };
}

function employmentFromText(candidate) {
  // Location, experience and benefits describe other things than employment.
  // Read title/type evidence directly; inspect description for employment terms
  // after removing only specific leave/volunteering and hybrid-location phrases.
  const clean = (value) => decodeEntities(String(value || '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const direct = [clean(candidate.title), clean(candidate.employment?.evidence)].join(' · ');
  let description = clean(candidate.description)
    .replace(/\b(?:paid\s+)?volunteer(?:ing)?\s+(?:days?|time(?:\s+off)?|leave)\b/gi, '')
    .replace(/\b(?:paid\s+)?time\s+off\s+to\s+volunteer\b/gi, '')
    .replace(/\bunpaid\s+(?:leave|time\s+off)\b/gi, '');
  if (candidate.workMode === 'hybrid' || /\bhybrid\b/i.test(description)) {
    description = description.replace(/\b(?:work(?:ing)?[- ]from[- ]home|work(?:ing)?\s+remotely)\s+(?:on\s+a\s+)?part[- ]time(?:\s+basis)?\b/gi, '');
  }
  const text = [direct, description].join(' · ');
  const disallowed = /\b(?:part[ -]?time|contract(?:or)?|temporary|volunteer)\b/i;
  const roleType = /\b(?:part[ -]?time|contract(?:or)?|temporary|volunteer)\b[^.!?]{0,40}\b(?:role|position|employment|job|internship|engineer|developer|basis|availability)\b|\b(?:employment|job|engagement|contract)\s*(?:type)?\s*[:=-]\s*(?:part[ -]?time|contract(?:or)?|temporary|volunteer)\b|\b(?:work|hired|join|engaged)\s+(?:as\s+)?(?:a\s+)?(?:volunteer|contractor)\b/i;
  const disallowedType = direct.match(disallowed) || description.match(roleType)
    || description.match(/\b(?:role|position|employment|job)\s+(?:is|will be|as)\s+(?:a\s+)?(?:part[ -]?time|contract(?:or)?|temporary|volunteer)\b|\bwork(?:ing)?[- ]from[- ]home\s+(?:on\s+a\s+)?part[- ]time\b/i)
    || (/^(?:part[ -]?time|contract(?:or)?|temporary|volunteer)$/i.test(description) ? [description] : null);
  const internship = INTERNSHIP_PATTERN.test(direct) || /\b(?:paid\s+)?internship\b/i.test(description);
  const fullTime = /\bfull[ -]?time\b|permanent/i.test(text);
  const unpaid = UNPAID_PATTERN.test(text) || /\bvolunteer\b/i.test(disallowedType?.[0] || '');
  const paid = PAID_PATTERN.test(text) && !unpaid;
  const trainingFeeOrBond = text.match(TRAINING_FEE_OR_BOND_PATTERN);
  const freelancePerTask = text.match(/\bfreelance\b[^.!?]{0,80}\b(?:per[ -]?task|per[ -]?project|task[ -]?based)\b|\b(?:per[ -]?task|per[ -]?project|task[ -]?based)\b[^.!?]{0,80}\bfreelance\b/i);
  const agencyHire = text.match(/\b(?:staffing|recruitment|recruiting)\s+agency\b[^.!?]{0,100}\b(?:hiring|recruiting|reselling|resale)\b/i);
  const namedClient = /\b(?:named\s+client|client\s*(?::|=)|client\s+(?:is|named))\s+[a-z][a-z0-9& -]+/i.test(text);
  const anonymousAgency = text.match(/\b(?:staffing|recruitment|recruiting)\s+agency\b[^.!?]{0,100}\b(?:undisclosed|unnamed|anonymous|confidential)\s+client\b|\b(?:staffing|recruitment|recruiting)\s+agency\b[^.!?]{0,100}\bclient\s+(?:not\s+(?:named|disclosed)|undisclosed)\b/i)
    || (agencyHire && !namedClient ? agencyHire : null);
  return { internship, fullTime, unpaid, paid, trainingFeeOrBond, freelancePerTask, anonymousAgency, disallowedType, text };
}

export function classifyEmployment(candidate, policy) {
  const raw = employmentFromText(candidate);
  const suppliedType = candidate.employment?.type;
  const type = raw.internship && (!suppliedType || suppliedType === 'full-time')
    ? 'internship' : suppliedType || (raw.fullTime ? 'full-time' : null);
  const explicitUnpaid = candidate.employment?.paid === false || raw.unpaid;
  if (explicitUnpaid && policy.employment.rejectUnpaid) {
    return { pass: false, code: 'EMPLOYMENT_UNPAID', evidence: candidate.employment?.evidence || raw.text };
  }
  if (raw.trainingFeeOrBond) {
    return { pass: false, code: 'EMPLOYMENT_TRAINING_FEE_OR_BOND', evidence: raw.trainingFeeOrBond[0] };
  }
  if (raw.freelancePerTask) return { pass: false, code: 'EMPLOYMENT_FREELANCE_PER_TASK', evidence: raw.freelancePerTask[0] };
  if (raw.anonymousAgency) return { pass: false, code: 'EMPLOYMENT_AGENCY_CLIENT_NOT_NAMED', evidence: raw.anonymousAgency[0] };
  if (raw.disallowedType) return { pass: false, code: 'EMPLOYMENT_TYPE_NOT_ALLOWED', evidence: raw.disallowedType[0] };
  if (type && !policy.employment.allowedTypes.includes(type)) {
    return { pass: false, code: 'EMPLOYMENT_TYPE_NOT_ALLOWED', evidence: candidate.employment?.evidence || type };
  }
  // Ordinary engineering postings often omit a work-type field from list APIs.
  // Keep them eligible unless the text explicitly says a disallowed type; retain
  // null evidence so downstream output never fabricates "full-time".
  if (!type && !raw.internship) {
    return { pass: true, code: 'EMPLOYMENT_FULL_TIME_NOT_VERIFIED', evidence: null };
  }
  if (type === 'internship') {
    const stipend = parseStipend(candidate);
    if (stipend.status !== 'Verified') {
      return { pass: false, code: stipend.reason === 'STIPEND_MISSING' ? 'INTERNSHIP_PAY_NOT_EXPLICIT' : stipend.reason, evidence: stipend.evidence };
    }
    const ppo = raw.text.match(/\b(?:ppo|pre[ -]?placement offer|(?:path|opportunity) to (?:a )?full[ -]?time offer)\b/i);
    const noPpo = /\b(?:no|without)\s+(?:a\s+)?(?:ppo|pre[ -]?placement offer)|\b(?:ppo|pre[ -]?placement offer)\s+(?:is\s+)?(?:not|unavailable)/i.test(raw.text);
    if (!ppo || noPpo) return { pass: false, code: 'INTERNSHIP_PPO_NOT_STATED', evidence: ppo?.[0] || null };
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

// Reject role-specific senior hiring language while leaving employer boilerplate alone.
function seniorRoleRequirement(candidate) {
  const body = decodeEntities(candidate.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return body.match(/\b(?:we\s+(?:are\s+)?(?:seeking|hiring|looking for)|(?:this|the)\s+(?:position|role)\s+(?:is|requires)|(?:seeking|hiring|looking for))\s+(?:an?\s+)?(?:(?:experienced|highly skilled|skilled|talented)\s+)?((?:senior|sr\.?|staff|principal|lead)\s+(?:(?:java|python|software|backend|full[ -]?stack|ai|ml|data|machine learning)\s+){0,3}(?:engineer|developer|scientist))\b/i)?.[0] || null;
}

export function classifyExperience(candidate, policy) {
  const seniorRequirement = seniorRoleRequirement(candidate);
  if (seniorRequirement) return { pass: false, strict: false, relaxed: false, code: 'EXPERIENCE_SENIOR_ROLE_REQUIREMENT', evidence: seniorRequirement, minYears: null, maxYears: null };
  const parsed = parsedExperience(candidate);
  if (parsed.min != null && parsed.min >= policy.experience.hardRejectMinimumYears) {
    return { pass: false, strict: false, relaxed: false, code: 'EXPERIENCE_HARD_MIN_3_PLUS', evidence: parsed.evidence, minYears: parsed.min, maxYears: parsed.max };
  }
  if (parsed.min != null && parsed.min > policy.experience.relaxedMaximumYears) {
    return { pass: false, strict: false, relaxed: false, code: 'EXPERIENCE_ABOVE_RELAXED_LIMIT', evidence: parsed.evidence, minYears: parsed.min, maxYears: parsed.max };
  }
  if (parsed.min == null) {
    const fresherMatch = `${candidate.title || ''} ${candidate.description || ''}`.match(FRESHER_EXPERIENCE_PATTERN);
    if (fresherMatch) {
      return {
        pass: true,
        strict: true,
        relaxed: false,
        code: 'EXPERIENCE_FRESHER_EVIDENCE',
        evidence: fresherMatch[0],
        minYears: null,
        maxYears: null,
      };
    }
    return {
      pass: true,
      strict: false,
      relaxed: true,
      manualReview: true,
      code: 'EXPERIENCE_NOT_STATED_MANUAL_REVIEW',
      evidence: null,
      minYears: null,
      maxYears: null,
    };
  }
  if (parsed.min <= policy.experience.strictMaximumYears) {
    return {
      pass: true,
      strict: true,
      relaxed: false,
      code: 'EXPERIENCE_STRICT_0_1',
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
  if (SENIORITY_PATTERN.test(title) && !FRESHER_TITLE_PATTERN.test(title)) {
    return { pass: false, strict: false, relaxed: false, family: null, code: 'TITLE_SENIORITY_REJECT', evidence: title };
  }
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
  if (titleResult.family === 'general-new-grad-swe' && /\b(founding engineer|product engineer)\b/i.test(candidate.title || '')) {
    const body = `${candidate.title || ''} ${candidate.description || ''}`;
    if (/\b(ai|llm|machine learning|ml|agentic|gen\s*ai|rag)\b/i.test(body)) return 'ai-llm-agentic';
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

// Match configured employers without treating unrelated names as substrings.
function employerRuleKey(company) {
  return normalizedKey(company).replace(/\b(?:inc|ltd|limited|pvt|private|llc|corp|corporation|technologies|technology|solutions|india|co)\b/g, '').replace(/\s+/g, ' ').trim();
}

// Apply employer exclusions before a role can enter either eligibility tier.
function classifyCompany(candidate, policy) {
  const key = employerRuleKey(candidate.company);
  if (key && policy.companies.excluded.some((company) => employerRuleKey(company) === key)) {
    return { pass: false, code: 'COMPANY_EXCLUDED', evidence: candidate.company };
  }
  const aiOrProductTitle = /\b(ai|artificial intelligence|llm|genai|gen ai|generative ai|agentic|machine learning|ml|deep learning|computer vision|nlp|data scientist|product engineer|product engineering)\b/i.test(candidate.title || '');
  if (key && policy.companies.servicesMajors.some((company) => employerRuleKey(company) === key) && !aiOrProductTitle) {
    return { pass: false, code: 'SERVICES_MAJOR_GENERIC_ROLE', evidence: candidate.title || null };
  }
  return { pass: true, code: 'COMPANY_ALLOWED', evidence: candidate.company || null };
}

// Add schedule and notice labels without changing eligibility or reject reasons.
function candidateLabels(candidate, workMode) {
  const text = decodeEntities(textFor(candidate)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const labels = workMode === 'remote'
    ? classifyRemoteTimezone(candidate).labels || []
    : NIGHT_SHIFT_PATTERN.test(text) ? ['Night hours (IST)'] : [];
  const shortNotice = [...text.matchAll(SHORT_NOTICE_PATTERN)].some((match) => {
    const minimum = Number(match[1] ?? match[3]);
    const maximum = Number(match[2] ?? match[4] ?? minimum);
    return Math.max(minimum, maximum) <= 30;
  });
  if (IMMEDIATE_JOINER_PATTERN.test(text) || shortNotice) labels.push('Notice risk');
  return labels;
}

// Classify eligibility while keeping review labels separate from reject reasons.
export function classifyCandidate(candidate, policy) {
  const company = classifyCompany(candidate, policy);
  const geo = classifyGeo(candidate, policy);
  const employment = classifyEmployment(candidate, policy);
  const salary = classifySalary(candidate, policy);
  const experience = classifyExperience(candidate, policy);
  const title = classifyTitle(candidate);
  const liveness = classifyLiveness(candidate);
  const hardPass = company.pass && geo.pass && employment.pass && salary.pass && experience.pass && title.pass && liveness.pass;
  const strict = hardPass && geo.strict !== false && title.strict && experience.strict;
  const relaxed = hardPass && !strict && (geo.strict === false || title.relaxed || experience.relaxed);
  const reasons = [company, geo, employment, salary, experience, title, liveness].filter((result) => !result.pass).map((result) => result.code);
  const evidenceCodes = [company.code, geo.code, employment.code, salary.code, experience.code, title.code, liveness.code];
  const relaxations = [];
  if (hardPass && !title.strict) relaxations.push('adjacent-title');
  if (hardPass && experience.manualReview) relaxations.push('experience-not-stated');
  if (hardPass && !experience.strict && !experience.manualReview) relaxations.push('experience-up-to-2-years');
  const roleFamily = classifyRoleFamily(candidate, title);
  return {
    eligible: strict || relaxed,
    strict,
    relaxed,
    tier: strict ? 'strict' : relaxed ? 'relaxed' : null,
    roleFamily,
    workMode: geo.mode,
    company,
    geo,
    employment,
    salary,
    experience,
    title,
    liveness,
    reasons,
    labels: candidateLabels(candidate, geo.mode),
    evidenceCodes,
    relaxations,
    companyKey: normalizedKey(candidate.company),
    familyKey: roleFamily,
  };
}
