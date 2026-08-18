import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackedCandidatesFromJson, runTrackedScan } from '../../job-pull/adapters/tracked.mjs';
import { reverseAtsCandidatesFromJson, REVERSE_ATS, runReverseAtsScan } from '../../job-pull/adapters/reverse-ats.mjs';
import { fullScan, seedFromHistory } from '../../job-pull/reverse-warm-scan.mjs';
import { importPublicSearchCandidates } from '../../job-pull/adapters/public-search.mjs';
import { importIndeedCandidates } from '../../job-pull/adapters/indeed.mjs';
import { deriveProvider, normalizeSourceRecords } from '../../job-pull/adapters/common.mjs';

const record = {
  url: 'https://jobs.example.test/1', source: 'greenhouse-api', company: 'Example', title: 'AI Engineer', location: 'Pune', id: '1',
  postedAt: '2026-07-14T08:00:00.000Z', employment: { type: 'full-time' },
};

test('tracked and reverse ATS fixtures normalize provider and current-feed liveness', () => {
  const tracked = trackedCandidatesFromJson({ offers: [record] }, { runAt: '2026-07-14T09:00:00.000Z' });
  assert.equal(tracked.candidates[0].provider, 'greenhouse');
  assert.equal(tracked.candidates[0].liveness.status, 'Active');
  assert.equal(tracked.manifest.fetched, 1);

  const reverse = reverseAtsCandidatesFromJson({ offers: [{ ...record, source: 'ashby-full' }] }, { runAt: '2026-07-14T09:00:00.000Z' });
  assert.deepEqual(reverse.manifest.providers, REVERSE_ATS);
  assert.equal(reverse.candidates[0].provider, 'ashby');
});

test('reverse ATS degraded boards do not claim per-provider success without statuses', () => {
  const result = reverseAtsCandidatesFromJson({ offers: [], unreachableBoards: 1 });
  assert.ok(result.manifest.providerAttempts.every((attempt) => attempt.status === 'degraded'));
});

test('public search keeps Not Verified and Indeed is honestly unavailable', () => {
  const publicResult = importPublicSearchCandidates([record], { runAt: '2026-07-14T09:00:00.000Z' });
  assert.equal(publicResult.candidates[0].liveness.status, 'Not Verified');
  const indeed = importIndeedCandidates(null);
  assert.equal(indeed.candidates.length, 0);
  assert.equal(indeed.manifest.status, 'unavailable');
  assert.equal(indeed.manifest.reasonCode, 'INDEED_CONNECTOR_UNAVAILABLE');
});

test('scanner wrappers fail clearly when --json is not implemented', () => {
  assert.throws(() => runTrackedScan({ careerOpsDir: '/tmp', execute: () => 'human scanner output' }), /contract error.*expected JSON/);
});

test('tracked scanner executes vendored code with mutable state cwd and tracked config', () => {
  const stateDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'launchpad-career-ops-')), 'state');
  let invocation;
  runTrackedScan({
    careerOpsDir: stateDir,
    execute: (command, args, options) => {
      invocation = { command, args, options };
      return JSON.stringify({ offers: [] });
    },
  });
  assert.equal(invocation.command, process.execPath);
  assert.match(invocation.args[0], /vendor\/career-ops\/scan\.mjs$/);
  assert.equal(invocation.options.cwd, stateDir);
  assert.match(invocation.options.env.CAREER_OPS_PORTALS, /config\/career-ops-portals\.yml$/);
  assert.equal(existsSync(stateDir), true);
});

test('reverse ATS scanner uses the supplied mutable state cwd', () => {
  const stateDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'launchpad-reverse-ats-')), 'state');
  let invocation;
  runReverseAtsScan({
    careerOpsDir: stateDir,
    execute: (command, args, options) => {
      invocation = { command, args, options };
      return JSON.stringify({ offers: [] });
    },
  });
  assert.equal(invocation.command, process.execPath);
  assert.match(invocation.args[0], /job-pull\/reverse-warm-scan\.mjs$/);
  assert.equal(invocation.options.cwd, stateDir);
  assert.equal(existsSync(stateDir), true);
});

test('reverse full scan and history use runtime state paths', () => {
  let fullInvocation;
  fullScan({
    ats: ['greenhouse'],
    sinceDays: 3,
    portalsPath: path.resolve('config/career-ops-portals.yml'),
    execute: (command, args, options) => {
      fullInvocation = { command, args, options };
      return JSON.stringify({ offers: [] });
    },
  }, () => {});
  assert.equal(fullInvocation.command, process.execPath);
  assert.match(fullInvocation.args[0], /vendor\/career-ops\/scan-ats-full\.mjs$/);
  assert.equal(fullInvocation.options.cwd, process.cwd());
  assert.equal(fullInvocation.options.env.CAREER_OPS_PORTALS, path.resolve('config/career-ops-portals.yml'));

  let historyPath;
  seedFromHistory({ dryRun: true, warmSetPath: path.join(os.tmpdir(), 'unused-warm-set.json') }, () => {}, (scanHistoryPath) => {
    historyPath = scanHistoryPath;
    return { boards: { greenhouse: [], lever: [], ashby: [], workday: [] } };
  });
  assert.equal(historyPath, path.join(process.cwd(), 'data', 'scan-history.tsv'));
  assert.notEqual(historyPath, path.join(process.cwd(), 'career-ops', 'data', 'scan-history.tsv'));
});

test('known public ATS URLs classify as direct metadata without claiming a new scanner', () => {
  assert.equal(deriveProvider({ url: 'https://apply.workable.com/acme/j/1' }), 'workable');
  assert.equal(deriveProvider({ url: 'https://jobs.smartrecruiters.com/acme/1' }), 'smartrecruiters');
  assert.equal(deriveProvider({ url: 'https://acme.breezy.hr/p/1' }), 'breezy');
  assert.equal(deriveProvider({ url: 'https://acme.recruitee.com/o/1' }), 'recruitee');
  const [candidate] = normalizeSourceRecords([{ ...record, url: 'https://apply.workable.com/acme/j/1', source: 'public-search' }], {
    source: 'public-search', sourceKind: 'aggregator', runAt: '2026-07-14T09:00:00.000Z', currentFeedIsLive: false,
  });
  assert.equal(candidate.provider, 'workable');
  assert.equal(candidate.sourceKind, 'ats-direct');
  assert.equal(candidate.applicationResolution.status, 'Direct ATS');
});
