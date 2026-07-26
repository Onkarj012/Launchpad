import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SEMANTIC_VERIFIER_VERSION, verifySemanticArtifact } from '../../resume-v5/semantic-verifier.mjs';

function fixture({ claim, evidence, matrixPhrase = 'Python', jd = 'Requires Python for backend services.' }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'semantic-verifier-'));
  const stem = 'Onkar_Jadhav_Acme_AI_Engineer_ashby_REQ_1';
  const paths = {
    sourcePath: path.join(directory, `${stem}.tex`),
    provenancePath: path.join(directory, `${stem}.provenance.md`),
    matrixPath: path.join(directory, `${stem}.matrix.md`),
    pdfPath: path.join(directory, `${stem}.pdf`),
  };
  writeFileSync(paths.sourcePath, `\\\\resumeItem{${claim}}\n`);
  writeFileSync(paths.provenancePath, [
    '| Claim ID | Tailored claim | Resume section | Approved evidence locator | Equivalence note |',
    '| --- | --- | --- | --- | --- |',
    `| C1 | ${claim} | Experience | MASTER-1 | Equivalent wording |`,
    '',
  ].join('\n'));
  writeFileSync(paths.matrixPath, [
    '| Exact JD phrase | Required / preferred | Category | Approved evidence locator | Target section | Resume wording | Covered / missing |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${matrixPhrase} | Required | Skill | MASTER-1 | Experience | ${claim} | Covered |`,
    '',
  ].join('\n'));
  writeFileSync(paths.pdfPath, 'verified-pdf-bytes');
  return {
    application: {
      id: 'app-1',
      jdSnapshotBody: jd,
      jdSha256: createHash('sha256').update(jd).digest('hex'),
    },
    artifact: paths,
    approvedEvidence: { 'MASTER-1': evidence },
  };
}

test('unsupported qualifier is rejected despite a valid evidence locator', () => {
  const input = fixture({
    claim: 'Built CI-style release gates for production deployments.',
    evidence: 'Built a deployment workflow for tagged releases.',
  });
  const result = verifySemanticArtifact(input);

  assert.equal(result.status, 'REVIEW_REQUIRED');
  assert.equal(result.mismatches.some((item) => item.code === 'UNSUPPORTED_QUALIFIER'), true);
  assert.equal(result.humanReviewRequired, true);
});

test('requirement matrix is checked against the immutable JD snapshot', () => {
  const input = fixture({
    claim: 'Built Python backend services.',
    evidence: 'Built Python backend services.',
    matrixPhrase: 'Kubernetes',
  });
  const result = verifySemanticArtifact(input);

  assert.equal(result.status, 'REVIEW_REQUIRED');
  assert.equal(result.mismatches.some((item) => item.code === 'MATRIX_JD_MISMATCH'), true);
  assert.equal(result.jdSha256, input.application.jdSha256);
});

test('successful semantic verification records version and artifact digest', () => {
  const input = fixture({
    claim: 'Built Python backend services.',
    evidence: 'Built Python backend services.',
  });
  const result = verifySemanticArtifact(input);

  assert.equal(result.status, 'PASS');
  assert.equal(result.verifierVersion, SEMANTIC_VERIFIER_VERSION);
  assert.equal(result.artifactDigest, '23dd01aa4d9b9dd12ca48e8d743ad1b04dea199000ce9a6f22d3ca14918c4f4d');
  assert.equal(result.humanReviewRequired, false);
});
