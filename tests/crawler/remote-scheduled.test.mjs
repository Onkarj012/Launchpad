import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'os';
import path from 'path';
import {
  buildSourcePlans,
  runCrawlerOperator,
} from '../../crawler/operator.mjs';
import { HIMALAYAS_SEARCH_URL } from '../../job-pull/remote-adapters/himalayas.mjs';
import { JOBICY_FEED_URL } from '../../job-pull/remote-adapters/jobicy.mjs';
import { WWR_FEED_URL } from '../../job-pull/remote-adapters/weworkremotely.mjs';
import { REMOTIVE_FEED_URL } from '../../job-pull/remote-adapters/remotive.mjs';
import { REMOTEOK_FEED_URL } from '../../job-pull/remote-adapters/remoteok.mjs';

function baseSources(remote = {}) {
  return {
    atsWarm: { boards: [] },
    atsBatch1: { boards: [] },
    atsBatch2: { boards: [] },
    enterprise: { boards: [] },
    indiaStartup: { enabled: false },
    searxng: { enabled: false },
    brave: { enabled: false },
    indeed: { enabled: false },
    connectorInbox: { enabled: false },
    commercialRescue: { enabled: false },
    remote: {
      enabled: true,
      primaryProviders: ['himalayas'],
      secondaryProviders: ['jobicy', 'weworkremotely', 'remotive', 'remoteok'],
      secondaryCadenceDays: 2,
      maxRecordsPrimary: 40,
      maxRecordsPerSecondary: 25,
      ...remote,
    },
  };
}

function remoteTransport() {
  const requested = [];
  const transport = async (url) => {
    requested.push(url);
    if (url.startsWith(HIMALAYAS_SEARCH_URL)) {
      return {
        status: 200,
        body: JSON.stringify({
          jobs: [{
            title: 'AI Engineer',
            companyName: 'Himalayas Co',
            applicationLink: 'https://himalayas.app/companies/h/jobs/1',
            pubDate: 1782538666,
            locationRestrictions: ['India'],
          }],
        }),
      };
    }
    if (url === JOBICY_FEED_URL) {
      return {
        status: 200,
        body: JSON.stringify({
          jobs: [{
            jobTitle: 'ML Engineer',
            companyName: 'Jobicy Co',
            jobGeo: 'Worldwide',
            jobType: ['Full-Time'],
            url: 'https://jobicy.com/jobs/1',
            pubDate: '2026-07-23T01:00:00Z',
          }],
        }),
      };
    }
    if (url === REMOTIVE_FEED_URL) {
      return {
        status: 200,
        body: JSON.stringify({
          jobs: [{
            title: 'Backend Engineer',
            company_name: 'Remotive Co',
            url: 'https://remotive.com/remote-jobs/1',
            candidate_required_location: 'Worldwide',
            job_type: 'full_time',
            publication_date: '2026-07-20T00:00:00Z',
          }],
        }),
      };
    }
    if (url === WWR_FEED_URL) {
      return {
        status: 200,
        body: '<rss><channel><item><title><![CDATA[Full Stack Engineer]]></title><link>https://weworkremotely.com/remote-jobs/1</link><region>Worldwide</region><type>Full-Time</type><pubDate>Thu, 23 Jul 2026 01:00:00 GMT</pubDate></item></channel></rss>',
      };
    }
    if (url === REMOTEOK_FEED_URL) {
      return {
        status: 200,
        body: JSON.stringify([
          { last_updated: 1, legal: 'https://remoteok.com/legal' },
          {
            id: '42',
            position: 'Platform Engineer',
            company: 'Remoteok Co',
            location: 'Worldwide',
            date: '2026-07-22T00:00:00Z',
            url: 'https://remoteok.com/remote-jobs/42-platform',
            description: 'Worldwide remote including India.',
          },
        ]),
      };
    }
    throw new Error(`unexpected transport call: ${url}`);
  };
  return { transport, requested };
}

test('remote lanes appear in default --mode normal when sources.remote.enabled is true', () => {
  const plans = buildSourcePlans({
    config: { sources: baseSources({ enabled: true }) },
    transport: async () => ({ status: 200, body: '[]' }),
    runAt: '2026-07-24T04:30:00.000Z',
    clock: { now: () => '2026-07-24T04:30:00.000Z' },
    schedule: 'morning',
    profile: { mode: 'normal' },
  });
  assert.ok(plans.some((plan) => plan.id === 'remote-mode'));
});

test('remote lanes do not appear when sources.remote.enabled is false or mode is startup', () => {
  const disabled = buildSourcePlans({
    config: { sources: baseSources({ enabled: false }) },
    transport: async () => ({ status: 200, body: '[]' }),
    runAt: '2026-07-24T04:30:00.000Z',
    schedule: 'morning',
    profile: { mode: 'normal' },
  });
  assert.equal(disabled.some((plan) => plan.id === 'remote-mode'), false);

  const startup = buildSourcePlans({
    config: { sources: baseSources({ enabled: true }) },
    transport: async () => ({ status: 200, body: '[]' }),
    runAt: '2026-07-24T04:30:00.000Z',
    schedule: 'morning',
    profile: { mode: 'startup' },
  });
  assert.equal(startup.some((plan) => plan.id === 'remote-mode'), false);
});

test('scheduled remote run applies original-listing resolution and keeps Himalayas primary with cadence-bound secondaries', async () => {
  const { transport, requested } = remoteTransport();
  const resolverCalls = [];
  const resolver = async (observation) => {
    resolverCalls.push(observation.discoveryUrl || observation.canonicalUrl || observation.url);
    return {
      status: 'resolved',
      originalApplicationUrl: 'https://jobs.ashbyhq.com/example/role-1',
      applicationResolution: { status: 'Resolved Original', evidence: 'test-resolver original ATS' },
      evidence: { resolver: 'test-resolver', originalApplication: 'test-resolver original ATS' },
      patch: { description: observation.description || 'Resolved employer posting.' },
    };
  };

  // 2026-07-24 → secondaries on; himalayas always on
  const plansOn = buildSourcePlans({
    config: { sources: baseSources() },
    transport,
    runAt: '2026-07-24T04:30:00.000Z',
    schedule: 'morning',
    resolver,
    profile: { mode: 'normal' },
  });
  const remotePlan = plansOn.find((plan) => plan.id === 'remote-mode');
  assert.ok(remotePlan);
  const result = await remotePlan.fetch({});
  assert.ok(requested.some((url) => url.startsWith(HIMALAYAS_SEARCH_URL)));
  assert.ok(requested.some((url) => url === REMOTEOK_FEED_URL));
  assert.ok(result.observations.length >= 1);
  assert.ok(resolverCalls.length >= 1);
  assert.ok(result.observations.every((row) => row.originalApplicationUrl === 'https://jobs.ashbyhq.com/example/role-1'
    || row.applicationResolution?.status === 'Resolved Original'
    || row.applicationResolution?.status === 'Needs Verification'));
  assert.equal(result.manifest.noAutoApply, true);
  assert.equal(result.manifest.writesPlanned, false);
  assert.ok(result.manifest.telemetry.activeProviders.includes('himalayas'));
  assert.ok(result.manifest.telemetry.activeProviders.includes('remoteok'));

  // Off-cadence day: only himalayas transport should be injected
  const offRequested = [];
  const offPlans = buildSourcePlans({
    config: { sources: baseSources({ secondaryCadenceDays: 2 }) },
    transport: async (url) => {
      offRequested.push(url);
      if (url.startsWith(HIMALAYAS_SEARCH_URL)) {
        return { status: 200, body: JSON.stringify({ jobs: [] }) };
      }
      throw new Error(`secondary should not run off-cadence: ${url}`);
    },
    runAt: '2026-07-25T04:30:00.000Z',
    schedule: 'morning',
    resolver,
    profile: { mode: 'normal' },
  });
  const offResult = await offPlans.find((plan) => plan.id === 'remote-mode').fetch({});
  assert.deepEqual(offResult.manifest.telemetry.activeProviders, ['himalayas']);
  assert.ok(offRequested.every((url) => url.startsWith(HIMALAYAS_SEARCH_URL)));
  assert.equal(offRequested.some((url) => url === REMOTEOK_FEED_URL), false);
});

test('scheduled discovery run including remote lanes is planning-only with no apply/send/writes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'crawler-remote-sched-'));
  const { transport } = remoteTransport();
  const result = await runCrawlerOperator({
    config: {
      schemaVersion: 'LaunchpadCrawlerConfigV1',
      databasePath: path.join(root, 'crawler.sqlite'),
      sources: baseSources(),
    },
    runId: 'remote-scheduled-safety',
    schedule: 'morning',
    mode: 'normal',
    transport,
    clock: { now: () => '2026-07-24T04:30:00.000Z', sleep: async () => {} },
  });

  assert.equal(result.run.status, 'completed');
  assert.equal(result.plannedDownstreamHandoff.noAutoApply, true);
  assert.equal(result.plannedDownstreamHandoff.writesPlanned, false);
  assert.equal(result.plannedDownstreamHandoff.schemaVersion, 'LaunchpadV5CrawlerHandoffV1');
  // Crawler never exposes a notion write path on the handoff.
  assert.equal(result.plannedDownstreamHandoff.notionWrites, undefined);
  assert.equal('apply' in (result.plannedDownstreamHandoff || {}), false);
});
