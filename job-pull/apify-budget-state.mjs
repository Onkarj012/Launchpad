import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const APIFY_BUDGET_STATE_SCHEMA = 1;
export const DEFAULT_APIFY_BUDGET_STATE_PATH = '.local/launchpad-crawler/apify-budget-state.json';

function monthKey(nowIso) { return String(nowIso).slice(0, 7); }

export function emptyApifyBudgetState() {
  return { schemaVersion: APIFY_BUDGET_STATE_SCHEMA, updatedAt: null, months: {}, retrieval: {} };
}

export function loadApifyBudgetState(file = DEFAULT_APIFY_BUDGET_STATE_PATH) {
  if (!existsSync(file)) return emptyApifyBudgetState();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    const state = emptyApifyBudgetState();
    if (raw && typeof raw === 'object' && raw.months && typeof raw.months === 'object') {
      for (const [month, entry] of Object.entries(raw.months)) {
        state.months[month] = {
          runs: Number(entry?.runs) || 0,
          spendUsd: Number(entry?.spendUsd) || 0,
          estimatedSpendUsd: Number(entry?.estimatedSpendUsd) || 0,
          actualSpendUsd: Number(entry?.actualSpendUsd) || 0,
          estimatedItems: Number(entry?.estimatedItems) || 0,
          actualItems: Number(entry?.actualItems) || 0,
          actualCostKnownRuns: Number(entry?.actualCostKnownRuns) || 0,
        };
      }
      state.updatedAt = raw.updatedAt || null;
      if (raw.retrieval && typeof raw.retrieval === 'object') state.retrieval = structuredClone(raw.retrieval);
    }
    return state;
  } catch {
    return emptyApifyBudgetState();
  }
}

export function saveApifyBudgetState(file = DEFAULT_APIFY_BUDGET_STATE_PATH, state, nowIso) {
  const out = { schemaVersion: APIFY_BUDGET_STATE_SCHEMA, updatedAt: nowIso, months: {} };
  for (const [month, entry] of Object.entries(state?.months ?? {})) out.months[month] = {
    runs: Number(entry?.runs) || 0,
    spendUsd: Number(entry?.spendUsd) || 0,
    estimatedSpendUsd: Number(entry?.estimatedSpendUsd) || 0,
    actualSpendUsd: Number(entry?.actualSpendUsd) || 0,
    estimatedItems: Number(entry?.estimatedItems) || 0,
    actualItems: Number(entry?.actualItems) || 0,
    actualCostKnownRuns: Number(entry?.actualCostKnownRuns) || 0,
  };
  out.retrieval = structuredClone(state?.retrieval ?? {});
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  return out;
}

/** Current month's usage, defaulting to zero if unrecorded. */
export function monthUsage(state, nowIso) {
  return state?.months?.[monthKey(nowIso)] ?? { runs: 0, spendUsd: 0 };
}

/** Would starting one more run of the given estimated cost violate any cap? Returns null if allowed, else a reason code. */
export function budgetBlockReason({ state, nowIso, estimatedCostUsd = 0, monthlyBudgetUsd, maxRunsPerMonth, maxRunCostUsd }) {
  const usage = monthUsage(state, nowIso);
  if (estimatedCostUsd > maxRunCostUsd) return 'RUN_COST_CAP_EXCEEDED';
  if (usage.runs >= maxRunsPerMonth) return 'MONTHLY_RUN_CAP_EXCEEDED';
  if (usage.spendUsd + estimatedCostUsd > monthlyBudgetUsd) return 'MONTHLY_BUDGET_CAP_EXCEEDED';
  return null;
}

/** Record one completed run's cost against the current month, mutating and returning state. */
export function recordApifyRun(state, nowIso, estimatedCostUsd = 0, { estimatedItems = 0, actualItems = 0, actualCostUsd = null } = {}) {
  const key = monthKey(nowIso);
  const usage = state.months[key] ?? { runs: 0, spendUsd: 0, estimatedSpendUsd: 0, actualSpendUsd: 0, estimatedItems: 0, actualItems: 0, actualCostKnownRuns: 0 };
  const estimated = Number(estimatedCostUsd) || 0;
  const actualKnown = actualCostUsd != null && Number.isFinite(Number(actualCostUsd));
  const actual = actualKnown ? Number(actualCostUsd) : estimated;
  state.months[key] = {
    runs: usage.runs + 1,
    spendUsd: usage.spendUsd + actual,
    estimatedSpendUsd: (Number(usage.estimatedSpendUsd) || 0) + estimated,
    actualSpendUsd: (Number(usage.actualSpendUsd) || 0) + (actualKnown ? Number(actualCostUsd) : 0),
    estimatedItems: (Number(usage.estimatedItems) || 0) + (Number(estimatedItems) || 0),
    actualItems: (Number(usage.actualItems) || 0) + (Number(actualItems) || 0),
    actualCostKnownRuns: (Number(usage.actualCostKnownRuns) || 0) + (actualKnown ? 1 : 0),
  };
  return state;
}
