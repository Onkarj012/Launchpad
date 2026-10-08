import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCrawlerHelp } from '../../crawler/operator.mjs';
import { parseAuditV5JournalArgs } from '../../crawler/cli.mjs';
import { verifySafetyContracts } from '../../crawler/safety-contract.mjs';
import {
  assertExternalAuditReceiptPath,
  auditV5Journal,
  classifyJournalRecord,
  createTransactionJournal,
  JOURNAL_AUDIT_CLASSIFICATIONS,
  writeAuditReceipt,
} from '../../notion-v5/transaction.mjs';

const pageId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const dataSourceId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const syntheticPageId = 'dddddddddddddddddddddddddddddddd';
const archivedPageId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const trashedPageId = 'ffffffffffffffffffffffffffffffff';
const missingPageId = '11111111111111111111111111111112';
const forbiddenPageId = '11111111111111111111111111111113';
const failingPageId = '11111111111111111111111111111114';
const secret = 'fixture-secret';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function tempDirectory() { return mkdtempSync(path.join(os.tmpdir(), 'launchpad-v5-audit-')); }
function committed(key, target = 'applications', id = pageId) { return { key, state: 'committed', target, pageId: id }; }
function inspected(title = 'AI Engineer', flags = {}) {
  return {
    pageExists: true,
    target: { key: 'applications', name: 'Applications v5', dataSourceId },
    pageScope: 'verified',
    relationState: { status: 'verified', properties: [{ property: 'Company', status: 'present', relatedPageCount: 1 }] },
    evidence: { title, parentDataSourceId: dataSourceId, syntheticMarker: /synthetic/i.test(title), testArtifactMarker: /(?:test|fixture)/i.test(title), ...flags },
  };
}

test('journal classification is exclusive and fail-closed', () => {
  const common = { pageExists: true, pageScope: 'verified', relationState: { status: 'verified' } };
  assert.equal(classifyJournalRecord({ entry: committed('live'), ...common }), 'retained-live-page');
  assert.equal(classifyJournalRecord({ entry: committed('smoke:run:applications'), syntheticMarker: true, ...common }), 'synthetic-artifact');
  assert.equal(classifyJournalRecord({ entry: committed('fixture:old'), testArtifactMarker: true, ...common }), 'stale-test-artifact');
  assert.equal(classifyJournalRecord({ entry: { key: 'broken', state: 'committed', target: 'applications', pageId: 'not-an-id' }, ...common }), 'malformed-record');
  assert.equal(classifyJournalRecord({ entry: committed('live'), pageExists: null, pageScope: null, relationState: null }), 'unresolved');
  assert.equal(classifyJournalRecord({ entry: committed('live'), ...common, archived: true }), 'unresolved');
  assert.equal(classifyJournalRecord({ entry: committed('live'), ...common, inTrash: true }), 'unresolved');
  assert.deepEqual(new Set([
    classifyJournalRecord({ entry: committed('live'), ...common }),
    classifyJournalRecord({ entry: committed('smoke:run:applications'), syntheticMarker: true, ...common }),
    classifyJournalRecord({ entry: committed('fixture:old'), testArtifactMarker: true, ...common }),
    classifyJournalRecord({ entry: { key: 'broken', state: 'committed', target: 'applications', pageId: 'not-an-id' }, ...common }),
    classifyJournalRecord({ entry: committed('live'), pageExists: null, pageScope: null, relationState: null }),
  ]), new Set(JOURNAL_AUDIT_CLASSIFICATIONS));
});

test('audit records evidence, redacts failures, and preserves recovery entries byte-for-byte', async () => {
  const directory = tempDirectory();
  const journalPath = path.join(directory, 'journal.json');
  const journalState = {
    version: 'LaunchpadV5TransactionJournalV1',
    entries: {
      live: committed('live'),
      'smoke:run:applications': committed('smoke:run:applications', 'applications', syntheticPageId),
      'fixture:old': committed('fixture:old', 'applications', 'cccccccccccccccccccccccccccccccc'),
      archived: committed('archived', 'applications', archivedPageId),
      trashed: committed('trashed', 'applications', trashedPageId),
      missing: committed('missing', 'applications', missingPageId),
      forbidden: committed('forbidden', 'applications', forbiddenPageId),
      failing: committed('failing', 'applications', failingPageId),
      malformed: { key: 'malformed', state: 'committed', target: 'applications', pageId: 'bad' },
      pending: { key: 'pending', state: 'pending', target: 'applications', pageId },
      verified: { key: 'verified', state: 'verified', target: 'applications', pageId },
    },
  };
  writeFileSync(journalPath, `${JSON.stringify(journalState)}\n`, { mode: 0o600 });
  const journal = createTransactionJournal({ journalPath });
  const before = readFileSync(journalPath, 'utf8');
  const gateway = {
    async readPage(id, target) {
      assert.equal(target, 'applications');
      if (id === pageId) return inspected('AI Engineer');
      if (id === syntheticPageId) return inspected('Synthetic smoke artifact');
      if (id.startsWith('c')) return inspected('Test fixture');
      if (id === archivedPageId) return inspected('AI Engineer', { archived: true, inTrash: false, in_trash: false });
      if (id === trashedPageId) return inspected('AI Engineer', { archived: false, inTrash: true, in_trash: true });
      if (id === missingPageId) throw Object.assign(new Error('missing page'), { status: 404 });
      if (id === forbiddenPageId) throw Object.assign(new Error('forbidden page'), { status: 403 });
      throw new Error(`Notion read failed with ${secret}`);
    },
  };
  const receipt = await auditV5Journal({ journal, gateway, secrets: [secret], now: () => '2026-09-01T00:00:00.000Z' });
  assert.equal(receipt.counts['retained-live-page'], 1);
  assert.equal(receipt.counts['synthetic-artifact'], 1);
  assert.equal(receipt.counts['stale-test-artifact'], 1);
  assert.equal(receipt.counts['malformed-record'], 1);
  assert.equal(receipt.counts.unresolved, 7);
  assert.equal(receipt.entries.find(({ key }) => key === 'missing').pageExists, false);
  assert.equal(receipt.entries.find(({ key }) => key === 'forbidden').pageExists, null);
  assert.equal(receipt.entries.find(({ key }) => key === 'failing').pageExists, null);
  assert.equal(receipt.entries.find(({ key }) => key === 'archived').classification, 'unresolved');
  assert.equal(receipt.entries.find(({ key }) => key === 'archived').evidence.archived, true);
  assert.equal(receipt.entries.find(({ key }) => key === 'trashed').evidence.inTrash, true);
  assert.equal(receipt.phase4.blocked, true);
  assert.equal(receipt.phase4.blockingCount, 8);
  assert.equal(receipt.phase4.blockingReasons.length, receipt.phase4.blockingCount);
  assert.equal(receipt.entries.find(({ key }) => key === 'pending').journalState, 'pending');
  assert.equal(receipt.entries.find(({ key }) => key === 'verified').journalState, 'verified');
  assert.equal(JSON.stringify(receipt).includes(secret), false);
  assert.equal(readFileSync(journalPath, 'utf8'), before);
});

test('audit requires an existing owner-only journal while normal journal creation remains available', () => {
  const directory = tempDirectory();
  const missingJournalPath = path.join(directory, 'missing-journal.json');
  assert.throws(() => createTransactionJournal({ journalPath: missingJournalPath, requireExisting: true }), /must already exist/);
  const normalJournal = createTransactionJournal({ journalPath: path.join(directory, 'normal-journal.json') });
  assert.deepEqual(normalJournal.state.entries, {});
  writeFileSync(path.join(directory, 'insecure-journal.json'), '{}\n', { mode: 0o640 });
  assert.throws(() => createTransactionJournal({ journalPath: path.join(directory, 'insecure-journal.json'), requireExisting: true }), /mode 0600/);
});

test('audit receipt is external, atomic, owner-only, and command surface stays in parity', () => {
  const directory = tempDirectory();
  const receiptPath = path.join(directory, 'receipt.json');
  const written = writeAuditReceipt(receiptPath, { evidence: `Bearer ${secret}` }, repositoryRoot, [secret]);
  assert.equal(written, receiptPath);
  assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).evidence, 'Bearer [REDACTED]');
  assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
  chmodSync(receiptPath, 0o600);
  const cwdBeforePathCheck = process.cwd();
  assert.throws(() => assertExternalAuditReceiptPath(path.join(repositoryRoot, 'receipt-inside-repo.json')), /outside the repository/);
  assert.equal(process.cwd(), cwdBeforePathCheck);

  const parsed = parseAuditV5JournalArgs(['audit-v5-journal', '--credential-file', '/tmp/token', '--journal', '/tmp/journal.json', '--receipt', '/tmp/receipt.json']);
  assert.deepEqual(parsed, { credentialFile: '/tmp/token', journalPath: '/tmp/journal.json', receiptPath: '/tmp/receipt.json' });
  assert.throws(() => parseAuditV5JournalArgs(['audit-v5-journal', '--credential-file', 'token', '--journal', '/tmp/journal.json', '--receipt', '/tmp/receipt.json']), /absolute path/);
  const help = buildCrawlerHelp();
  for (const flag of ['audit-v5-journal', '--credential-file', '--journal', '--receipt', '--execute-writes']) assert.match(help, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const manifestPath = 'config/launchpad-v5.commands.json';
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, manifestPath), 'utf8'));
  assert.match(manifest.commands['audit-v5-journal'].invocation, /audit-v5-journal/);
  for (const flag of manifest.liveSensitiveFlags) assert.match(help, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const command of Object.values(manifest.commands)) {
    for (const flag of command.flags ?? []) {
      assert.ok(manifest.liveSensitiveFlags.includes(flag));
      assert.match(help, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }

  const passing = verifySafetyContracts({ root: repositoryRoot });
  assert.equal(passing.passed, true);
  const manifestWithoutReceipt = readFileSync(path.join(repositoryRoot, manifestPath), 'utf8').replace(', "--receipt"', '');
  const manifestFailure = verifySafetyContracts({ root: repositoryRoot, files: { [manifestPath]: manifestWithoutReceipt } });
  assert.equal(manifestFailure.passed, false);
  assert.ok(manifestFailure.checks.some((check) => check.id === 'executable-command-parity' && !check.ok));
  const operatorPath = 'crawler/operator.mjs';
  const operatorWithoutReceipt = readFileSync(path.join(repositoryRoot, operatorPath), 'utf8').replace(' --receipt ABS_PATH', '');
  const helpFailure = verifySafetyContracts({ root: repositoryRoot, files: { [operatorPath]: operatorWithoutReceipt } });
  assert.equal(helpFailure.passed, false);
  assert.ok(helpFailure.checks.some((check) => check.id === 'executable-command-parity' && !check.ok));
});
