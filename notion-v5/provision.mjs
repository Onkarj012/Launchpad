import { assertLiveManifest, assertValidManifest, isLegacyNotionId, isNotionIdentifier, isPlaceholderIdentifier, loadManifest } from './manifest.mjs';
import { assertValidViewDefinitions, V5_SCHEMA, V5_STORE_KEYS, V5_VIEW_DEFINITIONS } from './schema.mjs';
import { createNotionV5Gateway, NotionV5Error } from './gateway.mjs';
import { createTransactionJournal, structuredError } from './transaction.mjs';

const STORE_ORDER = Object.freeze(['companies', ...V5_STORE_KEYS.filter((key) => key !== 'companies')]);

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function viewInventoryValid(inventory) {
  if (!Array.isArray(inventory)) return false;
  return V5_VIEW_DEFINITIONS.every((definition) => inventory.some((candidate) => candidate?.name === definition.name && candidate?.store === definition.store && same(candidate.filter, definition.filter)));
}

function expectedRelations() {
  return V5_STORE_KEYS.flatMap((storeKey) => Object.values(V5_SCHEMA.stores[storeKey].properties).filter((property) => property.type === 'relation').map((property) => ({ from: storeKey, to: property.target, reciprocal: property.reciprocal })));
}

function relationsValid(inventory) {
  if (!Array.isArray(inventory)) return false;
  return expectedRelations().every((expected) => inventory.some((candidate) => candidate?.from === expected.from && candidate?.to === expected.to && candidate?.reciprocal === expected.reciprocal));
}

function storesValid(created, inventory) {
  if (!Array.isArray(inventory) || created.length !== V5_STORE_KEYS.length) return false;
  return V5_STORE_KEYS.every((storeKey) => {
    const actual = created.find((entry) => entry.storeKey === storeKey);
    const verified = inventory.find((entry) => entry.storeKey === storeKey);
    return actual && verified && verified.databaseId === actual.databaseId && verified.dataSourceId === actual.dataSourceId;
  });
}

function resultBase(status, reason) { return { status, live: false, reason, created: [], views: { status: 'not-attempted', required: V5_VIEW_DEFINITIONS } }; }

export async function provisionV5({ manifest = loadManifest(), credentialFile = null, enabled = false, gateway = null, parentId = manifest.parent.id, journalPath = null, journal = null, verifiedState = null } = {}) {
  assertValidViewDefinitions();
  assertValidManifest(manifest);
  if (!enabled) return resultBase('disabled', 'pass enabled: true for explicitly authorized provisioning');
  if (isPlaceholderIdentifier(parentId) || !isNotionIdentifier(parentId) || isLegacyNotionId(parentId)) return { ...resultBase('blocked', 'a real authorized v5 parent page id is required; no network request was made'), code: 'PARENT_REQUIRED' };
  let client = gateway;
  const injectedGateway = Boolean(client);
  if (!client) {
    if (!credentialFile) return { ...resultBase('blocked', 'external credential file is required; no network request was made'), code: 'CREDENTIAL_REQUIRED' };
    if (!journalPath) return { ...resultBase('blocked', 'explicit external journal path is required; no network request was made'), code: 'JOURNAL_PATH_REQUIRED' };
    client = createNotionV5Gateway({ manifest, credentialFile, live: true, provisioning: true, authorizedParentId: parentId, journalPath });
  }
  const durableJournal = journal ?? (injectedGateway ? null : createTransactionJournal({ journalPath }));
  if (durableJournal && client) client.journal = durableJournal;
  const created = [];
  const journalKeys = [];
  const ids = {};
  try {
    for (const storeKey of STORE_ORDER) {
      const key = `provision:${parentId}:${storeKey}`;
      journalKeys.push(key);
      const reservation = durableJournal?.reserve([{ key, target: storeKey }]);
      if (reservation?.committedKeys?.includes(key)) {
        const entry = durableJournal.get(key);
        if (!entry?.targetId || !entry?.dataSourceId) throw new NotionV5Error('committed provisioning journal entry lacks recovery identifiers', { code: 'JOURNAL_INVALID', stage: 'provision' });
        ids[storeKey] = { databaseId: entry.targetId, dataSourceId: entry.dataSourceId };
        created.push({ storeKey, databaseId: entry.targetId, dataSourceId: entry.dataSourceId, recovered: true });
        continue;
      }
      if (reservation?.pendingKeys?.includes(key) || reservation?.verifiedKeys?.includes(key)) return { status: 'blocked', live: Boolean(client.live), reason: 'provisioning has a pending journal entry requiring explicit recovery', code: 'JOURNAL_RECOVERY_REQUIRED', created, recovery: { journalKeys, pendingKey: key, cleanupRequired: created.length > 0, rollbackPerformed: false }, views: { status: 'not-attempted', required: V5_VIEW_DEFINITIONS } };
      if (durableJournal) { client.activeJournal = durableJournal; client.activeTransactionKey = key; }
      let response;
      try { response = await client.createDatabase(storeKey, { parentId, includeRelations: false, relationIds: {} }); }
      finally { if (durableJournal) { client.activeJournal = null; client.activeTransactionKey = null; } }
      const databaseId = response?.databaseId ?? response?.id;
      const dataSourceId = response?.dataSourceId;
      if (!databaseId || !dataSourceId || !isNotionIdentifier(databaseId) || !isNotionIdentifier(dataSourceId) || isLegacyNotionId(databaseId) || isLegacyNotionId(dataSourceId)) throw new NotionV5Error(`provisioned ${storeKey} response omitted valid v5 identifiers`, { code: 'RESPONSE_INVALID', stage: 'provision' });
      ids[storeKey] = { databaseId, dataSourceId };
      created.push({ storeKey, databaseId, dataSourceId });
      if (durableJournal) durableJournal.recordTarget(key, { targetId: databaseId, dataSourceId });
    }
    const relationIds = Object.fromEntries(V5_STORE_KEYS.map((key) => [key, ids[key].dataSourceId]));
    for (const storeKey of V5_STORE_KEYS) {
      const key = `provision:${parentId}:${storeKey}`;
      if (durableJournal) { client.activeJournal = durableJournal; client.activeTransactionKey = key; }
      try {
        if (typeof client.updateDataSourceRelations === 'function') await client.updateDataSourceRelations(storeKey, ids[storeKey].dataSourceId, relationIds);
        else if (typeof client.updateDatabaseRelations === 'function') await client.updateDatabaseRelations(storeKey, ids[storeKey].databaseId, relationIds);
        else throw new NotionV5Error('gateway cannot update data-source relations', { code: 'RELATION_UPDATE_UNAVAILABLE', stage: 'provision' });
      } finally { if (durableJournal) { client.activeJournal = null; client.activeTransactionKey = null; } }
    }
    if (durableJournal) for (const key of journalKeys) durableJournal.markVerified(key);
    if (durableJournal) for (const key of journalKeys) durableJournal.markCommitted(key);
    const manifestPatch = { parent: { type: 'page_id', id: parentId }, targets: Object.fromEntries(V5_STORE_KEYS.map((key) => [key, { name: manifest.targets[key].name, databaseId: ids[key].databaseId, dataSourceId: ids[key].dataSourceId }])) };
    const viewsVerified = viewInventoryValid(verifiedState?.views);
    const storesVerified = storesValid(created, verifiedState?.stores);
    const relationsVerified = relationsValid(verifiedState?.relations);
    const manifestVerified = verifiedState?.manifest === true;
    const complete = viewsVerified && storesVerified && relationsVerified && manifestVerified;
    return {
      status: complete ? 'complete' : 'incomplete', live: Boolean(client.live), created, manifestPatch,
      verification: { stores: storesVerified, relations: relationsVerified, manifest: manifestVerified, views: viewsVerified },
      views: { status: viewsVerified ? 'verified' : 'manual-required', required: V5_VIEW_DEFINITIONS, verified: verifiedState?.views ?? [] },
      reason: complete ? 'all five stores, reciprocal relations, manifest identifiers, and required views were explicitly verified' : 'live provisioning is incomplete until stores, reciprocal relations, manifest identifiers, and all required views are verified',
    };
  } catch (error) {
    if (durableJournal) for (const key of journalKeys) if (durableJournal.get(key)?.state === 'pending' || durableJournal.get(key)?.state === 'verified') durableJournal.markAborted(key, error);
    return { status: 'blocked', live: Boolean(client.live), created, reason: error.message, error: structuredError(error), recovery: { journalKeys, cleanupRequired: created.length > 0, rollbackPerformed: false, createdObjects: created, action: 'manually reconcile or explicitly clean up these created v5 objects; no rollback was performed' }, views: { status: 'not-attempted', required: V5_VIEW_DEFINITIONS } };
  }
}

export async function smokeV5({ manifest = loadManifest(), credentialFile = null, enabled = false, gateway = null, journalPath = null, journal = null, company = { name: 'Launchpad v5 synthetic company', canonicalDomain: 'synthetic.launchpad-v5.invalid' }, application = { Role: 'Synthetic AI Engineer', Company: 'Launchpad v5 synthetic company', 'Application Ready': true }, transaction = {}, runId = application?.['Run ID'] ?? transaction?.runId ?? null } = {}) {
  const preflight = provisioningPreflight({ manifest, enabled, credentialFile, journalPath, injectedGateway: Boolean(gateway), runId });
  if (!preflight.ok) return { status: 'blocked', live: false, ...preflight };
  const dedupKey = String(runId);
  const payload = { ...application, 'Run ID': runId, 'Dedup Key': dedupKey };
  const client = gateway ?? createNotionV5Gateway({ manifest, credentialFile, live: true, journalPath, journal });
  const result = await client.writeApplications([{ operation: 'create', resource: 'application', dedupKey, payload, company }], { ...transaction, journalPath, journal, keyOf: transaction.keyOf ?? (() => dedupKey) });
  const freshCommit = result.status === 'committed'
    && result.committed?.length === 1
    && result.verified?.length === 1
    && result.failed?.length === 0
    && result.recovery?.length === 0
    && result.skipped?.length === 0;
  return { status: freshCommit ? 'passed' : result.status === 'noop' ? 'blocked' : 'failed', live: Boolean(client.live), runId, dedupKey, result };
}

export function provisioningPreflight({ manifest, enabled = false, credentialFile = null, journalPath = null, injectedGateway = false, runId = null } = {}) {
  if (!enabled) return { ok: false, code: 'LIVE_OPT_IN_REQUIRED', reason: 'enabled: true is required' };
  if (!runId || !String(runId).trim()) return { ok: false, code: 'SMOKE_RUN_ID_REQUIRED', reason: 'a unique smoke run ID is required' };
  if (!injectedGateway && !credentialFile) return { ok: false, code: 'CREDENTIAL_REQUIRED', reason: 'external credential file is required' };
  if (!injectedGateway && !journalPath) return { ok: false, code: 'JOURNAL_PATH_REQUIRED', reason: 'explicit external journal path is required' };
  if (isPlaceholderIdentifier(manifest?.parent?.id) || !isNotionIdentifier(manifest?.parent?.id) || isLegacyNotionId(manifest?.parent?.id)) return { ok: false, code: 'PARENT_REQUIRED', reason: 'real authorized v5 parent page id is required' };
  return { ok: true };
}

export { assertLiveManifest };
