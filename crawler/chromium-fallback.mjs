export function createChromiumFallbackTransport({
  baseTransport,
  enabled = false,
  renderHosts = [],
  timeoutMs = 30_000,
  launchOptions = { headless: true },
} = {}) {
  if (typeof baseTransport !== 'function') throw new TypeError('baseTransport is required');
  const hosts = new Set(renderHosts.map((value) => String(value).toLowerCase()));
  let browserPromise;
  return async (url, options = {}) => {
    const host = new URL(url).hostname.toLowerCase();
    if (!enabled || !hosts.has(host) || /robots\.txt$|\.xml(?:$|\?)/i.test(new URL(url).pathname)) {
      return baseTransport(url, options);
    }
    try {
      browserPromise ??= import('playwright').then(({ chromium }) => chromium.launch(launchOptions));
      const browser = await browserPromise;
      const page = await browser.newPage();
      try {
        const response = await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
        return { status: response?.status() ?? 200, headers: response?.headers() ?? {}, body: await page.content(), rendered: true };
      } finally {
        await page.close();
      }
    } catch (error) {
      const result = await baseTransport(url, options);
      return { ...result, renderFailure: error?.message || 'Chromium rendering failed' };
    }
  };
}

export default createChromiumFallbackTransport;
