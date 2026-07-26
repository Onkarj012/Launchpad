import { normalizeCandidate } from '../job-pull/candidate.mjs';
import { boardIdentityKey, planBoardRotation, recordBoardHealth } from './board-registry.mjs';
import { mapProviderSafe } from './bounded-concurrency.mjs';

const PROVIDERS = new Set(['greenhouse', 'lever', 'ashby']);

function endpoint(board) {
  const slug = encodeURIComponent(String(board.slug || board.board || '').trim());
  if (!slug) return null;
  if (board.endpoint) return board.endpoint;
  if (board.provider === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  if (board.provider === 'lever') return `https://api.lever.co/v0/postings/${slug}`;
  if (board.provider === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  return null;
}

function rows(provider, body) {
  if (provider === 'greenhouse') return body?.jobs;
  if (provider === 'lever') return Array.isArray(body) ? body : null;
  if (provider === 'ashby') return body?.jobs;
  return null;
}

function stripHtml(value) {
  return typeof value === 'string'
    ? value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#xa0;/gi, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function isoDate(value) {
  if (value == null || value === '') return null;
  const time = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function mapRow(provider, row, board) {
  if (provider === 'greenhouse') return {
    id: row.id, title: row.title, url: row.absolute_url, location: row.location?.name,
    description: stripHtml(row.content), postedAt: row.first_published || row.updated_at,
    employmentType: row.employment_type,
  };
  if (provider === 'lever') return {
    id: row.id, title: row.text, url: row.hostedUrl, location: row.categories?.location,
    description: [row.descriptionPlain, ...(row.lists || []).flatMap((part) => [part?.text, stripHtml(part?.content)]), row.additionalPlain].filter(Boolean).join('\n'),
    postedAt: typeof row.createdAt === 'number' ? new Date(row.createdAt).toISOString() : row.createdAt,
    employmentType: row.categories?.commitment,
  };
  return {
    id: row.id, title: row.title, url: row.jobUrl || row.applyUrl, location: row.location,
    description: row.descriptionPlain || stripHtml(row.descriptionHtml), postedAt: row.publishedAt,
    employmentType: row.employmentType,
  };
}

const INDIA_LOCATION = /\b(india|ind|pune|bengaluru|bangalore|hyderabad|chennai|gurugram|gurgaon|noida|new delhi|delhi|ncr|mumbai|maharashtra|karnataka|telangana|tamil nadu)\b/i;
const FOREIGN_ONLY_LOCATION = /\b(?:austria|belgium|brazil|canada|china|denmark|france|germany|ireland|italy|japan|mexico|netherlands|new zealand|poland|portugal|singapore|south africa|spain|sweden|switzerland|united kingdom|uk|united states|usa|us)\b/i;
function sourceLocation(provider, row) {
  if (provider === 'greenhouse') return row?.location?.name || '';
  if (provider === 'lever') return row?.categories?.location || '';
  return row?.location || '';
}
function clearlyForeign(provider, row) {
  const location = String(sourceLocation(provider, row)).trim();
  if (!location) return false;
  if (/\b(?:us|usa|united states|uk|united kingdom)\s+only\b/i.test(location)) return true;
  if (/\b(?:apac|asia[ -]pacific|worldwide|global|anywhere|remote)\b/i.test(location)) return false;
  if (INDIA_LOCATION.test(location)) return false;
  return FOREIGN_ONLY_LOCATION.test(location);
}

function candidate(row, board, sourceUrl, runAt, sourceGeoObservation = null) {
  if (!row.url || !row.title) return null;
  const startupTagged = board.startupTagged === true;
  const item = normalizeCandidate({
    url: row.url,
    jobId: row.id,
    company: board.company || board.name || board.slug,
    title: row.title,
    location: row.location,
    description: row.description,
    employmentType: row.employmentType,
    postedAt: isoDate(row.postedAt),
    discoveredAt: runAt,
    crawledAt: runAt,
    provider: board.provider,
    source: sourceUrl,
    sourceKind: 'ats-direct',
    originalApplicationUrl: row.url,
    originalApplicationEvidence: 'public ATS posting',
    liveness: { status: 'Active', checkedAt: runAt, evidence: 'public-ats-feed' },
    evidence: {
      classification: 'direct', verified: true, provider: board.provider, board: board.slug, sourceUrl, startupTagged,
      ...(sourceGeoObservation ? { sourceGeoObservation } : {}),
    },
  }, { runAt, provider: board.provider, sourceCategory: 'direct-company' });
  item.classification = 'direct';
  // Board-level startup tagging is operator-curated, evidence-backed metadata
  // (see config/crawler-v2.json sources.atsWarm.boards[].startupTagged). It is
  // prioritization signal only and must never substitute for freshness,
  // liveness, or readiness verification, which run unchanged elsewhere.
  if (startupTagged) {
    item.companyStage = 'Startup';
    item.companyStageEvidence = `warm ATS board tagged startup: ${board.company || board.slug}`;
  }
  return item;
}

export async function fetchWarmAts({
  boards = [],
  transport,
  runAt = new Date().toISOString(),
  maxBoards = 40,
  maxJobsPerBoard = 100,
  rotation = {},
  rotationState = {},
  seenBoardIds = [],
  registry = null,
  boardConcurrency = 1,
} = {}) {
  if (typeof transport !== 'function') throw new TypeError('fetchWarmAts requires injected transport');
  const observations = [];
  const failures = [];
  const sources = [];
  const plan = rotation.enabled === true
    ? planBoardRotation({
      boards,
      maxBoards,
      providerQuotas: rotation.providerQuotas ?? { ashby: 1, greenhouse: 1, lever: 1 },
      state: rotationState,
      runAt,
      seenBoardIds,
    })
    : {
      boards: boards.filter((_board, index) => index < Math.max(0, Number(maxBoards))),
      telemetry: {
        boardsConfigured: boards.length,
        boardsAttempted: Math.min(boards.length, Math.max(0, Number(maxBoards))),
        boardsOmitted: Math.max(0, boards.length - Math.max(0, Number(maxBoards))),
        omissions: boards.slice(Math.max(0, Number(maxBoards))).map((board) => ({
          boardId: board.id || board.registryId || boardIdentityKey(board),
          provider: board.provider,
          reason: 'legacy-cap-order',
        })),
        rotationWindowRuns: null,
      },
      state: rotationState,
    };
  let healthRegistry = registry;
  const healthEvents = [];
  const updateHealth = (board, event) => {
    const boardId = board.id || board.registryId || board.rotationBoardId || boardIdentityKey(board);
    healthEvents.push({ boardId, ...event });
    if (healthRegistry && boardId) healthRegistry = recordBoardHealth(healthRegistry, boardId, event);
  };
  const boardResults = await mapProviderSafe(plan.boards, {
    concurrency: boardConcurrency,
    providerKey: (board) => board?.provider,
  }, async (board) => {
    const provider = String(board?.provider || '').toLowerCase();
    const url = endpoint({ ...board, provider });
    if (!PROVIDERS.has(provider) || !url) {
      return { board, failure: { provider, board: board?.slug, code: 'INVALID_WARM_BOARD' } };
    }
    try {
      const response = await transport(url, { method: 'GET', provider, board, warm: true });
      const status = Number(response?.status ?? 200);
      if (status < 200 || status >= 300) {
        return { board, failure: { provider, board: board.slug, code: `HTTP_${status}` } };
      }
      const body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
      const listings = rows(provider, body);
      if (!Array.isArray(listings)) {
        return { board, failure: { provider, board: board.slug, code: 'MALFORMED_PAYLOAD' } };
      }
      const indiaFirst = board.indiaFirst === true;
      const eligibleListings = indiaFirst ? listings.filter((row) => !clearlyForeign(provider, row)) : listings;
      const foreignDiscardedAtSource = listings.length - eligibleListings.length;
      const oldFilterWouldDiscard = (raw) => {
        const location = String(sourceLocation(provider, raw)).trim();
        return indiaFirst && Boolean(location) && !INDIA_LOCATION.test(location);
      };
      const foreignPassedThroughAtSource = indiaFirst
        ? eligibleListings.filter((raw) => oldFilterWouldDiscard(raw)).length
        : 0;
      const boardObservations = [];
      for (const raw of eligibleListings.slice(0, Math.max(0, Number(maxJobsPerBoard)))) {
        const sourceGeoObservation = oldFilterWouldDiscard(raw) ? 'india-first-filter-bypass' : null;
        const item = candidate(mapRow(provider, raw, board), { ...board, provider }, url, runAt, sourceGeoObservation);
        if (item) boardObservations.push(item);
      }
      return {
        board,
        observations: boardObservations,
        source: { provider, board: board.slug, company: board.company, fetched: listings.length, observations: boardObservations.length, foreignDiscardedAtSource, foreignPassedThroughAtSource, status: 'ok' },
      };
    } catch (error) {
      return { board, failure: { provider, board: board.slug, code: 'TRANSPORT_ERROR', message: error?.message || 'transport error' } };
    }
  });
  for (const result of boardResults) {
    if (result.failure) {
      failures.push(result.failure);
      updateHealth(result.board, { failure: true, at: runAt });
    } else {
      observations.push(...result.observations);
      sources.push(result.source);
      updateHealth(result.board, { success: true, at: runAt });
    }
  }
  return {
    observations,
    failures,
    manifest: {
      schemaVersion: 'WarmAtsManifestV1',
      ...plan.telemetry,
      fetched: sources.reduce((sum, source) => sum + source.fetched, 0),
      failed: failures.length,
      sources,
      healthEvents,
      noAutoApply: true,
    },
    rotationState: plan.state,
    registry: healthRegistry,
  };
}

export default fetchWarmAts;
