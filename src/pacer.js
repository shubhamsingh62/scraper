import { log, randomBetween, sleep } from './utils.js';

export async function pause(ms, reason) {
  if (ms <= 0) return;
  log.info(`Waiting ${Math.round(ms / 1000)}s (${reason}).`);
  await sleep(ms);
}

/**
 * Decides how long to wait before every outgoing request:
 *  - a random delay, so requests don't arrive at a fixed rhythm;
 *  - a minimum gap per proxy, so a single IP is never hit in quick succession
 *    (rotating proxies spreads load, but each IP still has to look human on its own);
 *  - a longer "coffee break" every N requests.
 */
export class Pacer {
  constructor({
    minDelayMs = 2500,
    maxDelayMs = 6000,
    perProxyGapMs = 8000,
    breakEvery = 25,
    breakMinMs = 30_000,
    breakMaxMs = 90_000,
  } = {}) {
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = Math.max(maxDelayMs, minDelayMs);
    this.perProxyGapMs = perProxyGapMs;
    this.breakEvery = breakEvery;
    this.breakMinMs = breakMinMs;
    this.breakMaxMs = Math.max(breakMaxMs, breakMinMs);
    this.requests = 0;
  }

  async beforeRequest(proxy) {
    if (this.breakEvery > 0 && this.requests > 0 && this.requests % this.breakEvery === 0) {
      await pause(randomBetween(this.breakMinMs, this.breakMaxMs), `break after ${this.requests} requests`);
    }

    const sinceLastOnProxy = Date.now() - (proxy.lastRequestAt ?? 0);
    const waitMs = Math.max(randomBetween(this.minDelayMs, this.maxDelayMs), this.perProxyGapMs - sinceLastOnProxy);
    await pause(waitMs, `before fetch via ${proxy.label}`);

    this.requests++;
    proxy.lastRequestAt = Date.now();
  }
}
