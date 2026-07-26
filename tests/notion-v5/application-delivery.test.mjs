import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplicationEvidencePacket } from '../../resume-v5/application-evidence.mjs';
import { deliverApplicationsV5 } from '../../resume-v5/application-delivery.mjs';

function operation(id = 'REQ-1') {
  const evidencePacket = createApplicationEvidencePacket({
    company: 'Acme',
    role: 'AI Engineer',
    canonicalUrl: `https://careers.acme.example/${id}`,
    originalAtsUrl: `https://acme.ashbyhq.com/${id}`,
    provider: 'ashby',
    requisitionId: id,
    jdSnapshotBody: 'Requires Python.',
    freshnessEvidence: { class: 'Hot' },
    livenessEvidence: { decision: 'Active' },
    seniorityDecision: 'Eligible',
    seniorityEvidenceQuote: '0 to 1 years',
    readinessDecision: 'Ready',
    scoringVersions: { match: 'v5.2' },
    sourceProvenance: { board: 'acme' },
  }, { now: '2026-07-26T09:00:00.000Z' });
  return {
    resource: 'application',
    operation: 'create',
    payload: { role: 'AI Engineer', company: 'Acme', evidencePacket },
    company: { name: 'Acme', canonicalDomain: 'acme.example' },
  };
}

function receiptPath() {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'application-delivery-')), 'receipt.json');
}

test('default mode performs no external application write', async () => {
  let writes = 0;
  const receipt = receiptPath();
  const result = await deliverApplicationsV5({
    operations: [operation()],
    gateway: { live: true, async runTransaction() { writes++; } },
    receiptPath: receipt,
  });

  assert.equal(result.status, 'disabled');
  assert.equal(result.externalWrites, 0);
  assert.equal(writes, 0);
  assert.equal(existsSync(receipt), false);
});

test('partial external state is not success and recovery can finish surfacing', async () => {
  const receipt = receiptPath();
  let attempts = 0;
  let surfaced = 0;
  const gateway = {
    live: true,
    async runTransaction({ work }) {
      attempts++;
      if (attempts === 1) return { status: 'partial', key: 'delivery' };
      return { status: 'committed', key: 'delivery', result: await work({ checkpoint: async () => {} }) };
    },
    async writeApplication() { return { page: { id: 'app-page' }, company: { id: 'company-page' }, relationVerified: true }; },
  };
  const options = {
    operations: [operation()],
    gateway,
    receiptPath: receipt,
    liveWriteAuthorized: true,
    commitLocal: async () => ({ status: 'committed', path: '/local/report.json' }),
    markSurfaced: async () => { surfaced++; return { status: 'committed' }; },
  };
  const first = await deliverApplicationsV5(options);
  assert.equal(first.status, 'recovery-required');
  assert.equal(surfaced, 0);
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).state, 'external-pending');

  const recovered = await deliverApplicationsV5(options);
  assert.equal(recovered.status, 'committed');
  assert.equal(surfaced, 1);
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).state, 'committed');
});

test('v5 failure never invokes a legacy fallback', async () => {
  let legacyCalls = 0;
  const result = await deliverApplicationsV5({
    operations: [operation()],
    gateway: { live: true, async runTransaction() { throw new Error('synthetic v5 failure'); } },
    legacyGateway: { async writeApplications() { legacyCalls++; } },
    receiptPath: receiptPath(),
    liveWriteAuthorized: true,
    commitLocal: async () => ({ status: 'committed' }),
    markSurfaced: async () => { throw new Error('must not surface'); },
  });

  assert.equal(result.status, 'recovery-required');
  assert.equal(result.legacyFallback, false);
  assert.equal(legacyCalls, 0);
});
