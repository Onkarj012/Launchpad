export const APPLIED_EVENT = 'Applied';
export const CONFIRMED_OUTCOMES = Object.freeze(['Interviewing', 'Offer', 'Rejected', 'Withdrawn', 'Not Pursuing', 'Closed/Expired']);

export function applicationEventKey(applicationId, eventType = APPLIED_EVENT) {
  if (!applicationId) throw new Error('application id is required for an idempotency key');
  return `launchpad-v5:application:${applicationId}:${String(eventType).trim().toLocaleLowerCase('en-US')}`;
}

export function eventKeyFor(application, eventType = APPLIED_EVENT) {
  return applicationEventKey(application?.id, eventType);
}

export function isConfirmedEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || evidence.confirmed !== true) return false;
  return Boolean(evidence.source || evidence.url || evidence.connector || evidence.recordId);
}

export function assertConfirmedOutcome(outcome, evidence) {
  if (!CONFIRMED_OUTCOMES.includes(outcome)) throw new Error(`unsupported or unconfirmed lifecycle outcome: ${outcome}`);
  if (!isConfirmedEvidence(evidence)) throw new Error(`lifecycle outcome ${outcome} requires user-confirmed or connector-backed evidence`);
  return true;
}

