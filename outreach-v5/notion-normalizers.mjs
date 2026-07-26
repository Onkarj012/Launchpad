import { readPropertyValue } from '../notion-v5/schema.mjs';

const TERMINAL_STATUSES = new Set(['Offer', 'Rejected', 'Withdrawn', 'Not Pursuing', 'Closed/Expired']);

function text(value) {
  const normalized = String(value ?? '').normalize('NFKC').trim();
  return normalized || null;
}

function number(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function array(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value == null ? [] : [value];
}

function rawPage(value) {
  return Boolean(value?.properties && typeof value.properties === 'object' && !value.values);
}

function rawValue(page, name) {
  return readPropertyValue(page?.properties?.[name]);
}

function value(row, domainKey, notionName = domainKey) {
  if (rawPage(row)) return rawValue(row, notionName);
  if (row?.[domainKey] !== undefined) return row[domainKey];
  if (row?.values?.[domainKey] !== undefined) return row.values[domainKey];
  if (row?.[notionName] !== undefined) return row[notionName];
  return null;
}

function date(valueToNormalize) {
  const candidate = text(valueToNormalize);
  if (!candidate) return null;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function resumeArtifact(row, application) {
  const stored = value(row, 'resumeArtifact', 'Resume Artifact');
  if (stored && typeof stored === 'object') return Object.freeze({ ...stored });
  const pdfPath = text(stored);
  if (!pdfPath) return null;
  return Object.freeze({
    applicationId: application.id,
    company: application.companyName,
    role: application.role,
    pdfPath,
    state: application.resumeState,
    digest: text(value(row, 'resumeArtifactDigest', 'Resume Artifact Digest')),
  });
}

export function normalizeApplicationPage(row = {}) {
  const companyIds = array(value(row, 'companyIds', 'Company'));
  const application = {
    id: text(row.id ?? row.pageId),
    name: text(value(row, 'name', 'Name')),
    role: text(value(row, 'role', 'Role')),
    companyIds,
    companyName: text(value(row, 'companyName', 'Company Name') ?? row.companyName ?? row.company),
    status: text(value(row, 'status', 'Status')),
    applicationReady: value(row, 'applicationReady', 'Application Ready') === true,
    makeResume: value(row, 'makeResume', 'Make Resume') === true,
    applied: value(row, 'applied', 'Applied?') === true,
    resumeState: text(value(row, 'resumeState', 'Resume State')),
    matchScore: number(value(row, 'matchScore', 'Match Score')),
    conversionScore: number(value(row, 'conversionScore', 'Conversion Score')),
    hook: text(value(row, 'hook', 'Hook')),
    approvedProofPoint: text(value(row, 'approvedProofPoint', 'Approved Proof Point') ?? row.bestProof),
    originalApplicationUrl: text(value(row, 'originalApplicationUrl', 'Original Application URL')),
    outreachState: text(value(row, 'outreachState', 'Outreach State')),
    nextAction: text(value(row, 'nextAction', 'Next Action')),
    runId: text(value(row, 'runId', 'Run ID')),
  };
  application.bestProof = application.approvedProofPoint;
  application.resumeArtifact = resumeArtifact(row, application);
  application.userSelected = application.makeResume || application.applied || row.userSelected === true;
  application.terminal = TERMINAL_STATUSES.has(application.status);
  return Object.freeze(application);
}

export function normalizeCompanyPage(row = {}) {
  return Object.freeze({
    id: text(row.id ?? row.pageId),
    name: text(value(row, 'name', 'Name')),
    canonicalDomain: text(value(row, 'canonicalDomain', 'Canonical Domain')),
    careerPageUrl: text(value(row, 'careerPageUrl', 'Career Page URL')),
    verificationState: text(value(row, 'verificationState', 'Verification State')),
    fundingEvidence: text(value(row, 'fundingEvidence', 'Funding Evidence')),
    lastVerified: date(value(row, 'lastVerified', 'Last Verified')),
  });
}

export function normalizeOutreachPage(row = {}) {
  const applicationIds = array(value(row, 'applicationIds', 'Application'));
  return Object.freeze({
    id: text(row.id ?? row.pageId),
    name: text(value(row, 'name', 'Name')),
    applicationIds,
    applicationId: text(row.applicationId) ?? applicationIds[0] ?? null,
    person: text(value(row, 'person', 'Person')),
    channel: text(value(row, 'channel', 'Channel')),
    contactUrl: text(value(row, 'contactUrl', 'Contact URL')),
    email: text(value(row, 'email', 'Email')),
    preview: text(value(row, 'preview', 'Preview')),
    sent: value(row, 'sent', 'Sent?') === true,
    sentAt: date(value(row, 'sentAt', 'Sent At')),
    initialSentAt: date(value(row, 'initialSentAt', 'Initial Sent At')),
    response: text(value(row, 'response', 'Response')),
    outcome: text(value(row, 'outcome', 'Outcome')),
    nextEligibleContact: date(value(row, 'nextEligibleContact', 'Next Eligible Contact')),
    duplicateKey: text(value(row, 'duplicateKey', 'Duplicate Key')),
    evidenceUrl: text(value(row, 'evidenceUrl', 'Evidence URL')),
    draftState: text(value(row, 'draftState', 'Draft State')),
    gmailDraftId: text(value(row, 'gmailDraftId', 'Gmail Draft ID')),
    attachmentDigest: text(value(row, 'attachmentDigest', 'Attachment Digest')),
  });
}

export function normalizeActivityPage(row = {}) {
  const applicationIds = array(value(row, 'applicationIds', 'Application'));
  return Object.freeze({
    id: text(row.id ?? row.pageId),
    name: text(value(row, 'name', 'Name')),
    applicationIds,
    applicationId: text(row.applicationId) ?? applicationIds[0] ?? null,
    eventType: text(value(row, 'eventType', 'Event Type')),
    eventAt: date(value(row, 'eventAt', 'Event At')),
    dueAt: date(value(row, 'dueAt', 'Due At')),
    idempotencyKey: text(value(row, 'idempotencyKey', 'Idempotency Key')),
    actionState: text(value(row, 'actionState', 'Action State')),
    outreachKey: text(value(row, 'outreachKey', 'Outreach Key')),
    notes: text(value(row, 'notes', 'Notes')),
  });
}

export function normalizeReferralPage(row = {}) {
  const applicationIds = array(value(row, 'applicationIds', 'Application'));
  return Object.freeze({
    id: text(row.id ?? row.pageId),
    name: text(value(row, 'name', 'Name')),
    applicationIds,
    applicationId: text(row.applicationId) ?? applicationIds[0] ?? null,
    person: text(value(row, 'person', 'Person')),
    personUrl: text(value(row, 'personUrl', 'Person URL')),
    channel: text(value(row, 'channel', 'Channel')),
    status: text(value(row, 'status', 'Status')),
    requestedAt: date(value(row, 'requestedAt', 'Requested At')),
    outcome: text(value(row, 'outcome', 'Outcome')),
    duplicateKey: text(value(row, 'duplicateKey', 'Duplicate Key')),
    evidence: text(value(row, 'evidence', 'Evidence')),
  });
}

export function normalizeNotionOutreachState({ applications = [], outreach = [], activity = [], companies = [], referrals = [] } = {}) {
  return Object.freeze({
    applications: applications.map(normalizeApplicationPage),
    outreach: outreach.map(normalizeOutreachPage),
    activity: activity.map(normalizeActivityPage),
    companies: companies.map(normalizeCompanyPage),
    referrals: referrals.map(normalizeReferralPage),
  });
}
