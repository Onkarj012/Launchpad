import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, prepareRecord } from '../../job-pull/public-search-prepare.mjs';
import { importPublicSearchCandidates } from '../../job-pull/adapters/public-search.mjs';

test('normalizes messy aliases and preserves public source metadata', () => {
  const result = prepare([{ link: 'https://example.test/a', org: 'Acme', position: 'Engineer', snippet: 'JD' }]);
  assert.equal(result.kept[0].url, 'https://example.test/a');
  assert.equal(result.kept[0].sourceKind, 'aggregator');
});

test('converts date-only posting dates to UTC midnight', () => {
  assert.equal(prepareRecord({ url: 'https://example.test/a', company: 'A', title: 'T', date: '2026-07-15' }).postedAt, '2026-07-15T00:00:00.000Z');
});

test('skips records missing required fields', () => {
  const result = prepare([{ url: 'https://example.test/a', title: 'T' }, { company: 'A', title: 'T' }]);
  assert.equal(result.kept.length, 0);
  assert.deepEqual(result.skipped.map(({ index }) => index), [0, 1]);
});

test('parses hours-ago relative postings anchored to now', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');
  const result = prepareRecord({ url: 'https://example.test/a', company: 'A', title: 'T', posted: '21 hrs ago' }, now);
  assert.equal(result.postedAt, new Date(now.getTime() - 21 * 3600000).toISOString());
});

test('parses days-ago relative postings anchored to now', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');
  const result = prepareRecord({ url: 'https://example.test/a', company: 'A', title: 'T', posted: '2 days ago' }, now);
  assert.equal(result.postedAt, new Date(now.getTime() - 2 * 86400000).toISOString());
});

test('parses "Today" as now', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');
  const result = prepareRecord({ url: 'https://example.test/a', company: 'A', title: 'T', posted: 'Today' }, now);
  assert.equal(result.postedAt, now.toISOString());
});

test('parses "Yesterday" as now minus 24h', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');
  const result = prepareRecord({ url: 'https://example.test/a', company: 'A', title: 'T', posted: 'Yesterday' }, now);
  assert.equal(result.postedAt, new Date(now.getTime() - 86400000).toISOString());
});

test('parses "Posted 6 hours ago" case-insensitively with prefix', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');
  const result = prepareRecord({ url: 'https://example.test/a', company: 'A', title: 'T', posted: 'Posted 6 hours ago' }, now);
  assert.equal(result.postedAt, new Date(now.getTime() - 6 * 3600000).toISOString());
});

test('unparseable relative text returns null postedAt', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');
  const result = prepareRecord({ url: 'https://example.test/a', company: 'A', title: 'T', posted: 'a while back' }, now);
  assert.equal(result.postedAt, null);
});

test('prepared output imports with zero errors', () => {
  const result = prepare([{ url: 'https://example.test/a', company: 'A', title: 'T', date: '2026-07-15' }]);
  const imported = importPublicSearchCandidates(result.kept);
  assert.equal(imported.candidates.length, 1);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'public-search-'));
  const file = path.join(dir, 'prepared.json');
  writeFileSync(file, JSON.stringify(result.kept));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1);
});
