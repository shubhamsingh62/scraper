import { pause } from './pacer.js';
import { PoolExhaustedError } from './proxyPool.js';
import { BlockedError, NetworkError, Session } from './session.js';
import { clean, log, randomBetween } from './utils.js';

export const BASE = 'https://www.zomato.com';

export const LISTINGS = {
  delivery: { path: (city, locality) => `/${city}/delivery-in-${locality}`, context: 'delivery' },
  dineout: { path: (city, locality) => `/${city}/dine-out-in-${locality}`, context: 'dineout' },
};

const HTML_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'upgrade-insecure-requests': '1',
};

export class GaveUpError extends Error {}

export function parsePreloadedState(html) {
  const match = html.match(/window\.__PRELOADED_STATE__\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\)/);
  if (!match) return null;
  try {
    return JSON.parse(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

/**
 * Runs `fn(session)` on the next healthy proxy. When the proxy is blocked or drops, its
 * session is thrown away, the proxy is put on cooldown and `fn` is retried on another one.
 * Each proxy keeps one session (cookies + user agent) for as long as it stays healthy.
 */
export async function withRotation(pool, opts, what, fn) {
  let lastError;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const proxy = await pool.acquire();
    proxy.session ??= new Session(proxy, opts.pacer);
    try {
      const result = await fn(proxy.session);
      pool.reportSuccess(proxy);
      return result;
    } catch (err) {
      if (!(err instanceof BlockedError || err instanceof NetworkError)) throw err;
      lastError = err;
      proxy.session = null;
      pool.reportFailure(proxy, err.kind);
      log.warn(`  ${what}: attempt ${attempt}/${opts.maxAttempts} failed: ${err.message}`);
      if (err instanceof BlockedError) await pause(opts.blockPauseMs, 'backing off after a block');
    }
  }
  throw new GaveUpError(`${what}: gave up after ${opts.maxAttempts} attempts (${lastError?.message})`);
}

function toRawRestaurant(item) {
  const info = item.info;
  const deliveryOffers = (item.bulkOffers ?? [])
    .map((o) => clean([o.text, o.subtext].filter(Boolean).join(' ')))
    .filter(Boolean);
  return {
    res_id: info.resId,
    restaurant_name: clean(info.name),
    locality: clean(info.locality?.name),
    image_url: info.image?.url || info.o2FeaturedImage?.url || null,
    cuisines: (info.cuisine ?? []).map((c) => clean(c.name)).filter(Boolean),
    cost_for_two: clean(info.cft?.text).replace(/\s*for (two|2).*$/i, '') || null,
    delivery_offer: deliveryOffers.join(' | ') || null,
    gold_offer: clean(item.gold?.offerValue) || null,
    zomato_url: item.cardAction?.clickUrl ? new URL(item.cardAction.clickUrl, BASE).toString() : null,
  };
}

/** Listing cards link to `/order` or `/info`; the bare restaurant URL has the full details. */
export const restaurantPageUrl = (zomatoUrl) => zomatoUrl?.replace(/\/(order|info)\/?(\?.*)?$/, '');

/** Merges two partial records of the same restaurant, keeping the first non-empty value of each field. */
export function mergeRestaurant(prev = {}, next) {
  const out = { ...next };
  for (const [key, value] of Object.entries(prev)) {
    const empty = value == null || value === '' || (Array.isArray(value) && value.length === 0);
    if (!empty) out[key] = value;
  }
  return out;
}

function collect(results, into) {
  let added = 0;
  for (const item of results ?? []) {
    if (item?.type !== 'restaurant' || !item.info?.name) continue;
    const raw = toRawRestaurant(item);
    if (!into.has(raw.res_id)) added++;
    into.set(raw.res_id, mergeRestaurant(into.get(raw.res_id), raw));
  }
  return added;
}

async function fetchListingPage1(session, url) {
  const html = await session.request(url, { headers: HTML_HEADERS });
  const state = parsePreloadedState(html);
  if (!state) throw new BlockedError(`No __PRELOADED_STATE__ on ${url} via ${session.proxy.label} (bot wall?)`);
  const page = Object.values(state.pages?.search ?? {})[0];
  if (!page?.sections) throw new Error(`Unexpected page structure on ${url}; Zomato may have changed its markup.`);
  return { state, page };
}

/** Crawls one listing (page 1 is server-rendered HTML, the rest come from the infinite-scroll API). */
async function crawlListing(session, url, context, collected, opts) {
  const { state, page } = await fetchListingPage1(session, url);

  let added = collect(page.sections.SECTION_SEARCH_RESULT, collected);
  let meta = page.sections.SECTION_SEARCH_META_INFO?.searchMetaData;
  const appliedFilter = meta?.filterInfo?.railFilters?.filter((f) => f.isApplied) ?? [];
  const location = state.location?.currentLocation ?? {};
  log.info(`  page 1: +${added} (${meta?.totalResults ?? '?'} listed in total) via ${session.proxy.label}`);

  for (let pageNo = 2; pageNo <= opts.maxPages && meta?.hasMore && !opts.shouldStop?.(collected); pageNo++) {
    if (!session.csrf) {
      session.csrf = (await session.requestJson(`${BASE}/webroutes/auth/csrf`, { headers: { referer: url } })).csrf;
    }

    const filters = {
      searchMetadata: {
        previousSearchParams: meta.previousSearchParams,
        postbackParams: meta.postbackParams,
        totalResults: meta.totalResults,
        hasMore: meta.hasMore,
        getInactive: meta.getInactive,
      },
      dineoutAdsMetaData: {},
      appliedFilter,
      urlParamsForAds: {},
    };
    const json = await session.requestJson(`${BASE}/webroutes/search/home`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zomato-csrft': session.csrf,
        origin: BASE,
        referer: url,
      },
      body: JSON.stringify({ context, filters: JSON.stringify(filters), ...location }),
    });

    added = collect(json.sections?.SECTION_SEARCH_RESULT, collected);
    meta = json.sections?.SECTION_SEARCH_META_INFO?.searchMetaData;
    log.info(`  page ${pageNo}: +${added} (${collected.size} so far)`);
  }
}

/** Returns every restaurant on a listing. A crawl interrupted by blocks restarts on a new proxy; partial results are kept. */
export async function scrapeListing(pool, url, context, opts) {
  const collected = new Map();
  try {
    await withRotation(pool, opts, url, (session) => crawlListing(session, url, context, collected, opts));
  } catch (err) {
    if (!(err instanceof GaveUpError)) throw err;
    log.warn(`  ${err.message}; keeping ${collected.size} partial result(s).`);
  }
  return [...collected.values()];
}

/** Checks a listing URL exists (HTTP 200 with search data) without crawling it. */
export async function listingExists(pool, url, opts) {
  return withRotation(pool, opts, url, async (session) => {
    await fetchListingPage1(session, url);
    return true;
  });
}

function formatTime(raw) {
  const t = raw.toLowerCase().replace(/\s+/g, '');
  if (t.includes('midnight')) return '12:00 AM';
  if (t.includes('noon')) return '12:00 PM';
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  return m ? `${Number(m[1])}:${m[2] ?? '00'} ${m[3].toUpperCase()}` : null;
}

/** "11:30am – 3:45pm, 6:30pm – 10:45pm (Today)" -> "10:45 PM" */
export function closingTime(timingDesc) {
  const text = clean(timingDesc).replace(/\(.*?\)/g, '').trim();
  if (!text) return null;
  if (/24\s*hours/i.test(text)) return 'Open 24 hours';
  if (/closed/i.test(text)) return 'Closed today';
  const end = text.split(',').pop().split(/\s*[–—-]\s*/).pop();
  return formatTime(end) ?? clean(end);
}

export function parseRestaurantPage(state) {
  const sections = Object.values(state.pages?.restaurant ?? {})[0]?.sections;
  if (!sections) return null;
  const details = sections.SECTION_RES_DETAILS ?? {};
  const basic = sections.SECTION_BASIC_INFO ?? {};
  const images = state.entities?.IMAGES ?? {};
  const imageIds = sections.SECTION_IMAGE_CAROUSEL?.entities?.flatMap((e) => e.entity_ids ?? []) ?? [];
  const popularDishes = clean(details.TOP_DISHES?.description).split(',').map(clean).filter(Boolean);

  return {
    popular_dish: popularDishes[0] || null,
    known_for: clean(details.KNOWN_FOR?.knownFor) || null,
    open_until: closingTime(basic.timing?.timing_desc),
    cuisines: (details.CUISINES?.cuisines ?? []).map((c) => clean(c.name)).filter(Boolean),
    cost_for_two: clean(details.CFT_DETAILS?.cost_text_min_info).replace(/\s*for (two|2).*$/i, '') || null,
    image_urls: imageIds.map((id) => images[id]?.url).filter(Boolean),
    thumb_url: basic.res_thumb || null,
  };
}

const parseVotes = (text) => {
  const m = String(text ?? '').match(/([\d.,]+)\s*(k)?/i);
  return m ? Number.parseFloat(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1) : 0;
};

/** Most-voted dish rated 4+ on the delivery menu (`/order` page), preferring food over drinks. */
export function topMenuDish(state) {
  const menus = Object.values(state.pages?.restaurant ?? {})[0]?.order?.menuList?.menus ?? [];
  const items = menus
    .flatMap((m) => m.menu?.categories ?? [])
    .flatMap((c) => c.category?.items ?? [])
    .map((i) => i.item)
    .filter((i) => i?.name && (i.rating?.value ?? 0) >= 4 && parseVotes(i.rating?.total_rating_text) > 0);
  const food = items.filter((i) => !(i.tag_slugs ?? []).includes('dt-beverages'));
  const ranked = (food.length ? food : items).sort(
    (a, b) => parseVotes(b.rating.total_rating_text) - parseVotes(a.rating.total_rating_text) || b.rating.value - a.rating.value,
  );
  return ranked.length ? clean(ranked[0].name) : null;
}

async function fetchState(pool, url, opts) {
  return withRotation(pool, opts, url, async (session) => {
    const state = parsePreloadedState(await session.request(url, { headers: HTML_HEADERS }));
    if (!state) throw new BlockedError(`No __PRELOADED_STATE__ on ${url} via ${session.proxy.label} (bot wall?)`);
    return state;
  });
}

/**
 * Reads the restaurant page; when it lists no "Popular Dishes" (common for delivery-first places),
 * also reads the `/order` menu to pick a must-try dish from customer ratings.
 */
export async function fetchRestaurantDetails(pool, url, opts) {
  const details = parseRestaurantPage(await fetchState(pool, url, opts));
  if (!details) throw new Error(`Unexpected restaurant page structure on ${url}.`);

  let menuDish = null;
  if (!details.popular_dish) {
    try {
      menuDish = topMenuDish(await fetchState(pool, `${url}/order`, opts));
    } catch (err) {
      if (err instanceof PoolExhaustedError) throw err;
      log.warn(`  menu for ${url} unavailable: ${err.message}`);
    }
  }
  return { ...details, must_try: details.popular_dish ?? menuDish ?? details.known_for };
}

export function offerText(r) {
  if (r.delivery_offer) return r.delivery_offer;
  if (r.gold_offer) return `${r.gold_offer} on dining with Zomato Gold`;
  return null;
}

export const stripCity = (locality) => locality.replace(/,\s*[^,]+$/, '');

/** Pause between listings so consecutive crawls don't arrive back to back. */
export async function betweenListings(opts) {
  await pause(randomBetween(opts.listingDelayMinMs, opts.listingDelayMaxMs), 'between listings');
}

/**
 * @param {Array<{city: string, locality: string, area?: string, strictArea?: boolean, listings?: string[]}>} targets
 * @returns {Promise<Array<{restaurant_name: string, area: string, image_url: string|null, zomato_offer_text: string|null}>>}
 */
export async function scrapeTargets(targets, pool, opts) {
  const output = [];
  let listingsDone = 0;

  for (const target of targets) {
    const merged = new Map();
    for (const listing of target.listings ?? ['delivery']) {
      const def = LISTINGS[listing];
      if (!def) throw new Error(`Unknown listing "${listing}" (expected one of: ${Object.keys(LISTINGS).join(', ')})`);
      const url = BASE + def.path(target.city, target.locality);
      if (listingsDone++ > 0) await betweenListings(opts);
      log.info(`Scraping ${url}`);
      try {
        for (const r of await scrapeListing(pool, url, def.context, opts)) {
          merged.set(r.res_id, mergeRestaurant(merged.get(r.res_id), r));
        }
      } catch (err) {
        log.error(`  ${url} failed: ${err.message}`);
      }
    }

    const area = clean(target.area);
    const strict = area && target.strictArea !== false;
    let kept = 0;
    for (const r of merged.values()) {
      if (strict && !r.locality.toLowerCase().includes(area.toLowerCase())) continue;
      kept++;
      output.push({
        restaurant_name: r.restaurant_name,
        area: area || stripCity(r.locality),
        image_url: r.image_url,
        zomato_offer_text: offerText(r),
        locality: r.locality,
        res_id: r.res_id,
        zomato_url: r.zomato_url,
      });
    }
    log.info(`${target.city}/${target.locality}: ${merged.size} scraped, ${kept} kept for area "${area || '(from locality)'}"`);
  }

  return output;
}
