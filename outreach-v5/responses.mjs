import { normalizeActivityPage, normalizeApplicationPage, normalizeOutreachPage } from './notion-normalizers.mjs';
import { recordOutreachOutcome } from './workflow.mjs';

const POSITIVE_RESPONSES = new Set(['replied', 'interested', 'interview', 'interviewing', 'referral offered', 'referred']);
const NEGATIVE_RESPONSES = new Set(['no', 'not interested', 'rejected', 'opt out', 'opted out', 'closed', 'withdrawn']);
const NON_RESPONSES = new Set(['', 'pending', 'no response', 'no reply', 'awaiting reply']);

function normalized(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' ');
}

function responseClass(sequence) {
  const response = normalized(sequence.response ?? sequence.outcome);
  if (NON_RESPONSES.has(response)) return 'awaiting';
  if (POSITIVE_RESPONSES.has(response)) return 'positive';
  if (NEGATIVE_RESPONSES.has(response)) return 'negative';
  return 'review';
}

function attachApplication(sequence, applications) {
  return Object.freeze({ ...sequence, application: applications.get(sequence.applicationId) ?? null });
}

export function buildResponseOperationalViews({ outreach = [], applications = [], activity = [] } = {}) {
  const normalizedApplications = applications.map(normalizeApplicationPage);
  const applicationIndex = new Map(normalizedApplications.map((application) => [application.id, application]));
  const sequences = outreach.map(normalizeOutreachPage).map((sequence) => attachApplication(sequence, applicationIndex));
  const activities = activity.map(normalizeActivityPage);
  const replied = sequences.filter((sequence) => !NON_RESPONSES.has(normalized(sequence.response ?? sequence.outcome)));
  const positive = replied.filter((sequence) => responseClass(sequence) === 'positive');
  const negative = replied.filter((sequence) => responseClass(sequence) === 'negative');
  const reviewNeeded = replied.filter((sequence) => responseClass(sequence) === 'review');
  const stopped = sequences.filter((sequence) => ['Stopped', 'Closed'].includes(sequence.draftState) || responseClass(sequence) !== 'awaiting');
  const awaiting = sequences.filter((sequence) => responseClass(sequence) === 'awaiting' && !['Stopped', 'Closed'].includes(sequence.draftState));
  return Object.freeze({
    replied,
    positive,
    negative,
    reviewNeeded,
    stopped,
    awaiting,
    responseActivity: activities.filter((entry) => entry.eventType === 'Response'),
  });
}

export async function reconcileObservedResponse({
  gateway,
  rawOutreach,
  rawApplication,
  rawActivities = [],
  response = null,
  outcome = null,
  confirmation,
  now = () => Date.now(),
} = {}) {
  const outreach = normalizeOutreachPage(rawOutreach);
  const application = normalizeApplicationPage(rawApplication);
  const activities = rawActivities.map(normalizeActivityPage).filter((entry) => entry.outreachKey === outreach.duplicateKey);
  const observedResponse = response ?? outreach.response ?? outreach.outcome;
  const result = await recordOutreachOutcome({
    gateway,
    outreach,
    application,
    response: observedResponse,
    outcome,
    confirmation,
    now,
  });
  return Object.freeze({
    ...result,
    source: 'manual-raw-notion-reconciliation',
    outreach,
    application,
    priorSequenceActivity: activities,
  });
}
