import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importIndeedInbox } from '../../crawler/indeed-inbox.mjs';

const tempInbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-indeed-'));
const record = (overrides = {}) => ({
  jobId: 'indeed-123',
  title: 'AI Engineer',
  company: 'Acme Labs',
  location: 'Pune, India',
  description: 'Build useful AI systems.',
  url: 'https://in.indeed.com/viewjob?jk=indeed-123',
  postedAt: '2026-07-23T08:00:00.000Z',
  ...overrides,
});
const payload = (records = [record()], overrides = {}) => ({ schemaVersion: 'IndeedConnectorV1', records, ...overrides });
const write = (dir, name, body) => { const file = path.join(dir, name); fs.writeFileSync(file, body); return file; };

test('imports a valid dated versioned file into normalized observations without network access', async () => {
  const inboxDir = tempInbox();
  write(inboxDir, '2026-07-23.json', JSON.stringify(payload()));

  const result = await importIndeedInbox({ inboxDir, date: '2026-07-23' });

  assert.equal(result.status, 'imported');
  assert.equal(result.imported, 1);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].provider, 'indeed');
  assert.equal(result.observations[0].sourceKind, 'aggregator');
  assert.equal(result.observations[0].classification, 'lead');
  assert.equal(result.observations[0].canonicalUrl, 'https://in.indeed.com/viewjob?jk=indeed-123');
  assert.equal(result.observations[0].applicationResolution.status, 'Unresolved');
  assert.equal(result.manifest.schemaVersion, 'IndeedInboxManifestV1');
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].status, 'committed');
});

test('rerunning the same dated file is idempotent through a durable content receipt', async () => {
  const inboxDir = tempInbox();
  write(inboxDir, '2026-07-23.json', JSON.stringify(payload()));

  const first = await importIndeedInbox({ inboxDir, date: '2026-07-23' });
  const second = await importIndeedInbox({ inboxDir, date: '2026-07-23' });

  assert.equal(first.imported, 1);
  assert.equal(second.imported, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(second.receipts[0].status, 'duplicate');
  assert.equal(fs.readdirSync(path.join(inboxDir, '.receipts')).length, 1);
});

test('malformed JSON is quarantined and does not produce observations', async () => {
  const inboxDir = tempInbox();
  const file = write(inboxDir, '2026-07-23-bad.json', '{not-json');

  const result = await importIndeedInbox({ inboxDir, date: '2026-07-23' });

  assert.equal(result.status, 'quarantined');
  assert.equal(result.quarantined, 1);
  assert.equal(result.observations.length, 0);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.join(inboxDir, 'quarantine')).length, 1);
  assert.match(result.receipts[0].error, /JSON/i);
});

test('unsupported schema and missing records are quarantined as malformed payloads', async () => {
  const inboxDir = tempInbox();
  write(inboxDir, '2026-07-23-schema.json', JSON.stringify({ schemaVersion: 'IndeedConnectorV9', records: [] }));
  write(inboxDir, '2026-07-23-partial.json', JSON.stringify({ schemaVersion: 'IndeedConnectorV1', items: [] }));

  const result = await importIndeedInbox({ inboxDir, date: '2026-07-23' });

  assert.equal(result.quarantined, 2);
  assert.equal(result.observations.length, 0);
  assert.ok(result.receipts.every((receipt) => receipt.status === 'quarantined'));
});

test('partial record is quarantined while a valid sibling record is promoted by the resolver', async () => {
  const inboxDir = tempInbox();
  write(inboxDir, '2026-07-23.json', JSON.stringify(payload([
    record({ jobId: 'good', url: 'https://in.indeed.com/viewjob?jk=good' }),
    record({ jobId: 'bad', company: '' }),
  ])));

  const result = await importIndeedInbox({
    inboxDir,
    date: '2026-07-23',
    resolveOriginalEmployer: async (observation) => observation.providerJobId === 'good'
      ? { url: 'https://jobs.acme.com/careers/ai-engineer', company: 'Acme Labs', evidence: 'employer resolver fixture' }
      : null,
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.imported, 1);
  assert.equal(result.quarantined, 1);
  assert.equal(result.observations[0].classification, 'direct');
  assert.equal(result.observations[0].originalApplicationUrl, 'https://jobs.acme.com/careers/ai-engineer');
  assert.equal(result.observations[0].applicationResolution.status, 'Resolved Original');
  assert.equal(result.manifest.telemetry.resolverPromotions, 1);
});

test('receipt is crash-safe: an interrupted import leaves no committed receipt and reruns cleanly', async () => {
  const inboxDir = tempInbox();
  write(inboxDir, '2026-07-23.json', JSON.stringify(payload()));

  await assert.rejects(() => importIndeedInbox({ inboxDir, date: '2026-07-23', beforeCommit: () => { throw new Error('simulated crash'); } }), /simulated crash/);
  assert.equal(fs.readdirSync(path.join(inboxDir, '.receipts')).length, 0);

  const rerun = await importIndeedInbox({ inboxDir, date: '2026-07-23' });
  assert.equal(rerun.imported, 1);
  assert.equal(rerun.receipts[0].status, 'committed');
});
