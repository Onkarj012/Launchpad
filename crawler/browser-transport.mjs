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
} = {}) {
  let browserPromise = null;
  let contextPromise = null;
  let pagesUsed = 0;
  const failures = [];

  async function context() {
    browserPromise ??= import('playwright').then(({ chromium }) => chromium.launch(launchOptions));
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

  async function fetchRendered(url, { waitMs = defaultWaitMs, signal = null } = {}) {
    if (signal?.aborted) throw new Error('rendered fetch aborted before start');
    if (pagesUsed >= maxPages) throw new Error(`rendered page budget exhausted (${maxPages})`);
    pagesUsed += 1;
    const ctx = await context();
    const page = await ctx.newPage();
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      const status = response?.status() ?? 0;
      // A challenge or block page renders fine and parses to zero rows, which
      // would read as an empty result set. Fail instead so the lane reports it.
      if (status >= 400) throw new Error(`HTTP ${status}`);
      if (waitMs > 0) await page.waitForTimeout(waitMs);
      return await page.content();
    } catch (error) {
      failures.push({ url, error: error?.message || String(error) });
      throw error;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async function close() {
    try {
      if (contextPromise) await (await contextPromise).close().catch(() => {});
      if (browserPromise) await (await browserPromise).close().catch(() => {});
    } finally {
      browserPromise = null;
      contextPromise = null;
    }
  }

  return { fetchRendered, close, stats: () => ({ pagesUsed, maxPages, failures: [...failures] }) };
}

export default createRenderedFetcher;
