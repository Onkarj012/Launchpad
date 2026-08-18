import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFile } from '../tests/resume/verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class LocalResumeBuildError extends Error {
  constructor(message, code = 'RESUME_BUILD_FAILED') {
    super(message);
    this.name = 'LocalResumeBuildError';
    this.code = code;
  }
}

export function resumeArtifactStem(company, role) {
  const safe = (value) => String(value ?? 'Unknown')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '') || 'Unknown';
  return `Onkar_Jadhav_${safe(company)}_${safe(role)}`;
}

export function datedResumeDirs(root = ROOT, now = new Date()) {
  const date = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  return {
    date,
    sources: path.join(root, 'resumes', 'sources', date),
    output: path.join(root, 'resumes', 'output', date),
    build: path.join(root, 'resumes', 'sources', date, 'build'),
  };
}

function requiredFile(filePath, label, code) {
  if (!filePath || !existsSync(filePath)) {
    throw new LocalResumeBuildError(`${label} is required: ${filePath ?? '(missing)'}`, code);
  }
  return path.resolve(filePath);
}

export function compileLatexSource(sourcePath, { outputPdfPath, spawn = spawnSync } = {}) {
  const source = path.resolve(sourcePath);
  const stem = path.basename(source, path.extname(source));
  const buildDir = mkdtempSync(path.join(os.tmpdir(), 'launchpad-resume-build-'));
  try {
    const compile = spawn('pdflatex', [
      '-interaction=nonstopmode',
      '-halt-on-error',
      `-output-directory=${buildDir}`,
      path.basename(source),
    ], { cwd: path.dirname(source), encoding: 'utf8' });
    const compiledPdf = path.join(buildDir, `${stem}.pdf`);
    if (compile.error) throw new LocalResumeBuildError(`pdflatex: ${compile.error.message}`, 'LATEX_UNAVAILABLE');
    if (compile.status !== 0 || !existsSync(compiledPdf)) {
      throw new LocalResumeBuildError(`pdflatex failed with exit ${compile.status ?? 'unknown'}`, 'LATEX_COMPILE_FAILED');
    }
    mkdirSync(path.dirname(outputPdfPath), { recursive: true });
    cpSync(compiledPdf, outputPdfPath);
    return outputPdfPath;
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

export function verifyCompiledResume({ sourcePath, pdfPath }) {
  const result = verifyFile(sourcePath, pdfPath);
  return {
    ok: result.status === 'PASS',
    status: result.status,
    line: result.line,
  };
}

/**
 * Production adapter for processMakeResumeQueue. It compiles and places a
 * tailored source. It never invents slot content, never checks Make Resume,
 * and never submits an application.
 */
export function createLocalResumeBuilder({ root = ROOT, now = () => new Date() } = {}) {
  return async function build(application, extras = {}) {
    const company = application.companyName ?? application.company ?? 'Unknown';
    const role = application.role ?? 'Role';
    const stem = extras.stem ?? resumeArtifactStem(company, role);
    const dirs = datedResumeDirs(root, typeof now === 'function' ? now() : now);
    const guessedSource = extras.sourcePath || path.join(dirs.sources, `${stem}.tex`);
    const sourcePath = requiredFile(guessedSource, 'tailored source', 'TAILORED_SOURCE_REQUIRED');
    const matrixPath = requiredFile(extras.matrixPath ?? sourcePath.replace(/\.tex$/i, '.matrix.md'), 'matrix sidecar', 'MATRIX_REQUIRED');
    const provenancePath = requiredFile(extras.provenancePath ?? sourcePath.replace(/\.tex$/i, '.provenance.md'), 'provenance sidecar', 'PROVENANCE_REQUIRED');
    mkdirSync(dirs.sources, { recursive: true });
    mkdirSync(dirs.output, { recursive: true });
    const placedSource = path.join(dirs.sources, `${stem}.tex`);
    const placedMatrix = path.join(dirs.sources, `${stem}.matrix.md`);
    const placedProvenance = path.join(dirs.sources, `${stem}.provenance.md`);
    const pdfPath = path.join(dirs.output, `${stem}.pdf`);
    if (path.resolve(sourcePath) !== placedSource) cpSync(sourcePath, placedSource);
    if (path.resolve(matrixPath) !== placedMatrix) cpSync(matrixPath, placedMatrix);
    if (path.resolve(provenancePath) !== placedProvenance) cpSync(provenancePath, placedProvenance);
    compileLatexSource(placedSource, { outputPdfPath: pdfPath });
    return {
      applicationId: application.id,
      company,
      role,
      pdfPath,
      sourcePath: placedSource,
      matrixPath: placedMatrix,
      provenancePath: placedProvenance,
    };
  };
}

export function createLocalPdfVerifier() {
  return async function verifyPdf(artifact) {
    return verifyCompiledResume({ sourcePath: artifact.sourcePath, pdfPath: artifact.pdfPath });
  };
}
