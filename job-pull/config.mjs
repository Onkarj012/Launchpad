import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.resolve(MODULE_DIR, '../config/job-pull.json');
export const DEFAULT_CONVERSION_PLAN_PATH = path.resolve(MODULE_DIR, '../config/conversion-plan.json');

export class JobPullConfigError extends Error {
  constructor(errors) {
    super(`Invalid job-pull policy: ${errors.join('; ')}`);
    this.name = 'JobPullConfigError';
    this.errors = errors;
  }
}

export class ConversionPlanConfigError extends Error {
  constructor(errors) {
    super(`Invalid conversion operations policy: ${errors.join('; ')}`);
    this.name = 'ConversionPlanConfigError';
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

  const shortlist = config.applicationShortlist;
  if (!shortlist || shortlist.targetCount !== 10 || shortlist.maximumStretch !== 1) {
    errors.push('application shortlist must target 10 with at most one stretch role');
  } else {
    const targets = shortlist.roleTargets;
    if (!targets || targets.ai !== 4 || targets.backendFullStack !== 2 || targets.newGrad !== 2 || targets.adjacent !== 1) {
      errors.push('application shortlist role targets must remain 4 AI, 2 backend/full-stack, 2 new-grad, and 1 adjacent');
    }
    const sources = shortlist.sourceTargets;
    if (!sources || sources.directOrVcMinimum !== 4 || sources.indiaNicheMinimum !== 3 || sources.broadRemoteMaximum !== 2) {
      errors.push('application shortlist source targets must remain 4 direct/VC, 3 India niche, and at most 2 broad remote');
    }
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
  if (!sources || !sameArray(sources.knownAts, ['greenhouse', 'lever', 'ashby', 'workday', 'workable', 'smartrecruiters', 'breezy', 'recruitee'])) {
    errors.push('known ATS metadata must include Workable, SmartRecruiters, Breezy, and Recruitee');
  }

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

function exactNumberMap(value, expected, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const [key, number] of Object.entries(expected)) {
    if (value[key] !== number) errors.push(`${label}.${key} must be ${number}`);
  }
  for (const key of Object.keys(value)) {
    if (!(key in expected)) errors.push(`${label}.${key} is not supported`);
  }
}

/** Validate the user-facing conversion policy independently from job discovery. */
export function validateConversionPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return ['policy must be an object'];
  if (plan.version !== 1) errors.push('version must remain 1');
  if (plan.owner !== 'conversion-ops') errors.push('owner must remain conversion-ops');
  const safety = plan.manualSafety;
  if (!safety || safety.apply !== 'user_confirmation_required' || safety.send !== 'user_confirmation_required'
    || safety.notionMutation !== 'proposal_only_until_approved') {
    errors.push('manualSafety must preserve confirmation-only apply/send and proposal-only Notion changes');
  }
  const score = plan.conversionScore;
  exactNumberMap(score?.weights, {
    responsibilitiesAndStack: 25,
    experienceEligibility: 20,
    indiaLocationEligibility: 15,
    projectConnection: 15,
    directOrVcSource: 10,
    humanContact: 10,
    postingFreshness: 5,
  }, 'conversionScore.weights', errors);
  if (!score?.bands || score.bands.readyForManualReview !== 75 || score.bands.manualInspect !== 65) {
    errors.push('conversionScore bands must remain 75 and 65');
  }
  if (score?.bands && Object.keys(score.bands).some((key) => !['readyForManualReview', 'manualInspect'].includes(key))) {
    errors.push('conversionScore.bands has unsupported keys');
  }
  const composition = plan.composition;
  if (!composition || composition.dailySelected !== 10) errors.push('composition.dailySelected must remain 10');
  exactNumberMap(composition?.roleFamilies, {
    aiProductAppliedAi: 4,
    fullStackBackend: 2,
    entrySoftware: 2,
    technicalSolutionsImplementation: 1,
    stretch: 1,
  }, 'composition.roleFamilies', errors);
  exactNumberMap(composition?.sources, {
    minimumDirectOrVc: 4,
    minimumIndianNiche: 3,
    maximumBroadRemote: 2,
    maximumStretch: 1,
  }, 'composition.sources', errors);
  const cadence = plan.cadence;
  if (!cadence || !sameArray(cadence.applicationDays, [3, 7]) || !sameArray(cadence.coldOutreachDays, [4])
    || !sameArray(cadence.conversationDays, [1, 3]) || cadence.maxApplicationFollowUps !== 2
    || cadence.maxColdOutreachFollowUps !== 1 || cadence.silenceClosureDays !== 14) {
    errors.push('cadence must preserve the configured 3/7, 4, 1/3, 2/1, and 14-day rules');
  }
  exactNumberMap(plan.dailyTargets, {
    humanContactsForTopApplications: 5,
    referralAttempts: 3,
    proofOfFitAssets: 2,
    mockInterviewsAcrossSprint: 3,
  }, 'dailyTargets', errors);
  if (!plan.checkpoints || plan.checkpoints.first !== 50 || plan.checkpoints.secondMin !== 70 || plan.checkpoints.secondMax !== 100) {
    errors.push('checkpoints must remain 50 and 70-100');
  }
  if (plan.salaryFloorLpa !== 8) errors.push('salaryFloorLpa must remain 8');
  return errors;
}

export function assertValidConversionPlan(plan) {
  const errors = validateConversionPlan(plan);
  if (errors.length) throw new ConversionPlanConfigError(errors);
  return plan;
}

export function loadConversionPlan(planPath = DEFAULT_CONVERSION_PLAN_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (error) {
    throw new ConversionPlanConfigError([`${planPath}: ${error.message}`]);
  }
  return assertValidConversionPlan(parsed);
}
