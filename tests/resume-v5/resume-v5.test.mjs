import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAKE_RESUME_FILTER, readMakeResumeQueue, readAppliedQueue } from '../../resume-v5/queue-reader.mjs';
import { verifyResumeArtifact } from '../../resume-v5/artifact-state.mjs';
import { processMakeResumeQueue } from '../../resume-v5/resume-queue.mjs';
import { applicationEventKey, assertConfirmedOutcome } from '../../resume-v5/idempotency.mjs';
import { syncAppliedApplications, syncConfirmedOutcome } from '../../resume-v5/application-sync.mjs';
import { createLedgerSuppressionAdapter } from '../../resume-v5/suppression-adapter.mjs';

const FIXTURE_DIR = path.resolve('tests/fixtures/resume-v5');

function prop(type, value) {
  if (type === 'checkbox') return { type, [type]: value };
  if (type === 'date') return { type, [type]: value == null ? null : { start: value } };
  if (type === 'rich_text' || type === 'title') return { type, [type]: [{ plain_text: String(value ?? '') }] };
  return { type, [type]: value == null ? null : { name: value } };
}

function row(id, { makeResume = false, applied = false, role = 'AI Engineer', companyName = 'Acme', status = 'Ready', appliedAt = null } = {}) {
  return { id, role, companyName, status, appliedAt, properties: {
    'Make Resume': prop('checkbox', makeResume), 'Applied?': prop('checkbox', applied),
    'Role': prop('rich_text', role), 'JD Link': { type: 'url', url: `https://jobs.example/${id}` },
    'Resume State': prop('select', 'Not Started'), 'Status': prop('select', status),
    'Applied At': prop('date', appliedAt), 'Sync Key': prop('rich_text', null), 'Dedup Key': prop('rich_text', `dedup-${id}`),
  } };
}

function fixtureArtifact(applicationId, directory = mkdtempSync(path.join(os.tmpdir(), 'resume-v5-artifact-'))) {
  for (const name of ['Onkar_Jadhav_Acme_AI_Engineer.tex', 'Onkar_Jadhav_Acme_AI_Engineer.matrix.md', 'Onkar_Jadhav_Acme_AI_Engineer.provenance.md', 'Onkar_Jadhav_Acme_AI_Engineer.pdf']) cpSync(path.join(FIXTURE_DIR, name), path.join(directory, name));
  return {
    applicationId, company: 'Acme', role: 'AI Engineer',
    pdfPath: path.join(directory, 'Onkar_Jadhav_Acme_AI_Engineer.pdf'),
    sourcePath: path.join(directory, 'Onkar_Jadhav_Acme_AI_Engineer.tex'),
    matrixPath: path.join(directory, 'Onkar_Jadhav_Acme_AI_Engineer.matrix.md'),
    provenancePath: path.join(directory, 'Onkar_Jadhav_Acme_AI_Engineer.provenance.md'),
  };
}

test('Make Resume queue reads the direct checked v5 Applications query and filters over-broad results locally', async () => {
  const calls = [];
  const gateway = { listRows: async (target, options) => { calls.push({ target, options }); return [row('checked', { makeResume: true }), row('unchecked')]; } };
  const result = await readMakeResumeQueue({ gateway });
  assert.deepEqual(result.map((item) => item.id), ['checked']);
  assert.equal(calls[0].target, 'applications');
  assert.deepEqual(calls[0].options.filter, MAKE_RESUME_FILTER);
});

test('v4 queue targets are refused before the gateway is queried', async () => {
  let queried = false;
  await assert.rejects(() => readMakeResumeQueue({ gateway: { version: 'v4', listRows: async () => { queried = true; return []; } } }), (error) => error.code === 'LEGACY_TARGET_REFUSED');
  assert.equal(queried, false);
});

test('artifact verifier makes Ready contingent on exact association, sidecars, freshness, and injected PDF verification', async () => {
  const artifact = fixtureArtifact('app-acme');
  let verified = 0;
  const result = await verifyResumeArtifact({ application: { id: 'app-acme', companyName: 'Acme', role: 'AI Engineer' }, artifact, verifyPdf: async () => { verified++; return { status: 'PASS' }; }, now: '2026-07-23T10:00:00.000Z' });
  assert.equal(result.state, 'Ready');
  assert.equal(verified, 1);

  const mismatch = await verifyResumeArtifact({ application: { id: 'other', companyName: 'Acme', role: 'AI Engineer' }, artifact, verifyPdf: async () => true });
  assert.equal(mismatch.state, 'Stale');
  assert.equal(mismatch.code, 'APPLICATION_MISMATCH');
  assert.equal(verified, 1);

  utimesSync(artifact.pdfPath, new Date(1), new Date(1));
  const stale = await verifyResumeArtifact({ application: { id: 'app-acme', companyName: 'Acme', role: 'AI Engineer' }, artifact, verifyPdf: async () => true });
  assert.equal(stale.state, 'Stale');
  assert.equal(stale.code, 'PDF_OLDER_THAN_EVIDENCE');
});

test('resume queue builds only selected rows and reports partial artifact failures with state transitions', async () => {
  const applications = [row('a', { makeResume: true }), row('b', { makeResume: true }), row('not-selected')];
  const updates = [];
  const gateway = {
    listRows: async () => applications,
    updatePage: async (_target, id, values) => { updates.push({ id, values }); },
  };
  const result = await processMakeResumeQueue({ gateway, build: async (application) => { if (application.id === 'b') throw new Error('fixture build failure'); return fixtureArtifact(application.id); }, verifyPdf: async () => true });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.results.map((item) => [item.applicationId, item.state]), [['a', 'Ready'], ['b', 'Failed']]);
  assert.deepEqual(updates.map((item) => [item.id, item.values.resumeState]), [['a', 'Building'], ['a', 'Ready'], ['b', 'Building'], ['b', 'Failed']]);
  assert.equal(updates.some((item) => Object.prototype.hasOwnProperty.call(item.values, 'makeResume')), false);
});

function syncGateway(applicationRows) {
  const activities = [];
  const updates = [];
  return {
    activities, updates,
    async listRows(target, { filter } = {}) {
      if (target === 'applications') return applicationRows;
      const key = filter?.rich_text?.equals;
      return activities.filter((activity) => activity.properties?.['Idempotency Key']?.rich_text?.[0]?.plain_text === key);
    },
    async updatePage(target, id, values) {
      updates.push({ target, id, values });
      const app = applicationRows.find((item) => item.id === id);
      Object.assign(app, values);
      if ('status' in values) app.properties.Status = prop('select', values.status);
      if ('appliedAt' in values) app.properties['Applied At'] = prop('date', values.appliedAt);
      if ('syncKey' in values) app.properties['Sync Key'] = prop('rich_text', values.syncKey);
    },
    async createPage(target, values) { const activity = { id: `activity-${activities.length + 1}`, properties: { 'Idempotency Key': prop('rich_text', values.idempotencyKey) }, values }; activities.push(activity); return activity; },
  };
}

test('Applied? synchronization stamps only the current confirmed observation, creates one event, and is idempotent', async () => {
  const applications = [row('applied-1', { applied: true, appliedAt: null })];
  const gateway = syncGateway(applications);
  const suppression = { calls: [], async ensureSuppressed(application) { this.calls.push(application.id); return { status: this.calls.length === 1 ? 'updated' : 'already' }; } };
  const first = await syncAppliedApplications({ gateway, suppression, now: '2026-07-23T12:00:00.000Z' });
  const second = await syncAppliedApplications({ gateway, suppression, now: '2026-07-24T12:00:00.000Z' });
  assert.equal(first.results[0].status, 'synced');
  assert.equal(second.results[0].status, 'noop');
  assert.equal(applications[0].status, 'Applied');
  assert.equal(applications[0].appliedAt, '2026-07-23T12:00:00.000Z');
  assert.equal(gateway.activities.length, 1);
  assert.deepEqual(suppression.calls, ['applied-1']);
  assert.equal(gateway.updates.length, 2);
});

test('an existing Applied At date is preserved and terminal outcomes require evidence', async () => {
  const applications = [row('applied-2', { applied: true, appliedAt: '2026-07-01T09:00:00.000Z' })];
  const gateway = syncGateway(applications);
  const result = await syncAppliedApplications({ gateway, now: '2026-07-23T12:00:00.000Z' });
  assert.equal(result.results[0].appliedAt, '2026-07-01T09:00:00.000Z');
  assert.equal(applications[0].appliedAt, '2026-07-01T09:00:00.000Z');
  assert.throws(() => assertConfirmedOutcome('Rejected', { confirmed: false, source: 'email' }), /requires user-confirmed/);
  const confirmed = await syncConfirmedOutcome({ gateway, application: applications[0], outcome: 'Interviewing', evidence: { confirmed: true, source: 'user note', observedAt: '2026-07-23T13:00:00.000Z' } });
  assert.equal(confirmed.status, 'synced');
  assert.equal(applications[0].status, 'Interviewing');
  assert.equal(gateway.activities.at(-1).values.idempotencyKey, applicationEventKey('applied-2', 'Interviewing'));
});

test('failed PDF verification cannot promote an artifact to Ready', async () => {
  const artifact = fixtureArtifact('app-fail');
  const result = await verifyResumeArtifact({ application: { id: 'app-fail', companyName: 'Acme', role: 'AI Engineer' }, artifact, verifyPdf: async () => false });
  assert.equal(result.state, 'Failed');
  assert.equal(result.code, 'PDF_VERIFICATION_FAILED');
});

test('the additive ledger adapter updates only an existing matching row and is idempotent', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'resume-v5-ledger-'));
  const ledgerPath = path.join(directory, 'opportunity-ledger.tsv');
  writeFileSync(ledgerPath, 'dedup_key\tcompany\trole\tcanonical_url\tprovider\tfirst_surfaced_at\tlast_surfaced_at\ttimes_surfaced\taction_state\taction_at\nkey-1\tAcme\tAI Engineer\thttps://jobs.example/acme\tats\t2026-07-22T00:00:00.000Z\t2026-07-22T00:00:00.000Z\t1\tnone\t\n');
  const adapter = createLedgerSuppressionAdapter({ ledgerPath });
  const application = { dedupKey: 'key-1', originalApplicationUrl: 'https://jobs.example/acme' };
  assert.equal((await adapter.ensureSuppressed(application, { now: '2026-07-23T12:00:00.000Z' })).status, 'updated');
  assert.equal((await adapter.ensureSuppressed(application, { now: '2026-07-24T12:00:00.000Z' })).status, 'already');
  assert.equal((await adapter.ensureSuppressed({ dedupKey: 'missing' }, { now: '2026-07-23T12:00:00.000Z' })).status, 'not-found');
});
