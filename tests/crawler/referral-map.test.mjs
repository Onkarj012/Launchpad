import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildReferralMapFromFiles } from '../../crawler/referral-map.mjs';

const fixture = (name) => path.join('tests/fixtures/referral-map', name);

test('reads LinkedIn and handwritten contacts, matches registry employers and shortlisted roles, and returns drafts only', () => {
  const result = buildReferralMapFromFiles({
    connectionsPath: fixture('connections.csv'),
    handwrittenPath: fixture('handwritten.json'),
    registryPath: fixture('registry.json'),
    shortlistPath: fixture('shortlist.json'),
  });

  assert.equal(result.people.length, 4);
  assert.deepEqual(result.people.map((person) => person.name), ['Ananya Test', 'Rohan Sample', 'Priya Example', 'Kiran Fixture']);
  assert.deepEqual(result.people[0].registryEmployer, { id: 'greenhouse:northstar', company: 'Northstar Labs' });
  assert.deepEqual(result.people[0].roles.map((role) => role.title), ['AI Platform Engineer']);
  assert.equal(result.people[0].connectedDate, '2025-10-08');
  assert.equal(result.people[2].connectedDate, '2023-07-15');
  assert.equal(result.people[3].source, 'handwritten');
  assert.match(result.people[0].draftNotes[0].body, /AI Platform Engineer/);
  assert.equal(result.people[0].draftNotes[0].status, 'draft');
  assert.equal(result.people[2].draftNotes[0].sent, false);
  assert.equal(result.people.find((person) => person.name === 'Rohan Sample').registryEmployer, null);
});
