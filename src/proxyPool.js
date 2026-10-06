import { Agent, ProxyAgent } from 'undici';
import { log, sleep } from './utils.js';

const DIRECT = 'direct';
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Accepts the formats proxy providers usually hand out:
 *   http://user:pass@host:port   https://host:port   host:port   host:port:user:pass
 */
export function normalizeProxyUrl(raw) {
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) return value;
  const parts = value.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  return `http://${value}`;
}

export class PoolExhaustedError extends Error {}

function maskProxy(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '<invalid proxy url>';
  }
}

/**
 * Round-robin proxy pool with per-proxy health tracking.
 *
 * - A proxy that gets blocked (403/429/bot wall) goes into an exponential cooldown
 *   so the next request is routed through a different IP.
 * - After `maxStrikes` consecutive failures it is dropped for the rest of the run.
 * - Any success resets its strike counter.
 */
export class ProxyPool {
  constructor(
    proxyUrls,
    { allowDirect = false, baseCooldownMs = 60_000, maxCooldownMs = 30 * 60_000, maxStrikes = 4, maxWaitMs = 10 * 60_000 } = {},
  ) {
    const urls = [...new Set(proxyUrls.map(normalizeProxyUrl))];
    if (allowDirect || urls.length === 0) urls.push(DIRECT);

    this.proxies = urls.map((url) => ({
      label: url === DIRECT ? 'direct' : maskProxy(url),
      dispatcher:
        url === DIRECT
          ? new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } })
          : new ProxyAgent({ uri: url, connect: { timeout: CONNECT_TIMEOUT_MS } }),
      strikes: 0,
      cooldownUntil: 0,
      banned: false,
      ok: 0,
      failed: 0,
    }));
    this.cursor = 0;
    Object.assign(this, { baseCooldownMs, maxCooldownMs, maxStrikes, maxWaitMs });
  }

  static fromEnv(env = process.env) {
    const list = (env.PROXY_LIST ?? '').split(/[\s,;]+/).filter(Boolean);
    const pool = new ProxyPool(list, { allowDirect: /^(1|true|yes)$/i.test(env.ALLOW_DIRECT ?? '') });
    if (list.length === 0) {
      log.warn('PROXY_LIST is empty: requests go out directly from this machine, no IP rotation.');
    } else {
      log.info(`Loaded ${pool.size} proxy endpoint(s): ${pool.proxies.map((p) => p.label).join(', ')}`);
    }
    return pool;
  }

  get size() {
    return this.proxies.length;
  }

  async acquire() {
    for (;;) {
      const live = this.proxies.filter((p) => !p.banned);
      if (live.length === 0) throw new PoolExhaustedError('Every proxy in the pool has been banned for this run.');

      const now = Date.now();
      for (let i = 0; i < this.proxies.length; i++) {
        const idx = (this.cursor + i) % this.proxies.length;
        const proxy = this.proxies[idx];
        if (!proxy.banned && proxy.cooldownUntil <= now) {
          this.cursor = (idx + 1) % this.proxies.length;
          return proxy;
        }
      }

      const waitMs = Math.min(...live.map((p) => p.cooldownUntil)) - now;
      if (waitMs > this.maxWaitMs) {
        throw new PoolExhaustedError(`All proxies are cooling down for at least ${Math.round(waitMs / 1000)}s; giving up.`);
      }
      log.warn(`All proxies are cooling down, waiting ${Math.ceil(waitMs / 1000)}s for the next one.`);
      await sleep(Math.max(waitMs, 1000));
    }
  }

  reportSuccess(proxy) {
    proxy.ok++;
    proxy.strikes = 0;
  }

  /** @param {'blocked' | 'network'} kind */
  reportFailure(proxy, kind) {
    proxy.failed++;
    proxy.strikes++;
    if (proxy.strikes >= this.maxStrikes) {
      proxy.banned = true;
      log.warn(`Proxy ${proxy.label} failed ${proxy.strikes}x in a row, removing it for this run.`);
      return;
    }
    const base = kind === 'blocked' ? this.baseCooldownMs : this.baseCooldownMs / 4;
    const cooldown = Math.min(base * 2 ** (proxy.strikes - 1), this.maxCooldownMs);
    proxy.cooldownUntil = Date.now() + cooldown;
    log.warn(`Proxy ${proxy.label} ${kind}; cooling down for ${Math.round(cooldown / 1000)}s.`);
  }

  stats() {
    return this.proxies.map(({ label, ok, failed, banned }) => ({ proxy: label, ok, failed, banned }));
  }
}
