const SCHEMA_VERSION = 'LaunchpadCrawlerSchedulePlanV1';
const TIMEZONE = 'Asia/Kolkata';

const morningStages = [
  { id: 'ats-warm', label: 'Warm ATS', sourceClass: 'ats-warm' },
  { id: 'ats-expanded', label: 'Expanded ATS', sourceClass: 'ats-expanded', dependsOn: ['ats-warm'] },
  { id: 'career-pages', label: 'Company career pages', sourceClass: 'career-pages' },
  { id: 'brave-startup', label: 'Brave and startup lanes', sourceClass: 'brave-startup' },
  { id: 'connector-imports', label: 'Connector imports', sourceClass: 'connector-imports' },
  {
    id: 'normalize-verify',
    label: 'Normalization and verification',
    processing: true,
    dependsOn: ['ats-warm', 'ats-expanded', 'career-pages', 'brave-startup', 'connector-imports'],
  },
  { id: 'selection', label: 'Reserve and shortlist selection', processing: true, dependsOn: ['normalize-verify'] },
];

const middayStages = [
  { id: 'ats-refresh', label: 'Warm ATS refresh', sourceClass: 'ats-refresh' },
  { id: 'career-pages-refresh', label: 'Changed career pages', sourceClass: 'career-pages-refresh' },
  { id: 'connector-imports', label: 'Connector imports', sourceClass: 'connector-imports' },
  { id: 'normalize-verify', label: 'Normalization and verification', processing: true, dependsOn: ['ats-refresh', 'career-pages-refresh', 'connector-imports'] },
  { id: 'selection', label: 'Reserve and shortlist selection', processing: true, dependsOn: ['normalize-verify'] },
];

const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

export const DEFAULT_SCHEDULE_CONFIG = freeze({
  timezone: TIMEZONE,
  schedules: {
    morning: {
      cadence: { kind: 'daily', timezone: TIMEZONE, window: { start: '04:30', end: '07:30' } },
      stages: morningStages,
    },
    midday: {
      cadence: { kind: 'daily', timezone: TIMEZONE, at: '12:30' },
      stages: middayStages,
    },
  },
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const asArray = (value) => Array.isArray(value) ? value : [];

function stageEntries(schedule, configuredStages) {
  if (Array.isArray(configuredStages)) return configuredStages.map((stage) => ({ ...stage }));
  const overrides = configuredStages && typeof configuredStages === 'object' ? configuredStages : {};
  return schedule === 'morning'
    ? morningStages.map((stage) => ({ ...stage, ...(overrides[stage.id] || {}) }))
    : middayStages.map((stage) => ({ ...stage, ...(overrides[stage.id] || {}) }));
}

/** Validate dependencies and return a stable topological order of enabled stages. */
export function validateStageDependencies(stages) {
  const entries = asArray(stages).map((stage) => ({ ...stage, dependsOn: asArray(stage.dependsOn) }));
  const ids = new Set();
  for (const stage of entries) {
    if (!stage.id || ids.has(stage.id)) throw new Error(`Duplicate stage identity: ${stage.id || '<missing>'}`);
    ids.add(stage.id);
  }
  const enabled = entries.filter((stage) => stage.enabled !== false);
  const enabledIds = new Set(enabled.map((stage) => stage.id));
  for (const stage of enabled) {
    for (const dependency of stage.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Missing dependency '${dependency}' for stage '${stage.id}'`);
      if (!enabledIds.has(dependency)) throw new Error(`Disabled dependency '${dependency}' for stage '${stage.id}'`);
    }
  }

  const order = [];
  const remaining = new Map(enabled.map((stage) => [stage.id, new Set(stage.dependsOn)]));
  while (remaining.size) {
    const stage = enabled.find((candidate) => remaining.has(candidate.id) && remaining.get(candidate.id).size === 0);
    if (!stage) throw new Error('Stage dependency cycle detected');
    order.push(stage.id);
    remaining.delete(stage.id);
    for (const deps of remaining.values()) deps.delete(stage.id);
  }
  return order;
}

function disableDependents(stages) {
  const result = stages.map((stage) => ({ ...stage, dependsOn: asArray(stage.dependsOn) }));
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of result) {
      if (stage.enabled === false) continue;
      if (stage.dependsOn.some((dependency) => result.find((candidate) => candidate.id === dependency)?.enabled === false)) {
        stage.enabled = false;
        changed = true;
      }
    }
  }
  return result;
}

function configForSchedule(input, schedule) {
  const schedules = input?.schedules || {};
  const configured = schedules[schedule] || {};
  return {
    cadence: { ...(schedule === 'morning' ? DEFAULT_SCHEDULE_CONFIG.schedules.morning.cadence : DEFAULT_SCHEDULE_CONFIG.schedules.midday.cadence), ...(configured.cadence || {}) },
    stages: stageEntries(schedule, configured.stages),
  };
}

function buildPlan(input, schedule) {
  const configured = configForSchedule(input, schedule);
  const stages = disableDependents(configured.stages);
  const order = validateStageDependencies(stages);
  const disabledStageIds = stages.filter((stage) => stage.enabled === false).map((stage) => stage.id);
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const outputStages = order.map((id) => ({
    ...byId.get(id),
    identity: `${schedule}.${id}`,
    dependsOn: asArray(byId.get(id).dependsOn),
  }));
  return {
    schemaVersion: SCHEMA_VERSION,
    scheduleId: schedule,
    timezone: configured.cadence.timezone || input?.timezone || TIMEZONE,
    cadence: configured.cadence,
    order,
    stages: outputStages,
    disabledStageIds,
    safety: { network: false, scheduling: false, autoApply: false },
    noAutoApply: true,
  };
}

export function buildSchedulePlans(config = DEFAULT_SCHEDULE_CONFIG) {
  const suppliedSchedules = config?.schedules || config || {};
  const input = {
    timezone: config?.timezone || TIMEZONE,
    schedules: { ...DEFAULT_SCHEDULE_CONFIG.schedules, ...suppliedSchedules },
  };
  const scheduleIds = Object.keys(input.schedules);
  return Object.fromEntries(scheduleIds.map((schedule) => [schedule, buildPlan(input, schedule)]));
}

export function serializeSchedulePlans(plans) {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, plans: clone(plans) });
}

/** Execute a built plan once. An external cron/launchd timer owns invocation. */
export async function executeSchedulePlan(plan, { handlers = {}, context = {} } = {}) {
  if (!plan?.scheduleId || !Array.isArray(plan.stages)) throw new TypeError('executeSchedulePlan requires a built schedule plan');
  const stages = {};
  for (const stage of plan.stages) {
    const blockedBy = asArray(stage.dependsOn).filter((dependency) => !['completed', 'degraded'].includes(stages[dependency]?.status));
    if (blockedBy.length) {
      stages[stage.id] = { status: 'blocked', blockedBy };
      continue;
    }
    const handler = handlers[stage.id] ?? handlers[stage.sourceClass];
    if (typeof handler !== 'function') {
      stages[stage.id] = { status: 'unavailable', error: 'stage handler is not configured' };
      continue;
    }
    try {
      const value = await handler({ plan, stage, context, stages });
      stages[stage.id] = { status: value?.status === 'degraded' ? 'degraded' : 'completed', value: value ?? null };
    } catch (error) {
      stages[stage.id] = { status: 'failed', error: error?.message || String(error) };
    }
  }
  const values = Object.values(stages);
  const status = values.some((stage) => ['failed', 'blocked', 'unavailable'].includes(stage.status))
    ? 'degraded'
    : values.some((stage) => stage.status === 'degraded') ? 'degraded' : 'completed';
  return {
    schemaVersion: 'LaunchpadCrawlerScheduleExecutionV1',
    scheduleId: plan.scheduleId,
    timezone: plan.timezone,
    status,
    stages,
    noAutoApply: true,
    noAutoSend: true,
  };
}

export default buildSchedulePlans;
