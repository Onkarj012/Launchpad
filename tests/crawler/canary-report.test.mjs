import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DELIVERY_CANARY_SIDECAR_SCHEMA } from '../../crawler/delivery-canary.mjs';
import { writeDeliveryCanaryReport } from '../../crawler/canary-report.mjs';

test('canary report writer emits a bound markdown and json pair', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'launchpad-canary-report-'));
  const result = writeDeliveryCanaryReport({
    root,
    directory: 'logs',
    runId: 'run-1',
    codeConfigVersion: 'sha256:abc',
    revision: 'deadbeef',
    inventoryIdentity: 'sha256:def',
    discoveryProfile: { schedule: 'morning', mode: 'normal', locationPreset: 'pune' },
    shortlist: [{ company: 'Acme', title: 'AI Engineer', matchScore: 88, freshnessWindow: 'Hot' }],
    outcome: { status: 'ok' },
    now: new Date('2026-08-18T12:00:00.000Z'),
  });
  const sidecar = JSON.parse(readFileSync(path.join(root, result.json), 'utf8'));
  const markdown = readFileSync(path.join(root, result.markdown), 'utf8');
  assert.equal(sidecar.schemaVersion, DELIVERY_CANARY_SIDECAR_SCHEMA);
  assert.equal(sidecar.runId, 'run-1');
  assert.equal(sidecar.revision, 'deadbeef');
  assert.equal(sidecar.markdownDigest, result.markdownDigest);
  assert.match(markdown, /Acme/);
  assert.match(markdown, /morning\/normal\/pune/);
});
