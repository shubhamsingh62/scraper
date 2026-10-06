import { Pacer } from './pacer.js';
import { envInt } from './utils.js';

/** Raises the wait before every fetch to at least `seconds`, with a few seconds of jitter on top. */
export function applyFetchDelay(pacer, seconds) {
  const ms = seconds * 1000;
  pacer.minDelayMs = Math.max(pacer.minDelayMs, ms);
  pacer.maxDelayMs = Math.max(pacer.maxDelayMs, ms + 3000);
  pacer.perProxyGapMs = Math.max(pacer.perProxyGapMs, ms);
}

/** Crawl settings shared by every CLI, read from env (see .env.example). */
export function scrapeOptionsFromEnv(pool) {
  const pacer = new Pacer({
    minDelayMs: envInt('MIN_DELAY_MS', 2500),
    maxDelayMs: envInt('MAX_DELAY_MS', 6000),
    perProxyGapMs: envInt('PROXY_MIN_GAP_MS', 8000),
    breakEvery: envInt('BREAK_EVERY', 25),
    breakMinMs: envInt('BREAK_MIN_MS', 30_000),
    breakMaxMs: envInt('BREAK_MAX_MS', 90_000),
  });
  const fetchDelaySec = envInt('FETCH_DELAY_SEC', 0);
  if (fetchDelaySec > 0) applyFetchDelay(pacer, fetchDelaySec);

  return {
    pacer,
    maxPages: envInt('MAX_PAGES', 5),
    maxAttempts: envInt('MAX_ATTEMPTS', Math.min(pool.size + 1, 6)),
    listingDelayMinMs: envInt('LISTING_DELAY_MIN_MS', 10_000),
    listingDelayMaxMs: envInt('LISTING_DELAY_MAX_MS', 25_000),
    blockPauseMs: envInt('BLOCK_PAUSE_MS', 20_000),
  };
}
