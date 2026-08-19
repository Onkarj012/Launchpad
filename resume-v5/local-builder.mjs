import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFile } from '../tests/resume/verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_NAME = 'Onkar_Template.tex';
const SLOT_MARKER = /%==\s*TAILOR-(START|END):\s*([A-Z0-9-]+)\s*==\s*\r?\n/g;

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

function parseSlots(source, label) {
  const segments = [];
  const errors = [];
  let cursor = 0;
  let openName = null;
  let openStart = 0;
  SLOT_MARKER.lastIndex = 0;
  let match;
  while ((match = SLOT_MARKER.exec(source))) {
    const [marker, kind, name] = match;
    if (kind === 'START') {
      if (openName) errors.push(`${label} has nested tailor slot ${name} inside ${openName}`);
      else {
        segments.push({ type: 'frozen', text: source.slice(cursor, match.index) });
        segments.push({ type: 'marker', text: marker });
        openName = name;
        openStart = SLOT_MARKER.lastIndex;
      }
    } else if (!openName) {
      errors.push(`${label} has an unmatched tailor slot end ${name}`);
    } else {
      if (openName !== name) errors.push(`${label} closes ${name} while ${openName} is open`);
      segments.push({ type: 'slot', name: openName, text: source.slice(openStart, match.index) });
      segments.push({ type: 'marker', text: marker });
      cursor = SLOT_MARKER.lastIndex;
      openName = null;
    }
  }
  if (openName) errors.push(`${label} leaves tailor slot ${openName} open`);
  segments.push({ type: 'frozen', text: source.slice(cursor) });
  if (errors.length) throw new LocalResumeBuildError(errors.join('; '), 'TAILOR_SLOTS_INVALID');
  return segments;
}

function slotValues(source, label) {
  return Object.fromEntries(parseSlots(source, label).filter((segment) => segment.type === 'slot').map((segment) => [segment.name, segment.text]));
}

function renderTemplate(template, values) {
  const segments = parseSlots(template, 'canonical template');
  const names = segments.filter((segment) => segment.type === 'slot').map((segment) => segment.name);
  const supplied = Object.keys(values ?? {});
  const unknown = supplied.filter((name) => !names.includes(name));
  const missing = names.filter((name) => !Object.prototype.hasOwnProperty.call(values ?? {}, name));
  if (unknown.length) throw new LocalResumeBuildError(`tailoring contains unknown slot(s): ${unknown.join(', ')}`, 'TAILOR_SLOT_UNKNOWN');
  if (missing.length) throw new LocalResumeBuildError(`tailoring is missing slot(s): ${missing.join(', ')}`, 'TAILOR_SLOT_MISSING');
  return segments.map((segment) => segment.type === 'slot' ? String(values[segment.name]) : segment.text).join('');
}

function inputValue(application, extras, key, rawKey = key) {
  return extras[key] ?? application?.[key] ?? application?.raw?.[rawKey] ?? application?.raw?.[key] ?? null;
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
export function createLocalResumeBuilder({ root = ROOT, now = () => new Date(), compile = compileLatexSource } = {}) {
  return async function build(application, extras = {}) {
    const company = application.companyName ?? application.company ?? 'Unknown';
    const role = application.role ?? 'Role';
    const stem = extras.stem ?? resumeArtifactStem(company, role);
    const dirs = datedResumeDirs(root, typeof now === 'function' ? now() : now);
    const templatePath = requiredFile(path.join(root, 'resumes', 'templates', TEMPLATE_NAME), 'canonical resume template', 'TEMPLATE_REQUIRED');
    const sourceInput = inputValue(application, extras, 'sourcePath', 'resumeSourcePath') ?? path.join(dirs.sources, `${stem}.tex`);
    const sourcePath = existsSync(sourceInput) ? requiredFile(sourceInput, 'tailored source input', 'TAILORED_SOURCE_REQUIRED') : null;
    const sourceText = sourcePath ? readFileSync(sourcePath, 'utf8') : null;
    const slots = sourceText ? slotValues(sourceText, 'tailored source input') : null;
    if (!slots || typeof slots !== 'object' || Array.isArray(slots)) {
      throw new LocalResumeBuildError('tailored slot content is required from the existing resume workflow', 'TAILORING_REQUIRED');
    }
    const matrixInput = inputValue(application, extras, 'matrixPath', 'resumeMatrixPath') ?? (sourcePath ? sourcePath.replace(/\.tex$/i, '.matrix.md') : null);
    const provenanceInput = inputValue(application, extras, 'provenancePath', 'resumeProvenancePath') ?? (sourcePath ? sourcePath.replace(/\.tex$/i, '.provenance.md') : null);
    const matrixPath = requiredFile(matrixInput, 'matrix sidecar', 'MATRIX_REQUIRED');
    const provenancePath = requiredFile(provenanceInput, 'provenance sidecar', 'PROVENANCE_REQUIRED');
    mkdirSync(dirs.sources, { recursive: true });
    mkdirSync(dirs.output, { recursive: true });
    const placedSource = path.join(dirs.sources, `${stem}.tex`);
    const placedMatrix = path.join(dirs.sources, `${stem}.matrix.md`);
    const placedProvenance = path.join(dirs.sources, `${stem}.provenance.md`);
    const pdfPath = path.join(dirs.output, `${stem}.pdf`);
    const template = readFileSync(templatePath, 'utf8');
    writeFileSync(placedSource, renderTemplate(template, slots));
    if (path.resolve(matrixPath) !== placedMatrix) cpSync(matrixPath, placedMatrix);
    if (path.resolve(provenancePath) !== placedProvenance) cpSync(provenancePath, placedProvenance);
    compile(placedSource, { outputPdfPath: pdfPath });
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

export function createLocalPdfVerifier({ verify = verifyCompiledResume } = {}) {
  return async function verifyPdf(artifact) {
    return verify({ sourcePath: artifact.sourcePath, pdfPath: artifact.pdfPath });
  };
}
