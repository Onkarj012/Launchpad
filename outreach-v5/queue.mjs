import { normalizeNotionOutreachState } from './notion-normalizers.mjs';

function queueBlockers(application, companyEvidence) {
  const blockers = [];
  if (!application.userSelected) blockers.push('USER_SELECTION_REQUIRED');
  if (!application.applicationReady) blockers.push('APPLICATION_NOT_READY');
  if (application.terminal) blockers.push('APPLICATION_TERMINAL');
  if (!application.hook) blockers.push('HOOK_REQUIRED');
  if (!application.approvedProofPoint) blockers.push('APPROVED_PROOF_REQUIRED');
  if (!application.resumeArtifact?.pdfPath || application.resumeState !== 'Ready') blockers.push('READY_RESUME_ARTIFACT_REQUIRED');
  if (!application.originalApplicationUrl) blockers.push('ORIGINAL_ATS_URL_REQUIRED');
  if (!companyEvidence?.id || !companyEvidence.careerPageUrl || !companyEvidence.lastVerified) blockers.push('COMPANY_EVIDENCE_REQUIRED');
  return blockers;
}

export function buildOutreachQueue(raw = {}) {
  const domain = normalizeNotionOutreachState(raw);
  const companies = new Map(domain.companies.map((company) => [company.id, company]));
  const ready = [];
  const blocked = [];

  for (const application of domain.applications) {
    const companyEvidence = companies.get(application.companyIds[0]) ?? null;
    const entry = Object.freeze({
      ...application,
      companyName: application.companyName ?? companyEvidence?.name ?? null,
      companyEvidence,
      existingOutreach: domain.outreach.filter((row) => row.applicationId === application.id),
      activity: domain.activity.filter((row) => row.applicationId === application.id),
      referrals: domain.referrals.filter((row) => row.applicationId === application.id),
    });
    const blockers = queueBlockers(entry, companyEvidence);
    if (blockers.length) blocked.push(Object.freeze({ applicationId: application.id, blockers, application: entry }));
    else ready.push(entry);
  }

  return Object.freeze({ status: blocked.length ? (ready.length ? 'partial' : 'blocked') : 'ready', ready, blocked, domain });
}
