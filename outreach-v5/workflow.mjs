import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildOutreachDraft, storeOutreachDraft } from './draft.mjs';
import { deriveOutreachState } from './cadence.mjs';
import { evidenceUrls } from './evidence.mjs';
import { observedReplyActivityKey } from './gmail.mjs';
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

function replyNotes({ outreach, application, binding, reply }) {
  return JSON.stringify({
    provider: 'gmail',
    observation: 'reply',
    gmailMessageId: reply.gmailMessageId,
    gmailThreadId: reply.gmailThreadId,
    outreachId: outreach.id,
    applicationId: application.id,
    duplicateKey: binding.duplicateKey,
    gmailDraftId: binding.gmailDraftId ?? null,
    bindingIdempotencyKey: binding.idempotencyKey ?? null,
  });
}

function replyStopsComplete(outreach, application) {
  return outreach?.response === 'Replied'
    && outreach?.outcome === 'Replied'
    && outreach?.nextEligibleContact == null
    && outreach?.draftState === 'Stopped'
    && application?.outreachState === 'Stopped'
    && application?.nextAction == null;
}

function journalRecoveryError(eventKey) {
  return new OutreachWorkflowError('reply activity journal entry requires explicit recovery before retry', 'JOURNAL_RECOVERY_REQUIRED', { eventKey });
}

function activityKeyOf(activity) {
  return activity?.idempotencyKey ?? activity?.['Idempotency Key'] ?? activity?.values?.idempotencyKey ?? null;
}

function mergeActivities(...groups) {
  const merged = [];
  const seen = new Set();
  for (const activity of groups.flatMap((group) => Array.isArray(group) ? group : [])) {
    const identity = activity?.id ?? activityKeyOf(activity) ?? `${activity?.eventType ?? ''}:${activity?.eventAt ?? ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(activity);
  }
  return merged;
}

/** Research and draft without any send-capable connector. */
export async function prepareOutreach({ applications = [], providers = {}, deepLimit = 6, now = () => Date.now(), attachmentExpected = false, allowPaid = false, selectContact } = {}) {
  const eligible = applications.filter((application) => application?.id && !terminal(application)).sort((a, b) => score(b) - score(a) || String(a.id).localeCompare(String(b.id)));
  const results = [];
  for (let index = 0; index < eligible.length; index += 1) {
    const application = eligible[index];
    const research = await researchContact({ application, providers, allowPaid, selectContact, now });
    if (!research.contact) {
      if (research.status === 'needs-selection') {
        results.push({ applicationId: application.id, depth: index < deepLimit ? 'deep' : 'light', status: 'needs-selection', research });
        continue;
      }
      results.push({ applicationId: application.id, depth: index < deepLimit ? 'deep' : 'light', status: 'no-contact', research });
      continue;
    }
    try {
      const draft = buildOutreachDraft({
        application,
        contact: research.contact,
        depth: index < deepLimit ? 'deep' : 'light',
        channel: research.contact.recommendedChannel,
        attachmentExpected: typeof attachmentExpected === 'function' ? Boolean(attachmentExpected(application, research.contact)) : Boolean(attachmentExpected),
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
    needsSelectionCount: results.filter((result) => result.status === 'needs-selection').length,
    results,
  };
}

/** Prepare local LinkedIn and published-site email drafts for selected employers. */
export async function prepareEmployerOutreach({ targets = [], providers = {}, now = () => Date.now(), selectContact } = {}) {
  const eligible = targets.filter((target) => target?.id && (target.shortlisted === true || target.watched === true));
  const results = [];
  for (const target of eligible) {
    const research = await researchContact({ application: target, providers, sourceOrder: ['companyTeamPages', 'hiringAuthors', 'publicProfiles'], selectContact, now });
    const result = { targetId: target.id, status: research.contact ? 'draft-ready' : research.status, research, drafts: [] };
    if (research.contact) {
      const contact = research.contact;
      if (contact.contactUrl) {
        try {
          result.drafts.push(buildOutreachDraft({ application: target, contact, channel: 'LinkedIn' }));
        } catch (error) {
          result.linkedinError = { code: error.code ?? 'DRAFT_FAILED', message: error.message };
        }
      }
      if (contact.source === 'companyTeamPages' && contact.email && contact.emailEvidence) {
        try {
          result.drafts.push(buildOutreachDraft({ application: target, contact, channel: 'Public Email' }));
        } catch (error) {
          result.emailError = { code: error.code ?? 'DRAFT_FAILED', message: error.message };
        }
      } else {
        result.emailStatus = 'not-published-site-evidence';
      }
      if (result.drafts.length === 0) result.status = 'no-channel';
    }
    results.push(result);
  }
  return { status: results.some((result) => result.status === 'draft-ready') ? 'ready' : 'empty', results };
}

/** Save prepared employer messages as idempotent local JSON drafts. */
export async function persistEmployerOutreachDrafts({ prepared, directory } = {}) {
  if (!directory) throw new OutreachWorkflowError('a local draft directory is required', 'DRAFT_DIRECTORY_REQUIRED');
  const files = [];
  await mkdir(directory, { recursive: true });
  for (const result of prepared?.results ?? []) {
    for (const draft of result.drafts ?? []) {
      const channel = draft.channel === 'Public Email' ? 'public-email' : 'linkedin';
      const file = path.join(directory, `${draft.duplicateKey}-${channel}.json`);
      try {
        await writeFile(file, `${JSON.stringify(draft, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        files.push(file);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        files.push(file);
      }
    }
  }
  return { status: 'stored', files };
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
  const suppliedActivities = mergeActivities(activities, outreach.activities);
  const before = deriveOutreachState({ application, sequence: outreach, activities: suppliedActivities, now });
  if (before.stopReason || before.state === 'Closed') throw new OutreachWorkflowError(`outreach sequence is stopped: ${before.stopReason ?? 'Cadence Closed'}`, 'OUTREACH_STOPPED');
  const eventType = stage === 'Initial' ? 'Initial Sent' : stage === 'Follow-up 1' ? 'Follow-up 1 Sent' : stage === 'Follow-up 2' ? 'Follow-up 2 Sent' : null;
  if (!eventType) throw new OutreachWorkflowError(`unsupported manual contact stage: ${stage}`, 'STAGE_INVALID');
  const sentAt = confirmation.sentAt ? nowIso(confirmation.sentAt) : nowIso(now);
  const eventKey = outreachActivityKey({ duplicateKey: outreach.duplicateKey, eventType });
  let existing = suppliedActivities.filter((activity) => activityKeyOf(activity) === eventKey);
  if (typeof gateway.listRows === 'function') {
    existing = mergeActivities(existing, await gateway.listRows('activity', { filter: activityFilter(eventKey) }));
  }
  if (existing?.length) return { status: 'noop', outreachId: outreach.id, applicationId: application.id, eventKey, activityId: existing[0].id ?? null };

  const priorKeys = stage === 'Follow-up 1'
    ? [outreachActivityKey({ duplicateKey: outreach.duplicateKey, eventType: 'Initial Sent' })]
    : stage === 'Follow-up 2'
      ? [
        outreachActivityKey({ duplicateKey: outreach.duplicateKey, eventType: 'Initial Sent' }),
        outreachActivityKey({ duplicateKey: outreach.duplicateKey, eventType: 'Follow-up 1 Sent' }),
      ]
      : [];
  for (const priorKey of priorKeys) {
    const suppliedPrior = suppliedActivities.filter((activity) => activityKeyOf(activity) === priorKey);
    let observedPrior = suppliedPrior;
    if (typeof gateway.listRows === 'function') {
      observedPrior = mergeActivities(observedPrior, await gateway.listRows('activity', { filter: activityFilter(priorKey) }));
    }
    if (!observedPrior.length && stage === 'Follow-up 2') {
      throw new OutreachWorkflowError('Follow-up 2 requires Follow-up 1 activity evidence', 'STAGE_ORDER_INVALID');
    }
    if (!observedPrior.length && stage === 'Follow-up 1' && !(outreach.sent === true && (outreach.initialSentAt || outreach.sentAt))) {
      throw new OutreachWorkflowError('Follow-up 1 requires initial-send evidence', 'STAGE_ORDER_INVALID');
    }
    suppliedActivities.push(...observedPrior);
  }

  const initialActivity = suppliedActivities.find((activity) => activityKeyOf(activity) === outreachActivityKey({ duplicateKey: outreach.duplicateKey, eventType: 'Initial Sent' }));
  const initialSentAt = stage === 'Initial'
    ? sentAt
    : initialActivity?.eventAt ?? initialActivity?.['Event At'] ?? initialActivity?.values?.eventAt ?? outreach.initialSentAt ?? outreach.sentAt;
  if (!initialSentAt) throw new OutreachWorkflowError('follow-up confirmation requires the initial sent date', 'INITIAL_SENT_DATE_REQUIRED');
  const dueOffset = stage === 'Initial' ? 3 : stage === 'Follow-up 1' ? 10 : 17;
  const nextEligibleContact = addDays(initialSentAt, dueOffset);
  const outreachUpdate = stage === 'Initial'
    ? { sent: true, sentAt, nextEligibleContact, draftState: 'Sent' }
    : { sent: true, nextEligibleContact, draftState: 'Sent' };
  await gateway.updatePage('outreach', outreach.id, outreachUpdate);
  const activity = await gateway.createPage('activity', {
    name: `${eventType} — ${outreach.person}`,
    application: [application.id],
    outreach: [outreach.id],
    eventType,
    eventAt: sentAt,
    dueAt: stage === 'Follow-up 2' ? addDays(initialSentAt, 17) : nextEligibleContact,
    idempotencyKey: eventKey,
    actionState: 'Confirmed',
    notes: `Manual confirmation: ${confirmation.confirmedBy ?? confirmation.source ?? confirmation.note}`,
  });
  const sequence = { ...outreach, sent: true, sentAt: initialSentAt };
  const activityHistory = mergeActivities(suppliedActivities, existing, [{ eventType, eventAt: sentAt, outreachId: outreach.id, idempotencyKey: eventKey }]);
  const derived = deriveOutreachState({ application, sequence, activities: activityHistory, now });
  if (typeof gateway.updatePage === 'function') {
    await gateway.updatePage('applications', application.id, { outreachState: derived.state, nextAction: derived.nextAction });
  }
  return { status: 'confirmed', outreachId: outreach.id, applicationId: application.id, eventKey, activityId: pageId(activity), sentAt, nextEligibleContact, derived, evidenceUrls: evidenceUrls({ publicEvidence: outreach.publicEvidence ?? [] }) };
}

/** Apply one exact, read-only provider reply observation to the matching v5 sequence. */
export async function recordObservedReply({ gateway, outreach, application, binding, reply, activities = [], journal = null } = {}) {
  if (!gateway || typeof gateway.updatePage !== 'function' || typeof gateway.createPage !== 'function') throw new OutreachWorkflowError('an injected gateway with updatePage and createPage is required', 'GATEWAY_REQUIRED');
  if (!outreach?.id || !outreach.duplicateKey) throw new OutreachWorkflowError('outreach page and duplicate key are required', 'OUTREACH_REQUIRED');
  if (!application?.id) throw new OutreachWorkflowError('application id is required', 'APPLICATION_ID_REQUIRED');
  if (!binding?.outreachId || binding.outreachId !== outreach.id) throw new OutreachWorkflowError('reply binding does not match the Outreach row', 'REPLY_OUTREACH_MISMATCH');
  if (!binding.applicationId || binding.applicationId !== application.id || outreach.applicationId && outreach.applicationId !== application.id) throw new OutreachWorkflowError('reply binding does not match the Application row', 'REPLY_APPLICATION_MISMATCH');
  if (binding.duplicateKey !== outreach.duplicateKey || reply?.outreachId !== binding.outreachId || reply?.duplicateKey !== binding.duplicateKey) throw new OutreachWorkflowError('reply identity does not match the exact Outreach binding', 'REPLY_IDENTITY_MISMATCH');
  if (reply?.gmailThreadId !== binding.gmailThreadId || !reply.gmailMessageId || !reply.observedAt) throw new OutreachWorkflowError('reply must carry the exact Gmail message/thread binding and observed timestamp', 'REPLY_BINDING_REQUIRED');
  const eventKey = observedReplyActivityKey({ duplicateKey: binding.duplicateKey, gmailMessageId: reply.gmailMessageId });
  let existing = mergeActivities(activities, outreach.activities);
  if (typeof gateway.listRows === 'function') existing = mergeActivities(existing, await gateway.listRows('activity', { filter: activityFilter(eventKey) }));
  const existingActivity = existing.find((activity) => activityKeyOf(activity) === eventKey) ?? null;
  const durableJournal = gateway.live === true ? (journal ?? gateway.journal ?? gateway.activeJournal ?? null) : null;
  const previousJournal = gateway.activeJournal;
  const previousTransactionKey = gateway.activeTransactionKey;
  let activeJournalBound = false;
  let reservedByThisCall = false;
  let activity = existingActivity;

  try {
    if (durableJournal) {
      const reservation = await durableJournal.reserve([{ key: eventKey, target: 'activity' }]);
      if (reservation.pendingKeys?.includes(eventKey) || reservation.verifiedKeys?.includes(eventKey)) throw journalRecoveryError(eventKey);
      if (reservation.committedKeys?.includes(eventKey)) {
        return { status: 'noop', outreachId: outreach.id, applicationId: application.id, eventKey, activityId: pageId(existingActivity) ?? durableJournal.get(eventKey)?.pageId ?? null };
      }
      reservedByThisCall = reservation.reserved?.includes(eventKey) === true;
      gateway.activeJournal = durableJournal;
      gateway.activeTransactionKey = eventKey;
      activeJournalBound = true;
      if (activity) durableJournal.recordTarget(eventKey, activity);
    } else if (activity && replyStopsComplete(outreach, application)) {
      return { status: 'noop', outreachId: outreach.id, applicationId: application.id, eventKey, activityId: pageId(activity) };
    }

    if (!activity) {
      activity = await gateway.createPage('activity', {
        name: `Gmail reply — ${outreach.person}`,
        application: [application.id],
        outreach: [outreach.id],
        eventType: 'Reply Observed',
        eventAt: reply.observedAt,
        idempotencyKey: eventKey,
        actionState: 'Observed',
        notes: replyNotes({ outreach, application, binding, reply }),
      });
      if (durableJournal) durableJournal.recordTarget(eventKey, activity);
    }

    const needsStopUpdates = !replyStopsComplete(outreach, application);
    if (needsStopUpdates) {
      await gateway.updatePage('outreach', outreach.id, { response: 'Replied', outcome: 'Replied', nextEligibleContact: null, draftState: 'Stopped' });
      await gateway.updatePage('applications', application.id, { outreachState: 'Stopped', nextAction: null });
    }
    if (durableJournal) {
      durableJournal.markVerified(eventKey);
      durableJournal.markCommitted(eventKey);
    }
    return { status: existingActivity ? (needsStopUpdates ? 'recovered' : 'noop') : 'observed', outreachId: outreach.id, applicationId: application.id, eventKey, activityId: pageId(activity), observedAt: reply.observedAt };
  } catch (error) {
    if (durableJournal && reservedByThisCall && ['pending', 'verified'].includes(durableJournal.get(eventKey)?.state)) {
      try { durableJournal.markAborted(eventKey, error); } catch { /* preserve the original failure */ }
    }
    throw error;
  } finally {
    if (activeJournalBound) {
      gateway.activeJournal = previousJournal;
      gateway.activeTransactionKey = previousTransactionKey;
    }
  }
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
    outreach: [outreach.id],
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
  const derived = ordered.map((sequence) => deriveOutreachState({ application, sequence, activities: activities.filter((activity) => !sequence.id || activity.outreachId === sequence.id || (Array.isArray(activity.outreach) && activity.outreach.includes(sequence.id)) || activity.duplicateKey === sequence.duplicateKey), now }));
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
