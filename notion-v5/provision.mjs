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

const SMOKE_STORE_ORDER = Object.freeze(['companies', 'applications', 'outreach', 'activity']);

function smokeKey(runId, store) { return `smoke:${runId}:${store}`; }
function smokeId(entry) { return entry?.pageId ?? null; }
function smokeSafeValues(values = {}) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !['makeResume', 'applied', 'Make Resume', 'Applied?'].includes(key)));
}

function smokeRelations(ids) {
  return [
    { pageId: ids.applications, store: 'applications', property: 'company', expectedPageId: ids.companies },
    { pageId: ids.companies, store: 'companies', property: 'applications', expectedPageId: ids.applications },
    { pageId: ids.outreach, store: 'outreach', property: 'application', expectedPageId: ids.applications },
    { pageId: ids.applications, store: 'applications', property: 'outreach', expectedPageId: ids.outreach },
    { pageId: ids.activity, store: 'activity', property: 'application', expectedPageId: ids.applications },
    { pageId: ids.applications, store: 'applications', property: 'activity', expectedPageId: ids.activity },
    { pageId: ids.activity, store: 'activity', property: 'outreach', expectedPageId: ids.outreach },
    { pageId: ids.outreach, store: 'outreach', property: 'activity', expectedPageId: ids.activity },
  ];
}

export async function smokeV5({ manifest = loadManifest(), credentialFile = null, enabled = false, gateway = null, journalPath = null, journal = null, company = { name: 'Launchpad v5 synthetic company', canonicalDomain: 'synthetic.launchpad-v5.invalid' }, application = { Role: 'Synthetic AI Engineer', Company: 'Launchpad v5 synthetic company', 'Application Ready': true }, transaction = {}, runId = application?.['Run ID'] ?? transaction?.runId ?? null } = {}) {
  const preflight = provisioningPreflight({ manifest, enabled, credentialFile, journalPath, journal, injectedGateway: Boolean(gateway), runId });
  if (!preflight.ok) return { status: 'blocked', live: false, ...preflight };

  const normalizedRunId = String(runId).trim();
  const keys = Object.fromEntries(SMOKE_STORE_ORDER.map((store) => [store, smokeKey(normalizedRunId, store)]));
  const evidence = {
    created: [], createdIds: [], recovered: [], recoveredIds: [], relationVerificationCount: 0, relationChecks: [], failures: [],
    journal: { outcome: 'not-started', keys: Object.values(keys) }, pendingRecoveryCount: 0,
  };
  const client = gateway ?? createNotionV5Gateway({ manifest, credentialFile, live: true, journalPath, journal });
  const durableJournal = journal ?? createTransactionJournal({ journalPath });
  client.journal = durableJournal;

  let reservation;
  try {
    reservation = durableJournal.reserve(SMOKE_STORE_ORDER.map((store) => ({ key: keys[store], target: store })));
  } catch (error) {
    evidence.failures.push({ stage: 'reserve', error: structuredError(error) });
    return { status: 'failed', live: Boolean(client.live), runId: normalizedRunId, keys, evidence };
  }

  const recoveryKeys = new Set([...(reservation.pendingKeys ?? []), ...(reservation.verifiedKeys ?? [])].map(String));
  if (recoveryKeys.size) {
    for (const key of reservation.reserved ?? []) if (durableJournal.get(key)?.state === 'pending') durableJournal.markAborted(key, new NotionV5Error('smoke run encountered an existing journal recovery entry', { code: 'JOURNAL_RECOVERY_REQUIRED', stage: 'smoke' }));
    evidence.journal.outcome = 'recovery-required';
    evidence.pendingRecoveryCount = durableJournal.recover().length;
    return { status: 'blocked', live: Boolean(client.live), runId: normalizedRunId, code: 'JOURNAL_RECOVERY_REQUIRED', keys, evidence };
  }

  const committedKeys = new Set((reservation.committedKeys ?? []).map(String));
  if (committedKeys.size && committedKeys.size !== SMOKE_STORE_ORDER.length) {
    for (const key of reservation.reserved ?? []) if (durableJournal.get(key)?.state === 'pending') durableJournal.markAborted(key, new NotionV5Error('smoke journal is incomplete and requires explicit recovery', { code: 'JOURNAL_RECOVERY_REQUIRED', stage: 'smoke' }));
    evidence.journal.outcome = 'recovery-required';
    evidence.pendingRecoveryCount = durableJournal.recover().length;
    return { status: 'blocked', live: Boolean(client.live), runId: normalizedRunId, code: 'JOURNAL_RECOVERY_REQUIRED', keys, evidence };
  }

  const ids = {};
  if (committedKeys.size === SMOKE_STORE_ORDER.length) {
    for (const store of SMOKE_STORE_ORDER) {
      const id = smokeId(durableJournal.get(keys[store]));
      if (!id) {
        evidence.failures.push({ stage: 'recovery', error: structuredError(new NotionV5Error('committed smoke journal entry lacks a page id', { code: 'JOURNAL_INVALID', stage: 'smoke', target: store })) });
        evidence.journal.outcome = 'invalid';
        evidence.pendingRecoveryCount = durableJournal.recover().length;
        return { status: 'blocked', live: Boolean(client.live), runId: normalizedRunId, code: 'JOURNAL_INVALID', keys, evidence };
      }
      ids[store] = id;
      evidence.recovered.push({ store, key: keys[store], id });
      evidence.recoveredIds.push(id);
    }
  }

  const runValues = smokeSafeValues(application);
  const companyValues = smokeSafeValues(company);
  const companyName = `${companyValues.name ?? companyValues.Name ?? 'Launchpad v5 synthetic company'} [${normalizedRunId}]`;
  const applicationName = `${runValues.name ?? runValues.Name ?? runValues.Role ?? 'Synthetic AI Engineer'} [${normalizedRunId}]`;
  const values = {
    companies: { ...companyValues, name: companyName, companyKey: keys.companies },
    applications: { ...runValues, name: applicationName, Company: companyName, 'Run ID': normalizedRunId, 'Dedup Key': keys.applications },
    outreach: { name: `Synthetic outreach [${normalizedRunId}]`, application: [ids.applications], duplicateKey: keys.outreach, draftState: 'Prepared' },
    activity: { name: `Synthetic activity [${normalizedRunId}]`, application: [ids.applications], outreach: [ids.outreach], idempotencyKey: keys.activity, eventType: 'Smoke', actionState: 'Verified' },
  };

  const verify = async () => {
    for (const relation of smokeRelations(ids)) {
      const result = await client.verifyRelation(relation);
      if (result !== true && result?.verified !== true) throw new NotionV5Error('smoke relation verification did not confirm the expected v5 page', { code: 'RELATION_VERIFICATION_FAILED', stage: 'smoke', target: relation.store });
      evidence.relationVerificationCount++;
      evidence.relationChecks.push({ ...relation, verified: true });
    }
  };

  if (!committedKeys.size) {
    try {
      for (const store of SMOKE_STORE_ORDER) {
        client.activeJournal = durableJournal;
        client.activeTransactionKey = keys[store];
        try {
          const page = await client.createPage(store, store === 'applications' ? { ...values[store], Company: undefined, company: [ids.companies] } : values[store]);
          if (!page?.id) throw new NotionV5Error(`smoke ${store} response omitted a page id`, { code: 'RESPONSE_INVALID', stage: 'smoke', target: store });
          ids[store] = page.id;
          evidence.created.push({ store, key: keys[store], id: page.id });
          evidence.createdIds.push(page.id);
          durableJournal.recordTarget(keys[store], { pageId: page.id });
          if (store === 'applications') values.outreach.application = [ids.applications];
          if (store === 'outreach') values.activity.outreach = [ids.outreach];
          if (store === 'applications') values.activity.application = [ids.applications];
        } finally {
          client.activeTransactionKey = null;
          client.activeJournal = null;
        }
      }
      await verify();
      if (typeof transaction.commit === 'function') await transaction.commit(evidence);
      for (const key of Object.values(keys)) durableJournal.markVerified(key);
      for (const key of Object.values(keys)) durableJournal.markCommitted(key);
      evidence.journal.outcome = 'committed';
      evidence.pendingRecoveryCount = durableJournal.recover().length;
      return { status: 'passed', live: Boolean(client.live), runId: normalizedRunId, outcome: 'fresh', idempotent: false, keys, evidence };
    } catch (error) {
      evidence.failures.push({ stage: error?.stage ?? 'smoke', error: structuredError(error) });
      for (const key of Object.values(keys)) if (durableJournal.get(key)?.state === 'pending' || durableJournal.get(key)?.state === 'verified') durableJournal.markAborted(key, error);
      evidence.journal.outcome = 'aborted';
      evidence.pendingRecoveryCount = durableJournal.recover().length;
      return { status: 'failed', live: Boolean(client.live), runId: normalizedRunId, keys, evidence, recovery: { rollbackPerformed: false, deletionPerformed: false, createdIds: evidence.created.map(({ id }) => id), action: 'manual reconciliation required; no rollback or deletion was performed' } };
    }
  }

  try {
    await verify();
    evidence.journal.outcome = 'committed';
    evidence.pendingRecoveryCount = durableJournal.recover().length;
    return { status: 'passed', live: Boolean(client.live), runId: normalizedRunId, outcome: 'idempotent', idempotent: true, keys, evidence };
  } catch (error) {
    evidence.failures.push({ stage: error?.stage ?? 'smoke', error: structuredError(error) });
    evidence.journal.outcome = 'committed';
    evidence.pendingRecoveryCount = durableJournal.recover().length;
    return { status: 'failed', live: Boolean(client.live), runId: normalizedRunId, outcome: 'idempotent-verification-failed', idempotent: true, keys, evidence };
  }
}

export function provisioningPreflight({ manifest, enabled = false, credentialFile = null, journalPath = null, journal = null, injectedGateway = false, runId = null } = {}) {
  if (!enabled) return { ok: false, code: 'LIVE_OPT_IN_REQUIRED', reason: 'enabled: true is required' };
  if (!runId || !String(runId).trim()) return { ok: false, code: 'SMOKE_RUN_ID_REQUIRED', reason: 'a unique smoke run ID is required' };
  if (!injectedGateway && !credentialFile) return { ok: false, code: 'CREDENTIAL_REQUIRED', reason: 'external credential file is required' };
  if (!journal && !journalPath) return { ok: false, code: 'JOURNAL_PATH_REQUIRED', reason: 'explicit external journal path is required' };
  if (isPlaceholderIdentifier(manifest?.parent?.id) || !isNotionIdentifier(manifest?.parent?.id) || isLegacyNotionId(manifest?.parent?.id)) return { ok: false, code: 'PARENT_REQUIRED', reason: 'real authorized v5 parent page id is required' };
  return { ok: true };
}

export { assertLiveManifest };
