import { canonicalizeUrl, candidateDedupKey, hiringEmployerConflict } from './candidate.mjs';

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function evidenceText(value) {
  if (value == null) return null;
  if (typeof value === 'string') return text(value);
  try { return JSON.stringify(value); } catch { return null; }
}

function originalEvidence(candidate) {
  return candidate.originalApplicationEvidence
    ?? candidate.applicationResolution?.evidence
    ?? candidate.evidence?.originalApplication
    ?? candidate.evidence?.originalApplicationEvidence
    ?? candidate.evidence?.resolution;
}

function originalLiveness(candidate) {
  return candidate.originalApplicationLiveness?.status
    ?? candidate.evidence?.originalApplicationLiveness?.status
    ?? candidate.liveness?.status;
}

/**
 * Resolve a discovery lead to a first-party application destination. Direct
 * ATS candidates carry their provenance in source/provider; portal and search
 * candidates must supply explicit resolution evidence.
 */
export function resolveOriginalEmployer(candidate) {
  const url = canonicalizeUrl(candidate?.originalApplicationUrl);
  const status = text(candidate?.applicationResolution?.status) || (url ? 'Resolved Original' : 'Unresolved');
  const evidence = originalEvidence(candidate);
  const employerConflict = hiringEmployerConflict(candidate?.description);
  const direct = candidate?.sourceKind === 'ats-direct' && status === 'Direct ATS';
  const resolved = !employerConflict && ['Direct ATS', 'Resolved Original'].includes(status) && Boolean(url) && (direct || Boolean(evidence));
  const provenance = direct
    ? `direct-ats:${candidate.provider || candidate.source || 'unknown'}`
    : evidenceText(candidate?.evidence?.originalApplicationProvider) || null;
  const reasons = [];
  if (employerConflict) reasons.push('HIRING_EMPLOYER_NOT_VERIFIED');
  if (!url) reasons.push('ORIGINAL_APPLICATION_URL_MISSING');
  if (!['Direct ATS', 'Resolved Original'].includes(status)) reasons.push('ORIGINAL_APPLICATION_NOT_RESOLVED');
  if (!direct && !evidence) reasons.push('ORIGINAL_APPLICATION_EVIDENCE_MISSING');
  return {
    ready: resolved,
    status: resolved ? status : 'Unresolved',
    url,
    evidence: evidenceText(evidence),
    provenance,
    ...(employerConflict ? { employerIdentity: { status: 'Not Verified', ...employerConflict } } : {}),
    reasons,
  };
}

/** Classify the evidence that an operator needs to verify before applying. */
export function classifyCandidateEvidence(candidate, eligibility = null) {
  const resolution = resolveOriginalEmployer(candidate);
  const livenessStatus = originalLiveness(candidate);
  const liveness = {
    status: livenessStatus || 'Not Verified',
    pass: livenessStatus === 'Active',
    evidence: candidate?.liveness?.evidence ?? candidate?.evidence?.liveness ?? null,
  };
  const feesOrBonds = candidate?.feeBondEvidence
    ?? candidate?.evidence?.feesBonds
    ?? candidate?.evidence?.feeBond
    ?? null;
  const experience = candidate?.experience || {};
  const citizenship = candidate?.remoteEligibility || candidate?.citizenship || { status: 'Not Verified', evidence: null };
  const employment = candidate?.employment || { type: null, paid: null, evidence: null };
  const hardFailures = [];
  if (!text(candidate?.description)) hardFailures.push('JD_MISSING');
  const employmentVerified = candidate?.employment?.type === 'full-time'
    || (candidate?.employment?.type === 'internship' && candidate?.employment?.paid === true)
    || ['EMPLOYMENT_FULL_TIME', 'EMPLOYMENT_PAID_INTERNSHIP', 'EMPLOYMENT_EOR_INDIA', 'EMPLOYMENT_LONG_TERM_CONTRACT'].includes(eligibility?.employment?.code);
  if (!employmentVerified) hardFailures.push('EMPLOYMENT_NOT_VERIFIED');
  if (!resolution.ready) hardFailures.push(...resolution.reasons);
  if (livenessStatus !== 'Active') hardFailures.push(livenessStatus === 'Expired' ? 'LIVENESS_EXPIRED' : 'LIVENESS_NOT_VERIFIED');
  if (feesOrBonds) hardFailures.push('FEES_OR_BOND_CONCERN');
  if (eligibility?.reasons?.length) hardFailures.push(...eligibility.reasons);
  return {
    resolution,
    liveness,
    citizenship: { status: citizenship.status || 'Not Verified', evidence: citizenship.evidence || null },
    experience: { minYears: experience.minYears ?? null, maxYears: experience.maxYears ?? null, evidence: experience.evidence ?? null },
    employment: { type: employment.type ?? null, paid: employment.paid ?? null, evidence: employment.evidence ?? null },
    feesOrBonds: { status: feesOrBonds ? 'Concern' : 'None observed', evidence: feesOrBonds },
    location: eligibility?.geo || { status: 'Not Verified', evidence: candidate?.location || null },
    hardFailures: [...new Set(hardFailures)],
  };
}

export function applicationReadiness(candidate, eligibility = null) {
  const evidence = classifyCandidateEvidence(candidate, eligibility);
  const policyPass = eligibility?.eligible === true;
  const finalReady = Boolean(evidence.resolution.ready && evidence.liveness.pass && !evidence.feesOrBonds.evidence && !evidence.hardFailures.length && policyPass);
  return {
    ready: finalReady,
    status: finalReady ? 'Ready' : 'Needs Verification',
    evidence,
    reasons: finalReady ? [] : evidence.hardFailures.length ? evidence.hardFailures : ['POLICY_OR_EVIDENCE_INCOMPLETE'],
    dedupKey: candidate ? candidateDedupKey(candidate) : null,
  };
}
