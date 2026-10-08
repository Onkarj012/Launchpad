import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REMOTEOK_FEED_URL,
  fetchRemoteOk,
  parseRemoteOkResponse,
} from '../../job-pull/remote-adapters/remoteok.mjs';
import { runRemoteSourcePlan, selectRemoteProviders, PRIMARY_REMOTE_PROVIDERS, SECONDARY_REMOTE_PROVIDERS } from '../../job-pull/remote-sources.mjs';
import { classifyCandidate } from '../../job-pull/eligibility.mjs';
import { loadConfig } from '../../job-pull/config.mjs';
import { resolveJobIdentity } from '../../crawler/identity.mjs';
import { applicationReadiness } from '../../job-pull/normal-readiness.mjs';

const FIXTURE = [
  { last_updated: 1720000000, legal: 'https://remoteok.com/legal' },
  {
    id: '1001',
    position: 'AI Engineer',
    company: 'Remoteok Co',
    location: 'Worldwide',
    tags: ['ai', 'worldwide'],
    date: '2026-07-20T12:00:00+00:00',
    url: 'https://remoteok.com/remote-jobs/1001-ai-engineer',
    description: 'Worldwide remote including India. Full-time. 0-1 years.',
  },
  {
    id: '1002',
    title: 'Backend Engineer',
    company: 'Board Co',
    location: 'USA',
    tags: ['python'],
    date: '2026-07-21T08:00:00+00:00',
    url: 'https://remoteok.com/remote-jobs/1002-backend',
    description: 'US-only remote role.',
  },
  {
    id: '1003',
    position: 'ML Engineer',
    company: 'Global Co',
    location: 'Remote - India',
    tags: ['ml'],
    epoch: 1721556000,
    url: 'https://remoteok.com/remote-jobs/1003-ml',
    description: 'India-eligible remote ML role. Full-time. 0-1 years.',
  },
];

test('remoteok parses a realistic metadata-first fixture into normalized candidates', async () => {
  const result = await fetchRemoteOk({ fetchJson: async (url, options) => {
    assert.equal(url, REMOTEOK_FEED_URL);
    assert.equal(options.redirect, 'error');
    return FIXTURE;
  } });
  assert.equal(result.records.length, 3);
  assert.equal(result.records[0].title, 'AI Engineer');
  assert.equal(result.records[0].company, 'Remoteok Co');
  assert.equal(result.records[0].provider, 'remoteok');
  assert.equal(result.records[0].providerDateField, 'date');
  assert.equal(result.records[0].providerDateEvidence, 'remoteok.date');
  assert.equal(result.records[0].feedPublishedAt, '2026-07-20T12:00:00.000Z');
  assert.equal(result.records[0].evidence.feedPublishedAt, '2026-07-20T12:00:00.000Z');
  assert.equal(result.records[1].title, 'Backend Engineer');
  assert.equal(result.records[1].countryRestrictionEvidence, 'USA only (Remote OK location)');
  assert.equal(result.records[2].title, 'ML Engineer');
  assert.ok(result.records[2].feedPublishedAt);
  assert.equal(result.telemetry.first24hEligible, true);
  assert.equal(result.telemetry.dated, 3);
});

test('remoteok handles malformed and empty responses gracefully', async () => {
  assert.deepEqual(parseRemoteOkResponse(null), []);
  assert.deepEqual(parseRemoteOkResponse({}), []);
  assert.deepEqual(parseRemoteOkResponse([]), []);
  assert.deepEqual(parseRemoteOkResponse([{ legal: 'x', last_updated: 1 }]), []);
  await assert.rejects(
    () => fetchRemoteOk({ fetchJson: async () => ({ jobs: [] }) }),
    /expected a JSON array/,
  );
  await assert.rejects(
    () => fetchRemoteOk({}),
    /injected fetchJson/,
  );
  const empty = await fetchRemoteOk({ fetchJson: async () => [{ legal: 'only-meta' }] });
  assert.equal(empty.records.length, 0);
  assert.equal(empty.telemetry.dated, 0);
});

test('remoteok publication timestamps are feed evidence distinct from employer-posted evidence', async () => {
  const outputs = await runRemoteSourcePlan({
    providerFetchers: { remoteok: { fetchJson: async () => FIXTURE } },
    runAt: '2026-07-23T10:00:00.000Z',
    runId: 'remoteok-date-evidence',
  });
  const lane = outputs.find((item) => item.manifest.sourceId === 'remoteok');
  assert.equal(lane.manifest.status, 'ok');
  const candidate = lane.candidates[0];
  assert.equal(candidate.feedPublishedAt, '2026-07-20T12:00:00.000Z');
  assert.equal(candidate.evidence.feedPublishedAt, '2026-07-20T12:00:00.000Z');
  assert.equal(candidate.providerDateEvidence.dateEvidence, 'remoteok.date');
  assert.equal(candidate.providerDateEvidence.dateField, 'date');
  // postedAt may carry the feed clock for ranking, but evidence labels it as feed not employer.
  assert.equal(candidate.postedAt, candidate.feedPublishedAt);
  assert.equal(candidate.evidence.providerDate.dateEvidence, 'remoteok.date');
});

test('Himalayas is primary; secondaries respect secondaryCadenceDays budget gate', () => {
  assert.deepEqual(PRIMARY_REMOTE_PROVIDERS, ['himalayas']);
  assert.ok(SECONDARY_REMOTE_PROVIDERS.includes('remoteok'));
  const forceAll = selectRemoteProviders({ forceAll: true });
  assert.ok(forceAll.includes('himalayas'));
  assert.ok(forceAll.includes('remoteok'));
  assert.ok(forceAll.includes('remotive'));

  // dayIndex for 2026-07-24 UTC is even under cadence=2 → secondaries included
  const onDay = selectRemoteProviders({
    remoteConfig: { secondaryCadenceDays: 2 },
    runAt: '2026-07-24T04:30:00.000Z',
    forceAll: false,
  });
  assert.ok(onDay.includes('himalayas'));
  assert.ok(onDay.includes('jobicy'));

  // pick an adjacent day so dayIndex % 2 !== 0 under the same cadence
  const offDay = selectRemoteProviders({
    remoteConfig: { secondaryCadenceDays: 2 },
    runAt: '2026-07-25T04:30:00.000Z',
    forceAll: false,
  });
  assert.deepEqual(offDay, ['himalayas']);
});

test('remote lead without India/worldwide-compatible scope is rejected by existing eligibility policy', () => {
  const policy = loadConfig();
  const usOnly = classifyCandidate({
    title: 'Backend Engineer',
    company: 'Board Co',
    location: 'USA',
    description: 'US-only remote role. Must be based in the United States.',
    workMode: 'remote',
    sourceCategory: 'broad-remote',
    provider: 'remoteok',
  }, policy);
  assert.equal(usOnly.geo.pass, false);

  const worldwide = classifyCandidate({
    title: 'AI Engineer',
    company: 'Remoteok Co',
    location: 'Worldwide',
    description: 'Worldwide remote including India. Full-time. 0-1 years.',
    workMode: 'remote',
    sourceCategory: 'broad-remote',
    provider: 'remoteok',
  }, policy);
  assert.equal(worldwide.geo.pass, true);
});

test('remote board lead is not application-ready until original employer destination is resolved', () => {
  const eligibility = {
    eligible: true,
    reasons: [],
    geo: { pass: true, code: 'GEO_REMOTE_INDIA_ELIGIBLE' },
  };
  const unresolved = applicationReadiness({
    title: 'AI Engineer',
    company: 'Remoteok Co',
    canonicalUrl: 'https://remoteok.com/remote-jobs/1001-ai-engineer',
    originalApplicationUrl: null,
    applicationResolution: { status: 'Unresolved', evidence: null },
    liveness: { status: 'Active', evidence: 'fixture' },
    experience: { minYears: 0, maxYears: 1, evidence: '0-1 years' },
    employment: { type: 'full-time', evidence: 'full-time' },
  }, eligibility);
  assert.equal(unresolved.ready, false);
  assert.ok(unresolved.reasons.some((reason) => /ORIGINAL_APPLICATION/i.test(reason)));

  const resolved = applicationReadiness({
    description: 'Build Python AI services. Full-time, 0-1 years.',
    title: 'AI Engineer',
    company: 'Remoteok Co',
    canonicalUrl: 'https://remoteok.com/remote-jobs/1001-ai-engineer',
    originalApplicationUrl: 'https://jobs.ashbyhq.com/remoteokco/abc',
    applicationResolution: { status: 'Resolved Original', evidence: 'resolver employer ATS' },
    originalApplicationEvidence: 'resolver employer ATS',
    liveness: { status: 'Active', evidence: 'fixture' },
    experience: { minYears: 0, maxYears: 1, evidence: '0-1 years' },
    employment: { type: 'full-time', evidence: 'full-time' },
  }, eligibility);
  assert.equal(resolved.ready, true);
});

test('duplicate remote board and direct ATS postings converge on one identity', () => {
  const ats = {
    provider: 'ashby',
    providerJobId: 'abc-123',
    canonicalUrl: 'https://jobs.ashbyhq.com/acme/abc-123',
    company: 'Acme Inc',
    title: 'AI Engineer',
    location: 'Remote - India',
    description: 'Build AI systems. Full-time. India remote.',
    postedAt: '2026-07-20T10:00:00.000Z',
  };
  const remote = {
    provider: 'remoteok',
    canonicalUrl: 'https://remoteok.com/remote-jobs/999-ai-engineer',
    originalApplicationUrl: 'https://jobs.ashbyhq.com/acme/abc-123',
    company: 'Acme Inc',
    title: 'AI Engineer',
    location: 'Remote - India',
    description: 'Build AI systems. Full-time. India remote.',
    postedAt: '2026-07-21T10:00:00.000Z',
  };
  const first = resolveJobIdentity(ats, {});
  assert.equal(first.code, 'NEW_TO_ME');
  const second = resolveJobIdentity(remote, {
    existingJobs: [{
      jobKey: first.identity.jobKey,
      provider: 'ashby',
      providerJobId: 'abc-123',
      canonicalUrl: ats.canonicalUrl,
      company: ats.company,
      title: ats.title,
      location: ats.location,
      fingerprint: first.fingerprint,
    }],
  });
  assert.equal(second.code, 'UNCHANGED_DUPLICATE');
  assert.equal(second.novelty, 'not_new');
  assert.equal(second.identity.jobKey, first.identity.jobKey);
});
