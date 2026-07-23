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
