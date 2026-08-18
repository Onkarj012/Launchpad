import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { application, contact, createFakeGateway, OUTREACH_FIXTURE_NOW, providersFor } from '../fixtures/outreach-v5.mjs';
import { normalizeContactEvidence } from '../../outreach-v5/evidence.mjs';
import { buildOutreachDraft, storeOutreachDraft } from '../../outreach-v5/draft.mjs';
import { OUTREACH_CADENCE, cadencePlan, deriveOutreachState, dueCadenceAction } from '../../outreach-v5/cadence.mjs';
import { createGmailDraft, observeGmailReplies } from '../../outreach-v5/gmail.mjs';
import { confirmManualSend, prepareOutreach, persistOutreach, recordObservedReply, recordOutreachOutcome } from '../../outreach-v5/workflow.mjs';
import { outreachActivityKey, outreachDuplicateKey } from '../../outreach-v5/idempotency.mjs';
import { researchContact } from '../../outreach-v5/research.mjs';
import { mapProperties } from '../../notion-v5/schema.mjs';
import * as gmailOutreach from '../../outreach-v5/gmail.mjs';

test('contact research is free-first, records public evidence, and leaves missing email blank', async () => {
  const providers = providersFor({ failure: true });
  const result = await researchContact({ application: application('one'), providers, selectContact: (candidates) => candidates[0], now: OUTREACH_FIXTURE_NOW });
  assert.equal(result.status, 'found');
  assert.equal(result.contact.email, null);
  assert.equal(result.contact.recommendedChannel, 'LinkedIn');
  assert.equal(result.contact.companyRelationship, 'Leads the engineering team hiring for this role');
  assert.deepEqual(providers.calls.map(([source]) => source), ['hiringAuthors', 'companyTeamPages', 'publicProfiles']);
  assert.equal(result.failures[0].source, 'companyTeamPages');
  assert.equal(result.contact.publicEvidence[0].url, 'https://example.com/team/one');
});

test('optional provider failures do not block a later evidence-backed email path', async () => {
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
    selectContact: (candidates) => candidates[0],
    now: OUTREACH_FIXTURE_NOW,
  });
  assert.equal(result.status, 'found');
  assert.equal(result.contact.email, 'person-two@example.com');
  assert.deepEqual(calls, ['hiringAuthors', 'companyTeamPages', 'publicProfiles', 'apollo', 'hunter']);
  assert.equal(result.failures[0].source, 'apollo');
});

test('contact research requires explicit selection when candidates are available', async () => {
  const result = await researchContact({ application: application('selection'), providers: providersFor(), now: OUTREACH_FIXTURE_NOW });
  assert.equal(result.status, 'needs-selection');
  assert.equal(result.contact, null);
  assert.equal(result.candidates.length, 1);
});

test('contact research skips paid providers by default when free providers return nothing', async () => {
  const calls = [];
  const providers = {
    hiringAuthors: async () => { calls.push('hiringAuthors'); return []; },
    companyTeamPages: async () => { calls.push('companyTeamPages'); return []; },
    publicProfiles: async () => { calls.push('publicProfiles'); return []; },
    apollo: async () => { calls.push('apollo'); return [contact('paid')]; },
  };
  const result = await researchContact({ application: application('paid-default'), providers, now: OUTREACH_FIXTURE_NOW });
  assert.equal(result.status, 'not-found');
  assert.equal(result.contact, null);
  assert.deepEqual(calls, ['hiringAuthors', 'companyTeamPages', 'publicProfiles']);
  assert.equal(result.attempts.find((attempt) => attempt.source === 'apollo').status, 'skipped');
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
  const prepared = await prepareOutreach({ applications: apps, providers: providersFor(), selectContact: (candidates) => candidates[0], deepLimit: 6, now: OUTREACH_FIXTURE_NOW });
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.deepCount, 6);
  assert.equal(prepared.lightCount, 2);
  assert.equal(prepared.results[0].draft.depth, 'deep');
  assert.equal(prepared.results.at(-1).draft.depth, 'light');
});

test('outreach preparation pauses for contact selection instead of drafting automatically', async () => {
  const prepared = await prepareOutreach({ applications: [application('needs-selection')], providers: providersFor(), now: OUTREACH_FIXTURE_NOW });
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.needsSelectionCount, 1);
  assert.equal(prepared.results[0].status, 'needs-selection');
  assert.equal(prepared.results[0].draft, undefined);
});

test('outreach preparation drafts from the explicitly selected candidate', async () => {
  const providers = {
    hiringAuthors: async () => [
      contact('top', { relevanceScore: 100 }),
      contact('chosen', { relevanceScore: 10 }),
    ],
  };
  const prepared = await prepareOutreach({
    applications: [application('selected')],
    providers,
    selectContact: (candidates) => candidates.find(({ contact: candidate }) => candidate.personId === 'chosen'),
    now: OUTREACH_FIXTURE_NOW,
  });
  assert.equal(prepared.results[0].status, 'draft-ready');
  assert.equal(prepared.results[0].research.contact.personId, 'chosen');
  assert.match(prepared.results[0].draft.body, /Hi Person chosen/);
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
  assert.deepEqual(gateway.pages.activity[0].values.outreach, [stored.page.id]);
  const repeated = await confirmManualSend({ gateway, outreach: { ...draft, id: stored.page.id }, application: app, confirmation: { confirmed: true, confirmedBy: 'Onkar', sentAt: OUTREACH_FIXTURE_NOW }, now: OUTREACH_FIXTURE_NOW });
  assert.equal(repeated.status, 'noop');
  assert.equal(gateway.pages.activity.length, 1);
  assert.equal(gateway.calls.some((call) => call.method === 'send'), false);
});

test('initial-send cadence uses the append-only Activity timestamp over Outreach Sent At', () => {
  const sequenceSentAt = '2026-07-01T09:00:00.000Z';
  const activitySentAt = '2026-07-05T09:00:00.000Z';
  const derived = deriveOutreachState({
    application: application('activity-authority'),
    sequence: { sent: true, sentAt: sequenceSentAt },
    activities: [{ eventType: 'Initial Sent', eventAt: activitySentAt }],
    now: '2026-07-08T09:00:00.000Z',
  });
  assert.deepEqual(derived.cadence.map((item) => item.dueAt), [
    '2026-07-05T09:00:00.000Z',
    '2026-07-08T09:00:00.000Z',
    '2026-07-15T09:00:00.000Z',
    '2026-07-22T09:00:00.000Z',
  ]);
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
    selectContact: (candidates) => candidates[0],
    attachmentExpected: (current) => current.id === 'blocked',
    now: OUTREACH_FIXTURE_NOW,
  });
  const persisted = await persistOutreach({ gateway, prepared });
  assert.equal(persisted.status, 'partial');
  assert.equal(gateway.pages.outreach.length, 1);
  assert.equal(persisted.results.find((result) => result.applicationId === 'blocked').status, 'draft-blocked');
});

test('Gmail seam exposes no send capability and creates a stable idempotent draft', async () => {
  const calls = [];
  let existing = null;
  const draft = buildOutreachDraft({ application: application('gmail-idempotent'), contact: contact('gmail-idempotent', { email: 'person@gmail-idempotent.example.com', emailEvidence: 'public page', recommendedChannel: 'Public Email' }) });
  const transport = {
    async lookupDraftByIdempotencyKey(request) { calls.push({ method: 'lookup', request }); return existing; },
    async createDraft(request) { calls.push({ method: 'create', request }); return { draftId: 'gd-1', messageId: 'gm-1', threadId: 'gt-1' }; },
  };
  assert.equal(Object.keys(gmailOutreach).some((name) => /send/i.test(name)), false);
  const first = await createGmailDraft({ transport, outreachId: 'outreach-gmail-1', draft });
  existing = first;
  const replay = await createGmailDraft({ transport, outreachId: 'outreach-gmail-1', draft });
  assert.equal(first.status, 'created');
  assert.equal(replay.status, 'replay');
  assert.equal(calls.filter(({ method }) => method === 'create').length, 1);
  const createCall = calls.find(({ method }) => method === 'create');
  assert.equal(createCall.request.idempotencyKey, calls.find(({ method }) => method === 'lookup').request.idempotencyKey);
  assert.equal(createCall.request.headers['X-Launchpad-Outreach-Id'], 'outreach-gmail-1');
  assert.equal(createCall.request.metadata.duplicateKey, draft.duplicateKey);
});

test('Gmail draft passes exact Ready PDF bytes, filename, MIME type, and digest once', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'launchpad-outreach-'));
  const pdfPath = path.join(directory, 'exact-role.pdf');
  const bytes = Buffer.from('%PDF-1.7\nexact fixture bytes\n%%EOF\n');
  await writeFile(pdfPath, bytes);
  try {
    const current = application('gmail-attachment', 90, { resumeState: 'Ready' });
    const draft = buildOutreachDraft({
      application: current,
      contact: contact('gmail-attachment', { email: 'person@gmail-attachment.example.com', emailEvidence: 'public page', recommendedChannel: 'Public Email' }),
      attachmentExpected: true,
      resumeArtifact: { applicationId: current.id, company: current.companyName, role: current.role, pdfPath, state: 'Ready' },
    });
    let request;
    const receipt = await createGmailDraft({
      outreachId: 'outreach-gmail-attachment',
      draft,
      transport: {
        async lookupDraftByIdempotencyKey() { return null; },
        async createDraft(value) { request = value; return { draftId: 'gd-2', messageId: 'gm-2', threadId: 'gt-2' }; },
      },
    });
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    assert.equal(receipt.digest, digest);
    assert.equal(request.attachment.filename, 'exact-role.pdf');
    assert.equal(request.attachment.mimeType, 'application/pdf');
    assert.equal(request.attachment.digest, digest);
    assert.deepEqual(request.attachment.bytes, bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reply observation binds exact thread, Outreach identity, and duplicate key while remaining read-only', async () => {
  const draft = buildOutreachDraft({ application: application('gmail-reply'), contact: contact('gmail-reply', { email: 'person@gmail-reply.example.com', emailEvidence: 'public page', recommendedChannel: 'Public Email' }) });
  const binding = {
    outreachId: 'outreach-gmail-reply',
    applicationId: draft.applicationId,
    duplicateKey: draft.duplicateKey,
    idempotencyKey: 'launchpad-v5:gmail-draft:outreach-gmail-reply:key',
    gmailDraftId: 'gd-reply',
    gmailMessageId: 'gm-outbound',
    gmailThreadId: 'gt-reply',
  };
  const calls = [];
  const result = await observeGmailReplies({
    binding,
    seenMessageIds: ['gm-seen'],
    transport: {
      async listMessages(request) {
        calls.push({ method: 'list', request });
        return [{ id: 'gm-outbound' }, { id: 'gm-wrong' }, { id: 'gm-reply' }, { id: 'gm-reply' }, { id: 'gm-seen' }];
      },
      async readMessage(request) {
        calls.push({ method: 'read', request });
        if (request.messageId === 'gm-outbound') return { id: 'gm-outbound', threadId: 'gt-reply', outreachId: binding.outreachId, duplicateKey: binding.duplicateKey, labelIds: ['SENT'] };
        if (request.messageId === 'gm-wrong') return { id: 'gm-wrong', threadId: 'gt-other', outreachId: binding.outreachId, duplicateKey: binding.duplicateKey, observedAt: OUTREACH_FIXTURE_NOW };
        if (request.messageId === 'gm-reply') return { id: 'gm-reply', threadId: 'gt-reply', outreachId: binding.outreachId, duplicateKey: binding.duplicateKey, labelIds: ['INBOX'], from: 'person@example.com', body: 'Thanks for reaching out.', observedAt: OUTREACH_FIXTURE_NOW };
        return null;
      },
    },
  });
  assert.equal(result.status, 'observed');
  assert.equal(result.replies.length, 1);
  assert.deepEqual(result.replies[0], {
    outreachId: binding.outreachId,
    applicationId: binding.applicationId,
    duplicateKey: binding.duplicateKey,
    idempotencyKey: binding.idempotencyKey,
    gmailMessageId: 'gm-reply',
    gmailThreadId: 'gt-reply',
    observedAt: OUTREACH_FIXTURE_NOW,
    from: 'person@example.com',
    subject: null,
    body: 'Thanks for reaching out.',
  });
  assert.deepEqual(calls.map(({ method }) => method), ['list', 'read', 'read', 'read']);
  assert.equal(calls.some(({ method }) => method.includes('write') || method.includes('create') || method.includes('update')), false);
});

test('observed reply Activity payload is schema-aware and preserves exact structured identity', async () => {
  const gateway = createFakeGateway();
  const current = application('schema-reply');
  gateway.pages.applications.push({ id: current.id, values: {} });
  const draft = buildOutreachDraft({ application: current, contact: contact('schema-reply') });
  const stored = await storeOutreachDraft({ gateway, draft });
  const binding = { outreachId: stored.page.id, applicationId: current.id, duplicateKey: draft.duplicateKey, idempotencyKey: 'gmail-schema-key', gmailDraftId: 'gd-schema', gmailThreadId: 'gt-schema' };
  const reply = { outreachId: stored.page.id, duplicateKey: draft.duplicateKey, gmailMessageId: 'gm-schema', gmailThreadId: 'gt-schema', observedAt: OUTREACH_FIXTURE_NOW };
  let mapped;
  const createPage = gateway.createPage.bind(gateway);
  gateway.createPage = async (target, values, options) => {
    if (target === 'activity') mapped = mapProperties('activity', values);
    return createPage(target, values, options);
  };
  await recordObservedReply({ gateway, outreach: { ...draft, id: stored.page.id }, application: current, binding, reply });
  assert.deepEqual(Object.keys(mapped).sort(), ['Action State', 'Event At', 'Event Type', 'Idempotency Key', 'Name', 'Notes', 'Application', 'Outreach'].sort());
  assert.equal(mapped['Idempotency Key'].rich_text[0].text.content, 'launchpad-v5:gmail-reply:' + draft.duplicateKey + ':gm-schema');
  assert.deepEqual(JSON.parse(mapped.Notes.rich_text[0].text.content), {
    provider: 'gmail',
    observation: 'reply',
    gmailMessageId: 'gm-schema',
    gmailThreadId: 'gt-schema',
    outreachId: stored.page.id,
    applicationId: current.id,
    duplicateKey: draft.duplicateKey,
    gmailDraftId: 'gd-schema',
    bindingIdempotencyKey: 'gmail-schema-key',
  });
});

test('Activity-create failure leaves both stop updates untouched', async () => {
  const gateway = createFakeGateway();
  const current = application('activity-failure');
  gateway.pages.applications.push({ id: current.id, values: {} });
  const draft = buildOutreachDraft({ application: current, contact: contact('activity-failure') });
  const stored = await storeOutreachDraft({ gateway, draft });
  const createPage = gateway.createPage.bind(gateway);
  gateway.createPage = async (target, values, options) => {
    if (target === 'activity') throw new Error('activity unavailable');
    return createPage(target, values, options);
  };
  const binding = { outreachId: stored.page.id, applicationId: current.id, duplicateKey: draft.duplicateKey, gmailThreadId: 'gt-failure' };
  const reply = { outreachId: stored.page.id, duplicateKey: draft.duplicateKey, gmailMessageId: 'gm-failure', gmailThreadId: 'gt-failure', observedAt: OUTREACH_FIXTURE_NOW };
  await assert.rejects(() => recordObservedReply({ gateway, outreach: { ...draft, id: stored.page.id }, application: current, binding, reply }), /activity unavailable/);
  assert.equal(gateway.calls.some((call) => call.method === 'updatePage' && ['outreach', 'applications'].includes(call.target)), false);
});

test('an update failure replays from one Activity and completes both stop updates', async () => {
  const gateway = createFakeGateway();
  const current = application('recovery-reply');
  gateway.pages.applications.push({ id: current.id, values: {} });
  const draft = buildOutreachDraft({ application: current, contact: contact('recovery-reply') });
  const stored = await storeOutreachDraft({ gateway, draft });
  const binding = { outreachId: stored.page.id, applicationId: current.id, duplicateKey: draft.duplicateKey, gmailThreadId: 'gt-recovery' };
  const reply = { outreachId: stored.page.id, duplicateKey: draft.duplicateKey, gmailMessageId: 'gm-recovery', gmailThreadId: 'gt-recovery', observedAt: OUTREACH_FIXTURE_NOW };
  const updatePage = gateway.updatePage.bind(gateway);
  let failApplicationUpdate = true;
  gateway.updatePage = async (target, id, values) => {
    if (target === 'applications' && failApplicationUpdate) {
      failApplicationUpdate = false;
      throw new Error('application stop unavailable');
    }
    return updatePage(target, id, values);
  };
  await assert.rejects(() => recordObservedReply({ gateway, outreach: { ...draft, id: stored.page.id }, application: current, binding, reply }), /application stop unavailable/);
  assert.equal(gateway.pages.activity.length, 1);
  const replay = await recordObservedReply({ gateway, outreach: { ...draft, id: stored.page.id }, application: current, binding, reply });
  assert.equal(replay.status, 'recovered');
  assert.equal(gateway.pages.activity.length, 1);
  assert.equal(gateway.pages.outreach[0].values.response, 'Replied');
  assert.equal(gateway.pages.outreach[0].values.draftState, 'Stopped');
  assert.equal(gateway.pages.applications[0].values.outreachState, 'Stopped');
  assert.equal(gateway.pages.applications[0].values.nextAction, null);
});

test('an exact observed reply stops the sequence and replay is a noop', async () => {
  const gateway = createFakeGateway();
  const current = application('observed-reply');
  gateway.pages.applications.push({ id: current.id, values: {} });
  const draft = buildOutreachDraft({ application: current, contact: contact('observed-reply', { email: 'person@observed-reply.example.com', emailEvidence: 'public page', recommendedChannel: 'Public Email' }) });
  const stored = await storeOutreachDraft({ gateway, draft });
  const binding = { outreachId: stored.page.id, applicationId: current.id, duplicateKey: draft.duplicateKey, idempotencyKey: 'gmail-key', gmailDraftId: 'gd-observed', gmailMessageId: 'gm-outbound-observed', gmailThreadId: 'gt-observed' };
  const reply = { outreachId: stored.page.id, duplicateKey: draft.duplicateKey, gmailMessageId: 'gm-inbound-observed', gmailThreadId: 'gt-observed', observedAt: OUTREACH_FIXTURE_NOW };
  const first = await recordObservedReply({ gateway, outreach: { ...draft, id: stored.page.id }, application: current, binding, reply });
  const repeated = await recordObservedReply({
    gateway,
    outreach: { ...draft, id: stored.page.id, response: 'Replied', outcome: 'Replied', nextEligibleContact: null, draftState: 'Stopped' },
    application: { ...current, outreachState: 'Stopped', nextAction: null },
    binding,
    reply,
  });
  assert.equal(first.status, 'observed');
  assert.equal(repeated.status, 'noop');
  assert.equal(gateway.pages.outreach[0].values.response, 'Replied');
  assert.equal(gateway.pages.outreach[0].values.nextEligibleContact, null);
  assert.equal(gateway.pages.applications[0].values.outreachState, 'Stopped');
  assert.equal(gateway.pages.activity.length, 1);
  assert.deepEqual(gateway.pages.activity[0].values.application, [current.id]);
  assert.deepEqual(gateway.pages.activity[0].values.outreach, [stored.page.id]);
});

test('follow-up stage order is enforced and follow-ups preserve immutable initial sentAt', async () => {
  const invalidGateway = createFakeGateway();
  const invalidApplication = application('invalid-jump');
  invalidGateway.pages.applications.push({ id: invalidApplication.id, values: {} });
  const invalidDraft = buildOutreachDraft({ application: invalidApplication, contact: contact('invalid-jump') });
  const invalidStored = await storeOutreachDraft({ gateway: invalidGateway, draft: invalidDraft });
  await assert.rejects(() => confirmManualSend({
    gateway: invalidGateway,
    outreach: { ...invalidDraft, id: invalidStored.page.id, sent: true, sentAt: OUTREACH_FIXTURE_NOW },
    application: invalidApplication,
    confirmation: { confirmed: true, confirmedBy: 'Onkar', sentAt: OUTREACH_FIXTURE_NOW },
    stage: 'Follow-up 2',
    now: OUTREACH_FIXTURE_NOW,
  }), (error) => error.code === 'STAGE_ORDER_INVALID');
  assert.equal(invalidGateway.calls.some((call) => call.method === 'updatePage' && call.target === 'outreach'), false);
  assert.equal(invalidGateway.pages.activity.length, 0);

  const gateway = createFakeGateway();
  const current = application('ordered-stages');
  gateway.pages.applications.push({ id: current.id, values: {} });
  const draft = buildOutreachDraft({ application: current, contact: contact('ordered-stages') });
  const stored = await storeOutreachDraft({ gateway, draft });
  const outreach = { ...draft, id: stored.page.id };
  await confirmManualSend({ gateway, outreach, application: current, confirmation: { confirmed: true, confirmedBy: 'Onkar', sentAt: OUTREACH_FIXTURE_NOW }, now: OUTREACH_FIXTURE_NOW });
  const initialSentAt = OUTREACH_FIXTURE_NOW;
  const sentOutreach = { ...outreach, sent: true, sentAt: initialSentAt };
  await confirmManualSend({ gateway, outreach: sentOutreach, application: current, confirmation: { confirmed: true, confirmedBy: 'Onkar', sentAt: '2026-07-26T12:00:00.000Z' }, stage: 'Follow-up 1', now: '2026-07-26T12:00:00.000Z' });
  await confirmManualSend({ gateway, outreach: sentOutreach, application: current, confirmation: { confirmed: true, confirmedBy: 'Onkar', sentAt: '2026-08-02T12:00:00.000Z' }, stage: 'Follow-up 2', now: '2026-08-02T12:00:00.000Z' });
  const followUps = gateway.calls.filter((call) => call.method === 'updatePage' && call.target === 'outreach').slice(1);
  assert.equal(followUps.length, 2);
  assert.equal(Object.hasOwn(followUps[0].values, 'sentAt'), false);
  assert.equal(Object.hasOwn(followUps[1].values, 'sentAt'), false);
  assert.equal(gateway.pages.outreach[0].values.sentAt, initialSentAt);
  assert.deepEqual(gateway.pages.activity.map((page) => page.values.eventType), ['Initial Sent', 'Follow-up 1 Sent', 'Follow-up 2 Sent']);
});
