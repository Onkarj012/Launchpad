import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitDailyReport } from '../../crawler/daily-report.mjs';

const RUN_AT = '2026-07-26T06:30:00.000Z';

function outputDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-daily-report-'));
}

function successfulRun(overrides = {}) {
  return {
    runId: 'morning-2026-07-26',
    runAt: RUN_AT,
    outcome: { status: 'ok', fatal: false },
    shortlist: [{
      company: 'Acme',
      title: 'AI Engineer',
      originalApplicationUrl: 'https://jobs.acme.test/req-1',
      liveness: { status: 'Active', checkedAt: RUN_AT, evidence: 'HTTP 200 employer page' },
      freshness: { window: 'Hot', trusted: true, evidence: 'Employer posted date' },
      seniorityAssessment: {
        seniorityDecision: 'eligible',
        evidenceQuote: '0-1 years of professional experience',
      },
      matchScore: 82,
      responseLikelihood: 71,
      strongestHook: 'Shipped an agentic job-search system',
      readinessRepair: { blockers: [] },
      selectionTier: 'Strict',
    }],
    stretchShortage: [],
    verificationQueue: [],
    sourceManifests: [{ sourceId: 'ats-warm', status: 'ok', attempted: true, fetched: 1 }],
    shortfall: {
      minimum: 10,
      selected: 1,
      missing: 9,
      reasons: ['APPLICATION_READY_MINIMUM_SHORTFALL'],
    },
    ...overrides,
  };
}

test('commits Markdown and JSON with complete delivered-role evidence and exact shortfall', () => {
  const directory = outputDirectory();
  const committed = commitDailyReport({ run: successfulRun(), directory });
  const receipt = JSON.parse(fs.readFileSync(committed.jsonPath, 'utf8'));
  const markdown = fs.readFileSync(committed.markdownPath, 'utf8');

  assert.equal(fs.existsSync(committed.markdownPath), true);
  assert.equal(fs.existsSync(committed.jsonPath), true);
  assert.deepEqual(Object.keys(receipt.selectedRoles[0]).sort(), [
    'company',
    'freshness',
    'liveness',
    'matchScore',
    'originalUrl',
    'readiness',
    'responseLikelihood',
    'seniority',
    'strongestHook',
    'title',
  ]);
  assert.equal(receipt.selectedRoles[0].seniority.evidenceQuote, '0-1 years of professional experience');
  assert.equal(receipt.shortfall.explanation, 'Selected 1 of the minimum 10 application-ready roles; shortfall 9. Reasons: APPLICATION_READY_MINIMUM_SHORTFALL.');
  assert.match(markdown, /## Selected roles/);
  assert.match(markdown, /## Shortage fallback and stretch/);
  assert.match(markdown, /## Verification queue/);
  assert.match(markdown, /## Source health/);
});

test('rerun with the same run ID is idempotent', () => {
  const directory = outputDirectory();
  const first = commitDailyReport({ run: successfulRun(), directory });
  const before = fs.readFileSync(first.jsonPath, 'utf8');
  const second = commitDailyReport({ run: successfulRun(), directory });

  assert.equal(second.idempotent, true);
  assert.equal(fs.readFileSync(second.jsonPath, 'utf8'), before);
  assert.equal(second.markdownPath, first.markdownPath);
});

test('failed report rename leaves no final report', () => {
  const directory = outputDirectory();
  assert.throws(() => commitDailyReport({
    run: successfulRun(),
    directory,
    fileOps: {
      renameSync() { throw new Error('injected rename failure'); },
    },
  }), /injected rename failure/);

  assert.deepEqual(fs.readdirSync(directory), []);
});

test('kill hook between durable temp write and rename leaves no partial report', () => {
  const directory = outputDirectory();
  assert.throws(() => commitDailyReport({
    run: successfulRun(),
    directory,
    beforeRename() {
      const error = new Error('simulated process kill');
      error.code = 'SIMULATED_KILL';
      throw error;
    },
  }), /simulated process kill/);

  assert.deepEqual(fs.readdirSync(directory), []);
});
