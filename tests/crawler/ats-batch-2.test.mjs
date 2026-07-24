import test from 'node:test';
import assert from 'node:assert/strict';
import { ATS_BATCH_2_PROVIDERS, discoverAtsBatch2, fetchAtsBatch2 } from '../../crawler/ats-batch-2.mjs';

const runAt = '2026-07-23T10:00:00.000Z';

test('batch 2 is bounded and does not overlap the warm ATS providers', () => {
  assert.deepEqual(ATS_BATCH_2_PROVIDERS, ['breezy', 'bamboohr', 'personio', 'comeet', 'pinpoint', 'rippling']);
  assert.equal(ATS_BATCH_2_PROVIDERS.some((provider) => ['greenhouse', 'lever', 'ashby', 'workday'].includes(provider)), false);
});

test('Comeet, Pinpoint, and Rippling public payloads use the same bounded contract', async () => {
  for (const provider of ['comeet', 'pinpoint', 'rippling']) {
    const result = await fetchAtsBatch2({
      board: { provider, company: `${provider} Co`, baseUrl: `https://${provider}.example`, endpoint: '/jobs' },
      runAt,
      transport: async () => ({
        status: 200,
        body: { jobs: [{ id: `${provider}-1`, title: 'AI Engineer', location: 'Pune', description: 'Build agents.', url: `https://${provider}.example/jobs/1`, postedAt: '2026-07-23' }] },
      }),
    });
    assert.equal(result.observations.length, 1, provider);
    assert.equal(result.observations[0].provider, provider);
    assert.equal(result.observations[0].classification, 'direct');
  }
});

test('Pinpoint parses the live JSON:API postings.json shape ({ data: [...] }) with an object location', async () => {
  const result = await fetchAtsBatch2({
    board: { provider: 'pinpoint', slug: 'infor', company: 'Infor' }, runAt, maxItems: 5,
    transport: async () => ({
      status: 200,
      body: {
        data: [
          { id: '1', title: 'Security Analyst', url: 'https://careers.infor.com/en/postings/abc', location: { city: 'Bengaluru', province: 'Karnataka', country: 'India' }, description: 'Secure the network.' },
          { id: '2', title: '', url: 'https://careers.infor.com/en/postings/no-title', location: { city: 'Remote' } },
        ],
      },
    }),
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].title, 'Security Analyst');
  assert.equal(result.observations[0].location, 'Bengaluru, Karnataka, India');
  assert.equal(result.observations[0].classification, 'lead');
  assert.equal(result.manifest.status, 'ok');
});

test('Breezy adapter emits normalized direct observations with provenance', async () => {
  const calls = [];
  const result = await fetchAtsBatch2({
    board: { provider: 'breezy', slug: 'acme', company: 'Acme' }, runAt, maxItems: 1,
    transport: async (url, options) => { calls.push({ url, options }); return { status: 200, headers: { etag: '"b1"' }, body: [{ id: 'b-1', name: 'AI Engineer', location: 'Pune', description: 'Build agents.', url: 'https://acme.breezy.hr/p/b-1' }, { id: 'b-2', name: 'Ignored' }] }; },
  });
  assert.equal(calls[0].url, 'https://acme.breezy.hr/json');
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].provider, 'breezy');
  assert.equal(result.observations[0].classification, 'direct');
  assert.equal(result.observations[0].provenance.endpoint, calls[0].url);
  assert.equal(result.manifest.direct, 1);
  assert.equal(result.manifest.noAutoApply, true);
});

test('BambooHR pagination advances cursor and obeys page and item bounds', async () => {
  const urls = [];
  const result = await fetchAtsBatch2({
    board: { provider: 'bamboohr', slug: 'acme', company: 'Acme' }, runAt, pageSize: 1, maxPages: 2, maxItems: 2,
    transport: async (url) => { urls.push(url); const page = new URL(url).searchParams.get('page'); return { status: 200, body: { result: [{ id: page || '1', jobOpeningName: 'Engineer', jobOpeningDescription: 'Ship software.', location: 'Remote', jobOpeningUrl: `https://acme.bamboohr.com/careers/${page || '1'}` }], nextPage: page === '1' ? 2 : null } }; },
  });
  assert.deepEqual(urls, ['https://acme.bamboohr.com/careers/list', 'https://acme.bamboohr.com/careers/list?page=2']);
  assert.equal(result.observations.length, 2);
  assert.deepEqual(result.cursor, { page: 3 });
  assert.equal(result.manifest.pages, 2);
});

test('Personio XML is parsed and conditional 304 is persisted without duplicate observations', async () => {
  const requests = [];
  const xml = '<jobs><position><id>p-1</id><name>ML Engineer</name><office>Pune</office><jobDescription><![CDATA[Learn systems]]></jobDescription><url>https://acme.jobs.personio.com/job/p-1</url></position></jobs>';
  const first = await fetchAtsBatch2({ board: { provider: 'personio', slug: 'acme' }, runAt, transport: async (url, options) => { requests.push(options); return { status: 200, headers: { etag: '"p1"', 'last-modified': 'Wed, 23 Jul 2026 09:00:00 GMT' }, body: xml }; } });
  assert.equal(first.observations[0].title, 'ML Engineer');
  const second = await fetchAtsBatch2({ board: { provider: 'personio', slug: 'acme' }, runAt, state: { etag: '"p1"', lastModified: 'Wed, 23 Jul 2026 09:00:00 GMT', cursor: { page: 1 } }, transport: async (url, options) => { requests.push(options); return { status: 304, headers: {} }; } });
  assert.deepEqual(requests[1].headers, { 'if-none-match': '"p1"', 'if-modified-since': 'Wed, 23 Jul 2026 09:00:00 GMT' });
  assert.equal(second.manifest.status, 'not-modified');
  assert.equal(second.observations.length, 0);
  assert.equal(second.conditionalState.cursor.page, 1);
});

test('lead classification and retryable errors remain observable and nonfatal', async () => {
  let attempts = 0;
  const result = await discoverAtsBatch2({
    boards: [{ provider: 'breezy', slug: 'lead', company: 'Lead Co', direct: false }, { provider: 'personio', slug: 'broken' }], runAt, retry: { maxAttempts: 2 },
    transport: async (url) => { attempts += 1; if (url.includes('personio')) { const error = new Error('temporary outage'); error.retryable = true; throw error; } return { status: 200, body: [{ id: '1', name: 'Engineer', url: 'https://lead.breezy.hr/p/1' }] }; },
  });
  assert.equal(result.observations[0].classification, 'lead');
  assert.equal(result.observations[0].originalApplicationUrl, null);
  assert.equal(result.failures.length, 1);
  assert.equal(attempts, 3);
  assert.equal(result.manifest.noAutoApply, true);
});
