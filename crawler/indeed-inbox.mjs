import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeCandidate } from '../job-pull/candidate.mjs';

export const INDEED_CONNECTOR_SCHEMA_VERSION = 'IndeedConnectorV1';
export const INDEED_INBOX_MANIFEST_VERSION = 'IndeedInboxManifestV1';

const AGGREGATOR_HOST = /(?:^|\.)indeed\.(?:com|co\.[a-z]{2,3}|[a-z]{2})$/i;
const ATS_HOST = /(?:greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workable\.com|smartrecruiters\.com|breezy\.hr|recruitee\.com)$/i;
const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const isoNow = (clock) => {
  const value = typeof clock?.now === 'function' ? clock.now() : new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporary, file);
}

function safeQuarantine(file, quarantineDir) {
  fs.mkdirSync(quarantineDir, { recursive: true });
  const destination = path.join(quarantineDir, `${path.basename(file)}.${Date.now()}.quarantine`);
  fs.renameSync(file, destination);
  return destination;
}

function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }

function filesFor({ inboxDir, date, file }) {
  if (file) return [path.resolve(file)];
  if (!inboxDir) throw new TypeError('inboxDir or file is required');
  const root = path.resolve(inboxDir);
  const dated = path.join(root, date);
  const usesDatedDirectory = fs.existsSync(dated) && fs.statSync(dated).isDirectory();
  const directory = usesDatedDirectory ? dated : root;
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && (usesDatedDirectory || !date || entry.name.startsWith(date)))
    .map((entry) => path.join(directory, entry.name)).sort();
}

function directOriginal(url) {
  try {
    const parsed = new URL(url);
    return !AGGREGATOR_HOST.test(parsed.hostname) && (ATS_HOST.test(parsed.hostname) || /(?:career|careers|jobs|join-us|work-with-us|opportunit)/i.test(parsed.pathname));
  } catch { return false; }
}

function recordError(record, index) {
  const errors = [];
  if (!isObject(record)) errors.push('record must be an object');
  else {
    for (const field of ['jobId', 'title', 'company', 'url']) if (!clean(record[field] ?? record[`${field}Url`])) errors.push(`${field} is required`);
    if (record.postedAt != null && Number.isNaN(Date.parse(String(record.postedAt)))) errors.push('postedAt must be a valid date');
  }
  return errors.length ? { index, errors } : null;
}

async function resolveObservation(observation, resolver) {
  if (typeof resolver !== 'function') return observation;
  const resolved = await resolver(observation);
  const url = clean(typeof resolved === 'string' ? resolved : resolved?.url ?? resolved?.originalApplicationUrl);
  if (!url) return observation;
  const company = clean(typeof resolved === 'object' ? resolved.company : null) || observation.company;
  const evidence = typeof resolved === 'object' ? resolved.evidence ?? 'injected-original-employer-resolver' : 'injected-original-employer-resolver';
  return {
    ...observation,
    company,
    originalApplicationUrl: url,
    applicationResolution: { status: 'Resolved Original', evidence },
    classification: directOriginal(url) ? 'direct' : 'lead',
    evidence: { ...observation.evidence, originalEmployer: 'promoted', resolver: 'injected', resolverEvidence: evidence },
  };
}

function receiptPath(receiptDir, digest) { return path.join(receiptDir, `${digest}.json`); }

/** Import connector-exported Indeed JSON. This function never performs network I/O. */
export async function importIndeedInbox({ inboxDir, file, date, receiptDir, quarantineDir, resolveOriginalEmployer, resolver, clock, beforeCommit } = {}) {
  const root = path.resolve(inboxDir || path.dirname(path.resolve(file)));
  const receiptsDir = path.resolve(receiptDir || path.join(root, '.receipts'));
  const quarantinedDir = path.resolve(quarantineDir || path.join(root, 'quarantine'));
  const observations = [];
  const receipts = [];
  let imported = 0; let duplicates = 0; let quarantined = 0;
  const runAt = isoNow(clock);
  fs.mkdirSync(receiptsDir, { recursive: true });
  for (const sourceFile of filesFor({ inboxDir: root, date, file })) {
    const raw = fs.readFileSync(sourceFile);
    const digest = sha256(raw);
    const committedReceipt = receiptPath(receiptsDir, digest);
    if (fs.existsSync(committedReceipt)) {
      const receipt = JSON.parse(fs.readFileSync(committedReceipt, 'utf8'));
      receipts.push({ ...receipt, status: 'duplicate' }); duplicates += 1; continue;
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); }
    catch (error) {
      const movedTo = safeQuarantine(sourceFile, quarantinedDir);
      const receipt = { schemaVersion: INDEED_INBOX_MANIFEST_VERSION, file: sourceFile, digest, status: 'quarantined', error: `Malformed JSON: ${error.message}`, quarantinedTo: movedTo, imported: 0, quarantinedRecords: 0, importedAt: runAt };
      atomicWrite(committedReceipt, json(receipt)); receipts.push(receipt); quarantined += 1; continue;
    }
    if (payload?.schemaVersion !== INDEED_CONNECTOR_SCHEMA_VERSION || !Array.isArray(payload.records)) {
      const movedTo = safeQuarantine(sourceFile, quarantinedDir);
      const receipt = { schemaVersion: INDEED_INBOX_MANIFEST_VERSION, file: sourceFile, digest, status: 'quarantined', error: 'Payload must contain schemaVersion IndeedConnectorV1 and records array', quarantinedTo: movedTo, imported: 0, quarantinedRecords: 0, importedAt: runAt };
      atomicWrite(committedReceipt, json(receipt)); receipts.push(receipt); quarantined += 1; continue;
    }
    const valid = []; const invalid = [];
    for (const [index, record] of payload.records.entries()) {
      const issue = recordError(record, index);
      if (issue) invalid.push({ record, ...issue }); else valid.push(record);
    }
    for (const issue of invalid) {
      const partialFile = path.join(quarantinedDir, `${path.basename(sourceFile)}.record-${issue.index}.json`);
      atomicWrite(partialFile, json({ schemaVersion: INDEED_CONNECTOR_SCHEMA_VERSION, record: issue.record, errors: issue.errors }));
      quarantined += 1;
    }
    const resolved = [];
    for (const record of valid) {
      const candidate = normalizeCandidate({ ...record, source: 'indeed', provider: 'indeed', sourceKind: 'aggregator', discoveredAt: record.discoveredAt ?? runAt, crawledAt: record.crawledAt ?? runAt, liveness: record.liveness ?? { status: 'Not Verified', checkedAt: runAt, evidence: 'indeed-connector-inbox' } }, { runAt, provider: 'indeed', source: 'indeed', sourceKind: 'aggregator' });
      resolved.push(await resolveObservation({ ...candidate, providerJobId: candidate.jobId, classification: 'lead', observationKey: sha256(`${digest}:${record.jobId}`), evidence: { sourceFile, connectorSchemaVersion: payload.schemaVersion } }, resolveOriginalEmployer || resolver));
    }
    if (typeof beforeCommit === 'function') await beforeCommit({ file: sourceFile, digest, observations: resolved });
    const receipt = { schemaVersion: INDEED_INBOX_MANIFEST_VERSION, file: sourceFile, digest, status: 'committed', imported: resolved.length, quarantinedRecords: invalid.length, importedAt: runAt };
    atomicWrite(committedReceipt, json(receipt));
    observations.push(...resolved); imported += resolved.length; receipts.push(receipt);
  }
  const status = quarantined && imported ? 'partial' : quarantined ? 'quarantined' : duplicates && !imported ? 'duplicate' : 'imported';
  return { status, imported, duplicates, quarantined, observations, receipts, manifest: { schemaVersion: INDEED_INBOX_MANIFEST_VERSION, sourceId: 'indeed-inbox', runAt, files: receipts.length, telemetry: { imported, duplicates, quarantined, resolverPromotions: observations.filter((row) => row.evidence?.resolver === 'injected').length }, noAutoApply: true, networkUsed: false } };
}

export const importIndeedConnectorInbox = importIndeedInbox;
export default importIndeedInbox;
