const NORMALIZE_RE = /[^\p{L}\p{N}]+/gu;

export const OUTREACH_CHANNELS = Object.freeze(['Email', 'LinkedIn', 'Public Email', 'Referral']);
export const OUTREACH_EVENTS = Object.freeze(['Initial Sent', 'Follow-up 1 Sent', 'Follow-up 2 Sent']);

export class OutreachIdentityError extends Error {
  constructor(message, code = 'OUTREACH_IDENTITY_INVALID') {
    super(message);
    this.name = 'OutreachIdentityError';
    this.code = code;
  }
}

export function normalizeIdentity(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(NORMALIZE_RE, ' ')
    .trim()
    .replaceAll(' ', '-');
}

function firstValue(...values) {
  return values.find((value) => value != null && String(value).trim()) ?? null;
}

export function personIdentity(person = {}) {
  const value = typeof person === 'string'
    ? person
    : firstValue(person.personId, person.id, person.linkedinUrl, person.profileUrl, person.contactUrl, person.email, person.name, person.Person);
  const normalized = normalizeIdentity(value);
  if (!normalized) throw new OutreachIdentityError('person identity is required', 'PERSON_IDENTITY_REQUIRED');
  return normalized;
}

export function channelIdentity(channel) {
  const normalized = normalizeIdentity(channel);
  if (!normalized) throw new OutreachIdentityError('contact channel is required', 'CHANNEL_REQUIRED');
  return normalized;
}

/** One stable identity for application x person x channel. */
export function outreachDuplicateKey({ applicationId, person, personId, channel } = {}) {
  const application = normalizeIdentity(applicationId);
  if (!application) throw new OutreachIdentityError('application id is required', 'APPLICATION_ID_REQUIRED');
  return `launchpad-v5:outreach:${application}:${personIdentity(person ?? { personId })}:${channelIdentity(channel)}`;
}

export const outreachIdentityKey = outreachDuplicateKey;
export const duplicateKeyFor = outreachDuplicateKey;

export function outreachActivityKey({ duplicateKey, eventType } = {}) {
  const duplicate = normalizeIdentity(duplicateKey);
  const event = normalizeIdentity(eventType);
  if (!duplicate) throw new OutreachIdentityError('outreach duplicate key is required', 'DUPLICATE_KEY_REQUIRED');
  if (!event) throw new OutreachIdentityError('outreach event type is required', 'EVENT_TYPE_REQUIRED');
  return `launchpad-v5:outreach-event:${duplicate}:${event}`;
}

export function assertManualSendConfirmation(confirmation = {}) {
  if (confirmation.confirmed !== true) {
    throw new OutreachIdentityError('sending state requires explicit user confirmation', 'MANUAL_CONFIRMATION_REQUIRED');
  }
  const evidence = firstValue(confirmation.confirmedBy, confirmation.source, confirmation.note, confirmation.recordId);
  if (!evidence) {
    throw new OutreachIdentityError('manual send confirmation requires user evidence', 'MANUAL_CONFIRMATION_EVIDENCE_REQUIRED');
  }
  return true;
}

export function assertManualOutcomeConfirmation(confirmation = {}) {
  if (confirmation.confirmed !== true) {
    throw new OutreachIdentityError('outreach outcome requires explicit user confirmation', 'MANUAL_OUTCOME_CONFIRMATION_REQUIRED');
  }
  const evidence = firstValue(confirmation.confirmedBy, confirmation.source, confirmation.note, confirmation.recordId);
  if (!evidence) {
    throw new OutreachIdentityError('outreach outcome confirmation requires user evidence', 'MANUAL_OUTCOME_EVIDENCE_REQUIRED');
  }
  return true;
}

export function isOutreachEventType(eventType) {
  return OUTREACH_EVENTS.includes(eventType);
}
