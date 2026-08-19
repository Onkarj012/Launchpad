import { createHash } from 'node:crypto';
import { normalizeCandidate } from '../job-pull/candidate.mjs';
import { classifyOriginalListingUrl } from './original-listing-resolver.mjs';

export const THEIRSTACK_JOB_SEARCH_URL = 'https://api.theirstack.com/v1/jobs/search';
export const THEIRSTACK_CURSOR_SCHEMA_VERSION = 'TheirStackCursorV1';
export const THEIRSTACK_CURSOR_VERSION = THEIRSTACK_CURSOR_SCHEMA_VERSION;
export const THEIRSTACK_CURSOR_SCHEMA = Object.freeze({
  schemaVersion: THEIRSTACK_CURSOR_SCHEMA_VERSION,
  required: Object.freeze(['querySetHash', 'queryIndex', 'offset']),
});

const REQUIRED_FILTERS = new Set([
  'posted_at_max_age_days', 'posted_at_gte', 'posted_at_lte',
  'company_domain_or', 'company_linkedin_url_or', 'company_name_or',
]);
const CONTROL_FIELDS = new Set([
  'apikey', 'api_key', 'authorization', 'headers',
  'limit', 'offset', 'page', 'cursor', 'include_total_results', 'order', 'order_by', 'blur_company_data',
]);
const ORDER_BY = Object.freeze([
  Object.freeze({ field: 'date_posted', desc: true }),
  Object.freeze({ field: 'discovered_at', desc: true }),
]);
const EMPLOYMENT_TYPES = new Map([
  ['full time', 'full-time'], ['full-time', 'full-time'], ['fulltime', 'full-time'], ['permanent', 'full-time'],
  ['intern', 'internship'], ['internship', 'internship'], ['paid internship', 'internship'],
  ['part time', 'part-time'], ['part-time', 'part-time'],
  ['contract', 'contract'], ['contractor', 'contract'], ['temporary', 'temporary'],
]);

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const bound = (value, fallback, { minimum = 0 } = {}) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
};

function cleanObject(value) {
  if (Array.isArray(value)) return value.map(cleanObject).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    return ['string', 'boolean'].includes(typeof value) ? value : undefined;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (CONTROL_FIELDS.has(key.toLowerCase())) continue;
    const cleaned = cleanObject(item);
    if (cleaned !== undefined) result[key] = cleaned;
  }
  return result;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function querySetHash(queries) {
  return createHash('sha256').update(JSON.stringify(stableValue(queries))).digest('hex');
}

function hasRequiredFilter(query) {
  return [...REQUIRED_FILTERS].some((key) => {
    if (!Object.hasOwn(query, key)) return false;
    const value = query[key];
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && value !== '';
  });
}

function canonicalHttpUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|source$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return null;
  }
}

function dateOnly(value) {
  const raw = text(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? null : date.toISOString();
}

function timestamp(value, fallback) {
  const raw = text(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}T/.test(raw) || Number.isNaN(Date.parse(raw))) return fallback;
  return new Date(raw).toISOString();
}

function locationFrom(job) {
  const direct = text(job?.location) || text(job?.long_location) || text(job?.short_location);
  if (direct) return direct;
  const component = [job?.city, job?.state_code, job?.country, job?.country_code].map(text).filter(Boolean);
  if (component.length) return [...new Set(component)].join(', ');
  if (!Array.isArray(job?.locations)) return null;
  const locations = job.locations.map((item) => {
    if (typeof item === 'string') return text(item);
    if (!item || typeof item !== 'object') return null;
    return text(item.display_name)
      || text([item.name, item.state || item.state_code, item.country_name || item.country_code].map(text).filter(Boolean).join(', '));
  }).filter(Boolean);
  return [...new Set(locations)].join('; ') || null;
}

function employmentFrom(value) {
  const statuses = Array.isArray(value) ? value : value == null ? [] : [value];
  for (const status of statuses) {
    const key = text(status)?.toLowerCase().replace(/[_\s]+/g, ' ');
    const mapped = key && EMPLOYMENT_TYPES.get(key);
    if (mapped) return { type: mapped, paid: null, evidence: text(status) };
  }
  return { type: null, paid: null, evidence: null };
}

function payloadOf(response) {
  const raw = response?.body ?? (typeof response?.json === 'object' ? response.json : null);
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

function requestError(statusCode = null, code = 'THEIRSTACK_REQUEST_FAILED') {
  const suffix = statusCode == null ? '' : ` with HTTP ${statusCode}`;
  const error = new Error(`TheirStack request failed${suffix}`);
  error.name = 'TheirStackRequestError';
  error.code = code;
  error.statusCode = statusCode;
  error.retryable = statusCode === 429 || (statusCode != null && statusCode >= 500 && statusCode <= 599);
  return error;
}

function continuation(querySetHashValue, queryIndex, offset) {
  return {
    schemaVersion: THEIRSTACK_CURSOR_SCHEMA_VERSION,
    querySetHash: querySetHashValue,
    queryIndex,
    offset,
  };
}

function normalizeCursor(cursor, hash, queryCount) {
  const sameHash = cursor?.querySetHash === hash || cursor?.queryHash === hash;
  const compatible = cursor?.schemaVersion === THEIRSTACK_CURSOR_SCHEMA_VERSION && sameHash;
  const queryIndex = Number(cursor?.queryIndex);
  const offset = Number(cursor?.offset);
  if (!compatible || !Number.isInteger(queryIndex) || queryIndex < 0 || queryIndex >= Math.max(1, queryCount)
    || !Number.isInteger(offset) || offset < 0) {
    return { queryIndex: 0, offset: 0, reset: Boolean(cursor) };
  }
  return { queryIndex, offset, reset: false };
}

function rowKeys(job) {
  const id = job?.id == null ? null : text(String(job.id));
  const final = classifyOriginalListingUrl(job?.final_url);
  const provenFinalUrl = ['ats', 'employer-career'].includes(final.kind) ? final.url : null;
  const discoveryUrl = canonicalHttpUrl(job?.url) || canonicalHttpUrl(job?.source_url);
  return {
    id: id ? `id:${id}` : null,
    final: provenFinalUrl ? `final:${provenFinalUrl}` : null,
    discovery: discoveryUrl ? `discovery:${discoveryUrl}` : null,
    provenFinalUrl,
    finalClassification: final,
    discoveryUrl,
  };
}

function duplicateKey(keys, seen) {
  if (keys.id && seen.ids.has(keys.id)) return keys.id;
  if (keys.final && seen.finals.has(keys.final)) return keys.final;
  if (keys.discovery && seen.discovery.has(keys.discovery)) return keys.discovery;
  return null;
}

function rememberKeys(keys, seen) {
  if (keys.id) seen.ids.add(keys.id);
  if (keys.final) seen.finals.add(keys.final);
  if (keys.discovery) seen.discovery.add(keys.discovery);
}

function candidateFrom(job, runAt, keys, context) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new TypeError('job row must be an object');
  const company = text(job.company) || text(job.company_object?.name);
  const title = text(job.job_title);
  const canonicalUrl = keys.discoveryUrl || keys.provenFinalUrl;
  const rawDate = text(job.date_posted);
  const providerDiscoveredAt = text(job.discovered_at);
  const postedAt = dateOnly(rawDate);
  const original = keys.provenFinalUrl;
  const originalProvider = original ? keys.finalClassification.provider : null;
  const workMode = job.hybrid === true ? 'hybrid' : job.remote === true ? 'remote' : null;
  const closedAt = text(job.closed_at);
  const evidence = {
    provider: 'theirstack',
    rawDatePosted: rawDate,
    providerDiscoveredAt,
    dateConfidence: postedAt ? 'provider-date-only' : null,
    finalUrlClassification: keys.finalClassification.kind,
    ...(original ? {
      originalApplication: 'theirstack-final_url-classified',
      originalApplicationProvider: originalProvider,
    } : {}),
    ...(closedAt ? { closedAt } : {}),
  };
  const candidate = normalizeCandidate({
    url: canonicalUrl,
    company,
    title,
    location: locationFrom(job),
    description: text(job.description),
    postedAt,
    discoveredAt: runAt,
    crawledAt: runAt,
    jobId: job.id == null ? null : String(job.id),
    provider: 'theirstack',
    source: 'theirstack',
    sourceKind: 'aggregator',
    sourceCategory: 'aggregator',
    workMode,
    employment: employmentFrom(job.employment_statuses),
    liveness: closedAt
      ? { status: 'Expired', checkedAt: runAt, evidence: 'theirstack-closed_at' }
      : { status: 'Not Verified', checkedAt: null, evidence: null },
    ...(original ? {
      originalApplicationUrl: original,
      applicationResolution: { status: 'Resolved Original', evidence: 'theirstack-final_url-classified' },
      originalApplicationEvidence: 'theirstack-final_url-classified',
    } : {}),
    evidence,
  }, { runAt, provider: 'theirstack', sourceKind: 'aggregator', sourceCategory: 'aggregator' });
  candidate.classification = 'lead';
  candidate.discoveryUrl = keys.discoveryUrl;
  candidate.originalApplicationProvider = originalProvider;
  candidate.provenance = {
    provider: 'theirstack',
    providerJobId: job.id == null ? null : String(job.id),
    endpoint: 'theirstack-jobs-search',
    endpointUrl: THEIRSTACK_JOB_SEARCH_URL,
    queryId: context.queryId,
    queryIndex: context.queryIndex,
    page: context.page,
    offset: context.offset,
    fetchedAt: runAt,
    rawDatePosted: rawDate,
    providerDiscoveredAt,
    url: text(job.url),
    source_url: text(job.source_url),
    final_url: text(job.final_url),
    finalUrlClassification: {
      kind: keys.finalClassification.kind,
      provider: keys.finalClassification.provider,
      host: keys.finalClassification.host || null,
      url: keys.finalClassification.url,
    },
    transportInjected: true,
  };
  return candidate;
}

function metadataNumber(metadata, key) {
  const value = number(metadata?.[key]);
  return value == null ? null : Math.max(0, Math.floor(value));
}

function capName(itemsRemaining, creditsRemaining) {
  if (itemsRemaining <= 0 && creditsRemaining <= 0) return 'maxItemsPerRun';
  return itemsRemaining <= 0 ? 'maxItemsPerRun' : 'maxCreditsPerRun';
}

export async function discoverTheirStack({
  transport,
  apiKey,
  runAt = new Date().toISOString(),
  queries = [],
  cursor = null,
  pageSize = 25,
  maxQueriesPerRun,
  maxPagesPerQuery = 10,
  maxItemsPerRun = 1_000,
  maxCreditsPerRun = 1_000,
} = {}) {
  if (!text(apiKey)) throw new TypeError('discoverTheirStack requires apiKey');
  if (typeof transport !== 'function') throw new TypeError('discoverTheirStack requires injected transport');
  const normalizedQueries = (Array.isArray(queries) ? queries : [queries]).map((query, index) => {
    if (!query || typeof query !== 'object' || Array.isArray(query)) throw new TypeError(`TheirStack query ${index} must be an object`);
    const wrapped = Object.hasOwn(query, 'filters');
    if (wrapped && (!query.filters || typeof query.filters !== 'object' || Array.isArray(query.filters))) {
      throw new TypeError(`TheirStack query ${index} filters must be an object`);
    }
    const filters = cleanObject(wrapped ? query.filters : query);
    if (!hasRequiredFilter(filters)) throw new TypeError(`TheirStack query ${index} requires a supported date or company filter`);
    return { queryId: wrapped ? text(query.id) : null, filters };
  });
  const hash = querySetHash(normalizedQueries);
  const resume = normalizeCursor(cursor, hash, normalizedQueries.length);
  const limits = {
    pageSize: bound(pageSize, 25, { minimum: 1 }),
    maxQueriesPerRun: bound(maxQueriesPerRun, normalizedQueries.length),
    maxPagesPerQuery: bound(maxPagesPerQuery, 10),
    maxItemsPerRun: bound(maxItemsPerRun, 1_000),
    maxCreditsPerRun: bound(maxCreditsPerRun, 1_000),
  };
  const observations = [];
  const verificationQueue = [];
  const seen = { ids: new Set(), finals: new Set(), discovery: new Set() };
  const telemetry = {
    creditsConsumed: 0,
    rowsReturned: 0,
    observationsNormalized: 0,
    duplicates: 0,
    invalidRecords: 0,
    verificationQueued: 0,
    queryDiagnostics: [],
  };
  let queryIndex = normalizedQueries.length ? resume.queryIndex : 0;
  let offset = resume.offset;
  let queriesProcessed = 0;
  let capHit = null;
  let providerTruncated = 0;
  let recordsNotExamined = 0;
  let interrupted = false;

  const buildManifest = () => ({
    schemaVersion: 'TheirStackManifestV1',
    runAt,
    querySetHash: hash,
    cursorReset: resume.reset,
    fetched: telemetry.rowsReturned,
    changed: observations.length,
    noAutoApply: true,
    writesPlanned: false,
    naturalTerminal: queryIndex >= normalizedQueries.length && !interrupted && !capHit && providerTruncated === 0,
    interrupted,
    truncated: Boolean(capHit || providerTruncated),
    capHit,
    recordsNotExamined: recordsNotExamined || null,
    telemetry,
  });

  while (queryIndex < normalizedQueries.length && queriesProcessed < limits.maxQueriesPerRun) {
    const query = normalizedQueries[queryIndex];
    const diagnostic = {
      queryIndex,
      startingOffset: offset,
      endingOffset: offset,
      pagesFetched: 0,
      rowsReturned: 0,
      observationsNormalized: 0,
      duplicates: 0,
      invalidRecords: 0,
      totalResults: null,
      totalCompanies: null,
      truncatedResults: 0,
      truncatedCompanies: 0,
      naturalTerminal: false,
      interrupted: false,
      capHit: null,
    };
    telemetry.queryDiagnostics.push(diagnostic);
    let queryTerminal = false;

    while (!queryTerminal) {
      const itemRemaining = limits.maxItemsPerRun - telemetry.rowsReturned;
      const creditRemaining = limits.maxCreditsPerRun - telemetry.creditsConsumed;
      if (itemRemaining <= 0 || creditRemaining <= 0) {
        capHit = capHit || capName(itemRemaining, creditRemaining);
        diagnostic.capHit = capHit;
        break;
      }
      if (diagnostic.pagesFetched >= limits.maxPagesPerQuery) {
        capHit = capHit || 'maxPagesPerQuery';
        diagnostic.capHit = capHit;
        break;
      }
      const limit = Math.min(limits.pageSize, itemRemaining, creditRemaining);
      const request = {
        ...query.filters,
        limit,
        offset,
        include_total_results: true,
        order_by: ORDER_BY.map((item) => ({ ...item })),
      };
      let response;
      try {
        response = await transport(THEIRSTACK_JOB_SEARCH_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
      } catch (cause) {
        interrupted = true;
        diagnostic.interrupted = true;
        const statusCode = number(cause?.statusCode ?? cause?.status);
        const error = requestError(statusCode, 'THEIRSTACK_TRANSPORT_ERROR');
        error.cursor = continuation(hash, queryIndex, offset);
        error.manifest = buildManifest();
        throw error;
      }
      const statusCode = number(response?.status) ?? 200;
      if (statusCode < 200 || statusCode >= 300) {
        interrupted = true;
        diagnostic.interrupted = true;
        const error = requestError(statusCode);
        error.cursor = continuation(hash, queryIndex, offset);
        error.manifest = buildManifest();
        throw error;
      }
      const payload = payloadOf(response);
      if (!payload || !Array.isArray(payload.data) || !payload.metadata || typeof payload.metadata !== 'object') {
        interrupted = true;
        diagnostic.interrupted = true;
        const error = requestError(statusCode, 'THEIRSTACK_MALFORMED_RESPONSE');
        error.cursor = continuation(hash, queryIndex, offset);
        error.manifest = buildManifest();
        throw error;
      }

      const rows = payload.data;
      const metadata = payload.metadata;
      const totalResults = metadataNumber(metadata, 'total_results');
      const totalCompanies = metadataNumber(metadata, 'total_companies');
      const truncatedResults = metadataNumber(metadata, 'truncated_results') ?? 0;
      const truncatedCompanies = metadataNumber(metadata, 'truncated_companies') ?? 0;
      diagnostic.pagesFetched += 1;
      diagnostic.rowsReturned += rows.length;
      diagnostic.totalResults = totalResults;
      diagnostic.totalCompanies = totalCompanies;
      diagnostic.truncatedResults = Math.max(diagnostic.truncatedResults, truncatedResults);
      diagnostic.truncatedCompanies = Math.max(diagnostic.truncatedCompanies, truncatedCompanies);
      telemetry.rowsReturned += rows.length;
      telemetry.creditsConsumed += rows.length;

      for (const job of rows) {
        const keys = rowKeys(job);
        if (duplicateKey(keys, seen)) {
          telemetry.duplicates += 1;
          diagnostic.duplicates += 1;
          continue;
        }
        try {
          const candidate = candidateFrom(job, runAt, keys, {
            queryId: query.queryId,
            queryIndex,
            page: diagnostic.pagesFetched,
            offset,
          });
          rememberKeys(keys, seen);
          observations.push(candidate);
          telemetry.observationsNormalized += 1;
          diagnostic.observationsNormalized += 1;
          if (text(job?.final_url) && !keys.provenFinalUrl) {
            verificationQueue.push({
              provider: 'theirstack',
              jobId: job?.id == null ? null : String(job.id),
              url: keys.discoveryUrl || canonicalHttpUrl(job.final_url),
              reason: 'unsupported-final-url',
              evidence: { finalUrlKind: keys.finalClassification.kind, finalUrlHost: keys.finalClassification.host || null },
            });
          }
        } catch (error) {
          telemetry.invalidRecords += 1;
          diagnostic.invalidRecords += 1;
          verificationQueue.push({
            provider: 'theirstack',
            jobId: job?.id == null ? null : String(job.id),
            url: keys.discoveryUrl || keys.provenFinalUrl,
            reason: 'invalid-record',
            evidence: { errors: Array.isArray(error?.errors) ? [...error.errors] : [error?.message || 'invalid record'] },
          });
        }
      }
      offset += rows.length;
      diagnostic.endingOffset = offset;
      const accessibleTotal = totalResults == null ? null : Math.max(0, totalResults - truncatedResults);
      const shortPage = rows.length < limit;
      const totalReached = accessibleTotal != null && offset >= accessibleTotal;
      queryTerminal = shortPage || totalReached;
      if (queryTerminal) {
        diagnostic.naturalTerminal = truncatedResults === 0;
        if (truncatedResults > 0) {
          providerTruncated += truncatedResults;
          recordsNotExamined += truncatedResults;
        }
        queryIndex += 1;
        offset = 0;
        queriesProcessed += 1;
        break;
      }
      const exhaustedItems = telemetry.rowsReturned >= limits.maxItemsPerRun;
      const exhaustedCredits = telemetry.creditsConsumed >= limits.maxCreditsPerRun;
      if (exhaustedItems || exhaustedCredits) {
        capHit = capHit || capName(limits.maxItemsPerRun - telemetry.rowsReturned, limits.maxCreditsPerRun - telemetry.creditsConsumed);
        diagnostic.capHit = capHit;
        if (totalResults != null) recordsNotExamined += Math.max(0, totalResults - offset);
        break;
      }
    }
    if (capHit || interrupted) break;
  }

  if (!capHit && queryIndex < normalizedQueries.length && queriesProcessed >= limits.maxQueriesPerRun) capHit = 'maxQueriesPerRun';
  const manifest = buildManifest();
  telemetry.verificationQueued = verificationQueue.length;
  const result = { observations, verificationQueue, manifest };
  if ((manifest.truncated || manifest.interrupted) && queryIndex < normalizedQueries.length && (capHit || interrupted)) {
    result.cursor = continuation(hash, queryIndex, offset);
  }
  return result;
}

export default discoverTheirStack;
