import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readV4HistorySnapshot } from '../../crawler/v4-history-snapshot.mjs';

function tempPath(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v4-history-')), name);
}

test('missing snapshot file degrades to empty rows, not an error', () => {
  const result = readV4HistorySnapshot(tempPath('missing.json'));
  assert.equal(result.missing, true);
  assert.deepEqual(result.rows, []);
});

test('reads a bare JSON array of historical rows', () => {
  const file = tempPath('snapshot.json');
  fs.writeFileSync(file, JSON.stringify([
    { provider: 'greenhouse', provider_job_id: 'GH-1', canonical_url: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme', title: 'AI Engineer', location: 'Pune', state: 'applied' },
  ]));
  const result = readV4HistorySnapshot(file);
  assert.equal(result.missing, false);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].company, 'Acme');
});

test('reads a { rows, generatedAt } envelope', () => {
  const file = tempPath('envelope.json');
  fs.writeFileSync(file, JSON.stringify({ generatedAt: '2026-07-24T00:00:00Z', rows: [{ company: 'Beta', title: 'Backend Engineer', state: 'rejected' }] }));
  const result = readV4HistorySnapshot(file);
  assert.equal(result.rows.length, 1);
  assert.equal(result.generatedAt, '2026-07-24T00:00:00Z');
});

test('rejects a payload that is neither an array nor a rows envelope', () => {
  const file = tempPath('bad.json');
  fs.writeFileSync(file, JSON.stringify({ notRows: true }));
  assert.throws(() => readV4HistorySnapshot(file), /must be an array/);
});

test('rejects malformed JSON rather than silently ignoring it', () => {
  const file = tempPath('malformed.json');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => readV4HistorySnapshot(file), /not valid JSON/);
});
