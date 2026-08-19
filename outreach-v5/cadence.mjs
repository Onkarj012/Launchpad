export const OUTREACH_CADENCE = Object.freeze([
  Object.freeze({ day: 0, action: 'Initial', eventType: 'Initial Sent', label: 'Day 0 initial contact' }),
  Object.freeze({ day: 3, action: 'Follow-up 1', eventType: 'Follow-up 1 Sent', label: 'Day 3 follow-up 1' }),
  Object.freeze({ day: 10, action: 'Follow-up 2', eventType: 'Follow-up 2 Sent', label: 'Day 10 follow-up 2' }),
  Object.freeze({ day: 17, action: 'Close', eventType: null, label: 'Day 17 silent closure' }),
]);

export const STOP_RESPONSES = Object.freeze(['Replied', 'No', 'Opt Out', 'Opted Out', 'Rejected', 'Closed', 'Withdrawn']);
export const TERMINAL_APPLICATION_STATUSES = Object.freeze(['Rejected', 'Withdrawn', 'Not Pursuing', 'Closed/Expired', 'Offer']);
const NON_RESPONSE_VALUES = new Set(['noresponse', 'noreply', 'pending', 'awaitingreply']);

function iso(value) {
  const date = new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('invalid outreach cadence date');
  return date.toISOString();
}

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function text(value) { return String(value ?? '').trim(); }
function normalized(value) { return text(value).toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ''); }

function eventType(activity) { return activity?.eventType ?? activity?.['Event Type'] ?? activity?.values?.eventType ?? null; }
function eventAt(activity) { return activity?.eventAt ?? activity?.['Event At'] ?? activity?.values?.eventAt ?? null; }
function responseOf(sequence) { return sequence?.response ?? sequence?.Response ?? sequence?.responseOutcome ?? sequence?.['Response Outcome'] ?? sequence?.outcome ?? null; }
function sentOf(sequence) { return sequence?.sent === true || sequence?.['Sent?'] === true || sequence?.values?.sent === true; }
function sentAtOf(sequence) { return sequence?.sentAt ?? sequence?.['Sent At'] ?? sequence?.values?.sentAt ?? null; }

export function stopReason({ application = {}, sequence = {}, activities = [] } = {}) {
  if (TERMINAL_APPLICATION_STATUSES.includes(application.status)) return application.status;
  const response = text(responseOf(sequence));
  if (STOP_RESPONSES.some((value) => normalized(value) === normalized(response))) return response;
  if (response && !NON_RESPONSE_VALUES.has(normalized(response))) return response;
  if (activities.some((activity) => STOP_RESPONSES.some((value) => normalized(value) === normalized(eventType(activity))))) {
    return activities.find((activity) => STOP_RESPONSES.some((value) => normalized(value) === normalized(eventType(activity))))?.eventType ?? 'Stopped';
  }
  return null;
}

export function cadencePlan({ initialSentAt = null } = {}) {
  if (!initialSentAt) return OUTREACH_CADENCE.map((action) => ({ ...action, dueAt: null, state: action.day === 0 ? 'ready' : 'blocked-until-initial-send' }));
  return OUTREACH_CADENCE.map((action) => ({ ...action, dueAt: addDays(initialSentAt, action.day), state: 'scheduled' }));
}

function eventFor(activities, type) {
  return activities.filter((activity) => eventType(activity) === type).sort((a, b) => String(eventAt(a)).localeCompare(String(eventAt(b))))[0] ?? null;
}

/** Derive the operator-facing state from Outreach plus append-only Activity. */
export function deriveOutreachState({ application = {}, sequence = {}, activities = [], now = () => Date.now() } = {}) {
  const stopped = stopReason({ application, sequence, activities });
  if (stopped) return { state: 'Stopped', nextAction: null, nextEligibleContact: null, due: false, stopReason: stopped, cadence: cadencePlan({ initialSentAt: sentAtOf(sequence) }) };
  const initial = sentOf(sequence) || Boolean(eventFor(activities, 'Initial Sent'));
  const initialSentAt = eventAt(eventFor(activities, 'Initial Sent')) ?? sentAtOf(sequence);
  if (!initial || !initialSentAt) return { state: 'Draft', nextAction: 'Send manually', nextEligibleContact: null, due: false, stopReason: null, cadence: cadencePlan() };

  const followup1 = Boolean(eventFor(activities, 'Follow-up 1 Sent'));
  const followup2 = Boolean(eventFor(activities, 'Follow-up 2 Sent'));
  const nowDate = new Date(typeof now === 'function' ? now() : now);
  if (Number.isNaN(nowDate.getTime())) throw new Error('invalid outreach state clock');
  const plan = cadencePlan({ initialSentAt });
  if (nowDate >= new Date(plan[3].dueAt)) return { state: 'Closed', nextAction: null, nextEligibleContact: null, due: false, stopReason: 'Cadence Closed', cadence: plan };
  if (followup2) return { state: 'Sent', nextAction: 'Close', nextEligibleContact: plan[3].dueAt, due: nowDate >= new Date(plan[3].dueAt), stopReason: null, cadence: plan };
  if (followup1) return { state: 'Follow-up 1 Sent', nextAction: 'Follow-up 2', nextEligibleContact: plan[2].dueAt, due: nowDate >= new Date(plan[2].dueAt), stopReason: null, cadence: plan };
  return { state: 'Sent', nextAction: 'Follow-up 1', nextEligibleContact: plan[1].dueAt, due: nowDate >= new Date(plan[1].dueAt), stopReason: null, cadence: plan };
}

export function dueCadenceAction({ application = {}, sequence = {}, activities = [], now = () => Date.now() } = {}) {
  const derived = deriveOutreachState({ application, sequence, activities, now });
  if (derived.state === 'Closed') return { ...derived, action: 'Close' };
  if (derived.stopReason || derived.state === 'Draft') return { ...derived, action: derived.nextAction === 'Send manually' ? 'Initial' : null };
  if (derived.nextAction === 'Close') return { ...derived, action: derived.due ? 'Close' : null };
  return { ...derived, action: derived.due ? derived.nextAction : null };
}

export function cadenceActionForDay(day) {
  return OUTREACH_CADENCE.find((action) => action.day === day) ?? null;
}
