import fs from 'node:fs';
import path from 'node:path';
import { warmAtsProbeFeed } from './ats-warm.mjs';
import { createAtsBatch1Adapters } from './ats-batch-1.mjs';
import { ATS_BATCH_2_PROVIDERS, batch2ProbeFeed } from './ats-batch-2.mjs';
import { enterpriseProbeFeed } from './ats-enterprise.mjs';
import { ENTRY_BUILDERS, WARM_ATS } from '../job-pull/warm-set.mjs';

export const BOARD_REGISTRY_SCHEMA = 'BoardRegistryV1';
export const DEFAULT_BOARD_REGISTRY_PATH = 'config/board-registry.json';
export const REGISTRY_SEED_TIERS = Object.freeze(['pune-gcc-captive', 'pune-product', 'india-ai-devtools', 'services-major']);

export const SCHEDULE_LANES = Object.freeze(['atsWarm', 'atsBatch1', 'atsBatch2', 'enterprise']);
export const SOURCE_PLAN_TIERS = Object.freeze(['daily-core', 'targeted-enterprise', 'exploration', 'opportunistic']);
export const DEFAULT_SOURCE_PLAN_ALLOCATION = Object.freeze({ priorityShare: 0.8, explorationShare: 0.2 });

/** Provider family → scheduled crawler source section that consumes it. */
export const PROVIDER_LANES = Object.freeze({
  greenhouse: 'atsWarm',
  lever: 'atsWarm',
  ashby: 'atsWarm',
  smartrecruiters: 'atsBatch1',
  workable: 'atsBatch1',
  teamtailor: 'atsBatch1',
  recruitee: 'atsBatch1',
  breezy: 'atsBatch2',
  bamboohr: 'atsBatch2',
  personio: 'atsBatch2',
  comeet: 'atsBatch2',
  pinpoint: 'atsBatch2',
  rippling: 'atsBatch2',
  workday: 'enterprise',
});

const ALL_CAPS = Object.freeze({
  listingEnumeration: true,
  detailRetrieval: true,
  dateEvidence: true,
  liveness: true,
  applicationUrl: true,
});

/** Reasonable per-provider capability defaults (adapters already implement these). */
export const DEFAULT_CAPABILITIES = Object.freeze({
  greenhouse: { ...ALL_CAPS },
  lever: { ...ALL_CAPS },
  ashby: { ...ALL_CAPS },
  smartrecruiters: { ...ALL_CAPS },
  workable: { ...ALL_CAPS },
  teamtailor: { ...ALL_CAPS },
  recruitee: { ...ALL_CAPS },
  breezy: { ...ALL_CAPS },
  bamboohr: { ...ALL_CAPS },
  personio: { ...ALL_CAPS },
  comeet: { ...ALL_CAPS },
  pinpoint: {
    listingEnumeration: true,
    detailRetrieval: false,
    dateEvidence: false,
    liveness: true,
    applicationUrl: true,
  },
  rippling: { ...ALL_CAPS },
  workday: { ...ALL_CAPS },
});

export function emptyHealth() {
  return {
    lastSuccessfulFetchAt: null,
    recentFreshEligibleYield: 0,
    recentReadyRoleYield: 0,
    repeatedFailureCount: 0,
  };
}

export function defaultCapabilities(provider) {
  const key = String(provider || '').toLowerCase();
  return { ...(DEFAULT_CAPABILITIES[key] ?? ALL_CAPS) };
}

function clean(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function titleCaseSlug(slug) {
  return String(slug || '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || null;
}

/** Stable identity: provider + board key (slug, board id, or workday triple). */
export function boardIdentityKey(board) {
  const provider = clean(board?.provider)?.toLowerCase();
  if (!provider) return null;
  if (provider === 'workday') {
    const triple = clean(board.boardKey)
      || [board.tenant, board.instance, board.site].map(clean).filter(Boolean).join('|');
    return triple ? `workday:${triple}` : null;
  }
  const id = clean(board.boardKey) || clean(board.slug) || clean(board.board);
  return id ? `${provider}:${id}` : null;
}

function rotate(values, cursor) {
  if (!values.length) return [];
  const start = Math.max(0, Number(cursor) || 0) % values.length;
  return [...values.slice(start), ...values.slice(0, start)];
}

function rotateRanked(values, cursor, compare) {
  const ranked = [...values].sort(compare);
  const groups = [];
  for (const item of ranked) {
    const group = groups.at(-1);
    if (!group || compare(group[0], item) !== 0) groups.push([item]);
    else group.push(item);
  }
  return groups.flatMap((group) => rotate(group, typeof cursor === 'function' ? cursor(group) : cursor));
}

// Prefer newer registry evidence over a saved rotation observation.
function boardWithProbeState(board, state = {}) {
  const id = normalizedBoardId(board);
  const saved = state?.boards?.[id] || state?.boardPlanState?.boards?.[id];
  if (!saved?.probe || Date.parse(board.probedAt || board.probe?.probedAt) > Date.parse(saved.probe.probedAt)) return board;
  return { ...board, probe: saved.probe,
    ...(typeof saved.puneRelevant === 'boolean' ? { puneRelevant: saved.puneRelevant } : {}),
    ...(typeof saved.indiaRelevant === 'boolean' ? { indiaRelevant: saved.indiaRelevant } : {}),
  };
}

// Pause only complete US-only evidence whose zero-India streak spans seven days.
export function boardPauseReason(board, state = {}, runAt = new Date().toISOString()) {
  const probe = boardWithProbeState(board, state).probe;
  if (probe?.usOnly !== true || probe.complete !== true || probe.indiaJobCount !== 0) return null;
  const elapsed = Date.parse(runAt) - Date.parse(probe.zeroIndiaSince);
  return elapsed >= 7 * 86_400_000 ? 'us-only-zero-india-yield-7-days' : null;
}

// Keep verified Pune supply ahead of rotation within each relevance group.
function puneFirst(left, right) {
  return Number(right.puneRelevant === true) - Number(left.puneRelevant === true)
    || Number(right.indiaRelevant === true || right.indiaFirst === true) - Number(left.indiaRelevant === true || left.indiaFirst === true)
    || Number(right.probeStatus === 'verified') - Number(left.probeStatus === 'verified');
}

export function planBoardRotation({ boards = [], maxBoards = boards.length, providerQuotas = {}, state = {}, runAt = new Date().toISOString(), seenBoardIds = [] } = {}) {
  const configured = [];
  const duplicateConfigured = [];
  const ids = new Set();
  for (const input of boards) {
    const board = boardWithProbeState(input, state);
    const id = boardIdentityKey(board);
    if (!id || ids.has(id)) {
      duplicateConfigured.push({ boardId: id, provider: board?.provider ?? null, reason: 'duplicate-configured-board' });
      continue;
    }
    ids.add(id);
    configured.push({ ...board, rotationBoardId: id });
  }
  configured.sort((left, right) => String(left.rotationBoardId).localeCompare(String(right.rotationBoardId)));
  const cap = Math.max(0, Math.min(configured.length, Number(maxBoards) || 0));
  const seen = new Set(seenBoardIds);
  const eligible = configured.filter((board) => !seen.has(board.rotationBoardId) && !boardPauseReason(board, state, runAt));
  const selected = [];
  const selectedIds = new Set();
  const providerCursors = { ...(state.providerCursors || {}) };
  const rotationGroups = new Map();
  // Advance each geographic peer group by the boards it actually selected.
  const groupCursor = (pool) => (group) => {
    const key = `${pool}:${group.map((board) => board.rotationBoardId).sort().join(',')}`;
    const cursor = Math.max(0, Number(state.rankGroupCursors?.[key]) || 0);
    rotationGroups.set(key, { group, cursor });
    return cursor;
  };
  for (const board of rotateRanked(eligible, groupCursor('all'), puneFirst).filter((entry) => entry.puneRelevant === true)) {
    if (selected.length >= cap) break;
    selected.push(board); selectedIds.add(board.rotationBoardId);
  }
  for (const [provider, rawQuota] of Object.entries(providerQuotas)) {
    const quota = Math.max(0, Math.min(cap - selected.length, Number(rawQuota) || 0));
    const family = eligible.filter((board) => String(board.provider).toLowerCase() === String(provider).toLowerCase());
    for (const board of rotateRanked(family, groupCursor(provider), puneFirst)) {
      if (selected.length >= cap || selected.filter((item) => item.provider === board.provider).length >= quota) break;
      if (!selectedIds.has(board.rotationBoardId)) { selected.push(board); selectedIds.add(board.rotationBoardId); }
    }
    providerCursors[provider] = family.length ? (Number(providerCursors[provider] || 0) + quota) % family.length : 0;
  }
  for (const board of rotateRanked(eligible, groupCursor('all'), puneFirst)) {
    if (selected.length >= cap) break;
    if (!selectedIds.has(board.rotationBoardId)) { selected.push(board); selectedIds.add(board.rotationBoardId); }
  }
  const omissions = [
    ...duplicateConfigured,
    ...configured.filter((board) => !selectedIds.has(board.rotationBoardId)).map((board) => ({
      boardId: board.rotationBoardId,
      provider: board.provider,
      reason: boardPauseReason(board, state, runAt) || (seen.has(board.rotationBoardId) ? 'already-attempted-this-run' : cap === 0 ? 'board-cap-zero' : 'due-in-later-rotation-window'),
    })),
  ];
  return {
    boards: selected.sort(puneFirst),
    telemetry: {
      boardsConfigured: configured.length,
      boardsAttempted: selected.length,
      boardsOmitted: omissions.length,
      omissions,
      providerQuotas: { ...providerQuotas },
      rotationWindowRuns: configured.length ? Math.ceil(configured.length / Math.max(1, cap)) : 0,
    },
    state: {
      cursor: eligible.length ? (Number(state.cursor || 0) + Math.max(1, cap)) % eligible.length : 0,
      providerCursors,
      rankGroupCursors: { ...state.rankGroupCursors, ...Object.fromEntries([...rotationGroups].map(([key, { group, cursor }]) => {
        // Fallback picks can leave gaps, so keep the next unvisited peer at the cursor.
        const nextUnselected = rotate(group, cursor).findIndex((board) => !selectedIds.has(board.rotationBoardId));
        return [key, (cursor + (nextUnselected < 0 ? group.length : nextUnselected)) % group.length];
      })) },
      lastAttemptByBoard: Object.fromEntries(selected.map((board) => [board.rotationBoardId, runAt])),
      ...(state.boardPlanState ? { boardPlanState: state.boardPlanState } : {}),
    },
  };
}

function normalizedBoardId(board) {
  const id = boardIdentityKey(board);
  return id ? id.toLowerCase() : null;
}

function boardPlanLane(board, lane) {
  const provider = String(board?.provider || '').toLowerCase();
  return PROVIDER_LANES[provider] || lane || null;
}

function boardPlanText(board) {
  return [board?.company, board?.board, board?.slug, board?.boardKey, board?.notes, board?.evidenceRef,
    ...(Array.isArray(board?.targetTitles) ? board.targetTitles : []),
    ...(Array.isArray(board?.relevantTitles) ? board.relevantTitles : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function boardPlanGeoRank(board, locationPreset) {
  const text = boardPlanText(board);
  const pune = board?.puneRelevant === true || /\bpune|pcmc|hinjawadi|pimpri|wakad|baner|kharadi\b/i.test(text);
  const india = board?.indiaRelevant === true || board?.indiaFirst === true || pune || /\bindia|bengaluru|hyderabad|mumbai|chennai\b/i.test(text);
  if (locationPreset === 'pune') return pune ? 3 : india ? 2 : 0;
  return india ? 2 : 0;
}

function boardPlanTitleRank(board, targetTitles = []) {
  const text = boardPlanText(board);
  const titles = [...targetTitles, ...(Array.isArray(board?.targetTitles) ? board.targetTitles : []), ...(Array.isArray(board?.relevantTitles) ? board.relevantTitles : [])]
    .map((value) => String(value).trim().toLowerCase()).filter(Boolean);
  return titles.filter((title) => text.includes(title)).length;
}

function boardPlanHealth(board) {
  const health = board?.health || {};
  return Math.max(0, Number(health.recentReadyRoleYield) || 0) * 100
    + Math.max(0, Number(health.recentFreshEligibleYield) || 0) * 10
    - Math.max(0, Number(health.repeatedFailureCount) || 0) * 25;
}

function boardPlanState(state, id) {
  return state?.boards?.[id]
    || state?.boardStates?.[id]
    || state?.continuation?.[id]
    || null;
}

function boardPlanTier(board, lane) {
  const explicit = String(board?.sourceTier || board?.tier || '').trim().toLowerCase();
  if (SOURCE_PLAN_TIERS.includes(explicit)) return explicit;
  const ownerLane = boardPlanLane(board, lane);
  if (ownerLane === 'enterprise') return 'targeted-enterprise';
  if (ownerLane === 'atsWarm') return 'daily-core';
  if (ownerLane === 'atsBatch1' && (board?.indiaRelevant || board?.puneRelevant)) return 'daily-core';
  return 'opportunistic';
}

function planReason(decision, board) {
  const continuation = decision.continuation ? 'continuation-' : '';
  if (decision.action === 'selected' || decision.action === 'resumed') return `${continuation}${decision.exploration ? 'exploration-quota' : 'measured-priority'}`;
  if (decision.action === 'deferred') return decision.exploration ? 'exploration-quota-exhausted' : 'measured-priority-budget-exhausted';
  if (decision.action === 'omitted') return decision.reason || 'board-omitted';
  return board?.enabled === false ? 'board-disabled' : 'board-not-selected';
}

/**
 * Build the deterministic, no-network board plan shared by all ATS lanes.
 * `boardsByLane` is intentionally an input map so tests and dev fixtures can
 * prove alias dedupe without loading the production registry.
 */
export function planBoundedSources({
  boardsByLane = {},
  locationPreset = 'india',
  targetTitles = [],
  maxBoards = 20,
  allocation = DEFAULT_SOURCE_PLAN_ALLOCATION,
  state = {},
  runAt = new Date().toISOString(),
  sourceBudgetMs = 720_000,
} = {}) {
  const owners = new Map();
  const decisions = [];
  const laneOrder = [...SCHEDULE_LANES];
  for (const lane of Object.keys(boardsByLane).sort((left, right) => laneOrder.indexOf(left) - laneOrder.indexOf(right) || left.localeCompare(right))) {
    for (const input of boardsByLane[lane] || []) {
      const raw = boardWithProbeState(input, state);
      const id = normalizedBoardId(raw);
      if (!id) {
        decisions.push({ action: 'omitted', boardId: null, sourceLane: lane, reason: 'missing-normalized-board-identity' });
        continue;
      }
      if (raw?.enabled === false || ['disabled', 'proposed', 'rejected'].includes(String(raw?.activationState || '').toLowerCase())) {
        decisions.push({ action: 'omitted', boardId: id, sourceLane: lane, reason: raw?.activationState === 'proposed' ? 'board-proposed-not-active' : 'board-disabled' });
        continue;
      }
      const pauseReason = boardPauseReason(raw, state, runAt);
      if (pauseReason) {
        decisions.push({ action: 'omitted', boardId: id, sourceLane: lane, reason: pauseReason });
        continue;
      }
      const ownerLane = boardPlanLane(raw, lane);
      const existing = owners.get(id);
      if (existing) {
        existing.aliases.push({ sourceLane: lane, boardId: boardIdentityKey(raw) });
        decisions.push({ action: 'omitted', boardId: id, sourceLane: lane, ownerSource: existing.sourceLane, reason: 'duplicate-board-alias' });
        continue;
      }
      const board = { ...raw, boardId: id, sourceLane: ownerLane, planTier: boardPlanTier(raw, lane) };
      const continuation = boardPlanState(state, id);
      const hasContinuation = Boolean(continuation?.cursor || continuation?.unfinished || continuation?.status === 'interrupted' || continuation?.status === 'truncated');
      const scored = {
        board,
        sourceLane: ownerLane,
        aliases: [],
        continuation,
        hasContinuation,
        geoRank: boardPlanGeoRank(board, locationPreset),
        titleRank: boardPlanTitleRank(board, targetTitles),
        healthRank: boardPlanHealth(board),
      };
      owners.set(id, scored);
    }
  }

  const all = [...owners.values()];
  const priority = all.filter((item) => item.board.planTier === 'daily-core' || item.board.planTier === 'targeted-enterprise');
  const exploration = all.filter((item) => item.board.planTier === 'exploration' || item.board.planTier === 'opportunistic');
  const cap = Math.max(0, Math.min(all.length, Number(maxBoards) || 0));
  const priorityShare = Math.max(0, Math.min(1, Number(allocation.priorityShare ?? 0.8) || 0.8));
  const explorationShare = Math.max(0, Math.min(1, Number(allocation.explorationShare ?? 0.2) || 0.2));
  const priorityBudget = Math.min(cap, Math.ceil(cap * priorityShare));
  const explorationBudget = Math.max(0, Math.min(cap - priorityBudget, Math.floor(cap * explorationShare)));
  const compareRank = (left, right) => puneFirst(left.board, right.board)
    || Number(right.hasContinuation) - Number(left.hasContinuation)
    || (right.geoRank - left.geoRank)
    || (right.titleRank - left.titleRank)
    || (right.healthRank - left.healthRank);
  const compare = (left, right) => compareRank(left, right)
    || left.board.boardId.localeCompare(right.board.boardId);
  const trackedAtsItems = all.filter((item) => item.sourceLane === 'atsWarm');
  const trackedAtsCursor = Math.max(0, Number(state?.trackedAts?.rotation?.cursor ?? state?.rotation?.trackedAtsCursor ?? 0) || 0);
  const explorationCursor = Math.max(0, Number(state?.explorationCursor ?? state?.rotation?.explorationCursor ?? 0) || 0);
  const rotationGroups = new Map();
  // Each equally ranked pool advances only for its own completed selections.
  const groupCursor = (pool) => (group) => {
    const key = `${pool}:${group.map((item) => item.board.boardId).sort().join(',')}`;
    const cursor = Math.max(0, Number(state.rankGroupCursors?.[key]) || 0);
    rotationGroups.set(key, { group, cursor });
    return cursor;
  };
  const orderedPriority = rotateRanked(priority, groupCursor('priority'), compareRank);
  const orderedExploration = rotateRanked(exploration, groupCursor('exploration'), compareRank);
  const puneItems = all.filter((candidate) => candidate.board.puneRelevant === true);
  const selected = [];
  const selectedIds = new Set();
  // Pune supply gets the first bounded slots even when other boards need continuation.
  for (const item of rotateRanked(puneItems, groupCursor('pune'), compareRank)) {
    if (selected.length >= cap) break;
    selected.push(item); selectedIds.add(item.board.boardId);
  }
  for (const item of all.filter((candidate) => candidate.hasContinuation).sort(compare)) {
    if (selected.length >= cap || selectedIds.has(item.board.boardId)) continue;
    selected.push(item); selectedIds.add(item.board.boardId);
  }
  for (const item of orderedPriority.slice(0, priorityBudget)) {
    if (selected.length >= cap || selectedIds.has(item.board.boardId)) continue;
    selected.push(item); selectedIds.add(item.board.boardId);
  }
  for (const item of orderedExploration.slice(0, explorationBudget)) {
    if (selected.length >= cap || selectedIds.has(item.board.boardId)) continue;
    selected.push(item); selectedIds.add(item.board.boardId);
  }
  // If one side has no eligible boards, unused budget is deterministic fallback
  // capacity, while the configured 80/20 split remains visible in telemetry.
  if (selected.length < cap) {
    for (const item of [...orderedPriority, ...orderedExploration]) {
      if (selected.length >= cap || selectedIds.has(item.board.boardId)) continue;
      selected.push(item); selectedIds.add(item.board.boardId);
    }
  }
  const selectedBoardsByLane = Object.fromEntries(SCHEDULE_LANES.map((lane) => [lane, []]));
  for (const item of selected) {
    selectedBoardsByLane[item.sourceLane] ??= [];
    selectedBoardsByLane[item.sourceLane].push(item.board);
    const action = item.hasContinuation ? 'resumed' : 'selected';
    decisions.push({
      action, boardId: item.board.boardId, sourceLane: item.sourceLane, tier: item.board.planTier,
      continuation: item.hasContinuation, exploration: item.board.planTier === 'exploration' || item.board.planTier === 'opportunistic',
      reason: planReason({ action, continuation: item.hasContinuation, exploration: item.board.planTier === 'exploration' || item.board.planTier === 'opportunistic' }, item.board),
      score: { geography: item.geoRank, title: item.titleRank, health: item.healthRank },
    });
  }
  for (const item of all) {
    if (selectedIds.has(item.board.boardId)) continue;
    decisions.push({
      action: 'deferred', boardId: item.board.boardId, sourceLane: item.sourceLane, tier: item.board.planTier,
      continuation: item.hasContinuation, exploration: item.board.planTier === 'exploration' || item.board.planTier === 'opportunistic',
      reason: planReason({ action: 'deferred', exploration: item.board.planTier === 'exploration' || item.board.planTier === 'opportunistic' }, item.board),
      score: { geography: item.geoRank, title: item.titleRank, health: item.healthRank },
    });
  }
  decisions.sort((left, right) => String(left.boardId).localeCompare(String(right.boardId)) || left.action.localeCompare(right.action));
  const explorationSelectedCount = selected.filter((item) => !item.hasContinuation && (item.board.planTier === 'exploration' || item.board.planTier === 'opportunistic')).length;
  const trackedAtsSelectedCount = selected.filter((item) => item.sourceLane === 'atsWarm' && !item.hasContinuation).length;
  const nextTrackedAtsCursor = trackedAtsItems.length ? (trackedAtsCursor + trackedAtsSelectedCount) % trackedAtsItems.length : 0;
  const nextExplorationCursor = exploration.length ? (explorationCursor + explorationSelectedCount) % exploration.length : 0;
  const trackedAtsCoverage = {
    configuredBoardIds: trackedAtsItems.map((item) => item.board.boardId),
    selectedBoardIds: trackedAtsItems.filter((item) => selectedIds.has(item.board.boardId)).map((item) => item.board.boardId),
    deferredBoardIds: trackedAtsItems.filter((item) => !selectedIds.has(item.board.boardId)).map((item) => item.board.boardId),
  };
  const boardPlan = {
    schemaVersion: 'BoundedBoardPlanV1', runAt, locationPreset,
    allocation: { priorityShare, explorationShare, priorityBudget, explorationBudget },
    rotation: {
      trackedAtsCursor,
      nextTrackedAtsCursor,
      explorationCursor,
      nextExplorationCursor,
    },
    trackedAts: {
      sourceId: 'ats-warm',
      rotation: { cursor: trackedAtsCursor, nextCursor: nextTrackedAtsCursor },
      coverage: trackedAtsCoverage,
    },
    boardsConfigured: all.length, boardsSelected: selected.length,
    noWrite: true,
    sourcePhaseBudgetMs: Math.max(1, Number(sourceBudgetMs) || 720_000),
    sourcePhaseWithinBudget: Math.max(1, Number(sourceBudgetMs) || 720_000) <= 720_000,
    retainedReadyYield: selected.reduce((sum, item) => sum + Math.max(0, Number(item.board.health?.recentReadyRoleYield) || 0), 0),
    decisions,
  };
  const nextState = {
    schemaVersion: 'BoundedBoardPlanStateV1', updatedAt: runAt,
    rankGroupCursors: { ...state.rankGroupCursors, ...Object.fromEntries([...rotationGroups].map(([key, { group, cursor }]) => [key,
      (cursor + group.filter((item) => selectedIds.has(item.board.boardId) && !item.hasContinuation).length) % group.length])) },
    trackedAts: {
      rotation: { cursor: nextTrackedAtsCursor },
      coverage: trackedAtsCoverage,
    },
    explorationCursor: nextExplorationCursor,
    rotation: { trackedAtsCursor: nextTrackedAtsCursor, explorationCursor: nextExplorationCursor },
    boards: { ...(state.boards || {}), ...Object.fromEntries(all.map((item) => [item.board.boardId, {
      ...(item.continuation || {}), lastPlanAction: selectedIds.has(item.board.boardId) ? 'selected' : 'deferred',
      lastPlanTier: item.board.planTier, lastPlannedAt: runAt,
    }])) },
    lastPlan: boardPlan,
  };
  return { boardsByLane: selectedBoardsByLane, boardPlan, state: nextState, resumeState: state };
}

export function workdayTriple(boardOrSlug) {
  if (boardOrSlug && typeof boardOrSlug === 'object') {
    if (boardOrSlug.tenant && boardOrSlug.instance && boardOrSlug.site) {
      return {
        tenant: String(boardOrSlug.tenant),
        instance: String(boardOrSlug.instance),
        site: String(boardOrSlug.site),
      };
    }
    const key = boardOrSlug.boardKey || boardOrSlug.slug;
    if (key) return workdayTriple(String(key));
    return null;
  }
  const parts = String(boardOrSlug || '').split('|');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  return { tenant: parts[0], instance: parts[1], site: parts[2] };
}

export function workdayCxsUrl(tenant, instance, site) {
  return `https://${tenant}.${instance}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
}

export function emptyRegistry(updatedAt = null) {
  return {
    schemaVersion: BOARD_REGISTRY_SCHEMA,
    updatedAt,
    boards: [],
  };
}

/**
 * Normalize one registry board. Activation is dual-field for clarity:
 * `enabled` is the operational switch adapters understand; `activationState`
 * is the human lifecycle (`enabled` | `proposed` | `disabled` | `rejected`).
 * Proposals never auto-activate: enabled stays false until a human flips it.
 */
export function normalizeRegistryBoard(raw = {}) {
  const provider = clean(raw.provider)?.toLowerCase();
  if (!provider) throw new Error('registry board requires provider');

  let boardKey = clean(raw.boardKey);
  let slug = clean(raw.slug);
  let board = clean(raw.board);
  let tenant = clean(raw.tenant);
  let instance = clean(raw.instance);
  let site = clean(raw.site);
  let url = clean(raw.url);

  if (provider === 'workday') {
    const triple = workdayTriple(raw) || (boardKey ? workdayTriple(boardKey) : null);
    if (triple) {
      tenant = triple.tenant;
      instance = triple.instance;
      site = triple.site;
      boardKey = `${tenant}|${instance}|${site}`;
      if (!url) url = workdayCxsUrl(tenant, instance, site);
    }
  } else if (['greenhouse', 'lever', 'ashby', 'pinpoint'].includes(provider)) {
    slug = slug || board || boardKey;
    boardKey = boardKey || slug;
  } else {
    board = board || slug || boardKey;
    boardKey = boardKey || board;
  }

  // Rejected/disabled probe rows may lack a tenant slug; keep them addressable via company.
  if (!boardKey && !slug && !board && !tenant) {
    const fallback = clean(raw.company);
    if (fallback) boardKey = `unverified:${fallback.toLowerCase().replace(/\s+/g, '-')}`;
  }

  const activationState = clean(raw.activationState)
    || (raw.enabled === false && raw.probeStatus === 'proposed' ? 'proposed'
      : raw.enabled === false ? 'disabled'
        : 'enabled');
  const enabled = activationState === 'enabled'
    ? raw.enabled !== false
    : false;

  const id = clean(raw.id) || boardIdentityKey({
    provider, boardKey, slug, board, tenant, instance, site,
  });
  if (!id) throw new Error(`registry board missing identity for provider ${provider}`);

  return {
    id,
    provider,
    boardKey,
    slug: slug || null,
    board: board || null,
    tenant: tenant || null,
    instance: instance || null,
    site: site || null,
    company: clean(raw.company) || titleCaseSlug(slug || board || tenant) || id,
    url: url || null,
    careerPageUrl: clean(raw.careerPageUrl),
    endpoint: clean(raw.endpoint),
    country: clean(raw.country),
    indiaFirst: raw.indiaFirst === true,
    indiaRelevant: raw.indiaRelevant === true,
    puneRelevant: raw.puneRelevant === true,
    startupTagged: raw.startupTagged === true,
    ...(REGISTRY_SEED_TIERS.includes(raw.registryTier) ? { registryTier: raw.registryTier } : {}),
    enabled,
    activationState,
    probeStatus: clean(raw.probeStatus) || (enabled ? 'verified' : 'proposed'),
    probedAt: clean(raw.probedAt),
    probe: raw.probe && typeof raw.probe === 'object' && !Array.isArray(raw.probe) ? { ...raw.probe } : null,
    evidenceRef: clean(raw.evidenceRef),
    notes: clean(raw.notes) || clean(raw.reason),
    scheduleLane: clean(raw.scheduleLane) || PROVIDER_LANES[provider] || null,
    capabilities: {
      ...defaultCapabilities(provider),
      ...(raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {}),
    },
    health: {
      ...emptyHealth(),
      ...(raw.health && typeof raw.health === 'object' ? raw.health : {}),
    },
    migratedFrom: Array.isArray(raw.migratedFrom) ? [...raw.migratedFrom] : [],
  };
}

// Flatten structured ATS locations while keeping country-code evidence readable.
function probeLocationText(value) {
  if (Array.isArray(value)) return value.map(probeLocationText).join(', ');
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return [value.name, value.city, value.addressLocality, value.region, value.country === 'in' ? 'India' : value.country,
    value.countryCode === 'IN' ? 'India' : value.countryCode, value.addressCountry].filter(Boolean).join(', ');
}

// Reuse each adapter's public feed and location mapping for probe evidence.
function boardProbeFeed(board, body) {
  if (['greenhouse', 'lever', 'ashby'].includes(board.provider)) return warmAtsProbeFeed(board, body);
  const adapter = createAtsBatch1Adapters()[board.provider];
  if (adapter) {
    const rows = adapter.rows(body);
    return { url: adapter.url(board, { page: 0, pageSize: 50 }),
      locations: Array.isArray(rows) ? rows.map((row) => adapter.map(row, board).location) : null,
      complete: Array.isArray(rows) && adapter.next(body, { page: 0, pageSize: 50 }) == null };
  }
  if (ATS_BATCH_2_PROVIDERS.includes(board.provider)) return batch2ProbeFeed(board, body);
  if (board.provider === 'workday') return {
    url: board.endpoint || `https://${board.tenant}.${board.instance}.myworkdayjobs.com/${board.site}`,
    ...enterpriseProbeFeed(board, body),
  };
  throw new Error(`unsupported registry probe provider: ${board.provider}`);
}

// Resolve the one-request public probe URL through the existing provider adapter.
export function registryProbeUrl(board) {
  return boardProbeFeed(board, null).url;
}

// Summarize location evidence from a public listing response without another request.
export function recordRegistryProbe(registry, boardId, { locations, sourceUrl, foundVia, complete = true, runAt = new Date().toISOString() }) {
  const punePattern = /\b(?:pune|pcmc|hinjawadi|hinjewadi|pimpri|chinchwad)\b/i;
  const indiaPattern = /\b(?:india|pune|bengaluru|bangalore|hyderabad|chennai|gurugram|gurgaon|noida|delhi|mumbai|maharashtra)\b/i;
  locations = locations.map(probeLocationText);
  const indiaJobCount = locations.filter((location) => indiaPattern.test(location) || punePattern.test(location)).length;
  const puneRelevant = locations.some((location) => punePattern.test(location));
  const otherScope = /\b(?:canada|mexico|brazil|uk|united kingdom|germany|france|ireland|netherlands|poland|spain|italy|australia|new zealand|singapore|china|japan|europe|eu|apac|latam|worldwide|global|anywhere)\b/i;
  const usOnly = locations.length > 0 && locations.every((location) =>
    /\b(?:united states|usa|us)\b/i.test(location) && !indiaPattern.test(location) && !otherScope.test(location));
  return {
    ...registry, updatedAt: runAt,
    boards: registry.boards.map((board) => board.id !== boardId ? board : {
      ...board, puneRelevant, indiaRelevant: indiaJobCount > 0, probedAt: runAt, probeStatus: 'verified',
      probe: { probedAt: runAt, foundVia: foundVia || board.probe?.foundVia || board.evidenceRef || 'registry', sourceUrl,
        jobCount: locations.length, indiaJobCount, usOnly, complete,
        zeroIndiaSince: usOnly && complete ? board.probe?.zeroIndiaSince || runAt : null },
    }),
  };
}

// Observe an existing adapter response and carry its evidence into durable rotation state.
export function recordBoardProbeResponse(registry, boardId, response, { sourceUrl, runAt } = {}) {
  if (Number(response?.status) < 200 || Number(response?.status) >= 300) return registry;
  const board = findBoard(registry, boardId);
  if (!board) return registry;
  try {
    let body = response.body;
    if (typeof body === 'string' && /^[\s]*[\[{]/.test(body)) body = JSON.parse(body);
    const feed = boardProbeFeed(board, body);
    if (!Array.isArray(feed.locations)) return registry;
    return recordRegistryProbe(registry, board.id, { locations: feed.locations, complete: feed.complete, sourceUrl, runAt });
  } catch { return registry; }
}

// Probe a board once through its public listing feed and retain the observed geography.
export async function probeRegistryBoard(registry, boardId, { transport, runAt, foundVia } = {}) {
  const board = findBoard(registry, boardId);
  if (!board) throw new Error(`unknown registry board: ${boardId}`);
  if (typeof transport !== 'function') throw new TypeError('probeRegistryBoard requires injected transport');
  const url = registryProbeUrl(board);
  if (!url) throw new Error('board probe missing public feed URL');
  const response = await transport(url, { method: 'GET', provider: board.provider, board });
  if (Number(response.status) < 200 || Number(response.status) >= 300) throw new Error(`board probe HTTP_${response.status}`);
  let body = response.body;
  if (typeof body === 'string' && /^[\s]*[\[{]/.test(body)) body = JSON.parse(body);
  const feed = boardProbeFeed(board, body);
  if (!Array.isArray(feed.locations)) throw new Error('board probe missing supported jobs array');
  return recordRegistryProbe(registry, board.id, {
    locations: feed.locations, complete: feed.complete, sourceUrl: url, foundVia, runAt,
  });
}

export function loadBoardRegistry(file = DEFAULT_BOARD_REGISTRY_PATH) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) return emptyRegistry();
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!raw || typeof raw !== 'object') throw new Error(`invalid board registry: ${resolved}`);
  if (raw.schemaVersion !== BOARD_REGISTRY_SCHEMA) {
    throw new Error(`board registry schemaVersion must be ${BOARD_REGISTRY_SCHEMA}`);
  }
  return {
    schemaVersion: BOARD_REGISTRY_SCHEMA,
    updatedAt: raw.updatedAt ?? null,
    boards: (raw.boards ?? []).map((board) => normalizeRegistryBoard(board)),
  };
}

export function saveBoardRegistry(file, registry) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const out = {
    schemaVersion: BOARD_REGISTRY_SCHEMA,
    updatedAt: registry.updatedAt ?? new Date().toISOString(),
    boards: (registry.boards ?? []).map((board) => normalizeRegistryBoard(board)),
  };
  fs.writeFileSync(resolved, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return out;
}

function upsertBoard(map, board, sourceTag) {
  const normalized = normalizeRegistryBoard(board);
  const existing = map.get(normalized.id);
  if (!existing) {
    normalized.migratedFrom = sourceTag ? [sourceTag] : [...normalized.migratedFrom];
    map.set(normalized.id, normalized);
    return;
  }
  // Prefer richer crawler-v2 fields; union geography flags and provenance.
  const merged = normalizeRegistryBoard({
    ...existing,
    ...Object.fromEntries(
      Object.entries(normalized).filter(([, value]) => value != null && value !== false && value !== ''),
    ),
    indiaFirst: existing.indiaFirst || normalized.indiaFirst,
    indiaRelevant: existing.indiaRelevant || normalized.indiaRelevant,
    puneRelevant: existing.puneRelevant || normalized.puneRelevant,
    startupTagged: existing.startupTagged || normalized.startupTagged,
    enabled: existing.enabled || normalized.enabled,
    activationState: existing.activationState === 'enabled' || normalized.activationState === 'enabled'
      ? 'enabled'
      : existing.activationState,
    capabilities: { ...normalized.capabilities, ...existing.capabilities },
    health: { ...emptyHealth(), ...normalized.health, ...existing.health },
    migratedFrom: [...new Set([...(existing.migratedFrom || []), ...(normalized.migratedFrom || []), sourceTag].filter(Boolean))],
    company: existing.company && existing.company !== existing.id
      ? existing.company
      : normalized.company,
    url: existing.url || normalized.url,
    endpoint: existing.endpoint || normalized.endpoint,
    evidenceRef: existing.evidenceRef || normalized.evidenceRef,
    probeStatus: existing.probeStatus === 'verified' ? existing.probeStatus : (normalized.probeStatus || existing.probeStatus),
    probedAt: existing.probedAt || normalized.probedAt,
    notes: existing.notes || normalized.notes,
  });
  map.set(merged.id, merged);
}

function fromCrawlerBoard(board, sourceTag) {
  return {
    ...board,
    migratedFrom: [sourceTag],
    activationState: board.enabled === false ? 'disabled' : 'enabled',
    enabled: board.enabled !== false,
    probeStatus: board.probeStatus || (board.enabled === false ? 'disabled' : 'verified'),
  };
}

function fromWarmSlug(provider, slug) {
  if (provider === 'workday') {
    const triple = workdayTriple(slug);
    if (!triple) return null;
    const isFinastra = triple.tenant === 'finastra'
      && triple.instance === 'wd3'
      && triple.site === 'finc';
    return {
      provider: 'workday',
      ...triple,
      boardKey: slug,
      company: isFinastra ? 'Finastra' : titleCaseSlug(triple.tenant),
      url: workdayCxsUrl(triple.tenant, triple.instance, triple.site),
      enabled: true,
      activationState: 'enabled',
      probeStatus: isFinastra ? 'verified' : 'warm',
      probedAt: isFinastra ? '2026-07-24T00:00:00.000Z' : null,
      evidenceRef: isFinastra
        ? 'docs/reports/daily-run-2026-07-24.md — confirmed Associate Software Engineer (Pune) posting via reverse-ATS warm set (finastra|wd3|finc)'
        : 'migrated from config/reverse-warm-set.json (historically warm board)',
      scheduleLane: 'enterprise',
      migratedFrom: ['reverse-warm-set'],
    };
  }
  return {
    provider,
    slug,
    boardKey: slug,
    company: titleCaseSlug(slug),
    enabled: true,
    activationState: 'enabled',
    probeStatus: 'warm',
    evidenceRef: 'migrated from config/reverse-warm-set.json (historically warm board)',
    scheduleLane: PROVIDER_LANES[provider] || 'atsWarm',
    migratedFrom: ['reverse-warm-set'],
  };
}

/**
 * Import every board from crawler-v2 lane arrays and reverse-warm-set slug lists.
 * Zero silent coverage loss: the union of both sources is the registry.
 * Finastra Workday is explicitly activated with a full enterprise-shaped URL.
 */
export function migrateFromLegacySources({
  crawlerConfig,
  reverseWarmSet,
  runAt = new Date().toISOString(),
} = {}) {
  const map = new Map();
  const counts = {
    crawler: { atsWarm: 0, atsBatch1: 0, atsBatch2: 0, enterprise: 0, disabled: 0 },
    reverseWarm: { greenhouse: 0, lever: 0, ashby: 0, workday: 0 },
    before: { crawler: 0, reverseWarm: 0 },
    after: 0,
    byProvider: {},
  };

  const sources = crawlerConfig?.sources ?? {};
  for (const lane of SCHEDULE_LANES) {
    for (const board of sources[lane]?.boards ?? []) {
      upsertBoard(map, fromCrawlerBoard({ ...board, scheduleLane: lane }, `crawler-v2:${lane}`), `crawler-v2:${lane}`);
      counts.crawler[lane] += 1;
      counts.before.crawler += 1;
    }
    for (const board of sources[lane]?.disabledBoards ?? []) {
      upsertBoard(map, {
        ...board,
        scheduleLane: lane,
        enabled: false,
        activationState: board.probeStatus === 'rejected-mismatch' ? 'rejected' : 'disabled',
        migratedFrom: [`crawler-v2:${lane}:disabled`],
      }, `crawler-v2:${lane}:disabled`);
      counts.crawler.disabled += 1;
      counts.before.crawler += 1;
    }
  }

  const warmBoards = reverseWarmSet?.boards ?? {};
  for (const provider of WARM_ATS) {
    for (const slug of warmBoards[provider] ?? []) {
      const board = fromWarmSlug(provider, slug);
      if (!board) continue;
      upsertBoard(map, board, 'reverse-warm-set');
      counts.reverseWarm[provider] += 1;
      counts.before.reverseWarm += 1;
    }
  }

  // Guarantee Finastra is present, enabled, and enterprise-shaped even if reverse-warm-set is empty in a test.
  const finastraId = 'workday:finastra|wd3|finc';
  if (!map.has(finastraId) && (warmBoards.workday ?? []).includes('finastra|wd3|finc')) {
    upsertBoard(map, fromWarmSlug('workday', 'finastra|wd3|finc'), 'reverse-warm-set');
  }
  if (map.has(finastraId)) {
    const finastra = map.get(finastraId);
    map.set(finastraId, normalizeRegistryBoard({
      ...finastra,
      company: 'Finastra',
      tenant: 'finastra',
      instance: 'wd3',
      site: 'finc',
      boardKey: 'finastra|wd3|finc',
      url: workdayCxsUrl('finastra', 'wd3', 'finc'),
      enabled: true,
      activationState: 'enabled',
      probeStatus: 'verified',
      probedAt: finastra.probedAt || '2026-07-24T00:00:00.000Z',
      evidenceRef: finastra.evidenceRef
        || 'docs/reports/daily-run-2026-07-24.md — confirmed Associate Software Engineer (Pune) posting via reverse-ATS warm set (finastra|wd3|finc)',
      scheduleLane: 'enterprise',
    }));
  }

  const boards = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const board of boards) {
    counts.byProvider[board.provider] = (counts.byProvider[board.provider] || 0) + 1;
  }
  counts.after = boards.length;

  return {
    registry: {
      schemaVersion: BOARD_REGISTRY_SCHEMA,
      updatedAt: runAt,
      boards,
    },
    counts,
  };
}

/** Adapter-shaped projection for one scheduled crawler lane. Only enabled boards. */
function boardMentions(board, pattern) {
  return [board.company, board.board, board.slug, board.boardKey, board.site, board.url]
    .some((value) => typeof value === 'string' && pattern.test(value));
}

function boardLocationRank(board, locationPreset) {
  const pune = board.puneRelevant === true || boardMentions(board, /\bpune|pcmc|hinjawadi|pimpri/i);
  const india = board.indiaRelevant === true || pune || boardMentions(board, /\bindia\b/i);
  if (locationPreset === 'pune') {
    if (pune) return 0;
    if (india) return 1;
    return 2;
  }
  if (locationPreset === 'india') {
    if (pune) return 0;
    if (india) return 1;
    return 2;
  }
  return 0;
}

export function projectLaneBoards(registry, lane, { enabledOnly = true, locationPreset = null } = {}) {
  const boards = [];
  for (const entry of registry?.boards ?? []) {
    if (entry.scheduleLane !== lane) continue;
    if (enabledOnly && !entry.enabled) continue;
    if (enabledOnly && entry.activationState === 'proposed') continue;
    boards.push({
      ...toAdapterBoard(entry),
      id: entry.id,
      boardKey: entry.boardKey,
      sourceTier: entry.sourceTier ?? entry.tier ?? null,
      targetTitles: entry.targetTitles ?? entry.relevantTitles ?? null,
      health: entry.health,
      probe: entry.probe,
    });
  }
  if (!locationPreset) return boards;
  return [...boards].sort((left, right) => {
    const rank = boardLocationRank(left, locationPreset) - boardLocationRank(right, locationPreset);
    if (rank) return rank;
    return String(left.company || left.board || left.slug || '').localeCompare(String(right.company || right.board || right.slug || ''));
  });
}

function withLocationFlags(board, entry) {
  if (entry.indiaRelevant) board.indiaRelevant = true;
  if (entry.puneRelevant) board.puneRelevant = true;
  if (entry.indiaFirst) board.indiaFirst = true;
  if (entry.probeStatus) board.probeStatus = entry.probeStatus;
  return board;
}

// Project unsupported ATS employers only when retained metadata proves JobPosting support.
export function projectCareerPageBoards(registry, { locationPreset = 'pune' } = {}) {
  return (registry?.boards ?? []).filter((board) => board.enabled !== false
    && !['disabled', 'proposed', 'rejected'].includes(board.activationState)
    && !PROVIDER_LANES[String(board.provider || '').toLowerCase()]
    && typeof board.careerPageUrl === 'string' && board.careerPageUrl.trim()
    && board.probe?.jobPostingJsonLd === true)
    .sort((left, right) => boardLocationRank(left, locationPreset) - boardLocationRank(right, locationPreset))
    .map((board) => ({ boardId: board.id || boardIdentityKey(board), company: board.company, websiteUrl: board.careerPageUrl }));
}

// Describe configured ownership without claiming requests, liveness, or current yield.
export function registrySourceCoverage(registry, { schedule = 'morning' } = {}) {
  const careerIds = new Set(projectCareerPageBoards(registry).map((board) => board.boardId));
  const sourceIds = { atsWarm: 'ats-warm', atsBatch1: 'ats-batch-1', atsBatch2: 'ats-batch-2', enterprise: 'ats-enterprise' };
  return (registry?.boards ?? []).map((board) => {
    const boardId = board.id || boardIdentityKey(board);
    const disabled = board.enabled === false || ['disabled', 'proposed', 'rejected'].includes(board.activationState);
    const atsLane = PROVIDER_LANES[String(board.provider || '').toLowerCase()];
    const sourceId = disabled ? null : atsLane && atsLane === board.scheduleLane ? sourceIds[atsLane] || null
      : careerIds.has(boardId) ? 'structured-career-pages' : null;
    const excluded = schedule === 'midday' && ['ats-batch-2', 'ats-enterprise'].includes(sourceId);
    return { boardId, probeStatus: board.probeStatus ?? null, sourceId,
      state: disabled ? 'disabled' : !sourceId ? 'unscheduled' : excluded ? 'excluded-by-schedule' : 'scheduled',
      reason: disabled ? 'board-disabled-or-proposed' : !sourceId ? 'no-supported-scheduled-adapter' : excluded ? 'morning-only-source' : 'configured-source-ownership',
    };
  });
}

function toAdapterBoard(entry) {
  const provider = entry.provider;
  if (provider === 'workday') {
    return withLocationFlags({
      provider,
      company: entry.company,
      tenant: entry.tenant,
      instance: entry.instance,
      site: entry.site,
      url: entry.url || workdayCxsUrl(entry.tenant, entry.instance, entry.site),
      enabled: entry.enabled,
      probeStatus: entry.probeStatus,
      probedAt: entry.probedAt,
      evidenceRef: entry.evidenceRef,
    }, entry);
  }
  if (['smartrecruiters', 'workable', 'teamtailor', 'recruitee'].includes(provider)) {
    const out = {
      provider,
      board: entry.board || entry.slug || entry.boardKey,
      company: entry.company,
      enabled: entry.enabled,
      probeStatus: entry.probeStatus,
      probedAt: entry.probedAt,
      evidenceRef: entry.evidenceRef,
    };
    if (entry.endpoint) out.endpoint = entry.endpoint;
    if (entry.country) out.country = entry.country;
    if (entry.indiaRelevant) out.indiaRelevant = true;
    if (entry.puneRelevant) out.puneRelevant = true;
    if (entry.notes) out.notes = entry.notes;
    return out;
  }
  if (provider === 'pinpoint') {
    return withLocationFlags({
      provider,
      slug: entry.slug || entry.boardKey,
      company: entry.company,
      enabled: entry.enabled,
      probeStatus: entry.probeStatus,
      probedAt: entry.probedAt,
      evidenceRef: entry.evidenceRef,
    }, entry);
  }
  // greenhouse / lever / ashby
  const out = {
    provider,
    slug: entry.slug || entry.boardKey,
    company: entry.company,
  };
  if (entry.indiaFirst) out.indiaFirst = true;
  if (entry.startupTagged) out.startupTagged = true;
  if (entry.enabled === false) out.enabled = false;
  return withLocationFlags(out, entry);
}

/**
 * Manual / tracked-ATS path: same shape as reverse-warm-set warmEntries output
 * ({ provider, slug, careersUrl }) for greenhouse/lever/ashby/workday.
 */
export function projectTrackedBoards(registry, { enabledOnly = true } = {}) {
  const boards = [];
  for (const entry of registry?.boards ?? []) {
    if (!WARM_ATS.includes(entry.provider)) continue;
    if (enabledOnly && !entry.enabled) continue;
    if (enabledOnly && entry.activationState === 'proposed') continue;
    const slug = entry.provider === 'workday'
      ? (entry.boardKey || `${entry.tenant}|${entry.instance}|${entry.site}`)
      : (entry.slug || entry.boardKey);
    const build = ENTRY_BUILDERS[entry.provider];
    const portal = build ? build(slug) : null;
    if (!portal) continue;
    boards.push({
      provider: entry.provider,
      slug,
      careersUrl: portal.careers_url,
      ...withLocationFlags({}, entry),
      ...(entry.probe ? { probe: entry.probe } : {}),
    });
  }
  return boards;
}

/** reverse-warm-set.json-shaped projection for compatibility. */
export function projectTrackedWarmSet(registry, { enabledOnly = true } = {}) {
  const boards = { greenhouse: [], lever: [], ashby: [], workday: [] };
  for (const entry of projectTrackedBoards(registry, { enabledOnly })) {
    if (boards[entry.provider]) boards[entry.provider].push(entry.slug);
  }
  for (const provider of WARM_ATS) boards[provider].sort();
  return {
    schemaVersion: 1,
    updatedAt: registry?.updatedAt ?? null,
    boards,
  };
}

export function projectAllScheduleLanes(registry, options) {
  const out = {};
  for (const lane of SCHEDULE_LANES) out[lane] = projectLaneBoards(registry, lane, options);
  return out;
}

/**
 * Apply board-promotion proposals into the registry as proposal-only entries.
 * Never sets enabled:true. Existing boards are left untouched.
 */
export function applyPromotionProposals(registry, proposals = [], { runAt = new Date().toISOString() } = {}) {
  const boards = [...(registry?.boards ?? [])];
  const byId = new Map(boards.map((board) => [board.id, board]));
  const added = [];

  for (const proposal of proposals) {
    const suggested = proposal?.suggestedBoard ?? proposal;
    if (!suggested?.provider) continue;
    const candidate = normalizeRegistryBoard({
      ...suggested,
      enabled: false,
      activationState: 'proposed',
      probeStatus: suggested.probeStatus || 'proposed',
      evidenceRef: suggested.evidenceRef
        || (proposal.evidenceUrls || []).join('; ')
        || null,
      scheduleLane: suggested.scheduleLane || PROVIDER_LANES[String(suggested.provider).toLowerCase()] || null,
      migratedFrom: ['board-promotion'],
    });
    if (byId.has(candidate.id)) continue;
    byId.set(candidate.id, candidate);
    boards.push(candidate);
    added.push(candidate);
  }

  return {
    registry: {
      schemaVersion: BOARD_REGISTRY_SCHEMA,
      updatedAt: runAt,
      boards: boards.sort((a, b) => a.id.localeCompare(b.id)),
    },
    added,
  };
}

/** Manual activation: human flips a proposed/disabled board to enabled. */
export function activateBoard(registry, boardId, { runAt = new Date().toISOString() } = {}) {
  const boards = (registry?.boards ?? []).map((board) => {
    if (board.id !== boardId) return board;
    return normalizeRegistryBoard({
      ...board,
      enabled: true,
      activationState: 'enabled',
      probeStatus: board.probeStatus === 'proposed' ? 'verified' : board.probeStatus,
      probedAt: board.probedAt || runAt,
    });
  });
  return {
    schemaVersion: BOARD_REGISTRY_SCHEMA,
    updatedAt: runAt,
    boards,
  };
}

/** Future-facing health updater (callers in run/operator can use this later). */
export function recordBoardHealth(registry, boardId, event = {}) {
  const boards = (registry?.boards ?? []).map((board) => {
    if (board.id !== boardId) return board;
    const health = { ...emptyHealth(), ...board.health };
    if (event.success) {
      health.lastSuccessfulFetchAt = event.at || new Date().toISOString();
      health.repeatedFailureCount = 0;
      if (event.freshEligible != null) health.recentFreshEligibleYield = Number(event.freshEligible) || 0;
      if (event.readyRoles != null) health.recentReadyRoleYield = Number(event.readyRoles) || 0;
    } else if (event.failure) {
      health.repeatedFailureCount = (health.repeatedFailureCount || 0) + 1;
    }
    return { ...board, health };
  });
  return {
    schemaVersion: BOARD_REGISTRY_SCHEMA,
    updatedAt: registry?.updatedAt ?? null,
    boards,
  };
}

/** Resolve registry from config (attached object, path, or null). */
export function resolveBoardRegistry(config) {
  if (config?.boardRegistryPath) return loadBoardRegistry(config.boardRegistryPath);
  if (config?.boardRegistry) return config.boardRegistry;
  return null;
}

/**
 * Return a config whose sources.*.boards are projected from the unified registry.
 * When no registry is configured, returns config unchanged (test / inline fixtures).
 */
export function withRegistryProjectedBoards(config, { locationPreset = null, sourcePlan = null } = {}) {
  const loadedRegistry = resolveBoardRegistry(config);
  if (!loadedRegistry) return config;
  const registry = { ...loadedRegistry, boards: loadedRegistry.boards.map((board) => boardWithProbeState(board, config.sourcePlanner?.state)) };
  const preset = locationPreset || sourcePlan?.locationPreset || 'pune';
  const sources = { ...(config.sources ?? {}) };
  for (const lane of SCHEDULE_LANES) {
    sources[lane] = {
      ...(sources[lane] ?? {}),
      boards: projectLaneBoards(registry, lane, { locationPreset: preset }),
    };
  }
  return { ...config, boardRegistry: registry, sources, discoveryBoardPriority: preset };
}

export function findBoard(registry, predicate) {
  if (typeof predicate === 'string') {
    return (registry?.boards ?? []).find((board) => board.id === predicate
      || board.boardKey === predicate
      || board.slug === predicate) ?? null;
  }
  return (registry?.boards ?? []).find(predicate) ?? null;
}

export default {
  BOARD_REGISTRY_SCHEMA,
  loadBoardRegistry,
  saveBoardRegistry,
  migrateFromLegacySources,
  projectLaneBoards,
  projectTrackedBoards,
  projectTrackedWarmSet,
  applyPromotionProposals,
  activateBoard,
  withRegistryProjectedBoards,
};
