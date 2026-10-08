export const INTERNSHIP_NOW = '2026-07-23T06:30:00.000Z';

export function internshipFixture(index, overrides = {}) {
  return {
    url: `https://jobs.example.test/internship/${index}`,
    company: `Intern Company ${index}`,
    title: 'AI Engineer Intern',
    description: 'PPO based on performance after the internship.',
    location: 'Pune, India',
    workMode: 'onsite',
    postedAt: INTERNSHIP_NOW,
    employment: { type: 'internship', paid: true, evidence: 'Paid internship' },
    stipend: { amount: 40000, currency: 'INR', period: 'month', raw: 'INR 40,000/month', evidence: 'Stipend: INR 40,000/month' },
    experience: { minYears: 0, maxYears: 1, evidence: '0-1 years' },
    liveness: { status: 'Active', checkedAt: INTERNSHIP_NOW, evidence: 'employer page checked' },
    sourceKind: 'ats-direct',
    ...overrides,
  };
}

export function remoteInternshipFixture(index, overrides = {}) {
  return internshipFixture(index, {
    location: 'Remote - Worldwide',
    workMode: 'remote',
    remoteEligibility: { status: 'India Eligible', evidence: 'Posting explicitly accepts applicants in India' },
    ...overrides,
  });
}
