import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProductionResumeBuilder } from '../../resume-v5/production-builder.mjs';

function application(id, requisitionId, jdSha256, overrides = {}) {
  const packet = {
    version: 'LaunchpadApplicationEvidenceV1',
    identity: `ashby:acme:${requisitionId.toLowerCase()}`,
    company: 'Acme',
    role: 'AI Engineer',
    canonicalUrl: `https://careers.acme.example/${requisitionId}`,
    originalAtsUrl: `https://acme.ashbyhq.com/${requisitionId}`,
    provider: 'ashby',
    requisitionId,
    jdSnapshotPath: `/immutable/${requisitionId}.txt`,
    jdSnapshotBody: null,
    jdSha256,
    capturedAt: '2026-07-26T08:00:00.000Z',
    freshnessEvidence: { class: 'Hot' },
    livenessEvidence: { decision: 'Active' },
    seniority: { decision: 'Eligible', evidenceQuote: '0 to 1 years' },
    readinessDecision: 'Ready',
    scoringVersions: { match: 'v5.2' },
    sourceProvenance: { board: 'acme' },
  };
  return {
    id,
    role: 'AI Engineer',
    companyName: 'Acme',
    makeResume: true,
    status: 'Ready',
    resumeState: 'Not Started',
    requirementsEvidence: JSON.stringify(packet),
    ...overrides,
  };
}

function harness(rows) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'production-builder-'));
  const updates = [];
  let authored = 0;
  const gateway = {
    async listRows() { return rows; },
    async updatePage(_target, id, values) {
      updates.push({ id, values });
      Object.assign(rows.find((row) => row.id === id), values);
    },
  };
  return {
    root,
    updates,
    get authored() { return authored; },
    options: {
      gateway,
      stateRoot: path.join(root, 'state'),
      scratchRoot: path.join(root, 'scratch'),
      sourcesRoot: path.join(root, 'sources'),
      outputRoot: path.join(root, 'output'),
      now: () => '2026-07-26T10:00:00.000Z',
      author: async ({ paths, application: queued }) => {
        authored++;
        if (queued.id === 'app-fail') throw new Error('synthetic author failure');
        writeFileSync(paths.sourcePath, 'source');
        writeFileSync(paths.matrixPath, 'matrix');
        writeFileSync(paths.provenancePath, 'provenance');
      },
      compile: async ({ paths }) => { writeFileSync(paths.pdfPath, 'pdf'); },
      verify: async () => ({ status: 'PASS' }),
      semanticVerify: async ({ artifact }) => ({
        status: 'PASS',
        ok: true,
        verifierVersion: 'LaunchpadSemanticProvenanceV1',
        artifactDigest: `fixture:${path.basename(artifact.pdfPath)}`,
        mismatches: [],
      }),
    },
  };
}

test('unchanged Ready artifact does not rebuild', async () => {
  const rows = [application('app-1', 'REQ-1', 'a'.repeat(64))];
  const fixture = harness(rows);
  const first = await runProductionResumeBuilder(fixture.options);
  const second = await runProductionResumeBuilder(fixture.options);

  assert.equal(first.results[0].state, 'Ready');
  assert.equal(second.results[0].state, 'Ready');
  assert.equal(second.results[0].action, 'unchanged');
  assert.equal(fixture.authored, 1);
});

test('changed JD hash invalidates and rebuilds the artifact', async () => {
  const rows = [application('app-2', 'REQ-2', 'b'.repeat(64))];
  const fixture = harness(rows);
  await runProductionResumeBuilder(fixture.options);
  rows[0].requirementsEvidence = application('app-2', 'REQ-2', 'c'.repeat(64)).requirementsEvidence;
  const changed = await runProductionResumeBuilder(fixture.options);

  assert.equal(changed.results[0].state, 'Ready');
  assert.equal(changed.results[0].reason, 'JD_HASH_CHANGED');
  assert.equal(fixture.authored, 2);
});

test('same-title requisitions promote to different filenames', async () => {
  const rows = [
    application('app-3', 'REQ-3A', 'd'.repeat(64)),
    application('app-4', 'REQ-3B', 'e'.repeat(64)),
  ];
  const fixture = harness(rows);
  const result = await runProductionResumeBuilder(fixture.options);
  const paths = result.results.map((item) => item.artifact.pdfPath);

  assert.equal(new Set(paths).size, 2);
  assert.match(paths[0], /REQ_3A/);
  assert.match(paths[1], /REQ_3B/);
});

test('one failed build does not block the remaining queue', async () => {
  const rows = [
    application('app-fail', 'REQ-FAIL', 'f'.repeat(64)),
    application('app-ok', 'REQ-OK', '1'.repeat(64)),
  ];
  const fixture = harness(rows);
  const result = await runProductionResumeBuilder(fixture.options);

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.results.map((item) => [item.applicationId, item.state]), [
    ['app-fail', 'Failed'],
    ['app-ok', 'Ready'],
  ]);
});
