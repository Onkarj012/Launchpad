import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWarmAts } from '../../crawler/ats-warm.mjs';

test('fetches complete direct jobs from Greenhouse, Lever, and Ashby warm boards', async () => {
  const result = await fetchWarmAts({
    boards: [
      { provider: 'greenhouse', slug: 'acme', company: 'Acme' },
      { provider: 'lever', slug: 'beta', company: 'Beta' },
      { provider: 'ashby', slug: 'gamma', company: 'Gamma' },
    ],
    runAt: '2026-07-23T10:00:00.000Z',
    transport: async (url) => {
      if (url.includes('greenhouse')) return { status: 200, body: { jobs: [{ id: 1, title: 'AI Engineer', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1', location: { name: 'Pune, India' }, content: '<p>0-2 years Python</p>', first_published: '2026-07-23' }] } };
      if (url.includes('lever')) return { status: 200, body: [{ id: '2', text: 'Backend Engineer', hostedUrl: 'https://jobs.lever.co/beta/2', categories: { location: 'India Remote' }, descriptionPlain: 'Graduate Python role', createdAt: Date.parse('2026-07-23') }] };
      return { status: 200, body: { jobs: [{ id: '3', title: 'ML Engineer', jobUrl: 'https://jobs.ashbyhq.com/gamma/3', location: 'Bengaluru, India', descriptionPlain: 'Entry level ML role', publishedAt: '2026-07-23' }] } };
    },
  });

  assert.equal(result.observations.length, 3);
  assert.deepEqual(result.observations.map((row) => row.classification), ['direct', 'direct', 'direct']);
  assert.deepEqual(result.observations.map((row) => row.applicationResolution.evidence), ['public ATS posting', 'public ATS posting', 'public ATS posting']);
  assert.equal(result.manifest.failed, 0);
});

test('India-first warm boards discard clearly foreign rows before the job cap', async () => {
  const result = await fetchWarmAts({
    boards: [{ provider: 'ashby', slug: 'acme', company: 'Acme', indiaFirst: true }],
    maxJobsPerBoard: 1,
    transport: async () => ({ status: 200, body: { jobs: [
      { id: 'foreign', title: 'AI Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/foreign', location: 'Austria', employmentType: 'FullTime' },
      { id: 'india', title: 'AI Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/india', location: 'Pune, India', employmentType: 'FullTime' },
    ] } }),
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].jobId, 'india');
  assert.equal(result.observations[0].employment.type, 'full-time');
  assert.equal(result.manifest.sources[0].foreignDiscardedAtSource, 1);
});

test('India-first warm boards pass ambiguous and non-India-scoped observations to eligibility', async () => {
  const result = await fetchWarmAts({
    boards: [{ provider: 'ashby', slug: 'acme', company: 'Acme', indiaFirst: true }],
    transport: async () => ({ status: 200, body: { jobs: [
      { id: 'pune-metro', title: 'AI Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/pune-metro', location: 'Hinjawadi, Pune' },
      { id: 'apac', title: 'AI Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/apac', location: 'APAC' },
      { id: 'worldwide', title: 'AI Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/worldwide', location: 'Worldwide' },
      { id: 'remote-global', title: 'AI Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/remote-global', location: 'Remote - Global' },
      { id: 'empty', title: 'AI Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/empty', location: '' },
    ] } }),
  });

  assert.deepEqual(result.observations.map((row) => row.jobId), ['pune-metro', 'apac', 'worldwide', 'remote-global', 'empty']);
  assert.deepEqual(result.observations.map((row) => row.evidence.sourceGeoObservation), [
    undefined, 'india-first-filter-bypass', 'india-first-filter-bypass', 'india-first-filter-bypass', undefined,
  ]);
  assert.equal(result.observations[4].evidence.sourceGeoObservation, undefined);
  assert.equal(result.manifest.sources[0].foreignDiscardedAtSource, 0);
  assert.equal(result.manifest.sources[0].foreignPassedThroughAtSource, 3);
});

test('India-first warm boards still discard explicit foreign-only locations', async () => {
  const result = await fetchWarmAts({
    boards: [{ provider: 'ashby', slug: 'acme', company: 'Acme', indiaFirst: true }],
    transport: async () => ({ status: 200, body: { jobs: [
      { id: 'us-only', title: 'AI Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/us-only', location: 'US Only - Remote' },
      { id: 'global', title: 'AI Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/global', location: 'Remote - Global' },
    ] } }),
  });

  assert.deepEqual(result.observations.map((row) => row.jobId), ['global']);
  assert.equal(result.manifest.sources[0].foreignDiscardedAtSource, 1);
  assert.equal(result.manifest.sources[0].foreignPassedThroughAtSource, 1);
});

test('warm rotation emits configured, attempted, omitted, and omission reasons', async () => {
  const boards = ['ashby', 'greenhouse', 'lever'].flatMap((provider) =>
    [1, 2].map((index) => ({ provider, slug: `${provider}-${index}` })));
  const result = await fetchWarmAts({
    boards,
    maxBoards: 3,
    rotation: { enabled: true, providerQuotas: { ashby: 1, greenhouse: 1, lever: 1 } },
    transport: async (url) => url.includes('lever')
      ? { status: 200, body: [] }
      : { status: 200, body: { jobs: [] } },
  });
  assert.equal(result.manifest.boardsConfigured, 6);
  assert.equal(result.manifest.boardsAttempted, 3);
  assert.equal(result.manifest.boardsOmitted, 3);
  assert.ok(result.manifest.omissions.every((item) => item.reason === 'due-in-later-rotation-window'));
  assert.equal(result.manifest.healthEvents.length, 3);
});
test('bounded board concurrency runs providers in parallel but serializes each provider', async () => {
  let active = 0;
  let maximumActive = 0;
  const activeProviders = new Set();
  let sameProviderOverlap = false;
  const boards = [
    { provider: 'greenhouse', slug: 'green-1', company: 'Green One' },
    { provider: 'greenhouse', slug: 'green-2', company: 'Green Two' },
    { provider: 'lever', slug: 'lever-1', company: 'Lever One' },
  ];
  const result = await fetchWarmAts({
    boards,
    boardConcurrency: 3,
    transport: async (_url, { provider }) => {
      if (activeProviders.has(provider)) sameProviderOverlap = true;
      activeProviders.add(provider);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      activeProviders.delete(provider);
      return { status: 200, body: provider === 'lever' ? [] : { jobs: [] } };
    },
  });

  assert.equal(sameProviderOverlap, false);
  assert.equal(maximumActive, 2);
  assert.equal(result.failures.length, 0);
});
