import { normalizeCandidate } from '../job-pull/candidate.mjs';

export const ATS_BATCH_1 = Object.freeze(['smartrecruiters', 'workable', 'teamtailor', 'recruitee']);
export const ATS_BATCH_SCHEMA_VERSION = 'AtsBatchFetchV1';

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const isoDate = (value) => {
  if (value == null || value === '') return null;
  const time = Date.parse(String(value));
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};
const first = (...values) => values.find((value) => text(value) != null) ?? null;
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;

function encode(value) { return encodeURIComponent(String(value ?? '').trim()); }
function boardId(board) {
  return first(board?.board, board?.account, board?.companyId, board?.slug, board?.name, board?.id);
}
function boardName(board) { return first(board?.company, board?.companyName, board?.name, boardId(board)) || 'Unknown Company'; }
function absolute(value, base) {
  try { return new URL(String(value), base).toString(); } catch { return null; }
}
function canonical(value) {
  const result = absolute(value, 'https://invalid.example');
  if (!result || result.startsWith('https://invalid.example')) return null;
  const url = new URL(result); url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$|source$)/i.test(key)) url.searchParams.delete(key);
  url.protocol = url.protocol.toLowerCase(); url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}
function headersOf(response) {
  const headers = response?.headers || {};
  return typeof headers.get === 'function'
    ? { etag: headers.get('etag'), lastModified: headers.get('last-modified') }
    : { etag: headers.etag ?? headers.ETag ?? headers['etag'] ?? null, lastModified: headers['last-modified'] ?? headers['Last-Modified'] ?? null };
}
function responseJson(response) {
  if (response?.json && typeof response.json === 'object') return response.json;
  if (response?.body && typeof response.body === 'object') return response.body;
  if (typeof response?.body === 'string') return JSON.parse(response.body);
  if (typeof response?.text === 'string') return JSON.parse(response.text);
  return null;
}

function smartrecruiters(board, { page, pageSize }) {
  const id = boardId(board);
  const url = new URL(board.endpoint || `https://api.smartrecruiters.com/v1/companies/${encode(id)}/postings`);
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('offset', String(page * pageSize));
  if (board.country) url.searchParams.set('country', board.country);
  if (board.city) url.searchParams.set('city', board.city);
  return url.toString();
}
function workable(board, { page, pageSize }) {
  const id = boardId(board);
  return `${board.endpoint || `https://apply.workable.com/api/v3/accounts/${encode(id)}/jobs`}?state=published&limit=${pageSize}&offset=${page * pageSize}`;
}
function teamtailor(board, { page, pageSize }) {
  const id = boardId(board);
  return `${board.endpoint || `https://${encode(id)}.teamtailor.com/api/jobs`}?page=${page + 1}&limit=${pageSize}`;
}
function recruitee(board, { page, pageSize }) {
  const id = boardId(board);
  return `${board.endpoint || `https://${encode(id)}.recruitee.com/api/offers`}?limit=${pageSize}&offset=${page * pageSize}`;
}

const ADAPTERS = {
  smartrecruiters: {
    url: smartrecruiters,
    rows: (body) => body?.content || body?.postings,
    next: (body, { page, pageSize }) => {
      const rows = body?.content || body?.postings;
      return Array.isArray(rows) && rows.length >= pageSize ? page + 1 : null;
    },
    map: (row, board) => ({ id: row?.id, title: row?.name, company: row?.company?.name || boardName(board), location: row?.location?.fullLocation || row?.location?.label || row?.location?.name || row?.location, description: row?.jobAd?.sections?.jobDescription?.text || row?.description, employmentType: row?.typeOfEmployment?.label || row?.typeOfEmployment, postedAt: row?.releasedDate || row?.createdOn, url: row?.ref || row?.postingUrl || row?.url }),
  },
  workable: {
    url: workable,
    rows: (body) => body?.jobs || body?.results,
    next: (body, { page }) => body?.nextPage || body?.next || (body?.hasNextPage ? page + 1 : null),
    map: (row, board) => ({ id: row?.shortcode || row?.id, title: row?.title || row?.name, company: row?.company?.name || boardName(board), location: row?.location || row?.city, description: row?.description || row?.descriptionPlain, postedAt: row?.published_on || row?.created_at, url: row?.url || row?.shortlink }),
  },
  teamtailor: {
    url: teamtailor,
    rows: (body) => body?.data || body?.jobs,
    next: (body, { page }) => body?.links?.next || body?.next || body?.meta?.page?.next || (Array.isArray(body?.data) && body.data.length > 0 ? page + 1 : null),
    map: (row, board) => { const a = row?.attributes || row; return { id: row?.id || a?.id, title: a?.title || a?.name, company: a?.company?.name || boardName(board), location: a?.location || a?.city, description: a?.body || a?.description, postedAt: a?.published_at || a?.created_at, url: a?.apply_url || a?.url || row?.links?.self }; },
  },
  recruitee: {
    url: recruitee,
    rows: (body) => body?.offers || body?.jobs || body?.data,
    next: (body, { page, pageSize }) => Array.isArray(body?.offers || body?.jobs || body?.data) && (body.offers || body.jobs || body.data).length >= pageSize ? page + 1 : null,
    map: (row, board) => ({ id: row?.id || row?.slug, title: row?.title || row?.name, company: row?.company?.name || boardName(board), location: row?.location || row?.department, description: row?.description || row?.descriptionPlain, postedAt: row?.published_at || row?.created_at, url: row?.careers_url || row?.url || row?.slug }),
  },
};

export function createAtsBatch1Adapters(overrides = {}) {
  return Object.fromEntries(ATS_BATCH_1.map((provider) => [provider, { ...ADAPTERS[provider], ...(overrides[provider] || {}) }]));
}

function classifyUrl(url, provider) {
  return url && new URL(url).hostname.match(new RegExp(`${provider === 'smartrecruiters' ? 'smartrecruiters\\.com' : provider === 'workable' ? 'workable\\.com' : provider === 'teamtailor' ? 'teamtailor\\.com' : 'recruitee\\.com'}$`, 'i')) ? 'direct' : 'lead';
}

function makeObservation(mapped, { provider, board, sourceUrl, runAt }) {
  const url = canonical(absolute(mapped.url, sourceUrl));
  if (!url || !text(mapped.title)) return null;
  const classification = classifyUrl(url, provider);
  const candidate = normalizeCandidate({
    url, jobId: mapped.id, title: mapped.title, company: mapped.company || boardName(board), location: mapped.location,
    description: mapped.description, employmentType: mapped.employmentType, postedAt: isoDate(mapped.postedAt), discoveredAt: runAt, crawledAt: runAt,
    source: sourceUrl, provider, sourceKind: classification === 'direct' ? 'ats-direct' : 'aggregator',
    liveness: { status: 'Active', checkedAt: runAt, evidence: 'public-ats-feed' },
    originalApplicationUrl: url,
    originalApplicationEvidence: classification === 'direct' ? 'public ATS posting' : null,
    evidence: { classification, provider, board: boardId(board), sourceUrl, endpoint: sourceUrl, providerJobId: mapped.id == null ? null : String(mapped.id), verified: classification === 'direct' },
  }, { runAt, provider, sourceCategory: classification === 'direct' ? 'direct-company' : 'aggregator' });
  candidate.classification = classification;
  return candidate;
}

function smartRecruitersDetail(row, body) {
  const sections = body?.jobAd?.sections ?? {};
  const description = [
    sections.jobDescription?.text,
    sections.qualifications?.text,
    sections.additionalInformation?.text,
  ].filter(Boolean).join('\n');
  return {
    ...row,
    description: description || row.description,
    url: body?.applyUrl || row.url,
    location: body?.location?.fullLocation || row.location,
    employmentType: body?.typeOfEmployment?.label || body?.typeOfEmployment || row.employmentType,
  };
}

export async function fetchAtsProvider({ provider, board, transport, runAt = new Date().toISOString(), pageSize = 50, maxPages = 5, maxJobs = 250, conditionalState = {}, cursorState = {}, adapters = createAtsBatch1Adapters(), retry = {}, enrichDetails = true } = {}) {
  if (typeof transport !== 'function') throw new TypeError('fetchAtsProvider requires injected transport');
  const adapter = adapters[provider];
  if (!adapter) return { provider, board: boardId(board), observations: [], failures: [{ kind: 'unsupported-provider', provider }], cursorState, conditionalState, manifest: { status: 'unsupported', provider, board: boardId(board), pages: 0, jobs: 0 } };
  if (!boardId(board)) return { provider, observations: [], failures: [{ kind: 'malformed-board', provider, reason: 'board identifier is required' }], cursorState, conditionalState, manifest: { status: 'malformed', provider, pages: 0, jobs: 0 } };
  const observations = []; const failures = []; const seen = new Set();
  const boardCursor = cursorState[provider]?.[boardId(board)] || {};
  let page = Number(boardCursor.page ?? 0);
  let rowOffset = Number.isFinite(Number(boardCursor.rowOffset)) ? Math.max(0, Number(boardCursor.rowOffset)) : 0;
  let pages = 0; let fetched = 0; let status = 'ok'; let nextEndpoint = null;
  const boundedPages = Math.max(0, Number(maxPages)); const boundedJobs = Math.max(0, Number(maxJobs));
  while (pages < boundedPages && observations.length < boundedJobs) {
    const url = canonical(nextEndpoint || adapter.url(board, { page, pageSize: Math.max(1, Number(pageSize)) }));
    if (!url) { failures.push({ kind: 'invalid-endpoint', provider, board: boardId(board), page }); status = 'malformed'; break; }
    let response;
    try { response = await transport(url, { method: 'GET', headers: { ...(rowOffset === 0 && conditionalState[url]?.etag ? { 'if-none-match': conditionalState[url].etag } : {}), ...(rowOffset === 0 && conditionalState[url]?.lastModified ? { 'if-modified-since': conditionalState[url].lastModified } : {}) }, provider, board, page }); }
    catch (error) { failures.push({ kind: 'transport', provider, board: boardId(board), page, message: error?.message || 'transport error' }); status = 'failed'; break; }
    const httpStatus = Number(response?.status ?? 200);
    if (httpStatus === 304) { pages += 1; status = 'not-modified'; break; }
    if (httpStatus < 200 || httpStatus >= 300) { failures.push({ kind: httpStatus >= 500 || httpStatus === 429 ? 'retryable' : 'http', provider, board: boardId(board), page, status: httpStatus }); status = httpStatus >= 500 || httpStatus === 429 ? 'retryable' : 'failed'; break; }
    let body;
    try { body = responseJson(response); } catch { failures.push({ kind: 'malformed-json', provider, board: boardId(board), page, url }); status = 'malformed'; break; }
    const rows = adapter.rows(body);
    if (!Array.isArray(rows)) { failures.push({ kind: 'malformed-payload', provider, board: boardId(board), page, url }); status = 'malformed'; break; }
    fetched += rows.length;
    const headers = headersOf(response); conditionalState[url] = { ...(conditionalState[url] || {}), canonicalUrl: url, etag: headers.etag, lastModified: headers.lastModified };
    let pageComplete = true;
    for (let rowIndex = rowOffset; rowIndex < rows.length; rowIndex += 1) {
      if (observations.length >= boundedJobs) { pageComplete = false; break; }
      const row = rows[rowIndex];
      rowOffset = rowIndex + 1;
      let mapped = adapter.map(row, board);
      if (provider === 'smartrecruiters' && row?.ref && enrichDetails) {
        try {
          const detailResponse = await transport(row.ref, { method: 'GET', headers: {}, provider, board, page, detail: true });
          if (Number(detailResponse?.status ?? 200) >= 200 && Number(detailResponse?.status ?? 200) < 300) {
            mapped = smartRecruitersDetail(mapped, responseJson(detailResponse));
          } else {
            failures.push({ kind: 'detail-http', provider, board: boardId(board), page, status: Number(detailResponse?.status), url: row.ref });
          }
        } catch (error) {
          failures.push({ kind: 'detail-transport', provider, board: boardId(board), page, message: error?.message || 'detail transport error', url: row.ref });
        }
      }
      const item = makeObservation(mapped, { provider, board, sourceUrl: url, runAt });
      if (!item) { failures.push({ kind: 'malformed-record', provider, board: boardId(board), page }); continue; }
      if (!seen.has(item.canonicalUrl)) { seen.add(item.canonicalUrl); observations.push(item); }
    }
    pages += 1;
    if (!pageComplete) break;
    rowOffset = 0;
    const next = adapter.next(body, { page, pageSize });
    if (next == null || next === false || rows.length === 0) { page = page + 1; break; }
    if (typeof next === 'string' && /^https?:\/\//i.test(next)) { nextEndpoint = next; page += 1; } else { nextEndpoint = null; page = Number(next); }
  }
  const nextCursor = { page };
  if (rowOffset > 0) nextCursor.rowOffset = rowOffset;
  cursorState[provider] = { ...(cursorState[provider] || {}), [boardId(board)]: nextCursor };
  return { provider, board: boardId(board), observations, failures, cursorState, conditionalState, manifest: { status, provider, board: boardId(board), pages, fetched, jobs: observations.length, foreignDiscardedAtSource: 0, bounded: { maxPages: boundedPages, maxJobs: boundedJobs, pageSize } } };
}

export async function fetchAtsBatch1({ boards = [], transport, runAt = new Date().toISOString(), maxBoards = 100, ...options } = {}) {
  if (typeof transport !== 'function') throw new TypeError('fetchAtsBatch1 requires injected transport');
  const cursorState = { ...(options.cursorState || {}) }; const conditionalState = { ...(options.conditionalState || {}) }; const results = []; const observations = []; const failures = []; const seen = new Set();
  for (const board of boards.slice(0, Math.max(0, Number(maxBoards)))) {
    const provider = String(board?.provider || '').toLowerCase();
    const result = await fetchAtsProvider({ ...options, board, provider, transport, runAt, cursorState, conditionalState }); results.push(result); failures.push(...result.failures);
    for (const observation of result.observations) if (!seen.has(observation.canonicalUrl)) { seen.add(observation.canonicalUrl); observations.push(observation); }
  }
  return { schemaVersion: ATS_BATCH_SCHEMA_VERSION, observations, manifest: { schemaVersion: 'AtsBatchManifestV1', batch: 'ats-batch-1', runAt, providers: ATS_BATCH_1, boardsAttempted: results.length, boardsBound: Math.min(boards.length, Math.max(0, Number(maxBoards))), pages: results.reduce((sum, result) => sum + (result.manifest.pages || 0), 0), fetched: results.reduce((sum, result) => sum + (result.manifest.fetched || 0), 0), direct: observations.filter((row) => row.evidence.classification === 'direct').length, leads: observations.filter((row) => row.evidence.classification === 'lead').length, failures: failures.length, sources: results.map((result, index) => ({ provider: result.provider, board: result.board, company: boards[index]?.company ?? boards[index]?.name ?? result.board, fetched: Number(result.manifest.fetched || 0), observations: result.observations.length, foreignDiscardedAtSource: Number(result.manifest.foreignDiscardedAtSource || 0), status: result.manifest.status, failures: result.failures.length })), noAutoApply: true }, cursorState, conditionalState, failures, results };
}

export const runAtsBatch1 = fetchAtsBatch1;
export default fetchAtsBatch1;
