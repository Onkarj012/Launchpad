import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.resolve(MODULE_DIR, '../config/job-pull.json');

export class JobPullConfigError extends Error {
  constructor(errors) {
    super(`Invalid job-pull policy: ${errors.join('; ')}`);
    this.name = 'JobPullConfigError';
    this.errors = errors;
  }
}

function isStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim());
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['policy must be an object'];
  if (config.schemaVersion !== 'JobPullPolicyV2') errors.push('schemaVersion must be JobPullPolicyV2');
  if (config.timezone !== 'Asia/Kolkata') errors.push('timezone must remain Asia/Kolkata');

  const run = config.run;
  if (!run || typeof run !== 'object') errors.push('run section is required');
  else {
    if (run.cadence !== 'manual') errors.push('run.cadence must remain manual');
    if (run.onceDaily !== true) errors.push('run.onceDaily must remain true');
    if (run.minimumTotal !== 25 || run.maximumTotal !== 35) errors.push('run total target must remain 25-35');
    if (run.strictTarget !== 10) errors.push('run.strictTarget must remain 10');
    if (run.maximumPerCompany !== 2) errors.push('run.maximumPerCompany must remain 2');
    if (run.maximumFamilyShare !== 0.4) errors.push('run.maximumFamilyShare must remain 0.4');
  }

  const freshness = config.freshness;
  if (!freshness || freshness.hotMaximumHours !== 72 || freshness.activeMaximumDays !== 7 || freshness.backfillMaximumDays !== 14) {
    errors.push('freshness boundaries must remain 72 hours, 7 days, and 14 days');
  }

  const geo = config.geo;
  if (!geo || geo.homeCountry !== 'India') errors.push('geo.homeCountry must remain India');
  else {
    for (const field of ['puneMetroAliases', 'remoteAllowedScopes', 'remoteDeniedScopes']) {
      if (!isStringArray(geo[field])) errors.push(`geo.${field} must be a non-empty string array`);
    }
  }

  const employment = config.employment;
  if (!employment || !sameArray(employment.allowedTypes, ['full-time', 'internship'])) {
    errors.push('employment.allowedTypes must be full-time and internship');
  } else {
    if (employment.internshipRequiresExplicitPaid !== true) errors.push('internships must require explicit paid evidence');
    if (employment.rejectUnpaid !== true) errors.push('unpaid roles must be rejected');
  }

  const experience = config.experience;
  if (!experience || experience.strictMaximumYears !== 1 || experience.relaxedMaximumYears !== 2 || experience.hardRejectMinimumYears !== 3) {
    errors.push('experience boundaries must remain strict 1, relaxed 2, hard reject 3');
  }

  const roles = config.roles;
  if (!roles || !isStringArray(roles.families)) errors.push('roles.families must be a non-empty string array');
  if (!roles || roles.maximumFamilyShare !== 0.4) errors.push('roles.maximumFamilyShare must remain 0.4');

  const sources = config.sources;
  if (!sources || !sameArray(sources.qualityOrder, ['ats-direct', 'niche-public', 'aggregator'])) errors.push('source quality order is locked');
  if (!sources || !sameArray(sources.reverseAts, ['greenhouse', 'lever', 'ashby', 'workday'])) errors.push('all four reverse ATS providers are required');

  const dedup = config.dedup;
  if (!dedup || dedup.simHashEnabled !== true || dedup.simHashSimilarity !== 0.93) errors.push('SimHash policy is locked');
  return errors;
}

export function assertValidConfig(config) {
  const errors = validateConfig(config);
  if (errors.length) throw new JobPullConfigError(errors);
  return config;
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new JobPullConfigError([`${configPath}: ${error.message}`]);
  }
  return assertValidConfig(parsed);
}
