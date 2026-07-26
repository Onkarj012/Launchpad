import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncAppliedApplications, syncConfirmedOutcome } from '../../resume-v5/application-sync.mjs';
import { createTransactionJournal, runDurableTransaction } from '../../notion-v5/transaction.mjs';

function prop(type, value) {
  if (type === 'checkbox') return { type, [type]: value };
  if (type === 'date') return { type, [type]: value == null ? null : { start: value } };
  if (type === 'rich_text' || type === 'title') return { type, [type]: [{ plain_text: String(value ?? '') }] };
  return { type, [type]: value == null ? null : { name: value } };
}

function row(id, { status = 'Ready', applied = true, appliedAt = null, syncKey = null } = {}) {
  return {
    id,
    role: 'AI Engineer',
    companyName: 'Acme',
    status,
    appliedAt,
    properties: {
      'Applied?': prop('checkbox', applied),
      'Role': prop('rich_text', 'AI Engineer'),
      'Status': prop('select', status),
      'Applied At': prop('date', appliedAt),
      'Sync Key': prop('rich_text', syncKey),
      'Dedup Key': prop('rich_text', `dedup-${id}`),
    },
  };
}

function transactionGateway(applicationRows, { failCreateOnce = false } = {}) {
  const activities = [];
  const updates = [];
  let createFailures = failCreateOnce ? 1 : 0;
  const journal = createTransactionJournal({
    journalPath: path.join(mkdtempSync(path.join(os.tmpdir(), 'application-sync-')), 'transactions.json'),
  });
  const gateway = {
    activities,
    updates,
    journal,
    async runTransaction(options) {
      return runDurableTransaction({ journal, ...options });
    },
    async listRows(target, { filter } = {}) {
      if (target === 'applications') return applicationRows;
      const key = filter?.rich_text?.equals;
      return activities.filter((activity) => activity.values.idempotencyKey === key);
    },
    async updatePage(target, id, values) {
      updates.push({ target, id, values });
      const application = applicationRows.find((candidate) => candidate.id === id);
      Object.assign(application, values);
      if ('status' in values) application.properties.Status = prop('select', values.status);
      if ('appliedAt' in values) application.properties['Applied At'] = prop('date', values.appliedAt);
      if ('syncKey' in values) application.properties['Sync Key'] = prop('rich_text', values.syncKey);
      return { id };
    },
    async createPage(_target, values) {
      if (createFailures) {
        createFailures--;
        throw new Error('synthetic activity failure');
      }
      const activity = { id: `activity-${activities.length + 1}`, values };
      activities.push(activity);
      return activity;
    },
  };
  return gateway;
}

test('Applied sync never regresses Interviewing to Applied', async () => {
  const application = row('interviewing', { status: 'Interviewing', appliedAt: '2026-07-20T09:00:00.000Z' });
  const gateway = transactionGateway([application]);
  const suppression = { async ensureSuppressed(_application, options) { return { status: 'already', outcome: options.outcome }; } };
  const result = await syncAppliedApplications({ gateway, suppression, now: '2026-07-26T10:00:00.000Z' });

  assert.equal(result.status, 'synced');
  assert.equal(application.status, 'Interviewing');
  assert.equal(gateway.updates.some((update) => update.values.status === 'Applied'), false);
  assert.equal(result.results[0].transition.status, 'preserved');
});

test('repeated transactional sync creates one Activity event', async () => {
  const application = row('repeat');
  const gateway = transactionGateway([application]);
  const suppression = { async ensureSuppressed() { return { status: 'already' }; } };
  const first = await syncAppliedApplications({ gateway, suppression, now: '2026-07-26T10:00:00.000Z' });
  const second = await syncAppliedApplications({ gateway, suppression, now: '2026-07-26T11:00:00.000Z' });

  assert.equal(first.results[0].status, 'synced');
  assert.equal(second.results[0].status, 'noop');
  assert.equal(gateway.activities.length, 1);
});

test('a failed lifecycle transaction remains visible and resumes exactly', async () => {
  const application = row('recover');
  const gateway = transactionGateway([application], { failCreateOnce: true });
  const suppression = { async ensureSuppressed() { return { status: 'already' }; } };
  const first = await syncAppliedApplications({ gateway, suppression, now: '2026-07-26T10:00:00.000Z' });

  assert.equal(first.status, 'failed');
  assert.equal(gateway.journal.recover().length, 1);
  assert.equal(gateway.journal.recover()[0].progress.application, 'complete');

  const second = await syncAppliedApplications({ gateway, suppression, now: '2026-07-26T10:00:00.000Z' });
  assert.equal(second.status, 'synced');
  assert.equal(gateway.journal.recover().length, 0);
  assert.equal(gateway.activities.length, 1);
  assert.equal(application.syncKey, 'launchpad-v5:application:recover:applied');
});

test('suppression is retried when the Activity event already exists', async () => {
  const application = row('suppression');
  const gateway = transactionGateway([application]);
  let attempts = 0;
  const suppression = {
    async ensureSuppressed() {
      attempts++;
      if (attempts === 1) throw new Error('synthetic ledger failure');
      return { status: 'updated' };
    },
  };
  const first = await syncAppliedApplications({ gateway, suppression, now: '2026-07-26T10:00:00.000Z' });
  const second = await syncAppliedApplications({ gateway, suppression, now: '2026-07-26T10:00:00.000Z' });

  assert.equal(first.status, 'failed');
  assert.equal(second.status, 'synced');
  assert.equal(gateway.activities.length, 1);
  assert.equal(attempts, 2);
});

test('confirmed outcome is propagated to suppression and the opportunity ledger seam', async () => {
  const application = row('outcome', { status: 'Applied', appliedAt: '2026-07-20T09:00:00.000Z' });
  const gateway = transactionGateway([application]);
  const outcomes = [];
  const suppression = {
    async ensureSuppressed(_application, options) {
      outcomes.push(options.outcome);
      return { status: 'updated', outcome: options.outcome };
    },
  };
  const result = await syncConfirmedOutcome({
    gateway,
    application,
    outcome: 'Interviewing',
    evidence: { confirmed: true, source: 'user note', observedAt: '2026-07-26T10:00:00.000Z' },
    suppression,
  });

  assert.equal(result.status, 'synced');
  assert.equal(application.status, 'Interviewing');
  assert.deepEqual(outcomes, ['Interviewing']);
  assert.equal(application.syncKey, 'launchpad-v5:application:outcome:interviewing');
});
