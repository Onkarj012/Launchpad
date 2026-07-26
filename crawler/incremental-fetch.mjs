import { createHash } from 'node:crypto';
import { classifyRetry, createHostLimiter, decideRobots, getHeader, retryDelay, validateResponse } from './http-policy.mjs';

export function canonicalUrl(value) {
  const url = new URL(value);
  url.protocol = url.protocol.toLowerCase(); url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  url.hash = '';
  return url.toString();
}

export function contentFingerprint(content) {
  return createHash('sha256').update(String(content ?? '')).digest('hex');
}

export function conditionalHeaders(state = {}) {
  return Object.fromEntries([
    state.etag && ['if-none-match', String(state.etag)],
    state.lastModified && ['if-modified-since', String(state.lastModified)],
    state.sitemapLastmod && ['x-sitemap-lastmod', String(state.sitemapLastmod)],
  ].filter(Boolean));
}

export async function evaluateIncrementalResponse(response, prior = {}, { maxBytes = Infinity } = {}) {
  if (response.status === 304) return { classification: 'not-modified', canonicalUrl: prior.canonicalUrl ?? null, state: { ...prior } };
  const checked = validateResponse(response, { maxBytes });
  if (!checked.ok) return { classification: checked.kind, reason: checked.reason };
  const body = typeof response.body === 'string' ? response.body : typeof response.text === 'function' ? await response.text() : '';
  if (Buffer.byteLength(body) > maxBytes) return { classification: 'terminal', reason: 'response-too-large' };
  const fingerprint = contentFingerprint(body);
  const state = {
    ...prior,
    etag: getHeader(response.headers, 'etag') ?? prior.etag ?? null,
    lastModified: getHeader(response.headers, 'last-modified') ?? prior.lastModified ?? null,
    fingerprint,
  };
  return { classification: prior.fingerprint === fingerprint ? 'unchanged' : 'changed', body, fingerprint, state };
}

export async function fetchIncrementally({ url, transport, state = {}, robots, userAgent = '*', limiter, hostLimiterOptions, retry = {}, maxBytes = 2_000_000, timeoutMs = 30_000, maxRedirects = 0, maxHosts = 1, maxRequests = maxRedirects + 1, signal, clock = {} } = {}) {
  const canonical = canonicalUrl(url);
  if (robots != null) {
    const decision = decideRobots(canonical, robots, userAgent);
    if (!decision.allowed) return { classification: 'disallowed', canonicalUrl: canonical, reason: decision.reason };
  }
  if (typeof transport !== 'function') throw new TypeError('transport must be a function');
  const hostLimiter = limiter ?? createHostLimiter({ ...hostLimiterOptions, clock });
  const host = new URL(canonical).host;
  const maxAttempts = Math.max(1, retry.maxAttempts ?? 3);
  const sleep = (ms) => typeof clock.sleep === 'function' ? clock.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await hostLimiter.run(host, async () => {
        const controller = new AbortController();
        const abortFromCaller = () => controller.abort(signal.reason);
        if (signal?.aborted) abortFromCaller();
        else signal?.addEventListener?.('abort', abortFromCaller, { once: true });
        const request = transport(canonical, {
          headers: conditionalHeaders(state),
          signal: controller.signal,
          timeoutMs,
          maxBytes,
          maxRedirects,
          maxHosts,
          maxRequests,
        });
        if (!timeoutMs) {
          try { return await request; }
          finally { signal?.removeEventListener?.('abort', abortFromCaller); }
        }
        let timerId;
        const schedule = typeof clock.setTimeout === 'function' ? clock.setTimeout.bind(clock) : setTimeout;
        const cancel = typeof clock.clearTimeout === 'function' ? clock.clearTimeout.bind(clock) : clearTimeout;
        const timer = new Promise((_, reject) => {
          timerId = schedule(() => {
            const error = new Error('request timed out');
            error.code = 'ETIMEDOUT';
            controller.abort(error);
            reject(error);
          }, timeoutMs);
        });
        try { return await Promise.race([request, timer]); }
        finally {
          cancel(timerId);
          signal?.removeEventListener?.('abort', abortFromCaller);
        }
      });
    } catch (error) {
      if (classifyRetry({ error }).kind !== 'retryable' || attempt === maxAttempts) return { classification: 'terminal', reason: error.message };
      await sleep(retryDelay(attempt, retry)); continue;
    }
    const classification = validateResponse(response, { maxBytes });
    if (!classification.ok) {
      if (classification.kind === 'retryable' && attempt < maxAttempts) { await sleep(retryDelay(attempt, retry)); continue; }
      return { classification: classification.kind, reason: classification.reason, status: response.status };
    }
    return { ...(await evaluateIncrementalResponse(response, { ...state, canonicalUrl: canonical }, { maxBytes })), status: response.status };
  }
  return { classification: 'terminal', reason: 'attempts-exhausted' };
}
