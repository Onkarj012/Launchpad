export const REMOTE_NOW = '2026-07-23T06:30:00.000Z';

function posted(hours) {
  return new Date(Date.parse(REMOTE_NOW) - hours * 3600000).toISOString();
}

export function remoteJob(index, overrides = {}) {
  return {
    url: `https://remote-fixture.example/jobs/${index}`,
    company: `Remote Co ${index}`,
    title: 'AI Engineer',
    location: 'Remote - India',
    description: 'Remote in India. Full-time role. 0-1 years experience. Build AI services with Python.',
    postedAt: posted(index % 6 + 2),
    employment: { type: 'full-time', evidence: 'full-time employment' },
    experience: { minYears: 0, maxYears: 1, evidence: '0-1 years' },
    liveness: { status: 'Active', checkedAt: REMOTE_NOW, evidence: 'fixture original application check' },
    originalApplicationUrl: `https://careers.remote-fixture.example/jobs/${index}`,
    originalApplicationEvidence: 'fixture employer ATS resolution',
    applicationResolution: { status: 'Resolved Original', evidence: 'fixture employer ATS resolution' },
    matchScore: 90 - index,
    ...overrides,
  };
}

export function remoteModeFixtures() {
  return {
    'remote-ats': { records: [remoteJob(1, { provider: 'greenhouse', sourceKind: 'ats-direct', location: 'Remote - India' })] },
    yc: { records: [remoteJob(2, { provider: 'yc', location: 'Remote - APAC', description: 'Remote across APAC including India. Full-time role. 0-1 years.' })] },
    wellfound: { records: [remoteJob(3, { provider: 'wellfound', location: 'Worldwide remote', description: 'Worldwide remote, including India. Full-time role. 0-1 years.' })] },
    'bounded-remote-search': { records: [remoteJob(4, { location: 'Remote - India' })] },
    himalayas: { records: [remoteJob(5, { provider: 'himalayas', location: 'Remote - India' })], telemetry: { dateField: 'pubDate', pages: [{ page: 1, requested: 50, returned: 1 }], requestPlan: { pagination: { supported: false }, requests: [{ page: 1, limit: 50 }] } } },
    jobicy: { records: [remoteJob(6, { provider: 'jobicy', location: 'Remote - India', providerDateField: 'pubDate', providerDateEvidence: 'jobicy.pubDate' })], telemetry: { dateField: 'pubDate', pages: [{ page: 1, requested: 50, returned: 1 }] } },
    weworkremotely: { records: [remoteJob(7, { provider: 'weworkremotely', location: 'Worldwide', description: 'Worldwide remote including India. Full-time role. 0-1 years.', providerDateField: 'pubDate', providerDateEvidence: 'weworkremotely.pubDate' })], telemetry: { dateField: 'pubDate', pages: [{ page: 1, returned: 1 }] } },
    remotive: { records: [remoteJob(8, { provider: 'remotive', location: 'Worldwide', description: 'Worldwide remote including India. Full-time role. 0-1 years.', postedAt: posted(3), remoteProviderPolicy: { first24hEligible: false, reason: 'delayed inventory' } })], telemetry: { dateField: 'publication_date', first24hEligible: false, pages: [{ page: 1, returned: 1 }] } },
    remoteok: { records: [remoteJob(9, { provider: 'remoteok', location: 'Worldwide', description: 'Worldwide remote including India. Full-time role. 0-1 years.', providerDateField: 'date', providerDateEvidence: 'remoteok.date', feedPublishedAt: posted(4) })], telemetry: { dateField: 'date', pages: [{ page: 1, returned: 1 }] } },
  };
}

export function remoteSourceFunctions(fixtures = remoteModeFixtures()) {
  return Object.fromEntries(Object.entries(fixtures).map(([lane, output]) => [lane, () => structuredClone(output)]));
}
