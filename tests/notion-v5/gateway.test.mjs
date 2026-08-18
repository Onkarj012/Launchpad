import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { createManifestTemplate, isLegacyNotionId, isNotionIdentifier, loadManifest, assertLiveManifest, validateManifest } from '../../notion-v5/manifest.mjs';
import { buildDatabaseProperties, mapProperties, readPropertyValue, V5_SCHEMA, V5_STORE_KEYS, V5_VIEW_DEFINITIONS, validateViewDefinitions } from '../../notion-v5/schema.mjs';
import { createNotionV5Gateway, loadExternalCredential, NotionV5Error, NOTION_V5_API_VERSION } from '../../notion-v5/gateway.mjs';
import { provisionV5, smokeV5 } from '../../notion-v5/provision.mjs';
import { createTransactionJournal, runReservedBatch, structuredError } from '../../notion-v5/transaction.mjs';

const manifest = loadManifest();
const ids = Object.freeze({
  parent: '11111111111111111111111111111111',
  databases: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccccccccccc', 'dddddddddddddddddddddddddddddddd', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'],
  dataSources: ['22222222222222222222222222222222', '33333333333333333333333333333333', '44444444444444444444444444444444', '55555555555555555555555555555555', '66666666666666666666666666666666'],
  pages: ['77777777777777777777777777777777', '88888888888888888888888888888888', '99999999999999999999999999999999'],
});
const realManifest = {
  ...manifest,
  parent: { type: 'page_id', id: ids.parent },
  targets: Object.fromEntries(Object.entries(manifest.targets).map(([key, value], index) => [key, { ...value, databaseId: ids.databases[index], dataSourceId: ids.dataSources[index] }])),
  relations: manifest.relations.map((relation) => ({
    ...relation,
    fromDataSourceId: ids.dataSources[V5_STORE_KEYS.indexOf(relation.from.split('.')[0])],
    toDataSourceId: ids.dataSources[V5_STORE_KEYS.indexOf(relation.to)],
  })),
};

function tempPath(name) { return path.join(mkdtempSync(path.join(os.tmpdir(), 'launchpad-v5-')), name); }
function response(body, { status = 200, headers = {} } = {}) { return { ok: status >= 200 && status < 300, status, headers: new Map(Object.entries(headers)), text: async () => JSON.stringify(body) }; }
function testGateway(options = {}) { return createNotionV5Gateway({ manifest: realManifest, live: true, testOnly: true, token: 'fixture-secret', ...options }); }

test('schema emits public API option shapes and reciprocal data-source relations without dropping false', () => {
  const properties = mapProperties('applications', { Role: 'AI Engineer', 'Make Resume': false, 'Applied?': false, Company: [ids.pages[0]], 'Posted Date': '2026-07-23' });
  assert.equal(properties['Make Resume'].checkbox, false);
  assert.equal(properties['Applied?'].checkbox, false);
  assert.deepEqual(properties.Company.relation, [{ id: ids.pages[0] }]);
  const generated = buildDatabaseProperties('applications', { relationIds: { companies: ids.dataSources[1], outreach: ids.dataSources[2], activity: ids.dataSources[3], referrals: ids.dataSources[4] } });
  assert.equal(generated.Company.relation.data_source_id, ids.dataSources[1]);
  assert.deepEqual(generated.Status.select.options, [{ name: 'Ready' }, { name: 'Applied' }, { name: 'Interviewing' }, { name: 'Offer' }, { name: 'Rejected' }, { name: 'Withdrawn' }, { name: 'Not Pursuing' }, { name: 'Closed/Expired' }]);
  assert.deepEqual(generated.Relaxation.multi_select, {});
  assert.equal('default' in generated['Make Resume'].checkbox, false);
  assert.equal(V5_SCHEMA.stores.companies.properties.applications.reciprocal, 'Company');
  assert.equal(readPropertyValue(properties.Company), null);
});

test('internship stipend evidence maps to Applications v5 without a schema gap', () => {
  const properties = mapProperties('applications', {
    'Employment Category': 'Internship', 'Stipend Amount': 30000, 'Stipend Currency': 'INR',
    'Stipend Period': 'month', 'Stipend Monthly Amount': 30000, 'Stipend Raw': 'INR 30,000/month',
    'Stipend Evidence': 'fixture evidence', 'Stipend Tier': 'Preferred', Freshness: 'Primary', Readiness: 'Ready',
  });
  assert.equal(properties['Stipend Amount'].number, 30000);
  assert.equal(properties['Stipend Tier'].select.name, 'Preferred');
  assert.equal(properties.Freshness.rich_text[0].text.content, 'Primary');
  assert.equal(properties.Readiness.rich_text[0].text.content, 'Ready');
});

test('real manifest is scoped to nonlegacy v5 IDs and records reciprocal relation and view evidence', () => {
  assert.equal(validateManifest(manifest).valid, true);
  assert.doesNotThrow(() => assertLiveManifest(manifest));
  assert.equal(isNotionIdentifier(manifest.parent.id), true);
  assert.equal(isLegacyNotionId(manifest.parent.id), false);

  const dataSourceIds = Object.fromEntries(V5_STORE_KEYS.map((key) => [key, manifest.targets[key].dataSourceId]));
  const databaseIds = V5_STORE_KEYS.map((key) => manifest.targets[key].databaseId);
  const scopedIds = [...databaseIds, ...Object.values(dataSourceIds)];
  assert.equal(new Set(databaseIds).size, V5_STORE_KEYS.length);
  assert.equal(new Set(Object.values(dataSourceIds)).size, V5_STORE_KEYS.length);
  for (const id of scopedIds) {
    assert.equal(isNotionIdentifier(id), true);
    assert.equal(isLegacyNotionId(id), false);
  }

  const expectedRelations = V5_STORE_KEYS.flatMap((from) => Object.values(V5_SCHEMA.stores[from].properties)
    .filter((property) => property.type === 'relation')
    .map((property) => ({
      from: `${from}.${property.name}`,
      to: property.target,
      fromDataSourceId: dataSourceIds[from],
      toDataSourceId: dataSourceIds[property.target],
      verified: true,
    })));
  assert.equal(manifest.relations.length, expectedRelations.length);
  for (const expected of expectedRelations) assert.deepEqual(manifest.relations.find((relation) => relation.from === expected.from), expected);

  const expectedViewNames = V5_VIEW_DEFINITIONS.map((view) => view.name);
  assert.equal(manifest.views.created, true);
  assert.equal(manifest.views.verified, true);
  assert.equal(manifest.views.databaseId, manifest.targets.applications.databaseId);
  assert.equal(manifest.views.dataSourceId, manifest.targets.applications.dataSourceId);
  assert.deepEqual(Object.keys(manifest.views.required).sort(), [...expectedViewNames].sort());
  for (const view of Object.values(manifest.views.required)) {
    assert.equal(isNotionIdentifier(view.id), true);
    assert.equal(isLegacyNotionId(view.id), false);
    assert.equal(view.type, 'table');
    assert.deepEqual(view.sort, { property: 'Name', direction: 'ascending' });
    assert.ok(['exact', 'partial', 'unfiltered'].includes(view.filterCoverage));
    assert.ok(Array.isArray(view.filters));
  }

  const legacy = structuredClone(manifest);
  legacy.targets.applications.name = 'New v5 store';
  legacy.targets.applications.databaseId = '7bc3de3a-91d9-4391-8b22-9e68b264e8d2';
  assert.equal(validateManifest(legacy).valid, false);
  assert.equal(NOTION_V5_API_VERSION, '2025-09-03');
});

test('manifest validation rejects a missing relation', () => {
  const invalid = structuredClone(manifest);
  invalid.relations = invalid.relations.filter((relation) => relation.from !== 'outreach.Activity');
  assert.equal(validateManifest(invalid).valid, false);
});

test('manifest validation rejects duplicate and unexpected relations', () => {
  const duplicate = structuredClone(manifest);
  duplicate.relations.push(structuredClone(duplicate.relations[0]));
  assert.equal(validateManifest(duplicate).valid, false);

  const unexpected = structuredClone(manifest);
  unexpected.relations.push({ from: 'outreach.Unknown', to: 'activity', fromDataSourceId: ids.dataSources[2], toDataSourceId: ids.dataSources[3], verified: true });
  assert.equal(validateManifest(unexpected).valid, false);
});

test('manifest validation rejects wrong relation targets, data-source IDs, and verification', () => {
  for (const mutate of [
    (relation) => { relation.to = 'applications'; },
    (relation) => { relation.fromDataSourceId = ids.dataSources[0]; },
    (relation) => { relation.toDataSourceId = ids.dataSources[0]; },
    (relation) => { relation.verified = false; },
  ]) {
    const invalid = structuredClone(manifest);
    mutate(invalid.relations.find((relation) => relation.from === 'outreach.Activity'));
    assert.equal(validateManifest(invalid).valid, false);
  }
});

test('manifest template includes a complete schema-derived relation inventory', () => {
  const template = createManifestTemplate();
  assert.equal(validateManifest(template).valid, true);
  assert.deepEqual(template.relations.map((relation) => relation.from).sort(), manifest.relations.map((relation) => relation.from).sort());
  for (const relation of template.relations) {
    assert.equal(relation.fromDataSourceId, template.targets[relation.from.split('.')[0]].dataSourceId);
    assert.equal(relation.verified, true);
  }
});

test('offline gateway fails closed and Issue 01 planWrites returns authoritative operations unchanged', async () => {
  let calls = 0;
  const operations = [{ resource: 'application', operation: 'create', dedupKey: 'a', payload: { Role: 'AI Engineer', Company: 'Example' } }];
  const gateway = createNotionV5Gateway({ manifest, fetchImpl: async () => { calls++; throw new Error('must not call'); } });
  assert.deepEqual(gateway.planWrites({ operations }), { status: 'planned', live: false, operations });
  await assert.rejects(() => gateway.request('/pages/x'), (error) => error.code === 'LIVE_OPT_IN_REQUIRED');
  assert.equal(calls, 0);
});

test('unknown and legacy raw IDs are rejected before transport for page, body, relation, database, and data-source boundaries', async () => {
  let calls = 0;
  const gateway = testGateway({ fetchImpl: async () => { calls++; return response({}); } });
  await assert.rejects(() => gateway.request(`/pages/${ids.pages[2]}`, { target: 'applications' }), /unknown or undeclared/);
  await assert.rejects(() => gateway.appendPageBody(ids.pages[2], [{ object: 'block' }]), /unknown or undeclared/);
  await assert.rejects(() => gateway.verifyRelation({ pageId: ids.pages[0], expectedPageId: ids.pages[2] }), /unknown or undeclared/);
  await assert.rejects(() => gateway.updateDataSourceRelations('applications', ids.dataSources[0], { companies: ids.pages[0] }), /unknown or undeclared/);
  await assert.rejects(() => gateway.createDatabase('applications', { parentId: ids.parent, relationIds: { companies: 'd8d525b0-e436-44b7-ae65-28c08a358684' } }), /audited legacy/);
  assert.equal(calls, 0);
});

test('credential files require external regular 0600-style ownership and injected transport errors redact secrets', async () => {
  const credentialPath = tempPath('credential');
  writeFileSync(credentialPath, 'fixture-secret\n', { mode: 0o600 });
  chmodSync(credentialPath, 0o644);
  assert.throws(() => loadExternalCredential(credentialPath), /must not be group\/world readable/);
  chmodSync(credentialPath, 0o600);
  assert.equal(loadExternalCredential(credentialPath), 'fixture-secret');
  assert.throws(() => loadExternalCredential(path.join(process.cwd(), 'credential')), /outside the repository/);
  const gateway = testGateway({ fetchImpl: async () => { throw new Error('fixture-secret transport failure'); } });
  await assert.rejects(() => gateway.request('/data_sources/22222222222222222222222222222222/query'), (error) => { assert.equal(error.message.includes('fixture-secret'), false); assert.equal(structuredError(error).message.includes('fixture-secret'), false); return true; });
});

test('NotionV5Error keeps redaction secrets out of normal inspection while structured errors remain redacted', () => {
  const secret = 'fixture-secret';
  const error = new NotionV5Error(`request failed with ${secret}`, {
    code: 'FIXTURE_FAILURE',
    details: { message: `details contain ${secret}`, token: secret },
    redactionSecrets: [secret],
  });

  assert.equal(Object.keys(error).includes('redactionSecrets'), false);
  assert.equal(JSON.stringify(error).includes(secret), false);
  assert.equal(inspect(error).includes(secret), false);
  const safe = structuredError(error);
  assert.equal(safe.message.includes(secret), false);
  assert.equal(JSON.stringify(safe).includes(secret), false);
  assert.equal(safe.details.token, '[REDACTED]');
});

test('data-source pagination uses the pinned endpoint and honors bounded Retry-After', async () => {
  const sleeps = [];
  let calls = 0;
  const gateway = testGateway({ sleep: async (ms) => sleeps.push(ms), fetchImpl: async (url, options) => {
    calls++;
    if (calls === 1) return response({ message: 'slow down' }, { status: 429, headers: { 'Retry-After': '0.25' } });
    const body = JSON.parse(options.body);
    return body.start_cursor ? response({ results: [{ id: ids.pages[1] }], has_more: false }) : response({ results: [{ id: ids.pages[0] }], has_more: true, next_cursor: 'next' });
  } });
  const rows = await gateway.listRows('companies', { pageSize: 2 });
  assert.deepEqual(rows.map((row) => row.id), [ids.pages[0], ids.pages[1]]);
  assert.deepEqual(sleeps, [250]);
  assert.equal(calls, 3);
});

test('company find-or-create and application write use data-source page parents and verify scoped relations', async () => {
  const requests = [];
  const gateway = testGateway({ journalPath: tempPath('journal.json'), fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/query')) return response({ results: [{ id: ids.pages[0], properties: {} }], has_more: false });
    if (url.endsWith('/pages')) return response({ id: ids.pages[1] });
    if (url.endsWith(`/${ids.pages[1]}`)) return response({ properties: { Company: { type: 'relation', relation: [{ id: ids.pages[0] }] } } });
    throw new Error(`unexpected ${url}`);
  } });
  const result = await gateway.writeApplications([{ resource: 'application', operation: 'create', dedupKey: 'write-a', payload: { Role: 'AI Engineer', Company: 'Example' }, company: { name: 'Example', canonicalDomain: 'example.com' } }]);
  assert.equal(result.status, 'committed');
  const create = requests.find((request) => request.url.endsWith('/pages'));
  assert.equal(JSON.parse(create.options.body).parent.data_source_id, ids.dataSources[0]);
  assert.match(requests.at(-1).url, new RegExp(`pages/${ids.pages[1]}$`));
});

test('durable journal reserves before writes, reports restart recovery, commits, aborts, and skips duplicates', async () => {
  const journalPath = tempPath('transaction.json');
  const journal = createTransactionJournal({ journalPath });
  journal.reserve([{ key: 'crashed', target: 'applications' }]);
  const restarted = createTransactionJournal({ journalPath });
  assert.equal(restarted.recover()[0].state, 'pending');
  let writes = 0;
  const recovered = await runReservedBatch({ items: [{ dedupKey: 'crashed' }], journal: restarted, reserve: async (items) => ({ reserved: items, committedKeys: [] }), write: async () => { writes++; }, verify: async () => true, commit: async (rows) => rows, abort: async () => {} });
  assert.equal(recovered.status, 'aborted');
  assert.equal(writes, 0);
  restarted.markAborted('crashed', new Error('operator recovered')); 
  const result = await runReservedBatch({ items: [{ dedupKey: 'ok' }, { dedupKey: 'bad' }], journal: restarted, reserve: async (items) => ({ reserved: items, committedKeys: [] }), write: async (item) => { if (item.dedupKey === 'bad') throw new Error('bad row'); return { pageId: ids.pages[0] }; }, verify: async () => true, commit: async (rows) => rows, abort: async () => {} });
  assert.equal(result.status, 'partial');
  assert.equal(restarted.get('ok').state, 'committed');
  assert.equal(restarted.get('bad').state, 'aborted');
  const duplicate = await runReservedBatch({ items: [{ dedupKey: 'ok' }], journal: restarted, reserve: async () => ({ committedKeys: [] }), write: async () => { writes++; }, verify: async () => true, commit: async (rows) => rows, abort: async () => {} });
  assert.deepEqual(duplicate.skipped.map((item) => item.dedupKey), ['ok']);
  assert.equal(writes, 0);
});

test('live writes refuse missing or repository journals', async () => {
  assert.throws(() => createTransactionJournal({ journalPath: path.join(process.cwd(), 'journal.json') }), /outside the repository/);
  const gateway = testGateway();
  await assert.rejects(gateway.writeApplications([]), /external journal path/);
});

test('provisioning returns an incomplete manual-view result and a non-persisting manifest patch', async () => {
  const calls = [];
  const fake = {
    live: false,
    async createDatabase(storeKey) { const index = V5_STORE_KEYS.indexOf(storeKey); calls.push(['create', storeKey]); return { databaseId: ids.databases[index], dataSourceId: ids.dataSources[index] }; },
    async updateDataSourceRelations(storeKey, dataSourceId, relationIds) { calls.push(['relations', storeKey, dataSourceId, relationIds]); },
  };
  const result = await provisionV5({ manifest, enabled: true, parentId: ids.parent, gateway: fake });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.views.status, 'manual-required');
  assert.equal(result.verification.views, false);
  assert.equal(result.created.length, 5);
  assert.deepEqual(Object.keys(result.manifestPatch.targets.applications), ['name', 'databaseId', 'dataSourceId']);
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 5);
  assert.equal(calls.filter(([kind]) => kind === 'relations').length, 5);
});

test('provisioning partial failure reports durable cleanup facts and never claims rollback', async () => {
  const fake = {
    live: false,
    async createDatabase(storeKey) { if (storeKey === 'outreach') throw new Error('synthetic failure'); const index = V5_STORE_KEYS.indexOf(storeKey); return { databaseId: ids.databases[index], dataSourceId: ids.dataSources[index] }; },
    async updateDataSourceRelations() {},
  };
  const result = await provisionV5({ manifest, enabled: true, parentId: ids.parent, gateway: fake });
  assert.equal(result.status, 'blocked');
  assert.equal(result.recovery.rollbackPerformed, false);
  assert.equal(result.recovery.cleanupRequired, true);
  assert.equal(result.recovery.createdObjects.length, 2);
});

function smokeGateway({ failStore = null, failVerification = null } = {}) {
  const pages = new Map();
  const calls = { writes: [], verifications: [] };
  let nextId = 0;
  return {
    live: true,
    calls,
    async createPage(store, values) {
      calls.writes.push({ store, values });
      if (store === failStore) throw new Error(`synthetic ${store} write failure`);
      const id = `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${String(++nextId).padStart(1, '0')}`;
      pages.set(id, { store, values: structuredClone(values) });
      const reciprocalProperty = {
        companies: { applications: 'company' },
        applications: { company: 'applications', outreach: 'application', activity: 'application' },
        outreach: { application: 'outreach', activity: 'outreach' },
        activity: { application: 'activity', outreach: 'activity' },
      };
      for (const [property, relatedIds] of Object.entries(values)) {
        if (!Array.isArray(relatedIds)) continue;
        for (const relatedId of relatedIds) {
          const related = pages.get(relatedId);
          const relatedProperty = reciprocalProperty[store]?.[property];
          if (related && relatedProperty) related.values[relatedProperty] = [...(related.values[relatedProperty] ?? []), id];
        }
      }
      return { id };
    },
    async verifyRelation({ pageId, store, property, expectedPageId }) {
      calls.verifications.push({ pageId, store, property, expectedPageId });
      if (property === failVerification) throw new Error(`synthetic ${store}.${property} verification failure`);
      const page = pages.get(pageId);
      const received = page?.values[property] ?? [];
      if (!received.includes(expectedPageId)) throw new Error(`missing ${store}.${property}`);
      return { verified: true };
    },
  };
}

test('smoke writes exactly four v5 stores, verifies reciprocal relations, and is idempotent', async () => {
  const runId = 'smoke-four-store';
  const journalPath = tempPath('smoke.json');
  const fake = smokeGateway();
  const first = await smokeV5({ manifest: realManifest, enabled: true, runId, journalPath, gateway: fake });
  assert.equal(first.status, 'passed');
  assert.equal(first.idempotent, false);
  assert.deepEqual(fake.calls.writes.map(({ store }) => store), ['companies', 'applications', 'outreach', 'activity']);
  assert.equal(fake.calls.verifications.length, 8);
  assert.equal(first.evidence.relationVerificationCount, 8);
  assert.equal(first.evidence.journal.outcome, 'committed');
  assert.equal(first.evidence.pendingRecoveryCount, 0);
  assert.equal(first.evidence.created.length, 4);
  assert.equal(first.evidence.createdIds.length, 4);
  assert.equal(first.evidence.recoveredIds.length, 0);
  assert.deepEqual(first.evidence.created.map(({ store }) => store), ['companies', 'applications', 'outreach', 'activity']);
  const applicationValues = fake.calls.writes.find(({ store }) => store === 'applications').values;
  assert.equal('makeResume' in applicationValues, false);
  assert.equal('applied' in applicationValues, false);
  assert.equal('Make Resume' in applicationValues, false);
  assert.equal('Applied?' in applicationValues, false);
  for (const call of fake.calls.writes) assert.match(String(Object.values(call.values).flat().find((value) => String(value).includes(runId))), new RegExp(runId));

  const writesBeforeReplay = fake.calls.writes.length;
  const replay = await smokeV5({ manifest: realManifest, enabled: true, runId, journalPath, gateway: fake });
  assert.equal(replay.status, 'passed');
  assert.equal(replay.idempotent, true);
  assert.equal(replay.outcome, 'idempotent');
  assert.equal(fake.calls.writes.length, writesBeforeReplay);
  assert.equal(replay.evidence.recoveredIds.length, 4);
  assert.equal(replay.evidence.journal.outcome, 'committed');
  assert.equal(replay.evidence.pendingRecoveryCount, 0);
});

test('smoke aborts injected write and verification failures without pending recovery entries', async () => {
  const writeJournalPath = tempPath('smoke-write-failure.json');
  const writeFake = smokeGateway({ failStore: 'outreach' });
  const writeFailure = await smokeV5({ manifest: realManifest, enabled: true, runId: 'smoke-write-failure', journalPath: writeJournalPath, gateway: writeFake });
  assert.equal(writeFailure.status, 'failed');
  assert.equal(writeFailure.evidence.journal.outcome, 'aborted');
  assert.equal(writeFailure.evidence.pendingRecoveryCount, 0);
  assert.equal(writeFailure.evidence.created.length, 2);
  assert.equal(writeFailure.evidence.createdIds.length, 2);
  assert.match(writeFailure.evidence.created[0].id, /^[a-f0-9]{32}$/);
  assert.equal(createTransactionJournal({ journalPath: writeJournalPath }).recover().length, 0);

  const verifyJournalPath = tempPath('smoke-verify-failure.json');
  const verifyFake = smokeGateway({ failVerification: 'activity' });
  const verificationFailure = await smokeV5({ manifest: realManifest, enabled: true, runId: 'smoke-verify-failure', journalPath: verifyJournalPath, gateway: verifyFake });
  assert.equal(verificationFailure.status, 'failed');
  assert.equal(verificationFailure.evidence.journal.outcome, 'aborted');
  assert.equal(verificationFailure.evidence.pendingRecoveryCount, 0);
  assert.equal(verificationFailure.evidence.created.length, 4);
  assert.equal(verificationFailure.evidence.createdIds.length, 4);
  assert.equal(createTransactionJournal({ journalPath: verifyJournalPath }).recover().length, 0);
});

test('smoke fails closed on pending or verified journal entries', async () => {
  const journalPath = tempPath('smoke-recovery.json');
  const journal = createTransactionJournal({ journalPath });
  journal.reserve([
    { key: 'smoke:smoke-recovery:companies', target: 'companies' },
    { key: 'smoke:smoke-recovery:applications', target: 'applications' },
    { key: 'smoke:smoke-recovery:outreach', target: 'outreach' },
    { key: 'smoke:smoke-recovery:activity', target: 'activity' },
  ]);
  const result = await smokeV5({ manifest: realManifest, enabled: true, runId: 'smoke-recovery', journalPath, gateway: smokeGateway() });
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'JOURNAL_RECOVERY_REQUIRED');
  assert.equal(result.evidence.pendingRecoveryCount, 4);
});

test('view definitions cover the required names and filters', () => {
  assert.equal(validateViewDefinitions().valid, true);
  assert.deepEqual(V5_VIEW_DEFINITIONS.map((view) => view.name), ['Ready', 'Backfill', 'Internship', 'Startup', 'Remote', 'Verification', 'Resume', 'Applied', 'Outreach', 'Follow-up', 'Pipeline', 'Archive']);
});
