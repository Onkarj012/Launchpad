import test from 'node:test';
import assert from 'node:assert/strict';
import { application, contact, createFakeGateway, OUTREACH_FIXTURE_NOW, providersFor } from '../fixtures/outreach-v5.mjs';
import { normalizeContactEvidence } from '../../outreach-v5/evidence.mjs';
import { buildOutreachDraft, storeOutreachDraft } from '../../outreach-v5/draft.mjs';
import { OUTREACH_CADENCE, cadencePlan, deriveOutreachState, dueCadenceAction } from '../../outreach-v5/cadence.mjs';
import { confirmManualSend, prepareOutreach, persistOutreach, recordOutreachOutcome } from '../../outreach-v5/workflow.mjs';
import { outreachActivityKey, outreachDuplicateKey } from '../../outreach-v5/idempotency.mjs';
import { researchContact } from '../../outreach-v5/research.mjs';

test('contact research is free-first, records public evidence, and leaves missing email blank', async () => {
  const providers = providersFor({ failure: true });
  const result = await researchContact({ application: application('one'), providers, now: OUTREACH_FIXTURE_NOW });
  assert.equal(result.status, 'found');
  assert.equal(result.contact, null);
  assert.equal(result.recommendedCandidate.email, null);
  assert.equal(result.recommendedCandidate.recommendedChannel, 'LinkedIn');
  assert.equal(result.recommendedCandidate.companyRelationship, 'Leads the engineering team hiring for this role');
  assert.deepEqual(providers.calls.map(([source]) => source), ['hiringAuthors', 'companyTeamPages', 'publicProfiles']);
  assert.equal(result.failures[0].source, 'companyTeamPages');
  assert.equal(result.recommendedCandidate.publicEvidence[0].url, 'https://example.com/team/one');
  assert.equal(result.recommendedCandidate.observedAt, OUTREACH_FIXTURE_NOW);
});

test('explicit paid approval allows a later evidence-backed email path', async () => {
  const calls = [];
  const result = await researchContact({
    application: application('two'),
    providers: {
      hiringAuthors: async () => { calls.push('hiringAuthors'); return []; },
      companyTeamPages: async () => { calls.push('companyTeamPages'); return []; },
      publicProfiles: async () => { calls.push('publicProfiles'); return []; },
      apollo: async () => { calls.push('apollo'); throw new Error('credit provider down'); },
      hunter: async () => { calls.push('hunter'); return [contact('two', { email: 'person-two@example.com', emailEvidence: 'Hunter result', recommendedChannel: 'Email' })]; },
    },
    allowPaid: true,
    runId: 'paid-run',
    paidApproval: { confirmed: true, approvedBy: 'Onkar', runId: 'paid-run' },
    now: OUTREACH_FIXTURE_NOW,
  });
  assert.equal(result.status, 'found');
  assert.equal(result.recommendedCandidate.email, 'person-two@example.com');
  assert.deepEqual(calls, ['hiringAuthors', 'companyTeamPages', 'publicProfiles', 'apollo', 'hunter']);
  assert.equal(result.failures[0].source, 'apollo');
});

test('paid providers are disabled by default and guessed email evidence is rejected', async () => {
  const paidCalls = [];
  const result = await researchContact({
    application: application('paid-default'),
    providers: {
      hiringAuthors: async () => [],
      companyTeamPages: async () => [],
      publicProfiles: async () => [],
      publicCompanyEmailEvidence: async () => [{
        ...contact('guessed', { recommendedChannel: 'Email' }),
        email: 'guessed@example.com',
        emailEvidence: null,
      }],
      apollo: async () => { paidCalls.push('apollo'); return []; },
    },
    now: OUTREACH_FIXTURE_NOW,
  });
  assert.equal(result.status, 'not-found');
  assert.deepEqual(paidCalls, []);
  assert.equal(result.rejected[0].code, 'EMAIL_EVIDENCE_REQUIRED');
  assert.equal(result.attempts.find(({ source }) => source === 'apollo').reason, 'paid-provider-disabled');
});

test('outreach identity is deterministic for application x person x channel', () => {
  const first = outreachDuplicateKey({ applicationId: 'APP-1', person: { name: 'Jane Doe', contactUrl: 'https://www.linkedin.com/in/jane-doe' }, channel: 'LinkedIn' });
  const second = outreachDuplicateKey({ applicationId: 'app 1', person: { name: 'ignored', contactUrl: 'https://www.linkedin.com/in/jane-doe' }, channel: 'linkedin' });
  assert.equal(first, second);
  assert.notEqual(first, outreachDuplicateKey({ applicationId: 'app 1', person: { contactUrl: 'https://www.linkedin.com/in/jane-doe' }, channel: 'Email' }));
  assert.equal(outreachActivityKey({ duplicateKey: first, eventType: 'Initial Sent' }), outreachActivityKey({ duplicateKey: first, eventType: 'initial sent' }));
});

test('deep personalization is capped at six and lighter paths cover the remainder', async () => {
  const apps = Array.from({ length: 8 }, (_, index) => application(`app-${index}`, 100 - index));
  const contactApprovals = Object.fromEntries(apps.map((app) => [app.id, { approved: true, personId: app.id, channel: 'LinkedIn' }]));
  const prepared = await prepareOutreach({ applications: apps, providers: providersFor(), contactApprovals, deepLimit: 6, now: OUTREACH_FIXTURE_NOW });
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.deepCount, 6);
  assert.equal(prepared.lightCount, 2);
  assert.equal(prepared.results[0].draft.depth, 'deep');
  assert.equal(prepared.results.at(-1).draft.depth, 'light');
});

test('attachment preparation requires exact Ready resume state and matching role artifact', () => {
  const base = application('resume-app', 95, { resumeState: 'Not Started' });
  const artifact = { applicationId: 'resume-app', company: base.companyName, role: base.role, pdfPath: '/tmp/role.pdf', state: 'Ready' };
  assert.throws(() => buildOutreachDraft({ application: base, contact: contact('resume-app'), attachmentExpected: true, resumeArtifact: artifact }), (error) => error.code === 'RESUME_NOT_READY');
  const ready = { ...base, resumeState: 'Ready' };
  assert.throws(() => buildOutreachDraft({ application: ready, contact: contact('resume-app'), attachmentExpected: true, resumeArtifact: { ...artifact, role: 'Different Role' } }), (error) => error.code === 'RESUME_ROLE_MISMATCH');
  const draft = buildOutreachDraft({ application: ready, contact: contact('resume-app'), attachmentExpected: true, resumeArtifact: artifact });
  assert.equal(draft.attachmentExpected, true);
  assert.match(draft.body, /attached the exact role-specific resume/);
});

test('draft storage keeps compact properties, full body, and prevents duplicate pages', async () => {
  const gateway = createFakeGateway();
  const draft = buildOutreachDraft({ application: application('store-app'), contact: contact('store-app') });
  const first = await storeOutreachDraft({ gateway, draft });
  const second = await storeOutreachDraft({ gateway, draft });
  assert.equal(first.status, 'created');
  assert.equal(second.status, 'duplicate');
  assert.equal(gateway.pages.outreach.length, 1);
  assert.ok(gateway.pages.outreach[0].children.some((block) => block.paragraph?.rich_text?.[0]?.text?.content.includes('Hi Person')));
  assert.ok(draft.preview.length <= 240);
});

test('manual send confirmation is the only path that changes Sent state and it is idempotent', async () => {
  const gateway = createFakeGateway();
  const app = application('send-app');
  gateway.pages.applications.push({ id: app.id, values: { outreachState: null, nextAction: null } });
  const draft = buildOutreachDraft({ application: app, contact: contact('send-app') });
  const stored = await storeOutreachDraft({ gateway, draft });
  await assert.rejects(() => confirmManualSend({ gateway, outreach: { ...draft, id: stored.page.id }, application: app, confirmation: { confirmed: false }, now: OUTREACH_FIXTURE_NOW }), (error) => error.code === 'MANUAL_CONFIRMATION_REQUIRED');
  assert.equal(gateway.pages.outreach[0].values.sent, false);
  const confirmed = await confirmManualSend({ gateway, outreach: { ...draft, id: stored.page.id }, application: app, confirmation: { confirmed: true, confirmedBy: 'Onkar', sentAt: OUTREACH_FIXTURE_NOW }, now: OUTREACH_FIXTURE_NOW });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(gateway.pages.outreach[0].values.sent, true);
  assert.equal(gateway.pages.activity.length, 1);
  const repeated = await confirmManualSend({ gateway, outreach: { ...draft, id: stored.page.id }, application: app, confirmation: { confirmed: true, confirmedBy: 'Onkar', sentAt: OUTREACH_FIXTURE_NOW }, now: OUTREACH_FIXTURE_NOW });
  assert.equal(repeated.status, 'noop');
  assert.equal(gateway.pages.activity.length, 1);
  assert.equal(gateway.calls.some((call) => call.method === 'send'), false);
});

test('a manually confirmed response stops the sequence, updates derived application state, and blocks later sends', async () => {
  const gateway = createFakeGateway();
  const app = application('response-app');
  gateway.pages.applications.push({ id: app.id, values: {} });
  const draft = buildOutreachDraft({ application: app, contact: contact('response-app') });
  const stored = await storeOutreachDraft({ gateway, draft });
  const outcome = await recordOutreachOutcome({
    gateway,
    outreach: { ...draft, id: stored.page.id },
    application: app,
    response: 'Replied',
    confirmation: { confirmed: true, confirmedBy: 'Onkar' },
    now: OUTREACH_FIXTURE_NOW,
  });
  assert.equal(outcome.status, 'confirmed');
  assert.equal(gateway.pages.outreach[0].values.response, 'Replied');
  assert.equal(gateway.pages.outreach[0].values.nextEligibleContact, null);
  assert.equal(gateway.pages.applications[0].values.outreachState, 'Stopped');
  await assert.rejects(() => confirmManualSend({ gateway, outreach: { ...draft, id: stored.page.id, response: 'Replied' }, application: app, confirmation: { confirmed: true, confirmedBy: 'Onkar' }, now: OUTREACH_FIXTURE_NOW }), (error) => error.code === 'OUTREACH_STOPPED');
});

test('cadence produces Day 0/3/10/17 and stops on reply or closure', () => {
  assert.deepEqual(OUTREACH_CADENCE.map((item) => item.day), [0, 3, 10, 17]);
  const plan = cadencePlan({ initialSentAt: '2026-07-01T09:00:00.000Z' });
  assert.deepEqual(plan.map((item) => item.dueAt), ['2026-07-01T09:00:00.000Z', '2026-07-04T09:00:00.000Z', '2026-07-11T09:00:00.000Z', '2026-07-18T09:00:00.000Z']);
  const before = deriveOutreachState({ application: application('cadence'), sequence: { sent: true, sentAt: '2026-07-01T09:00:00.000Z' }, now: '2026-07-04T09:00:00.000Z' });
  assert.equal(before.nextAction, 'Follow-up 1');
  assert.equal(before.due, true);
  const stopped = deriveOutreachState({ application: application('cadence'), sequence: { sent: true, sentAt: '2026-07-01T09:00:00.000Z', response: 'Replied' }, now: '2026-07-20T09:00:00.000Z' });
  assert.equal(stopped.state, 'Stopped');
  assert.equal(stopped.nextAction, null);
  const closed = dueCadenceAction({ application: application('cadence'), sequence: { sent: true, sentAt: '2026-07-01T09:00:00.000Z' }, activities: [
    { eventType: 'Follow-up 1 Sent', eventAt: '2026-07-04T09:00:00.000Z' },
    { eventType: 'Follow-up 2 Sent', eventAt: '2026-07-11T09:00:00.000Z' },
  ], now: '2026-07-18T09:00:00.000Z' });
  assert.equal(closed.action, 'Close');
  const silentClosure = dueCadenceAction({ application: application('cadence'), sequence: { sent: true, sentAt: '2026-07-01T09:00:00.000Z' }, now: '2026-07-18T09:00:00.000Z' });
  assert.equal(silentClosure.action, 'Close');
});

test('batch persistence preserves no-contact and draft-blocked outcomes without external writes', async () => {
  const gateway = createFakeGateway();
  const prepared = await prepareOutreach({
    applications: [application('ok'), application('blocked', 89, { resumeState: 'Not Started' })],
    providers: providersFor(),
    contactApprovals: {
      ok: { approved: true, personId: 'ok', channel: 'LinkedIn' },
      blocked: { approved: true, personId: 'blocked', channel: 'LinkedIn' },
    },
    attachmentExpected: (current) => current.id === 'blocked',
    now: OUTREACH_FIXTURE_NOW,
  });
  const persisted = await persistOutreach({ gateway, prepared });
  assert.equal(persisted.status, 'partial');
  assert.equal(gateway.pages.outreach.length, 1);
  assert.equal(persisted.results.find((result) => result.applicationId === 'blocked').status, 'draft-blocked');
});
