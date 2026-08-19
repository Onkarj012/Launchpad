import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadManifest } from '../../notion-v5/manifest.mjs';
import { V5_STORE_KEYS } from '../../notion-v5/schema.mjs';
import { createNotionV5Gateway } from '../../notion-v5/gateway.mjs';

const base = loadManifest();
const pageId = '77777777777777777777777777777777';
const dataSourceIds = ['22222222222222222222222222222222', '33333333333333333333333333333333', '44444444444444444444444444444444', '55555555555555555555555555555555', '66666666666666666666666666666666'];
const manifest = {
  ...base,
  parent: { ...base.parent, id: '11111111111111111111111111111111' },
  targets: Object.fromEntries(Object.entries(base.targets).map(([key, value], index) => [key, {
    ...value,
    databaseId: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccccccccccc', 'dddddddddddddddddddddddddddddddd', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'][index],
    dataSourceId: dataSourceIds[index],
  }])),
  relations: base.relations.map((relation) => ({
    ...relation,
    fromDataSourceId: dataSourceIds[V5_STORE_KEYS.indexOf(relation.from.split('.')[0])],
    toDataSourceId: dataSourceIds[V5_STORE_KEYS.indexOf(relation.to)],
  })),
};

test('v5 gateway updates a scoped application page through the pinned page endpoint', async () => {
  const requests = [];
  const gateway = createNotionV5Gateway({ manifest, live: true, testOnly: true, token: 'fixture', journalPath: path.join(mkdtempSync(path.join(os.tmpdir(), 'resume-v5-gateway-')), 'journal.json'), fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ id: pageId, properties: {} }) };
  } });
  gateway.registerRuntimeId(pageId, 'page');
  const result = await gateway.updatePage('applications', pageId, { resumeState: 'Building' });
  assert.equal(result.id, pageId);
  assert.match(requests[0].url, new RegExp(`/pages/${pageId}$`));
  assert.equal(requests[0].options.method, 'PATCH');
  assert.equal(JSON.parse(requests[0].options.body).properties['Resume State'].select.name, 'Building');
});

