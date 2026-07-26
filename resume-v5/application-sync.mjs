import { V5_SCHEMA } from '../notion-v5/schema.mjs';
import { readAppliedQueue, assertV5ApplicationsGateway } from './queue-reader.mjs';
import { assertConfirmedOutcome, eventKeyFor } from './idempotency.mjs';

export const ALLOWED_STATUS_TRANSITIONS = Object.freeze({
  Ready: Object.freeze(['Applied', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn', 'Not Pursuing', 'Closed/Expired']),
  Applied: Object.freeze(['Interviewing', 'Offer', 'Rejected', 'Withdrawn', 'Not Pursuing', 'Closed/Expired']),
  Interviewing: Object.freeze(['Offer', 'Rejected', 'Withdrawn', 'Closed/Expired']),
  Offer: Object.freeze(['Rejected', 'Withdrawn', 'Closed/Expired']),
  Rejected: Object.freeze([]),
  Withdrawn: Object.freeze([]),
  'Not Pursuing': Object.freeze([]),
  'Closed/Expired': Object.freeze([]),
});

export class ApplicationSyncError extends Error {
  constructor(message, code = 'APPLICATION_SYNC_FAILED', details = null) {
    super(message);
    this.name = 'ApplicationSyncError';
    this.code = code;
    this.details = details;
  }
}

function validDate(value) {
  return typeof value === 'string' && value.trim() && !Number.isNaN(Date.parse(value));
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('sync clock is invalid');
  return date.toISOString();
}

function activityFilter(key) {
  return { property: V5_SCHEMA.stores.activity.properties.idempotencyKey.name, rich_text: { equals: key } };
}

async function existingActivity(gateway, key) {
  if (typeof gateway.listRows !== 'function') throw new Error('v5 sync requires gateway.listRows');
  const rows = await gateway.listRows('activity', { filter: activityFilter(key) });
  if (!Array.isArray(rows)) throw new Error('activity idempotency query returned a non-array result');
  return rows.find((row) => row?.id) ?? null;
}

function transitionFor(current, requested) {
  if (current === requested) return { status: 'unchanged', from: current, to: requested, applied: false };
  const allowed = current == null || current === 'Discovered'
    ? ['Applied', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn', 'Not Pursuing', 'Closed/Expired']
    : ALLOWED_STATUS_TRANSITIONS[current];
  if (!allowed) throw new ApplicationSyncError(`unknown application status: ${current}`, 'STATUS_INVALID', { current, requested });
  if (!allowed.includes(requested)) return { status: 'preserved', from: current, to: current, requested, applied: false };
  return { status: 'advanced', from: current, to: requested, applied: true };
}

function applicationUpdate(application, requestedStatus, observedAt, { stampApplied = false } = {}) {
  const transition = transitionFor(application.status, requestedStatus);
  const values = {};
  if (transition.applied) values.status = requestedStatus;
  if (stampApplied && !validDate(application.appliedAt)) values.appliedAt = observedAt;
  return { values, transition };
}

async function inTransaction(gateway, key, work) {
  if (typeof gateway.runTransaction !== 'function') {
    if (gateway.live) throw new ApplicationSyncError('live lifecycle sync requires gateway.runTransaction', 'TRANSACTION_REQUIRED');
    return { status: 'committed', skipped: false, result: await work({ checkpoint: async () => {} }) };
  }
  return gateway.runTransaction({ key: `lifecycle:${key}`, target: 'application-lifecycle', work });
}

async function ensureLifecycle(gateway, application, {
  eventType,
  observedAt,
  suppression,
  stampApplied = false,
  notes,
} = {}) {
  const key = eventKeyFor(application, eventType);
  const { values: update, transition } = applicationUpdate(application, eventType, observedAt, { stampApplied });
  if (typeof gateway.runTransaction !== 'function' && application.syncKey === key && await existingActivity(gateway, key)) {
    return {
      applicationId: application.id,
      status: 'noop',
      observedAt,
      idempotencyKey: key,
      applicationUpdated: false,
      activityCreated: false,
      suppression: { status: 'already' },
      transition,
      transaction: { key: null, recovered: false, skipped: true },
    };
  }
  const transaction = await inTransaction(gateway, key, async ({ checkpoint }) => {
    let applicationUpdated = false;
    let activityCreated = false;
    if (Object.keys(update).length) {
      if (typeof gateway.updatePage !== 'function') throw new ApplicationSyncError('v5 sync requires gateway.updatePage', 'GATEWAY_UPDATE_REQUIRED');
      await gateway.updatePage('applications', application.id, update);
      applicationUpdated = true;
    }
    await checkpoint({ application: 'complete', transition });

    let activity = await existingActivity(gateway, key);
    if (!activity) {
      if (typeof gateway.createPage !== 'function') throw new ApplicationSyncError('v5 sync requires gateway.createPage', 'GATEWAY_CREATE_REQUIRED');
      activity = await gateway.createPage('activity', {
        name: `${eventType} — ${application.role ?? 'Role'} at ${application.companyName ?? application.company ?? 'Company'}`,
        application: [application.id],
        eventType,
        eventAt: observedAt,
        idempotencyKey: key,
        actionState: 'Confirmed',
        notes,
      });
      activityCreated = true;
    }
    await checkpoint({ activity: 'complete', activityId: activity?.id ?? null });

    const ledgerOutcome = eventType === 'Applied' && transition.status === 'preserved'
      ? application.status
      : eventType;
    const suppressionResult = suppression?.ensureSuppressed
      ? await suppression.ensureSuppressed(application, { now: observedAt, outcome: ledgerOutcome })
      : { status: 'not-configured', outcome: ledgerOutcome };
    if (suppressionResult.status === 'conflict') throw new ApplicationSyncError('existing suppression state conflicts with lifecycle synchronization', 'SUPPRESSION_CONFLICT');
    if (suppressionResult.status === 'not-found') throw new ApplicationSyncError('application opportunity ledger row was not found', 'SUPPRESSION_NOT_FOUND');
    await checkpoint({ suppression: 'complete', suppressionResult });

    if (application.syncKey !== key) {
      if (typeof gateway.updatePage !== 'function') throw new ApplicationSyncError('v5 sync requires gateway.updatePage', 'GATEWAY_UPDATE_REQUIRED');
      await gateway.updatePage('applications', application.id, { syncKey: key });
      applicationUpdated = true;
    }
    await checkpoint({ syncKey: 'complete' });
    const noop = !applicationUpdated && !activityCreated && ['already', 'not-configured'].includes(suppressionResult.status);
    return {
      applicationId: application.id,
      status: noop ? 'noop' : 'synced',
      observedAt,
      idempotencyKey: key,
      applicationUpdated,
      activityCreated,
      activityId: activity?.id ?? null,
      suppression: suppressionResult,
      transition,
    };
  });
  if (transaction.skipped) return { ...(transaction.result ?? { applicationId: application.id, idempotencyKey: key, transition }), status: 'noop', transaction: { key: transaction.key, recovered: false, skipped: true } };
  return { ...transaction.result, transaction: { key: transaction.key, recovered: transaction.recovering === true, skipped: false } };
}

async function ensureApplied(gateway, application, { now, suppression } = {}) {
  const appliedAt = validDate(application.appliedAt) ? application.appliedAt : nowIso(now);
  const result = await ensureLifecycle(gateway, application, {
    eventType: 'Applied',
    observedAt: appliedAt,
    suppression,
    stampApplied: true,
    notes: 'Observed from user-controlled Applied? = true. No submission was inferred.',
  });
  return { ...result, appliedAt };
}

export async function syncAppliedApplications({ gateway, suppression = null, now = () => Date.now(), pageSize = 100 } = {}) {
  assertV5ApplicationsGateway(gateway);
  const applications = await readAppliedQueue({ gateway, pageSize });
  const results = [];
  for (const application of applications) {
    try {
      results.push(await ensureApplied(gateway, application, { now, suppression }));
    } catch (error) {
      results.push({ applicationId: application.id, status: 'failed', error: { code: error.code ?? 'APPLICATION_SYNC_FAILED', message: error.message } });
    }
  }
  const failed = results.filter((result) => result.status === 'failed');
  return { status: failed.length ? (failed.length === results.length && results.length ? 'failed' : 'partial') : 'synced', selected: applications.length, results };
}

export async function syncConfirmedOutcome({ gateway, application, outcome, evidence, suppression = null, now = () => Date.now() } = {}) {
  assertConfirmedOutcome(outcome, evidence);
  assertV5ApplicationsGateway(gateway);
  if (!application?.id) throw new Error('application id is required');
  const observedAt = validDate(evidence.observedAt) ? new Date(evidence.observedAt).toISOString() : nowIso(now);
  const result = await ensureLifecycle(gateway, application, {
    eventType: outcome,
    observedAt,
    suppression,
    notes: `Evidence: ${evidence.source ?? evidence.connector ?? evidence.url ?? evidence.recordId}`,
  });
  return { ...result, outcome };
}
