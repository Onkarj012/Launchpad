import test from 'node:test';
import assert from 'node:assert/strict';
import { ATS_BATCH_2_PROVIDERS, discoverAtsBatch2, fetchAtsBatch2 } from '../../crawler/ats-batch-2.mjs';
import { deadlineError } from '../../crawler/deadline.mjs';
import { classifyFreshness } from '../../job-pull/freshness.mjs';

const runAt = '2026-07-23T10:00:00.000Z';

test('cancellation stops a hanging page transport before another page begins', async () => {
  let requests = 0;
  let stopped = false;
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = fetchAtsBatch2({
    board: { provider: 'bamboohr', slug: 'deadline' },
    signal: controller.signal,
    deadline: { deadlineMs: startedAt + 100 },
    transport: async (_url, { signal }) => {
      requests += 1;
      await new Promise((resolve) => signal.addEventListener('abort', () => {
        stopped = true;
        resolve();
      }, { once: true }));
    },
  });
  setTimeout(() => controller.abort(deadlineError()), 30);
  const result = await pending;
  assert.equal(result.manifest.status, 'interrupted');
  assert.equal(requests, 1);
  assert.equal(stopped, true);
  assert.ok(Date.now() - startedAt < 2_000);
});

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

test('complete-array feeds do not invent page parameters and report item truncation', async () => {
  const calls = [];
  const result = await fetchAtsBatch2({
    board: { provider: 'breezy', slug: 'large', company: 'Large Co' }, runAt, maxItems: 2,
    transport: async (url) => {
      calls.push(url);
      return { status: 200, body: [
        { id: '1', name: 'Engineer 1', url: 'https://large.breezy.hr/p/1' },
        { id: '2', name: 'Engineer 2', url: 'https://large.breezy.hr/p/2' },
        { id: '3', name: 'Engineer 3', url: 'https://large.breezy.hr/p/3' },
      ] };
    },
  });

  assert.deepEqual(calls, ['https://large.breezy.hr/json']);
  assert.equal(result.observations.length, 2);
  assert.equal(result.manifest.completeArray, true);
  assert.equal(result.manifest.truncated, true);
  assert.equal(result.manifest.recordsNotExamined, 1);
  assert.equal(result.manifest.naturalTerminal, false);
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
  const xml = '<jobs><position><id>p-1</id><name>ML Engineer</name><office>Pune</office><createdAt>2026-07-23T08:00:00Z</createdAt><publishedAt>2026-07-23T09:00:00Z</publishedAt><jobDescription><![CDATA[Learn systems]]></jobDescription><url>https://acme.jobs.personio.com/job/p-1</url></position></jobs>';
  const first = await fetchAtsBatch2({ board: { provider: 'personio', slug: 'acme' }, runAt, transport: async (url, options) => { requests.push(options); return { status: 200, headers: { etag: '"p1"', 'last-modified': 'Wed, 23 Jul 2026 09:00:00 GMT' }, body: xml }; } });
  assert.equal(first.observations[0].title, 'ML Engineer');
  assert.equal(first.observations[0].postedAt, '2026-07-23T08:00:00.000Z');
  assert.equal(first.observations[0].evidence.dateConfidence, 'provider-unverified');
  assert.equal(first.observations[0].evidence.providerCreatedAt, '2026-07-23T08:00:00.000Z');
  assert.equal(first.observations[0].evidence.providerPublishedAt, '2026-07-23T09:00:00.000Z');
  const second = await fetchAtsBatch2({ board: { provider: 'personio', slug: 'acme' }, runAt, state: { etag: '"p1"', lastModified: 'Wed, 23 Jul 2026 09:00:00 GMT', cursor: { page: 1 } }, transport: async (url, options) => { requests.push(options); return { status: 304, headers: {} }; } });
  assert.deepEqual(requests[1].headers, { 'if-none-match': '"p1"', 'if-modified-since': 'Wed, 23 Jul 2026 09:00:00 GMT' });
  assert.equal(second.manifest.status, 'not-modified');
  assert.equal(second.observations.length, 0);
  assert.equal(second.conditionalState.cursor.page, 1);
});

test('Personio provider-created date remains uncorroborated VerifyQueue evidence', async () => {
  const result = await fetchAtsBatch2({
    board: { provider: 'personio', slug: 'acme' }, runAt,
    transport: async () => ({ status: 200, body: '<jobs><position><id>p-2</id><name>Backend Engineer</name><createdAt>2026-07-23T08:00:00Z</createdAt><url>https://acme.jobs.personio.com/job/p-2</url></position></jobs>' }),
  });
  const freshness = classifyFreshness(result.observations[0], { now: runAt });
  assert.equal(freshness.window, 'VerifyQueue');
  assert.equal(freshness.eligible, false);
  assert.equal(freshness.code, 'FRESHNESS_PERSONIO_UNCORROBORATED_VERIFY_QUEUE');
  assert.equal(freshness.personioUncorroborated, true);
  assert.equal(freshness.verifyQueue, true);
});

test('Comeet time_updated is retained as modification evidence without fabricating postedAt', async () => {
  const result = await fetchAtsBatch2({
    board: { provider: 'comeet', company: 'Comeet Co', baseUrl: 'https://www.comeet.com/jobs/acme' }, runAt,
    transport: async () => ({ status: 200, body: { jobs: [{ id: 'c-1', name: 'AI Engineer', time_updated: '2026-07-23T08:00:00Z', url: 'https://www.comeet.com/jobs/acme/ai-engineer' }] } }),
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].postedAt, null);
  assert.equal(result.observations[0].evidence.dateConfidence, 'modification-only');
  assert.equal(result.observations[0].evidence.modifiedAt, '2026-07-23T08:00:00.000Z');
  assert.equal(result.manifest.newestPostingAt, null);
});

test('Comeet conditional 304 short-circuits without re-parsing the response', async () => {
  const requests = [];
  const board = { provider: 'comeet', company: 'Comeet Co', baseUrl: 'https://www.comeet.com/jobs/acme' };
  const first = await fetchAtsBatch2({ board, runAt, transport: async (url, options) => { requests.push({ url, options }); return { status: 200, headers: { etag: '"c1"' }, body: { jobs: [{ id: 'c-1', name: 'AI Engineer', time_updated: '2026-07-23T08:00:00Z', url: 'https://www.comeet.com/jobs/acme/ai-engineer' }] } }; } });
  const second = await fetchAtsBatch2({ board, runAt, state: { etag: '"c1"', cursor: { page: 1 } }, transport: async (url, options) => { requests.push({ url, options }); return { status: 304, headers: {}, get body() { throw new Error('304 body must not be parsed'); } }; } });
  assert.equal(first.observations.length, 1);
  assert.equal(second.manifest.status, 'not-modified');
  assert.equal(second.observations.length, 0);
  assert.deepEqual(requests[1].options.headers, { 'if-none-match': '"c1"' });
});

test('lead classification and retryable errors remain observable and nonfatal', async () => {
  let attempts = 0;
  const result = await discoverAtsBatch2({
    boards: [{ provider: 'breezy', slug: 'lead', company: 'Lead Co', direct: false }, { provider: 'personio', slug: 'broken' }, { provider: 'comeet', slug: 'broken' }], runAt, retry: { maxAttempts: 2 },
    transport: async (url) => { attempts += 1; if (url.includes('personio') || url.includes('comeet')) { const error = new Error('temporary outage'); error.retryable = true; throw error; } return { status: 200, body: [{ id: '1', name: 'Engineer', url: 'https://lead.breezy.hr/p/1' }] }; },
  });
  assert.equal(result.observations[0].classification, 'lead');
  assert.equal(result.observations[0].originalApplicationUrl, null);
  assert.equal(result.failures.length, 2);
  assert.deepEqual(result.failures.map((failure) => failure.sourceId).sort(), ['ats-batch-2:comeet:broken', 'ats-batch-2:personio:broken']);
  assert.equal(attempts, 5);
  assert.equal(result.manifest.noAutoApply, true);
});
