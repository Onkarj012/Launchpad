#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildAgentPlist, installSchedules } from './install-schedule.mjs';
import {
  computeCanaryVersion,
  evaluateDeliveryCanary,
  normalizeCanaryDiscoveryProfile,
} from './canary-evaluator.mjs';

export const RELEASE_RECEIPT_SCHEMA = 'LaunchpadScheduleReleaseReceiptV1';
export const DEFAULT_RELEASE_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Launchpad', 'releases');
export const DEFAULT_RELEASE_STATE = path.join(os.homedir(), 'Library', 'Application Support', 'Launchpad', 'state', 'schedule-release.json');
export const DEFAULT_RELEASE_LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'Launchpad');

const REVISION_RE = /^[0-9a-f]{40}$/i;
const PROFILE_FIELDS = Object.freeze(['schedule', 'mode', 'locationPreset']);

function defaultRunner(command, args, options = {}) {
  return spawnSync(command, args, { ...options, encoding: 'utf8' });
}

export function defaultGitRunner(args, options = {}) {
  return defaultRunner('git', args, options);
}

export function defaultNpmRunner(args, options = {}) {
  return defaultRunner('npm', args, options);
}

function statusOf(result) {
  return {
    status: result?.status ?? null,
    stdout: String(result?.stdout ?? '').trim(),
    stderr: String(result?.stderr ?? '').trim(),
  };
}

function callRunner(runner, args, options) {
  return runner(args, options);
}

function commandOutput(runner, args, cwd, description) {
  const result = statusOf(callRunner(runner, args, { cwd }));
  if (result.status !== 0) {
    throw new Error(`${description} failed${result.stderr ? `: ${result.stderr}` : ''}`);
  }
  return result.stdout;
}

function assertRevision(revision) {
  if (!REVISION_RE.test(String(revision ?? ''))) throw new Error('release revision must be a full 40-hex commit');
  return String(revision).toLowerCase();
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertExternalPath(candidate, sourceRoot, label = 'path') {
  const resolved = path.resolve(candidate);
  if (isInside(sourceRoot, resolved)) throw new Error(`${label} must be outside source repo: ${resolved}`);
  return resolved;
}

function assertExternalRoots({ sourceRoot, releaseRoot, releaseState, logDir }) {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedReleaseRoot = assertExternalPath(releaseRoot, resolvedSourceRoot, 'release root');
  const resolvedReleaseState = assertExternalPath(releaseState, resolvedSourceRoot, 'release state');
  const resolvedLogDir = assertExternalPath(logDir, resolvedSourceRoot, 'release log directory');
  return { sourceRoot: resolvedSourceRoot, releaseRoot: resolvedReleaseRoot, releaseState: resolvedReleaseState, logDir: resolvedLogDir };
}

function cleanStatus(git, cwd, label) {
  const status = commandOutput(git, ['status', '--porcelain'], cwd, `${label} status check`);
  if (status) throw new Error(`${label} checkout is dirty: ${status}`);
  return { clean: true, dirtyPaths: [] };
}

function exactResolvedRevision(git, cwd, revision, label) {
  const resolved = commandOutput(git, ['rev-parse', '--verify', `${revision}^{commit}`], cwd, `${label} revision resolution`);
  if (resolved !== revision) throw new Error(`${label} resolved revision mismatch: expected ${revision}, received ${resolved || 'missing'}`);
  return resolved;
}

export function verifyReleaseCheckout({ releasePath, revision, git = defaultGitRunner, fsApi = fs } = {}) {
  const exactRevision = assertRevision(revision);
  const resolvedPath = path.resolve(releasePath ?? '');
  if (!resolvedPath || !fsApi.existsSync(resolvedPath) || !fsApi.statSync(resolvedPath).isDirectory()) {
    throw new Error(`release checkout is missing: ${resolvedPath}`);
  }
  const head = commandOutput(git, ['rev-parse', 'HEAD'], resolvedPath, 'release checkout HEAD');
  if (head !== exactRevision) throw new Error(`release checkout HEAD mismatch: expected ${exactRevision}, received ${head || 'missing'}`);
  exactResolvedRevision(git, resolvedPath, exactRevision, 'release checkout');
  const status = cleanStatus(git, resolvedPath, 'release checkout');
  const cliPath = path.join(resolvedPath, 'crawler', 'cli.mjs');
  if (!fsApi.existsSync(cliPath) || !fsApi.statSync(cliPath).isFile()) throw new Error(`release checkout is missing crawler/cli.mjs: ${resolvedPath}`);
  return { exactRevision, releasePath: resolvedPath, cliPath, ...status };
}

export function verifySourceCheckout({ sourceRoot = process.cwd(), revision, git = defaultGitRunner } = {}) {
  const exactRevision = assertRevision(revision);
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const status = cleanStatus(git, resolvedSourceRoot, 'source');
  const head = commandOutput(git, ['rev-parse', 'HEAD'], resolvedSourceRoot, 'source HEAD');
  if (head !== exactRevision) throw new Error(`source checkout HEAD mismatch: expected ${exactRevision}, received ${head || 'missing'}`);
  exactResolvedRevision(git, resolvedSourceRoot, exactRevision, 'source');
  return { exactRevision, sourceRoot: resolvedSourceRoot, ...status };
}

export function prepareReleaseCheckout({
  sourceRoot = process.cwd(),
  revision,
  releaseRoot = DEFAULT_RELEASE_ROOT,
  git = defaultGitRunner,
  npm = defaultNpmRunner,
  fsApi = fs,
} = {}) {
  const exactRevision = assertRevision(revision);
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedReleaseRoot = assertExternalPath(releaseRoot, resolvedSourceRoot, 'release root');
  verifySourceCheckout({ sourceRoot: resolvedSourceRoot, revision: exactRevision, git });
  const releasePath = path.join(resolvedReleaseRoot, exactRevision);
  const existed = fsApi.existsSync(releasePath);
  if (existed) {
    const checkout = verifyReleaseCheckout({ releasePath, revision: exactRevision, git, fsApi });
    return { ...checkout, created: false, npmInstalled: false };
  }

  fsApi.mkdirSync(resolvedReleaseRoot, { recursive: true });
  const worktree = statusOf(callRunner(git, ['worktree', 'add', '--detach', releasePath, exactRevision], { cwd: resolvedSourceRoot }));
  if (worktree.status !== 0) throw new Error(`release worktree creation failed${worktree.stderr ? `: ${worktree.stderr}` : ''}`);
  const checkout = verifyReleaseCheckout({ releasePath, revision: exactRevision, git, fsApi });
  const npmResult = statusOf(callRunner(npm, ['ci', '--ignore-scripts'], { cwd: releasePath }));
  if (npmResult.status !== 0) throw new Error(`release npm ci failed${npmResult.stderr ? `: ${npmResult.stderr}` : ''}`);
  return { ...verifyReleaseCheckout({ releasePath, revision: exactRevision, git, fsApi }), created: true, npmInstalled: true };
}

function recordsFrom(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.runs)) return input.runs;
  return [];
}

function sameProfile(left, right) {
  return PROFILE_FIELDS.every((field) => left?.[field] === right?.[field]);
}

export function evaluateProfileCanaries(input = {}, maybeOptions = {}) {
  const options = Array.isArray(input) ? { ...maybeOptions, records: input } : input;
  const records = recordsFrom(options.records ?? options.canaryRecords);
  const profiles = options.profiles ?? [];
  const canaryVersion = options.canaryVersion;
  const requiredRuns = options.requiredRuns;
  const evaluator = options.evaluator ?? evaluateDeliveryCanary;
  const evaluations = profiles.map((rawProfile) => {
    const profile = normalizeCanaryDiscoveryProfile(rawProfile);
    if (!profile) return { profile: rawProfile, passed: false, reasons: ['installed discovery profile is invalid'], records: [], evaluation: null };
    const matching = records.filter((record) => sameProfile(normalizeCanaryDiscoveryProfile(record?.discoveryProfile), profile));
    const reasons = [];
    if (matching.length === 0) reasons.push('no canary records for installed discovery profile');
    const evaluation = evaluator(matching, { requiredRuns });
    if (!evaluation.passed) reasons.push('delivery canary gates did not pass');
    if (evaluation.streak?.version !== canaryVersion) reasons.push('delivery canary streak version does not match release');
    return { profile, passed: reasons.length === 0, reasons, records: matching, evaluation };
  });
  return { passed: evaluations.length > 0 && evaluations.every((item) => item.passed), canaryVersion, profiles: evaluations };
}

export const evaluateInstalledProfileCanaries = evaluateProfileCanaries;

function configForCanary({ config, sourceRoot, configPath }) {
  if (config) return config;
  const resolved = path.resolve(sourceRoot, configPath ?? 'config/crawler-v2.json');
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

export function resolveReleaseCanaryVersion({ canaryVersion, config, sourceRoot = process.cwd(), configPath } = {}) {
  if (typeof canaryVersion === 'string' && canaryVersion.trim()) return canaryVersion.trim();
  return computeCanaryVersion({ config: configForCanary({ config, sourceRoot, configPath }), root: path.resolve(sourceRoot) });
}

function clockTimestamp(clock) {
  const value = typeof clock === 'function' ? clock() : clock?.now?.() ?? clock ?? new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('release clock must produce a valid date');
  return date.toISOString();
}

function defaultProfiles(mode, locationPreset) {
  return ['morning', 'midday'].map((schedule) => ({ schedule, mode, locationPreset }));
}

function normalizeProfiles(profiles, mode, locationPreset) {
  const selected = profiles ?? defaultProfiles(mode, locationPreset);
  if (!Array.isArray(selected) || selected.length === 0) throw new Error('installed discovery profiles are required');
  return selected.map((profile) => {
    const normalized = normalizeCanaryDiscoveryProfile(profile);
    if (!normalized) throw new Error(`invalid installed discovery profile: ${JSON.stringify(profile)}`);
    return normalized;
  });
}

function buildAgents({ releasePath, revision, profiles, logDir, launchAgentsDir, nodePath, scheduleConfig }) {
  return profiles.map((profile) => buildAgentPlist({
    schedule: profile.schedule,
    mode: profile.mode,
    locationPreset: profile.locationPreset,
    repoRoot: releasePath,
    cliPath: path.join(releasePath, 'crawler', 'cli.mjs'),
    nodePath,
    logDir,
    launchAgentsDir,
    releaseRevision: revision,
    releasePath,
    scheduleConfig,
  }));
}

function readReceipt(releaseState, { allowMissing = false, fsApi = fs } = {}) {
  const resolved = path.resolve(releaseState);
  if (!fsApi.existsSync(resolved)) {
    if (allowMissing) return null;
    throw new Error(`release state receipt is missing: ${resolved}`);
  }
  let receipt;
  try {
    receipt = JSON.parse(fsApi.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`release state receipt is malformed: ${error.message}`);
  }
  if (!receipt || receipt.schemaVersion !== RELEASE_RECEIPT_SCHEMA || !receipt.currentRelease) {
    throw new Error('release state receipt is malformed');
  }
  return receipt;
}

function validateReceiptMetadata(receipt, sourceRoot) {
  if (!receipt) return null;
  if (!Object.prototype.hasOwnProperty.call(receipt, 'previousRelease')) throw new Error('release state receipt is malformed');
  return {
    ...receipt,
    currentRelease: validateMetadata(receipt.currentRelease, 'current', sourceRoot),
    previousRelease: receipt.previousRelease === null
      ? null
      : validateMetadata(receipt.previousRelease, 'previous', sourceRoot),
  };
}

function validateMetadata(metadata, label, sourceRoot = null) {
  if (!metadata || typeof metadata !== 'object') throw new Error(`${label} release metadata is missing`);
  const revision = assertRevision(metadata.revision ?? metadata.exactRevision);
  if (typeof metadata.releasePath !== 'string' || !metadata.releasePath) throw new Error(`${label} release path is missing`);
  if (typeof metadata.canaryVersion !== 'string' || !metadata.canaryVersion) throw new Error(`${label} canary version is missing`);
  if (typeof metadata.timestamp !== 'string' || Number.isNaN(new Date(metadata.timestamp).getTime())) throw new Error(`${label} release timestamp is missing or invalid`);
  if (typeof metadata.action !== 'string' || !metadata.action) throw new Error(`${label} release action is missing`);
  if (!Array.isArray(metadata.installedProfiles) || metadata.installedProfiles.length === 0) throw new Error(`${label} installed profiles are missing`);
  const installedProfiles = normalizeProfiles(metadata.installedProfiles);
  const releasePath = path.resolve(metadata.releasePath);
  if (path.basename(releasePath) !== revision) throw new Error(`${label} release path is not content-addressed by revision`);
  if (sourceRoot) assertExternalPath(releasePath, sourceRoot, `${label} release path`);
  return { ...metadata, revision, exactRevision: revision, releasePath, installedProfiles };
}

function receiptMetadata({ revision, releasePath, canaryVersion, installedProfiles, timestamp, action }) {
  return {
    revision,
    exactRevision: revision,
    releasePath: path.resolve(releasePath),
    canaryVersion,
    installedProfiles: installedProfiles.map((profile) => ({ ...profile })),
    timestamp,
    action,
  };
}

export function writeReleaseReceipt({ releaseState, receipt, fsApi = fs } = {}) {
  const resolved = path.resolve(releaseState);
  fsApi.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  fsApi.renameSync(temporary, resolved);
  return resolved;
}

function installSucceeded(result, expectedCount) {
  return Array.isArray(result?.agents)
    && result.agents.length === expectedCount
    && result.agents.every((agent) => agent.installed === true);
}

export function promoteSchedule({
  sourceRoot = process.cwd(),
  revision,
  canaryRecords = [],
  canaryVersion,
  config,
  configPath,
  releaseRoot = DEFAULT_RELEASE_ROOT,
  releaseState = DEFAULT_RELEASE_STATE,
  releaseLogDir = DEFAULT_RELEASE_LOG_DIR,
  launchAgentsDir,
  nodePath = process.execPath,
  mode = 'normal',
  locationPreset = 'india',
  profiles,
  scheduleConfig,
  dryRun = false,
  clock = () => new Date(),
  git = defaultGitRunner,
  npm = defaultNpmRunner,
  launchctl,
  install = installSchedules,
  fsApi = fs,
  uid,
} = {}) {
  const exactRevision = assertRevision(revision);
  const roots = assertExternalRoots({ sourceRoot, releaseRoot, releaseState, logDir: releaseLogDir });
  const installedProfiles = normalizeProfiles(profiles, mode, locationPreset);
  const resolvedCanaryVersion = resolveReleaseCanaryVersion({ canaryVersion, config, sourceRoot: roots.sourceRoot, configPath });
  const canary = evaluateProfileCanaries({ records: canaryRecords, profiles: installedProfiles, canaryVersion: resolvedCanaryVersion });
  const releasePath = path.join(roots.releaseRoot, exactRevision);
  if (!canary.passed) return { promoted: false, blocked: true, dryRun, exactRevision, releasePath, canary, receiptWritten: false, noAutoApply: true, noAutoSend: true };
  if (dryRun) return { promoted: false, dryRun: true, exactRevision, releasePath, canary, receiptWritten: false, noAutoApply: true, noAutoSend: true };

  const previousReceipt = validateReceiptMetadata(readReceipt(roots.releaseState, { allowMissing: true, fsApi }), roots.sourceRoot);
  const prepared = prepareReleaseCheckout({ sourceRoot: roots.sourceRoot, revision: exactRevision, releaseRoot: roots.releaseRoot, git, npm, fsApi });
  const agents = buildAgents({ releasePath: prepared.releasePath, revision: exactRevision, profiles: installedProfiles, logDir: roots.logDir, launchAgentsDir, nodePath, scheduleConfig });
  const installed = install({ dryRun: false, launchctl, agents, uid });
  if (!installSucceeded(installed, agents.length)) {
    return { promoted: false, dryRun: false, exactRevision, releasePath: prepared.releasePath, canary, prepared, install: installed, receiptWritten: false, noAutoApply: true, noAutoSend: true };
  }
  const timestamp = clockTimestamp(clock);
  const currentRelease = receiptMetadata({ revision: exactRevision, releasePath: prepared.releasePath, canaryVersion: resolvedCanaryVersion, installedProfiles, timestamp, action: 'promote' });
  const retainedPreviousRelease = previousReceipt?.currentRelease?.revision === exactRevision
    ? previousReceipt.previousRelease
    : previousReceipt?.currentRelease ?? null;
  const receipt = {
    schemaVersion: RELEASE_RECEIPT_SCHEMA,
    currentRelease,
    previousRelease: retainedPreviousRelease,
    ...currentRelease,
    action: 'promote',
    installed: true,
    noAutoApply: true,
    noAutoSend: true,
  };
  const receiptPath = writeReleaseReceipt({ releaseState: roots.releaseState, receipt, fsApi });
  return { promoted: true, dryRun: false, exactRevision, releasePath: prepared.releasePath, canary, prepared, install: installed, receipt, receiptPath, receiptWritten: true, noAutoApply: true, noAutoSend: true };
}

export function rollbackSchedule({
  sourceRoot = process.cwd(),
  releaseState = DEFAULT_RELEASE_STATE,
  releaseLogDir = DEFAULT_RELEASE_LOG_DIR,
  launchAgentsDir,
  nodePath = process.execPath,
  scheduleConfig,
  dryRun = false,
  clock = () => new Date(),
  git = defaultGitRunner,
  launchctl,
  install = installSchedules,
  fsApi = fs,
  uid,
} = {}) {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedReleaseState = assertExternalPath(releaseState, resolvedSourceRoot, 'release state');
  const resolvedLogDir = assertExternalPath(releaseLogDir, resolvedSourceRoot, 'release log directory');
  const receipt = readReceipt(resolvedReleaseState, { fsApi });
  const currentRelease = validateMetadata(receipt.currentRelease, 'current', resolvedSourceRoot);
  const previousRelease = validateMetadata(receipt.previousRelease, 'previous', resolvedSourceRoot);
  const agents = buildAgents({
    releasePath: previousRelease.releasePath,
    revision: previousRelease.revision,
    profiles: previousRelease.installedProfiles,
    logDir: resolvedLogDir,
    launchAgentsDir,
    nodePath,
    scheduleConfig,
  });
  if (dryRun) return { rolledBack: false, dryRun: true, currentRelease, previousRelease, agents, receiptWritten: false, noAutoApply: true, noAutoSend: true };

  const verified = verifyReleaseCheckout({ releasePath: previousRelease.releasePath, revision: previousRelease.revision, git, fsApi });
  const installed = install({ dryRun: false, launchctl, agents, uid });
  if (!installSucceeded(installed, agents.length)) {
    return { rolledBack: false, dryRun: false, currentRelease, previousRelease, verified, install: installed, receiptWritten: false, noAutoApply: true, noAutoSend: true };
  }
  const timestamp = clockTimestamp(clock);
  const nextCurrent = receiptMetadata({ ...previousRelease, timestamp, action: 'rollback' });
  const nextPrevious = receiptMetadata({ ...currentRelease, timestamp: currentRelease.timestamp, action: currentRelease.action ?? 'promote' });
  const nextReceipt = {
    schemaVersion: RELEASE_RECEIPT_SCHEMA,
    currentRelease: nextCurrent,
    previousRelease: nextPrevious,
    ...nextCurrent,
    action: 'rollback',
    installed: true,
    noAutoApply: true,
    noAutoSend: true,
  };
  const receiptPath = writeReleaseReceipt({ releaseState: resolvedReleaseState, receipt: nextReceipt, fsApi });
  return { rolledBack: true, dryRun: false, currentRelease: nextCurrent, previousRelease: nextPrevious, verified, install: installed, receipt: nextReceipt, receiptPath, receiptWritten: true, noAutoApply: true, noAutoSend: true };
}

export const promote = promoteSchedule;
export const rollback = rollbackSchedule;
export const prepareRelease = prepareReleaseCheckout;
export const verifyRelease = verifyReleaseCheckout;
export const evaluateCanaries = evaluateProfileCanaries;
