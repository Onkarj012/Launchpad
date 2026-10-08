import { canonicalizeUrl, normalizedKey, normalizeCandidate } from '../job-pull/candidate.mjs';
import { boardIdentityKey, planBoardRotation, recordBoardHealth } from './board-registry.mjs';
import { mapProviderSafe } from './bounded-concurrency.mjs';

import { decodeEntities } from '../vendor/career-ops/providers/_html-entities.mjs';
import { loadConfig } from '../job-pull/config.mjs';
import { classifyCandidate } from '../job-pull/eligibility.mjs';
import { classifyFreshness } from '../job-pull/freshness.mjs';

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
    ? decodeEntities(decodeEntities(value)).replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#xa0;/gi, ' ').replace(/\s+/g, ' ').trim()
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
// Expose the public feed URL and unfiltered locations for registry probes.
export function warmAtsProbeFeed(board, body) {
  const listings = rows(board.provider, body);
  return { url: endpoint(board), locations: Array.isArray(listings) ? listings.map((row) => sourceLocation(board.provider, row)) : null, complete: true };
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
  const startupStageEvidenceRef = typeof board.evidenceRef === 'string' && board.evidenceRef.trim()
    ? board.evidenceRef.trim()
    : null;
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
      ...(startupStageEvidenceRef ? { startupStageEvidenceRef } : {}),
      ...(sourceGeoObservation ? { sourceGeoObservation } : {}),
    },
  }, { runAt, provider: board.provider, sourceCategory: 'direct-company' });
  item.classification = 'direct';
  // Board-level startup tagging is only a stage assertion. Promote it into
  // focused Startup fallback evidence when the board retains an independent
  // evidence reference; the generated label must never prove itself.
  if (startupTagged) {
    item.companyStage = 'Startup';
    if (startupStageEvidenceRef) {
      item.startupStageEvidenceRef = startupStageEvidenceRef;
      item.companyStageEvidence = startupStageEvidenceRef;
    }
  }
  return item;
}

function clockMs(clock) {
  const value = typeof clock?.now === 'function' ? clock.now() : Date.now();
  const parsed = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

async function boundedTransport(transport, url, options, timeoutMs, parentSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener?.('abort', onAbort, { once: true });
  let timer;
  try {
    const request = Promise.resolve().then(() => transport(url, { ...options, timeoutMs, signal: controller.signal }));
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`warm ATS request timed out after ${timeoutMs}ms`);
        error.code = 'ETIMEDOUT';
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener?.('abort', onAbort);
  }
}

export async function fetchWarmAts({
  boards = [],
  transport,
  runAt = new Date().toISOString(),
  maxBoards = 40,
  maxJobsPerBoard = 100,
  maxDetailRequests = 10,
  rotation = {},
  rotationState = {},
  seenBoardIds = [],
  registry = null,
  boardConcurrency = 1,
  requestTimeoutMs = 10_000,
  // Large Greenhouse/Ashby boards with content=true exceed the 2 MB transport default.
  maxResponseBytes = 12_000_000,
  maxDurationMs = Infinity,
  deadline = null,
  signal = null,
  clock = null,
} = {}) {
  if (typeof transport !== 'function') throw new TypeError('fetchWarmAts requires injected transport');
  const observations = [];
  const policy = loadConfig();
  let detailRequests = 0;
  const failures = [];
  const sources = [];
  const omissions = [];
  const startedAt = clockMs(clock);
  const configuredDurationMs = Math.max(1, Number(maxDurationMs) || Infinity);
  const parentRemainingMs = Number.isFinite(Number(deadline?.remainingMs)) ? Number(deadline.remainingMs) : Infinity;
  const effectiveDurationMs = Math.min(configuredDurationMs, parentRemainingMs);
  const deadlineAt = Number.isFinite(effectiveDurationMs) ? startedAt + effectiveDurationMs : Infinity;
  let deadlineExhausted = false;
  const remainingMs = () => Math.max(0, deadlineAt - clockMs(clock));
  const unsupportedBoards = boards.filter((board) => !PROVIDERS.has(String(board?.provider || '').toLowerCase()));
  const warmBoards = boards.filter((board) => PROVIDERS.has(String(board?.provider || '').toLowerCase()));
  const plan = rotation.enabled === true
    ? planBoardRotation({
      boards: warmBoards,
      maxBoards,
      providerQuotas: rotation.providerQuotas ?? { ashby: 1, greenhouse: 1, lever: 1 },
      state: rotationState,
      runAt,
      seenBoardIds,
    })
    : {
      boards: warmBoards.filter((_board, index) => index < Math.max(0, Number(maxBoards))),
      telemetry: {
        boardsConfigured: boards.length,
        boardsAttempted: Math.min(warmBoards.length, Math.max(0, Number(maxBoards))),
        boardsOmitted: Math.max(0, boards.length - Math.max(0, Number(maxBoards))),
        omissions: [...unsupportedBoards.map((board) => ({
          boardId: board.id || board.registryId || boardIdentityKey(board),
          provider: board.provider,
          reason: 'unsupported-warm-provider',
        })), ...warmBoards.slice(Math.max(0, Number(maxBoards))).map((board) => ({
          boardId: board.id || board.registryId || boardIdentityKey(board),
          provider: board.provider,
          reason: 'legacy-cap-order',
        }))],
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
    const boardId = board.id || board.registryId || board.rotationBoardId || boardIdentityKey(board);
    const availableMs = remainingMs();
    if (signal?.aborted || availableMs <= 0) {
      deadlineExhausted = true;
      return { board, omitted: { boardId, provider, reason: 'source-deadline-exhausted' } };
    }
    if (!PROVIDERS.has(provider) || !url) {
      return { board, attempted: false, failure: { provider, board: board?.slug, code: 'INVALID_WARM_BOARD' } };
    }
    try {
      const timeoutMs = Math.max(1, Math.min(Number(requestTimeoutMs) || 10_000, availableMs));
      const response = await boundedTransport(transport, url, { method: 'GET', provider, board, warm: true, maxBytes: maxResponseBytes }, timeoutMs, signal);
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
      // Provider arrays may be title-sorted, so freshness must precede the row cap.
      const newestFirst = eligibleListings.map((raw, index) => ({ raw, index, postedAt: isoDate(mapRow(provider, raw, board).postedAt) }))
        .sort((left, right) => (right.postedAt || '').localeCompare(left.postedAt || '') || left.index - right.index);
      const boardObservations = [];
      for (const { raw } of newestFirst.slice(0, Math.max(0, Number(maxJobsPerBoard)))) {
        const sourceGeoObservation = oldFilterWouldDiscard(raw) ? 'india-first-filter-bypass' : null;
        let item = candidate(mapRow(provider, raw, board), { ...board, provider }, url, runAt, sourceGeoObservation);
        if (item && provider === 'greenhouse' && !item.description
          && classifyCandidate(item, policy).eligible && classifyFreshness(item, { now: runAt, ...policy.freshness }).eligible) {
          const detailUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.slug || board.board)}/jobs/${encodeURIComponent(item.jobId)}`;
          try {
            if (signal?.aborted || remainingMs() <= 0 || detailRequests >= maxDetailRequests) throw new Error('DETAIL_BUDGET_EXHAUSTED');
            detailRequests++;
            const detailResponse = await boundedTransport(transport, detailUrl, { method: 'GET', provider, board, warm: true }, Math.max(1, Math.min(Number(requestTimeoutMs) || 10_000, remainingMs())), signal);
            if (Number(detailResponse.status) < 200 || Number(detailResponse.status) >= 300) throw new Error(`HTTP_${detailResponse.status}`);
            const detail = typeof detailResponse.body === 'string' ? JSON.parse(detailResponse.body) : detailResponse.body;
            if (String(detail?.id) !== item.jobId || normalizedKey(detail?.title) !== normalizedKey(item.title)
              || canonicalizeUrl(detail?.absolute_url) !== item.canonicalUrl || !stripHtml(detail?.content)) throw new Error('DETAIL_IDENTITY_OR_CONTENT_INVALID');
            item = candidate(mapRow(provider, { ...raw, ...detail }, board), { ...board, provider }, detailUrl, runAt, sourceGeoObservation);
            item.evidence.detailUrl = detailUrl;
          } catch (error) {
            item = { ...item, liveness: { status: 'Not Verified', checkedAt: runAt, evidence: 'Greenhouse detail unavailable' },
              evidence: { ...item.evidence, detailFailure: error.message } };
          }
        }
        if (item) boardObservations.push(item);
      }
      return {
        board,
        attempted: true,
        observations: boardObservations,
        source: { provider, board: board.slug, company: board.company, fetched: listings.length, observations: boardObservations.length, foreignDiscardedAtSource, foreignPassedThroughAtSource, status: 'ok' },
      };
    } catch (error) {
      if (error?.code === 'ETIMEDOUT' && remainingMs() <= 0) deadlineExhausted = true;
      return { board, attempted: true, failure: { provider, board: board.slug, code: error?.code === 'ETIMEDOUT' ? 'REQUEST_TIMEOUT' : 'TRANSPORT_ERROR', message: error?.message || 'transport error' } };
    }
  });
  let attemptedBoards = 0;
  for (const result of boardResults) {
    if (result.omitted) {
      omissions.push(result.omitted);
      deadlineExhausted = true;
    } else if (result.failure) {
      if (result.attempted) attemptedBoards += 1;
      failures.push(result.failure);
      updateHealth(result.board, { failure: true, at: runAt });
    } else {
      attemptedBoards += 1;
      observations.push(...result.observations);
      sources.push(result.source);
      updateHealth(result.board, { success: true, at: runAt });
    }
  }
  const allOmissions = [...(plan.telemetry?.omissions ?? []), ...omissions];
  return {
    observations,
    failures,
    manifest: {
      schemaVersion: 'WarmAtsManifestV1',
      ...plan.telemetry,
      boardsSelected: plan.boards.length,
      boardsAttempted: attemptedBoards,
      boardsSucceeded: sources.length,
      boardsFailed: failures.length,
      boardsOmitted: allOmissions.length,
      omissions: allOmissions,
      deadline: {
        enabled: Number.isFinite(effectiveDurationMs),
        exhausted: deadlineExhausted,
        elapsedMs: Math.max(0, clockMs(clock) - startedAt),
        maxDurationMs: Number.isFinite(effectiveDurationMs) ? effectiveDurationMs : null,
      },
      detailRequests,
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
