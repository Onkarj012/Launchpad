import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintDescription,
  resolveJobIdentity,
} from '../../crawler/identity.mjs';

const base = {
  provider: 'Greenhouse',
  providerJobId: '123',
  canonicalUrl: 'https://jobs.example.com/role/123?utm_source=feed',
  company: 'Acme, Inc.',
  title: 'AI Engineer',
  location: 'Pune, India',
  description: 'Build reliable AI systems for customers.',
  observedAt: '2026-07-23T10:00:00.000Z',
  postedAt: '2026-07-22T10:00:00.000Z',
  status: 'open',
};

const prior = (overrides = {}) => ({
  jobKey: 'job-existing',
  provider: 'greenhouse',
  providerJobId: '123',
  canonicalUrl: 'https://jobs.example.com/role/123',
  company: 'acme inc',
  title: 'ai engineer',
  location: 'pune, india',
  fingerprint: fingerprintDescription(base.description),
  firstSeenAt: '2026-07-20T10:00:00.000Z',
  lastSeenAt: '2026-07-22T10:00:00.000Z',
  ...overrides,
});

test('cross-source observations reconcile by stable identity evidence in priority order', () => {
  const providerMatch = resolveJobIdentity({ ...base, canonicalUrl: 'https://mirror.example/role/123' }, {
    existingJobs: [prior()],
  });
  assert.equal(providerMatch.evidence.matchType, 'provider_job_id');

  const result = resolveJobIdentity({ ...base, provider: 'board-mirror', providerJobId: 'mirror-9' }, {
    existingJobs: [prior()],
  });

  assert.equal(result.code, 'UNCHANGED_DUPLICATE');
  assert.equal(result.novelty, 'not_new');
  assert.equal(result.identity.jobKey, 'job-existing');
  assert.equal(result.evidence.matchType, 'canonical_url');
  assert.equal(result.evidence.fingerprint.same, true);
});

test('prior lifecycle rows suppress novelty without becoming crawler application authority', () => {
  for (const state of ['surfaced', 'applied', 'contacted', 'rejected', 'cooldown']) {
    const result = resolveJobIdentity(base, {
      lifecycleRows: [{ canonicalUrl: base.canonicalUrl, state }],
    });
    assert.equal(result.code, `SUPPRESSED_${state.toUpperCase()}`);
    assert.equal(result.novelty, 'not_new');
    assert.equal(result.authority, 'external_lifecycle_data');
  }
});

test('opportunity-ledger action_state suppresses novelty through the operator contract', () => {
  const observation = { ...base, canonicalUrl: 'https://jobs.example.test/ledger-state' };
  const result = resolveJobIdentity(observation, {
    lifecycleRows: [{
      canonical_url: observation.canonicalUrl,
      action_state: 'applied',
    }],
  });

  assert.equal(result.code, 'SUPPRESSED_APPLIED');
  assert.equal(result.novelty, 'not_new');
});

test('same identity distinguishes material refresh, repost, and closure', () => {
  const refresh = resolveJobIdentity({ ...base, description: 'Build reliable AI systems and mentor engineers.' }, {
    existingJobs: [prior()],
  });
  assert.equal(refresh.code, 'MATERIAL_REFRESH');
  assert.equal(refresh.novelty, 'not_new');

  const repost = resolveJobIdentity({ ...base, postedAt: '2026-07-23T09:00:00.000Z', description: 'Build reliable AI systems for customers.' }, {
    existingJobs: [prior({ status: 'closed', closedAt: '2026-07-22T12:00:00.000Z' })],
  });
  assert.equal(repost.code, 'REPOST');
  assert.equal(repost.novelty, 'new_to_me');

  const closure = resolveJobIdentity({ ...base, status: 'closed', description: '' }, {
    existingJobs: [prior()],
  });
  assert.equal(closure.code, 'CLOSURE');
  assert.equal(closure.novelty, 'not_new');
});

test('ambiguous fallback collisions fail closed with all candidate evidence', () => {
  const result = resolveJobIdentity({
    ...base,
    provider: null,
    providerJobId: null,
    canonicalUrl: null,
  }, {
    existingJobs: [prior({ jobKey: 'job-a', providerJobId: null, canonicalUrl: null }), prior({ jobKey: 'job-b', providerJobId: null, canonicalUrl: null })],
  });

  assert.equal(result.code, 'AMBIGUOUS_COLLISION');
  assert.equal(result.novelty, 'not_new');
  assert.deepEqual(result.evidence.candidates.map((candidate) => candidate.jobKey), ['job-a', 'job-b']);
});

test('first-seen observation is new to me and gets a durable deterministic key', () => {
  const result = resolveJobIdentity(base, {});

  assert.equal(result.code, 'NEW_TO_ME');
  assert.equal(result.novelty, 'new_to_me');
  assert.match(result.identity.jobKey, /^[a-f0-9]{64}$/);
  assert.equal(result.evidence.matchType, null);
  assert.equal(resolveJobIdentity(base, {}).identity.jobKey, result.identity.jobKey);
});
