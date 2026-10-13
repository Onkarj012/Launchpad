import { remainingDeadlineMs, requestWithDeadline, throwIfNetworkWorkDisallowed } from './deadline.mjs';

// Rendered-page transport for portal lanes.
//
// Separate from crawler/chromium-fallback.mjs on purpose. That one wraps a base
// HTTP transport, renders only allowlisted hosts, and falls back to plain fetch
// on error — correct for its callers, wrong here. A portal lane wants an
// explicit browser, a real browsing context, and a loud failure when rendering
// does not work, because a silent fallback returns a JS shell that parses to
// zero jobs and looks identical to "no jobs today".
//
// The context options below are the ones measured to work on 2026-08-22:
// without a real UA, an India locale/timezone, and navigator.webdriver masked,
// Glassdoor served a challenge page instead of listings.
//
// One browser is launched lazily and shared across every URL in a run. Callers
// must call close() when the run ends or the process will not exit.

export const DEFAULT_BROWSER_CONTEXT = Object.freeze({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
  locale: 'en-IN',
  timezoneId: 'Asia/Kolkata',
});

/**
 * @returns {{ fetchRendered: (url: string, opts?: object) => Promise<string>, close: () => Promise<void>, stats: () => object }}
 */
export function createRenderedFetcher({
  launchOptions = { headless: true },
  contextOptions = DEFAULT_BROWSER_CONTEXT,
  timeoutMs = 45_000,
  defaultWaitMs = 6_000,
  maxPages = 40,
  launchBrowser = async (options) => { const { chromium } = await import('playwright'); return chromium.launch(options); },
} = {}) {
  let browserPromise = null;
  let contextPromise = null;
  let pagesUsed = 0;
  const failures = [];

  async function context() {
    browserPromise ??= launchBrowser(launchOptions);
    const browser = await browserPromise;
    contextPromise ??= (async () => {
      const ctx = await browser.newContext(contextOptions);
      // Playwright sets navigator.webdriver; portals check it.
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      return ctx;
    })();
    return contextPromise;
  }

  // Bound setup, navigation, waits and body reads by the same request budget.
  async function fetchRendered(url, { waitMs = defaultWaitMs, signal = null, deadline = null, timeoutMs: requestTimeoutMs = timeoutMs } = {}) {
    throwIfNetworkWorkDisallowed(signal, deadline);
    if (pagesUsed >= maxPages) throw new Error(`rendered page budget exhausted (${maxPages})`);
    pagesUsed += 1;
    const duration = Math.min(Math.max(1, Number(requestTimeoutMs) || timeoutMs), remainingDeadlineMs(deadline));
    const requestDeadline = { remainingMs: () => Math.min(endAt - Date.now(), remainingDeadlineMs(deadline)) };
    const endAt = Date.now() + duration;
    try {
      return await requestWithDeadline(async (_url, { signal: requestSignal }) => {
        let page;
        // Closing the page interrupts Playwright operations when the parent aborts.
        const onAbort = () => { if (page) void page.close().catch(() => {}); };
        requestSignal.addEventListener('abort', onAbort, { once: true });
        try {
          const ctx = await context();
          throwIfNetworkWorkDisallowed(requestSignal, requestDeadline);
          page = await ctx.newPage();
          throwIfNetworkWorkDisallowed(requestSignal, requestDeadline);
          const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1, remainingDeadlineMs(requestDeadline)) });
          throwIfNetworkWorkDisallowed(requestSignal, requestDeadline);
          const status = response?.status() ?? 0;
          if (status >= 400) throw new Error(`HTTP ${status}`);
          if (waitMs > 0) await page.waitForTimeout(Math.min(waitMs, remainingDeadlineMs(requestDeadline)));
          throwIfNetworkWorkDisallowed(requestSignal, requestDeadline);
          const body = await page.content();
          throwIfNetworkWorkDisallowed(requestSignal, requestDeadline);
          return body;
        } finally {
          requestSignal.removeEventListener('abort', onAbort);
          if (page) await page.close().catch(() => {});
        }
      }, url, {}, { signal, deadline: requestDeadline, abortOnDeadline: true });
    } catch (error) {
      failures.push({ url, error: error?.message || String(error) });
      throw error;
    }
  }

  // Bound shutdown while still closing a browser that finishes launching late.
  async function close() {
    const pendingBrowser = browserPromise;
    const pendingContext = contextPromise;
    browserPromise = null;
    contextPromise = null;
    const endAt = Date.now() + 1_000;
    await requestWithDeadline(async () => {
      await Promise.all([
        pendingContext?.then((ctx) => ctx.close()).catch(() => {}),
        pendingBrowser?.then((browser) => browser.close()).catch(() => {}),
      ]);
    }, 'browser-close', {}, { deadline: { deadlineMs: endAt } }).catch(() => {});
  }

  return { fetchRendered, close, stats: () => ({ pagesUsed, maxPages, failures: [...failures] }) };
}

export default createRenderedFetcher;
