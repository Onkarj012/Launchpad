// HTTP transport helpers shared across providers.
// Files prefixed with _ are never loaded as providers by scan.mjs.

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; career-ops/1.3)';

// Read the caller's absolute deadline or remaining budget.
function remainingDeadlineMs(deadline) {
  if (deadline == null) return Infinity;
  if (typeof deadline === 'number') return Math.max(0, deadline - Date.now());
  if (Number.isFinite(Number(deadline.deadlineMs))) return Math.max(0, Number(deadline.deadlineMs) - Date.now());
  const remaining = typeof deadline.remainingMs === 'function' ? deadline.remainingMs() : deadline.remainingMs;
  return Number.isFinite(Number(remaining)) ? Math.max(0, Number(remaining)) : Infinity;
}

// Bound headers and body reads even when a transport ignores abort.
async function fetchWithTimeout(url, readBody, { timeoutMs = DEFAULT_TIMEOUT_MS, signal = null, deadline = null, headers = {}, method = 'GET', body = null, redirect = 'follow' } = {}) {
  if (signal?.aborted) throw signal.reason;
  const remainingMs = remainingDeadlineMs(deadline);
  const configuredMs = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : DEFAULT_TIMEOUT_MS;
  const waitMs = Math.min(configuredMs, remainingMs, 2_147_483_647);
  const timeoutError = Object.assign(new Error(remainingMs <= configuredMs ? 'HTTP request deadline exceeded' : 'HTTP request timed out'), {
    code: remainingMs <= configuredMs ? 'DAILY_DEADLINE_EXCEEDED' : 'ETIMEDOUT',
  });
  if (waitMs <= 0) throw timeoutError;
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal.reason);
  let onAbort;
  const cancellation = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  signal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError), waitMs);
  try {
    const request = (async () => {
      const res = await fetch(url, {
        method,
        headers: { 'user-agent': DEFAULT_USER_AGENT, ...headers },
        body,
        redirect,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (!res.ok) {
        const responseText = await res.text().catch(() => '');
        controller.signal.throwIfAborted();
        // Keep WAF challenge markup in err.body rather than the log message.
        const err = new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
        err.status = res.status;
        err.body = responseText;
        err.retryAfter = res.headers.get('retry-after');
        throw err;
      }
      return await readBody(res);
    })();
    return await Promise.race([request, cancellation]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromParent);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

// Fetch and parse JSON within the request budget.
export async function fetchJson(url, opts = {}) {
  return await fetchWithTimeout(url, (res) => res.json(), opts);
}

// Fetch text within the request budget.
export async function fetchText(url, opts = {}) {
  return await fetchWithTimeout(url, (res) => res.text(), opts);
}

// Expose the shared provider HTTP transport.
export function makeHttpCtx() {
  return {
    transport: 'http',
    fetchJson,
    fetchText,
  };
}
