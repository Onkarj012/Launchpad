import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../../job-pull/config.mjs';
import {
  createDiscoveryState,
  importEnvelope,
} from './logic.mjs';

const NOW = '2026-07-23T12:00:00.000Z';

test('maps a fresh relaxed two-year candidate to the controlled-reach reserve lane', () => {
  const state = importEnvelope(createDiscoveryState({ now: NOW }), {
    records: [{
      source: 'web',
      sourceJobId: 'relaxed-two-year',
      title: 'Software Engineer',
      company: 'Example Product Company',
      location: 'Pune, India',
      workMode: 'onsite',
      description: 'Full-time software engineering role requiring 2 years of experience.',
      postedAt: '2026-07-21T12:00:00.000Z',
      url: 'https://jobs.example.test/relaxed-two-year',
      originalApplicationUrl: 'https://jobs.example.test/relaxed-two-year',
      liveness: {
        status: 'Active',
        checkedAt: NOW,
        evidence: 'Direct employer application page is active.',
      },
      employment: { type: 'full-time' },
      experience: {
        minYears: 2,
        maxYears: 2,
        evidence: '2 years of experience',
      },
    }],
  }, { policy: loadConfig() });

  assert.equal(state.counts.applicationReady, 1);
  assert.equal(state.records[0].eligibility.relaxed, true);
  assert.equal(state.records[0].eligibility.reach, undefined);
  assert.equal(state.counts.shortlist, 1);
  assert.equal(state.selection.composition.controlledReaches, 1);
  assert.equal(state.shortlist[0].eligibility.reach, true);
  assert.equal(state.shortlist[0].eligibility.reachMinimumYears, 2);
});
