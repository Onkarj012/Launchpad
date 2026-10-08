import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLegacyNotionId, isNotionIdentifier } from './manifest.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOURNAL_VERSION = 'LaunchpadV5TransactionJournalV1';
const REDACTED = '[REDACTED]';
export const JOURNAL_AUDIT_CLASSIFICATIONS = Object.freeze([
  'retained-live-page',
  'synthetic-artifact',
  'stale-test-artifact',
  'malformed-record',
  'unresolved',
]);

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

function ensureExternalJournalPath(journalPath, repositoryRoot = REPOSITORY_ROOT, requireExactMode = false) {
  if (!journalPath || !String(journalPath).trim()) throw new NotionV5TransactionError('an explicit external journal path is required for live writes', null, 'JOURNAL_PATH_REQUIRED');
  if (!path.isAbsolute(String(journalPath))) throw new NotionV5TransactionError('transaction journal path must be absolute', null, 'JOURNAL_PATH_NOT_ABSOLUTE');
  const resolved = path.resolve(String(journalPath));
  const root = path.resolve(repositoryRoot);
  const insideRoot = (candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
  const parent = path.dirname(resolved);
  let canonicalParent;
  try { canonicalParent = realpathSync(parent); }
  catch { throw new NotionV5TransactionError('transaction journal parent must exist and resolve canonically', null, 'JOURNAL_LOCATION_INVALID'); }
  if (insideRoot(canonicalParent)) throw new NotionV5TransactionError('transaction journal must be outside the repository', null, 'JOURNAL_LOCATION_INVALID');
  if (!existsSync(resolved)) return resolved;
  let stats;
  try {
    const linkStats = lstatSync(resolved);
    if (linkStats.isSymbolicLink() || !linkStats.isFile() || linkStats.nlink > 1) throw new Error('unsafe file type');
    stats = statSync(resolved);
  } catch (error) {
    if (error instanceof NotionV5TransactionError) throw error;
    throw new NotionV5TransactionError('transaction journal must be a regular non-symlink file', null, 'JOURNAL_FILE_INVALID');
  }
  if (requireExactMode ? (stats.mode & 0o777) !== 0o600 : (stats.mode & 0o077) !== 0) {
    throw new NotionV5TransactionError(requireExactMode ? 'transaction journal must have mode 0600' : 'transaction journal must not be group/world readable', null, 'JOURNAL_PERMISSIONS_INVALID');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) throw new NotionV5TransactionError('transaction journal must be owned by the current user', null, 'JOURNAL_OWNER_INVALID');
  return resolved;
}

function ensureExternalReceiptPath(receiptPath, repositoryRoot = REPOSITORY_ROOT) {
  if (!receiptPath || !String(receiptPath).trim()) throw new NotionV5TransactionError('an explicit external audit receipt path is required', null, 'RECEIPT_PATH_REQUIRED');
  if (!path.isAbsolute(String(receiptPath))) throw new NotionV5TransactionError('audit receipt path must be absolute', null, 'RECEIPT_PATH_NOT_ABSOLUTE');
  const resolved = path.resolve(String(receiptPath));
  const root = path.resolve(repositoryRoot);
  const insideRoot = (candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
  const parent = path.dirname(resolved);
  let canonicalParent;
  try { canonicalParent = realpathSync(parent); }
  catch { throw new NotionV5TransactionError('audit receipt parent must exist and resolve canonically', null, 'RECEIPT_LOCATION_INVALID'); }
  if (insideRoot(canonicalParent)) throw new NotionV5TransactionError('audit receipt must be outside the repository', null, 'RECEIPT_LOCATION_INVALID');
  if (!existsSync(resolved)) return resolved;
  let stats;
  try {
    const linkStats = lstatSync(resolved);
    if (linkStats.isSymbolicLink() || !linkStats.isFile() || linkStats.nlink > 1) throw new Error('unsafe file type');
    stats = statSync(resolved);
  } catch (error) {
    if (error instanceof NotionV5TransactionError) throw error;
    throw new NotionV5TransactionError('audit receipt must be a regular non-symlink file', null, 'RECEIPT_FILE_INVALID');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) throw new NotionV5TransactionError('audit receipt must be owned by the current user', null, 'RECEIPT_OWNER_INVALID');
  if ((stats.mode & 0o777) !== 0o600) throw new NotionV5TransactionError('audit receipt must have mode 0600', null, 'RECEIPT_PERMISSIONS_INVALID');
  return resolved;
}

export function assertExternalAuditReceiptPath(receiptPath, repositoryRoot = REPOSITORY_ROOT) {
  return ensureExternalReceiptPath(receiptPath, repositoryRoot);
}

export function writeAuditReceipt(receiptPath, receipt, repositoryRoot = REPOSITORY_ROOT, secrets = []) {
  const resolved = ensureExternalReceiptPath(receiptPath, repositoryRoot);
  const temporary = `${resolved}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(redactSensitive(receipt, secrets))}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, resolved);
    chmodSync(resolved, 0o600);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* preserve the original failure */ }
    throw new NotionV5TransactionError(`unable to write audit receipt: ${error.message}`, null, 'RECEIPT_WRITE_FAILED');
  }
  return resolved;
}

function validPageId(value) { return isNotionIdentifier(value) && !isLegacyNotionId(value); }

const AUDIT_TARGET_ALIASES = Object.freeze({ application: 'applications', company: 'companies' });
function auditTargetKey(value) {
  const normalized = String(value ?? '').trim();
  return AUDIT_TARGET_ALIASES[normalized] ?? normalized;
}

function targetIdentity(target) {
  if (!target || typeof target !== 'object') return null;
  return redactSensitive({ key: target.key ?? null, name: target.name ?? null, dataSourceId: target.dataSourceId ?? null });
}

export function classifyJournalRecord({ journalKey = null, entry, pageExists = null, pageScope = null, relationState = null, syntheticMarker = false, testArtifactMarker = false, archived = false, inTrash = false, accessError = null } = {}) {
  const malformed = !entry || typeof entry !== 'object' || Array.isArray(entry)
    || typeof entry.key !== 'string'
    || (journalKey !== null && entry.key !== journalKey)
    || entry.state !== 'committed'
    || !validPageId(entry.pageId)
    || typeof entry.target !== 'string' || !entry.target.trim();
  if (malformed) return 'malformed-record';
  if (accessError || pageExists !== true || pageScope !== 'verified' || relationState?.status !== 'verified') return 'unresolved';
  if (archived || inTrash) return 'unresolved';
  if (syntheticMarker) return 'synthetic-artifact';
  if (testArtifactMarker) return 'stale-test-artifact';
  return 'retained-live-page';
}

function auditCounts(entries) {
  const counts = Object.fromEntries(JOURNAL_AUDIT_CLASSIFICATIONS.map((classification) => [classification, 0]));
  for (const entry of entries) counts[entry.classification]++;
  return counts;
}

export async function auditV5Journal({ journal, gateway, secrets = [], now = () => new Date().toISOString() } = {}) {
  if (!journal || typeof journal !== 'object' || !journal.state?.entries || typeof journal.state.entries !== 'object') {
    throw new NotionV5TransactionError('audit requires a readable transaction journal', null, 'JOURNAL_INVALID');
  }
  if (!gateway || typeof gateway.readPage !== 'function') throw new NotionV5TransactionError('audit requires a read-only v5 page gateway', null, 'AUDIT_GATEWAY_REQUIRED');

  const audited = [];
  for (const [key, rawEntry] of Object.entries(journal.state.entries).sort(([left], [right]) => left.localeCompare(right))) {
    const entry = rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry) ? rawEntry : null;
    const journalState = entry?.state ?? null;
    const base = {
      key,
      journalState,
      target: entry?.target ? { key: auditTargetKey(entry.target), name: null, dataSourceId: null } : null,
      pageId: entry?.pageId ?? null,
      pageExists: null,
      relationState: { status: 'not-checked', properties: [] },
      classification: 'unresolved',
      phase4Blocked: false,
      blockingReason: null,
      evidence: {},
    };
    if (journalState === 'pending' || journalState === 'verified') {
      base.classification = 'unresolved';
      base.phase4Blocked = true;
      base.blockingReason = 'recovery-entry-requires-explicit-recovery';
      base.evidence = { reason: 'recovery-entry-requires-explicit-recovery', recoveryEntry: true };
      audited.push(base);
      continue;
    }
    if (journalState !== 'committed') {
      base.classification = 'unresolved';
      base.phase4Blocked = true;
      base.blockingReason = journalState ? 'non-committed-journal-entry' : 'journal-entry-state-missing';
      base.evidence = { reason: journalState ? 'non-committed-journal-entry' : 'journal-entry-state-missing' };
      audited.push(base);
      continue;
    }

    if (classifyJournalRecord({ journalKey: key, entry, pageExists: true, pageScope: 'verified', relationState: { status: 'verified' } }) === 'malformed-record') {
      base.classification = 'malformed-record';
      base.evidence = { reason: 'committed-record-shape-invalid' };
      base.phase4Blocked = true;
      base.blockingReason = 'committed-record-shape-invalid';
      audited.push(base);
      continue;
    }

    let inspected = null;
    try {
      inspected = await gateway.readPage(entry.pageId, auditTargetKey(entry.target));
      base.target = targetIdentity(inspected.target);
      base.pageExists = inspected.pageExists === true;
      base.relationState = inspected.relationState ?? base.relationState;
      const title = String(inspected.evidence?.title ?? '');
      const keyMarker = String(entry.key);
      const syntheticMarker = /^smoke:/i.test(keyMarker) && inspected.evidence?.syntheticMarker === true && /synthetic/i.test(title);
      const testArtifactMarker = /^(?:test|fixture):/i.test(keyMarker) && inspected.evidence?.testArtifactMarker === true;
      base.classification = classifyJournalRecord({
        journalKey: key,
        entry,
        pageExists: base.pageExists,
        pageScope: inspected.pageScope,
        relationState: base.relationState,
        syntheticMarker,
        testArtifactMarker,
        archived: inspected.evidence?.archived === true,
        inTrash: inspected.evidence?.inTrash === true || inspected.evidence?.in_trash === true,
      });
      base.evidence = redactSensitive({
        pageScope: inspected.pageScope,
        parentDataSourceId: inspected.evidence?.parentDataSourceId ?? null,
        syntheticMarker,
        testArtifactMarker,
        archived: inspected.evidence?.archived ?? null,
        inTrash: inspected.evidence?.inTrash ?? inspected.evidence?.in_trash ?? null,
        in_trash: inspected.evidence?.in_trash ?? inspected.evidence?.inTrash ?? null,
      }, secrets);
      if (base.classification === 'unresolved') {
        base.blockingReason = inspected.pageScope !== 'verified'
          ? 'page-scope-unverified'
          : inspected.evidence?.archived === true || inspected.evidence?.inTrash === true || inspected.evidence?.in_trash === true
            ? 'page-archived-or-in-trash'
            : base.relationState?.status !== 'verified'
              ? 'relation-membership-unverified'
              : 'classification-unresolved';
      }
    } catch (error) {
      base.pageExists = error?.status === 404 ? false : null;
      base.classification = classifyJournalRecord({ journalKey: key, entry, pageExists: base.pageExists, accessError: error });
      base.blockingReason = base.pageExists === false ? 'page-not-found' : 'page-read-failed';
      base.evidence = redactSensitive({ reason: base.pageExists === false ? 'page-not-found' : 'page-read-failed', error: structuredError(error) }, secrets);
    }
    base.phase4Blocked = ['unresolved', 'malformed-record'].includes(base.classification);
    base.blockingReason ??= base.phase4Blocked ? `classification-${base.classification}` : null;
    audited.push(base);
  }

  const counts = auditCounts(audited);
  return redactSensitive({
    schemaVersion: 'LaunchpadV5JournalAuditReceiptV1',
    auditedAt: now(),
    journal: { version: journal.state.version, entryCount: audited.length, recoveryCount: audited.filter(({ journalState }) => ['pending', 'verified'].includes(journalState)).length },
    entries: audited,
    counts: { total: audited.length, ...counts },
    unresolved: audited.filter(({ classification }) => classification === 'unresolved').map(({ key, journalState, evidence, blockingReason }) => ({ key, journalState, evidence, blockingReason })),
    phase4: {
      blocked: audited.some(({ phase4Blocked }) => phase4Blocked),
      blockingCount: audited.filter(({ phase4Blocked }) => phase4Blocked).length,
      blockingReasons: audited.filter(({ phase4Blocked }) => phase4Blocked).map(({ key, journalState, classification, blockingReason }) => ({ key, journalState, classification, reason: blockingReason })),
    },
  }, secrets);
}

function nowIso(now) { return new Date(typeof now === 'function' ? now() : now ?? Date.now()).toISOString(); }

export class FileTransactionJournal {
  constructor({ journalPath, now = () => Date.now(), repositoryRoot = REPOSITORY_ROOT, requireExisting = false } = {}) {
    this.path = ensureExternalJournalPath(journalPath, repositoryRoot, requireExisting);
    this.now = now;
    this.requireExisting = Boolean(requireExisting);
    this.state = this.#read();
  }

  #read() {
    if (!existsSync(this.path)) {
      if (this.requireExisting) throw new NotionV5TransactionError('transaction journal must already exist for audit', null, 'JOURNAL_REQUIRED');
      return { version: JOURNAL_VERSION, entries: {} };
    }
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

function transactionResult({ status, newlyCommitted = [], alreadyCommitted = [], failed = [], recovery = [], requestedKeys = [] }) {
  const delivered = new Set([...newlyCommitted, ...alreadyCommitted]);
  return {
    status,
    newlyCommitted,
    alreadyCommitted,
    failed,
    recovery,
    deliveredKeys: requestedKeys.filter((key) => delivered.has(key)),
  };
}

function keyFromCommittedRow(row, keyOf) {
  if (typeof row === 'string' || typeof row === 'number') return String(row);
  if (row?.key != null) return String(row.key);
  return String(keyOf(row?.item ?? row));
}

function assertExactCommitKeys(committedRows, verifiedRows, keyOf) {
  if (!Array.isArray(committedRows)) {
    throw new NotionV5TransactionError('commit must return an array of committed rows or keys', null, 'COMMIT_KEYS_INVALID');
  }
  const expected = verifiedRows.map(({ item }) => String(keyOf(item)));
  const actual = committedRows.map((row) => keyFromCommittedRow(row, keyOf));
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const valid = actual.length === expected.length
    && actualSet.size === actual.length
    && actual.every((key) => expectedSet.has(key))
    && expected.every((key) => actualSet.has(key));
  if (!valid) {
    throw new NotionV5TransactionError('committed keys must exactly equal verified keys', { expected, actual }, 'COMMIT_KEYS_MISMATCH');
  }
  return actual;
}

export async function runReservedBatch({ items, reserve, write, verify, commit, abort, journal = null, keyOf = (item) => item.dedupKey ?? item.idempotencyKey ?? JSON.stringify(item) }) {
  if (!Array.isArray(items)) throw new NotionV5TransactionError('transaction items must be an array');
  for (const callback of [reserve, write, verify, commit, abort]) {
    if (typeof callback !== 'function') throw new NotionV5TransactionError('reserve, write, verify, commit, and abort callbacks are required');
  }
  const unique = [];
  const requestedKeys = [];
  const seen = new Set();
  for (const item of items) {
    const key = String(keyOf(item));
    if (seen.has(key)) continue;
    seen.add(key);
    requestedKeys.push(key);
    unique.push(item);
  }
  if (!unique.length) return transactionResult({ status: 'noop' });

  let journalReservation = { reserved: [], committedKeys: [], pendingKeys: [], verifiedKeys: [] };
  try {
    if (journal) journalReservation = await journal.reserve(unique.map((item) => ({ key: keyOf(item), target: item.resource ?? item.target ?? null })));
  } catch (error) {
    return transactionResult({ status: 'aborted', failed: [{ key: null, error: structuredError(error) }], requestedKeys });
  }

  let reservation;
  try {
    const recoverableKeys = new Set([...(journalReservation.pendingKeys ?? []), ...(journalReservation.verifiedKeys ?? [])].map(String));
    reservation = await reserve(unique.filter((item) => !recoverableKeys.has(String(keyOf(item)))), journalReservation);
  } catch (error) {
    if (journal) {
      for (const item of unique.filter((candidate) => journalReservation.reserved.includes(String(keyOf(candidate))))) journal.markAborted(keyOf(item), error);
    }
    return transactionResult({ status: 'aborted', failed: [{ key: null, error: structuredError(error) }], requestedKeys });
  }

  const alreadyCommitted = [...new Set([
    ...(journalReservation.committedKeys ?? []),
    ...((reservation?.committedKeys ?? []).map(String)),
  ].map(String))].filter((key) => seen.has(key));
  const recoveryKeys = [...new Set([
    ...(journalReservation.pendingKeys ?? []),
    ...(journalReservation.verifiedKeys ?? []),
  ].map(String))].filter((key) => seen.has(key));
  const committedSet = new Set(alreadyCommitted);
  const recoverySet = new Set(recoveryKeys);
  const recovery = recoveryKeys.map((key) => ({ key, state: journal?.get(key)?.state ?? 'unknown' }));
  const verified = [];
  const failed = [];

  for (const item of unique) {
    const key = String(keyOf(item));
    if (committedSet.has(key) || recoverySet.has(key)) continue;
    try {
      const result = await write(item, reservation);
      if (journal) journal.recordTarget(key, result);
      const verification = await verify(item, result, reservation);
      if (verification !== true && verification?.verified !== true) throw new NotionV5TransactionError('verification did not confirm the written row');
      if (journal) journal.markVerified(key);
      verified.push({ item, result, verification });
    } catch (error) {
      const failure = { key, error: structuredError(error) };
      failed.push(failure);
      if (journal) journal.markAborted(key, error);
      try { await abort([item], error, reservation); } catch (abortError) { failure.abortError = structuredError(abortError); }
    }
  }

  let newlyCommitted = [];
  if (verified.length) {
    try {
      const committedRows = await commit(verified, reservation) ?? verified;
      newlyCommitted = assertExactCommitKeys(committedRows, verified, keyOf);
      if (journal) for (const key of newlyCommitted) journal.markCommitted(key);
    } catch (error) {
      const failure = { key: null, error: structuredError(error) };
      failed.push(failure);
      if (journal) for (const { item } of verified) journal.markAborted(keyOf(item), error);
      try { await abort(verified.map(({ item }) => item), error, reservation); } catch (abortError) { failure.abortError = structuredError(abortError); }
      newlyCommitted = [];
    }
  }

  let status;
  if (alreadyCommitted.length === requestedKeys.length) status = 'replayed';
  else if (recovery.length && !newlyCommitted.length) status = 'recovery';
  else if (newlyCommitted.length && (failed.length || recovery.length)) status = 'partial';
  else if (failed.length) status = 'aborted';
  else status = 'committed';
  return transactionResult({ status, newlyCommitted, alreadyCommitted, failed, recovery, requestedKeys });
}
