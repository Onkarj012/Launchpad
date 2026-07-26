import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationIdentity,
  createApplicationEvidencePacket,
  evidencePacketValues,
  verifyApplicationEvidencePacket,
} from '../../resume-v5/application-evidence.mjs';

function evidence(overrides = {}) {
  return {
    company: 'Acme',
    role: 'AI Engineer',
    canonicalUrl: 'https://careers.acme.example/jobs/REQ-42',
    originalAtsUrl: 'https://acme.ashbyhq.com/job/REQ-42',
    provider: 'ashby',
    requisitionId: 'REQ-42',
    jdSnapshotBody: 'abc',
    freshnessEvidence: { class: 'Hot', observedAt: '2026-07-26T08:00:00.000Z' },
    livenessEvidence: { decision: 'Active', checkedAt: '2026-07-26T08:05:00.000Z' },
    seniorityDecision: 'Eligible',
    seniorityEvidenceQuote: '0 to 1 years of experience',
    readinessDecision: 'Ready',
    scoringVersions: { match: 'v5.2', readiness: 'v5.1' },
    sourceProvenance: { adapter: 'ashby', board: 'acme' },
    ...overrides,
  };
}

test('JD SHA-256 is stable for the immutable snapshot bytes', () => {
  const first = createApplicationEvidencePacket(evidence(), { now: '2026-07-26T09:00:00.000Z' });
  const second = createApplicationEvidencePacket(evidence({ canonicalUrl: 'https://careers.acme.example/renamed/REQ-42' }), { now: '2026-07-26T10:00:00.000Z' });

  assert.equal(first.jdSha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(second.jdSha256, first.jdSha256);
});

test('requisition identity survives URL changes and separates same-title requisitions', () => {
  const moved = evidence({ canonicalUrl: 'https://jobs.acme.example/new/REQ-42' });
  assert.equal(applicationIdentity(evidence()), applicationIdentity(moved));
  assert.notEqual(applicationIdentity(evidence()), applicationIdentity(evidence({ requisitionId: 'REQ-43' })));
});

test('evidence packet retains a captured-at timestamp and all readiness evidence', () => {
  const packet = createApplicationEvidencePacket(evidence(), { now: '2026-07-26T09:00:00.000Z' });
  const verification = verifyApplicationEvidencePacket(packet);

  assert.equal(verification.valid, true);
  assert.equal(packet.capturedAt, '2026-07-26T09:00:00.000Z');
  assert.equal(packet.seniority.evidenceQuote, '0 to 1 years of experience');
  assert.equal(packet.readinessDecision, 'Ready');
  assert.deepEqual(packet.scoringVersions, { match: 'v5.2', readiness: 'v5.1' });
  assert.deepEqual(JSON.parse(evidencePacketValues(packet).requirementsEvidence), packet);
  assert.equal(Object.isFrozen(packet), true);
});
