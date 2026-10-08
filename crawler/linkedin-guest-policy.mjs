const PAUSE_KEY = 'linkedin-guest-paused-until';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Share the IST-day LinkedIn pause across discovery, detail requests and restarts.
export function createLinkedInGuestPolicy({ transport, store = null, runAt = new Date().toISOString(), clock = {} }) {
  let pausedUntil = store?.prepare('SELECT value FROM crawler_meta WHERE key = ?').get(PAUSE_KEY)?.value ?? null;
  // Use the injected clock to make the IST day boundary reproducible.
  const now = () => Date.parse(typeof clock.now === 'function' ? clock.now() : runAt);
  // Block later LinkedIn requests while leaving other hosts available.
  const guardedTransport = async (url, options) => {
    if (!/(?:^|\.)linkedin\.com$/i.test(new URL(url).hostname)) return transport(url, options);
    pausedUntil = store?.prepare('SELECT value FROM crawler_meta WHERE key = ?').get(PAUSE_KEY)?.value ?? pausedUntil;
    if (pausedUntil && now() < Date.parse(pausedUntil)) {
      const error = new Error(`linkedin-rate-limited-until-${pausedUntil}`);
      error.code = 'LINKEDIN_PAUSED';
      error.statusCode = 429;
      throw error;
    }
    const response = await transport(url, options);
    if (Number(response.status) === 429) {
      pausedUntil = new Date((Math.floor((now() + IST_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - IST_OFFSET_MS).toISOString();
      store?.prepare('INSERT INTO crawler_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(PAUSE_KEY, pausedUntil);
    }
    return response;
  };
  return { transport: guardedTransport };
}
