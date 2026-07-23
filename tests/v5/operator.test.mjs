import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHelp, runNoWriteRehearsal, validateV5Surface } from '../../launchpad-v5.mjs';

test('v5 command help exposes the complete public surface and fail-closed safety contract', () => {
  const help = buildHelp();
  for (const command of ['/morning', '/morning startup', '/morning remote', '/make-applications', '/outreach', '/linkedin-leads', '/followups', '/sync', '--profile <stable-name>']) assert.match(help, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(help, /Normal is the default/);
  assert.match(help, /No auto-apply/);
  assert.match(help, /no legacy fallback/);
});

test('v5 surface validates the manifest, schema, views, policy, and command modules', () => {
  const result = validateV5Surface();
  assert.equal(result.schemaVersion, 'LaunchpadV5OperatorValidationV1');
  assert.deepEqual(result.modes, ['normal', 'startup', 'remote']);
  assert.equal(result.manifest.targetCount, 5);
  assert.equal(result.views.length, 12);
  assert.equal(result.legacyFallback, false);
  assert.equal(result.status, 'valid');
  assert.deepEqual(result.mirrorIssues, []);
});

test('full deterministic rehearsal plans all v5 paths with zero external side effects', async () => {
  const result = await runNoWriteRehearsal();
  assert.equal(result.status, 'passed');
  assert.equal(result.validation.status, 'valid');
  assert.deepEqual(result.validation.mirrorIssues, []);
  assert.equal(result.externalWrites, 0);
  assert.equal(result.externalNetwork, false);
  assert.equal(result.browserAutomation, false);
  assert.equal(result.applicationsSubmitted, false);
  assert.equal(result.autonomousSending, false);
  assert.equal(result.pendingTransactions, 0);
  assert.deepEqual(result.unexplainedSourceOmission, []);
  assert.equal(result.legacyFallback, false);
  assert.equal(result.modes.normal.status, 'ok');
  assert.equal(result.modes.startup.status, 'ok');
  assert.equal(result.modes.remote.status, 'ok');
  assert.equal(result.internship.schemaIntegrationRequired, false);
  assert.equal(result.linkedin.sideEffects.notionMutation, false);
  assert.equal(result.apify.externalCalls, 0);
  assert.equal(result.resume.status, 'ready');
  assert.equal(result.resume.sync, 'synced');
  assert.equal(result.outreach.stored, 'stored');
  assert.equal(result.outreach.sends, 0);
});
