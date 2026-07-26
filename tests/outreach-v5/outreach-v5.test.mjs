import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { application, contact, createFakeGateway, OUTREACH_FIXTURE_NOW, providersFor } from '../fixtures/outreach-v5.mjs';
import { normalizeContactEvidence } from '../../outreach-v5/evidence.mjs';
import { buildOutreachDraft, storeOutreachDraft } from '../../outreach-v5/draft.mjs';
import { OUTREACH_CADENCE, cadencePlan, deriveOutreachState, dueCadenceAction } from '../../outreach-v5/cadence.mjs';
import { confirmManualSend, prepareOutreach, persistOutreach, recordOutreachOutcome } from '../../outreach-v5/workflow.mjs';
import { outreachActivityKey, outreachDuplicateKey } from '../../outreach-v5/idempotency.mjs';
import { researchContact } from '../../outreach-v5/research.mjs';
import { normalizeNotionOutreachState, normalizeOutreachPage } from '../../outreach-v5/notion-normalizers.mjs';
import { buildOutreachQueue } from '../../outreach-v5/queue.mjs';
import { approveContactReview, buildContactReviewCard } from '../../outreach-v5/review.mjs';
import * as gmailDraftModule from '../../outreach-v5/gmail-draft.mjs';
import { approvedMessageDigest, createApprovedGmailDraft, OUTREACH_DELIVERY_CAPABILITIES } from '../../outreach-v5/gmail-draft.mjs';

function notionProperty(type, value) {
  if (type === 'title' || type === 'rich_text') return { type, [type]: [{ plain_text: String(value) }] };
  if (type === 'relation') return { type, relation: value.map((id) => ({ id })) };
  if (type === 'date') return { type, date: value ? { start: value } : null };
  if (type === 'select') return { type, select: value ? { name: value } : null };
  return { type, [type]: value };
}

function reviewedContact(id, overrides = {}) {
  return contact(id, { observedAt: OUTREACH_FIXTURE_NOW, ...overrides });
}

function approvalFor(current, overrides = {}) {
  return {
    approved: true,
    approvedBy: 'Onkar',
    approvedAt: OUTREACH_FIXTURE_NOW,
    personId: current.personId,
    channel: current.recommendedChannel,
    ...overrides,
  };
}

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

test('raw Notion rows normalize to the same stable outreach domain shape', () => {
  const rawOutreach = {
    id: 'outreach-raw',
    properties: {
      Name: notionProperty('title', 'Acme | Person | LinkedIn'),
      Application: notionProperty('relation', ['app-raw']),
      Person: notionProperty('rich_text', 'Person Raw'),
      Channel: notionProperty('select', 'LinkedIn'),
      'Contact URL': { type: 'url', url: 'https://www.linkedin.com/in/raw' },
      'Sent?': notionProperty('checkbox', false),
      'Duplicate Key': notionProperty('rich_text', 'sequence-raw'),
      'Draft State': notionProperty('select', 'Draft'),
    },
  };
  const domainOutreach = {
    id: 'outreach-raw',
    name: 'Acme | Person | LinkedIn',
    applicationIds: ['app-raw'],
    person: 'Person Raw',
    channel: 'LinkedIn',
    contactUrl: 'https://www.linkedin.com/in/raw',
    sent: false,
    duplicateKey: 'sequence-raw',
    draftState: 'Draft',
  };
  assert.deepEqual(normalizeOutreachPage(rawOutreach), normalizeOutreachPage(domainOutreach));
  const allStores = normalizeNotionOutreachState({
    applications: [{ id: 'app-raw', properties: { Role: notionProperty('rich_text', 'AI Engineer') } }],
    outreach: [rawOutreach],
    activity: [{ id: 'activity-raw', properties: { Application: notionProperty('relation', ['app-raw']), 'Event Type': notionProperty('select', 'Initial Sent') } }],
    companies: [{ id: 'company-raw', properties: { Name: notionProperty('title', 'Acme') } }],
    referrals: [{ id: 'referral-raw', properties: { Application: notionProperty('relation', ['app-raw']), Person: notionProperty('rich_text', 'Referrer') } }],
  });
  assert.deepEqual(Object.fromEntries(Object.entries(allStores).map(([key, rows]) => [key, rows.length])), { applications: 1, outreach: 1, activity: 1, companies: 1, referrals: 1 });
});

test('outreach queue rejects terminal or unready rows and retains the complete evidence packet', () => {
  const company = {
    id: 'company-1',
    name: 'Acme',
    careerPageUrl: 'https://acme.example/careers',
    canonicalDomain: 'acme.example',
    lastVerified: OUTREACH_FIXTURE_NOW,
  };
  const evidence = {
    role: 'AI Engineer',
    companyIds: ['company-1'],
    companyName: 'Acme',
    status: 'Ready',
    applicationReady: true,
    makeResume: true,
    resumeState: 'Ready',
    hook: 'A verified company-specific hook.',
    approvedProofPoint: 'A truthful approved proof point.',
    originalApplicationUrl: 'https://acme.example/jobs/ai',
    resumeArtifact: { applicationId: 'ready', company: 'Acme', role: 'AI Engineer', pdfPath: '/tmp/acme.pdf', state: 'Ready' },
  };
  const queue = buildOutreachQueue({
    applications: [
      { id: 'ready', ...evidence },
      { id: 'terminal', ...evidence, status: 'Rejected' },
      { id: 'unready', ...evidence, applicationReady: false },
    ],
    companies: [company],
  });
  assert.deepEqual(queue.ready.map(({ id }) => id), ['ready']);
  assert.equal(queue.ready[0].approvedProofPoint, evidence.approvedProofPoint);
  assert.equal(queue.ready[0].originalApplicationUrl, evidence.originalApplicationUrl);
  assert.equal(queue.ready[0].resumeArtifact.pdfPath, '/tmp/acme.pdf');
  assert.equal(queue.ready[0].companyEvidence.canonicalDomain, 'acme.example');
  assert.ok(queue.blocked.find(({ applicationId }) => applicationId === 'terminal').blockers.includes('APPLICATION_TERMINAL'));
  assert.ok(queue.blocked.find(({ applicationId }) => applicationId === 'unready').blockers.includes('APPLICATION_NOT_READY'));
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
  const contactApprovals = Object.fromEntries(apps.map((app) => [app.id, approvalFor(reviewedContact(app.id))]));
  const prepared = await prepareOutreach({ applications: apps, providers: providersFor(), contactApprovals, deepLimit: 6, now: OUTREACH_FIXTURE_NOW });
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.deepCount, 6);
  assert.equal(prepared.lightCount, 2);
  assert.equal(prepared.results[0].draft.depth, 'deep');
  assert.equal(prepared.results.at(-1).draft.depth, 'light');
});

test('attachment preparation requires exact Ready resume state and matching role artifact', () => {
  const base = application('resume-app', 95, { resumeState: 'Not Started' });
  const currentContact = reviewedContact('resume-app');
  const approval = approvalFor(currentContact);
  const artifact = { applicationId: 'resume-app', company: base.companyName, role: base.role, pdfPath: '/tmp/role.pdf', state: 'Ready' };
  assert.throws(() => buildOutreachDraft({ application: base, contact: currentContact, approval, attachmentExpected: true, resumeArtifact: artifact }), (error) => error.code === 'RESUME_NOT_READY');
  const ready = { ...base, resumeState: 'Ready' };
  assert.throws(() => buildOutreachDraft({ application: ready, contact: currentContact, approval, attachmentExpected: true, resumeArtifact: { ...artifact, role: 'Different Role' } }), (error) => error.code === 'RESUME_ROLE_MISMATCH');
  const draft = buildOutreachDraft({ application: ready, contact: currentContact, approval, attachmentExpected: true, resumeArtifact: artifact });
  assert.equal(draft.attachmentExpected, true);
  assert.match(draft.body, /attached the exact role-specific resume/);
});

test('draft storage keeps compact properties, full body, and prevents duplicate pages', async () => {
  const gateway = createFakeGateway();
  const currentContact = reviewedContact('store-app');
  const draft = buildOutreachDraft({ application: application('store-app'), contact: currentContact, approval: approvalFor(currentContact) });
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
  const currentContact = reviewedContact('send-app');
  const draft = buildOutreachDraft({ application: app, contact: currentContact, approval: approvalFor(currentContact) });
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
  const currentContact = reviewedContact('response-app');
  const draft = buildOutreachDraft({ application: app, contact: currentContact, approval: approvalFor(currentContact) });
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
  const before = deriveOutreachState({ application: application('cadence'), sequence: { sent: true, initialSentAt: '2026-07-01T09:00:00.000Z' }, now: '2026-07-04T09:00:00.000Z' });
  assert.equal(before.nextAction, 'Follow-up 1');
  assert.equal(before.due, true);
  const stopped = deriveOutreachState({ application: application('cadence'), sequence: { sent: true, initialSentAt: '2026-07-01T09:00:00.000Z', response: 'Replied' }, now: '2026-07-20T09:00:00.000Z' });
  assert.equal(stopped.state, 'Stopped');
  assert.equal(stopped.nextAction, null);
  const closed = dueCadenceAction({ application: application('cadence'), sequence: { sent: true, initialSentAt: '2026-07-01T09:00:00.000Z' }, activities: [
    { eventType: 'Follow-up 1 Sent', eventAt: '2026-07-04T09:00:00.000Z' },
    { eventType: 'Follow-up 2 Sent', eventAt: '2026-07-11T09:00:00.000Z' },
  ], now: '2026-07-18T09:00:00.000Z' });
  assert.equal(closed.action, 'Close');
  const silentClosure = dueCadenceAction({ application: application('cadence'), sequence: { sent: true, initialSentAt: '2026-07-01T09:00:00.000Z' }, now: '2026-07-18T09:00:00.000Z' });
  assert.equal(silentClosure.action, 'Close');
  const rawSequence = {
    id: 'raw-cadence',
    properties: {
      'Sent?': notionProperty('checkbox', true),
      'Initial Sent At': notionProperty('date', '2026-07-01T09:00:00.000Z'),
    },
  };
  assert.equal(dueCadenceAction({ application: application('cadence'), sequence: rawSequence, now: '2026-07-04T09:00:00.000Z' }).action, 'Follow-up 1');
});

test('batch persistence preserves no-contact and draft-blocked outcomes without external writes', async () => {
  const gateway = createFakeGateway();
  const prepared = await prepareOutreach({
    applications: [application('ok'), application('blocked', 89, { resumeState: 'Not Started' })],
    providers: providersFor(),
    contactApprovals: {
      ok: approvalFor(reviewedContact('ok')),
      blocked: approvalFor(reviewedContact('blocked')),
    },
    attachmentExpected: (current) => current.id === 'blocked',
    now: OUTREACH_FIXTURE_NOW,
  });
  const persisted = await persistOutreach({ gateway, prepared });
  assert.equal(persisted.status, 'partial');
  assert.equal(gateway.pages.outreach.length, 1);
  assert.equal(persisted.results.find((result) => result.applicationId === 'blocked').status, 'draft-blocked');
});

test('contact review requires human person and channel approval and enforces suppression', () => {
  const app = application('review');
  const currentContact = reviewedContact('review');
  const card = buildContactReviewCard({ application: app, contact: currentContact, now: OUTREACH_FIXTURE_NOW });
  assert.equal(card.application.id, app.id);
  assert.equal(card.currentRole, 'Engineering Manager');
  assert.equal(card.email.status, 'Missing');
  assert.equal(card.evidence.observedAt, OUTREACH_FIXTURE_NOW);
  assert.throws(() => buildOutreachDraft({ application: app, contact: currentContact }), (error) => error.code === 'CONTACT_APPROVAL_REQUIRED');
  assert.throws(() => approveContactReview({ card, approval: approvalFor(currentContact, { channel: 'Email' }) }), (error) => error.code === 'APPROVED_CHANNEL_MISMATCH');
  const suppressed = buildContactReviewCard({
    application: app,
    contact: currentContact,
    personHistory: [{ personId: currentContact.personId, initialSentAt: '2026-07-20T12:00:00.000Z' }],
    companyHistory: [{ companyName: app.companyName, initialSentAt: '2026-07-22T12:00:00.000Z' }],
    now: OUTREACH_FIXTURE_NOW,
  });
  assert.deepEqual(suppressed.suppression.reasons, ['PERSON_SILENCE_WINDOW', 'COMPANY_SILENCE_WINDOW']);
  assert.throws(() => approveContactReview({ card: suppressed, approval: approvalFor(currentContact) }), (error) => error.code === 'CONTACT_SUPPRESSED');
});

test('partial send confirmation rolls back Outreach and Application state', async () => {
  const gateway = createFakeGateway();
  const app = application('atomic-send', 90, { outreachState: null, nextAction: null });
  gateway.pages.applications.push({ id: app.id, values: { outreachState: null, nextAction: null } });
  const currentContact = reviewedContact('atomic-send');
  const draft = buildOutreachDraft({ application: app, contact: currentContact, approval: approvalFor(currentContact) });
  const stored = await storeOutreachDraft({ gateway, draft });
  const createPage = gateway.createPage;
  gateway.createPage = async (target, values, options) => {
    if (target === 'activity') throw new Error('synthetic activity failure');
    return createPage(target, values, options);
  };
  await assert.rejects(() => confirmManualSend({
    gateway,
    outreach: { ...draft, id: stored.page.id },
    application: app,
    confirmation: { confirmed: true, confirmedBy: 'Onkar', sentAt: OUTREACH_FIXTURE_NOW },
    now: OUTREACH_FIXTURE_NOW,
  }), (error) => error.code === 'TRANSACTION_ABORTED');
  assert.equal(gateway.pages.outreach[0].values.sent, false);
  assert.equal(gateway.pages.outreach[0].values.sentAt, null);
  assert.equal(gateway.pages.outreach[0].values.draftState, 'Draft');
  assert.equal(gateway.pages.applications[0].values.outreachState, null);
  assert.equal(gateway.pages.applications[0].values.nextAction, null);
  assert.equal(gateway.pages.activity.length, 0);
});

test('immutable initial cadence anchor survives follow-up and Activity identifies the exact sequence', async () => {
  const gateway = createFakeGateway();
  const app = application('cadence-send');
  gateway.pages.applications.push({ id: app.id, values: {} });
  const currentContact = reviewedContact('cadence-send');
  const draft = buildOutreachDraft({ application: app, contact: currentContact, approval: approvalFor(currentContact) });
  const stored = await storeOutreachDraft({ gateway, draft });
  await confirmManualSend({
    gateway,
    outreach: { ...draft, id: stored.page.id },
    application: app,
    confirmation: { confirmed: true, confirmedBy: 'Onkar', sentAt: '2026-07-01T09:00:00.000Z' },
    now: '2026-07-01T09:00:00.000Z',
  });
  const sequence = { ...draft, ...gateway.pages.outreach[0].values, id: stored.page.id };
  await confirmManualSend({
    gateway,
    outreach: sequence,
    application: { ...app, ...gateway.pages.applications[0].values },
    activities: gateway.pages.activity.map(({ values }) => values),
    stage: 'Follow-up 1',
    confirmation: { confirmed: true, confirmedBy: 'Onkar', sentAt: '2026-07-04T09:00:00.000Z' },
    now: '2026-07-04T09:00:00.000Z',
  });
  assert.equal(gateway.pages.outreach[0].values.initialSentAt, '2026-07-01T09:00:00.000Z');
  assert.equal(gateway.pages.outreach[0].values.sentAt, '2026-07-04T09:00:00.000Z');
  assert.deepEqual(gateway.pages.activity.map(({ values }) => values.outreachKey), [draft.duplicateKey, draft.duplicateKey]);
});

test('early or out-of-order follow-up confirmation is rejected', async () => {
  const gateway = createFakeGateway();
  const app = application('cadence-order');
  gateway.pages.applications.push({ id: app.id, values: {} });
  const currentContact = reviewedContact('cadence-order');
  const draft = buildOutreachDraft({ application: app, contact: currentContact, approval: approvalFor(currentContact) });
  const stored = await storeOutreachDraft({ gateway, draft });
  const sequence = { ...draft, id: stored.page.id, sent: true, sentAt: '2026-07-01T09:00:00.000Z', initialSentAt: '2026-07-01T09:00:00.000Z' };
  await assert.rejects(() => confirmManualSend({
    gateway,
    outreach: sequence,
    application: app,
    stage: 'Follow-up 2',
    confirmation: { confirmed: true, confirmedBy: 'Onkar', sentAt: '2026-07-04T09:00:00.000Z' },
    now: '2026-07-04T09:00:00.000Z',
  }), (error) => error.code === 'CADENCE_ORDER_INVALID');
  await assert.rejects(() => confirmManualSend({
    gateway,
    outreach: sequence,
    application: app,
    stage: 'Follow-up 1',
    confirmation: { confirmed: true, confirmedBy: 'Onkar', sentAt: '2026-07-02T09:00:00.000Z' },
    now: '2026-07-02T09:00:00.000Z',
  }), (error) => error.code === 'CADENCE_ORDER_INVALID');
});

test('the same person cannot run parallel Email and LinkedIn sequences', () => {
  const app = application('parallel');
  const currentContact = reviewedContact('parallel');
  const card = buildContactReviewCard({
    application: app,
    contact: currentContact,
    activeSequences: [{ personId: currentContact.personId, channel: 'Email', draftState: 'Sent' }],
    now: OUTREACH_FIXTURE_NOW,
  });
  assert.ok(card.suppression.reasons.includes('ACTIVE_PERSON_SEQUENCE'));
  assert.ok(card.suppression.reasons.includes('PARALLEL_PERSON_CHANNEL'));
  assert.throws(() => approveContactReview({ card, approval: approvalFor(currentContact) }), (error) => error.code === 'CONTACT_SUPPRESSED');
});

test('Gmail draft attaches the exact verified PDF and stores its digest', async () => {
  const gateway = createFakeGateway();
  const app = application('gmail', 95, { resumeState: 'Ready' });
  const pdfPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'launchpad-gmail-')), 'role.pdf');
  const pdf = Buffer.from('%PDF-1.4\nverified fixture\n%%EOF\n');
  writeFileSync(pdfPath, pdf);
  const digest = createHash('sha256').update(pdf).digest('hex');
  const currentContact = reviewedContact('gmail', {
    email: 'person@gmail.example',
    emailEvidence: 'Public company recruiting page',
    recommendedChannel: 'Email',
  });
  const draft = buildOutreachDraft({
    application: app,
    contact: currentContact,
    approval: approvalFor(currentContact),
    attachmentExpected: true,
    resumeArtifact: { applicationId: app.id, company: app.companyName, role: app.role, pdfPath, state: 'Ready', digest },
  });
  gateway.pages.outreach.push({ id: 'outreach-gmail', values: {} });
  const messageDigest = approvedMessageDigest({ recipient: draft.email, subject: draft.subject, body: draft.body });
  let payload;
  const result = await createApprovedGmailDraft({
    enabled: true,
    gateway,
    outreach: { id: 'outreach-gmail' },
    draft,
    messageApproval: { approved: true, approvedBy: 'Onkar', approvedAt: OUTREACH_FIXTURE_NOW, messageDigest },
    draftCreator: { createDraft: async (input) => { payload = input; return { id: 'gmail-draft-1' }; } },
  });
  assert.equal(result.attachmentDigest, digest);
  assert.equal(gateway.pages.outreach[0].values.gmailDraftId, 'gmail-draft-1');
  assert.equal(gateway.pages.outreach[0].values.attachmentDigest, digest);
  assert.match(Buffer.from(payload.raw, 'base64url').toString(), /Content-Type: application\/pdf/);
});

test('outreach exposes drafts and copy text only, with no send operation reachable', async () => {
  assert.deepEqual(OUTREACH_DELIVERY_CAPABILITIES, ['gmail.drafts.create', 'linkedin.copy-text']);
  assert.deepEqual(Object.keys(gmailDraftModule).filter((name) => /send/iu.test(name)), []);
  await assert.rejects(() => createApprovedGmailDraft(), (error) => error.code === 'GMAIL_DRAFT_DISABLED');
  const gateway = createFakeGateway();
  await assert.rejects(() => createApprovedGmailDraft({
    enabled: true,
    gateway,
    outreach: { id: 'outreach-no-email' },
    draft: { applicationId: 'app', channel: 'Email', email: null },
    messageApproval: { approved: true },
    draftCreator: { createDraft: async () => ({ id: 'draft' }), send: async () => {} },
  }), (error) => error.code === 'EMAIL_REQUIRED');
});
