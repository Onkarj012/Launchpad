import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOURNAL_VERSION = 'LaunchpadV5TransactionJournalV1';
const REDACTED = '[REDACTED]';

export class NotionV5TransactionError extends Error {
  constructor(message, details = null, code = 'TRANSACTION_FAILED') {
    super(message);
    this.name = 'NotionV5TransactionError';
    this.code = code;
    this.details = details;
  }
}

function sensitiveKey(key) { return /token|secret|password|authorization|credential|api[-_]?key/i.test(String(key)); }

export function redactSensitive(value, secrets = []) {
  const secretValues = secrets.filter(Boolean).map((secret) => String(secret));
  if (typeof value === 'string') {
    let output = value;
    for (const secret of secretValues) output = output.split(secret).join(REDACTED);
    return output.replace(/(Bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`).replace(/((?:token|secret|password|authorization|api[-_]?key)\s*[:=]\s*)[^\s,;}]+/gi, `$1${REDACTED}`);
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, secretValues));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey(key) ? REDACTED : redactSensitive(item, secretValues)]));
  return value;
}

export function structuredError(error) {
  const secrets = error?.redactionSecrets ?? [];
  return redactSensitive({
    code: error?.code ?? 'UNKNOWN_ERROR',
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    stage: error?.stage ?? 'transaction',
    status: error?.status ?? null,
    target: error?.target ?? null,
    details: error?.details ?? null,
  }, secrets);
}

function ensureExternalJournalPath(journalPath, repositoryRoot = REPOSITORY_ROOT) {
  if (!journalPath || !String(journalPath).trim()) throw new NotionV5TransactionError('an explicit external journal path is required for live writes', null, 'JOURNAL_PATH_REQUIRED');
  const resolved = path.resolve(String(journalPath));
  const root = path.resolve(repositoryRoot);
  const canonical = existsSync(resolved) ? realpathSync(resolved) : resolved;
  if (canonical === root || canonical.startsWith(`${root}${path.sep}`)) throw new NotionV5TransactionError('transaction journal must be outside the repository', null, 'JOURNAL_LOCATION_INVALID');
  return resolved;
}

function nowIso(now) { return new Date(typeof now === 'function' ? now() : now ?? Date.now()).toISOString(); }

export class FileTransactionJournal {
  constructor({ journalPath, now = () => Date.now(), repositoryRoot = REPOSITORY_ROOT } = {}) {
    this.path = ensureExternalJournalPath(journalPath, repositoryRoot);
    this.now = now;
    this.state = this.#read();
  }

  #read() {
    if (!existsSync(this.path)) return { version: JOURNAL_VERSION, entries: {} };
    let parsed;
    try { parsed = JSON.parse(readFileSync(this.path, 'utf8')); }
    catch (error) { throw new NotionV5TransactionError(`unable to read transaction journal: ${error.message}`, null, 'JOURNAL_READ_FAILED'); }
    if (parsed?.version !== JOURNAL_VERSION || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) throw new NotionV5TransactionError('transaction journal has an invalid format', null, 'JOURNAL_INVALID');
    return parsed;
  }

  #persist() {
    const parent = path.dirname(this.path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }

  get(key) { return this.state.entries[String(key)] ?? null; }

  reserve(items = []) {
    const reserved = [];
    const committedKeys = [];
    const pendingKeys = [];
    const verifiedKeys = [];
    for (const item of items) {
      const key = String(item?.key ?? item);
      const existing = this.state.entries[key];
      if (existing?.state === 'committed') { committedKeys.push(key); continue; }
      if (existing?.state === 'pending') { pendingKeys.push(key); continue; }
      if (existing?.state === 'verified') { verifiedKeys.push(key); continue; }
      const timestamp = nowIso(this.now);
      this.state.entries[key] = {
        key,
        state: 'pending',
        targetId: null,
        pageId: null,
        dataSourceId: null,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        error: null,
        target: item?.target ?? null,
      };
      reserved.push(key);
    }
    if (reserved.length) this.#persist();
    return { reserved, committedKeys, pendingKeys, verifiedKeys };
  }

  recordTarget(key, result = {}) {
    const entry = this.#require(key);
    const timestamp = nowIso(this.now);
    const pageId = result.pageId ?? result.page?.id ?? result.id ?? null;
    const targetId = result.targetId ?? result.databaseId ?? result.company?.id ?? null;
    const dataSourceId = result.dataSourceId ?? result.data_source_id ?? null;
    this.state.entries[String(key)] = { ...entry, targetId, pageId, dataSourceId, updatedAt: timestamp };
    this.#persist();
    return this.state.entries[String(key)];
  }

  markVerified(key) { return this.#transition(key, 'verified'); }
  markCommitted(key) { return this.#transition(key, 'committed'); }

  markAborted(key, error) {
    const entry = this.#require(key);
    const timestamp = nowIso(this.now);
    this.state.entries[String(key)] = { ...entry, state: 'aborted', updatedAt: timestamp, error: structuredError(error) };
    this.#persist();
    return this.state.entries[String(key)];
  }

  recover() {
    return Object.values(this.state.entries).filter((entry) => entry.state === 'pending' || entry.state === 'verified').map((entry) => ({ ...entry }));
  }

  #require(key) {
    const entry = this.get(key);
    if (!entry) throw new NotionV5TransactionError(`journal key is not reserved: ${key}`, null, 'JOURNAL_KEY_INVALID');
    return entry;
  }

  #transition(key, state) {
    const entry = this.#require(key);
    const timestamp = nowIso(this.now);
    this.state.entries[String(key)] = { ...entry, state, updatedAt: timestamp };
    this.#persist();
    return this.state.entries[String(key)];
  }
}

export function createTransactionJournal(options = {}) { return new FileTransactionJournal(options); }

export async function runReservedBatch({ items, reserve, write, verify, commit, abort, journal = null, keyOf = (item) => item.dedupKey ?? item.idempotencyKey ?? JSON.stringify(item) }) {
  if (!Array.isArray(items)) throw new NotionV5TransactionError('transaction items must be an array');
  for (const callback of [reserve, write, verify, commit, abort]) if (typeof callback !== 'function') throw new NotionV5TransactionError('reserve, write, verify, commit, and abort callbacks are required');
  const unique = [];
  const seen = new Set();
  for (const item of items) {
    const key = String(keyOf(item));
    if (!seen.has(key)) { seen.add(key); unique.push(item); }
  }
  if (!unique.length) return { status: 'noop', reserved: [], verified: [], committed: [], failed: [], skipped: [], recovery: [] };
  let journalReservation = { reserved: [], committedKeys: [], pendingKeys: [], verifiedKeys: [] };
  try { if (journal) journalReservation = await journal.reserve(unique.map((item) => ({ key: keyOf(item), target: item.resource ?? item.target ?? null }))); }
  catch (error) { return { status: 'aborted', reserved: [], verified: [], committed: [], failed: [{ item: null, error: structuredError(error) }], skipped: [], recovery: [] }; }
  let reservation;
  try { reservation = await reserve(unique.filter((item) => !journalReservation.pendingKeys.includes(String(keyOf(item))) && !journalReservation.verifiedKeys.includes(String(keyOf(item)))), journalReservation); }
  catch (error) {
    if (journal) for (const item of unique.filter((candidate) => journalReservation.reserved.includes(String(keyOf(candidate))))) journal.markAborted(keyOf(item), error);
    return { status: 'aborted', reserved: [], verified: [], committed: [], failed: [{ item: null, error: structuredError(error) }], skipped: [], recovery: [] };
  }
  const committedKeys = new Set([...(journalReservation.committedKeys ?? []), ...((reservation?.committedKeys ?? []).map(String))]);
  const recoveryKeys = new Set([...(journalReservation.pendingKeys ?? []), ...(journalReservation.verifiedKeys ?? [])].map(String));
  const reserved = reservation?.reserved ?? unique;
  const skipped = unique.filter((item) => committedKeys.has(String(keyOf(item))));
  const recovery = unique.filter((item) => recoveryKeys.has(String(keyOf(item))));
  const verified = [];
  const failed = recovery.map((item) => ({ item, error: structuredError(new NotionV5TransactionError('journal entry requires explicit recovery before retry', { key: keyOf(item) }, 'JOURNAL_RECOVERY_REQUIRED')) }));
  for (const item of unique) {
    const key = String(keyOf(item));
    if (committedKeys.has(key) || recoveryKeys.has(key)) continue;
    try {
      const result = await write(item, reservation);
      if (journal) journal.recordTarget(key, result);
      const verification = await verify(item, result, reservation);
      if (verification !== true && verification?.verified !== true) throw new NotionV5TransactionError('verification did not confirm the written row');
      if (journal) journal.markVerified(key);
      verified.push({ item, result, verification });
    } catch (error) {
      const failure = { item, error: structuredError(error) };
      failed.push(failure);
      if (journal) journal.markAborted(key, error);
      try { await abort([item], error, reservation); } catch (abortError) { failure.abortError = structuredError(abortError); }
    }
  }
  let committed = [];
  if (verified.length) {
    try {
      committed = await commit(verified, reservation) ?? verified;
      if (journal) for (const { item } of verified) journal.markCommitted(keyOf(item));
    } catch (error) {
      const failure = { item: null, error: structuredError(error) };
      failed.push(failure);
      if (journal) for (const { item } of verified) journal.markAborted(keyOf(item), error);
      try { await abort(verified.map(({ item }) => item), error, reservation); } catch (abortError) { failure.abortError = structuredError(abortError); }
      committed = [];
    }
  }
  return { status: failed.length ? (committed.length ? 'partial' : 'aborted') : 'committed', reserved, verified, committed, failed, skipped, recovery };
}
