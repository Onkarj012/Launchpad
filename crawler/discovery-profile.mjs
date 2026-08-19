export const DISCOVERY_PROFILE_SCHEMA_VERSION = 'LaunchpadDiscoveryProfileV1';
export const DISCOVERY_MODES = Object.freeze(['normal', 'startup', 'remote']);
export const LOCATION_PRESETS = Object.freeze(['pune', 'india']);
export const DISCOVERY_SCHEDULES = Object.freeze(['morning', 'midday']);
export const SHARED_GATE_POLICY = 'shared-v5';

const MODE_SOURCE_PLANS = Object.freeze({
  normal: Object.freeze({
    lanes: Object.freeze(['warm-ats', 'expanded-ats', 'enterprise-ats', 'portals']),
    priority: Object.freeze(['direct-ats', 'employer-careers', 'resolved-portals', 'connectors']),
    queryHints: Object.freeze(['software engineer', 'backend engineer', 'machine learning engineer', 'AI engineer']),
  }),
  startup: Object.freeze({
    lanes: Object.freeze(['startup-ats', 'startup-employers', 'yc-india', 'vc-portfolios']),
    priority: Object.freeze(['startup-ats', 'startup-employers', 'yc-india', 'vc-portfolios', 'resolved-portals']),
    queryHints: Object.freeze(['AI engineer startup', 'machine learning engineer startup', 'backend engineer startup']),
  }),
  remote: Object.freeze({
    lanes: Object.freeze(['remote-ats', 'native-remote-feeds', 'remote-employers', 'resolved-portals']),
    priority: Object.freeze(['india-remote', 'worldwide-remote', 'remote-ats', 'native-remote-feeds']),
    queryHints: Object.freeze(['India remote software engineer', 'India remote AI engineer', 'worldwide remote backend engineer']),
  }),
});

const LOCATION_HINTS = Object.freeze({
  india: Object.freeze({
    priority: Object.freeze(['india']),
    queryHints: Object.freeze(['India', 'India eligible']),
  }),
  pune: Object.freeze({
    priority: Object.freeze(['pune-employers', 'pune-pcmc', 'india-remote', 'india']),
    queryHints: Object.freeze(['Pune', 'Pune/PCMC', 'India remote']),
  }),
});

function normalizeChoice(value, choices, label) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (!choices.includes(normalized)) {
    throw new RangeError(`Unsupported ${label}: ${String(value)}`);
  }
  return normalized;
}

export function buildDiscoveryProfile({
  mode = 'normal',
  locationPreset = 'india',
  schedule = 'morning',
} = {}) {
  const normalizedMode = normalizeChoice(mode, DISCOVERY_MODES, 'mode');
  const normalizedLocationPreset = normalizeChoice(locationPreset, LOCATION_PRESETS, 'locationPreset');
  const normalizedSchedule = normalizeChoice(schedule, DISCOVERY_SCHEDULES, 'schedule');
  const modePlan = MODE_SOURCE_PLANS[normalizedMode];
  const locationPlan = LOCATION_HINTS[normalizedLocationPreset];

  return {
    schemaVersion: DISCOVERY_PROFILE_SCHEMA_VERSION,
    mode: normalizedMode,
    locationPreset: normalizedLocationPreset,
    schedule: normalizedSchedule,
    sourcePlan: {
      priority: [...locationPlan.priority, ...modePlan.priority],
      lanes: [...modePlan.lanes],
      queryHints: [...locationPlan.queryHints, ...modePlan.queryHints],
    },
    gatePolicy: SHARED_GATE_POLICY,
    noAutoApply: true,
  };
}
