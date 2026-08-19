import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAtsBatch1, fetchAtsProvider, ATS_BATCH_1 } from '../../crawler/ats-batch-1.mjs';

test('fetches the bounded first ATS batch through an injected transport', async () => {
  const requests = [];
  const transport = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('smartrecruiters')) return { status: 200, headers: { etag: '"sr-1"' }, body: JSON.stringify({ postings: [{ id: 'sr-7', name: 'AI Engineer', company: { name: 'Acme' }, location: { label: 'Pune, India' }, releasedDate: '2026-07-22', ref: 'https://jobs.smartrecruiters.com/Acme/743999/sr-7' }] }) };
    if (url.includes('recruitee')) return { status: 200, headers: {}, body: JSON.stringify({ offers: [{ id: 9, title: 'Backend Engineer', company: { name: 'Beta' }, location: 'Remote - India', published_at: '2026-07-21', careers_url: 'https://beta.recruitee.com/o/backend-engineer' }] }) };
    return { status: 200, headers: {}, body: JSON.stringify({ jobs: [] }) };
  };

  const result = await fetchAtsBatch1({
    boards: [{ provider: 'smartrecruiters', company: 'Acme', board: 'Acme' }, { provider: 'recruitee', company: 'Beta', board: 'beta' }],
    transport,
    runAt: '2026-07-23T10:00:00Z',
    maxPages: 2,
    enrichDetails: false,
  });

  assert.deepEqual(ATS_BATCH_1, ['smartrecruiters', 'workable', 'teamtailor', 'recruitee']);
  assert.equal(requests.length, 2);
  assert.equal(result.observations.length, 2);
  assert.equal(result.manifest.direct, 2);
  assert.equal(result.manifest.leads, 0);
  assert.equal(result.observations[0].schemaVersion, 'CandidateV1');
  assert.equal(result.observations[0].jobId, 'sr-7');
  assert.equal(result.observations[0].evidence.providerJobId, 'sr-7');
  assert.equal(result.observations[0].evidence.sourceUrl, requests[0].url);
  assert.equal(result.observations[1].originalApplicationUrl, 'https://beta.recruitee.com/o/backend-engineer');
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.manifest.sources, [
    { provider: 'smartrecruiters', board: 'Acme', company: 'Acme', fetched: 1, observations: 1, foreignDiscardedAtSource: 0, status: 'ok', failures: 0, capHit: null, interrupted: false, naturalTerminal: true, newestPostingAt: '2026-07-22T00:00:00.000Z', recordsNotExamined: null, startingCursor: {}, truncated: false },
    { provider: 'recruitee', board: 'beta', company: 'Beta', fetched: 1, observations: 1, foreignDiscardedAtSource: 0, status: 'ok', failures: 0, capHit: null, interrupted: false, naturalTerminal: true, newestPostingAt: '2026-07-21T00:00:00.000Z', recordsNotExamined: null, startingCursor: {}, truncated: false },
  ]);
  assert.equal(result.manifest.noAutoApply, true);
});

test('SmartRecruiters applies configured country and city filters at request time', async () => {
  let requested;
  await fetchAtsProvider({
    provider: 'smartrecruiters',
    board: { board: 'Acme', country: 'in', city: 'Bengaluru' },
    maxPages: 1,
    enrichDetails: false,
    transport: async (url) => {
      requested = new URL(url);
      return { status: 200, body: { postings: [] } };
    },
  });
  assert.equal(requested.searchParams.get('country'), 'in');
  assert.equal(requested.searchParams.get('city'), 'Bengaluru');
});

test('preserves conditional state and cursor while honoring page and job bounds', async () => {
  const calls = [];
  const result = await fetchAtsProvider({
    provider: 'smartrecruiters',
    board: { company: 'Acme', board: 'Acme' },
    pageSize: 1,
    maxPages: 2,
    maxJobs: 2,
    enrichDetails: false,
    conditionalState: { 'https://api.smartrecruiters.com/v1/companies/Acme/postings?limit=1&offset=0': { etag: '"old"', lastModified: 'yesterday' } },
    transport: async (url, options) => {
      calls.push({ url, options });
      const offset = new URL(url).searchParams.get('offset');
      return { status: 200, headers: { etag: `"${offset}"` }, body: JSON.stringify({ postings: [{ id: offset, name: `Role ${offset}`, ref: `https://jobs.smartrecruiters.com/Acme/${offset}` }] }) };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers['if-none-match'], '"old"');
  assert.equal(calls[0].options.headers['if-modified-since'], 'yesterday');
  assert.equal(result.observations.length, 2);
  assert.equal(result.manifest.pages, 2);
  assert.equal(result.cursorState.smartrecruiters.Acme.page, 2);
  assert.equal(result.conditionalState[calls[1].url].etag, '"1"');
});

test('resumes within a page after duplicate rows consume the job bound', async () => {
  const pages = [
    [
      { id: 'a', title: 'A', url: 'https://acme.workable.com/j/a' },
      { id: 'a', title: 'A', url: 'https://acme.workable.com/j/a' },
      { id: 'b', title: 'B', url: 'https://acme.workable.com/j/b' },
      { id: 'c', title: 'C', url: 'https://acme.workable.com/j/c' },
    ],
    [],
  ];
  const calls = [];
  const transport = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('offset')) / 4;
    return { status: 200, headers: {}, body: JSON.stringify({ jobs: pages[page], nextPage: page === 0 ? 1 : null }) };
  };
  const options = { provider: 'workable', board: { board: 'acme' }, pageSize: 4, maxPages: 2, maxJobs: 2, transport };

  const first = await fetchAtsProvider(options);
  assert.deepEqual(first.observations.map((row) => row.title), ['A', 'B']);
  assert.equal(first.manifest.fetched, 4);
  assert.equal(first.manifest.foreignDiscardedAtSource, 0);
  assert.deepEqual(first.cursorState.workable.acme, { page: 0, rowOffset: 3 });

  const resumed = await fetchAtsProvider({ ...options, cursorState: first.cursorState });
  assert.ok(resumed.observations.some((row) => row.title === 'C'));
  assert.equal(resumed.manifest.fetched, 4);
  assert.deepEqual(calls.slice(0, 2), [
    'https://apply.workable.com/api/v3/accounts/acme/jobs?state=published&limit=4&offset=0',
    'https://apply.workable.com/api/v3/accounts/acme/jobs?state=published&limit=4&offset=0',
  ]);
});

test('reports unsupported providers and malformed public payloads without throwing', async () => {
  const unsupported = await fetchAtsProvider({ provider: 'greenhouse', board: { board: 'x' }, transport: async () => { throw new Error('must not call transport'); } });
  assert.equal(unsupported.manifest.status, 'unsupported');
  assert.equal(unsupported.failures[0].kind, 'unsupported-provider');

  const malformed = await fetchAtsBatch1({
    boards: [{ provider: 'workable', board: 'acme' }],
    transport: async () => ({ status: 200, headers: {}, body: '{"unexpected":true}' }),
  });
  assert.deepEqual(malformed.observations, []);
  assert.equal(malformed.failures[0].kind, 'malformed-payload');
  assert.equal(malformed.results[0].manifest.status, 'malformed');
});

test('accepts the live SmartRecruiters content payload and canonical posting ref', async () => {
  const result = await fetchAtsProvider({
    provider: 'smartrecruiters',
    board: { board: 'Visa', company: 'Visa' },
    runAt: '2026-07-23T10:00:00.000Z',
    maxPages: 1,
    transport: async (url) => url.endsWith('/visa-1') ? ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        applyUrl: 'https://jobs.smartrecruiters.com/Visa/visa-1-software-engineer',
        location: { fullLocation: 'Bengaluru, India' },
        jobAd: { sections: {
          jobDescription: { text: 'Build Python services.' },
          qualifications: { text: '0-2 years experience.' },
        } },
      }),
    }) : ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        content: [{
          id: 'visa-1',
          name: 'Software Engineer',
          company: { name: 'Visa' },
          location: { fullLocation: 'Bengaluru, India' },
          releasedDate: '2026-07-23T09:00:00.000Z',
          ref: 'https://api.smartrecruiters.com/v1/companies/Visa/postings/visa-1',
        }],
      }),
    }),
  });

  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].title, 'Software Engineer');
  assert.equal(result.observations[0].location, 'Bengaluru, India');
  assert.equal(result.observations[0].canonicalUrl, 'https://jobs.smartrecruiters.com/Visa/visa-1-software-engineer');
  assert.match(result.observations[0].description, /0-2 years/);
  assert.equal(result.observations[0].classification, 'direct');
  assert.equal(result.observations[0].applicationResolution.evidence, 'public ATS posting');
});

test('does not make live network calls and classifies non-ATS application links as leads', async () => {
  const result = await fetchAtsProvider({
    provider: 'teamtailor',
    board: { board: 'acme', endpoint: 'https://acme.teamtailor.com/api/jobs' },
    transport: async () => ({ status: 200, headers: {}, body: JSON.stringify({ data: [{ id: 'tt-1', attributes: { title: 'ML Engineer', url: 'https://acme.example/jobs/ml-engineer' } }] }) }),
    maxPages: 1,
  });
  assert.equal(result.observations[0].evidence.classification, 'lead');
  assert.equal(result.observations[0].sourceKind, 'aggregator');
  assert.equal(result.observations[0].evidence.providerJobId, 'tt-1');
});
