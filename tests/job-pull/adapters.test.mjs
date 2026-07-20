import test from 'node:test';
import assert from 'node:assert/strict';
import { trackedCandidatesFromJson, runTrackedScan } from '../../job-pull/adapters/tracked.mjs';
import { reverseAtsCandidatesFromJson, REVERSE_ATS } from '../../job-pull/adapters/reverse-ats.mjs';
import { importPublicSearchCandidates } from '../../job-pull/adapters/public-search.mjs';
import { importIndeedCandidates } from '../../job-pull/adapters/indeed.mjs';
import { deriveProvider, normalizeSourceRecords } from '../../job-pull/adapters/common.mjs';

const record = {
  url: 'https://jobs.example.test/1', source: 'greenhouse-api', company: 'Example', title: 'AI Engineer', location: 'Pune', id: '1',
  postedAt: '2026-07-14T08:00:00.000Z', employment: { type: 'full-time' },
};

test('tracked and reverse ATS fixtures normalize provider and current-feed liveness', () => {
  const tracked = trackedCandidatesFromJson({ offers: [record] }, { runAt: '2026-07-14T09:00:00.000Z' });
  assert.equal(tracked.candidates[0].provider, 'greenhouse');
  assert.equal(tracked.candidates[0].liveness.status, 'Active');
  assert.equal(tracked.manifest.fetched, 1);

  const reverse = reverseAtsCandidatesFromJson({ offers: [{ ...record, source: 'ashby-full' }] }, { runAt: '2026-07-14T09:00:00.000Z' });
  assert.deepEqual(reverse.manifest.providers, REVERSE_ATS);
  assert.equal(reverse.candidates[0].provider, 'ashby');
});

test('reverse ATS degraded boards do not claim per-provider success without statuses', () => {
  const result = reverseAtsCandidatesFromJson({ offers: [], unreachableBoards: 1 });
  assert.ok(result.manifest.providerAttempts.every((attempt) => attempt.status === 'degraded'));
});

test('public search keeps Not Verified and Indeed is honestly unavailable', () => {
  const publicResult = importPublicSearchCandidates([record], { runAt: '2026-07-14T09:00:00.000Z' });
  assert.equal(publicResult.candidates[0].liveness.status, 'Not Verified');
  const indeed = importIndeedCandidates(null);
  assert.equal(indeed.candidates.length, 0);
  assert.equal(indeed.manifest.status, 'unavailable');
  assert.equal(indeed.manifest.reasonCode, 'INDEED_CONNECTOR_UNAVAILABLE');
});

test('scanner wrappers fail clearly when --json is not implemented', () => {
  assert.throws(() => runTrackedScan({ careerOpsDir: '/tmp', execute: () => 'human scanner output' }), /contract error.*expected JSON/);
});

test('known public ATS URLs classify as direct metadata without claiming a new scanner', () => {
  assert.equal(deriveProvider({ url: 'https://apply.workable.com/acme/j/1' }), 'workable');
  assert.equal(deriveProvider({ url: 'https://jobs.smartrecruiters.com/acme/1' }), 'smartrecruiters');
  assert.equal(deriveProvider({ url: 'https://acme.breezy.hr/p/1' }), 'breezy');
  assert.equal(deriveProvider({ url: 'https://acme.recruitee.com/o/1' }), 'recruitee');
  const [candidate] = normalizeSourceRecords([{ ...record, url: 'https://apply.workable.com/acme/j/1', source: 'public-search' }], {
    source: 'public-search', sourceKind: 'aggregator', runAt: '2026-07-14T09:00:00.000Z', currentFeedIsLive: false,
  });
  assert.equal(candidate.provider, 'workable');
  assert.equal(candidate.sourceKind, 'ats-direct');
  assert.equal(candidate.applicationResolution.status, 'Direct ATS');
});
