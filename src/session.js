import { fetch } from 'undici';
import { pick } from './utils.js';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
];

const BLOCK_STATUSES = new Set([403, 429, 503]);

export class BlockedError extends Error {
  kind = 'blocked';
}

export class NetworkError extends Error {
  kind = 'network';
}

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * One browser-like identity: a single proxy/IP, user agent and cookie jar.
 * Zomato's CSRF token and search pagination are tied to cookies, so every request
 * of a crawl must stay on the same session; rotation happens by starting a new one.
 */
export class Session {
  /** @param {import('./pacer.js').Pacer} [pacer] */
  constructor(proxy, pacer) {
    this.proxy = proxy;
    this.pacer = pacer;
    this.userAgent = pick(USER_AGENTS);
    this.cookies = new Map();
    this.csrf = null;
  }

  async request(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
    if (this.pacer) await this.pacer.beforeRequest(this.proxy);

    let res;
    try {
      res = await fetch(url, {
        method,
        body,
        dispatcher: this.proxy.dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': this.userAgent,
          'accept-language': 'en-IN,en;q=0.9',
          ...(this.cookies.size > 0 && { cookie: this.#cookieHeader() }),
          ...headers,
        },
      });
    } catch (err) {
      throw new NetworkError(`${method} ${url} via ${this.proxy.label}: ${err.cause?.message ?? err.message}`);
    }

    this.#storeCookies(res.headers.getSetCookie());
    const text = await res.text();

    if (BLOCK_STATUSES.has(res.status)) {
      throw new BlockedError(`HTTP ${res.status} for ${url} via ${this.proxy.label}`);
    }
    if (!res.ok) {
      throw new HttpError(`HTTP ${res.status} for ${url}`, res.status);
    }
    return text;
  }

  async requestJson(url, options) {
    const text = await this.request(url, { ...options, headers: { accept: 'application/json, */*', ...options?.headers } });
    try {
      return JSON.parse(text);
    } catch {
      // A 200 with HTML instead of JSON is how bot walls usually respond.
      throw new BlockedError(`Expected JSON from ${url} via ${this.proxy.label}, got: ${text.slice(0, 120)}`);
    }
  }

  #storeCookies(setCookies) {
    for (const header of setCookies) {
      const pair = header.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  #cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}
