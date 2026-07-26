import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const APPLICATION_EVIDENCE_VERSION = 'LaunchpadApplicationEvidenceV1';

export class ApplicationEvidenceError extends Error {
  constructor(message, code = 'APPLICATION_EVIDENCE_INVALID', details = null) {
    super(message);
    this.name = 'ApplicationEvidenceError';
    this.code = code;
    this.details = details;
  }
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new ApplicationEvidenceError(`${label} is required`, 'EVIDENCE_FIELD_REQUIRED', { field: label });
  return text;
}

function timestamp(value, label = 'captured-at timestamp') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApplicationEvidenceError(`${label} is invalid`, 'EVIDENCE_TIMESTAMP_INVALID', { field: label });
  return date.toISOString();
}

function normalizeIdentityPart(value) {
  return requiredText(value, 'identity component')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function immutableJson(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationEvidenceError(`${label} must be an evidence object`, 'EVIDENCE_OBJECT_REQUIRED', { field: label });
  }
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function jdBytes(application) {
  if (typeof application.jdSnapshotBody === 'string') return Buffer.from(application.jdSnapshotBody, 'utf8');
  if (application.jdSnapshotPath) {
    const snapshotPath = path.resolve(String(application.jdSnapshotPath));
    try { return readFileSync(snapshotPath); }
    catch (error) {
      throw new ApplicationEvidenceError(`unable to read immutable JD snapshot: ${error.message}`, 'JD_SNAPSHOT_READ_FAILED', { path: snapshotPath });
    }
  }
  throw new ApplicationEvidenceError('JD snapshot path or immutable body is required', 'JD_SNAPSHOT_REQUIRED');
}

export function applicationIdentity(application = {}) {
  const provider = normalizeIdentityPart(application.provider);
  const requisitionId = normalizeIdentityPart(application.requisitionId ?? application.sourceJobId ?? application.jobId);
  const namespace = normalizeIdentityPart(
    application.sourceNamespace
      ?? application.sourceProvenance?.board
      ?? application.sourceProvenance?.tenant
      ?? application.company,
  );
  return `${provider}:${namespace}:${requisitionId}`;
}

export function createApplicationEvidencePacket(application = {}, { now = () => Date.now() } = {}) {
  const bytes = jdBytes(application);
  const capturedAt = timestamp(typeof now === 'function' ? now() : now);
  const packet = {
    version: APPLICATION_EVIDENCE_VERSION,
    identity: applicationIdentity(application),
    company: requiredText(application.company, 'company'),
    role: requiredText(application.role, 'role'),
    canonicalUrl: requiredText(application.canonicalUrl, 'canonical URL'),
    originalAtsUrl: requiredText(application.originalAtsUrl ?? application.originalApplicationUrl, 'original ATS URL'),
    provider: requiredText(application.provider, 'provider'),
    requisitionId: requiredText(application.requisitionId ?? application.sourceJobId ?? application.jobId, 'requisition ID'),
    jdSnapshotPath: application.jdSnapshotPath ? path.resolve(String(application.jdSnapshotPath)) : null,
    jdSnapshotBody: typeof application.jdSnapshotBody === 'string' ? application.jdSnapshotBody : null,
    jdSha256: createHash('sha256').update(bytes).digest('hex'),
    capturedAt,
    freshnessEvidence: immutableJson(application.freshnessEvidence, 'freshness evidence'),
    livenessEvidence: immutableJson(application.livenessEvidence, 'liveness evidence'),
    seniority: {
      decision: requiredText(application.seniorityDecision, 'seniority decision'),
      evidenceQuote: requiredText(application.seniorityEvidenceQuote, 'seniority evidence quote'),
    },
    readinessDecision: requiredText(application.readinessDecision, 'readiness decision'),
    scoringVersions: immutableJson(application.scoringVersions, 'scoring versions'),
    sourceProvenance: immutableJson(application.sourceProvenance, 'source provenance'),
  };
  const verification = verifyApplicationEvidencePacket(packet);
  if (!verification.valid) throw new ApplicationEvidenceError(verification.errors.join('; '), 'APPLICATION_EVIDENCE_INVALID', verification.errors);
  return deepFreeze(packet);
}

export function verifyApplicationEvidencePacket(packet) {
  const errors = [];
  if (packet?.version !== APPLICATION_EVIDENCE_VERSION) errors.push('evidence packet version is invalid');
  for (const field of ['identity', 'company', 'role', 'canonicalUrl', 'originalAtsUrl', 'provider', 'requisitionId', 'jdSha256', 'capturedAt', 'readinessDecision']) {
    if (!String(packet?.[field] ?? '').trim()) errors.push(`${field} is required`);
  }
  if (!packet?.jdSnapshotPath && typeof packet?.jdSnapshotBody !== 'string') errors.push('JD snapshot path or body is required');
  if (!/^[a-f0-9]{64}$/.test(String(packet?.jdSha256 ?? ''))) errors.push('JD SHA-256 is invalid');
  if (Number.isNaN(Date.parse(packet?.capturedAt))) errors.push('capturedAt is invalid');
  if (!packet?.seniority?.decision || !packet?.seniority?.evidenceQuote) errors.push('seniority decision and exact evidence quote are required');
  for (const field of ['freshnessEvidence', 'livenessEvidence', 'scoringVersions', 'sourceProvenance']) {
    if (!packet?.[field] || typeof packet[field] !== 'object' || Array.isArray(packet[field])) errors.push(`${field} is required`);
  }
  return { valid: errors.length === 0, errors };
}

export function evidencePacketValues(packet) {
  const verification = verifyApplicationEvidencePacket(packet);
  if (!verification.valid) throw new ApplicationEvidenceError(verification.errors.join('; '), 'APPLICATION_EVIDENCE_INVALID', verification.errors);
  return {
    jdLink: packet.canonicalUrl,
    originalApplicationUrl: packet.originalAtsUrl,
    provider: packet.provider,
    sourceJobId: packet.requisitionId,
    requirementsEvidence: JSON.stringify(packet),
    originalApplicationEvidence: JSON.stringify({
      applicationIdentity: packet.identity,
      originalAtsUrl: packet.originalAtsUrl,
      sourceProvenance: packet.sourceProvenance,
    }),
    liveness: packet.livenessEvidence.decision ?? null,
    freshness: JSON.stringify(packet.freshnessEvidence),
    readiness: packet.readinessDecision,
  };
}
