import test from 'node:test';
import assert from 'node:assert/strict';
import { runContactResearch } from '../../crawler/contact-research.mjs';

const NOW = '2026-07-23T12:00:00.000Z';

function application(id, score, overrides = {}) {
  return {
    id,
    companyName: `Company ${id}`,
    role: 'AI Engineer',
    conversionScore: score,
    selected: true,
    verificationStatus: 'Verified',
    ...overrides,
  };
}

function candidate(id, overrides = {}) {
  return {
    personId: id,
    name: `Person ${id}`,
    currentRole: 'Engineering Manager',
    companyRelationship: 'Leads the team hiring for this role',
    contactUrl: `https://www.linkedin.com/in/${id}`,
    publicEvidence: [{ url: `https://company.example.test/team/${id}`, title: 'Team page' }],
    recommendedChannel: 'LinkedIn',
    confidence: 'High',
    ...overrides,
  };
}

test('research starts only for explicitly selected verified applications', async () => {
  const calls = [];
  const result = await runContactResearch({
    applications: [
      application('selected', 90),
      application('unselected', 100, { selected: false }),
      application('unverified', 99, { verificationStatus: 'Pending' }),
    ],
    providers: { hiringAuthors: async ({ application: app }) => { calls.push(app.id); return [candidate(app.id)]; } },
    now: NOW,
  });

  assert.deepEqual(calls, ['selected']);
  assert.deepEqual(result.researchedApplicationIds, ['selected']);
  assert.equal(result.planningOnly, true);
});

test('uses the strongest eight applications and caps contacts at two per application and ten total', async () => {
  const result = await runContactResearch({
    applications: Array.from({ length: 10 }, (_, index) => application(`app-${index}`, 100 - index)),
    providers: { publicProfiles: async ({ application: app }) => [candidate(`${app.id}-one`), candidate(`${app.id}-two`), candidate(`${app.id}-three`)] },
    now: NOW,
  });

  assert.equal(result.researchedApplicationIds.length, 8);
  assert.equal(result.contacts.length, 10);
  assert.deepEqual(result.contactsByApplication.map((row) => [row.applicationId, row.contacts.length]), [
    ['app-0', 2], ['app-1', 2], ['app-2', 2], ['app-3', 2], ['app-4', 2],
  ]);
  assert.equal(result.contacts.some(({ applicationId }) => applicationId === 'app-7'), false);
});

test('ranks hiring-post authors, recruiters, managers, leads, and founders ahead of generic contacts', async () => {
  const result = await runContactResearch({
    applications: [application('ranked', 90)],
    providers: { publicProfiles: async () => [
      candidate('generic', { currentRole: 'Software Engineer' }),
      candidate('founder', { currentRole: 'Founder and CTO' }),
      candidate('recruiter', { currentRole: 'Technical Recruiter' }),
      candidate('author', { currentRole: 'Engineering Manager', hiringPostAuthor: true }),
    ] },
    now: NOW,
  });

  assert.deepEqual(result.contacts.map(({ contact }) => contact.personId), ['author', 'recruiter']);
  assert.match(result.contacts[0].relevance, /hiring-post author/i);
});

test('deduplicates by application, person, and channel while retaining the strongest evidence', async () => {
  const result = await runContactResearch({
    applications: [application('one', 90), application('two', 80)],
    providers: {
      hiringAuthors: async ({ application: app }) => app.id === 'one' ? [candidate('same', { confidence: 'Low', publicEvidence: [{ url: 'https://weak.example.test' }] })] : [],
      publicProfiles: async ({ application: app }) => app.id === 'one'
        ? [candidate('same', { confidence: 'High', publicEvidence: [{ url: 'https://strong.example.test' }] }), candidate('same', { recommendedChannel: 'Referral' })]
        : [candidate('same')],
    },
    now: NOW,
  });

  assert.equal(result.contacts.filter(({ applicationId }) => applicationId === 'one').length, 2);
  assert.equal(result.contacts.find(({ applicationId, contact }) => applicationId === 'one' && contact.recommendedChannel === 'LinkedIn').evidenceUrl, 'https://strong.example.test/');
  assert.equal(new Set(result.contacts.map(({ duplicateKey }) => duplicateKey)).size, result.contacts.length);
});

test('includes evidence, confidence, relevance, and labels guessed email as unverified', async () => {
  const result = await runContactResearch({
    applications: [application('one', 90)],
    providers: { publicProfiles: async () => [candidate('guessed', { email: 'guessed@example.test', emailGuessed: true })] },
    now: NOW,
  });

  const lead = result.contacts[0];
  assert.equal(lead.evidenceUrl, 'https://company.example.test/team/guessed');
  assert.equal(lead.confidence, 'High');
  assert.ok(lead.relevance);
  assert.equal(lead.contact.email, null);
  assert.equal(lead.contact.guessedEmail, 'guessed@example.test');
  assert.equal(lead.contact.emailStatus, 'unverified');
  assert.equal(result.verifiedContactCount, 0);
});

test('returns planning-only no-write/no-send metadata and does not accept a gateway or sender', async () => {
  const result = await runContactResearch({
    applications: [application('one', 90)],
    providers: { publicProfiles: async () => [candidate('one')] },
    gateway: { createPage() { throw new Error('must not write'); } },
    sender: { send() { throw new Error('must not send'); } },
    now: NOW,
  });

  assert.deepEqual(result.actions, { writes: [], sends: [] });
  assert.equal(result.noAutoApply, true);
  assert.equal(result.noSend, true);
  assert.equal(result.researchedAt, NOW);
});
