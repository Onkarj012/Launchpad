import test from 'node:test';
import assert from 'node:assert/strict';
import { readPath, mapItem, validateConfig, RunError } from '../../job-pull/apify-pull.mjs';
import { prepare } from '../../job-pull/public-search-prepare.mjs';

test('readPath resolves dot-paths, including nested objects and missing keys', () => {
  assert.equal(readPath({ a: { b: { c: 'x' } } }, 'a.b.c'), 'x');
  assert.equal(readPath({ a: 1 }, 'a.b.c'), undefined);
  assert.equal(readPath({ jobUrl: 'https://example.test/1' }, 'jobUrl'), 'https://example.test/1');
});

test('mapItem shapes a raw dataset item into the RAW record contract', () => {
  const fieldMap = {
    url: 'jobUrl',
    company: 'companyName',
    title: 'jobTitle',
    postedAt: 'publishedAt',
    location: 'location',
    description: 'jobDescription',
  };
  const item = {
    jobUrl: 'https://example.test/job/1',
    companyName: 'Acme',
    jobTitle: 'AI Engineer',
    publishedAt: '2026-07-14T00:00:00.000Z',
    location: 'Pune, India',
    jobDescription: 'Build things.',
  };
  const record = mapItem(item, fieldMap, 'linkedin');
  assert.equal(record.url, 'https://example.test/job/1');
  assert.equal(record.company, 'Acme');
  assert.equal(record.title, 'AI Engineer');
  assert.equal(record.postedAt, '2026-07-14T00:00:00.000Z');
  assert.equal(record.location, 'Pune, India');
  assert.equal(record.description, 'Build things.');
  assert.equal(record.sourceKind, 'aggregator');
  assert.equal(record.source, 'apify-linkedin');

  // missing item / fieldMap short-circuit to null
  assert.equal(mapItem(null, fieldMap, 'linkedin'), null);
  assert.equal(mapItem(item, null, 'linkedin'), null);
});

test('validateConfig rejects malformed actor entries and accepts a well-formed config', () => {
  assert.throws(() => validateConfig(null), RunError);
  assert.throws(() => validateConfig({ actors: 'nope' }), RunError);
  assert.throws(() => validateConfig({ actors: [{ id: 'x' }] }), RunError); // missing fieldMap
  assert.throws(() => validateConfig({ actors: [{ fieldMap: { url: 'u', company: 'c', title: 't' } }] }), RunError); // missing id
  assert.throws(
    () => validateConfig({ actors: [{ id: 'x', fieldMap: { url: 'u', company: 'c' } }] }),
    RunError,
  ); // missing fieldMap.title

  const good = { actors: [{ id: 'acme~scraper', label: 'acme', fieldMap: { url: 'u', company: 'c', title: 't' } }] };
  assert.equal(validateConfig(good), good);
});

test('a mapped Apify record passes public-search-prepare.mjs unchanged', () => {
  const fieldMap = {
    url: 'jobUrl',
    company: 'companyName',
    title: 'jobTitle',
    postedAt: 'publishedAt',
    location: 'location',
    description: 'jobDescription',
  };
  const item = {
    jobUrl: 'https://example.test/job/42',
    companyName: 'Acme',
    jobTitle: 'Backend Engineer',
    publishedAt: '2026-07-15',
    location: 'Pune, India',
    jobDescription: 'Ship the backend.',
  };
  const record = mapItem(item, fieldMap, 'linkedin');
  const result = prepare([record]);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].url, 'https://example.test/job/42');
  assert.equal(result.kept[0].company, 'Acme');
  assert.equal(result.kept[0].postedAt, '2026-07-15T00:00:00.000Z');
});
