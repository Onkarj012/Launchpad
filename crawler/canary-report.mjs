import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DELIVERY_CANARY_SIDECAR_SCHEMA } from './delivery-canary.mjs';

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function text(value) {
  return value == null ? '' : String(value);
}

export function renderDeliveryCanaryMarkdown({
  runId,
  codeConfigVersion,
  revision,
  inventoryIdentity,
  discoveryProfile,
  shortlist = [],
  outcome,
} = {}) {
  const profile = discoveryProfile
    ? `${discoveryProfile.schedule}/${discoveryProfile.mode}/${discoveryProfile.locationPreset}`
    : 'unknown';
  const rows = (Array.isArray(shortlist) ? shortlist : [])
    .map((item, index) => `| ${index + 1} | ${text(item.company)} | ${text(item.title || item.role)} | ${text(item.matchScore ?? '')} | ${text(item.freshnessWindow || item.freshness || '')} |`)
    .join('\n');
  return [
    '# Launchpad delivery canary',
    '',
    `- Run: \`${text(runId)}\``,
    `- Profile: ${profile}`,
    `- Revision: \`${text(revision)}\``,
    `- Code/config: \`${text(codeConfigVersion)}\``,
    `- Inventory: \`${text(inventoryIdentity)}\``,
    `- Outcome: ${text(outcome?.status ?? 'unknown')}`,
    '',
    '## Shortlist',
    '',
    '| # | Company | Role | Score | Freshness |',
    '| --- | --- | --- | --- | --- |',
    rows || '| | _(empty)_ | | | |',
    '',
  ].join('\n');
}

/**
 * Write the Markdown report + JSON sidecar pair that delivery-canary already
 * validates. Paths are relative to `root` so the canary can bind them.
 */
export function writeDeliveryCanaryReport({
  root = process.cwd(),
  directory = 'logs',
  runId,
  codeConfigVersion,
  revision,
  inventoryIdentity,
  discoveryProfile,
  shortlist,
  outcome,
  now = new Date(),
} = {}) {
  if (!runId) throw new TypeError('writeDeliveryCanaryReport requires runId');
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString().replace(/[:.]/g, '-');
  const relativeDir = directory;
  const absDir = path.resolve(root, relativeDir);
  fs.mkdirSync(absDir, { recursive: true });
  const markdownRelative = path.join(relativeDir, `delivery-canary-${stamp}.md`);
  const jsonRelative = path.join(relativeDir, `delivery-canary-${stamp}.json`);
  const markdown = renderDeliveryCanaryMarkdown({
    runId, codeConfigVersion, revision, inventoryIdentity, discoveryProfile, shortlist, outcome,
  });
  const markdownDigest = sha256(Buffer.from(markdown));
  const sidecar = {
    schemaVersion: DELIVERY_CANARY_SIDECAR_SCHEMA,
    runId,
    codeConfigVersion,
    revision,
    inventoryIdentity,
    markdownDigest,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  fs.writeFileSync(path.resolve(root, markdownRelative), markdown);
  fs.writeFileSync(path.resolve(root, jsonRelative), `${JSON.stringify(sidecar, null, 2)}\n`);
  return {
    markdown: markdownRelative,
    json: jsonRelative,
    markdownDigest,
    sidecar,
  };
}
