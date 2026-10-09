import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedPropertyKeys, V5_SCHEMA, V5_STORE_KEYS, V5_STORE_NAMES } from './schema.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_V5_MANIFEST_PATH = path.resolve(MODULE_DIR, '../config/notion-v5.manifest.json');
export const NOTION_V5_MANIFEST_VERSION = 'LaunchpadV5ManifestV2';

export class NotionV5ManifestError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'NotionV5ManifestError';
    this.code = 'INVALID_MANIFEST';
    this.details = details;
  }
}

// Exact IDs copied from repository-local v3/v4 audit records. These are scope
// identifiers, not credentials. Normalization makes hyphenated and compact
// spellings deny the same object independently of its display name.
export const LEGACY_NOTION_ID_DENYLIST = Object.freeze({
  pageIds: Object.freeze([
    Object.freeze({ id: '3885c2b5d1b081458df2c68954540105', label: 'audited Job Search parent used by legacy tracker' }),
    Object.freeze({ id: 'd7db471ca1fb4686868b4ca4c9f56824', label: 'audited Applications v4 database page' }),
    Object.freeze({ id: 'abe8d58130844fd480c24b4edb285dee', label: 'audited Activity v4 database page' }),
    Object.freeze({ id: 'c72c4997616745428d28e7340336d32d', label: 'audited Referrals v4 database page' }),
  ]),
  databaseIds: Object.freeze([
    Object.freeze({ id: 'd7db471ca1fb4686868b4ca4c9f56824', label: 'audited Applications v4 database page' }),
    Object.freeze({ id: 'abe8d58130844fd480c24b4edb285dee', label: 'audited Activity v4 database page' }),
    Object.freeze({ id: 'c72c4997616745428d28e7340336d32d', label: 'audited Referrals v4 database page' }),
  ]),
  dataSourceIds: Object.freeze([
    Object.freeze({ id: 'd8d525b0e43644b7ae6528c08a358684', label: 'audited Applications v3 data source' }),
    Object.freeze({ id: '7bc3de3a91d943918b229e68b264e8d2', label: 'audited Applications v4 data source' }),
    Object.freeze({ id: '9cb287301c2e4e81bb544cb1ac4b3a1d', label: 'audited Companies v4 data source' }),
    Object.freeze({ id: 'bf40caf68b074c559d21787b8033f454', label: 'audited Outreach v4 data source' }),
    Object.freeze({ id: '76a31defa14545db9b820c263b80ab1b', label: 'audited Activity v4 data source' }),
    Object.freeze({ id: '346c1a1538084e4abcb78d24f0ea597a', label: 'audited Referrals v4 data source' }),
  ]),
});

// No IDs are fabricated for audited categories absent from local evidence.
// Unknown IDs remain denied by the v5 scope gate even when these gaps exist.
export const LEGACY_NOTION_AUDIT_GAPS = Object.freeze([
  'v3_database_page_ids_not_recorded',
  'v3_companies_and_outreach_data_source_ids_not_recorded',
  'v4_companies_database_page_id_not_recorded',
  'v4_outreach_database_page_id_not_recorded',
]);

const LEGACY_ID_SET = new Set(Object.values(LEGACY_NOTION_ID_DENYLIST).flat().map(({ id }) => id));

export function normalizeNotionId(value) {
  return String(value ?? '').trim().toLowerCase().replaceAll('-', '');
}

export function isLegacyNotionId(value) {
  return LEGACY_ID_SET.has(normalizeNotionId(value));
}

export function isPlaceholderIdentifier(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return !normalized || normalized.includes('placeholder') || normalized.includes('not_configured') || normalized.includes('replace_me') || normalized.includes('todo') || /^0+$/.test(normalized.replaceAll('-', ''));
}

export function isNotionIdentifier(value) {
  return /^[0-9a-f]{32}$/i.test(normalizeNotionId(value));
}

function isLegacyTarget(value) {
  return /(?:^|[-_ ])(?:v3|v4|legacy|archive)(?:$|[-_ ])/i.test(String(value ?? ''));
}

function expectedContracts() {
  return Object.fromEntries(V5_STORE_KEYS.map((key) => [key, expectedPropertyKeys(key)]));
}

function expectedRelationInventory(manifest) {
  const dataSourceIds = Object.fromEntries(V5_STORE_KEYS.map((key) => [key, manifest.targets?.[key]?.dataSourceId]));
  return V5_STORE_KEYS.flatMap((storeKey) => Object.values(V5_SCHEMA.stores[storeKey].properties)
    .filter((property) => property.type === 'relation')
    .map((property) => ({
      from: `${storeKey}.${property.name}`,
      to: property.target,
      fromDataSourceId: dataSourceIds[storeKey],
      toDataSourceId: dataSourceIds[property.target],
      verified: true,
    })));
}

function relationMatches(actual, expected) {
  const fields = ['from', 'to', 'fromDataSourceId', 'toDataSourceId'];
  return actual && typeof actual === 'object' && !Array.isArray(actual)
    && Object.keys(actual).length === fields.length + 1
    && fields.every((field) => typeof actual[field] === 'string' && actual[field] === expected[field])
    && actual.verified === true;
}

function validateRelations(manifest) {
  if (!Array.isArray(manifest.relations)) return ['relations must be an array'];
  const expected = expectedRelationInventory(manifest);
  const errors = [];
  for (const relation of expected) {
    const matches = manifest.relations.filter((candidate) => relationMatches(candidate, relation)).length;
    if (matches === 0) errors.push(`missing relation ${relation.from}`);
    if (matches > 1) errors.push(`duplicate relation ${relation.from}`);
  }
  const unexpected = manifest.relations.filter((candidate) => !expected.some((relation) => relationMatches(candidate, relation)));
  if (unexpected.length > 0) errors.push(`unexpected relation entry count ${unexpected.length}`);
  return errors;
}

function targetIdentifierErrors(key, target) {
  const errors = [];
  for (const field of ['databaseId', 'dataSourceId']) {
    if (typeof target?.[field] !== 'string' || !target[field].trim()) errors.push(`${key} target ${field} is required`);
    if (isLegacyNotionId(target?.[field])) errors.push(`${key} target ${field} is an audited legacy identifier`);
  }
  return errors;
}

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { valid: false, errors: ['manifest must be an object'] };
  if (manifest.schemaVersion !== NOTION_V5_MANIFEST_VERSION) errors.push(`schemaVersion must be ${NOTION_V5_MANIFEST_VERSION}`);
  if (manifest.parent?.type !== 'page_id' || typeof manifest.parent?.id !== 'string') errors.push('parent must contain type page_id and id');
  if (isLegacyNotionId(manifest.parent?.id)) errors.push('audited legacy parent id is refused');
  if (isLegacyTarget(manifest.parent?.id)) errors.push('legacy parent targets are refused');
  const targets = manifest.targets;
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) errors.push('targets must be an object');
  else {
    const actualKeys = Object.keys(targets).sort();
    const requiredKeys = [...V5_STORE_KEYS].sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(requiredKeys)) errors.push(`targets must contain exactly ${requiredKeys.join(', ')}`);
    for (const key of actualKeys) {
      const target = targets[key];
      if (!V5_STORE_KEYS.includes(key)) { errors.push(`undeclared v5 target ${key}`); continue; }
      if (target?.name !== V5_STORE_NAMES[key]) errors.push(`${key} target name must be ${V5_STORE_NAMES[key]}`);
      errors.push(...targetIdentifierErrors(key, target));
      if (isLegacyTarget(target?.name) || isLegacyTarget(target?.databaseId) || isLegacyTarget(target?.dataSourceId)) errors.push(`${key} legacy target is refused`);
    }
  }
  const expected = expectedContracts();
  if (!manifest.expectedPropertyContracts || typeof manifest.expectedPropertyContracts !== 'object') errors.push('expectedPropertyContracts is required');
  else for (const key of V5_STORE_KEYS) {
    const received = manifest.expectedPropertyContracts[key];
    if (!Array.isArray(received) || JSON.stringify([...received].sort()) !== JSON.stringify([...expected[key]].sort())) errors.push(`${key} property contract does not match v5 schema`);
  }
  errors.push(...validateRelations(manifest));
  if (!Array.isArray(manifest.viewNames) || manifest.viewNames.length === 0) errors.push('viewNames must be a non-empty array');
  if (!Array.isArray(manifest.legacyAuditGaps)) errors.push('legacyAuditGaps must be an array');
  return { valid: errors.length === 0, errors };
}

export function assertValidManifest(manifest) {
  const result = validateManifest(manifest);
  if (!result.valid) throw new NotionV5ManifestError(result.errors.join('; '), result.errors);
  return manifest;
}

export function assertLiveManifest(manifest) {
  assertValidManifest(manifest);
  if (isPlaceholderIdentifier(manifest.parent.id) || !isNotionIdentifier(manifest.parent.id) || isLegacyNotionId(manifest.parent.id)) throw new NotionV5ManifestError('live v5 operations require a real authorized v5 parent page id');
  for (const key of V5_STORE_KEYS) {
    const target = manifest.targets[key];
    for (const field of ['databaseId', 'dataSourceId']) if (isPlaceholderIdentifier(target[field]) || !isNotionIdentifier(target[field]) || isLegacyNotionId(target[field])) throw new NotionV5ManifestError(`live v5 operations require a real authorized v5 ${key} ${field}`);
  }
  return manifest;
}

export function loadManifest(manifestPath = DEFAULT_V5_MANIFEST_PATH) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (error) { throw new NotionV5ManifestError(`unable to read v5 manifest: ${error.message}`); }
  return assertValidManifest(parsed);
}

export function targetFor(manifest, target) {
  assertValidManifest(manifest);
  const key = V5_STORE_KEYS.includes(target) ? target : V5_STORE_KEYS.find((candidate) => V5_STORE_NAMES[candidate] === target);
  if (!key) throw new NotionV5ManifestError(`unknown or undeclared v5 target: ${target}`);
  const value = manifest.targets[key];
  if (isPlaceholderIdentifier(value.databaseId) || isPlaceholderIdentifier(value.dataSourceId)) throw new NotionV5ManifestError(`${key} target is not configured; refusing network access`);
  if (isLegacyNotionId(value.databaseId) || isLegacyNotionId(value.dataSourceId)) throw new NotionV5ManifestError(`${key} target is an audited legacy identifier`);
  if (!isNotionIdentifier(value.databaseId) || !isNotionIdentifier(value.dataSourceId)) throw new NotionV5ManifestError(`${key} target identifiers are invalid; refusing network access`);
  return { key, ...value };
}

export function createManifestTemplate() {
  return {
    schemaVersion: NOTION_V5_MANIFEST_VERSION,
    parent: { type: 'page_id', id: 'PLACEHOLDER_LAUNCHPAD_V5_PARENT' },
    targets: Object.fromEntries(V5_STORE_KEYS.map((key) => [key, { name: V5_STORE_NAMES[key], databaseId: `PLACEHOLDER_${key.toUpperCase()}_V5_DATABASE`, dataSourceId: `PLACEHOLDER_${key.toUpperCase()}_V5_DATA_SOURCE` }])),
    expectedPropertyContracts: expectedContracts(),
    relations: expectedRelationInventory({ targets: Object.fromEntries(V5_STORE_KEYS.map((key) => [key, { dataSourceId: `PLACEHOLDER_${key.toUpperCase()}_V5_DATA_SOURCE` }])) }),
    viewNames: ['Ready', 'Fallback', 'Internship', 'Startup', 'Remote', 'Verification', 'Resume', 'Applied', 'Outreach', 'Follow-up', 'Pipeline', 'Archive'],
    legacyAuditGaps: [...LEGACY_NOTION_AUDIT_GAPS],
  };
}

export function manifestSummary(manifest) {
  assertValidManifest(manifest);
  return {
    schemaVersion: manifest.schemaVersion,
    parentConfigured: !isPlaceholderIdentifier(manifest.parent.id),
    targets: Object.fromEntries(V5_STORE_KEYS.map((key) => [key, { databaseConfigured: !isPlaceholderIdentifier(manifest.targets[key].databaseId), dataSourceConfigured: !isPlaceholderIdentifier(manifest.targets[key].dataSourceId) }])),
    legacyAuditGaps: [...manifest.legacyAuditGaps],
  };
}

export { V5_SCHEMA };
