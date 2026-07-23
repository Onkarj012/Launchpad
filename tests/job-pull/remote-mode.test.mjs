import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { fetchHimalayas, buildHimalayasRequestPlan, HIMALAYAS_FEED_URL } from '../../job-pull/remote-adapters/himalayas.mjs';
import { fetchJobicy } from '../../job-pull/remote-adapters/jobicy.mjs';
import { fetchWeWorkRemotely } from '../../job-pull/remote-adapters/weworkremotely.mjs';
import { fetchRemotive } from '../../job-pull/remote-adapters/remotive.mjs';
import { enrichRemoteCandidate, classifyRemoteEligibility, classifyRemoteEmployment } from '../../job-pull/remote-enrichment.mjs';
import { runRemoteMode } from '../../job-pull/remote-mode.mjs';
import { REMOTE_SOURCE_LANES } from '../../job-pull/remote-sources.mjs';
import { createFakeTransactionalGateway } from '../../job-pull/remote-transaction.mjs';
import { REMOTE_NOW, remoteJob, remoteModeFixtures, remoteSourceFunctions } from '../fixtures/remote-mode.mjs';

function candidate(overrides = {}) {
  return enrichRemoteCandidate(normalizeCandidate(remoteJob(1, { matchScore: 80, ...overrides }), { runAt: REMOTE_NOW, source: 'fixture', provider: overrides.provider || 'fixture', sourceKind: 'niche-public', sourceCategory: 'broad-remote' }));
}

test('Himalayas exposes the documented limit=50 request and page/date metadata without inventing pagination', async () => {
  assert.equal(buildHimalayasRequestPlan().requests[0].url, HIMALAYAS_FEED_URL);
  assert.equal(buildHimalayasRequestPlan().pagination.limit, 50);
  assert.equal(buildHimalayasRequestPlan().pagination.supported, false);
  assert.throws(() => buildHimalayasRequestPlan({ limit: 100 }), /limit=50/);
  let requested;
  const result = await fetchHimalayas({ fetchJson: async (url, options) => { requested = { url, options }; return { jobs: [{ title: 'AI Engineer', companyName: 'H', applicationLink: 'https://himalayas.app/companies/h/jobs/1', pubDate: 1782538666 }] }; } });
  assert.equal(requested.url, HIMALAYAS_FEED_URL);
  assert.equal(requested.options.redirect, 'error');
  assert.equal(result.telemetry.pages[0].requested, 50);
  assert.equal(result.records[0].providerDateEvidence, 'himalayas.pubDate');
});

test('Jobicy and We Work Remotely preserve native pubDate evidence and honest dated counts', async () => {
  const jobicy = await fetchJobicy({ fetchJson: async () => ({ jobs: [{ jobTitle: 'AI Engineer', companyName: 'J', jobGeo: 'Worldwide', url: 'https://jobicy.com/jobs/1', pubDate: '2026-07-23T01:00:00Z' }] }) });
  const xml = '<rss><channel><item><title><![CDATA[W: AI Engineer]]></title><link>https://weworkremotely.com/remote-jobs/1</link><region>Worldwide</region><pubDate>Thu, 23 Jul 2026 01:00:00 GMT</pubDate></item></channel></rss>';
  const wwr = await fetchWeWorkRemotely({ fetchText: async () => xml });
  assert.equal(jobicy.records[0].providerDateField, 'pubDate');
  assert.equal(jobicy.telemetry.dated, 1);
  assert.equal(wwr.records[0].providerDateEvidence, 'weworkremotely.pubDate');
  assert.equal(wwr.telemetry.dated, 1);
});

test('Remotive preserves provider dates but its fresh inventory is never in the first-24-hour tier', async () => {
  const result = await fetchRemotive({ fetchJson: async () => ({ jobs: [{ title: 'AI Engineer', company_name: 'R', url: 'https://remotive.com/remote-jobs/1', candidate_required_location: 'Worldwide', publication_date: REMOTE_NOW }] }) });
  assert.equal(result.records[0].providerDateField, 'publication_date');
  assert.equal(result.telemetry.first24hEligible, false);
  const run = await runRemoteMode({ clock: () => REMOTE_NOW, runId: 'remotive-delay', sourceFunctions: {
    himalayas: () => ({ records: [remoteJob(1, { provider: 'himalayas', postedAt: new Date(Date.parse(REMOTE_NOW) - 2 * 3600000).toISOString(), matchScore: 60 })] }),
    remotive: () => ({ records: [remoteJob(2, { provider: 'remotive', location: 'Worldwide', description: 'Worldwide remote including India. Full-time role. 0-1 years.', postedAt: new Date(Date.parse(REMOTE_NOW) - 1 * 3600000).toISOString(), matchScore: 99 })], telemetry: { first24hEligible: false } }),
  } });
  assert.equal(run.shortlist[0].provider, 'himalayas');
  assert.equal(run.shortlist.find((item) => item.provider === 'remotive')?.waterfallBand, 'remotive-delayed-0-24h');
  assert.equal(run.shortlist.some((item) => item.provider === 'remotive' && item.waterfallBand === 'strict-0-24h'), false);
});

test('Remote eligibility classifies India, APAC, global, and India-available EOR evidence explicitly', () => {
  assert.equal(candidate({ location: 'Remote - India' }).remoteEligibilityDecision.classification, 'india');
  assert.equal(candidate({ location: 'Remote - APAC', description: 'Remote across APAC including India. Full-time role.' }).remoteEligibilityDecision.classification, 'apac');
  assert.equal(candidate({ location: 'Worldwide remote', description: 'Worldwide remote including India. Full-time role.' }).remoteEligibilityDecision.classification, 'global');
  const eor = candidate({ location: 'Remote - India', employment: { type: 'contract', evidence: 'Full-time contractor, ongoing, regular salary through India payroll' }, eor: { available: true, evidence: 'Employer of Record available in India' } });
  assert.equal(eor.remoteEligibilityDecision.classification, 'stable-eor');
  assert.equal(eor.remoteEmploymentDecision.category, 'Stable EOR');
});

test('Bare remote and country/citizenship/payroll restrictions go to Needs Verification or rejection', () => {
  assert.equal(candidate({ location: 'Remote', description: 'Remote role. Full-time role.' }).remoteEligibilityDecision.code, 'REMOTE_SCOPE_AMBIGUOUS');
  assert.equal(candidate({ location: 'Remote - US only' }).remoteEligibilityDecision.status, 'Not Eligible');
  assert.equal(candidate({ location: 'Worldwide remote', description: 'US citizens only. Full-time role.' }).remoteEligibilityDecision.code, 'REMOTE_COUNTRY_CITIZENSHIP_AUTH_PAYROLL_RESTRICTED');
  assert.equal(candidate({ location: 'Worldwide remote', description: 'Payroll available in US only. Full-time role.' }).remoteEligibilityDecision.status, 'Not Eligible');
  assert.equal(candidate({ location: 'Remote', description: 'Work remotely anywhere within Europe. Full-time role.' }).remoteEligibilityDecision.status, 'Not Eligible');
});

test('All timezone requirements are accepted, while stable Contractor/EOR requires stability and payroll evidence', () => {
  const stable = candidate({ location: 'Remote - APAC', timezoneOverlap: { status: 'overnight', minimumHours: 0, evidence: 'any schedule accepted' }, employment: { type: 'contract', evidence: 'Long-term full-time contractor with regular salary via India payroll' } });
  const unstable = candidate({ location: 'Remote - India', employment: { type: 'contract', evidence: 'contract role, stability not stated' } });
  assert.equal(stable.timezoneDecision.accepted, true);
  assert.equal(stable.remoteEmploymentDecision.category, 'Stable Contractor');
  assert.equal(unstable.remoteEmploymentDecision.status, 'Needs Verification');
});

test('Gigs, commission-only, temporary, project-only, and unpredictable freelance roles are rejected', () => {
  for (const evidence of ['gig work', 'commission-only role', 'temporary role', 'project-only contract', 'unpredictable freelance work']) {
    const result = candidate({ employment: { type: 'contract', evidence }, description: `Remote in India. ${evidence}.` });
    assert.equal(result.remoteEmploymentDecision.status, 'Not Eligible', evidence);
    assert.equal(result.remoteEmploymentDecision.code, 'REMOTE_UNSTABLE_GIG_OR_FREELANCE', evidence);
  }
});

test('Remote mode records mode identity, readiness evidence, dedup, original application, liveness, and exact provider telemetry', async () => {
  const fixtures = remoteModeFixtures();
  fixtures['remote-ats'].records.push(remoteJob(1, { url: 'https://remote-fixture.example/jobs/duplicate', originalApplicationUrl: null, applicationResolution: null }));
  fixtures.wellfound.records.push(remoteJob(20, { liveness: { status: 'Not Verified' }, originalApplicationUrl: null, applicationResolution: null }));
  const run = await runRemoteMode({ clock: () => REMOTE_NOW, runId: 'remote-contract', sourceFunctions: remoteSourceFunctions(fixtures) });
  assert.equal(run.mode, 'remote');
  assert.equal(run.discoveryMode, 'Remote');
  assert.equal(run.sourceManifests.find((manifest) => manifest.sourceId === 'himalayas').requestPlan.pagination.supported, false);
  assert.equal(run.shortlist.some((item) => item.canonicalUrl.includes('/duplicate')), false);
  assert.ok(run.shortlist.every((item) => item.applicationReady && item.originalApplicationUrl && item.liveness.status === 'Active'));
  assert.ok(run.verificationQueue.some((record) => record.liveness.status === 'Not Verified'));
});

test('Remote payloads preserve provenance and explicitly report the additive schema integration gap', async () => {
  const run = await runRemoteMode({ clock: () => REMOTE_NOW, runId: 'remote-payload', sourceFunctions: { himalayas: () => ({ records: [remoteJob(1, { provider: 'himalayas', providerDateField: 'pubDate', providerDateEvidence: 'himalayas.pubDate' })], telemetry: { dateField: 'pubDate', pages: [{ page: 1, requested: 50, returned: 1 }] } }) } });
  const operation = run.plannedNotionOperations[0];
  assert.equal(operation.payload.discoveryMode, 'Remote');
  assert.equal(operation.payload.schemaIntegrationRequired, true);
  assert.ok(operation.payload.missingFields.includes('employmentStructure'));
  assert.equal(operation.provenance.remote.eligibility.classification, 'india');
  assert.equal(operation.provenance.providerDateEvidence.dateField, 'pubDate');
});

test('Provider failures degrade coverage visibly without making Remote mode fatal', async () => {
  const run = await runRemoteMode({ clock: () => REMOTE_NOW, sourceFunctions: { himalayas: () => { throw new Error('fixture provider timeout'); } } });
  assert.equal(run.outcome.fatal, false);
  assert.equal(run.outcome.degraded, true);
  assert.equal(run.sourceManifests.find((manifest) => manifest.sourceId === 'himalayas').status, 'failed');
  assert.equal(run.sourceManifests.find((manifest) => manifest.sourceId === 'himalayas').errors[0], 'fixture provider timeout');
});

test('Remote execution is planning-only by default and fake-gateway execution proves reserve/write/verify/commit without live access', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('live access must not occur'); };
  try {
    const gateway = createFakeTransactionalGateway();
    const run = await runRemoteMode({ clock: () => REMOTE_NOW, runId: 'remote-transaction', sourceFunctions: { himalayas: () => ({ records: [remoteJob(1)] }) }, notionGateway: gateway, executeGateway: true });
    assert.equal(run.outcome.fatal, false);
    assert.equal(run.transaction.status, 'committed');
    assert.deepEqual(gateway.events.map((event) => event.stage), ['reserve', 'write', 'verify', 'commit']);
  } finally { globalThis.fetch = originalFetch; }
});
