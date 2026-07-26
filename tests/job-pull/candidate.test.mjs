import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidate } from '../../job-pull/candidate.mjs';

test('candidate normalization retains discovery, application, remote, and work-condition evidence', () => {
  const candidate = normalizeCandidate({
    url: 'https://boards.example.test/jobs/1?utm_source=search',
    originalApplicationUrl: 'https://jobs.example.test/openings/1?utm_source=search',
    company: 'Example', title: 'AI Engineer', location: 'Remote - India',
    postedAt: '2026-07-14T08:00:00.000Z', discoveredAt: '2026-07-14T09:00:00.000Z', crawledAt: '2026-07-14T09:05:00.000Z',
    remoteEligibility: { status: 'eligible', evidence: 'India' },
    salary: { min: 800000, max: 1200000, currency: 'INR', period: 'annual', evidence: '₹8–12 LPA' },
    timezoneOverlap: { hours: 4, evidence: 'IST overlap' }, eor: { available: true }, equipment: { available: false },
    sourceKind: 'aggregator', liveness: { status: 'Active' },
  });
  assert.equal(candidate.discoveredAt, '2026-07-14T09:00:00.000Z');
  assert.equal(candidate.crawledAt, '2026-07-14T09:05:00.000Z');
  assert.equal(candidate.originalApplicationUrl, 'https://jobs.example.test/openings/1');
  assert.equal(candidate.applicationResolution.status, 'Resolved Original');
  assert.equal(candidate.remoteEligibility.status, 'India Eligible');
  assert.equal(candidate.salary.minimum, 800000);
  assert.equal(candidate.timezoneOverlap.minimumHours, 4);
  assert.equal(candidate.eor.available, true);
  assert.equal(candidate.equipment.available, false);
});
