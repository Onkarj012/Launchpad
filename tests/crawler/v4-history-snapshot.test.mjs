import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readV4HistorySnapshot } from '../../crawler/v4-history-snapshot.mjs';

function tempPath(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v4-history-')), name);
}

test('missing snapshot file degrades to empty rows with status missing', () => {
  const result = readV4HistorySnapshot(tempPath('missing.json'));
  assert.equal(result.missing, true);
  assert.equal(result.status, 'missing');
  assert.equal(result.rowCount, 0);
  assert.deepEqual(result.rows, []);
  assert.equal(result.generatedAt, null);
});

test('reads a bare JSON array of historical rows as loaded', () => {
  const file = tempPath('snapshot.json');
  fs.writeFileSync(file, JSON.stringify([
    { provider: 'greenhouse', provider_job_id: 'GH-1', canonical_url: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme', title: 'AI Engineer', location: 'Pune', state: 'applied' },
  ]));
  const result = readV4HistorySnapshot(file);
  assert.equal(result.missing, false);
  assert.equal(result.status, 'loaded');
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].company, 'Acme');
});

test('reads a { rows, generatedAt } envelope as loaded when fresh', () => {
  const file = tempPath('envelope.json');
  fs.writeFileSync(file, JSON.stringify({
    generatedAt: '2026-07-24T00:00:00Z',
    rows: [{ company: 'Beta', title: 'Backend Engineer', state: 'rejected' }],
  }));
  const result = readV4HistorySnapshot(file, { now: '2026-07-24T12:00:00Z' });
  assert.equal(result.status, 'loaded');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rowCount, 1);
  assert.equal(result.generatedAt, '2026-07-24T00:00:00Z');
});

test('stale snapshot reports status stale while still contributing rows', () => {
  const file = tempPath('stale.json');
  fs.writeFileSync(file, JSON.stringify({
    generatedAt: '2026-01-01T00:00:00Z',
    rows: [{ company: 'Old Co', title: 'Engineer', state: 'applied' }],
  }));
  const result = readV4HistorySnapshot(file, { now: '2026-07-24T00:00:00Z', maxAgeDays: 30 });
  assert.equal(result.status, 'stale');
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.generatedAt, '2026-01-01T00:00:00Z');
});

test('malformed payload reports status malformed without throwing', () => {
  const file = tempPath('bad.json');
  fs.writeFileSync(file, JSON.stringify({ notRows: true }));
  const result = readV4HistorySnapshot(file);
  assert.equal(result.status, 'malformed');
  assert.equal(result.rowCount, 0);
  assert.deepEqual(result.rows, []);
  assert.match(result.error, /must be an array/);
});

test('malformed JSON reports status malformed without throwing', () => {
  const file = tempPath('malformed.json');
  fs.writeFileSync(file, '{not json');
  const result = readV4HistorySnapshot(file);
  assert.equal(result.status, 'malformed');
  assert.equal(result.rowCount, 0);
  assert.deepEqual(result.rows, []);
  assert.match(result.error, /not valid JSON/);
});
