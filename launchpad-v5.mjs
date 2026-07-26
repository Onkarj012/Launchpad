import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidConfig, assertValidConversionPlan, loadConfig, loadConversionPlan } from './job-pull/config.mjs';
import { NORMAL_SOURCE_LANES } from './job-pull/normal-sources.mjs';
import { runNormalMode } from './job-pull/normal-mode.mjs';
import { STARTUP_SOURCE_LANES } from './job-pull/startup-sources.mjs';
import { runStartupMode } from './job-pull/startup-mode.mjs';
import { REMOTE_SOURCE_LANES } from './job-pull/remote-sources.mjs';
import { runRemoteMode } from './job-pull/remote-mode.mjs';
import { runInternshipLane } from './job-pull/internship-lane.mjs';
import { runLinkedInRescue } from './job-pull/linkedin-rescue-mode.mjs';
import { prepareApifyRecords } from './job-pull/apify-prepare.mjs';
import { readMakeResumeQueue, readAppliedQueue } from './resume-v5/queue-reader.mjs';
import { processMakeResumeQueue } from './resume-v5/resume-queue.mjs';
import { runProductionResumeBuilder } from './resume-v5/production-builder.mjs';
import { syncAppliedApplications } from './resume-v5/application-sync.mjs';
import { prepareOutreach, persistOutreach } from './outreach-v5/workflow.mjs';
import { assertValidManifest, loadManifest } from './notion-v5/manifest.mjs';
import { assertValidViewDefinitions } from './notion-v5/schema.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const COMMAND_CONFIG_PATH = path.join(ROOT, 'config/launchpad-v5.commands.json');
const MIRRORED_SKILLS = Object.freeze([
  'application-agent', 'daily-job-pull', 'followups', 'linkedin-leads', 'make-applications',
  'morning', 'outreach', 'quick-add', 'resume-check', 'resume-latex', 'sync',
]);
const REHEARSAL_NOW = '2026-07-23T06:30:00.000Z';

export class LaunchpadV5OperatorError extends Error {
  constructor(message, code = 'LAUNCHPAD_V5_OPERATOR_ERROR') { super(message); this.name = 'LaunchpadV5OperatorError'; this.code = code; }
}

function commandConfig() {
  try { return JSON.parse(readFileSync(COMMAND_CONFIG_PATH, 'utf8')); }
  catch (error) { throw new LaunchpadV5OperatorError(`unable to read command config: ${error.message}`, 'COMMAND_CONFIG_INVALID'); }
}

export function buildHelp(config = commandConfig()) {
  const lines = [
    'Launchpad v5 local operator surface',
    '',
    'Safe local commands:',
    '  node launchpad-v5.mjs help       Show this contract.',
    '  node launchpad-v5.mjs validate   Validate v5 manifest, schema, policy, and skill mirrors.',
    '  node launchpad-v5.mjs rehearse   Run all deterministic v5 paths with fixture data and no external writes.',
    '',
    'Agent commands:',
    ...Object.values(config.commands).map((command) => {
      const invocation = command.invocation.includes(command.module)
        ? command.invocation
        : `${command.invocation} ${command.module}`;
      return `  ${invocation.padEnd(42)}`;
    }),
    '',
    'Safety: Normal is the default mode; Startup and Remote only change source emphasis. No auto-apply, no auto-send,',
    'no automatic LinkedIn browser use, local-only resume compilation, and no legacy fallback. Live v5 writes require',
    'an explicit credentialed operator action plus an external transaction journal; this command never performs them.',
  ];
  return `${lines.join('\n')}\n`;
}

function assertCommandConfig(config) {
  if (config.schemaVersion !== 'LaunchpadV5CommandSurfaceV1') throw new LaunchpadV5OperatorError('unsupported command config schema', 'COMMAND_CONFIG_INVALID');
  if (config.defaultMode !== 'normal' || JSON.stringify(config.modes) !== JSON.stringify(['normal', 'startup', 'remote'])) throw new LaunchpadV5OperatorError('Normal must be the default and modes must be Normal, Startup, Remote', 'COMMAND_CONFIG_INVALID');
  if (!config.safety || config.safety.autoApply !== false || config.safety.autoSend !== false || config.safety.autoLinkedIn !== false || config.safety.legacyFallback !== false) throw new LaunchpadV5OperatorError('command safety contract is not fail-closed', 'SAFETY_CONTRACT_INVALID');
  for (const [name, command] of Object.entries(config.commands ?? {})) {
    if (!command.invocation || !command.module) throw new LaunchpadV5OperatorError(`command ${name} is incomplete`, 'COMMAND_CONFIG_INVALID');
    if (!path.isAbsolute(path.join(ROOT, command.module)) || !readable(path.join(ROOT, command.module))) throw new LaunchpadV5OperatorError(`command ${name} references a missing module`, 'COMMAND_MODULE_MISSING');
  }
  return config;
}

function readable(filePath) {
  try { readFileSync(filePath); return true; } catch { return false; }
}

export function validateV5Surface({ root = ROOT } = {}) {
  const config = assertCommandConfig(commandConfig());
  const manifest = loadManifest(path.join(root, 'config/notion-v5.manifest.json'));
  assertValidManifest(manifest);
  const views = assertValidViewDefinitions();
  const policy = loadConfig();
  const conversionPlan = loadConversionPlan();
  assertValidConfig(policy);
  assertValidConversionPlan(conversionPlan);
  const mirrorResults = MIRRORED_SKILLS.map((skill) => {
    const canonicalPath = path.join(root, `.agents/skills/${skill}/SKILL.md`);
    const mirrorPath = path.join(root, `.claude/skills/${skill}/SKILL.md`);
    if (!readable(canonicalPath)) return { skill, identical: false, unavailable: 'canonical .agents skill is not readable or is missing' };
    if (!readable(mirrorPath)) return { skill, identical: false, unavailable: 'Claude mirror is not readable or is missing' };
    const canonical = readFileSync(canonicalPath, 'utf8');
    const mirror = readFileSync(mirrorPath, 'utf8');
    return { skill, identical: canonical === mirror, canonicalBytes: canonical.length, mirrorBytes: mirror.length };
  });
  const nonIdentical = mirrorResults.filter((result) => !result.identical);
  const status = nonIdentical.length ? 'blocked' : 'valid';
  return {
    status,
    schemaVersion: 'LaunchpadV5OperatorValidationV1',
    commandCount: Object.keys(config.commands).length,
    modes: config.modes,
    manifest: { schemaVersion: manifest.schemaVersion, parentConfigured: Boolean(manifest.parent?.id), targetCount: Object.keys(manifest.targets ?? {}).length },
    views: views.map((view) => view.name),
    policy: policy.schemaVersion,
    conversionPlan: conversionPlan.schemaVersion,
    mirroredSkills: mirrorResults.map((result) => result.skill),
    mirrorIssues: nonIdentical.map((result) => ({ skill: result.skill, reason: result.unavailable ?? 'canonical and Claude files differ' })),
    legacyFallback: false,
  };
}

function rehearsalJob(prefix, index, overrides = {}) {
  return {
    url: `https://rehearsal.example/${prefix}/${index}`,
    company: `Rehearsal ${prefix} ${index}`,
    title: index % 3 === 0 ? 'ML Engineer' : index % 3 === 1 ? 'AI Engineer' : 'Backend Python Engineer',
    location: prefix === 'remote' ? 'Remote - India' : 'Pune, India',
    workMode: prefix === 'remote' ? 'remote' : 'onsite',
    description: prefix === 'remote' ? 'Remote in India. Full-time role. 0-1 years experience. Python AI systems.' : 'Pune full-time role. 0-1 years experience. Python AI systems.',
    postedAt: new Date(Date.parse(REHEARSAL_NOW) - index * 3600000).toISOString(),
    employment: { type: 'full-time', evidence: 'fixture full-time role' },
    experience: { minYears: 0, maxYears: 1, evidence: '0-1 years' },
    liveness: { status: 'Active', checkedAt: REHEARSAL_NOW, evidence: 'fixture active application page' },
    originalApplicationUrl: `https://careers.rehearsal.example/${prefix}/${index}`,
    originalApplicationEvidence: 'fixture original employer ATS resolution',
    applicationResolution: { status: 'Resolved Original', evidence: 'fixture original employer ATS resolution' },
    matchScore: 90 - index,
    ...overrides,
  };
}

function laneFunctions(lanes, prefix, extra = {}) {
  return Object.fromEntries(lanes.map((lane, index) => {
    const additions = extra[lane.id] ?? {};
    return [lane.id, () => ({ records: [rehearsalJob(prefix, index + 1, { provider: lane.provider ?? 'greenhouse', sourceKind: lane.category === 'direct-ats' ? 'ats-direct' : 'aggregator' })], ...additions })];
  }));
}

function localGateway() {
  const applications = [{ id: 'app-acme', role: 'AI Engineer', companyName: 'Acme', makeResume: true, applied: true, status: 'Ready', resumeState: 'Not Started', appliedAt: null, hook: 'Acme is building practical AI systems.', bestProof: 'Lore Engine is an evidence-backed hybrid retrieval system.' }];
  const activities = [];
  const outreach = [];
  const updates = [];
  return {
    applications, activities, outreach, updates,
    async listRows(target, { filter } = {}) {
      if (target === 'applications') return applications;
      if (target === 'activity') return activities.filter((row) => !filter?.rich_text?.equals || row.idempotencyKey === filter.rich_text.equals || row.values?.idempotencyKey === filter.rich_text.equals);
      if (target === 'outreach') return outreach.filter((row) => !filter?.rich_text?.equals || row.duplicateKey === filter.rich_text.equals || row.values?.duplicateKey === filter.rich_text.equals);
      return [];
    },
    async updatePage(target, id, values) {
      updates.push({ target, id, values: structuredClone(values) });
      const collection = target === 'applications' ? applications : target === 'outreach' ? outreach : [];
      const row = collection.find((item) => item.id === id);
      if (row) Object.assign(row, values);
    },
    async createPage(target, values, options = {}) {
      const row = { id: `${target}-${activities.length + outreach.length + 1}`, ...structuredClone(values), values: structuredClone(values), children: options.children ?? [] };
      if (target === 'activity') activities.push(row);
      if (target === 'outreach') outreach.push(row);
      return row;
    },
  };
}

async function rehearsalModes() {
  const noWrite = { planWrites: ({ operations }) => ({ status: 'planned', operations }) };
  const normal = await runNormalMode({ clock: () => REHEARSAL_NOW, runId: 'rehearsal-normal', sourceFunctions: laneFunctions(NORMAL_SOURCE_LANES, 'normal'), notionGateway: noWrite });
  const startupFunctions = laneFunctions(STARTUP_SOURCE_LANES.filter((lane) => lane.id !== 'funding-hiring-signals'), 'startup');
  startupFunctions['funding-hiring-signals'] = () => ({ signals: [{ company: 'Rehearsal startup 1', fundingDate: '2026-05-01', fundingEvidence: 'fixture funding evidence', verifiedAt: REHEARSAL_NOW }] });
  const startup = await runStartupMode({ clock: () => REHEARSAL_NOW, runId: 'rehearsal-startup', sourceFunctions: startupFunctions, notionGateway: noWrite });
  const remote = await runRemoteMode({ clock: () => REHEARSAL_NOW, runId: 'rehearsal-remote', sourceFunctions: laneFunctions(REMOTE_SOURCE_LANES, 'remote'), notionGateway: noWrite });
  return { normal, startup, remote };
}

export async function runNoWriteRehearsal() {
  const validation = validateV5Surface();
  const modes = await rehearsalModes();
  const internship = await runInternshipLane({
    clock: () => REHEARSAL_NOW,
    runId: 'rehearsal-internship',
    records: [{ ...rehearsalJob('internship', 1), title: 'AI Engineer Intern', employment: { type: 'internship', paid: true, evidence: 'paid internship' }, stipend: { amount: 30000, currency: 'INR', period: 'month', raw: 'INR 30,000/month', evidence: 'fixture stipend' } }],
  });
  const root = ROOT;
  const linkedInCapture = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/linkedin-rescue/dual-output.json'), 'utf8'));
  const linkedin = runLinkedInRescue({ explicitInvocation: true, now: REHEARSAL_NOW, runId: 'rehearsal-linkedin', capturedPosts: [linkedInCapture] });
  const apify = prepareApifyRecords([{ url: 'https://portal.example/jobs/1', title: 'AI Engineer', company: 'Rescue Co', location: 'Pune, India', postedAt: REHEARSAL_NOW, source: 'apify-rescue', actorId: 'fixture-actor', actorLabel: 'Fixture rescue', discoveryUrl: 'https://portal.example', originalApplicationUrl: 'https://careers.example/jobs/1', originalApplicationEvidence: 'fixture ATS resolution' }]);
  const gateway = localGateway();
  const queued = await readMakeResumeQueue({ gateway });
  const applied = await readAppliedQueue({ gateway });
  const artifactBase = path.join(root, 'tests/fixtures/resume-v5/Onkar_Jadhav_Acme_AI_Engineer');
  const resume = await processMakeResumeQueue({
    gateway,
    build: async () => ({ applicationId: 'app-acme', company: 'Acme', role: 'AI Engineer', pdfPath: `${artifactBase}.pdf`, sourcePath: `${artifactBase}.tex`, matrixPath: `${artifactBase}.matrix.md`, provenancePath: `${artifactBase}.provenance.md` }),
    verifyPdf: async () => ({ status: 'PASS' }),
    now: () => REHEARSAL_NOW,
  });
  const sync = await syncAppliedApplications({ gateway, now: () => REHEARSAL_NOW });
  const outreach = await prepareOutreach({ applications: gateway.applications.map((row) => ({ ...row, resumeState: 'Ready' })), providers: { hiringAuthors: async () => ({ name: 'Jane Rao', currentRole: 'Hiring Manager', contactUrl: 'https://example.com/jane', publicEvidence: [{ url: 'https://example.com/team', kind: 'team page' }], recommendedChannel: 'LinkedIn' }) }, now: () => REHEARSAL_NOW, attachmentExpected: false });
  const outreachStored = await persistOutreach({ gateway, prepared: outreach });
  return {
    schemaVersion: 'LaunchpadV5NoWriteRehearsalV1',
    status: validation.status === 'valid' ? 'passed' : 'passed-with-environment-blocker',
    validation,
    modes: Object.fromEntries(Object.entries(modes).map(([name, result]) => [name, { status: result.outcome.status, selected: result.shortlist.length, planned: result.plannedNotionOperations.length, sources: result.sourceManifests.length, failedSources: result.sourceManifests.filter((source) => ['failed', 'unavailable'].includes(source.status)).length }])),
    internship: { status: internship.outcome.status, ready: internship.counts.ready, preferred: internship.counts.preferred, schemaIntegrationRequired: internship.schema.schemaIntegrationRequired },
    linkedin: { status: 'passed', ready: linkedin.counts.ready, associatedPeople: linkedin.counts.associatedPeople, sideEffects: linkedin.sideEffects },
    apify: { prepared: apify.kept.length, skipped: apify.skipped.length, externalCalls: 0 },
    resume: { queued: queued.length, applied: applied.length, status: resume.status, sync: sync.status },
    outreach: { prepared: outreach.results.length, stored: outreachStored.status, sends: 0 },
    externalWrites: 0,
    externalNetwork: false,
    browserAutomation: false,
    applicationsSubmitted: false,
    autonomousSending: false,
    pendingTransactions: 0,
    unexplainedSourceOmission: [],
    legacyFallback: false,
    localSimulationWrites: gateway.updates.length + gateway.activities.length + gateway.outreach.length,
  };
}

export async function runProductionResumeCommand(options = {}) {
  return runProductionResumeBuilder(options);
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') { process.stdout.write(buildHelp()); return 0; }
  if (command === 'validate') { process.stdout.write(`${JSON.stringify(validateV5Surface(), null, 2)}\n`); return 0; }
  if (command === 'rehearse') { process.stdout.write(`${JSON.stringify(await runNoWriteRehearsal(), null, 2)}\n`); return 0; }
  process.stderr.write(`Unknown command: ${command}\n\n${buildHelp()}`);
  return 2;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1; });
}
