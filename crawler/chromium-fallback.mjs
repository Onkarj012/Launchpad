import { remainingDeadlineMs, requestWithDeadline, throwIfNetworkWorkDisallowed } from './deadline.mjs';

export function createChromiumFallbackTransport({
  baseTransport,
  enabled = false,
  renderHosts = [],
  timeoutMs = 30_000,
  launchOptions = { headless: true },
  launchBrowser = async (options) => { const { chromium } = await import('playwright'); return chromium.launch(options); },
} = {}) {
  if (typeof baseTransport !== 'function') throw new TypeError('baseTransport is required');
  const hosts = new Set(renderHosts.map((value) => String(value).toLowerCase()));
  let browserPromise;
  const transport = async (url, options = {}) => {
    throwIfNetworkWorkDisallowed(options.signal, options.deadline);
    const host = new URL(url).hostname.toLowerCase();
    if (!enabled || !hosts.has(host) || /robots\.txt$|\.xml(?:$|\?)/i.test(new URL(url).pathname)) {
      return baseTransport(url, options);
    }
    const endAt = Date.now() + Math.min(timeoutMs, Number(options.timeoutMs) || timeoutMs, remainingDeadlineMs(options.deadline));
    const deadline = { remainingMs: () => Math.min(endAt - Date.now(), remainingDeadlineMs(options.deadline)) };
    try {
      return await requestWithDeadline(async (_url, { signal }) => {
        browserPromise ??= launchBrowser(launchOptions);
        const browser = await browserPromise;
        throwIfNetworkWorkDisallowed(signal, deadline);
        const page = await browser.newPage();
        // Closing a page stops pending navigation and body work on cancellation.
        const onAbort = () => { void page.close().catch(() => {}); };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          throwIfNetworkWorkDisallowed(signal, deadline);
          const response = await page.goto(url, { waitUntil: 'networkidle', timeout: Math.max(1, remainingDeadlineMs(deadline)) });
          throwIfNetworkWorkDisallowed(signal, deadline);
          const body = await page.content();
          throwIfNetworkWorkDisallowed(signal, deadline);
          return { status: response?.status() ?? 200, headers: response?.headers() ?? {}, body, rendered: true };
        } finally {
          signal.removeEventListener('abort', onAbort);
          await page.close().catch(() => {});
        }
      }, url, {}, { signal: options.signal, deadline, abortOnDeadline: true });
    } catch (error) {
      throwIfNetworkWorkDisallowed(options.signal, options.deadline);
      const result = await baseTransport(url, options);
      return { ...result, renderFailure: error?.message || 'Chromium rendering failed' };
    }
  };
  // Release the browser launched by this fallback transport.
  transport.close = async () => {
    const pendingBrowser = browserPromise;
    browserPromise = null;
    await requestWithDeadline(() => pendingBrowser?.then((browser) => browser.close()), 'browser-close', {},
      { deadline: { deadlineMs: Date.now() + 1_000 } }).catch(() => {});
  };
  return transport;
}

export default createChromiumFallbackTransport;
