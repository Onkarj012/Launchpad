import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export const ARTIFACT_STATES = Object.freeze(['Not Started', 'Building', 'Ready', 'Failed', 'Stale']);

export class ArtifactStateError extends Error {
  constructor(message, code = 'ARTIFACT_INVALID', details = null) {
    super(message);
    this.name = 'ArtifactStateError';
    this.code = code;
    this.details = details;
  }
}

function requiredPath(value, label) {
  if (!value || typeof value !== 'string') throw new ArtifactStateError(`${label} path is required`, 'ARTIFACT_PATH_REQUIRED');
  const resolved = path.resolve(value);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new ArtifactStateError(`${label} file is missing`, 'ARTIFACT_FILE_MISSING', { path: resolved });
  return resolved;
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, '');
}

function verifiedResult(result) {
  if (result === true) return true;
  if (!result || typeof result !== 'object') return false;
  return result.ok === true || result.verified === true || result.status === 'PASS';
}

function failure(state, code, message, details = null) {
  return { state, ok: false, code, message, details };
}

/**
 * Verify a completed role artifact without compiling it. Compilation and the
 * existing resume verifier are injected as verifyPdf, which keeps contract
 * tests filesystem-only while making Ready impossible without that evidence.
 */
export async function verifyResumeArtifact({ application, artifact, verifyPdf, now = () => Date.now() } = {}) {
  if (!application?.id) return failure('Failed', 'APPLICATION_ID_REQUIRED', 'application id is required');
  if (!artifact || typeof artifact !== 'object') return failure('Failed', 'ARTIFACT_REQUIRED', 'builder returned no artifact');
  if (typeof verifyPdf !== 'function') return failure('Failed', 'VERIFIER_REQUIRED', 'a compilation/verifier function is required');

  let pdfPath;
  let sourcePath;
  let matrixPath;
  let provenancePath;
  try {
    pdfPath = requiredPath(artifact.pdfPath, 'PDF');
    sourcePath = requiredPath(artifact.sourcePath, 'source');
    matrixPath = requiredPath(artifact.matrixPath, 'matrix');
    provenancePath = requiredPath(artifact.provenancePath, 'provenance');
  } catch (error) {
    return failure('Failed', error.code ?? 'ARTIFACT_FILE_INVALID', error.message, error.details);
  }

  if (path.extname(pdfPath).toLocaleLowerCase() !== '.pdf') return failure('Failed', 'PDF_EXTENSION_INVALID', 'artifact PDF must have a .pdf extension');
  const sourceStem = path.basename(sourcePath, path.extname(sourcePath));
  if (path.basename(pdfPath, path.extname(pdfPath)) !== sourceStem) {
    return failure('Stale', 'ARTIFACT_STEM_MISMATCH', 'PDF and source stems do not match', { pdfPath, sourcePath });
  }
  if (path.basename(matrixPath, path.extname(matrixPath)) !== `${sourceStem}.matrix`) {
    return failure('Stale', 'MATRIX_STEM_MISMATCH', 'matrix sidecar does not match the source stem', { matrixPath, sourceStem });
  }
  if (path.basename(provenancePath, path.extname(provenancePath)) !== `${sourceStem}.provenance`) {
    return failure('Stale', 'PROVENANCE_STEM_MISMATCH', 'provenance sidecar does not match the source stem', { provenancePath, sourceStem });
  }

  if (artifact.applicationId !== application.id) return failure('Stale', 'APPLICATION_MISMATCH', 'artifact belongs to a different application', { expected: application.id, received: artifact.applicationId ?? null });
  if (application.companyName && artifact.company == null) return failure('Stale', 'COMPANY_MISSING', 'artifact company identity is required for association');
  if (application.companyName && normalized(artifact.company) !== normalized(application.companyName)) return failure('Stale', 'COMPANY_MISMATCH', 'artifact company does not match the application');
  if (application.role && artifact.role == null) return failure('Stale', 'ROLE_MISSING', 'artifact role identity is required for association');
  if (application.role && normalized(artifact.role) !== normalized(application.role)) return failure('Stale', 'ROLE_MISMATCH', 'artifact role does not match the application');

  const pdfStats = statSync(pdfPath);
  const newestInput = Math.max(statSync(sourcePath).mtimeMs, statSync(matrixPath).mtimeMs, statSync(provenancePath).mtimeMs);
  if (pdfStats.mtimeMs < newestInput) return failure('Stale', 'PDF_OLDER_THAN_EVIDENCE', 'PDF predates its supporting evidence', { pdfPath, newestInput });
  if (artifact.stale === true) return failure('Stale', 'ARTIFACT_MARKED_STALE', 'builder marked the artifact stale');

  let verification;
  try {
    verification = await verifyPdf({ application, artifact: { ...artifact, pdfPath, sourcePath, matrixPath, provenancePath } });
  } catch (error) {
    return failure('Failed', 'PDF_VERIFICATION_ERROR', error.message);
  }
  if (!verifiedResult(verification)) return failure('Failed', 'PDF_VERIFICATION_FAILED', 'PDF did not pass the injected compilation/verifier gate', { verification });

  const timestamp = typeof now === 'function' ? now() : now;
  return {
    state: 'Ready',
    ok: true,
    applicationId: application.id,
    pdfPath,
    sourcePath,
    matrixPath,
    provenancePath,
    verifiedAt: new Date(timestamp).toISOString(),
    verification,
  };
}

export function artifactStateFor({ artifact = null, verification = null } = {}) {
  if (!artifact) return 'Not Started';
  if (verification?.state && ARTIFACT_STATES.includes(verification.state)) return verification.state;
  return 'Building';
}
