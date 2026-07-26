import fs from 'node:fs';
import path from 'node:path';
import { ENTRY_BUILDERS, WARM_ATS } from '../job-pull/warm-set.mjs';

export const BOARD_REGISTRY_SCHEMA = 'BoardRegistryV1';
export const DEFAULT_BOARD_REGISTRY_PATH = 'config/board-registry.json';

export const SCHEDULE_LANES = Object.freeze(['atsWarm', 'atsBatch1', 'atsBatch2', 'enterprise']);

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

function rotationPriority(board) {
  if (board?.indiaFirst || board?.indiaRelevant || board?.puneRelevant) return 1;
  if (Number(board?.health?.recentReadyRoleYield || 0) > 0 || Number(board?.health?.recentFreshEligibleYield || 0) > 0) return 2;
  if (!board?.health?.lastSuccessfulFetchAt && (board?.probedAt || ['proposed', 'probation'].includes(board?.probeStatus))) return 4;
  return 3;
}

function rotate(values, cursor) {
  if (!values.length) return [];
  const start = Math.max(0, Number(cursor) || 0) % values.length;
  return [...values.slice(start), ...values.slice(0, start)];
}

/**
 * Select a bounded, provider-fair board window. The returned state is JSON-safe
 * so callers can persist it in the existing source cursor_json durable store.
 */
export function planBoardRotation({
  boards = [],
  maxBoards = boards.length,
  providerQuotas = {},
  state = {},
  runAt = new Date().toISOString(),
  seenBoardIds = [],
} = {}) {
  const configured = [];
  const duplicateConfigured = [];
  const configuredIds = new Set();
  for (const board of boards) {
    const id = board.id || board.registryId || boardIdentityKey(board);
    if (!id || configuredIds.has(id)) {
      duplicateConfigured.push({ boardId: id, provider: board?.provider || null, reason: 'duplicate-configured-board' });
      continue;
    }
    configuredIds.add(id);
    configured.push({ ...board, rotationBoardId: id });
  }
  configured.sort((left, right) => rotationPriority(left) - rotationPriority(right)
    || left.rotationBoardId.localeCompare(right.rotationBoardId));

  const cap = Math.max(0, Math.min(configured.length, Number(maxBoards) || 0));
  const seen = new Set(seenBoardIds);
  const eligible = configured.filter((board) => !seen.has(board.rotationBoardId));
  const selected = [];
  const selectedIds = new Set();
  const providerCursors = { ...(state.providerCursors || {}) };

  for (const [provider, rawQuota] of Object.entries(providerQuotas)) {
    const quota = Math.max(0, Math.min(cap - selected.length, Number(rawQuota) || 0));
    if (!quota) continue;
    const family = configured.filter((board) => board.provider === provider && !seen.has(board.rotationBoardId));
    const ordered = rotate(family, providerCursors[provider]);
    for (const board of ordered) {
      if (selected.length >= cap || selected.filter((item) => item.provider === provider).length >= quota) break;
      if (!selectedIds.has(board.rotationBoardId)) {
        selected.push(board);
        selectedIds.add(board.rotationBoardId);
      }
    }
    providerCursors[provider] = family.length
      ? (Math.max(0, Number(providerCursors[provider]) || 0) + quota) % family.length
      : 0;
  }

  const ordered = rotate(eligible, state.cursor);
  for (const board of ordered) {
    if (selected.length >= cap) break;
    if (!selectedIds.has(board.rotationBoardId)) {
      selected.push(board);
      selectedIds.add(board.rotationBoardId);
    }
  }

  const lastAttemptByBoard = { ...(state.lastAttemptByBoard || {}) };
  for (const board of selected) lastAttemptByBoard[board.rotationBoardId] = runAt;
  const remainingSlots = Math.max(1, cap - Object.values(providerQuotas).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0));
  const providerWindow = Math.max(1, ...Object.entries(providerQuotas).map(([provider, quota]) => {
    const count = configured.filter((board) => board.provider === provider).length;
    return quota > 0 ? Math.ceil(count / quota) : 1;
  }));
  const rotationWindowRuns = configured.length ? Math.max(providerWindow, Math.ceil(configured.length / remainingSlots)) : 0;
  const omitted = [
    ...duplicateConfigured,
    ...configured.filter((board) => !selectedIds.has(board.rotationBoardId)).map((board) => ({
      boardId: board.rotationBoardId,
      provider: board.provider,
      reason: seen.has(board.rotationBoardId) ? 'already-attempted-this-run' : cap === 0 ? 'board-cap-zero' : 'due-in-later-rotation-window',
    })),
  ];

  return {
    boards: selected,
    telemetry: {
      boardsConfigured: configured.length,
      boardsAttempted: selected.length,
      boardsOmitted: omitted.length,
      omissions: omitted,
      providerQuotas: { ...providerQuotas },
      rotationWindowRuns,
    },
    state: {
      cursor: eligible.length ? (Math.max(0, Number(state.cursor) || 0) + remainingSlots) % eligible.length : 0,
      providerCursors,
      lastAttemptByBoard,
      rotationWindowRuns,
    },
  };
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
    endpoint: clean(raw.endpoint),
    country: clean(raw.country),
    indiaFirst: raw.indiaFirst === true,
    indiaRelevant: raw.indiaRelevant === true,
    puneRelevant: raw.puneRelevant === true,
    startupTagged: raw.startupTagged === true,
    enabled,
    activationState,
    probeStatus: clean(raw.probeStatus) || (enabled ? 'verified' : 'proposed'),
    probedAt: clean(raw.probedAt),
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
export function projectLaneBoards(registry, lane, { enabledOnly = true } = {}) {
  const boards = [];
  for (const entry of registry?.boards ?? []) {
    if (entry.scheduleLane !== lane) continue;
    if (enabledOnly && !entry.enabled) continue;
    if (enabledOnly && entry.activationState === 'proposed') continue;
    boards.push(toAdapterBoard(entry));
  }
  return boards;
}

function toAdapterBoard(entry) {
  const provider = entry.provider;
  const shared = {
    id: entry.id,
    registryId: entry.id,
    activationState: entry.activationState,
    health: { ...entry.health },
    indiaFirst: entry.indiaFirst,
    indiaRelevant: entry.indiaRelevant,
    puneRelevant: entry.puneRelevant,
  };
  if (provider === 'workday') {
    return {
      ...shared,
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
    };
  }
  if (['smartrecruiters', 'workable', 'teamtailor', 'recruitee'].includes(provider)) {
    const out = {
      ...shared,
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
    return {
      ...shared,
      provider,
      slug: entry.slug || entry.boardKey,
      company: entry.company,
      enabled: entry.enabled,
      probeStatus: entry.probeStatus,
      probedAt: entry.probedAt,
      evidenceRef: entry.evidenceRef,
    };
  }
  // greenhouse / lever / ashby
  const out = {
    ...shared,
    provider,
    slug: entry.slug || entry.boardKey,
    company: entry.company,
  };
  if (entry.indiaFirst) out.indiaFirst = true;
  if (entry.startupTagged) out.startupTagged = true;
  if (entry.enabled === false) out.enabled = false;
  return out;
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
      id: entry.id,
      registryId: entry.id,
      provider: entry.provider,
      slug,
      careersUrl: portal.careers_url,
      activationState: entry.activationState,
      probeStatus: entry.probeStatus,
      health: { ...entry.health },
      indiaFirst: entry.indiaFirst,
      indiaRelevant: entry.indiaRelevant,
      puneRelevant: entry.puneRelevant,
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
  if (config?.boardRegistry) return config.boardRegistry;
  if (config?.boardRegistryPath) return loadBoardRegistry(config.boardRegistryPath);
  return null;
}

/**
 * Return a config whose sources.*.boards are projected from the unified registry.
 * When no registry is configured, returns config unchanged (test / inline fixtures).
 */
export function withRegistryProjectedBoards(config) {
  const registry = resolveBoardRegistry(config);
  if (!registry) return config;
  const sources = { ...(config.sources ?? {}) };
  for (const lane of SCHEDULE_LANES) {
    sources[lane] = {
      ...(sources[lane] ?? {}),
      boards: projectLaneBoards(registry, lane),
    };
  }
  return { ...config, boardRegistry: registry, sources };
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
