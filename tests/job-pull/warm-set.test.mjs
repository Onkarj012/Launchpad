import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  boardKeyFromUrl,
  emptyWarmSet,
  promoteFromUrls,
  warmEntries,
  warmSetSize,
  saveWarmSet,
  loadWarmSet,
  warmSetFromScanHistory,
} from '../../job-pull/warm-set.mjs';

test('boardKeyFromUrl recovers slugs from canonical ATS hosts and rejects custom domains', () => {
  assert.deepEqual(boardKeyFromUrl('https://job-boards.greenhouse.io/phonepe/jobs/7680147003'), { ats: 'greenhouse', key: 'phonepe' });
  assert.deepEqual(boardKeyFromUrl('https://jobs.lever.co/acme/abc-123'), { ats: 'lever', key: 'acme' });
  assert.deepEqual(boardKeyFromUrl('https://jobs.ashbyhq.com/notion/uuid'), { ats: 'ashby', key: 'notion' });
  assert.deepEqual(boardKeyFromUrl('https://acme.wd1.myworkdayjobs.com/External/job/123'), { ats: 'workday', key: 'acme|wd1|External' });
  // Custom-domain Greenhouse fronting — slug is not recoverable, must be null.
  assert.equal(boardKeyFromUrl('https://www.pinterestcareers.com/jobs/?gh_jid=6121450'), null);
  assert.equal(boardKeyFromUrl('not-a-url'), null);
});

test('promoteFromUrls adds new boards once and reports the count', () => {
  const set = emptyWarmSet();
  const { added } = promoteFromUrls(set, [
    'https://job-boards.greenhouse.io/stripe/jobs/1',
    'https://job-boards.greenhouse.io/stripe/jobs/2', // same board — not double-counted
    'https://jobs.lever.co/openai/x',
    'https://example.com/careers/1',                  // unrecognized — ignored
  ]);
  assert.equal(added, 2);
  assert.deepEqual(set.boards.greenhouse, ['stripe']);
  assert.deepEqual(set.boards.lever, ['openai']);
  assert.equal(warmSetSize(set), 2);
});

test('warmEntries builds SSRF-checked PortalEntry objects for a provider', () => {
  const set = emptyWarmSet();
  set.boards.greenhouse = ['phonepe', 'bad slug with spaces'];
  const entries = warmEntries(set, 'greenhouse');
  assert.equal(entries.length, 1); // the invalid slug is dropped
  assert.equal(entries[0].name, 'phonepe');
  assert.equal(entries[0].careers_url, 'https://job-boards.greenhouse.io/phonepe');
});

test('saveWarmSet / loadWarmSet round-trip is sorted and deduped', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'warmset-'));
  const file = path.join(dir, 'warm.json');
  const set = emptyWarmSet();
  set.boards.ashby = ['ramp', 'cursor', 'ramp']; // dupe
  saveWarmSet(file, set, '2026-07-15T00:00:00.000Z');
  const loaded = loadWarmSet(file);
  assert.deepEqual(loaded.boards.ashby, ['cursor', 'ramp']);
  assert.equal(loaded.updatedAt, '2026-07-15T00:00:00.000Z');
});

test('warmSetFromScanHistory seeds boards from an added-URL log, skipping custom domains', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scanhist-'));
  const tsv = path.join(dir, 'scan-history.tsv');
  writeFileSync(tsv, [
    'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation',
    'https://job-boards.greenhouse.io/phonepe/jobs/1\t2026-07-09\tgreenhouse-api\tSWE\tPhonePe\tadded\tPune',
    'https://jobs.ashbyhq.com/notion/x\t2026-07-09\tashby-api\tSWE\tNotion\tadded\tHyderabad',
    'https://www.pinterestcareers.com/jobs/?gh_jid=6121450\t2026-07-09\tgreenhouse-api\tMLE\tPinterest\tadded\tRemote',
  ].join('\n'), 'utf-8');
  const set = warmSetFromScanHistory(tsv);
  assert.deepEqual(set.boards.greenhouse, ['phonepe']);
  assert.deepEqual(set.boards.ashby, ['notion']);
  assert.equal(warmSetSize(set), 2); // Pinterest custom domain skipped
});
