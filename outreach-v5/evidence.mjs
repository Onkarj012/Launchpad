import { personIdentity } from './idempotency.mjs';

export const CONTACT_CONFIDENCE = Object.freeze(['High', 'Medium', 'Low']);
export const CONTACT_CHANNELS = Object.freeze(['Email', 'LinkedIn', 'Public Email', 'Referral']);

export class ContactEvidenceError extends Error {
  constructor(message, code = 'CONTACT_EVIDENCE_INVALID', details = null) {
    super(message);
    this.name = 'ContactEvidenceError';
    this.code = code;
    this.details = details;
  }
}

function text(value) {
  const normalized = String(value ?? '').normalize('NFKC').trim();
  return normalized || null;
}

function validUrl(value) {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeEmail(value) {
  const email = text(value)?.toLocaleLowerCase('en-US') ?? null;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function normalizeEvidenceItems(items, fallbackUrl = null) {
  const values = Array.isArray(items) ? items : items ? [items] : [];
  const normalized = values.map((item) => {
    if (typeof item === 'string') return { url: validUrl(item), title: null, source: null };
    return { url: validUrl(item?.url ?? item?.href), title: text(item?.title ?? item?.label), source: text(item?.source ?? item?.provider) };
  }).filter((item) => item.url);
  if (!normalized.length && fallbackUrl) {
    const url = validUrl(fallbackUrl);
    if (url) normalized.push({ url, title: null, source: null });
  }
  return normalized;
}

function inferredChannel(candidate, email) {
  if (candidate.recommendedChannel) return canonicalChannel(candidate.recommendedChannel);
  if (email && candidate.emailEvidence) return 'Public Email';
  if (candidate.linkedinUrl || candidate.profileUrl || candidate.contactUrl) return 'LinkedIn';
  if (email) return 'Public Email';
  return null;
}

function canonicalChannel(value) {
  const key = text(value)?.toLocaleLowerCase('en-US').replace(/[\s_-]+/gu, '') ?? '';
  return { email: 'Email', linkedin: 'LinkedIn', publicemail: 'Public Email', referral: 'Referral' }[key] ?? text(value);
}

function confidence(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.min(1, Math.max(0, value));
  const label = text(value);
  if (label && CONTACT_CONFIDENCE.includes(label)) return label;
  return 'Low';
}

function observationDate(value) {
  const observedAt = text(value);
  if (!observedAt || Number.isNaN(Date.parse(observedAt))) {
    throw new ContactEvidenceError('an evidence observation date is required', 'EVIDENCE_OBSERVED_AT_REQUIRED');
  }
  return new Date(observedAt).toISOString();
}

/**
 * Normalize only evidence supplied by a provider. In particular, this never
 * derives an email from a name, company domain, or guessed pattern.
 */
export function normalizeContactEvidence(candidate = {}, { application = {}, source = null } = {}) {
  const name = text(candidate.name ?? candidate.person ?? candidate.Person);
  const currentRole = text(candidate.currentRole ?? candidate.role ?? candidate.title ?? candidate.ContactRole);
  const companyRelationship = text(candidate.companyRelationship ?? candidate.relationship ?? candidate.companyRole);
  const contactUrl = validUrl(candidate.contactUrl ?? candidate.linkedinUrl ?? candidate.profileUrl);
  const publicEvidence = normalizeEvidenceItems(candidate.publicEvidence ?? candidate.evidence ?? candidate.evidenceUrls, contactUrl);
  if (!name) throw new ContactEvidenceError('contact identity is required', 'CONTACT_NAME_REQUIRED');
  if (!currentRole) throw new ContactEvidenceError('contact current role is required', 'CONTACT_ROLE_REQUIRED');
  if (!companyRelationship) throw new ContactEvidenceError('company relationship evidence is required', 'COMPANY_RELATIONSHIP_REQUIRED');
  if (!publicEvidence.length) throw new ContactEvidenceError('at least one public evidence link is required', 'PUBLIC_EVIDENCE_REQUIRED');
  const observedAt = observationDate(candidate.observedAt ?? candidate.observationDate);

  const email = normalizeEmail(candidate.email ?? candidate.publicEmail);
  if (email && !candidate.emailEvidence && !candidate.emailSource) {
    throw new ContactEvidenceError('email must include its source evidence; guessed emails are refused', 'EMAIL_EVIDENCE_REQUIRED');
  }
  const channel = inferredChannel(candidate, email);
  if (!channel || !CONTACT_CHANNELS.includes(channel)) throw new ContactEvidenceError('recommended contact channel is invalid or missing', 'CHANNEL_REQUIRED');
  if ((channel === 'Email' || channel === 'Public Email') && !email) throw new ContactEvidenceError('an email channel requires an evidence-backed email address', 'EMAIL_REQUIRED');
  if (channel === 'LinkedIn' && !contactUrl) throw new ContactEvidenceError('a LinkedIn channel requires a public profile URL', 'PROFILE_URL_REQUIRED');

  return Object.freeze({
    personId: text(candidate.personId ?? candidate.id) ?? personIdentity({ name, contactUrl, email }),
    name,
    currentRole,
    companyRelationship,
    company: text(candidate.company ?? application.companyName ?? application.company),
    contactUrl,
    email,
    emailEvidence: text(candidate.emailEvidence ?? candidate.emailSource),
    publicEvidence,
    recommendedChannel: channel,
    confidence: confidence(candidate.confidence),
    source: text(candidate.source ?? source),
    observedAt,
  });
}

export function assertContactEvidence(contact) {
  const normalized = normalizeContactEvidence(contact, { application: contact });
  return normalized;
}

export function evidenceUrls(contact = {}) {
  return (contact.publicEvidence ?? []).map((item) => typeof item === 'string' ? item : item.url).filter(Boolean);
}
