import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THEIRSTACK_CURSOR_SCHEMA,
  THEIRSTACK_CURSOR_SCHEMA_VERSION,
  THEIRSTACK_JOB_SEARCH_URL,
  discoverTheirStack,
} from '../../crawler/theirstack.mjs';

const RUN_AT = '2026-07-26T10:00:00.000Z';
const API_KEY = 'ts-secret-test-key';
const query = { posted_at_max_age_days: 7, job_title_or: ['AI Engineer'] };

const job = (id, overrides = {}) => ({
  id,
  job_title: `AI Engineer ${id}`,
  company: 'Acme',
  location: 'Pune, India',
  description: 'Build reliable AI systems.',
  date_posted: '2026-07-25',
  discovered_at: '2026-07-25T08:30:00Z',
  employment_statuses: ['full_time'],
  remote: false,
  hybrid: false,
  url: `https://www.linkedin.com/jobs/view/${id}`,
  source_url: `https://source.example/jobs/${id}`,
  final_url: null,
  closed_at: null,
  ...overrides,
});

function response(data, metadata = {}) {
  return {
    status: 200,
    body: {
      data,
      metadata: {
        total_results: data.length,
        total_companies: data.length ? 1 : 0,
        truncated_results: 0,
        truncated_companies: 0,
        ...metadata,
      },
    },
  };
}

test('posts the fixed request shape, owns controls, and emits no secret-bearing output', async () => {
  const calls = [];
  const result = await discoverTheirStack({
    apiKey: API_KEY,
    transport: async (url, options) => {
      calls.push({ url, options });
      return response([]);
    },
    queries: [{
      ...query,
      apiKey: 'query-secret',
      authorization: 'query-auth',
      headers: { authorization: 'nested-auth' },
      limit: 999,
      offset: 900,
      page: 4,
      cursor: 'provider-cursor',
      include_total_results: false,
      order_by: [{ field: 'company', desc: false }],
    }],
    pageSize: 12,
    runAt: RUN_AT,
  });

  assert.equal(THEIRSTACK_JOB_SEARCH_URL, 'https://api.theirstack.com/v1/jobs/search');
  assert.equal(THEIRSTACK_CURSOR_SCHEMA.schemaVersion, THEIRSTACK_CURSOR_SCHEMA_VERSION);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, THEIRSTACK_JOB_SEARCH_URL);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(calls[0].options.headers, {
    Authorization: `Bearer ${API_KEY}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.limit, 12);
  assert.equal(body.offset, 0);
  assert.equal(body.include_total_results, true);
  assert.equal(body.page, undefined);
  assert.equal(body.cursor, undefined);
  assert.equal(body.apiKey, undefined);
  assert.equal(body.authorization, undefined);
  assert.equal(body.headers, undefined);
  assert.deepEqual(body.order_by, [
    { field: 'date_posted', desc: true },
    { field: 'discovered_at', desc: true },
  ]);
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
  assert.equal(JSON.stringify(result).includes('query-secret'), false);
  assert.equal(result.manifest.noAutoApply, true);
  assert.equal(result.manifest.writesPlanned, false);
});

test('validates the API key and required filters before transport', async () => {
  let calls = 0;
  const transport = async () => { calls += 1; return response([]); };
  await assert.rejects(
    discoverTheirStack({ transport, apiKey: '', queries: [query] }),
    /requires apiKey/,
  );
  await assert.rejects(
    discoverTheirStack({ transport, apiKey: API_KEY, queries: [{ job_title_or: ['AI Engineer'], limit: 2 }] }),
    /requires a supported date or company filter/,
  );
  assert.equal(calls, 0);
});

test('normalizes TheirStack fields conservatively as an aggregator lead', async () => {
  const result = await discoverTheirStack({
    apiKey: API_KEY,
    transport: async () => response([job(1, {
      company: null,
      company_object: { name: 'Acme AI' },
      location: null,
      long_location: 'Pune, Maharashtra, India',
      remote: true,
      employment_statuses: ['FULL_TIME', 'unknown_status'],
    })]),
    queries: [query],
    runAt: RUN_AT,
  });

  const candidate = result.observations[0];
  assert.equal(candidate.schemaVersion, 'CandidateV1');
  assert.equal(candidate.company, 'Acme AI');
  assert.equal(candidate.title, 'AI Engineer 1');
  assert.equal(candidate.location, 'Pune, Maharashtra, India');
  assert.equal(candidate.description, 'Build reliable AI systems.');
  assert.equal(candidate.workMode, 'remote');
  assert.equal(candidate.employment.type, 'full-time');
  assert.equal(candidate.provider, 'theirstack');
  assert.equal(candidate.source, 'theirstack');
  assert.equal(candidate.sourceKind, 'aggregator');
  assert.equal(candidate.sourceCategory, 'aggregator');
  assert.equal(candidate.classification, 'lead');
  assert.equal(candidate.liveness.status, 'Not Verified');
  assert.equal(candidate.canonicalUrl, 'https://www.linkedin.com/jobs/view/1');
  assert.equal(result.manifest.fetched, 1);
  assert.equal(result.manifest.changed, 1);
});

test('attaches a proven ATS final_url without promoting aggregator provenance', async () => {
  const finalUrl = 'https://jobs.lever.co/acme/123?utm_source=theirstack';
  const result = await discoverTheirStack({
    apiKey: API_KEY,
    transport: async () => response([job(2, { final_url: finalUrl })]),
    queries: [query],
    runAt: RUN_AT,
  });

  const candidate = result.observations[0];
  assert.equal(candidate.canonicalUrl, 'https://www.linkedin.com/jobs/view/2');
  assert.equal(candidate.originalApplicationUrl, 'https://jobs.lever.co/acme/123');
  assert.equal(candidate.applicationResolution.status, 'Resolved Original');
  assert.equal(candidate.applicationResolution.evidence, 'theirstack-final_url-classified');
  assert.equal(candidate.originalApplicationProvider, 'lever');
  assert.equal(candidate.evidence.originalApplicationProvider, 'lever');
  assert.equal(candidate.provider, 'theirstack');
  assert.equal(candidate.sourceKind, 'aggregator');
  assert.equal(candidate.sourceCategory, 'aggregator');
  assert.equal(candidate.classification, 'lead');
  assert.equal(candidate.liveness.status, 'Not Verified');
  assert.equal(result.verificationQueue.length, 0);
});

test('queues unsupported final_url values and uses a proven final_url only when discovery URLs are absent', async () => {
  const result = await discoverTheirStack({
    apiKey: API_KEY,
    transport: async () => response([
      job(3, { final_url: 'https://unrelated.example/opening/3' }),
      job(4, { url: null, source_url: null, final_url: 'https://careers.acme.com/jobs/4' }),
    ]),
    queries: [query],
    runAt: RUN_AT,
  });

  const unsupported = result.observations.find((item) => item.jobId === '3');
  const finalOnly = result.observations.find((item) => item.jobId === '4');
  assert.equal(unsupported.originalApplicationUrl, null);
  assert.equal(unsupported.applicationResolution.status, 'Unresolved');
  assert.ok(result.verificationQueue.some((item) => item.jobId === '3' && item.reason === 'unsupported-final-url'));
  assert.equal(finalOnly.canonicalUrl, 'https://careers.acme.com/jobs/4');
  assert.equal(finalOnly.originalApplicationUrl, 'https://careers.acme.com/jobs/4');
  assert.equal(finalOnly.classification, 'lead');
});

test('converts only valid date-only values and leaves missing or invalid dates undated', async () => {
  const result = await discoverTheirStack({
    apiKey: API_KEY,
    transport: async () => response([
      job(5, { date_posted: '2026-07-24' }),
      job(6, { date_posted: null, remote: false, hybrid: false, employment_statuses: ['mystery'] }),
      job(7, { date_posted: '2026-02-30', hybrid: true }),
      job(8, { date_posted: '2026-07-24T10:00:00Z' }),
    ]),
    queries: [query],
    runAt: RUN_AT,
  });

  const byId = new Map(result.observations.map((item) => [item.jobId, item]));
  assert.equal(byId.get('5').postedAt, '2026-07-24T00:00:00.000Z');
  assert.equal(byId.get('5').evidence.rawDatePosted, '2026-07-24');
  assert.equal(byId.get('5').evidence.dateConfidence, 'provider-date-only');
  assert.equal(byId.get('6').postedAt, null);
  assert.equal(byId.get('6').workMode, null);
  assert.equal(byId.get('6').employment.type, null);
  assert.equal(byId.get('7').postedAt, null);
  assert.equal(byId.get('7').workMode, 'hybrid');
  assert.equal(byId.get('8').postedAt, null);
});

test('marks a row expired only when closed_at is present', async () => {
  const result = await discoverTheirStack({
    apiKey: API_KEY,
    transport: async () => response([
      job(9),
      job(10, { closed_at: '2026-07-25T09:00:00Z' }),
    ]),
    queries: [query],
    runAt: RUN_AT,
  });
  assert.equal(result.observations[0].liveness.status, 'Not Verified');
  assert.equal(result.observations[1].liveness.status, 'Expired');
  assert.equal(result.observations[1].liveness.evidence, 'theirstack-closed_at');
});

test('deduplicates by id, proven final URL, then discovery URL while charging every returned row', async () => {
  const result = await discoverTheirStack({
    apiKey: API_KEY,
    transport: async () => response([
      job(11, { final_url: 'https://jobs.lever.co/acme/a' }),
      job(11, { url: 'https://source.example/duplicate-id', final_url: 'https://jobs.lever.co/acme/b' }),
      job(12, { final_url: 'https://jobs.lever.co/acme/a' }),
      job(null, { url: 'https://source.example/shared', source_url: null }),
      job(null, { url: 'https://source.example/shared?utm_source=x', source_url: null }),
    ]),
    queries: [query],
    runAt: RUN_AT,
  });

  assert.equal(result.observations.length, 2);
  assert.equal(result.manifest.fetched, 5);
  assert.equal(result.manifest.telemetry.rowsReturned, 5);
  assert.equal(result.manifest.telemetry.creditsConsumed, 5);
  assert.equal(result.manifest.telemetry.duplicates, 3);
});

test('reduces request limits to item and credit budgets and returns a continuation cursor on caps', async () => {
  const calls = [];
  const result = await discoverTheirStack({
    apiKey: API_KEY,
    transport: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      return response([job(20), job(21)], { total_results: 10 });
    },
    queries: [query],
    pageSize: 25,
    maxItemsPerRun: 9,
    maxCreditsPerRun: 2,
    runAt: RUN_AT,
  });

  assert.equal(calls[0].limit, 2);
  assert.equal(result.manifest.capHit, 'maxCreditsPerRun');
  assert.equal(result.manifest.truncated, true);
  assert.equal(result.manifest.naturalTerminal, false);
  assert.equal(result.manifest.recordsNotExamined, 8);
  assert.equal(result.cursor.queryIndex, 0);
  assert.equal(result.cursor.offset, 2);
});

test('resumes matching cursors and resets offsets when the stable query-set hash changes', async () => {
  const first = await discoverTheirStack({
    apiKey: API_KEY,
    transport: async () => response([job(30), job(31)], { total_results: 5 }),
    queries: [query],
    pageSize: 2,
    maxPagesPerQuery: 1,
    runAt: RUN_AT,
  });
  assert.equal(first.manifest.capHit, 'maxPagesPerQuery');
  assert.equal(first.cursor.offset, 2);

  const resumedBodies = [];
  await discoverTheirStack({
    apiKey: API_KEY,
    transport: async (url, options) => {
      resumedBodies.push(JSON.parse(options.body));
      return response([], { total_results: 2 });
    },
    queries: [query],
    cursor: first.cursor,
    runAt: RUN_AT,
  });
  assert.equal(resumedBodies[0].offset, 2);

  const resetBodies = [];
  const reset = await discoverTheirStack({
    apiKey: API_KEY,
    transport: async (url, options) => {
      resetBodies.push(JSON.parse(options.body));
      return response([]);
    },
    queries: [{ posted_at_max_age_days: 14 }],
    cursor: first.cursor,
    runAt: RUN_AT,
  });
  assert.equal(resetBodies[0].offset, 0);
  assert.equal(reset.manifest.cursorReset, true);
});

test('isolates malformed rows without crashing healthy siblings', async () => {
  const result = await discoverTheirStack({
    apiKey: API_KEY,
    transport: async () => response([
      job(40),
      null,
      job(41, { job_title: null }),
      job(42, { url: 'not a url', source_url: null, final_url: 'https://unsupported.example/42' }),
    ]),
    queries: [query],
    runAt: RUN_AT,
  });

  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].jobId, '40');
  assert.equal(result.manifest.telemetry.invalidRecords, 3);
  assert.equal(result.verificationQueue.filter((item) => item.reason === 'invalid-record').length, 3);
  assert.equal(result.manifest.telemetry.verificationQueued, 3);
});

test('sanitizes auth and 429 failures, marks retryability, and never retries ambiguous requests', async () => {
  let authCalls = 0;
  await assert.rejects(
    discoverTheirStack({
      apiKey: API_KEY,
      queries: [query],
      transport: async () => {
        authCalls += 1;
        throw Object.assign(new Error(`bad bearer ${API_KEY}`), { statusCode: 401 });
      },
    }),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.equal(error.retryable, false);
      assert.equal(error.message.includes(API_KEY), false);
      assert.equal(JSON.stringify(error).includes(API_KEY), false);
      assert.equal(error.cursor.offset, 0);
      return true;
    },
  );
  assert.equal(authCalls, 1);

  let rateCalls = 0;
  await assert.rejects(
    discoverTheirStack({
      apiKey: API_KEY,
      queries: [query],
      transport: async () => { rateCalls += 1; return { status: 429, body: { error: { description: API_KEY } } }; },
    }),
    (error) => {
      assert.equal(error.statusCode, 429);
      assert.equal(error.retryable, true);
      assert.equal(error.message, 'TheirStack request failed with HTTP 429');
      assert.equal(JSON.stringify(error).includes(API_KEY), false);
      return true;
    },
  );
  assert.equal(rateCalls, 1);
});

test('reports provider-side truncation truthfully without claiming natural completion', async () => {
  const result = await discoverTheirStack({
    apiKey: API_KEY,
    transport: async () => response([job(50)], {
      total_results: 4,
      truncated_results: 3,
      total_companies: 4,
      truncated_companies: 2,
    }),
    queries: [query],
    runAt: RUN_AT,
  });
  assert.equal(result.manifest.truncated, true);
  assert.equal(result.manifest.naturalTerminal, false);
  assert.equal(result.manifest.recordsNotExamined, 3);
  assert.equal(result.manifest.telemetry.queryDiagnostics[0].truncatedResults, 3);
  assert.equal(result.manifest.telemetry.queryDiagnostics[0].truncatedCompanies, 2);
});
