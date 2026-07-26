import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CATALOGUE = path.join(ROOT, 'resumes/evidence/approved-evidence.md');
const DEFAULT_MASTER = path.join(ROOT, 'resumes/master/Master_Resume_ATS.tex');
const PROVENANCE_HEADER = '| Claim ID | Tailored claim | Resume section | Approved evidence locator | Equivalence note |';
const MATRIX_HEADER = '| Exact JD phrase | Required / preferred | Category | Approved evidence locator | Target section | Resume wording | Covered / missing |';
const STOP_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'using', 'with']);
const PROTECTED_QUALIFIERS = Object.freeze([
  ['CI', /\bci(?:-style)?\b/i],
  ['continuous integration', /\bcontinuous integration\b/i],
  ['production', /\bproduction\b/i],
  ['release gate', /\brelease[- ]?gat(?:e|es|ed|ing)\b/i],
  ['owned', /\bowned?\b/i],
  ['led', /\bled\b/i],
  ['shipped', /\bshipp?ed\b/i],
  ['deployed', /\bdeploy(?:ed|ment|ments)\b/i],
  ['scaled', /\bscal(?:e|es|ed|ing)\b/i],
  ['real-time', /\breal[- ]?time\b/i],
]);

export const SEMANTIC_VERIFIER_VERSION = 'LaunchpadSemanticProvenanceV1';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tableRows(text, header) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === header);
  if (index < 0 || !/^\|\s*---/.test(lines[index + 1] ?? '')) return [];
  const rows = [];
  for (let cursor = index + 2; cursor < lines.length && lines[cursor].startsWith('|'); cursor++) {
    rows.push(lines[cursor].split('|').slice(1, -1).map((cell) => cell.trim().replace(/\\\|/g, '|')));
  }
  return rows;
}

function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, ' ')
    .replace(/[{}\\$%&#_^~]/g, ' ')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}+#.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stem(token) {
  if (token.length > 5 && token.endsWith('ments')) return token.slice(0, -5);
  if (token.length > 4 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function tokens(value) {
  return new Set(normalize(value).split(' ').filter((token) => token && !STOP_WORDS.has(token)).map(stem));
}

function mismatch(code, message, details = {}) {
  return { code, message, humanReviewRequired: true, ...details };
}

function semanticMismatches(claim, evidence, details) {
  const mismatches = [];
  for (const [qualifier, pattern] of PROTECTED_QUALIFIERS) {
    pattern.lastIndex = 0;
    const claimed = pattern.test(claim);
    pattern.lastIndex = 0;
    if (claimed && !pattern.test(evidence)) {
      mismatches.push(mismatch('UNSUPPORTED_QUALIFIER', `claim adds unsupported qualifier ${qualifier}`, { ...details, qualifier }));
    }
  }
  const claimNumbers = [...normalize(claim).matchAll(/\b\d+(?:\.\d+)?%?\b/g)].map((match) => match[0]);
  const evidenceNumbers = new Set([...normalize(evidence).matchAll(/\b\d+(?:\.\d+)?%?\b/g)].map((match) => match[0]));
  for (const number of claimNumbers) {
    if (!evidenceNumbers.has(number)) mismatches.push(mismatch('UNSUPPORTED_NUMBER', `claim adds unsupported number ${number}`, { ...details, number }));
  }
  const claimTokens = tokens(claim);
  const evidenceTokens = tokens(evidence);
  const supported = [...claimTokens].filter((token) => evidenceTokens.has(token)).length;
  const coverage = claimTokens.size ? supported / claimTokens.size : 0;
  if (coverage < 0.65) mismatches.push(mismatch('SEMANTIC_EQUIVALENCE_FAILED', 'claim meaning is not sufficiently supported by approved evidence', { ...details, coverage }));
  return mismatches;
}

function approvedEvidenceMap(approvedEvidence, cataloguePath, masterPath) {
  if (approvedEvidence instanceof Map) return approvedEvidence;
  if (approvedEvidence && typeof approvedEvidence === 'object' && !Array.isArray(approvedEvidence)) return new Map(Object.entries(approvedEvidence));
  if (!existsSync(cataloguePath) || !existsSync(masterPath)) return null;
  const catalogue = readFileSync(cataloguePath, 'utf8');
  const masterLines = readFileSync(masterPath, 'utf8').split(/\r?\n/);
  const mapping = new Map();
  for (const line of catalogue.split(/\r?\n/)) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|[^|]*\|\s*`([^`]+)`\s*\|/);
    if (!match) continue;
    const evidenceLine = masterLines.find((candidate) => candidate.includes(match[2]));
    if (evidenceLine) mapping.set(match[1], evidenceLine);
  }
  return mapping;
}

function jdSnapshot(application) {
  if (typeof application?.jdSnapshotBody === 'string') return Buffer.from(application.jdSnapshotBody, 'utf8');
  if (application?.jdSnapshotPath && existsSync(application.jdSnapshotPath)) return readFileSync(application.jdSnapshotPath);
  return null;
}

function slot(source, name) {
  const pattern = new RegExp(`%==\\s*TAILOR-START:\\s*${name}\\s*==([\\s\\S]*?)%==\\s*TAILOR-END:\\s*${name}\\s*==`);
  return pattern.exec(source)?.[1] ?? '';
}

function plainLatex(value) {
  return String(value)
    .replace(/(?<!\\)%.*$/gm, ' ')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, ' ')
    .replace(/[{}\\$&#_^~]/g, ' ')
    .replace(/-{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceClaims(source) {
  const claims = [];
  const itemPattern = /\\item\s*\{((?:[^{}]|\{[^{}]*\})*)\}/gs;
  for (const match of source.matchAll(itemPattern)) claims.push(normalize(plainLatex(match[1])));
  const resumeItemPattern = /\\+resumeItem\{((?:[^{}]|\{[^{}]*\})*)\}(?:\{((?:[^{}]|\{[^{}]*\})*)\})?/gs;
  for (const match of source.matchAll(resumeItemPattern)) claims.push(normalize(plainLatex([match[1], match[2]].filter(Boolean).join(' '))));
  const summary = plainLatex(slot(source, 'SUMMARY'));
  for (const sentence of summary.split(/(?<=[.!?])\s+/)) if (normalize(sentence)) claims.push(normalize(sentence));
  const skills = slot(source, 'SKILLS');
  for (const line of skills.split(/\r?\n/)) {
    if (/\\textbf\{/.test(line) && normalize(plainLatex(line))) claims.push(normalize(plainLatex(line)));
  }
  return [...new Set(claims.filter(Boolean))];
}

export function verifySemanticArtifact({
  application,
  artifact,
  approvedEvidence = null,
  approvedEvidencePath = DEFAULT_CATALOGUE,
  masterResumePath = DEFAULT_MASTER,
} = {}) {
  const mismatches = [];
  for (const field of ['sourcePath', 'matrixPath', 'provenancePath', 'pdfPath']) {
    if (!artifact?.[field] || !existsSync(artifact[field])) mismatches.push(mismatch('ARTIFACT_FILE_MISSING', `${field} is missing`, { field }));
  }
  const snapshot = jdSnapshot(application);
  if (!snapshot) mismatches.push(mismatch('JD_SNAPSHOT_MISSING', 'immutable JD snapshot is missing'));
  const jdSha256 = snapshot ? sha256(snapshot) : null;
  if (jdSha256 && jdSha256 !== application?.jdSha256) mismatches.push(mismatch('JD_HASH_MISMATCH', 'immutable JD snapshot does not match the application packet hash', { expected: application?.jdSha256, received: jdSha256 }));

  const evidence = approvedEvidenceMap(approvedEvidence, approvedEvidencePath, masterResumePath);
  if (!evidence) mismatches.push(mismatch('APPROVED_EVIDENCE_MISSING', 'approved evidence catalogue is unavailable'));

  let provenanceRows = [];
  let matrixRows = [];
  let source = '';
  if (artifact?.provenancePath && existsSync(artifact.provenancePath)) provenanceRows = tableRows(readFileSync(artifact.provenancePath, 'utf8'), PROVENANCE_HEADER);
  if (artifact?.matrixPath && existsSync(artifact.matrixPath)) matrixRows = tableRows(readFileSync(artifact.matrixPath, 'utf8'), MATRIX_HEADER);
  if (artifact?.sourcePath && existsSync(artifact.sourcePath)) source = readFileSync(artifact.sourcePath, 'utf8');
  if (!provenanceRows.length) mismatches.push(mismatch('PROVENANCE_EMPTY', 'claim provenance has no factual claim rows'));
  if (!matrixRows.length) mismatches.push(mismatch('MATRIX_EMPTY', 'requirement matrix has no rows'));

  for (const [claimId, claim, section, locator] of provenanceRows) {
    const approved = evidence?.get(locator);
    if (!approved) {
      mismatches.push(mismatch('EVIDENCE_LOCATOR_UNRESOLVED', `claim ${claimId} has no approved evidence`, { claimId, locator, section }));
      continue;
    }
    mismatches.push(...semanticMismatches(claim, approved, { claimId, locator, section }));
    if (source && !normalize(source).includes(normalize(claim))) mismatches.push(mismatch('CLAIM_NOT_IN_SOURCE', `provenance claim ${claimId} is not present in the resume source`, { claimId }));
  }

  const provenanceClaims = provenanceRows.map((row) => normalize(row[1]));
  for (const claim of sourceClaims(source)) {
    if (!provenanceClaims.includes(claim)) mismatches.push(mismatch('SOURCE_CLAIM_UNMAPPED', 'resume bullet has no claim provenance row', { claim }));
  }

  const snapshotText = normalize(snapshot?.toString('utf8'));
  for (const [phrase, , , , , , state] of matrixRows) {
    if (!phrase || /^Missing\b/i.test(state)) continue;
    if (!snapshotText.includes(normalize(phrase))) mismatches.push(mismatch('MATRIX_JD_MISMATCH', 'matrix phrase is absent from the immutable JD snapshot', { phrase }));
  }

  const artifactDigest = artifact?.pdfPath && existsSync(artifact.pdfPath) ? sha256(readFileSync(artifact.pdfPath)) : null;
  return {
    status: mismatches.length ? 'REVIEW_REQUIRED' : 'PASS',
    ok: mismatches.length === 0,
    verifierVersion: SEMANTIC_VERIFIER_VERSION,
    artifactDigest,
    jdSha256,
    claimsChecked: provenanceRows.length,
    matrixRowsChecked: matrixRows.length,
    humanReviewRequired: mismatches.length > 0,
    mismatches,
  };
}
