import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
import { syncAppliedApplications } from './resume-v5/application-sync.mjs';
import { prepareOutreach, persistOutreach } from './outreach-v5/workflow.mjs';
import { assertValidManifest, loadManifest } from './notion-v5/manifest.mjs';
import { assertValidViewDefinitions } from './notion-v5/schema.mjs';
import { provisioningPreflight, smokeV5 } from './notion-v5/provision.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const COMMAND_CONFIG_PATH = path.join(ROOT, 'config/launchpad-v5.commands.json');
const ROUTED_SKILLS = Object.freeze([
  'application-agent', 'application-readiness', 'conversion-ops', 'daily-job-pull', 'followups',
  'interview-loop', 'linkedin-leads', 'make-applications', 'morning', 'outreach', 'proof-of-fit',
  'quick-add', 'resume-check', 'resume-latex', 'sync',
]);
const MIRRORED_SKILLS = Object.freeze([
  'application-agent', 'daily-job-pull', 'followups', 'linkedin-leads', 'make-applications',
  'morning', 'outreach', 'quick-add', 'resume-check', 'resume-latex', 'sync',
]);
const SUPPORTING_SKILLS = Object.freeze(['application-readiness', 'conversion-ops', 'interview-loop', 'proof-of-fit']);
const SEQUENTIAL_SKILLS = Object.freeze(['resume-latex', 'make-applications', 'quick-add', 'application-agent']);
const ROUTER_SKILL = 'launchpad';
const GUARDRAILS_PATH = '.agents/skills/guardrails.md';
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
    '  node launchpad-v5.mjs smoke-plan --run-id ID [--credential-file FILE] [--journal FILE] [--receipt FILE]',
    '  node launchpad-v5.mjs smoke --confirm-live --run-id ID --credential-file FILE --journal FILE --receipt FILE',
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

function skillPair(root, skill) {
  const canonicalPath = path.join(root, `.agents/skills/${skill}/SKILL.md`);
  const mirrorPath = path.join(root, `.claude/skills/${skill}/SKILL.md`);
  if (!readable(canonicalPath)) return { skill, identical: false, unavailable: 'canonical .agents SKILL.md is missing' };
  if (!readable(mirrorPath)) return { skill, identical: false, unavailable: 'Claude SKILL.md mirror is missing' };
  const canonical = readFileSync(canonicalPath, 'utf8');
  const mirror = readFileSync(mirrorPath, 'utf8');
  return { skill, identical: canonical === mirror, canonicalBytes: canonical.length, mirrorBytes: mirror.length };
}

function oneLineDescriptionIssue(root, surface, skill) {
  const filePath = path.join(root, surface, 'skills', skill, 'SKILL.md');
  if (!readable(filePath)) return { surface, skill, reason: 'SKILL.md is missing' };
  const descriptionLine = readFileSync(filePath, 'utf8').split(/\r?\n/).find((line) => /^description\s*:/i.test(line));
  const value = descriptionLine?.replace(/^description\s*:\s*/i, '').trim() ?? '';
  if (!value || value === '|' || value === '>') return { surface, skill, reason: 'description must be nonempty and one line' };
  return null;
}

function markdownSection(text, heading) {
  const headingStart = text.indexOf(`## ${heading}`);
  if (headingStart < 0) return null;
  const bodyStart = text.indexOf('\n', headingStart);
  if (bodyStart < 0) return '';
  const nextHeading = text.indexOf('\n## ', bodyStart + 1);
  return text.slice(bodyStart + 1, nextHeading < 0 ? text.length : nextHeading);
}

function numberedProcedureIssue(root, surface, skill) {
  const filePath = path.join(root, surface, 'skills', skill, 'SKILL.md');
  if (!readable(filePath)) return { surface, skill, reason: 'sequential SKILL.md is missing' };
  const text = readFileSync(filePath, 'utf8');
  const procedure = markdownSection(text, text.includes('## Procedure') ? 'Procedure' : 'Steps');
  const doneWhen = markdownSection(text, 'Done when');
  if (!procedure || !/^\s*\d+\.\s+\S/m.test(procedure)) return { surface, skill, reason: 'procedure has no numbered steps' };
  if (!doneWhen || !doneWhen.trim()) return { surface, skill, reason: 'Done when section is empty or missing' };
  if (!/\b(?:exactly|every|each|zero|count|PASS|terminal|only)\b/i.test(doneWhen)) return { surface, skill, reason: 'Done when has no measurable condition' };
  return null;
}

function routedSkillsFromRouter(text) {
  const section = text.match(/^## Routed skills\s*\n([\s\S]*)$/m);
  return section ? [...section[1].matchAll(/^\|[^|\n]+\|\s*`([^`\n]+)`\s*\|\s*$/gm)].map((match) => match[1]) : [];
}

function routerContractIssues(root) {
  const filePath = path.join(root, `.agents/skills/${ROUTER_SKILL}/SKILL.md`);
  if (!readable(filePath)) return [{ surface: '.agents', skill: ROUTER_SKILL, reason: 'router SKILL.md is missing' }];
  const text = readFileSync(filePath, 'utf8');
  const mappedSkills = routedSkillsFromRouter(text);
  const counts = new Map();
  for (const skill of mappedSkills) counts.set(skill, (counts.get(skill) ?? 0) + 1);
  const issues = [];
  if (!/^disable-model-invocation:\s*false\s*$/m.test(text)) issues.push({ surface: '.agents', skill: ROUTER_SKILL, reason: 'disable-model-invocation must be false' });
  for (const skill of ROUTED_SKILLS) {
    const count = counts.get(skill) ?? 0;
    if (count !== 1) issues.push({ surface: '.agents', skill: ROUTER_SKILL, reason: `${skill} mapped ${count} times` });
  }
  for (const skill of mappedSkills) {
    if (!ROUTED_SKILLS.includes(skill)) issues.push({ surface: '.agents', skill: ROUTER_SKILL, reason: `unexpected routed skill ${skill}` });
  }
  return issues;
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
  const mirrorResults = MIRRORED_SKILLS.map((skill) => skillPair(root, skill));
  const routerResult = skillPair(root, ROUTER_SKILL);
  const guardrailsCanonicalPath = path.join(root, GUARDRAILS_PATH);
  const guardrailsMirrorPath = path.join(root, '.claude/skills/guardrails.md');
  const guardrailsResult = readable(guardrailsCanonicalPath) && readable(guardrailsMirrorPath)
    ? { identical: readFileSync(guardrailsCanonicalPath, 'utf8') === readFileSync(guardrailsMirrorPath, 'utf8') }
    : { identical: false };
  const nonIdentical = [...mirrorResults, routerResult].filter((result) => !result.identical);
  const parityIssues = nonIdentical.map((result) => ({ skill: result.skill, reason: result.unavailable ?? 'canonical and Claude files differ' }));
  if (!guardrailsResult.identical) parityIssues.push({ skill: 'guardrails', reason: 'canonical and Claude guardrails differ or are missing' });

  const staticIssues = [];
  for (const skill of [...ROUTED_SKILLS, ROUTER_SKILL]) {
    const canonicalIssue = oneLineDescriptionIssue(root, '.agents', skill);
    if (canonicalIssue) staticIssues.push(canonicalIssue);
  }
  for (const skill of [...MIRRORED_SKILLS, ROUTER_SKILL]) {
    const mirrorIssue = oneLineDescriptionIssue(root, '.claude', skill);
    if (mirrorIssue) staticIssues.push(mirrorIssue);
  }
  for (const skill of SEQUENTIAL_SKILLS) {
    for (const surface of ['.agents', '.claude']) {
      if (surface === '.claude' && !MIRRORED_SKILLS.includes(skill)) continue;
      const issue = numberedProcedureIssue(root, surface, skill);
      if (issue) staticIssues.push(issue);
    }
  }
  staticIssues.push(...routerContractIssues(root));
  for (const skill of SUPPORTING_SKILLS) {
    if (existsSync(path.join(root, `.claude/skills/${skill}`))) staticIssues.push({ surface: '.claude', skill, reason: 'supporting skill mirror directory must remain absent' });
  }
  const issues = [...parityIssues, ...staticIssues];
  const status = issues.length ? 'blocked' : 'valid';
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
    mirrorIssues: parityIssues,
    skillContractIssues: staticIssues,
    router: { mappedSkills: readable(path.join(root, `.agents/skills/${ROUTER_SKILL}/SKILL.md`)) ? routedSkillsFromRouter(readFileSync(path.join(root, `.agents/skills/${ROUTER_SKILL}/SKILL.md`), 'utf8')) : [], mirrored: routerResult.identical },
    supportingSkills: { localOnly: SUPPORTING_SKILLS, mirrorsAbsent: SUPPORTING_SKILLS.every((skill) => !existsSync(path.join(root, `.claude/skills/${skill}`))) },
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
    ...overrides,
  };
}

function laneFunctions(lanes, prefix, extra = {}) {
  return Object.fromEntries(lanes.map((lane, index) => {
    const additions = extra[lane.id] ?? {};
    return [lane.id, () => ({ records: [rehearsalJob(prefix, index + 1, { provider: lane.provider ?? 'greenhouse', sourceKind: lane.category === 'direct-ats' ? 'ats-direct' : 'aggregator' })], ...additions })];
  }));
}

// Supply fixture scores through the same explicit boundary as --scores-json.
function rehearsalScores(lanes, prefix) {
  return lanes.map((lane, index) => ({
    url: `https://rehearsal.example/${prefix}/${index + 1}`,
    matchScore: 89 - index,
    responseLikelihood: 18,
    rationale: 'Fixture Python AI requirements match the supplied skills.',
    strongestHook: 'Fixture Python AI systems.',
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

// Run each fixture mode with optional explicit scores and an in-memory gateway.
async function rehearsalModes(includeExplicitScores) {
  const noWrite = { planWrites: ({ operations }) => ({ status: 'planned', operations }) };
  const normal = await runNormalMode({ clock: () => REHEARSAL_NOW, runId: 'rehearsal-normal', sourceFunctions: laneFunctions(NORMAL_SOURCE_LANES, 'normal'), scores: includeExplicitScores ? rehearsalScores(NORMAL_SOURCE_LANES, 'normal') : undefined, notionGateway: noWrite });
  const startupLanes = STARTUP_SOURCE_LANES.filter((lane) => lane.id !== 'funding-hiring-signals');
  const startupFunctions = laneFunctions(startupLanes, 'startup');
  startupFunctions['funding-hiring-signals'] = () => ({ signals: [{ company: 'Rehearsal startup 1', fundingDate: '2026-05-01', fundingEvidence: 'fixture funding evidence', verifiedAt: REHEARSAL_NOW }] });
  const startup = await runStartupMode({ clock: () => REHEARSAL_NOW, runId: 'rehearsal-startup', sourceFunctions: startupFunctions, scores: includeExplicitScores ? rehearsalScores(startupLanes, 'startup') : undefined, notionGateway: noWrite });
  const remote = await runRemoteMode({ clock: () => REHEARSAL_NOW, runId: 'rehearsal-remote', sourceFunctions: laneFunctions(REMOTE_SOURCE_LANES, 'remote'), scores: includeExplicitScores ? rehearsalScores(REMOTE_SOURCE_LANES, 'remote') : undefined, notionGateway: noWrite });
  return { normal, startup, remote };
}

// Rehearse local paths and fail if a fixture mode cannot complete scoring.
export async function runNoWriteRehearsal({ includeExplicitScores = true } = {}) {
  const validation = validateV5Surface();
  const modes = await rehearsalModes(includeExplicitScores);
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
    status: Object.values(modes).some((result) => result.outcome.fatal) ? 'failed' : validation.status === 'valid' ? 'passed' : 'passed-with-environment-blocker',
    validation,
    modes: Object.fromEntries(Object.entries(modes).map(([name, result]) => [name, { status: result.outcome.status, selected: result.shortlist.length, planned: result.plannedNotionOperations.length, scoreOrigins: [...new Set(result.shortlist.map((candidate) => candidate.scoreOrigin))], sources: result.sourceManifests.length, failedSources: result.sourceManifests.filter((source) => ['failed', 'unavailable'].includes(source.status)).length }])),
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

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

export function buildSmokePlan(argv = []) {
  const credentialFile = option(argv, '--credential-file');
  const journalPath = option(argv, '--journal');
  const receiptPath = option(argv, '--receipt');
  const runId = option(argv, '--run-id');
  return {
    schemaVersion: 'LaunchpadV5SmokePlanV1',
    network: false,
    liveWrites: false,
    required: {
      confirmationFlag: '--confirm-live',
      credentialFile: credentialFile ?? '<external path required>',
      journalPath: journalPath ?? '<external path required>',
      receiptPath: receiptPath ?? '<external path required>',
      runId: runId ?? '<unique run ID required>',
    },
    preflight: provisioningPreflight({ manifest: loadManifest(), enabled: Boolean(runId), credentialFile, journalPath, runId }),
  };
}

function writeSmokeReceipt(receiptPath, result) {
  const resolved = path.resolve(receiptPath);
  if (resolved === ROOT || resolved.startsWith(`${ROOT}${path.sep}`)) throw new LaunchpadV5OperatorError('smoke receipt must be outside repository', 'SMOKE_RECEIPT_LOCATION_INVALID');
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 'LaunchpadV5SmokeReceiptV1', recordedAt: new Date().toISOString(), result }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, resolved);
  chmodSync(resolved, 0o600);
  return resolved;
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') { process.stdout.write(buildHelp()); return 0; }
  if (command === 'validate') { const result = validateV5Surface(); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return result.status === 'valid' ? 0 : 1; }
  if (command === 'rehearse') { const result = await runNoWriteRehearsal(); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return result.status === 'passed' ? 0 : 1; }
  if (command === 'smoke-plan') { const result = buildSmokePlan(argv.slice(1)); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0; }
  if (command === 'smoke') {
    if (!argv.includes('--confirm-live')) throw new LaunchpadV5OperatorError('live smoke requires --confirm-live', 'LIVE_CONFIRMATION_REQUIRED');
    const credentialFile = option(argv, '--credential-file');
    const journalPath = option(argv, '--journal');
    const receiptPath = option(argv, '--receipt');
    const runId = option(argv, '--run-id');
    if (!credentialFile || !journalPath || !receiptPath || !runId) throw new LaunchpadV5OperatorError('live smoke requires --credential-file, --journal, --receipt, and --run-id', 'SMOKE_ARGUMENTS_REQUIRED');
    const result = await smokeV5({ enabled: true, credentialFile, journalPath, runId, application: { Role: 'Synthetic AI Engineer', Company: `Launchpad v5 synthetic company ${runId}`, 'Application Ready': true, 'Run ID': runId }, company: { name: `Launchpad v5 synthetic company ${runId}`, canonicalDomain: `${runId}.invalid` } });
    const receipt = writeSmokeReceipt(receiptPath, result);
    process.stdout.write(`${JSON.stringify({ receipt, result }, null, 2)}\n`);
    return result.status === 'passed' ? 0 : 1;
  }
  process.stderr.write(`Unknown command: ${command}\n\n${buildHelp()}`);
  return 2;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1; });
}
