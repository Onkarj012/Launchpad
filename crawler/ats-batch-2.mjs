import { normalizeCandidate } from '../job-pull/candidate.mjs';

export const ATS_BATCH_2_PROVIDERS = Object.freeze(['breezy', 'bamboohr', 'personio', 'comeet', 'pinpoint', 'rippling']);
const RETRYABLE = new Set([408, 425, 429]);

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const isoDate = (value) => {
  if (!value) return null;
  const time = Date.parse(String(value));
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

function canonical(value) {
  try {
    const url = new URL(String(value));
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|source$|ref$)/i.test(key)) url.searchParams.delete(key);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    url.pathname = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    return url.toString();
  } catch { return null; }
}

function boardUrl(board) {
  if (board.baseUrl) return canonical(board.baseUrl);
  if (!board.slug) return null;
  const hosts = {
    breezy: `${board.slug}.breezy.hr`,
    bamboohr: `${board.slug}.bamboohr.com`,
    personio: `${board.slug}.jobs.personio.com`,
    comeet: `www.comeet.com/jobs/${board.slug}`,
    pinpoint: `${board.slug}.pinpointhq.com`,
    rippling: `ats.rippling.com/${board.slug}`,
  };
  return canonical(`https://${hosts[board.provider] || board.slug}`);
}

function endpointFor(board, page) {
  const root = boardUrl(board);
  if (!root) return null;
  const paths = { breezy: '/json', bamboohr: '/careers/list', personio: '/xml', comeet: '/positions/api', pinpoint: '/postings.json', rippling: '/jobs' };
  const endpoint = board.endpoint || paths[board.provider];
  const url = new URL(endpoint, `${root}/`);
  if (page > 1 && board.provider === 'bamboohr') url.searchParams.set('page', String(page));
  return url.toString();
}

function responseBody(response) {
  if (typeof response?.body === 'object' && response.body !== null) return response.body;
  if (typeof response?.json === 'object' && response.json !== null) return response.json;
  if (typeof response?.body === 'string') return response.body;
  return '';
}

function xmlText(value) {
  return text(String(value ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' '));
}
function xmlField(block, name) {
  const match = String(block).match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? xmlText(match[1]) : null;
}
function parsePersonio(body) {
  return [...String(body).matchAll(/<(?:position|job|jobPosition)\b[^>]*>([\s\S]*?)<\/(?:position|job|jobPosition)>/gi)].map((match) => {
    const block = match[1];
    return { id: xmlField(block, 'id') || xmlField(block, 'requisitionId'), title: xmlField(block, 'name') || xmlField(block, 'title'), location: xmlField(block, 'office') || xmlField(block, 'location'), description: xmlField(block, 'jobDescription') || xmlField(block, 'description'), postedAt: xmlField(block, 'createdAt') || xmlField(block, 'publishedAt'), url: xmlField(block, 'url') || xmlField(block, 'applicationUrl') };
  });
}

function parseRows(provider, body) {
  if (provider === 'personio') return parsePersonio(body);
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return null; }
  }
  if (provider === 'breezy') return Array.isArray(body) ? body : body?.positions ?? body?.jobs ?? null;
  if (provider === 'bamboohr') return body?.result ?? body?.results ?? body?.jobs ?? (Array.isArray(body) ? body : null);
  // Pinpoint's live postings.json is JSON:API-shaped ({ data: [...] }), not
  // the { jobs / positions / results / items } shape the other batch-2
  // providers use.
  if (['comeet', 'pinpoint', 'rippling'].includes(provider)) return body?.jobs ?? body?.positions ?? body?.results ?? body?.items ?? body?.data ?? (Array.isArray(body) ? body : null);
  return null;
}

function pinpointLocationText(value) {
  if (!value || typeof value !== 'object') return text(value);
  return text([value.city, value.province, value.country].filter(Boolean).join(', ')) || text(value.name);
}

function providerJobUrl(board, row) {
  const raw = row.url || row.applicationUrl || row.jobUrl || row.job_url || row.jobOpeningUrl || row.link;
  if (raw) return canonical(new URL(raw, `${boardUrl(board)}/`).toString());
  if (board.provider === 'breezy' && (row.slug || row.id)) return canonical(`${boardUrl(board)}/p/${row.slug || row.id}`);
  if (board.provider === 'bamboohr' && row.id) return canonical(`${boardUrl(board)}/careers/${row.id}`);
  if (['comeet', 'pinpoint', 'rippling'].includes(board.provider) && (row.slug || row.id)) return canonical(`${boardUrl(board)}/jobs/${row.slug || row.id}`);
  return null;
}

function classify(board, url) {
  if (board.classification === 'lead' || board.direct === false) return 'lead';
  return url && boardUrl(board) && new URL(url).hostname.endsWith(new URL(boardUrl(board)).hostname) ? 'direct' : 'lead';
}

function candidateFrom(board, row, runAt, sourceUrl) {
  const url = providerJobUrl(board, row);
  if (!url || !text(row.title || row.name || row.jobTitle || row.jobOpeningName)) return null;
  const classification = classify(board, url);
  const company = text(board.company || row.company || row.companyName) || 'Unknown Company';
  const candidate = normalizeCandidate({
    url, id: row.id || row.jobId || row.requisitionId,
    company, title: row.title || row.name || row.jobTitle || row.jobOpeningName,
    location: board.provider === 'pinpoint' ? pinpointLocationText(row.location) : (row.location || row.city || row.office),
    description: row.description || row.jobDescription || row.content,
    postedAt: isoDate(row.postedAt || row.createdAt || row.publishedAt || row.created_at),
    discoveredAt: runAt, crawledAt: runAt,
    source: sourceUrl, provider: board.provider,
    sourceKind: classification === 'direct' ? 'ats-direct' : 'aggregator',
    liveness: { status: 'Active', checkedAt: runAt, evidence: 'public-ats-feed' },
    evidence: {
      classification, provider: board.provider, board: board.slug || board.company || null,
      endpoint: sourceUrl, fetchedAt: runAt, contract: `${board.provider}-public`,
    },
  }, { runAt, provider: board.provider, source: sourceUrl });
  candidate.classification = classification;
  candidate.provenance = { provider: board.provider, sourceUrl, endpoint: sourceUrl, classification, board: board.slug || null };
  return candidate;
}

function nextState(response, url, prior = {}) {
  const headers = response?.headers || {};
  const get = (name) => headers[name] ?? headers[name.toLowerCase()] ?? null;
  return { ...prior, url, etag: get('etag') || prior.etag || null, lastModified: get('last-modified') || prior.lastModified || null, fetchedAt: prior.fetchedAt || null };
}

async function request(url, transport, state, retry = {}) {
  const maxAttempts = Math.max(1, Number(retry.maxAttempts ?? 1));
  const headers = {};
  if (state?.etag) headers['if-none-match'] = state.etag;
  if (state?.lastModified) headers['if-modified-since'] = state.lastModified;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const response = await transport(url, { headers, attempt: attempts });
      const status = Number(response?.status ?? 200);
      if (status >= 200 && status < 300 || status === 304) return { response, attempts };
      if (!(RETRYABLE.has(status) || status >= 500) || attempts === maxAttempts) return { response, attempts, error: `http-${status}`, retryable: RETRYABLE.has(status) || status >= 500 };
    } catch (error) {
      if (!error?.retryable || attempts === maxAttempts) return { attempts, error: error?.message || 'transport-error', retryable: Boolean(error?.retryable) };
    }
  }
  return { attempts, error: 'retry-exhausted', retryable: true };
}

export async function fetchAtsBatch2({ board, transport, runAt = new Date().toISOString(), state = {}, maxPages = 2, maxItems = 100, pageSize = 25, retry = {} } = {}) {
  if (!board?.provider || !ATS_BATCH_2_PROVIDERS.includes(board.provider)) throw new TypeError(`unsupported ATS batch 2 provider: ${board?.provider}`);
  if (typeof transport !== 'function') throw new TypeError('fetchAtsBatch2 requires injected transport');
  const observations = [], errors = [], seen = new Set();
  const prior = state || {}; let cursor = { page: Number(prior.cursor?.page || 1) }; const startPage = cursor.page; let status = 'ok'; let fetchedPages = 0; let notModified = false; let lastResponse = null;
  for (let page = startPage; page < startPage + maxPages && observations.length < maxItems; page += 1) {
    const url = endpointFor(board, page); if (!url) { status = 'terminal'; errors.push('invalid board URL'); break; }
    const result = await request(url, transport, page === cursor.page ? prior : {}, retry); fetchedPages += 1;
    if (result.error) { status = result.retryable ? 'retryable' : 'terminal'; errors.push(result.error); break; }
    const response = result.response; lastResponse = response; if (response.status === 304) { notModified = true; status = 'not-modified'; break; }
    const rows = parseRows(board.provider, responseBody(response));
    if (!Array.isArray(rows)) { status = 'malformed'; errors.push('response did not contain a supported jobs array'); break; }
    for (const row of rows.slice(0, Math.max(0, maxItems - observations.length))) {
      const candidate = candidateFrom(board, row, runAt, url); if (!candidate || seen.has(candidate.canonicalUrl)) continue;
      seen.add(candidate.canonicalUrl); observations.push(candidate);
    }
    const hasMore = board.provider === 'bamboohr' && (responseBody(response)?.nextPage || responseBody(response)?.next_page || rows.length >= pageSize);
    if (!hasMore || rows.length < pageSize) { cursor = { page: page + 1 }; break; }
    cursor = { page: page + 1 };
  }
  const lastResponseState = state?.lastResponse || {};
  return {
    observations, cursor, conditionalState: { ...nextState(lastResponse || { headers: {} }, endpointFor(board, cursor.page), lastResponseState), cursor, fetchedAt: runAt },
    manifest: { schemaVersion: 'AtsBatch2ManifestV1', sourceId: `ats-batch-2:${board.provider}:${board.slug || board.company || 'board'}`, provider: board.provider, status, attempted: true, pages: fetchedPages, fetched: observations.length, direct: observations.filter((x) => x.classification === 'direct').length, leads: observations.filter((x) => x.classification === 'lead').length, notModified, errors, bounds: { maxPages, maxItems }, noAutoApply: true },
  };
}

export async function discoverAtsBatch2({ boards = [], transport, runAt, state = {}, maxBoards = 20, ...options } = {}) {
  if (typeof transport !== 'function') throw new TypeError('discoverAtsBatch2 requires injected transport');
  const results = [], observations = [], failures = [];
  for (const board of boards.slice(0, maxBoards)) {
    try { const result = await fetchAtsBatch2({ board, transport, runAt, state: state[board.slug || board.company] || {}, ...options }); results.push(result); observations.push(...result.observations); if (result.manifest.status !== 'ok' && result.manifest.status !== 'not-modified') failures.push(result.manifest); }
    catch (error) { failures.push({ sourceId: `ats-batch-2:${board.provider}:${board.slug || board.company || 'board'}`, status: 'terminal', errors: [error.message] }); }
  }
  return { observations, results, failures, manifest: { schemaVersion: 'AtsBatch2BatchManifestV1', sourceId: 'ats-batch-2', providers: [...new Set(boards.slice(0, maxBoards).map((board) => board.provider))], boardsAttempted: results.length + failures.length, fetched: observations.length, failed: failures.length, noAutoApply: true } };
}

export const discoverExpandedAtsBatch2 = discoverAtsBatch2;
export default discoverAtsBatch2;
