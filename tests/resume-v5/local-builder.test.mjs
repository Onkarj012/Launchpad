import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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

test('production builder refuses to invent a tailored source', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-local-builder-'));
  const build = createLocalResumeBuilder({ root, now: () => new Date('2026-08-18T12:00:00.000Z') });
  await assert.rejects(
    () => build({ id: 'app-1', companyName: 'Acme', role: 'AI Engineer' }),
    (error) => error.code === 'TAILORED_SOURCE_REQUIRED',
  );
});
