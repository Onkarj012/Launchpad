import { buildOutreachDraft, storeOutreachDraft } from './draft.mjs';
import { deriveOutreachState } from './cadence.mjs';
import { evidenceUrls } from './evidence.mjs';
import { assertManualOutcomeConfirmation, assertManualSendConfirmation, outreachActivityKey } from './idempotency.mjs';
import { researchContact } from './research.mjs';

export class OutreachWorkflowError extends Error {
  constructor(message, code = 'OUTREACH_WORKFLOW_ERROR', details = null) {
    super(message);
    this.name = 'OutreachWorkflowError';
    this.code = code;
    this.details = details;
  }
}

function score(application) {
  return Number(application.conversionScore ?? application.matchScore ?? application.score ?? 0) || 0;
}

function terminal(application) {
  return ['Rejected', 'Withdrawn', 'Not Pursuing', 'Closed/Expired', 'Offer'].includes(application.status);
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new OutreachWorkflowError('outreach clock is invalid', 'CLOCK_INVALID');
  return date.toISOString();
}

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function activityFilter(key) {
  return { property: 'Idempotency Key', rich_text: { equals: key } };
}

function pageId(page) { return page?.id ?? page?.pageId ?? null; }

function approvedContact(research, approval) {
  if (approval?.approved !== true) return null;
  const candidate = research.candidates.find(({ contact }) => {
    const personMatches = String(approval.personId ?? '').trim() === String(contact.personId);
    const channelMatches = String(approval.channel ?? '').trim() === String(contact.recommendedChannel);
    return personMatches && channelMatches;
  });
  return candidate?.contact ?? null;
}

/** Research and draft without any send-capable connector. */
export async function prepareOutreach({ applications = [], providers = {}, deepLimit = 6, now = () => Date.now(), attachmentExpected = false, allowPaid = false, paidApproval = null, contactApprovals = {} } = {}) {
  const eligible = applications.filter((application) => application?.id && !terminal(application)).sort((a, b) => score(b) - score(a) || String(a.id).localeCompare(String(b.id)));
  const results = [];
  for (let index = 0; index < eligible.length; index += 1) {
    const application = eligible[index];
    const research = await researchContact({ application, providers, allowPaid, paidApproval, runId: application.runId, now });
    if (!research.recommendedCandidate) {
      results.push({ applicationId: application.id, depth: index < deepLimit ? 'deep' : 'light', status: 'no-contact', research });
      continue;
    }
    const approval = contactApprovals[application.id] ?? null;
    const contact = approvedContact(research, approval);
    if (!contact) {
      results.push({ applicationId: application.id, depth: index < deepLimit ? 'deep' : 'light', status: 'contact-review-required', research });
      continue;
    }
    try {
      const draft = buildOutreachDraft({
        application,
        contact,
        depth: index < deepLimit ? 'deep' : 'light',
        channel: contact.recommendedChannel,
        attachmentExpected: typeof attachmentExpected === 'function' ? Boolean(attachmentExpected(application, contact)) : Boolean(attachmentExpected),
        resumeArtifact: application.resumeArtifact ?? null,
      });
      results.push({ applicationId: application.id, depth: draft.depth, status: 'draft-ready', research, draft });
    } catch (error) {
      results.push({ applicationId: application.id, depth: index < deepLimit ? 'deep' : 'light', status: 'draft-blocked', research, error: { code: error.code ?? 'DRAFT_FAILED', message: error.message } });
    }
  }
  return {
    status: results.some((result) => result.status === 'draft-blocked') ? 'partial' : 'ready',
    deepCount: results.filter((result) => result.depth === 'deep' && result.status === 'draft-ready').length,
    lightCount: results.filter((result) => result.depth === 'light' && result.status === 'draft-ready').length,
    results,
  };
}

export async function persistOutreach({ gateway, prepared } = {}) {
  if (!gateway) throw new OutreachWorkflowError('an injected v5 gateway is required', 'GATEWAY_REQUIRED');
  const results = [];
  for (const result of prepared?.results ?? []) {
    if (result.status !== 'draft-ready') {
      results.push(result);
      continue;
    }
    try {
      results.push({ ...result, persistence: await storeOutreachDraft({ gateway, draft: result.draft }) });
    } catch (error) {
      results.push({ ...result, status: 'persist-failed', error: { code: error.code ?? 'DRAFT_PERSIST_FAILED', message: error.message } });
    }
  }
  const failed = results.filter((result) => ['draft-blocked', 'persist-failed'].includes(result.status));
  return { status: failed.length ? (failed.length === results.length && results.length ? 'failed' : 'partial') : 'stored', results };
}

/**
 * Change Sent? only after explicit user confirmation. There is intentionally no
 * send provider in this module or anywhere in the outreach-v5 path.
 */
export async function confirmManualSend({ gateway, outreach, application, confirmation, stage = 'Initial', activities = [], now = () => Date.now() } = {}) {
  assertManualSendConfirmation(confirmation);
  if (!gateway || typeof gateway.updatePage !== 'function' || typeof gateway.createPage !== 'function') throw new OutreachWorkflowError('an injected gateway with updatePage and createPage is required', 'GATEWAY_REQUIRED');
  if (!outreach?.id || !outreach.duplicateKey) throw new OutreachWorkflowError('outreach page and duplicate key are required', 'OUTREACH_REQUIRED');
  if (!application?.id) throw new OutreachWorkflowError('application id is required', 'APPLICATION_ID_REQUIRED');
  const before = deriveOutreachState({ application, sequence: outreach, activities: [...activities, ...(outreach.activities ?? [])], now });
  if (before.stopReason || before.state === 'Closed') throw new OutreachWorkflowError(`outreach sequence is stopped: ${before.stopReason ?? 'Cadence Closed'}`, 'OUTREACH_STOPPED');
  const eventType = stage === 'Initial' ? 'Initial Sent' : stage === 'Follow-up 1' ? 'Follow-up 1 Sent' : stage === 'Follow-up 2' ? 'Follow-up 2 Sent' : null;
  if (!eventType) throw new OutreachWorkflowError(`unsupported manual contact stage: ${stage}`, 'STAGE_INVALID');
  const sentAt = confirmation.sentAt ? nowIso(confirmation.sentAt) : nowIso(now);
  const initialSentAt = stage === 'Initial' ? sentAt : outreach.initialSentAt ?? outreach.sentAt;
  if (!initialSentAt) throw new OutreachWorkflowError('follow-up confirmation requires the initial sent date', 'INITIAL_SENT_DATE_REQUIRED');
  const dueOffset = stage === 'Initial' ? 3 : stage === 'Follow-up 1' ? 10 : 17;
  const eventKey = outreachActivityKey({ duplicateKey: outreach.duplicateKey, eventType });
  let existing = [];
  if (typeof gateway.listRows === 'function') existing = await gateway.listRows('activity', { filter: activityFilter(eventKey) });
  if (existing?.length) return { status: 'noop', outreachId: outreach.id, applicationId: application.id, eventKey, activityId: existing[0].id ?? null };

  const nextEligibleContact = addDays(initialSentAt, dueOffset);
  await gateway.updatePage('outreach', outreach.id, { sent: true, sentAt, nextEligibleContact, draftState: 'Sent' });
  const activity = await gateway.createPage('activity', {
    name: `${eventType} — ${outreach.person}`,
    application: [application.id],
    eventType,
    eventAt: sentAt,
    dueAt: stage === 'Follow-up 2' ? addDays(initialSentAt, 17) : nextEligibleContact,
    idempotencyKey: eventKey,
    actionState: 'Confirmed',
    notes: `Manual confirmation: ${confirmation.confirmedBy ?? confirmation.source ?? confirmation.note}`,
  });
  const sequence = { ...outreach, sent: true, sentAt: initialSentAt };
  const activityHistory = [...(existing ?? []), { eventType, eventAt: sentAt }];
  const derived = deriveOutreachState({ application, sequence, activities: activityHistory, now });
  if (typeof gateway.updatePage === 'function') {
    await gateway.updatePage('applications', application.id, { outreachState: derived.state, nextAction: derived.nextAction });
  }
  return { status: 'confirmed', outreachId: outreach.id, applicationId: application.id, eventKey, activityId: pageId(activity), sentAt, nextEligibleContact, derived, evidenceUrls: evidenceUrls({ publicEvidence: outreach.publicEvidence ?? [] }) };
}

export async function recordOutreachOutcome({ gateway, outreach, application, response, outcome = null, confirmation, now = () => Date.now() } = {}) {
  assertManualOutcomeConfirmation(confirmation);
  if (!gateway || typeof gateway.updatePage !== 'function' || typeof gateway.createPage !== 'function') throw new OutreachWorkflowError('an injected gateway with updatePage and createPage is required', 'GATEWAY_REQUIRED');
  if (!outreach?.id || !outreach.duplicateKey) throw new OutreachWorkflowError('outreach page and duplicate key are required', 'OUTREACH_REQUIRED');
  if (!application?.id) throw new OutreachWorkflowError('application id is required', 'APPLICATION_ID_REQUIRED');
  const normalizedResponse = String(response ?? outcome ?? '').trim();
  if (!normalizedResponse) throw new OutreachWorkflowError('a response or outcome is required', 'OUTCOME_REQUIRED');
  const eventKey = outreachActivityKey({ duplicateKey: outreach.duplicateKey, eventType: `Response ${normalizedResponse}` });
  const existing = typeof gateway.listRows === 'function' ? await gateway.listRows('activity', { filter: activityFilter(eventKey) }) : [];
  if (existing?.length) return { status: 'noop', outreachId: outreach.id, applicationId: application.id, eventKey, activityId: existing[0].id ?? null };
  const observedAt = confirmation.observedAt ? nowIso(confirmation.observedAt) : nowIso(now);
  await gateway.updatePage('outreach', outreach.id, { response: normalizedResponse, outcome: outcome ?? normalizedResponse, nextEligibleContact: null, draftState: 'Stopped' });
  const activity = await gateway.createPage('activity', {
    name: `Outreach response — ${outreach.person}`,
    application: [application.id],
    eventType: 'Response',
    eventAt: observedAt,
    idempotencyKey: eventKey,
    actionState: 'Confirmed',
    notes: `${normalizedResponse}. Confirmed by ${confirmation.confirmedBy ?? confirmation.source ?? confirmation.note}`,
  });
  await gateway.updatePage('applications', application.id, { outreachState: 'Stopped', nextAction: null });
  return { status: 'confirmed', outreachId: outreach.id, applicationId: application.id, eventKey, activityId: pageId(activity), observedAt };
}

export function deriveApplicationOutreachState({ application, sequences = [], activities = [], now = () => Date.now() } = {}) {
  if (!sequences.length) return { state: 'None', nextAction: null, nextEligibleContact: null, due: false };
  const ordered = [...sequences].sort((a, b) => String(a.duplicateKey ?? a.id).localeCompare(String(b.duplicateKey ?? b.id)));
  const derived = ordered.map((sequence) => deriveOutreachState({ application, sequence, activities: activities.filter((activity) => !sequence.id || activity.outreachId === sequence.id || activity.duplicateKey === sequence.duplicateKey), now }));
  const active = derived.find((state) => state.state !== 'Stopped') ?? derived[0];
  return active;
}

export async function syncDerivedOutreachState({ gateway, application, sequences = [], activities = [], now = () => Date.now() } = {}) {
  if (!gateway || typeof gateway.updatePage !== 'function') throw new OutreachWorkflowError('an injected gateway with updatePage is required', 'GATEWAY_REQUIRED');
  if (!application?.id) throw new OutreachWorkflowError('application id is required', 'APPLICATION_ID_REQUIRED');
  const derived = deriveApplicationOutreachState({ application, sequences, activities, now });
  await gateway.updatePage('applications', application.id, { outreachState: derived.state === 'None' ? null : derived.state, nextAction: derived.nextAction });
  return { status: 'synced', applicationId: application.id, derived };
}
