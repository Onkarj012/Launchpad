import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candidateDedupKey, candidateIdentityKeys, candidateMatchesLedgerRow, candidateRequisitionKey, canonicalizeUrl, normalizedKey } from './candidate.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OPPORTUNITY_LEDGER_PATH = path.resolve(MODULE_DIR, '../career-ops/data/opportunity-ledger.tsv');
export const OPPORTUNITY_COLUMNS = [
  'dedup_key', 'company', 'role', 'canonical_url', 'provider',
  'first_surfaced_at', 'last_surfaced_at', 'times_surfaced', 'action_state', 'action_at', 'identity_aliases',
];
export const ACTION_STATES = ['none', 'applied', 'contacted', 'interviewing', 'rejected'];
const ACTIONED_STATES = new Set(['applied', 'contacted', 'interviewing']);
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export class OpportunityLedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpportunityLedgerError';
  }
}

function splitLine(line) {
  return line.split('\t').map((value) => value.replace(/\r$/, ''));
}

function rowFromValues(values) {
  const row = {};
  for (let index = 0; index < OPPORTUNITY_COLUMNS.length; index++) row[OPPORTUNITY_COLUMNS[index]] = values[index] ?? '';
  row.action_state = row.action_state || 'none';
  row.action_at = row.action_at || null;
  return row;
}

function safeCell(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function ledgerText(rows) {
  const header = `${OPPORTUNITY_COLUMNS.join('\t')}\n`;
  const body = rows.map((row) => OPPORTUNITY_COLUMNS.map((column) => safeCell(row[column])).join('\t')).join('\n');
  return `${header}${body}${body ? '\n' : ''}`;
}

function atomicWrite(ledgerPath, rows) {
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const temporary = `${ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, ledgerText(rows), 'utf8');
  renameSync(temporary, ledgerPath);
}

export function withOpportunityLedgerLock(ledgerPath, callback) {
  const lockPath = `${ledgerPath}.lock`;
  let descriptor;
  try {
    mkdirSync(path.dirname(ledgerPath), { recursive: true });
    descriptor = openSync(lockPath, 'wx');
    writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
  } catch (error) {
    if (descriptor != null) closeSync(descriptor);
    throw new OpportunityLedgerError(`ledger is locked: ${lockPath} (${error.message})`);
  }
  try {
    return callback();
  } finally {
    closeSync(descriptor);
    unlinkSync(lockPath);
  }
}

export function readOpportunityLedger(ledgerPath = DEFAULT_OPPORTUNITY_LEDGER_PATH) {
  if (!existsSync(ledgerPath)) return { path: ledgerPath, columns: OPPORTUNITY_COLUMNS, rows: [], missing: true };
  const content = readFileSync(ledgerPath, 'utf8');
  const lines = content.split('\n').filter((line, index, array) => line.length || index < array.length - 1);
  if (!lines.length || !lines[0].trim()) return { path: ledgerPath, columns: OPPORTUNITY_COLUMNS, rows: [], missing: false };
  const columns = splitLine(lines[0]);
  const recognized = (columns.length === OPPORTUNITY_COLUMNS.length || columns.length === OPPORTUNITY_COLUMNS.length - 1)
    && columns.every((column, index) => OPPORTUNITY_COLUMNS[index] === column);
  if (!recognized) throw new OpportunityLedgerError(`Unsupported opportunity ledger header in ${ledgerPath}`);
  const rows = lines.slice(1).filter((line) => line.trim()).map((line) => rowFromValues(splitLine(line)));
  return { path: ledgerPath, columns, rows, missing: false };
}

export function validateOpportunityLedger(ledgerPath = DEFAULT_OPPORTUNITY_LEDGER_PATH) {
  const current = readOpportunityLedger(ledgerPath);
  const errors = [];
  const seen = new Map();
  for (const [index, row] of current.rows.entries()) {
    if (!row.dedup_key) errors.push(`row ${index + 2}: dedup_key is empty`);
    if (!row.company) errors.push(`row ${index + 2}: company is empty`);
    if (!row.role) errors.push(`row ${index + 2}: role is empty`);
    if (!ACTION_STATES.includes(row.action_state)) errors.push(`row ${index + 2}: invalid action_state ${row.action_state}`);
    if (seen.has(row.dedup_key)) errors.push(`rows ${seen.get(row.dedup_key) + 2} and ${index + 2}: duplicate dedup_key ${row.dedup_key}`);
    else if (row.dedup_key) seen.set(row.dedup_key, index);
  }
  return { valid: errors.length === 0, errors, path: ledgerPath, missing: current.missing, rowCount: current.rows.length };
}

function validTimestamp(value) {
  return typeof value === 'string' && value && !Number.isNaN(Date.parse(value));
}

export function suppressionFor(row, nowIso) {
  const actionState = row?.action_state || 'none';
  if (ACTIONED_STATES.has(actionState)) return { suppressed: true, code: 'SUPPRESSED_ACTIONED' };
  if (actionState === 'rejected') return { suppressed: true, code: 'SUPPRESSED_REJECTED' };
  if (actionState !== 'none') throw new OpportunityLedgerError(`invalid action_state ${actionState}`);
  if (!validTimestamp(nowIso)) throw new OpportunityLedgerError(`invalid suppression clock: ${nowIso}`);
  if (!validTimestamp(row?.last_surfaced_at)) return { suppressed: false, code: '' };
  const age = Date.parse(nowIso) - Date.parse(row.last_surfaced_at);
  if (age >= 0 && age <= COOLDOWN_MS) return { suppressed: true, code: 'SUPPRESSED_COOLDOWN_7D' };
  return { suppressed: false, code: '' };
}

function rowsForMutation(ledgerPath) {
  return readOpportunityLedger(ledgerPath).rows;
}

function newSurfacedRow(candidate, key, now) {
  return {
    dedup_key: key,
    company: candidate.company,
    role: candidate.title,
    canonical_url: candidate.canonicalUrl || '',
    provider: candidate.provider || '',
    first_surfaced_at: now,
    last_surfaced_at: now,
    times_surfaced: 1,
    action_state: 'none',
    action_at: null,
    identity_aliases: JSON.stringify(candidateIdentityKeys(candidate)),
  };
}

export function recordSurfaced(candidates, { path: ledgerPath = DEFAULT_OPPORTUNITY_LEDGER_PATH, now = new Date().toISOString() } = {}) {
  if (!Array.isArray(candidates)) throw new OpportunityLedgerError('recordSurfaced requires an array of candidates');
  if (!validTimestamp(now)) throw new OpportunityLedgerError(`invalid surfaced clock: ${now}`);
  return withOpportunityLedgerLock(ledgerPath, () => {
    const rows = rowsForMutation(ledgerPath);
    const recorded = [];
    for (const candidate of candidates) {
      const key = candidateDedupKey(candidate);
      const durableKey = candidateRequisitionKey(candidate);
      const url = canonicalizeUrl(candidate.canonicalUrl || candidate.url);
      let row = rows.find((entry) => candidateMatchesLedgerRow(candidate, entry))
        || (!durableKey && url
          ? rows.find((entry) => {
            const rowKey = normalizedKey(entry.dedup_key);
            const rowProvider = normalizedKey(entry.provider);
            const rowJobId = normalizedKey(entry.job_id ?? entry.jobId ?? entry.provider_job_id);
            const rowHasDurableKey = Boolean(rowProvider && rowJobId) || (rowProvider && rowKey.startsWith(`${rowProvider}|`));
            return !rowHasDurableKey && canonicalizeUrl(entry.canonical_url) === url;
          })
          : null);
      if (!row) {
        row = newSurfacedRow(candidate, key, now);
        rows.push(row);
      } else {
        row.last_surfaced_at = now;
        row.times_surfaced = Number(row.times_surfaced || 0) + 1;
        if (!row.canonical_url && candidate.canonicalUrl) row.canonical_url = candidate.canonicalUrl;
        if (!row.provider && candidate.provider) row.provider = candidate.provider;
      }
      row.identity_aliases = JSON.stringify([...new Set([...JSON.parse(row.identity_aliases || '[]'), ...candidateIdentityKeys(candidate)])]);
      recorded.push(row);
    }
    atomicWrite(ledgerPath, rows);
    return { path: ledgerPath, rows: recorded };
  });
}

export function repairMissingSurfaced(candidates, {
  path: ledgerPath = DEFAULT_OPPORTUNITY_LEDGER_PATH,
  committedAtForKey,
} = {}) {
  if (!Array.isArray(candidates)) throw new OpportunityLedgerError('repairMissingSurfaced requires an array of candidates');
  if (typeof committedAtForKey !== 'function') throw new OpportunityLedgerError('repairMissingSurfaced requires committedAtForKey');
  return withOpportunityLedgerLock(ledgerPath, () => {
    const rows = rowsForMutation(ledgerPath);
    const repaired = [];
    for (const candidate of candidates) {
      const key = candidateDedupKey(candidate);
      if (rows.some((row) => candidateMatchesLedgerRow(candidate, row))) continue;
      const committedAt = committedAtForKey(key);
      if (!validTimestamp(committedAt)) throw new OpportunityLedgerError(`missing original commit time for replayed key: ${key}`);
      const row = newSurfacedRow(candidate, key, committedAt);
      rows.push(row);
      repaired.push(row);
    }
    if (repaired.length) atomicWrite(ledgerPath, rows);
    return { path: ledgerPath, rows: repaired };
  });
}

export function markAction({ key, url, state, path: ledgerPath = DEFAULT_OPPORTUNITY_LEDGER_PATH, now = new Date().toISOString() } = {}) {
  if (!ACTION_STATES.includes(state)) throw new OpportunityLedgerError(`invalid action state ${state}`);
  if (!key && !url) throw new OpportunityLedgerError('mark requires key or url');
  if (!validTimestamp(now)) throw new OpportunityLedgerError(`invalid action clock: ${now}`);
  return withOpportunityLedgerLock(ledgerPath, () => {
    const rows = rowsForMutation(ledgerPath);
    const row = rows.find((entry) => key ? candidateMatchesLedgerRow({ identityAliases: [key] }, entry) : entry.canonical_url === url);
    if (!row) throw new OpportunityLedgerError(`no matching opportunity found for ${key ? `key ${key}` : `url ${url}`}`);
    row.action_state = state;
    row.action_at = now;
    atomicWrite(ledgerPath, rows);
    return { path: ledgerPath, row };
  });
}

function cliValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function printHelp() {
  console.log('Usage: node job-pull/opportunity-ledger.mjs <validate|list|mark> [--path FILE] [--key K|--url U] [--state STATE]');
}

export function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'help';
  const ledgerPath = cliValue(argv, '--path') || DEFAULT_OPPORTUNITY_LEDGER_PATH;
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }
  if (command === 'validate') {
    const result = validateOpportunityLedger(ledgerPath);
    console.log(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  }
  if (command === 'list') {
    console.log(JSON.stringify(readOpportunityLedger(ledgerPath).rows, null, 2));
    return 0;
  }
  if (command === 'mark') {
    const result = markAction({
      path: ledgerPath,
      key: cliValue(argv, '--key'),
      url: cliValue(argv, '--url'),
      state: cliValue(argv, '--state'),
    });
    console.log(JSON.stringify(result.row, null, 2));
    return 0;
  }
  printHelp();
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
