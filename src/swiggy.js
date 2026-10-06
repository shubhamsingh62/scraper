import { bestMatch } from './match.js';
import { Session, BlockedError, HttpError } from './session.js';
import { withRotation } from './zomato.js';
import { clean, log } from './utils.js';

const SWIGGY = 'https://www.swiggy.com';

const HEADERS = {
  accept: '*/*',
  referer: `${SWIGGY}/`,
  origin: SWIGGY,
};

function collectRestaurants(json) {
  const found = [];
  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.name && node.id && (node.areaName || node.locality)) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        found.push(node);
      }
      return;
    }
    for (const value of Object.values(node)) walk(value);
  })(json);
  return found;
}

/** Turns Swiggy's discount object into one line. Percentage deals use header + subHeader when Swiggy sends them. */
export function swiggyOfferText(info) {
  if (!info) return null;
  const v3 = info.aggregatedDiscountInfoV3;
  const headline = clean([v3?.header, v3?.subHeader].filter(Boolean).join(' '));
  if (headline) return headline;

  const v2 = info.aggregatedDiscountInfoV2 ?? info.aggregatedDiscountInfo ?? {};
  const legacy = clean([v2.header, v2.subHeader].filter(Boolean).join(' '));
  const parts = [];
  if (legacy) parts.push(legacy);
  for (const item of v2.descriptionList ?? v2.shortDescriptionList ?? []) {
    const meta = clean(item.meta);
    if (item.discountType === 'FREE_DELIVERY' || meta.toLowerCase() === 'freedel') parts.push('Free delivery');
    else if (meta) parts.push(meta);
  }
  const unique = [...new Set(parts)];
  return unique.length ? unique.join(' | ') : null;
}

async function swiggyJson(session, url) {
  try {
    return await session.requestJson(url, { headers: HEADERS });
  } catch (err) {
    if (err instanceof HttpError && err.status === 202) {
      throw new BlockedError(`Swiggy bot check for ${url} via ${session.proxy.label}`);
    }
    throw err;
  }
}

async function searchRestaurants(session, lat, lng, name) {
  const url =
    `${SWIGGY}/dapi/restaurants/search/v3?lat=${lat}&lng=${lng}` +
    `&str=${encodeURIComponent(name)}&submitAction=ENTER`;
  return collectRestaurants(await swiggyJson(session, url));
}

async function menuInfo(session, lat, lng, id) {
  const url =
    `${SWIGGY}/dapi/menu/pl?page-type=REGULAR_MENU&complete-menu=true` +
    `&lat=${lat}&lng=${lng}&restaurantId=${id}&submitAction=ENTER`;
  const matches = collectRestaurants(await swiggyJson(session, url)).filter((r) => r.id === String(id));
  return matches[0] ?? null;
}

/**
 * One menu read, without punishing the proxy. Swiggy's menu endpoint is behind a bot check
 * that the listing and search endpoints are not, so a block here must not burn the IP the
 * rest of the crawl still needs.
 */
async function readMenuOffer(pool, opts, lat, lng, id) {
  const proxy = await pool.acquire();
  proxy.session ??= new Session(proxy, opts.pacer);
  try {
    const info = await menuInfo(proxy.session, lat, lng, id);
    pool.reportSuccess(proxy);
    return swiggyOfferText(info);
  } catch (err) {
    if (err instanceof BlockedError) {
      proxy.session = null;
      return { blocked: true };
    }
    throw err;
  }
}

/**
 * Finds the Swiggy outlet for each Zomato restaurant and sets `swiggy_offer` on it.
 * Match rule: same name (or one name contains the other) AND the areas overlap.
 * A chain in another neighbourhood is left unmatched.
 */
export async function attachSwiggyOffers(restaurants, pool, opts, { lat, lng }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    log.warn('No coordinates for this place, so Swiggy offers were skipped.');
    return;
  }
  log.info(`Matching ${restaurants.length} restaurant(s) on Swiggy at ${lat}, ${lng}.`);

  let menuBlocked = false;
  let matched = 0;
  let withOffer = 0;

  for (const restaurant of restaurants) {
    const area = restaurant.locality?.replace(/,\s*[^,]+$/, '') || restaurant.area;
    let candidates = [];
    try {
      candidates = await withRotation(pool, opts, `swiggy search "${restaurant.restaurant_name}"`, (session) =>
        searchRestaurants(session, lat, lng, restaurant.restaurant_name),
      );
    } catch (err) {
      log.warn(`  Swiggy search failed for "${restaurant.restaurant_name}": ${err.message}`);
      restaurant.swiggy_offer = null;
      continue;
    }

    const hit = bestMatch({ name: restaurant.restaurant_name, area }, candidates);
    if (!hit) {
      restaurant.swiggy_offer = null;
      log.info(`  no Swiggy match for "${restaurant.restaurant_name}" in ${area}`);
      continue;
    }
    matched++;

    let offer = swiggyOfferText(hit);
    if (!offer && !menuBlocked) {
      const menu = await readMenuOffer(pool, opts, lat, lng, hit.id);
      if (menu && typeof menu === 'object' && menu.blocked) {
        menuBlocked = true;
        log.warn(
          'Swiggy is serving a bot check on its menu endpoint from this IP. ' +
            'That is where the offer text is. Search still matches restaurants; swiggy_offer stays empty until a proxy gets past the check.',
        );
      } else if (typeof menu === 'string') {
        offer = menu;
      }
    }

    restaurant.swiggy_offer = offer;
    if (offer) withOffer++;
    log.info(
      `  matched "${restaurant.restaurant_name}" -> "${hit.name}" (${hit.areaName || hit.locality})` +
        `${offer ? `: ${offer}` : ''}`,
    );
  }

  log.info(`Swiggy: ${matched}/${restaurants.length} matched, ${withOffer} with an offer.`);
}
