import { V5_SCHEMA } from '../notion-v5/schema.mjs';
import { readAppliedQueue, assertV5ApplicationsGateway } from './queue-reader.mjs';
import { applicationEventKey, assertConfirmedOutcome, eventKeyFor } from './idempotency.mjs';

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

function applicationUpdate(application, appliedAt, key) {
  const values = {};
  if (application.status !== 'Applied') values.status = 'Applied';
  if (!validDate(application.appliedAt)) values.appliedAt = appliedAt;
  return values;
}

async function ensureApplied(gateway, application, { now, suppression } = {}) {
  const key = eventKeyFor(application);
  const appliedAt = validDate(application.appliedAt) ? application.appliedAt : nowIso(now);
  const update = applicationUpdate(application, appliedAt, key);
  let activity = await existingActivity(gateway, key);
  const activityExisted = Boolean(activity);
  let applicationUpdated = false;
  let activityCreated = false;
  let suppressionResult = { status: 'not-configured' };

  if (Object.keys(update).length) {
    if (typeof gateway.updatePage !== 'function') throw new Error('v5 sync requires gateway.updatePage');
    await gateway.updatePage('applications', application.id, update);
    applicationUpdated = true;
  }
  if (!activity) {
    if (typeof gateway.createPage !== 'function') throw new Error('v5 sync requires gateway.createPage');
    const created = await gateway.createPage('activity', {
      name: `Applied — ${application.role ?? 'Role'} at ${application.companyName ?? application.company ?? 'Company'}`,
      application: [application.id],
      eventType: 'Applied',
      eventAt: appliedAt,
      idempotencyKey: key,
      actionState: 'Confirmed',
      notes: 'Observed from user-controlled Applied? = true. No submission was inferred.',
    });
    activityCreated = true;
    activity = created;
  }
  if (suppression && (!activityExisted || applicationUpdated)) suppressionResult = await suppression.ensureSuppressed(application, { now: appliedAt });
  if (suppressionResult.status === 'conflict') throw new Error('existing suppression state conflicts with Applied? synchronization');
  if (!application.syncKey && (suppressionResult.status === 'updated' || suppressionResult.status === 'already' || suppressionResult.status === 'not-configured')) {
    if (typeof gateway.updatePage !== 'function') throw new Error('v5 sync requires gateway.updatePage');
    await gateway.updatePage('applications', application.id, { syncKey: key });
    applicationUpdated = true;
  }

  const noop = !applicationUpdated && !activityCreated && ['already', 'not-configured'].includes(suppressionResult.status);
  return { applicationId: application.id, status: noop ? 'noop' : 'synced', appliedAt, idempotencyKey: key, applicationUpdated, activityCreated, activityId: activity?.id ?? null, suppression: suppressionResult };
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
  const key = applicationEventKey(application.id, outcome);
  const observedAt = validDate(evidence.observedAt) ? new Date(evidence.observedAt).toISOString() : nowIso(now);
  const activity = await existingActivity(gateway, key);
  const update = application.status === outcome ? {} : { status: outcome };
  if (Object.keys(update).length) await gateway.updatePage('applications', application.id, update);
  if (activity) return { status: 'noop', applicationId: application.id, outcome, idempotencyKey: key, activityId: activity.id };
  const created = await gateway.createPage('activity', {
    name: `${outcome} — ${application.role ?? 'Role'} at ${application.companyName ?? application.company ?? 'Company'}`,
    application: [application.id], eventType: outcome, eventAt: observedAt, idempotencyKey: key,
    actionState: 'Confirmed', notes: `Evidence: ${evidence.source ?? evidence.connector ?? evidence.url ?? evidence.recordId}`,
  });
  if (suppression?.ensureSuppressed) await suppression.ensureSuppressed(application, { now: observedAt });
  return { status: 'synced', applicationId: application.id, outcome, idempotencyKey: key, activityId: created?.id ?? null };
}
