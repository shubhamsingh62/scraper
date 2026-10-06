import { blockedOffer, emptyOffer, found, unknownOffer } from './offerRead.js';
import { BlockedError } from './session.js';
import { clean } from './utils.js';
import {
  BASE,
  GaveUpError,
  LISTINGS,
  parsePreloadedState,
  parseRestaurantPage,
  restaurantPageUrl,
  scrapeListing,
  withRotation,
} from './zomato.js';

const HTML_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'upgrade-insecure-requests': '1',
};

function formatGold(value) {
  const text = clean(value);
  if (!text) return null;
  return /dining|gold/i.test(text) ? text : `${text} on dining with Zomato Gold`;
}

/**
 * Reads a Zomato restaurant page. A missing offer block does not mean "no discount":
 * that page often omits Gold, so the caller keeps the stored offer.
 */
export function diningOfferFromState(state) {
  if (!state?.pages?.restaurant) return blockedOffer();

  const values = [];
  let sawOfferField = false;
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(node, 'offerValue') || node.promoOffer != null || node.gold) {
      sawOfferField = true;
    }
    if (typeof node.offerValue === 'string' && node.offerValue.trim()) values.push(node.offerValue);
    for (const value of Object.values(node)) walk(value);
  })(state.pages.restaurant);

  const text = formatGold(values[0]);
  if (text) return found(text);
  return sawOfferField ? emptyOffer() : unknownOffer();
}

/** One dine-out listing. gold.offerValue is the dining discount shown on the card. */
export async function fetchZomatoDiningListing(pool, opts, city, locality) {
  const url = BASE + LISTINGS.dineout.path(city, locality);
  const rows = await scrapeListing(pool, url, LISTINGS.dineout.context, opts);
  return rows.map((row) => ({
    name: row.restaurant_name,
    area: row.locality,
    cuisines: row.cuisines ?? [],
    cost_for_two: row.cost_for_two,
    image_urls: row.image_url ? [row.image_url] : [],
    rating: row.rating,
    review_count: row.review_count,
    zomato_url: restaurantPageUrl(row.zomato_url),
    offer: row.gold_offer ? found(formatGold(row.gold_offer)) : emptyOffer(),
  }));
}

/** Open a cached Zomato URL directly. No name search. */
export async function fetchZomatoDiningPage(pool, opts, url) {
  const pageUrl = restaurantPageUrl(url);
  try {
    return await withRotation(pool, opts, pageUrl, async (session) => {
      const html = await session.request(pageUrl, { headers: HTML_HEADERS });
      const state = parsePreloadedState(html);
      if (!state) throw new BlockedError(`No restaurant data on ${pageUrl} via ${session.proxy.label} (bot wall?)`);
      const details = parseRestaurantPage(state);
      return {
        offer: diningOfferFromState(state),
        cuisines: details?.cuisines ?? [],
        cost_for_two: details?.cost_for_two ?? null,
        open_until: details?.open_until ?? null,
        image_urls: details?.image_urls ?? [],
        rating: details?.rating ?? null,
        review_count: details?.review_count ?? null,
        must_try: details?.popular_dish ?? details?.known_for ?? null,
        bar_status: details?.bar_status ?? null,
        vibe_tags: details?.vibe_tags ?? [],
      };
    });
  } catch (err) {
    if (err instanceof GaveUpError || err instanceof BlockedError) return { offer: blockedOffer() };
    throw err;
  }
}
