import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMakeResumeQueue } from './queue-reader.mjs';
import { verifyResumeArtifact } from './artifact-state.mjs';
import { SEMANTIC_VERIFIER_VERSION, verifySemanticArtifact } from './semantic-verifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TERMINAL_STATUSES = new Set(['Offer', 'Rejected', 'Withdrawn', 'Not Pursuing', 'Closed/Expired']);
const ARTIFACT_RECEIPT_VERSION = 'LaunchpadResumeArtifactV1';
const DEFAULT_LEASE_MS = 30 * 60 * 1000;

export class ProductionResumeBuilderError extends Error {
  constructor(message, code = 'PRODUCTION_RESUME_BUILD_FAILED', details = null) {
    super(message);
    this.name = 'ProductionResumeBuilderError';
    this.code = code;
    this.details = details;
  }
}

function isoNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new ProductionResumeBuilderError('builder clock is invalid', 'BUILDER_CLOCK_INVALID');
  return date.toISOString();
}

function safePart(value, fallback) {
  return String(value ?? fallback)
    .normalize('NFKC')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '') || fallback;
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function receiptPath(stateRoot, application) {
  return path.join(stateRoot, `${safePart(application.applicationIdentity ?? application.id, 'application')}.json`);
}

function readReceipt(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const receipt = JSON.parse(readFileSync(filePath, 'utf8'));
    return receipt?.version === ARTIFACT_RECEIPT_VERSION ? receipt : null;
  } catch {
    return null;
  }
}

function atomicReceipt(filePath, receipt) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, filePath);
}

function artifactFilesValid(receipt) {
  const artifact = receipt?.artifact;
  if (!artifact) return false;
  for (const kind of ['pdf', 'source', 'matrix', 'provenance']) {
    const file = artifact[kind];
    if (!file?.path || !file?.sha256 || !existsSync(file.path) || !statSync(file.path).isFile()) return false;
    if (sha256(file.path) !== file.sha256) return false;
  }
  return true;
}

function artifactSummary(artifact) {
  return Object.fromEntries(Object.entries(artifact).flatMap(([kind, value]) => [
    [`${kind}Path`, value.path],
    [`${kind}Sha256`, value.sha256],
  ]));
}

function verified(result) {
  return result === true || result?.ok === true || result?.verified === true || result?.status === 'PASS';
}

function command(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ status: 'PASS', stdout, stderr });
      else reject(new ProductionResumeBuilderError(`${commandName} exited ${code}: ${stderr.trim() || stdout.trim()}`, 'LOCAL_COMMAND_FAILED'));
    });
  });
}

export function createLocalCompileAdapter({ executable = 'pdflatex' } = {}) {
  return async ({ paths }) => command(executable, [
    '-interaction=nonstopmode',
    '-halt-on-error',
    `-output-directory=${path.dirname(paths.pdfPath)}`,
    paths.sourcePath,
  ]);
}

export function createLocalVerifierAdapter() {
  return async ({ paths }) => {
    const { verifyFile } = await import('../tests/resume/verify.mjs');
    return verifyFile(paths.sourcePath, paths.pdfPath);
  };
}

function artifactPaths(application, { scratchRoot, sourcesRoot, outputRoot, date }) {
  const stem = [
    'Onkar_Jadhav',
    safePart(application.companyName ?? application.company, 'Company'),
    safePart(application.role, 'Role'),
    safePart(application.provider, 'Provider'),
    safePart(application.requisitionId, application.id),
  ].join('_');
  const scratchDir = mkdtempSync(path.join(scratchRoot, `${safePart(application.applicationIdentity ?? application.id, 'application')}-`));
  const sourceDirectory = path.join(sourcesRoot, date);
  const outputDirectory = path.join(outputRoot, date);
  return {
    stem,
    scratchDir,
    sourcePath: path.join(scratchDir, `${stem}.tex`),
    matrixPath: path.join(scratchDir, `${stem}.matrix.md`),
    provenancePath: path.join(scratchDir, `${stem}.provenance.md`),
    pdfPath: path.join(scratchDir, `${stem}.pdf`),
    finalSourcePath: path.join(sourceDirectory, `${stem}.tex`),
    finalMatrixPath: path.join(sourceDirectory, `${stem}.matrix.md`),
    finalProvenancePath: path.join(sourceDirectory, `${stem}.provenance.md`),
    finalPdfPath: path.join(outputDirectory, `${stem}.pdf`),
  };
}

function promoteFile(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  copyFileSync(source, temporary);
  renameSync(temporary, destination);
}

function readyForBuild(application) {
  if (application.readinessDecision !== 'Ready' && application.applicationReady !== true) return { eligible: false, reason: 'APPLICATION_NOT_READY' };
  if (TERMINAL_STATUSES.has(application.status)) return { eligible: false, reason: 'TERMINAL_STATUS' };
  if (!/^[a-f0-9]{64}$/i.test(String(application.jdSha256 ?? ''))) return { eligible: false, reason: 'JD_HASH_REQUIRED' };
  if (!application.provider || !application.requisitionId) return { eligible: false, reason: 'REQUISITION_IDENTITY_REQUIRED' };
  return { eligible: true };
}

async function updateResumeState(gateway, applicationId, resumeState) {
  if (typeof gateway?.updatePage !== 'function') throw new ProductionResumeBuilderError('builder requires gateway.updatePage', 'GATEWAY_UPDATE_REQUIRED');
  await gateway.updatePage('applications', applicationId, { resumeState });
}

async function buildOne(application, options) {
  const {
    gateway,
    stateRoot,
    scratchRoot,
    sourcesRoot,
    outputRoot,
    author,
    compile,
    verify,
    semanticVerify,
    approvedEvidence,
    now,
    leaseMs,
  } = options;
  const eligibility = readyForBuild(application);
  if (!eligibility.eligible) return { applicationId: application.id, state: application.resumeState, action: 'skipped', reason: eligibility.reason };
  const timestamp = isoNow(now);
  const statePath = receiptPath(stateRoot, application);
  const current = readReceipt(statePath);
  if (application.resumeState !== 'Stale' && current?.state === 'Ready' && current.jdSha256 === application.jdSha256 && current.semanticVerifierVersion === SEMANTIC_VERIFIER_VERSION && artifactFilesValid(current)) {
    return { applicationId: application.id, state: 'Ready', action: 'unchanged', artifact: artifactSummary(current.artifact), receiptPath: statePath };
  }
  if (current?.state === 'Building' && Date.parse(timestamp) - Date.parse(current.lease?.startedAt) <= leaseMs) {
    return { applicationId: application.id, state: 'Building', action: 'leased', reason: 'ACTIVE_BUILD_LEASE' };
  }
  const reason = current?.jdSha256 && current.jdSha256 !== application.jdSha256
    ? 'JD_HASH_CHANGED'
    : current?.state === 'Ready' && current.semanticVerifierVersion !== SEMANTIC_VERIFIER_VERSION
      ? 'SEMANTIC_REBUILD_REQUIRED'
    : current?.state === 'Building' ? 'STALE_LEASE_RECOVERED' : application.resumeState === 'Stale' || current?.state === 'Stale' ? 'ARTIFACT_STALE' : 'ARTIFACT_ABSENT';
  const lease = { id: randomUUID(), startedAt: timestamp, expiresAt: new Date(Date.parse(timestamp) + leaseMs).toISOString() };
  atomicReceipt(statePath, {
    version: ARTIFACT_RECEIPT_VERSION,
    applicationId: application.id,
    applicationIdentity: application.applicationIdentity,
    jdSha256: application.jdSha256,
    state: 'Building',
    lease,
    reason,
    updatedAt: timestamp,
  });

  let paths;
  try {
    await updateResumeState(gateway, application.id, 'Building');
    paths = artifactPaths(application, { scratchRoot, sourcesRoot, outputRoot, date: timestamp.slice(0, 10) });
    await author({ application, paths, scratchDir: paths.scratchDir });
    await compile({ application, paths, scratchDir: paths.scratchDir });
    const artifact = {
      applicationId: application.id,
      company: application.companyName ?? application.company,
      role: application.role,
      jdSha256: application.jdSha256,
      pdfPath: paths.pdfPath,
      sourcePath: paths.sourcePath,
      matrixPath: paths.matrixPath,
      provenancePath: paths.provenancePath,
    };
    const semanticVerification = await semanticVerify({ application, artifact, approvedEvidence });
    if (!semanticVerification?.ok) {
      throw new ProductionResumeBuilderError(
        'semantic provenance requires human exception review',
        'SEMANTIC_REVIEW_REQUIRED',
        semanticVerification?.mismatches ?? null,
      );
    }
    const verification = await verifyResumeArtifact({
      application,
      artifact,
      verifyPdf: async () => {
        const result = await verify({ application, artifact, paths, scratchDir: paths.scratchDir });
        return verified(result) ? result : false;
      },
      now,
    });
    if (!verification.ok) throw new ProductionResumeBuilderError(verification.message, verification.code, verification.details);

    promoteFile(paths.sourcePath, paths.finalSourcePath);
    promoteFile(paths.matrixPath, paths.finalMatrixPath);
    promoteFile(paths.provenancePath, paths.finalProvenancePath);
    promoteFile(paths.pdfPath, paths.finalPdfPath);
    const persisted = {
      pdf: { path: paths.finalPdfPath, sha256: sha256(paths.finalPdfPath) },
      source: { path: paths.finalSourcePath, sha256: sha256(paths.finalSourcePath) },
      matrix: { path: paths.finalMatrixPath, sha256: sha256(paths.finalMatrixPath) },
      provenance: { path: paths.finalProvenancePath, sha256: sha256(paths.finalProvenancePath) },
    };
    atomicReceipt(statePath, {
      version: ARTIFACT_RECEIPT_VERSION,
      applicationId: application.id,
      applicationIdentity: application.applicationIdentity,
      jdSha256: application.jdSha256,
      state: 'Ready',
      lease: null,
      reason,
      artifact: persisted,
      verifier: verification.verification ?? null,
      semanticVerifierVersion: semanticVerification.verifierVersion,
      artifactDigest: semanticVerification.artifactDigest,
      semanticVerification,
      verifiedAt: verification.verifiedAt,
      updatedAt: isoNow(now),
    });
    await updateResumeState(gateway, application.id, 'Ready');
    return { applicationId: application.id, state: 'Ready', action: 'built', reason, artifact: artifactSummary(persisted), receiptPath: statePath };
  } catch (error) {
    atomicReceipt(statePath, {
      version: ARTIFACT_RECEIPT_VERSION,
      applicationId: application.id,
      applicationIdentity: application.applicationIdentity,
      jdSha256: application.jdSha256,
      state: 'Failed',
      lease: null,
      reason,
      error: { code: error.code ?? 'PRODUCTION_RESUME_BUILD_FAILED', message: error.message, details: error.details ?? null },
      updatedAt: isoNow(now),
    });
    try { await updateResumeState(gateway, application.id, 'Failed'); }
    catch (stateError) { error.stateError = { message: stateError.message }; }
    return { applicationId: application.id, state: 'Failed', action: 'failed', reason, error: { code: error.code ?? 'PRODUCTION_RESUME_BUILD_FAILED', message: error.message, details: error.details ?? null }, stateError: error.stateError ?? null };
  } finally {
    if (paths?.scratchDir) rmSync(paths.scratchDir, { recursive: true, force: true });
  }
}

async function boundedMap(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function runProductionResumeBuilder({
  gateway,
  author,
  compile = createLocalCompileAdapter(),
  verify = createLocalVerifierAdapter(),
  semanticVerify = verifySemanticArtifact,
  approvedEvidence = null,
  concurrency = 2,
  leaseMs = DEFAULT_LEASE_MS,
  stateRoot = path.join(ROOT, 'resumes/sources/.launchpad-v5/artifacts'),
  scratchRoot = path.join(ROOT, 'resumes/sources/build'),
  sourcesRoot = path.join(ROOT, 'resumes/sources'),
  outputRoot = path.join(ROOT, 'resumes/output'),
  now = () => Date.now(),
  pageSize = 100,
} = {}) {
  if (typeof author !== 'function') throw new ProductionResumeBuilderError('a local evidence-backed author adapter is required', 'AUTHOR_ADAPTER_REQUIRED');
  if (typeof compile !== 'function' || typeof verify !== 'function' || typeof semanticVerify !== 'function') throw new ProductionResumeBuilderError('compile and verify adapters are required', 'BUILD_ADAPTER_REQUIRED');
  if (![2, 3].includes(concurrency)) throw new ProductionResumeBuilderError('builder concurrency must be 2 or 3', 'CONCURRENCY_INVALID');
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(scratchRoot, { recursive: true });
  const queue = await readMakeResumeQueue({ gateway, pageSize });
  const results = await boundedMap(queue, concurrency, (application) => buildOne(application, {
    gateway, stateRoot, scratchRoot, sourcesRoot, outputRoot, author, compile, verify, semanticVerify, approvedEvidence, now, leaseMs,
  }));
  const failed = results.filter((result) => result.state === 'Failed');
  return {
    status: failed.length ? (failed.length === results.length && results.length ? 'failed' : 'partial') : 'ready',
    selected: queue.length,
    ready: results.filter((result) => result.state === 'Ready').length,
    failed: failed.length,
    results,
  };
}
