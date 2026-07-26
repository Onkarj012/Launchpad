import { createHash } from 'node:crypto';
import { evidenceUrls } from './evidence.mjs';
import { personIdentity } from './idempotency.mjs';

export const CONTACT_SUPPRESSION_WINDOWS = Object.freeze({ personDays: 30, companyDays: 7 });

export class ContactReviewError extends Error {
  constructor(message, code = 'CONTACT_REVIEW_INVALID', details = null) {
    super(message);
    this.name = 'ContactReviewError';
    this.code = code;
    this.details = details;
  }
}

function text(value) {
  const normalized = String(value ?? '').normalize('NFKC').trim();
  return normalized || null;
}

function iso(value, code) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ContactReviewError('contact review date is invalid', code);
  return date.toISOString();
}

function eventDate(entry) {
  return entry.initialSentAt ?? entry.sentAt ?? entry.eventAt ?? entry.observedAt ?? entry.requestedAt ?? null;
}

function withinWindow(entry, now, days) {
  const observed = eventDate(entry);
  if (!observed) return false;
  const age = new Date(now).getTime() - new Date(observed).getTime();
  return age >= 0 && age < days * 86400000;
}

function active(entry) {
  if (entry.active === false) return false;
  if (['Stopped', 'Closed'].includes(entry.draftState ?? entry.state)) return false;
  return !entry.response && !entry.outcome;
}

function reviewDigest(card) {
  return createHash('sha256').update(JSON.stringify({
    applicationId: card.application.id,
    personId: card.person.id,
    channel: card.recommendedChannel,
    observedAt: card.evidence.observedAt,
    urls: card.evidence.urls,
  })).digest('hex');
}

export function evaluateContactSuppression({
  application,
  contact,
  personHistory = [],
  companyHistory = [],
  activeSequences = [],
  now = () => Date.now(),
  windows = CONTACT_SUPPRESSION_WINDOWS,
} = {}) {
  const timestamp = iso(typeof now === 'function' ? now() : now, 'CLOCK_INVALID');
  const personKey = personIdentity(contact);
  const samePerson = personHistory.filter((entry) => {
    try { return personIdentity(entry) === personKey; } catch { return false; }
  });
  const company = text(application?.companyName ?? application?.company ?? contact?.company);
  const sameCompany = companyHistory.filter((entry) => text(entry.companyName ?? entry.company) === company);
  const parallel = activeSequences.find((entry) => {
    try { return active(entry) && personIdentity(entry) === personKey; } catch { return false; }
  });
  const reasons = [];
  if (parallel) reasons.push('ACTIVE_PERSON_SEQUENCE');
  if (samePerson.some((entry) => withinWindow(entry, timestamp, windows.personDays))) reasons.push('PERSON_SILENCE_WINDOW');
  if (sameCompany.some((entry) => withinWindow(entry, timestamp, windows.companyDays))) reasons.push('COMPANY_SILENCE_WINDOW');
  return Object.freeze({
    allowed: reasons.length === 0,
    reasons,
    evaluatedAt: timestamp,
    windows: Object.freeze({ ...windows }),
    personHistory: samePerson,
    companyHistory: sameCompany,
    activeSequence: parallel ?? null,
  });
}

export function buildContactReviewCard({
  application,
  contact,
  personHistory = [],
  companyHistory = [],
  activeSequences = [],
  now = () => Date.now(),
  windows = CONTACT_SUPPRESSION_WINDOWS,
} = {}) {
  if (!application?.id) throw new ContactReviewError('application is required for contact review', 'APPLICATION_REQUIRED');
  if (!contact?.name) throw new ContactReviewError('person is required for contact review', 'PERSON_REQUIRED');
  const observedAt = iso(contact.observedAt, 'EVIDENCE_OBSERVED_AT_REQUIRED');
  const suppression = evaluateContactSuppression({ application, contact, personHistory, companyHistory, activeSequences, now, windows });
  const card = {
    application: Object.freeze({
      id: application.id,
      role: text(application.role ?? application.Role),
      company: text(application.companyName ?? application.company ?? application.Company),
      originalApplicationUrl: text(application.originalApplicationUrl),
    }),
    person: Object.freeze({ id: personIdentity(contact), name: contact.name }),
    currentRole: text(contact.currentRole),
    whyRelevant: text(contact.whyRelevant ?? contact.companyRelationship),
    companyRelationship: text(contact.companyRelationship),
    evidence: Object.freeze({ urls: evidenceUrls(contact), observedAt }),
    recommendedChannel: text(contact.recommendedChannel),
    email: Object.freeze({
      address: text(contact.email),
      evidence: text(contact.emailEvidence),
      status: contact.email && contact.emailEvidence ? 'Verified' : 'Missing',
    }),
    confidence: contact.confidence ?? 'Low',
    priorHistory: Object.freeze({ person: suppression.personHistory, company: suppression.companyHistory }),
    suppression,
  };
  return Object.freeze({ ...card, reviewDigest: reviewDigest(card) });
}

export function approveContactReview({ card, approval } = {}) {
  if (!card?.reviewDigest) throw new ContactReviewError('a contact review card is required', 'REVIEW_CARD_REQUIRED');
  if (approval?.approved !== true) throw new ContactReviewError('drafting requires explicit user approval', 'CONTACT_APPROVAL_REQUIRED');
  if (!text(approval.approvedBy)) throw new ContactReviewError('contact approval requires the approving user', 'CONTACT_APPROVER_REQUIRED');
  const approvedAt = iso(approval.approvedAt, 'CONTACT_APPROVAL_DATE_REQUIRED');
  if (personIdentity({ personId: approval.personId }) !== card.person.id) throw new ContactReviewError('approved person does not match the review card', 'APPROVED_PERSON_MISMATCH');
  if (text(approval.channel) !== card.recommendedChannel) throw new ContactReviewError('approved channel does not match the review card', 'APPROVED_CHANNEL_MISMATCH');
  if (approval.reviewDigest && approval.reviewDigest !== card.reviewDigest) throw new ContactReviewError('contact approval targets a different review card', 'REVIEW_DIGEST_MISMATCH');
  if (!card.suppression.allowed) throw new ContactReviewError('contact is inside a person or company suppression window', 'CONTACT_SUPPRESSED', card.suppression);
  return Object.freeze({
    approved: true,
    approvedBy: text(approval.approvedBy),
    approvedAt,
    personId: card.person.id,
    channel: card.recommendedChannel,
    reviewDigest: card.reviewDigest,
  });
}

export function assertContactApproval({ application, contact, channel, approval } = {}) {
  if (approval?.approved !== true) throw new ContactReviewError('drafting requires explicit user approval', 'CONTACT_APPROVAL_REQUIRED');
  if (!text(approval.approvedBy)) throw new ContactReviewError('contact approval requires the approving user', 'CONTACT_APPROVER_REQUIRED');
  iso(approval.approvedAt, 'CONTACT_APPROVAL_DATE_REQUIRED');
  if (personIdentity({ personId: approval.personId }) !== personIdentity(contact)) throw new ContactReviewError('approved person does not match the draft contact', 'APPROVED_PERSON_MISMATCH');
  if (text(approval.channel) !== text(channel)) throw new ContactReviewError('approved channel does not match the draft channel', 'APPROVED_CHANNEL_MISMATCH');
  if (!application?.id) throw new ContactReviewError('application is required for approved drafting', 'APPLICATION_REQUIRED');
  return true;
}
