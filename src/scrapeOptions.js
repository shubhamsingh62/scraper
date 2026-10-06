import { Pacer } from './pacer.js';
import { envInt } from './utils.js';

/** Crawl settings shared by every CLI, read from env (see .env.example). */
export function scrapeOptionsFromEnv(pool) {
  return {
    pacer: new Pacer({
      minDelayMs: envInt('MIN_DELAY_MS', 2500),
      maxDelayMs: envInt('MAX_DELAY_MS', 6000),
      perProxyGapMs: envInt('PROXY_MIN_GAP_MS', 8000),
      breakEvery: envInt('BREAK_EVERY', 25),
      breakMinMs: envInt('BREAK_MIN_MS', 30_000),
      breakMaxMs: envInt('BREAK_MAX_MS', 90_000),
    }),
    maxPages: envInt('MAX_PAGES', 5),
    maxAttempts: envInt('MAX_ATTEMPTS', Math.min(pool.size + 1, 6)),
    listingDelayMinMs: envInt('LISTING_DELAY_MIN_MS', 10_000),
    listingDelayMaxMs: envInt('LISTING_DELAY_MAX_MS', 25_000),
    blockPauseMs: envInt('BLOCK_PAUSE_MS', 20_000),
  };
}
