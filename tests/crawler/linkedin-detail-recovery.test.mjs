import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseLinkedInJobDetail, fetchLinkedIn } from '../../job-pull/portal-adapters/linkedin.mjs';
import { createOriginalListingResolver, applyOriginalListingResolution } from '../../crawler/original-listing-resolver.mjs';
import { buildSourcePlans, createCrawlerRunResolver, screenPortalCandidate, defaultHttpTransport, runCrawlerOperator } from '../../crawler/operator.mjs';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { loadConfig } from '../../job-pull/config.mjs';
import { runNormalMode } from '../../job-pull/normal-mode.mjs';
import { NORMAL_SOURCE_LANES } from '../../job-pull/normal-sources.mjs';
import { openCrawlerStore } from '../../crawler/run.mjs';
import { renderLocalLeadReport } from '../../crawler/local-lead-report.mjs';

const now = '2026-10-02T18:23:00.000Z';
const fixture = (id) => fs.readFileSync(new URL(`../fixtures/portals/linkedin-details/linkedin-detail-${id}.html`, import.meta.url), 'utf8');
const url = 'https://www.linkedin.com/jobs/view/4473136187';
const lead = { url, discoveryUrl: url, title: 'Software Engineer - NLP/LLM Reasoning', company: 'woodfrog', location: 'Pune', jobId: '4473136187', sourceKind: 'aggregator', provider: 'linkedin-jobs' };
const posting = { '@type': 'JobPosting', identifier: { value: '4473136187' }, title: lead.title, hiringOrganization: { name: lead.company }, description: 'Build Python and LLM systems.', employmentType: 'FULL_TIME', datePosted: '2026-10-02T10:16:32.000Z' };
const page = (value, extra = '') => {
  const postings = (Array.isArray(value) ? value : [value]).flatMap((item) => item?.['@type'] === 'JobPosting' ? [item] : item?.['@graph'] || []);
  const posting = postings.find((item) => item?.['@type'] === 'JobPosting') || {};
  const linkedinUrl = [posting.url, posting['@id']].find((item) => typeof item === 'string' && /linkedin\.com\/jobs\/view\//i.test(item));
  const linkedinId = linkedinUrl?.match(/-(\d{6,12})(?:[/?#]|$)/)?.[1];
  const identifier = posting.identifier && typeof posting.identifier === 'object' ? posting.identifier.value : posting.identifier;
  const postingId = linkedinId || (/^\d{6,12}$/.test(String(identifier ?? '')) ? String(identifier) : url.match(/(\d{6,12})\/?$/)?.[1]);
  return `${extra}<link rel="canonical" href="https://www.linkedin.com/jobs/view/${postingId}"><script type="application/ld+json">${JSON.stringify(value)}</script>`;
};
const parse = (html) => parseLinkedInJobDetail(html, { requestedUrl: url, ...lead, observedAt: now });
const card = (id, title = lead.title, company = lead.company) => `<li data-entity-urn="urn:li:jobPosting:${id}"><h3 class="base-search-card__title">${title}</h3><h4 class="base-search-card__subtitle"><a>${company}</a></h4><span class="job-search-card__location">Pune</span><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/${id}"></a><time datetime="2026-10-02"></time></li>`;
const cards = card('4473136187') + card('4473131541', 'Artificial Intelligence Engineer', 'Rasta.Ai') + card('4433878985', 'AI Product Engineer', 'Cognologix Technologies');
const config = { schemaVersion: 'LaunchpadCrawlerConfigV1', databasePath: ':memory:', opportunityLedgerPath: '/tmp/launchpad-test-absent-ledger.tsv', v4HistorySnapshotPath: '/tmp/launchpad-test-absent-history.json', sources: { portals: { enabled: true, maxCandidates: 6, maxResolverRequests: 6, resolverConcurrency: 1, http: { providers: ['linkedin-jobs'] }, linkedin: { queries: [{ keywords: 'AI', location: 'Pune' }], maxPagesPerQuery: 1 } } } };
function plan(transport, extra = {}) {
  const resolver = createCrawlerRunResolver({ config, transport, runAt: now });
  return buildSourcePlans({ config, transport, resolver, runAt: now, schedule: 'midday', portalCandidateScreen: (candidate) => screenPortalCandidate(candidate, loadConfig()), ...extra }).find((item) => item.id === 'portal-discovery');
}

test('public object, array and @graph JobPosting preserve exact portal provenance without inventing salary or experience', () => {
  for (const value of [posting, [posting], { '@graph': [{ '@type': 'BreadcrumbList' }, posting] }, [{ '@graph': [posting] }]]) {
    const result = parse(page(value));
    assert.equal(result.status, 'extracted');
    assert.equal(result.patch.postedAt, posting.datePosted);
    assert.equal(result.patch.evidence.fieldSources.postedAt, 'portal-detail-jsonld');
    assert.equal(result.patch.experience.minYears, null);
    assert.equal(result.patch.salary, undefined);
    assert.equal(result.patch.employment.type, 'full-time');
    assert.match(result.patch.evidence.portalDetail.responseDigest, /^[0-9a-f]{64}$/);
  }
});

test('saved canonical pages with employer PropertyValue identifiers match requested title and company', () => {
  const result = parse(fixture('4473136187'));
  assert.equal(result.status, 'extracted');
  assert.ok(result.patch.description.length > 2500);
  assert.equal(result.patch.experience.minYears, null);
  assert.equal(result.patch.postedAt, posting.datePosted);
  const cognologix = parseLinkedInJobDetail(fixture('4433878985'), { requestedUrl: 'https://www.linkedin.com/jobs/view/4433878985', title: 'AI Product Engineer', company: 'Cognologix Technologies', observedAt: now });
  assert.equal(cognologix.status, 'extracted');
});

test('numeric employer requisitions match the canonical posting while recommendation title or company mismatches fail', () => {
  const cases = [
    { id: '4464872269', company: 'Deloitte', title: 'Microservices JAVA with AWS-Software Engineer II', req: '350187', description: 'Position Summary' },
    { id: '4473984427', company: 'Amazon', title: 'Software Development Engineer II, Alexa Endpoint Experiences', req: '10565737', description: 'Join the team that brought you the Echo Show' },
  ];
  for (const expected of cases) {
    const requestedUrl = `https://www.linkedin.com/jobs/view/${expected.id}`;
    const html = `<link rel="canonical" href="${requestedUrl}"><script type="application/ld+json">${JSON.stringify({ ...posting, title: expected.title, hiringOrganization: { name: expected.company }, identifier: { '@type': 'PropertyValue', name: expected.company, value: expected.req }, description: expected.description })}</script>`;
    const result = parseLinkedInJobDetail(html, { requestedUrl, jobId: expected.id, title: expected.title, company: expected.company });
    assert.equal(result.status, 'extracted', expected.company);
    assert.ok(result.patch.description.includes(expected.description), expected.company);
    assert.equal(parseLinkedInJobDetail(html, { requestedUrl, jobId: expected.id, title: 'Recommended Software Engineer', company: expected.company }).patch, null);
    assert.equal(parseLinkedInJobDetail(html, { requestedUrl, jobId: expected.id, title: expected.title, company: 'Recommended Employer' }).patch, null);
  }
});

test('malicious posting identity, canonical, ambiguous graph and external identity never borrow recommended JDs', () => {
  const canonical = `<link href="${url}" rel="canonical">`;
  for (const html of [
    page({ ...posting, identifier: { value: '4473131541' } }, canonical),
    page({ ...posting, identifier: { name: lead.company, value: 'urn:li:jobPosting:4473131541' } }),
    page({ ...posting, url: 'https://www.linkedin.com/jobs/view/4473131541' }),
    page(posting, '<link rel="canonical" href="https://www.linkedin.com/jobs/view/4473131541">'),
    page({ ...posting, identifier: null, title: 'Another role' }, canonical),
    page({ '@graph': [{ ...posting, identifier: null }, { ...posting, identifier: null }] }, canonical),
    page({ ...posting, identifier: null, hiringOrganization: { name: 'Other company' } }, canonical),
  ]) assert.equal(parse(html).patch, null);
  assert.equal(parse(`<script type="application/ld+json">${JSON.stringify(posting)}</script>`).patch, null, 'missing canonical posting identity stays unverified');
  const result = parse(`${canonical}<script type="application/ld+json">${JSON.stringify([{ ...posting, identifier: { value: '4473131541' } }, posting])}</script>`);
  assert.equal(result.patch.description, posting.description);
});

test('malformed, empty JD and access blocks are truthful verification failures', () => {
  for (const html of ['<script type="application/ld+json">{broken</script>', page({ ...posting, description: '' }), page(posting, '<title>Sign in to LinkedIn</title>')]) {
    assert.equal(parse(html).patch, null);
    assert.match(parse(html).reason, /not-found|missing|canonical|BLOCKED|blocked/);
  }
  assert.equal(parse(page(posting, '<h2>Sign in to see who you already know at woodfrog</h2><form class="login-form"></form>')).status, 'extracted');
  assert.equal(parse(page(posting, '<p>Sign in to view the job description</p>')).patch, null);
});

test('disclosed salary is retained and missing numeric salary never becomes zero', () => {
  assert.equal(parse(page({ ...posting, baseSalary: { currency: 'INR', value: { minValue: null } } })).patch.salary, undefined);
  const result = parse(page({ ...posting, baseSalary: { currency: 'INR', value: { minValue: 700000, maxValue: 900000, unitText: 'YEAR' } } }));
  assert.equal(result.patch.salary.minimum, 700000);
  assert.equal(result.patch.salary.period, 'YEAR');
  const disclosed = parseLinkedInJobDetail(fixture('4473131541'), { requestedUrl: 'https://www.linkedin.com/jobs/view/4473131541', title: 'Artificial Intelligence Engineer', company: 'Rasta.Ai' });
  assert.equal(disclosed.patch.salary.minimum, 600000);
  assert.equal(disclosed.patch.salary.maximum, 800000);
  assert.equal(disclosed.patch.salary.evidence, 'CTC: 6LPA - 8 LPA');
  assert.equal(parse(page({ ...posting, experienceRequirements: { monthsOfExperience: 36 } })).patch.experience.minYears, 3);
  assert.equal(parse(page({ ...posting, datePosted: '2026-02-31' })).patch.postedAt, undefined);
  assert.equal(parse(page({ ...posting, datePosted: 'Yesterday' })).patch.postedAt, undefined);
});

test('untrusted public card URLs and mismatched card URNs never reach detail transport', async () => {
  const html = card('4473136187').replace(url, 'https://untrusted.invalid/jobs/view/4473136187')
    + card('4473136187').replace('urn:li:jobPosting:4473136187', 'urn:li:jobPosting:4473131541');
  const result = await fetchLinkedIn({ queries: [{ keywords: 'AI', location: 'Pune' }], fetchText: async () => html });
  assert.equal(result.records.length, 0);
});

test('concurrent duplicate calls share the response promise and count one actual GET', async () => {
  let gets = 0; let claims = 0;
  const resolver = createOriginalListingResolver({ sharedRequestBudget: { claim: () => ++claims <= 1 }, transport: async () => { gets++; await Promise.resolve(); return { status: 200, body: fixture('4473136187') }; } });
  const results = await Promise.all([resolver(lead), resolver(lead)]);
  assert.equal(gets, 1); assert.equal(claims, 1);
  assert.equal(results.reduce((count, result) => count + result.telemetry.requests, 0), 1);
  assert.ok(results.every((result) => result.portalPatch.description));
});

test('validated posting application action retains portal evidence on employer failure and ignores recommended apply anchors', async () => {
  const ats = 'https://jobs.lever.co/fixture/123';
  let calls = 0;
  const resolve = createOriginalListingResolver({ runAt: now, transport: async (target) => {
    calls++;
    return target === url ? { status: 200, body: page({ ...posting, potentialAction: { target: ats } }) } : { status: 403, body: 'Access denied' };
  } });
  const failure = await resolve(lead);
  assert.equal(calls, 2);
  assert.equal(failure.evidence.resolution.reason, 'blocked');
  assert.equal(applyOriginalListingResolution(normalizeCandidate(lead), failure).description, posting.description);
  assert.equal(failure.evidence.fieldSources.description, 'portal-detail-jsonld');
  calls = 0;
  const recommended = createOriginalListingResolver({ transport: async () => { calls++; return { status: 200, body: page(posting) + `<a href="${ats}">Apply on company site</a>` }; } });
  await recommended(lead);
  assert.equal(calls, 1);
});

test('LinkedIn redirects and ApplyAction targets reject mismatched or missing terminal identity', async () => {
  const ats = 'https://boards.greenhouse.io/woodfrog/jobs/123';
  const existingDescription = 'Existing lead JD';
  const destinations = [
    [{ title: 'Unrelated role', hiringOrganization: { name: 'Other employer' } }, 'destination-employer-identity-mismatch'],
    [{ title: lead.title, hiringOrganization: { name: 'Other employer' } }, 'destination-employer-identity-mismatch'],
    [{ title: 'Unrelated role', hiringOrganization: { name: lead.company } }, 'destination-role-identity-mismatch'],
    [{ title: lead.title }, 'destination-employer-identity-missing'],
    [{ hiringOrganization: { name: lead.company } }, 'destination-role-identity-missing'],
  ];
  for (const route of ['redirect', 'action']) {
    for (const [identity, reason] of destinations) {
      const calls = [];
      const resolver = createOriginalListingResolver({ runAt: now, transport: async (target) => {
        calls.push(target);
        if (target === url) return route === 'redirect'
          ? { status: 302, headers: { location: ats } }
          : { status: 200, body: page({ ...posting, potentialAction: { '@type': 'ApplyAction', target: ats } }) };
        return { status: 200, body: page({ '@type': 'JobPosting', ...identity, description: 'Unrelated ATS JD' }) };
      } });
      const candidate = normalizeCandidate({ ...lead, description: existingDescription });
      const result = await resolver(candidate);
      const applied = applyOriginalListingResolution(candidate, result);
      assert.deepEqual(calls, [url, ats]);
      assert.equal(result.status, 'verification');
      assert.equal(result.evidence.resolution.reason, reason);
      assert.equal(result.originalApplicationUrl, null);
      assert.equal(result.patch, undefined);
      assert.equal(applied.originalApplicationUrl, null);
      assert.equal(applied.applicationResolution.status, 'Needs Verification');
      assert.equal(applied.shortlistEligible, false);
      assert.equal(applied.company, lead.company);
      assert.equal(applied.title, lead.title);
      assert.notEqual(applied.liveness.status, 'Active');
      assert.equal(applied.description, route === 'action' ? posting.description : existingDescription);
      if (route === 'action') {
        assert.deepEqual(applied.evidence.portalDetail, result.portalPatch.evidence.portalDetail);
        assert.equal(applied.evidence.portalDetail.status, 'extracted');
        assert.equal(applied.evidence.fieldSources.description, 'portal-detail-jsonld');
        assert.match(applied.evidence.portalDetail.responseDigest, /^[0-9a-f]{64}$/);
      }
    }
  }
});

test('matched LinkedIn redirect and ApplyAction destinations resolve with employer and role evidence', async () => {
  const ats = 'https://boards.greenhouse.io/woodfrog/jobs/123';
  for (const route of ['redirect', 'action']) {
    const calls = [];
    const resolver = createOriginalListingResolver({ runAt: now, transport: async (target) => {
      calls.push(target);
      if (target === url) return route === 'redirect'
        ? { status: 302, headers: { location: ats } }
        : { status: 200, body: page({ ...posting, potentialAction: { '@type': 'ApplyAction', target: ats } }) };
      return { status: 200, body: page({ '@type': 'JobPosting', title: 'Software Engineer – NLP/LLM Reasoning', hiringOrganization: { name: 'Woodfrog' }, description: 'Matched employer JD' }) };
    } });
    const result = await resolver(lead);
    const applied = applyOriginalListingResolution(normalizeCandidate(lead), result);
    assert.deepEqual(calls, [url, ats]);
    assert.equal(result.status, 'resolved');
    assert.equal(applied.originalApplicationUrl, ats);
    assert.equal(applied.applicationResolution.status, 'Resolved Original');
    assert.equal(applied.description, 'Matched employer JD');
    assert.equal(applied.liveness.status, 'Active');
    assert.equal(applied.evidence.fieldSources.description, 'original-employer-detail');
    if (route === 'action') assert.equal(applied.evidence.portalDetail.status, 'extracted');
  }
});

test('LinkedIn role identity may use an explicit requisition but never infer it from the target URL', async () => {
  const ats = 'https://boards.greenhouse.io/woodfrog/jobs/123';
  for (const [requisitionId, expected] of [['REQ-123', 'resolved'], ['REQ-456', 'verification'], [null, 'verification']]) {
    const resolver = createOriginalListingResolver({ transport: async (target) => target === url
      ? { status: 302, headers: { location: ats } }
      : { status: 200, body: page({ '@type': 'JobPosting', title: 'Alternate title', hiringOrganization: { name: lead.company }, identifier: { value: 'REQ-123' }, description: 'Employer JD' }) } });
    const result = await resolver({ ...lead, requisitionId });
    assert.equal(result.status, expected);
    if (expected === 'verification') assert.equal(result.originalApplicationUrl, null);
  }
  const resolver = createOriginalListingResolver({ transport: async (target) => target === url
    ? { status: 302, headers: { location: ats } }
    : { status: 200, body: page({ '@type': 'JobPosting', hiringOrganization: { name: lead.company }, description: 'Employer JD' }) } });
  assert.equal((await resolver({ ...lead, requisitionId: '123' })).status, 'verification');
});

test('direct ATS starts still resolve without portal employer identity', async () => {
  const ats = 'https://boards.greenhouse.io/woodfrog/jobs/123';
  let calls = 0;
  const resolver = createOriginalListingResolver({ runAt: now, transport: async () => {
    calls++;
    return { status: 200, body: page({ '@type': 'JobPosting', title: 'ATS title', description: 'Direct employer JD' }) };
  } });
  const result = await resolver({ ...lead, url: ats, discoveryUrl: ats, sourceKind: 'ats-direct', provider: 'greenhouse' });
  assert.equal(calls, 1);
  assert.equal(result.status, 'resolved');
  assert.equal(result.originalApplicationUrl, ats);
  assert.equal(result.patch.title, 'ATS title');
  assert.equal(result.patch.description, 'Direct employer JD');
  assert.equal(result.patch.liveness.status, 'Active');
});

test('one shared counted GET per job ID and cache reuse at exhausted budget preserve portal fields', async () => {
  let calls = 0;
  const budget = { used: 0, claim() { if (this.used === 1) return false; this.used++; return true; } };
  const resolver = createOriginalListingResolver({ runAt: now, sharedRequestBudget: budget, transport: async () => { calls++; return { status: 200, body: fixture('4473136187') }; } });
  const first = await resolver(lead);
  const second = await resolver({ ...lead, discoveryUrl: 'https://in.linkedin.com/jobs/view/software-engineer-4473136187' });
  assert.equal(calls, 1); assert.equal(budget.used, 1);
  assert.equal(first.telemetry.requests, 1); assert.equal(second.telemetry.requests, 0); assert.equal(second.telemetry.bytesObserved, 0);
  const applied = applyOriginalListingResolution(normalizeCandidate(lead), second);
  assert.ok(applied.description.length > 2500);
  assert.equal(applied.originalApplicationUrl, null);
  assert.equal(applied.liveness.status, 'Not Verified');
  assert.equal(applied.evidence.fieldSources.description, 'portal-detail-jsonld');
});

test('same-job redirects are counted once and recommended redirects or outbound URLs are never fetched', async () => {
  const canonicalUrl = 'https://in.linkedin.com/jobs/view/software-engineer-4473136187';
  const calls = [];
  const resolver = createOriginalListingResolver({ transport: async (target) => { calls.push(target); return target === url ? { status: 302, headers: { location: canonicalUrl } } : { status: 200, body: fixture('4473136187') }; } });
  const first = await resolver(lead); const second = await resolver(lead);
  assert.equal(first.telemetry.requests, 2); assert.equal(second.telemetry.requests, 0); assert.equal(calls.length, 2);
  const alias = await resolver({ ...lead, discoveryUrl: canonicalUrl });
  assert.equal(alias.telemetry.requests, 0); assert.ok(alias.portalPatch.description); assert.equal(calls.length, 2);
  for (const target of ['https://www.linkedin.com/jobs/view/4473131541', 'https://private.invalid/jobs/secret']) {
    let gets = 0;
    const blocked = createOriginalListingResolver({ transport: async () => { gets++; return { status: 302, headers: { location: target } }; } });
    assert.equal((await blocked(lead)).status, 'verification'); assert.equal(gets, 1);
  }
  let gets = 0;
  const outbound = createOriginalListingResolver({ transport: async () => { gets++; return { status: 200, body: fixture('4473136187') + page({ '@type': 'JobPosting', identifier: { value: '4473131541' }, url: 'https://jobs.lever.co/evil/1' }) + '<a href="https://untrusted.invalid/careers">Apply</a>' }; } });
  await outbound(lead); assert.equal(gets, 1);
});

test('caps, byte limit, blocks, cancellation and expired deadline never trigger fallback requests', async () => {
  for (const [settings, response, reason] of [
    [{ maxRequests: 0 }, {}, 'request-budget-exceeded'],
    [{ maxHosts: 0 }, {}, 'host-budget-exceeded'],
    [{ maxBytes: 2 }, { status: 200, body: fixture('4473136187') }, 'response-too-large'],
    [{}, { status: 429, body: '' }, 'blocked'],
    [{ deadline: { remainingMs: 0 } }, {}, 'deadline-exceeded'],
  ]) {
    let calls = 0;
    const resolver = createOriginalListingResolver({ ...settings, transport: async () => { calls++; return response; } });
    assert.equal((await resolver(lead)).evidence.resolution.reason, reason);
    assert.ok(calls <= 1);
  }
  const controller = new AbortController(); let calls = 0;
  const resolver = createOriginalListingResolver({ signal: controller.signal, transport: async () => { calls++; controller.abort(); return { status: 200, body: fixture('4473136187') }; } });
  assert.equal((await resolver(lead)).evidence.resolution.reason, 'aborted');
  await resolver(lead); assert.equal(calls, 1);
});

test('operator checkpoints descriptions, resumes without detail refetch and rejects explicit experience after enrichment', async () => {
  const calls = [];
  const transport = async (target) => { calls.push(target); return { status: 200, body: target.includes('jobs-guest') ? cards : fixture(target.match(/(\d+)$/)[1]) }; };
  const checkpoints = [];
  const result = await plan(transport).fetch({ checkpoint: (payload) => checkpoints.push(payload) });
  assert.equal(result.manifest.telemetry.resolutionRequests, 3);
  assert.equal(result.verificationQueue.length, 1);
  assert.equal(result.observations.find((c) => c.jobId === '4473136187').eligibility.experience.manualReview, true);
  for (const id of ['4473131541', '4433878985']) assert.ok(result.observations.find((c) => c.jobId === id).eligibility.reasons.includes('EXPERIENCE_HARD_MIN_3_PLUS'));
  const cursor = checkpoints.at(-1).cursor;
  assert.equal(cursor.completedDetails.length, 3);
  const second = await plan(transport).fetch({ cursor });
  assert.equal(calls.length, 5); // three details once, one search each invocation
  assert.equal(second.observations.length, 3);
  assert.ok(second.observations.every((c) => c.description));
});

test('real operator to Normal path retains Woodfrog, rejects the two 3+ year JDs and renders truthful queues', async () => {
  const store = openCrawlerStore(':memory:'); let calls = 0;
  try {
    const result = await runCrawlerOperator({ config, store, schedule: 'midday', runId: 'linkedin-real-operator', clock: { now: () => now }, transport: async (target) => { calls++; return { status: 200, body: target.includes('jobs-guest') ? cards : fixture(target.match(/(\d+)$/)[1]) }; } });
    assert.equal(calls, 4);
    const second = await runCrawlerOperator({ config, store, schedule: 'midday', runId: 'linkedin-real-operator', clock: { now: () => now }, transport: async () => { throw new Error('idempotent run must not fetch'); } });
    assert.equal(second.idempotent, true);
    const normal = await runNormalMode({ clock: () => now, runId: 'linkedin-normal', ledgerRows: [], opportunityLedgerRows: [], enrichmentBudget: 0, commitSurfaced: false, scorer: () => { throw new Error('No scoring allowed'); }, sourceFunctions: Object.fromEntries(NORMAL_SOURCE_LANES.map((lane) => [lane.id, () => ({ records: lane.id === 'portal-linkedin-jobs' ? result.observations : [] })])) });
    assert.equal(normal.shortlist.length, 0);
    assert.equal(normal.verificationQueue.length, 1);
    assert.match(normal.verificationQueue[0].discoveryUrl, /4473136187/);
    const markdown = renderLocalLeadReport(result, { now });
    assert.match(markdown, /Strict ready: 0/); assert.match(markdown, /Needs verification: 1/); assert.match(markdown, /Rejected: 2/);
    assert.match(markdown, /SALARY|Not Verified/); assert.match(markdown, /EXPERIENCE_HARD_MIN_3_PLUS/);
  } finally { store.close(); }
});

test('failure after one detail preserves that checkpoint and card screening defers missing internship pay', async () => {
  const controller = new AbortController(); const checkpoints = [];
  const transport = async (target) => {
    if (target.includes('jobs-guest')) return { status: 200, body: cards };
    if (target.endsWith('4473136187')) return { status: 200, body: fixture('4473136187') };
    controller.abort(); throw new Error('cancelled second detail');
  };
  const result = await plan(transport, { signal: controller.signal }).fetch({ checkpoint: (payload) => checkpoints.push(payload) });
  assert.ok(result.observations[0].description);
  assert.equal(result.manifest.truncated, true);
  assert.ok(checkpoints.at(-1).cursor.completedDetails.some((c) => c.jobId === '4473136187'));
  assert.equal(screenPortalCandidate(normalizeCandidate({ ...lead, title: 'AI Engineer Intern' }), loadConfig()).eligible, true);
  assert.equal(screenPortalCandidate(normalizeCandidate({ ...lead, title: 'Senior AI Engineer' }), loadConfig()).eligible, false);
  assert.equal((await fetchLinkedIn({ queries: [{ keywords: 'AI', location: 'Pune' }], fetchText: async () => card('4473136187') + card('4473136187') })).records.length, 1);
});

test('production transport uses manual redirects and cancels oversized streaming body', async () => {
  const original = globalThis.fetch;
  let cancelled = false;
  try {
    globalThis.fetch = async (_url, options) => { assert.equal(options.redirect, 'manual'); return { status: 302, headers: new Headers({ location: '/jobs/view/4473136187' }), body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; } }) }; };
    await assert.rejects(defaultHttpTransport(url, { redirect: 'manual', maxBytes: 10 }), /response-too-large/);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = original; }
});
