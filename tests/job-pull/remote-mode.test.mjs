import { withManualFixtureScores, scoredFixture } from '../fixtures/manual-scores.mjs';
// Keep fixture scores separate from discovery records.
function runRemoteMode(options) { return runRemoteModeActual(withManualFixtureScores(options)); }

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';
import { fetchHimalayas, buildHimalayasRequestPlan, HIMALAYAS_SEARCH_URL } from '../../job-pull/remote-adapters/himalayas.mjs';
import { fetchJobicy } from '../../job-pull/remote-adapters/jobicy.mjs';
import { fetchWeWorkRemotely } from '../../job-pull/remote-adapters/weworkremotely.mjs';
import { fetchRemotive } from '../../job-pull/remote-adapters/remotive.mjs';
import { enrichRemoteCandidate, classifyRemoteEligibility, classifyRemoteEmployment, classifyRemoteTimezone } from '../../job-pull/remote-enrichment.mjs';
import { runRemoteMode as runRemoteModeActual } from '../../job-pull/remote-mode.mjs';
import { REMOTE_SOURCE_LANES } from '../../job-pull/remote-sources.mjs';
import { createFakeTransactionalGateway } from '../../job-pull/remote-transaction.mjs';
import { REMOTE_NOW, remoteJob, remoteModeFixtures, remoteSourceFunctions } from '../fixtures/remote-mode.mjs';

test('Remote returns all verified results alongside a bounded shortlist', async () => {
  const result = await runRemoteMode({ clock: () => REMOTE_NOW, sourceFixtures: remoteModeFixtures(), ledgerRows: [], opportunityLedgerRows: [], shortlistLimit: 1 });
  assert.equal(result.outcome.fatal, false);
  assert.equal(result.shortlist.length, 1);
  assert.ok(result.results.length > result.shortlist.length);
  assert.ok(result.results.every((role) => role.remoteReady && role.applicationReady && role.originalApplicationUrl && role.liveness.status === 'Active'));
  assert.ok(result.results.some((role) => role.canonicalUrl === result.shortlist[0].canonicalUrl));
});

function candidate(overrides = {}) {
  return enrichRemoteCandidate(scoredFixture(remoteJob(1, { scoreOrigin: 'explicit-scored-input', responseLikelihood: 15, matchScore: 80, ...overrides }), { runAt: REMOTE_NOW, source: 'fixture', provider: overrides.provider || 'fixture', sourceKind: 'niche-public', sourceCategory: 'broad-remote' }));
}

test('Himalayas runs an India-first then worldwide search pass against the live-verified 20-record-cap contract', async () => {
  const plan = buildHimalayasRequestPlan();
  assert.equal(plan.pagination.limit, 20);
  assert.equal(plan.pagination.supported, false);
  assert.equal(plan.requests.length, 2);
  assert.equal(plan.requests[0].pass, 'india');
  assert.ok(plan.requests[0].url.startsWith(HIMALAYAS_SEARCH_URL));
  assert.ok(plan.requests[0].url.includes('country=IN'));
  assert.ok(plan.requests[0].url.includes('seniority=Entry-level'));
  assert.ok(plan.requests[0].url.includes('sort=recent'));
  assert.equal(plan.requests[1].pass, 'worldwide');
  assert.ok(plan.requests[1].url.includes('worldwide=true'));

  const requestedUrls = [];
  const result = await fetchHimalayas({ fetchJson: async (url, options) => {
    requestedUrls.push({ url, redirect: options.redirect });
    if (url.includes('country=IN')) {
      return { jobs: [{ title: 'AI Engineer', companyName: 'H', applicationLink: 'https://himalayas.app/companies/h/jobs/1', pubDate: 1782538666, expiryDate: 1790000000, employmentType: 'Full Time', locationRestrictions: ['India'], timezoneRestrictions: [5.5] }] };
    }
    return { jobs: [{ title: 'Worldwide Engineer', companyName: 'H2', applicationLink: 'https://himalayas.app/companies/h2/jobs/2', pubDate: 1782538000, employmentType: 'Full Time', locationRestrictions: [] }] };
  } });
  assert.equal(requestedUrls.length, 2);
  assert.ok(requestedUrls.every((entry) => entry.redirect === 'error'));
  assert.equal(result.records.length, 2);
  const india = result.records.find((record) => record.title === 'AI Engineer');
  assert.equal(india.providerDateEvidence, 'himalayas.pubDate');
  assert.equal(india.providerExpiryEvidence, 'himalayas.expiryDate');
  assert.equal(india.employmentType, 'Full Time');
  assert.equal(india.countryRestrictionEvidence, 'India (Himalayas locationRestrictions)');
  assert.equal(india.timezoneEvidence, 'Himalayas timezoneRestrictions (UTC offsets): 5.5');
  const worldwide = result.records.find((record) => record.title === 'Worldwide Engineer');
  assert.equal(worldwide.countryRestrictionEvidence, 'Worldwide (Himalayas locationRestrictions: empty)');
});

test('Himalayas de-duplicates a job returned by both the India and worldwide passes', async () => {
  const sharedJob = { title: 'Shared Role', companyName: 'Dup Co', applicationLink: 'https://himalayas.app/companies/dup/jobs/1', pubDate: 1782538666, locationRestrictions: ['India'] };
  const result = await fetchHimalayas({ fetchJson: async () => ({ jobs: [sharedJob] }) });
  assert.equal(result.records.length, 1);
  assert.equal(result.telemetry.pages[1].added, 0);
});

test('Jobicy and We Work Remotely preserve native pubDate evidence, honest dated counts, and real employment-type fields', async () => {
  const jobicy = await fetchJobicy({ fetchJson: async () => ({ jobs: [{ jobTitle: 'AI Engineer', companyName: 'J', jobGeo: 'Worldwide', jobType: ['Full-Time'], url: 'https://jobicy.com/jobs/1', pubDate: '2026-07-23T01:00:00Z' }] }) });
  const xml = '<rss><channel><item><title><![CDATA[W: AI Engineer]]></title><link>https://weworkremotely.com/remote-jobs/1</link><region>Worldwide</region><type>Full-Time</type><pubDate>Thu, 23 Jul 2026 01:00:00 GMT</pubDate></item></channel></rss>';
  const wwr = await fetchWeWorkRemotely({ fetchText: async () => xml });
  assert.equal(jobicy.records[0].providerDateField, 'pubDate');
  assert.equal(jobicy.records[0].employmentType, 'Full-Time');
  assert.equal(jobicy.records[0].countryRestrictionEvidence, 'Jobicy jobGeo: Worldwide');
  assert.equal(jobicy.telemetry.dated, 1);
  assert.equal(wwr.records[0].providerDateEvidence, 'weworkremotely.pubDate');
  assert.equal(wwr.records[0].employmentType, 'Full-Time');
  assert.equal(wwr.records[0].countryRestrictionEvidence, undefined);
  assert.equal(wwr.telemetry.dated, 1);
});

test('Remotive preserves provider dates and real employment/location fields, but its fresh inventory is never in the first-24-hour tier', async () => {
  const result = await fetchRemotive({ fetchJson: async () => ({ jobs: [{ title: 'AI Engineer', company_name: 'R', url: 'https://remotive.com/remote-jobs/1', candidate_required_location: 'Worldwide', job_type: 'full_time', publication_date: REMOTE_NOW }] }) });
  assert.equal(result.records[0].providerDateField, 'publication_date');
  assert.equal(result.records[0].employmentType, 'Full Time');
  assert.equal(result.records[0].countryRestrictionEvidence, 'Remotive candidate_required_location: Worldwide');
  assert.equal(result.telemetry.first24hEligible, false);

  const usOnly = await fetchRemotive({ fetchJson: async () => ({ jobs: [{ title: 'US Support', company_name: 'R', url: 'https://remotive.com/remote-jobs/2', candidate_required_location: 'USA', job_type: 'full_time', publication_date: REMOTE_NOW }] }) });
  assert.equal(usOnly.records[0].countryRestrictionEvidence, 'USA only (Remotive candidate_required_location)');

  const run = await runRemoteMode({ clock: () => REMOTE_NOW, runId: 'remotive-delay', sourceFunctions: {
    himalayas: () => ({ records: [remoteJob(1, { provider: 'himalayas', postedAt: new Date(Date.parse(REMOTE_NOW) - 2 * 3600000).toISOString(), scoreOrigin: 'explicit-scored-input', responseLikelihood: 15, matchScore: 60 })] }),
    remotive: () => ({ records: [remoteJob(2, { provider: 'remotive', location: 'Worldwide', description: 'Worldwide remote including India. Full-time role. 0-1 years.', postedAt: new Date(Date.parse(REMOTE_NOW) - 1 * 3600000).toISOString(), scoreOrigin: 'explicit-scored-input', responseLikelihood: 15, matchScore: 99 })], telemetry: { first24hEligible: false } }),
  } });
  assert.equal(run.shortlist[0].provider, 'remotive');
  assert.equal(run.shortlist.find((item) => item.provider === 'remotive')?.waterfallBand, 'strict-hot-0-72h');
  assert.equal(run.shortlist.some((item) => item.provider === 'remotive' && item.waterfallBand === 'strict-hot-0-72h'), true);
});

test('Real adapter country-restriction evidence rejects US-only/EU-only roles downstream while explicit India/APAC roles pass and context-free worldwide stays in verification', () => {
  const base = { title: 'Engineer', workMode: 'remote' };
  const usOnly = classifyRemoteEligibility({ ...base, location: 'USA', remoteEvidence: { country: 'USA only (Remotive candidate_required_location)' } });
  assert.equal(usOnly.status, 'Not Eligible');
  assert.equal(usOnly.code, 'REMOTE_COUNTRY_CITIZENSHIP_AUTH_PAYROLL_RESTRICTED');

  const euOnly = classifyRemoteEligibility({ ...base, location: 'Europe', remoteEvidence: { country: 'Europe only (Jobicy jobGeo)' } });
  assert.equal(euOnly.status, 'Not Eligible');
  assert.equal(euOnly.code, 'REMOTE_COUNTRY_CITIZENSHIP_AUTH_PAYROLL_RESTRICTED');

  const india = classifyRemoteEligibility({ ...base, location: 'India', remoteEvidence: { country: 'India (Himalayas locationRestrictions)' } });
  assert.equal(india.status, 'India Eligible');
  assert.equal(india.classification, 'india');

  const worldwide = classifyRemoteEligibility({ ...base, location: '', remoteEvidence: { country: 'Worldwide (Himalayas locationRestrictions: empty)' } });
  assert.equal(worldwide.status, 'Needs Verification');
  assert.equal(worldwide.code, 'REMOTE_SCOPE_AMBIGUOUS');

  const bareRemote = classifyRemoteEligibility({ ...base, location: 'Remote', remoteEvidence: {} });
  assert.equal(bareRemote.code, 'REMOTE_SCOPE_AMBIGUOUS');
});

test('Adapter-populated countryRestrictionEvidence and employmentType flow through remote-sources normalization into candidate.remoteEvidence', async () => {
  const run = await runRemoteMode({ clock: () => REMOTE_NOW, runId: 'remote-evidence-flow', sourceFunctions: {
    himalayas: () => ({ records: [remoteJob(1, {
      provider: 'himalayas',
      location: 'India',
      description: 'Full-time role.',
      countryRestrictionEvidence: 'India (Himalayas locationRestrictions)',
      timezoneEvidence: 'Himalayas timezoneRestrictions (UTC offsets): 5.5',
      employmentType: 'Full Time',
      employmentEvidence: 'Full Time',
    })] }),
  } });
  const [selected] = run.shortlist;
  assert.equal(selected.provider, 'himalayas');
  assert.equal(selected.remoteEvidence.country, 'India (Himalayas locationRestrictions)');
  assert.equal(selected.remoteEvidence.timezone, 'Himalayas timezoneRestrictions (UTC offsets): 5.5');
  const operation = run.plannedNotionOperations.find((item) => item.payload.Company === selected.company);
  assert.equal(operation.payload.countryRestrictionEvidence, 'India (Himalayas locationRestrictions)');
});

test('Remote eligibility classifies India, APAC, and India-available EOR evidence explicitly', () => {
  assert.equal(candidate({ location: 'Remote - India' }).remoteEligibilityDecision.classification, 'india');
  assert.equal(candidate({ location: 'Remote - APAC', description: 'Remote across APAC including India. Full-time role.' }).remoteEligibilityDecision.classification, 'apac');
  assert.equal(candidate({ location: 'Worldwide remote', description: 'Worldwide remote including India. Full-time role.' }).remoteEligibilityDecision.classification, 'india');
  const eor = candidate({ location: 'Remote - India', employment: { type: 'contract', evidence: 'Full-time contractor, ongoing, regular salary through India payroll' }, eor: { available: true, evidence: 'Employer of Record available in India' } });
  assert.equal(eor.remoteEligibilityDecision.classification, 'stable-eor');
  assert.equal(eor.remoteEmploymentDecision.category, 'Stable EOR');
});

test('Global company descriptions with a US citizenship restriction are rejected before global classification', () => {
  const result = classifyRemoteEligibility({ workMode: 'remote', description: 'We are a global SaaS company headquartered in San Francisco. This remote role requires you to be a US citizen due to government contract requirements.' });
  assert.equal(result.status, 'Not Eligible');
  assert.equal(result.code, 'REMOTE_COUNTRY_CITIZENSHIP_AUTH_PAYROLL_RESTRICTED');
});

test('India is not supported overrides APAC eligibility', () => {
  const result = classifyRemoteEligibility({ workMode: 'remote', description: 'Open to APAC candidates... India is not supported for payroll purposes at this time.' });
  assert.equal(result.status, 'Not Eligible');
  assert.equal(result.code, 'REMOTE_INDIA_EXCLUDED');
});

test('Country-first and country-qualified citizenship, residency, and work-permit restrictions are rejected', () => {
  for (const description of ['must be a US citizen', 'citizen of Canada', 'US residents only need apply', 'open to US residents only', 'residents of Canada', 'requires a valid EU work permit', 'must hold a valid work permit for the United Kingdom']) {
    const result = classifyRemoteEligibility({ workMode: 'remote', description });
    assert.equal(result.status, 'Not Eligible', description);
    assert.equal(result.code, 'REMOTE_COUNTRY_CITIZENSHIP_AUTH_PAYROLL_RESTRICTED', description);
  }
});

test('A full-time ongoing role with uncapped commission remains employment-eligible', () => {
  const result = classifyRemoteEmployment({ description: '$80k base + uncapped commission, full-time role, ongoing' });
  assert.equal(result.status, 'Eligible');
  assert.equal(result.code, 'REMOTE_FULL_TIME');
});

test('Bare remote and country/citizenship/payroll restrictions go to Needs Verification or rejection', () => {
  assert.equal(candidate({ location: 'Remote', description: 'Remote role. Full-time role.' }).remoteEligibilityDecision.code, 'REMOTE_SCOPE_AMBIGUOUS');
  assert.equal(candidate({ location: 'Remote - US only' }).remoteEligibilityDecision.status, 'Not Eligible');
  assert.equal(candidate({ location: 'Worldwide remote', description: 'US citizens only. Full-time role.' }).remoteEligibilityDecision.code, 'REMOTE_COUNTRY_CITIZENSHIP_AUTH_PAYROLL_RESTRICTED');
  assert.equal(candidate({ location: 'Worldwide remote', description: 'Payroll available in US only. Full-time role.' }).remoteEligibilityDecision.status, 'Not Eligible');
  assert.equal(candidate({ location: 'Remote', description: 'Work remotely anywhere within Europe. Full-time role.' }).remoteEligibilityDecision.status, 'Not Eligible');
});

test('Timezone overlap accepts IST, flexible and unspecified hours and labels overnight US hours', () => {
  const stable = candidate({ location: 'Remote - APAC', timezoneOverlap: { status: 'flexible', minimumHours: 6, evidence: 'any schedule accepted' }, employment: { type: 'contract', evidence: 'Long-term full-time contractor with regular salary via India payroll' } });
  const unstable = candidate({ location: 'Remote - India', employment: { type: 'contract', evidence: 'contract role, stability not stated' } });
  const overnight = classifyRemoteTimezone({ timezoneOverlap: { status: 'overnight', minimumHours: 0, evidence: 'must overlap EST business hours overnight' } });
  const ist = classifyRemoteTimezone({ timezoneOverlap: { evidence: 'Himalayas timezoneRestrictions (UTC offsets): 5.5' } });
  assert.equal(stable.timezoneDecision.accepted, true);
  assert.equal(stable.remoteEmploymentDecision.category, 'Stable Contractor');
  assert.equal(unstable.remoteEmploymentDecision.status, 'Needs Verification');
  assert.equal(overnight.accepted, true);
  assert.equal(overnight.code, 'REMOTE_TZ_NIGHT_HOURS');
  assert.deepEqual(overnight.labels, ['Night hours (IST)']);
  assert.equal(ist.accepted, true);
  assert.equal(ist.code, 'REMOTE_TZ_IST');
});

test('Remote shortlist keeps India-eligible US and EU hours with night-hours evidence', async () => {
  const run = await runRemoteMode({ clock: () => REMOTE_NOW, runId: 'remote-night-hours', sourceFunctions: {
    himalayas: () => ({ records: [
      remoteJob(1, { description: 'Full-time AI role, remote from India, 0-1 years. US business hours only.', timezoneOverlap: { status: 'overnight', minimumHours: 0, evidence: 'Must overlap EST business hours' } }),
      remoteJob(2, { description: 'Full-time AI role, remote from India, 0-1 years. EU hours only.', timezoneEvidence: 'Required overlap with CET working hours' }),
    ] }),
  } });
  assert.equal(run.shortlist.length, 2);
  for (const selected of run.shortlist) {
    assert.equal(selected.timezoneDecision.accepted, true);
    assert.deepEqual(selected.timezoneDecision.labels, ['Night hours (IST)']);
    assert.deepEqual(selected.eligibility.labels, ['Night hours (IST)']);
  }
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
  for (const { payload } of run.plannedNotionOperations) {
    for (const field of ['makeResume', 'applied', 'Make Resume', 'Applied?']) assert.equal(field in payload, false, field);
  }
  assert.equal(operation.payload.discoveryMode, 'Remote');
  assert.equal(operation.payload.schemaIntegrationRequired, true);
  assert.ok(operation.payload.missingFields.includes('employmentStructure'));
  assert.equal(operation.provenance.remote.eligibility.classification, 'india');
  assert.equal(operation.provenance.providerDateEvidence.dateField, 'pubDate');
});

test('v4 historical identity match is suppressed before the shortlist/Notion-planning step', async () => {
  const sourceFunctions = { himalayas: () => ({ records: [remoteJob(1, { provider: 'himalayas', location: 'Remote - India' })], telemetry: { dateField: 'pubDate', pages: [{ page: 1, requested: 50, returned: 1 }] } }) };
  const historicalV4Rows = [{ company: 'Remote Co 1', title: 'AI Engineer', location: 'Remote - India', state: 'applied' }];

  const baseline = await runRemoteMode({ clock: () => REMOTE_NOW, runId: 'remote-suppression-baseline', sourceFunctions });
  assert.equal(baseline.shortlist.some((candidate) => candidate.company === 'Remote Co 1'), true);

  const suppressed = await runRemoteMode({ clock: () => REMOTE_NOW, runId: 'remote-suppression', sourceFunctions, historicalV4Rows });
  assert.equal(suppressed.shortlist.some((candidate) => candidate.company === 'Remote Co 1'), false);
  assert.ok(suppressed.plannedNotionOperations.every((operation) => operation.payload.Company !== 'Remote Co 1'));
  assert.ok(suppressed.historicalSuppressions.some((item) => item.company === 'Remote Co 1'));
  assert.equal(suppressed.counts.historicalSuppressed, suppressed.historicalSuppressions.length);
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
