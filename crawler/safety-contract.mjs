import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACT_FILES = Object.freeze([
  'config/launchpad-v5.commands.json',
  'crawler/schedules.mjs',
  'crawler/operator.mjs',
  'crawler/daily-runner.mjs',
  'job-pull/normal-mode.mjs',
  'master_prompt.md',
]);

function readSources(root, overrides = {}) {
  return Object.fromEntries(CONTRACT_FILES.map((file) => [
    file,
    overrides[file] ?? fs.readFileSync(path.join(root, file), 'utf8'),
  ]));
}

export function verifySafetyContracts({ root = process.cwd(), files = {} } = {}) {
  const sources = readSources(root, files);
  let commands = null;
  try { commands = JSON.parse(sources['config/launchpad-v5.commands.json']); } catch { commands = {}; }
  const schedule = sources['crawler/schedules.mjs'];
  const operator = sources['crawler/operator.mjs'];
  const daily = sources['crawler/daily-runner.mjs'];
  const normal = sources['job-pull/normal-mode.mjs'];
  const prompt = sources['master_prompt.md'];
  const checks = [
    {
      id: 'discovery-only-scheduling',
      ok: commands.commands?.morning?.module === 'crawler/daily-runner.mjs'
        && /safety: \{ network: false, scheduling: false, autoApply: false \}/.test(schedule)
        && /noAutoApply: true/.test(schedule),
    },
    {
      id: 'no-auto-apply',
      ok: commands.safety?.autoApply === false && /never applies or sends/i.test(operator),
    },
    {
      id: 'no-autonomous-sending',
      ok: commands.safety?.autoSend === false && /noAutoSend: true/.test(schedule) && /never applies or sends/i.test(operator),
    },
    {
      id: 'user-owned-checkboxes',
      ok: /Make Resume/.test(prompt) && /Applied\?/.test(prompt) && /never auto-checked/i.test(prompt),
    },
    {
      id: 'no-fabricated-evidence',
      ok: /Never fabricate/i.test(prompt) && /evidence/.test(normal),
    },
    {
      id: 'no-legacy-fallback-gateway',
      ok: commands.safety?.legacyFallback === false
        && !/legacyFallback\s*:\s*true/.test(normal)
        && /live or non-transactional gateway execution is disabled/.test(normal)
        && !/legacy fallback|v3/i.test(daily),
    },
  ];
  return {
    schemaVersion: 'LaunchpadSafetyContractReportV1',
    passed: checks.every((check) => check.ok),
    checks,
  };
}

export function assertSafetyContracts(options = {}) {
  const report = verifySafetyContracts(options);
  if (!report.passed) {
    throw new Error(`safety contract failure: ${report.checks.filter((check) => !check.ok).map((check) => check.id).join(', ')}`);
  }
  return report;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const report = verifySafetyContracts();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}
