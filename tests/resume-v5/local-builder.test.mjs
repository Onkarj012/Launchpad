import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalResumeBuilder, datedResumeDirs, resumeArtifactStem } from '../../resume-v5/local-builder.mjs';

test('artifact stem is filesystem-safe', () => {
  assert.equal(resumeArtifactStem('Acme Labs', 'AI Engineer'), 'Onkar_Jadhav_Acme_Labs_AI_Engineer');
});

test('dated directories follow output/source date partitions', () => {
  const dirs = datedResumeDirs('/tmp/launchpad', new Date('2026-08-18T12:00:00.000Z'));
  assert.equal(dirs.date, '2026-08-18');
  assert.equal(dirs.output, path.join('/tmp/launchpad', 'resumes', 'output', '2026-08-18'));
  assert.equal(dirs.sources, path.join('/tmp/launchpad', 'resumes', 'sources', '2026-08-18'));
});

test('production builder refuses to invent tailored slot content', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-local-builder-'));
  mkdirSync(path.join(root, 'resumes', 'templates'), { recursive: true });
  cpSync(path.resolve('resumes/templates/Onkar_Template.tex'), path.join(root, 'resumes', 'templates', 'Onkar_Template.tex'));
  const build = createLocalResumeBuilder({ root, now: () => new Date('2026-08-18T12:00:00.000Z') });
  await assert.rejects(
    () => build({ id: 'app-1', companyName: 'Acme', role: 'AI Engineer' }),
    (error) => error.code === 'TAILORING_REQUIRED',
  );
});

test('production builder renders from the frozen template and keeps output PDF-only', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-local-builder-'));
  mkdirSync(path.join(root, 'resumes', 'templates'), { recursive: true });
  const inputDir = mkdtempSync(path.join(os.tmpdir(), 'launchpad-local-builder-input-'));
  const templatePath = path.resolve('resumes/templates/Onkar_Template.tex');
  cpSync(templatePath, path.join(root, 'resumes', 'templates', 'Onkar_Template.tex'));
  const sourceInput = path.join(inputDir, 'tailored.tex');
  const sourceText = readFileSync(templatePath, 'utf8').replace(
    /(%== TAILOR-START: SUMMARY ==\n)[\s\S]*?(%== TAILOR-END: SUMMARY ==\n)/,
    '$1\\small{Tailored fixture summary.}\n$2',
  );
  cpSync(templatePath, sourceInput);
  writeFileSync(sourceInput, sourceText);
  const matrixInput = path.join(inputDir, 'tailored.matrix.md');
  const provenanceInput = path.join(inputDir, 'tailored.provenance.md');
  writeFileSync(matrixInput, 'fixture matrix\n');
  writeFileSync(provenanceInput, 'fixture provenance\n');
  const build = createLocalResumeBuilder({
    root,
    now: () => new Date('2026-08-18T12:00:00.000Z'),
    compile: (_sourcePath, { outputPdfPath }) => { writeFileSync(outputPdfPath, '%PDF-1.4 fixture\n'); return outputPdfPath; },
  });

  const artifact = await build({
    id: 'app-1', companyName: 'Acme', role: 'AI Engineer',
    raw: { sourcePath: sourceInput, matrixPath: matrixInput, provenancePath: provenanceInput },
  });
  const rendered = readFileSync(artifact.sourcePath, 'utf8');
  const template = readFileSync(templatePath, 'utf8');
  assert.match(rendered, /Tailored fixture summary/);
  assert.match(rendered, /Currently in the Java Full Stack \(JFS\) engineering training program/);
  assert.equal(rendered.slice(0, rendered.indexOf('%== TAILOR-START: HEADLINE ==')), template.slice(0, template.indexOf('%== TAILOR-START: HEADLINE ==')));
  assert.deepEqual(readdirSync(path.dirname(artifact.pdfPath)), ['Onkar_Jadhav_Acme_AI_Engineer.pdf']);
  assert.deepEqual(readdirSync(path.dirname(artifact.sourcePath)).sort(), [
    'Onkar_Jadhav_Acme_AI_Engineer.matrix.md',
    'Onkar_Jadhav_Acme_AI_Engineer.provenance.md',
    'Onkar_Jadhav_Acme_AI_Engineer.tex',
  ]);
});
