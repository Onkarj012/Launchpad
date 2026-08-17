const INDIA = /\bindia\b|\bindian\b/i;
const APAC = /\bapac\b|asia[ -]?pacific/i;
const GLOBAL = /\bworldwide\b|\bworld[ -]?wide\b|\bglobal(?:ly)?\b|\banywhere\b/i;
const REMOTE = /\bremote\b|work[ -]?from[ -]?home|distributed|anywhere/i;
const EOR = /\bemployer\s+of\s+record\b|\beor\b/i;
const COUNTRY_RESTRICTION = /(?:authorized\s+to\s+work\s+in|work\s+authorization(?:\s+in)?|work\s+permit\s+(?:for|in)|must\s+(?:be\s+located|reside)|(?:citizenship|citizens?|residency|residents?)\s*(?:required|only|of|from)|(?:payroll|employment)\s+(?:only\s+)?in|(?:payroll|employment)(?:\s+\w+){0,3}\s+in|based\s+in|(?:anywhere|worldwide|global)\s+(?:in|within))\s+(?:the\s+)?(?:u\.?s\.?|usa|united states|canada|europe|eu|u\.?k\.?|united kingdom|australia|new zealand|latam|latin america)\b|\b(?:u\.?s\.?|usa|united states|canada|europe|eu|u\.?k\.?|united kingdom|australia|new zealand|latam|latin america)\s+(?:only|citizens?|citizenship|residency|residents?|payroll|work\s+permit)(?:\s+only)?\b/i;
const INDIA_EXCLUSION = /excluding\s+india|except\s+india|india\s+(?:excluded|not\s+available)|india\s+is\s+not\s+(?:supported|eligible|included)|not\s+(?:open|available)\s+to\s+india/i;
const GIG = /\bgig\b|freelance|commission[ -]only|project[ -]only|temporary|short[ -]term|as[ -]needed|piecework|volunteer/i;
const STABLE = /full[ -]?time\s+contract(?:or)?|long[ -]?term|ongoing|indefinite|permanent\s+contract(?:or)?|12[ -]?month|employee[- ]?equivalent|regular\s+(?:salary|payroll|employment)/i;
const PAYROLL = /payroll|salary|monthly\s+pay|regular\s+pay|paid\s+(?:through|via|by)|compensation/i;

function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : ''; }
function evidenceValue(value) {
  if (typeof value === 'string') return text(value);
  if (value && typeof value === 'object') return value.evidence || value.text || JSON.stringify(value);
  return '';
}

function combinedText(candidate) {
  const remote = candidate.remoteEvidence || {};
  return [candidate.title, candidate.location, candidate.workMode, candidate.description, candidate.remoteEligibility?.evidence, candidate.eor?.evidence, candidate.employment?.evidence, remote.scope, remote.citizenship, remote.country, remote.workAuthorization, remote.payroll, remote.employment]
    .map(evidenceValue).filter(Boolean).join(' · ');
}

function exclusionEvidence(candidate, combined) {
  const remote = candidate.remoteEvidence || {};
  for (const value of [combined, remote.citizenship, remote.country, remote.workAuthorization, remote.payroll]) {
    const candidateText = evidenceValue(value);
    if (INDIA_EXCLUSION.test(candidateText)) return { code: 'REMOTE_INDIA_EXCLUDED', evidence: candidateText };
    const match = candidateText.match(COUNTRY_RESTRICTION);
    if (match) return { code: 'REMOTE_COUNTRY_CITIZENSHIP_AUTH_PAYROLL_RESTRICTED', evidence: match[0] };
  }
  return null;
}

export function classifyRemoteEligibility(candidate) {
  const remote = candidate.remoteEvidence || {};
  const combined = combinedText(candidate);
  const excluded = exclusionEvidence(candidate, combined);
  if (excluded) return { eligible: false, status: 'Not Eligible', classification: null, code: excluded.code, evidence: excluded.evidence, reasons: [excluded.code] };
  if (candidate.remoteEligibility?.status === 'Not Eligible') {
    return { eligible: false, status: 'Not Eligible', classification: null, code: 'REMOTE_PROVIDER_MARKED_INELIGIBLE', evidence: candidate.remoteEligibility.evidence || null, reasons: ['REMOTE_PROVIDER_MARKED_INELIGIBLE'] };
  }

  const hasIndia = INDIA.test(combined);
  const hasApac = APAC.test(combined);
  const hasGlobal = GLOBAL.test(combined);
  const hasEor = candidate.eor?.available === true || EOR.test(combined);
  const explicitIndia = candidate.remoteEligibility?.status === 'India Eligible' || hasIndia;
  if (hasEor && explicitIndia) {
    return { eligible: true, status: 'India Eligible', classification: 'stable-eor', code: 'REMOTE_STABLE_EOR_INDIA', evidence: remote.scope || remote.payroll || candidate.remoteEligibility?.evidence || combined, reasons: [] };
  }
  if (hasApac) return { eligible: true, status: 'India Eligible', classification: 'apac', code: 'REMOTE_APAC', evidence: remote.scope || combined, reasons: [] };
  if (hasGlobal) return { eligible: true, status: 'India Eligible', classification: 'global', code: 'REMOTE_GLOBAL', evidence: remote.scope || combined, reasons: [] };
  if (explicitIndia) return { eligible: true, status: 'India Eligible', classification: 'india', code: 'REMOTE_INDIA', evidence: remote.scope || candidate.location || combined, reasons: [] };
  if (hasEor) return { eligible: false, status: 'Needs Verification', classification: 'stable-eor', code: 'REMOTE_EOR_INDIA_AVAILABILITY_UNPROVEN', evidence: remote.payroll || combined, reasons: ['REMOTE_EOR_INDIA_AVAILABILITY_UNPROVEN'] };
  if (REMOTE.test(combined)) return { eligible: false, status: 'Needs Verification', classification: null, code: 'REMOTE_SCOPE_AMBIGUOUS', evidence: remote.scope || candidate.location || combined, reasons: ['REMOTE_SCOPE_AMBIGUOUS'] };
  return { eligible: false, status: 'Needs Verification', classification: null, code: 'REMOTE_ELIGIBILITY_NOT_VERIFIED', evidence: null, reasons: ['REMOTE_ELIGIBILITY_NOT_VERIFIED'] };
}

export function classifyRemoteEmployment(candidate) {
  const remote = candidate.remoteEvidence || {};
  const combined = combinedText(candidate);
  const gigEvidence = [combined, remote.employment].map(evidenceValue).find((value) => GIG.test(value));
  if (gigEvidence) return { eligible: false, status: 'Not Eligible', category: null, code: 'REMOTE_UNSTABLE_GIG_OR_FREELANCE', evidence: gigEvidence, reasons: ['REMOTE_UNSTABLE_GIG_OR_FREELANCE'] };

  const type = candidate.employment?.type;
  const eor = candidate.eor?.available === true || EOR.test(combined);
  const stable = STABLE.test(combined) || candidate.remoteEmploymentStability?.stable === true;
  const payroll = PAYROLL.test(combined) || Boolean(remote.payroll);
  if (type === 'contract' || eor) {
    if (!stable || !payroll) return { eligible: false, status: 'Needs Verification', category: eor ? 'EOR' : 'Contractor', code: 'REMOTE_CONTRACT_STABILITY_PAYROLL_UNPROVEN', evidence: remote.employment || candidate.employment?.evidence || combined, reasons: ['REMOTE_CONTRACT_STABILITY_PAYROLL_UNPROVEN'] };
    return { eligible: true, status: 'Eligible', category: eor ? 'Stable EOR' : 'Stable Contractor', code: eor ? 'REMOTE_STABLE_EOR' : 'REMOTE_STABLE_CONTRACTOR', evidence: remote.employment || candidate.employment?.evidence || combined, reasons: [] };
  }
  if (type === 'internship') return { eligible: true, status: 'Eligible', category: 'Internship', code: 'REMOTE_PAID_INTERNSHIP', evidence: candidate.employment?.evidence || null, reasons: [] };
  return { eligible: true, status: 'Eligible', category: 'Full-time Employee', code: 'REMOTE_FULL_TIME', evidence: candidate.employment?.evidence || combined, reasons: [] };
}

export function enrichRemoteCandidate(candidate) {
  const eligibility = classifyRemoteEligibility(candidate);
  const employment = classifyRemoteEmployment(candidate);
  const remoteReady = eligibility.eligible && employment.eligible;
  return {
    ...candidate,
    remoteEligibility: { status: eligibility.status === 'Eligible' ? 'India Eligible' : eligibility.status === 'Not Eligible' ? 'Not Eligible' : 'Not Verified', evidence: eligibility.evidence || candidate.remoteEligibility?.evidence || null },
    remoteEligibilityDecision: eligibility,
    remoteEmploymentDecision: employment,
    remoteEmploymentCategory: employment.category,
    remoteReady,
    timezoneDecision: { accepted: true, evidence: candidate.timezoneOverlap?.evidence || null },
    evidence: {
      ...(candidate.evidence || {}),
      remote: { ...(candidate.evidence?.remote || candidate.remoteEvidence || {}), eligibility, employment, timezone: { accepted: true } },
    },
  };
}

export function enrichRemoteSources(sourceResults) {
  return sourceResults.map((source) => ({
    ...source,
    candidates: source.candidates.map(enrichRemoteCandidate),
  }));
}

export const REMOTE_SCHEMA_FIELDS = Object.freeze([
  'remoteEligibilityClass', 'remoteScopeEvidence', 'citizenshipEvidence', 'countryRestrictionEvidence',
  'workAuthorizationEvidence', 'payrollEvidence', 'employmentStructure', 'employmentStabilityEvidence',
  'providerDateEvidence', 'timezoneEvidence',
]);
