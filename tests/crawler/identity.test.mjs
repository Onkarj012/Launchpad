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

test('raw repeated observation alone does not suppress or start cooldown', () => {
  const first = resolveJobIdentity(base, {});
  const second = resolveJobIdentity(base, {
    existingJobs: [prior({
      lifecycle: 'observed',
      applicationReady: false,
      applicationResolution: { status: 'Unresolved' },
    })],
  });
  assert.equal(first.code, 'NEW_TO_ME');
  // Still incomplete on both sides — not newly actionable, not surfaced/cooldown.
  assert.equal(second.code, 'UNCHANGED_DUPLICATE');
  assert.equal(second.novelty, 'not_new');
  assert.notEqual(second.code.startsWith('SUPPRESSED_'), true);
});

test('incomplete prior observation that becomes application-ready is newly actionable once', () => {
  const incompletePrior = prior({
    lifecycle: 'observed',
    applicationReady: false,
    applicationResolution: { status: 'Unresolved' },
    fingerprint: fingerprintDescription(base.description),
  });
  const ready = resolveJobIdentity({
    ...base,
    applicationReady: true,
    applicationResolution: { status: 'Resolved Original' },
  }, { existingJobs: [incompletePrior] });

  assert.equal(ready.code, 'NEWLY_ACTIONABLE');
  assert.equal(ready.novelty, 'new_to_me');
  assert.equal(ready.evidence.classification.newlyActionable, true);

  const afterReady = resolveJobIdentity({
    ...base,
    applicationReady: true,
    applicationResolution: { status: 'Resolved Original' },
  }, {
    existingJobs: [prior({
      lifecycle: 'application-ready',
      applicationReady: true,
      applicationResolution: { status: 'Resolved Original' },
    })],
  });
  assert.equal(afterReady.code, 'UNCHANGED_DUPLICATE');
  assert.equal(afterReady.novelty, 'not_new');
});

test('surfaced lifecycle starts suppression; actioned states stay permanently suppressed', () => {
  const readyObservation = {
    ...base,
    applicationReady: true,
    applicationResolution: { status: 'Resolved Original' },
  };
  const surfaced = resolveJobIdentity(readyObservation, {
    existingJobs: [prior({ lifecycle: 'surfaced', applicationReady: true, surfaced: true })],
  });
  assert.equal(surfaced.code, 'SUPPRESSED_SURFACED');
  assert.equal(surfaced.novelty, 'not_new');

  for (const state of ['applied', 'contacted', 'interviewing', 'rejected']) {
    const result = resolveJobIdentity(readyObservation, {
      lifecycleRows: [{ canonicalUrl: base.canonicalUrl, state }],
      existingJobs: [prior({ lifecycle: 'observed', applicationReady: false })],
    });
    assert.equal(result.code, `SUPPRESSED_${state.toUpperCase()}`);
    assert.equal(result.novelty, 'not_new');
  }
});

test('material refresh re-evaluates without auto-reposting as new', () => {
  const refresh = resolveJobIdentity({
    ...base,
    description: 'Build reliable AI systems and mentor engineers.',
    applicationReady: true,
    applicationResolution: { status: 'Resolved Original' },
  }, {
    existingJobs: [prior({
      lifecycle: 'application-ready',
      applicationReady: true,
      applicationResolution: { status: 'Resolved Original' },
    })],
  });
  assert.equal(refresh.code, 'MATERIAL_REFRESH');
  assert.equal(refresh.novelty, 'not_new');
  assert.equal(refresh.evidence.classification.materialRefresh, true);
  assert.equal(refresh.evidence.classification.repost, false);
  assert.equal(refresh.evidence.classification.reevaluate, true);
});

test('idempotent re-resolution of the same newly-actionable transition does not change identity key', () => {
  const incompletePrior = prior({
    lifecycle: 'observed',
    applicationReady: false,
    applicationResolution: { status: 'Unresolved' },
  });
  const observation = {
    ...base,
    applicationReady: true,
    applicationResolution: { status: 'Resolved Original' },
  };
  const first = resolveJobIdentity(observation, { existingJobs: [incompletePrior] });
  const second = resolveJobIdentity(observation, { existingJobs: [incompletePrior] });
  assert.equal(first.code, 'NEWLY_ACTIONABLE');
  assert.equal(second.code, 'NEWLY_ACTIONABLE');
  assert.equal(first.identity.jobKey, second.identity.jobKey);
  assert.equal(first.identity.jobKey, 'job-existing');
});
