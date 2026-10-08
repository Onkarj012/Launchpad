export const STARTUP_NOW = '2026-07-23T06:30:00.000Z';

function job(index, overrides = {}) {
  return {
    url: `https://jobs.startup-fixture.test/${index}`,
    company: `Startup Co ${index}`,
    title: 'AI Engineer',
    location: 'Pune, India',
    postedAt: new Date(Date.parse(STARTUP_NOW) - (index % 3) * 3600000).toISOString(),
    employment: { type: 'full-time', evidence: 'full-time' },
    experience: { minYears: 0, maxYears: 1, evidence: '0-1 years' },
    liveness: { status: 'Active', checkedAt: STARTUP_NOW, evidence: 'fixture employer page check' },
    scoreOrigin: 'explicit-scored-input', responseLikelihood: 15,
    matchScore: 80 - index,
    originalApplicationUrl: `https://careers.startup-fixture.test/${index}`,
    originalApplicationEvidence: 'fixture employer ATS resolution',
    applicationResolution: { status: 'Resolved Original', evidence: 'fixture employer ATS resolution' },
    description: `Build AI product services for startup fixture ${index}; Python and APIs.`,
    ...overrides,
  };
}

export function startupModeFixtures() {
  return {
    'startup-employer-boards': {
      records: [job(1, { sourceKind: 'ats-direct', provider: 'greenhouse', originalApplicationUrl: null, applicationResolution: null })],
      companyRecords: [{ company: 'Startup Co 1', stage: 'Scale-up', stageEvidence: 'Series A startup profile', employeeCount: 42, careerPageUrl: 'https://startupco1.example/careers', atsProvider: 'greenhouse', atsBoardUrl: 'https://boards.greenhouse.io/startupco1', remotePolicy: 'Pune hybrid', verifiedAt: STARTUP_NOW }],
    },
    'vc-portfolio-boards': {
      records: [job(2), job(1, { url: 'https://vc.example/jobs/duplicate', sourceKind: 'aggregator', provider: 'vc-portfolio' })],
      companyRecords: [{ company: 'Startup Co 2', stage: 'Startup', stageEvidence: 'VC portfolio company page', sourceUrl: 'https://vc.example/portfolio/startup-2', verifiedAt: STARTUP_NOW }],
    },
    yc: { records: [job(3)], companyRecords: [{ company: 'Startup Co 3', stage: 'Startup', verifiedAt: STARTUP_NOW }] },
    wellfound: { records: [job(4, { url: 'https://wellfound.example/jobs/4', provider: 'wellfound' })] },
    'india-startup-directories': { records: [job(5), job(6)] },
    'startup-watchlist': { records: [job(7), job(8)] },
    'funding-hiring-signals': {
      signals: [
        { company: 'Startup Co 2', fundingDate: '2026-05-10', fundingEvidence: 'Verified Series A announcement', sourceUrl: 'https://funding.example/series-a-2', verifiedAt: STARTUP_NOW, hiringSignal: 'Hiring engineers after round' },
        { company: 'Startup Co 9', fundingDate: '2024-03-01', fundingEvidence: 'Older funding announcement', sourceUrl: 'https://funding.example/old-9', verifiedAt: STARTUP_NOW },
      ],
    },
  };
}

export function startupSourceFunctions() {
  const fixtures = startupModeFixtures();
  return Object.fromEntries(Object.entries(fixtures).map(([lane, output]) => [lane, () => structuredClone(output)]));
}
