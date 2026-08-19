import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candidateDedupKey, canonicalizeUrl } from './candidate.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LEDGER_PATH = path.resolve(MODULE_DIR, '../career-ops/data/notion-written.tsv');
export const LEGACY_COLUMNS = ['dedup_key', 'job_id', 'company', 'role', 'notion_page_url', 'date_pulled'];
export const LEDGER_COLUMNS = [...LEGACY_COLUMNS, 'state', 'run_id', 'created_at', 'updated_at', 'error', 'canonical_url', 'provider'];

export class LedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerError';
  }
}

function splitLine(line) {
  return line.split('\t').map((value) => value.replace(/\r$/, ''));
}

function rowFromValues(columns, values) {
  const row = {};
  for (let index = 0; index < columns.length; index++) row[columns[index]] = values[index] ?? '';
  row.state = row.state || 'committed';
  row.run_id = row.run_id || null;
  row.created_at = row.created_at || null;
  row.updated_at = row.updated_at || null;
  row.error = row.error || null;
  row.canonical_url = row.canonical_url || null;
  row.provider = row.provider || null;
  return row;
}

function safeCell(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

export function readLedger(ledgerPath = DEFAULT_LEDGER_PATH) {
  if (!existsSync(ledgerPath)) return { path: ledgerPath, columns: LEDGER_COLUMNS, rows: [], legacy: false, missing: true };
  const content = readFileSync(ledgerPath, 'utf8');
  const lines = content.split('\n').filter((line, index, array) => line.length || index < array.length - 1);
  if (!lines.length || !lines[0].trim()) return { path: ledgerPath, columns: LEDGER_COLUMNS, rows: [], legacy: false, missing: false };
  const columns = splitLine(lines[0]);
  const legacy = columns.length === LEGACY_COLUMNS.length && LEGACY_COLUMNS.every((column, index) => columns[index] === column);
  const recognized = legacy || LEDGER_COLUMNS.every((column, index) => columns[index] === column);
  if (!recognized) throw new LedgerError(`Unsupported ledger header in ${ledgerPath}`);
  const rows = lines.slice(1).filter((line) => line.trim()).map((line) => rowFromValues(columns, splitLine(line)));
  return { path: ledgerPath, columns, rows, legacy, missing: false };
}

export function migrateRows(rows) {
  return rows.map((row) => ({
    dedup_key: row.dedup_key || '',
    job_id: row.job_id || '',
    company: row.company || '',
    role: row.role || '',
    notion_page_url: row.notion_page_url || '',
    date_pulled: row.date_pulled || '',
    state: row.state || 'committed',
    run_id: row.run_id || null,
    created_at: row.created_at || row.date_pulled || null,
    updated_at: row.updated_at || row.date_pulled || null,
    error: row.error || null,
    canonical_url: row.canonical_url || null,
    provider: row.provider || null,
  }));
}

function ledgerText(rows) {
  const header = `${LEDGER_COLUMNS.join('\t')}\n`;
  const body = rows.map((row) => LEDGER_COLUMNS.map((column) => safeCell(row[column])).join('\t')).join('\n');
  return `${header}${body}${body ? '\n' : ''}`;
}

function atomicWrite(ledgerPath, rows) {
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const temporary = `${ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, ledgerText(rows), 'utf8');
  renameSync(temporary, ledgerPath);
}

export function withLedgerLock(ledgerPath, callback) {
  const lockPath = `${ledgerPath}.lock`;
  let descriptor;
  try {
    mkdirSync(path.dirname(ledgerPath), { recursive: true });
    descriptor = openSync(lockPath, 'wx');
    writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
  } catch (error) {
    if (descriptor != null) closeSync(descriptor);
    throw new LedgerError(`ledger is locked: ${lockPath} (${error.message})`);
  }
  try {
    return callback();
  } finally {
    closeSync(descriptor);
    unlinkSync(lockPath);
  }
}

export function migrateLedger({ path: ledgerPath = DEFAULT_LEDGER_PATH, dryRun = false } = {}) {
  const current = readLedger(ledgerPath);
  const rows = current.legacy ? migrateRows(current.rows) : current.rows;
  const changed = current.legacy;
  if (changed && !dryRun) withLedgerLock(ledgerPath, () => atomicWrite(ledgerPath, rows));
  return { path: ledgerPath, dryRun, changed, written: changed && !dryRun, rows, legacy: current.legacy };
}

export function seedFromNotion(entries, { path: ledgerPath = DEFAULT_LEDGER_PATH, now = new Date().toISOString() } = {}) {
  return withLedgerLock(ledgerPath, () => {
    const rows = rowsForMutation(ledgerPath);
    const existingUrls = new Set(rows.map((row) => canonicalizeUrl(row.canonical_url)).filter(Boolean));
    const existingKeys = new Set(rows.map((row) => row.dedup_key).filter(Boolean));
    let added = 0;
    let skipped = 0;
    for (const entry of entries) {
      const canonicalUrl = canonicalizeUrl(entry.url ?? entry.jdLink);
      const dedupKey = candidateDedupKey({ company: entry.company, title: entry.role ?? entry.title, location: entry.location });
      if ((canonicalUrl && existingUrls.has(canonicalUrl)) || (dedupKey && existingKeys.has(dedupKey))) {
        skipped++;
        continue;
      }
      rows.push({
        dedup_key: dedupKey,
        job_id: entry.jobId || '',
        company: entry.company || '',
        role: entry.role ?? entry.title ?? '',
        notion_page_url: entry.notionPageUrl || '',
        date_pulled: entry.datePulled || now.slice(0, 10),
        state: 'committed',
        run_id: 'notion-seed',
        created_at: entry.datePulled || now,
        updated_at: now,
        error: null,
        canonical_url: canonicalUrl,
        provider: entry.provider || null,
      });
      if (canonicalUrl) existingUrls.add(canonicalUrl);
      if (dedupKey) existingKeys.add(dedupKey);
      added++;
    }
    atomicWrite(ledgerPath, rows);
    return { added, skipped, total: rows.length };
  });
}

function rowsForMutation(ledgerPath) {
  const current = readLedger(ledgerPath);
  return current.legacy ? migrateRows(current.rows) : current.rows;
}

export function validateLedger(ledgerPath = DEFAULT_LEDGER_PATH) {
  const current = readLedger(ledgerPath);
  const rows = current.legacy ? migrateRows(current.rows) : current.rows;
  const errors = [];
  const seen = new Map();
  for (const [index, row] of rows.entries()) {
    if (!row.company) errors.push(`row ${index + 2}: company is empty`);
    if (!row.role) errors.push(`row ${index + 2}: role is empty`);
    if (!row.dedup_key) errors.push(`row ${index + 2}: dedup_key is empty`);
    if (!['pending', 'committed', 'aborted'].includes(row.state)) errors.push(`row ${index + 2}: invalid state ${row.state}`);
    const key = row.dedup_key || `${row.company}|${row.role}`;
    if (seen.has(key) && row.state !== 'aborted' && rows[seen.get(key)].state !== 'aborted') errors.push(`rows ${seen.get(key) + 2} and ${index + 2}: duplicate dedup_key ${key}`);
    else seen.set(key, index);
  }
  return { valid: errors.length === 0, errors, path: ledgerPath, missing: current.missing, legacy: current.legacy, rowCount: rows.length, pendingCount: rows.filter((row) => row.state === 'pending').length };
}

export function pendingLedgerRows(ledgerPath = DEFAULT_LEDGER_PATH) {
  return rowsForMutation(ledgerPath).filter((row) => row.state === 'pending');
}

export function reserveCandidates(candidates, { path: ledgerPath = DEFAULT_LEDGER_PATH, runId = randomUUID(), now = new Date().toISOString() } = {}) {
  return withLedgerLock(ledgerPath, () => {
    const rows = rowsForMutation(ledgerPath);
    const reservations = [];
    for (const candidate of candidates) {
      const dedupKey = candidateDedupKey(candidate);
      const duplicate = rows.find((row) => row.state !== 'aborted' && (row.dedup_key === dedupKey || (candidate.jobId && String(row.job_id) === String(candidate.jobId)) || (candidate.canonicalUrl && row.canonical_url === candidate.canonicalUrl)));
      if (duplicate) throw new LedgerError(`cannot reserve existing ledger candidate: ${dedupKey}`);
      const row = {
        dedup_key: dedupKey,
        job_id: candidate.jobId || '',
        company: candidate.company,
        role: candidate.title,
        notion_page_url: '',
        date_pulled: now.slice(0, 10),
        state: 'pending',
        run_id: runId,
        created_at: now,
        updated_at: now,
        error: null,
        canonical_url: candidate.canonicalUrl || null,
        provider: candidate.provider || null,
      };
      rows.push(row);
      reservations.push(row);
    }
    atomicWrite(ledgerPath, rows);
    return { runId, reservations };
  });
}

function updateRunRows({ path: ledgerPath, runId, state, now, pageUrls = new Map(), error = null }) {
  return withLedgerLock(ledgerPath, () => {
    const rows = rowsForMutation(ledgerPath);
    let count = 0;
    for (const row of rows) {
      if (row.run_id !== runId || row.state !== 'pending') continue;
      if (state === 'committed') {
        if (!pageUrls.has(row.dedup_key)) continue; // partial Notion run: leave unconfirmed rows pending
        const pageUrl = safeCell(pageUrls.get(row.dedup_key));
        if (!pageUrl) throw new LedgerError(`missing Notion page URL for ${row.dedup_key}`);
        row.notion_page_url = pageUrl;
      }
      row.state = state;
      row.updated_at = now;
      row.error = state === 'aborted' ? error || 'aborted' : null;
      count++;
    }
    if (!count) throw new LedgerError(`no matching pending rows found for run ${runId}`);
    atomicWrite(ledgerPath, rows);
    return { runId, state, count, rows };
  });
}

export function commitRun({ path: ledgerPath = DEFAULT_LEDGER_PATH, runId, now = new Date().toISOString(), pageUrls = {} } = {}) {
  if (!runId) throw new LedgerError('commit requires runId');
  const map = pageUrls instanceof Map ? pageUrls : new Map(Object.entries(pageUrls));
  return updateRunRows({ path: ledgerPath, runId, state: 'committed', now, pageUrls: map });
}

export function abortRun({ path: ledgerPath = DEFAULT_LEDGER_PATH, runId, now = new Date().toISOString(), error = 'Notion operation failed' } = {}) {
  if (!runId) throw new LedgerError('abort requires runId');
  return updateRunRows({ path: ledgerPath, runId, state: 'aborted', now, error });
}

function cliValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function printHelp() {
  console.log('Usage: node job-pull/ledger.mjs <validate|pending|migrate|seed> [--path FILE] [--dry-run] [--in FILE]');
}

export function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'help';
  const ledgerPath = cliValue(argv, '--path') || DEFAULT_LEDGER_PATH;
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }
  if (command === 'validate') {
    const result = validateLedger(ledgerPath);
    console.log(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  }
  if (command === 'pending') {
    console.log(JSON.stringify(pendingLedgerRows(ledgerPath), null, 2));
    return 0;
  }
  if (command === 'migrate') {
    console.log(JSON.stringify(migrateLedger({ path: ledgerPath, dryRun: argv.includes('--dry-run') }), null, 2));
    return 0;
  }
  if (command === 'seed') {
    const inputPath = cliValue(argv, '--in');
    if (!inputPath) {
      console.error('seed requires --in FILE (JSON array of {company, role, location, url, datePulled})');
      return 1;
    }
    const entries = JSON.parse(readFileSync(inputPath, 'utf8'));
    const result = seedFromNotion(entries, { path: ledgerPath });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  printHelp();
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
