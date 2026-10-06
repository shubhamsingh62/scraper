import { blockedOffer, emptyOffer, found } from './offerRead.js';
import { BlockedError, HttpError } from './session.js';
import { clean } from './utils.js';
import { GaveUpError, withRotation } from './zomato.js';

const SWIGGY = 'https://www.swiggy.com';
const IMAGE_BASE = 'https://dineout-media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto/';

const HTML_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  referer: `${SWIGGY}/dineout`,
};

function looksLikeBotWall(html) {
  const head = html.slice(0, 6000);
  return /awsWafCookieDomainList|challenge-container|cf-challenge|g-recaptcha|not a robot/i.test(head);
}

function nextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function widgetCards(data) {
  const widget = data?.props?.pageProps?.widgetResponse;
  const cards = widget?.success?.cards ?? widget?.cards;
  return Array.isArray(cards) ? cards : [];
}

function uniqueParts(parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const text = clean(part);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** Bill discount first, then the Dineout pre-book deal. Bank coupons are left out. */
export function dineoutCardOffer(info) {
  const parts = [];
  const bill = info?.vendorOffer?.info;
  if (bill?.title) parts.push([bill.title, bill.subtitle].filter(Boolean).join(' '));
  const prebook = info?.offerInfoV3?.vendorOffer;
  if (prebook?.title) parts.push([prebook.title, prebook.subtitle].filter(Boolean).join(' '));
  const line = uniqueParts(parts).join(' | ');
  return line ? found(line) : emptyOffer();
}

function imageUrl(file) {
  const raw = file?.url;
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return IMAGE_BASE + raw.replace(/^\//, '');
}

function walkCards(data) {
  const foundCards = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.info?.name && node.cta?.link) {
      foundCards.push(node);
      return;
    }
    for (const value of Object.values(node)) walk(value);
  })(data);
  return foundCards;
}

/** @returns {{ blocked: boolean, restaurants: object[] }} */
export function parseDineoutListing(html) {
  if (looksLikeBotWall(html)) return { blocked: true, restaurants: [] };
  const data = nextData(html);
  if (!data) return { blocked: true, restaurants: [] };

  const restaurants = [];
  const seen = new Set();
  for (const card of walkCards(data)) {
    const info = card.info;
    if (seen.has(info.id)) continue;
    seen.add(info.id);
    const rating = Number.parseFloat(info.rating?.value);
    restaurants.push({
      id: String(info.id),
      name: clean(info.name),
      area: clean(info.locality || info.displayAreaName),
      cuisines: (info.cuisines ?? []).map(clean).filter(Boolean),
      cost_for_two: clean(info.costForTwo).replace(/\s*for (two|2).*$/i, '') || null,
      image_urls: (info.mediaFiles ?? []).map(imageUrl).filter(Boolean).slice(0, 5),
      rating: Number.isFinite(rating) ? rating : null,
      review_count: info.rating?.count != null ? String(info.rating.count) : null,
      swiggy_url: card.cta.link,
      offer: dineoutCardOffer(info),
    });
  }
  return { blocked: false, restaurants };
}

/** Pre-booking and total-bill deals on the restaurant Dineout page. */
export function parseDineoutRestaurant(html) {
  if (looksLikeBotWall(html)) return { offer: blockedOffer() };
  const data = nextData(html);
  if (!data) return { offer: blockedOffer() };

  const cards = widgetCards(data);
  const deal = cards.find((card) => card.card?.card?.['@type']?.includes('DealAndOfferInfo'));
  const masthead = cards.find((card) => card.card?.card?.['@type']?.includes('EntityInfoWithMasthead'));
  const identity = masthead?.card?.card ?? {};
  if (!deal) {
    return { offer: identity.name ? emptyOffer() : blockedOffer(), name: clean(identity.name) || null };
  }

  const titles = [];
  let sawDiningTab = false;
  for (const day of deal.card.card.dayWiseOfferInfo ?? []) {
    for (const tab of day.tabsOfferInfo?.offersTab ?? []) {
      const label = `${tab.tabInfo?.id ?? ''} ${tab.tabInfo?.title ?? ''}`;
      if (!/prebook|pre-book|bill|walk-in|dineout/i.test(label)) continue;
      sawDiningTab = true;
      for (const offer of tab.tabOffers?.offers ?? []) {
        if (offer?.title) titles.push(offer.title);
      }
    }
  }

  const line = uniqueParts(titles).join(' | ');
  return {
    offer: line ? found(line) : sawDiningTab ? emptyOffer() : emptyOffer(),
    name: clean(identity.name) || null,
  };
}

async function getHtml(session, url) {
  try {
    const html = await session.request(url, { headers: HTML_HEADERS });
    if (looksLikeBotWall(html)) throw new BlockedError(`Bot check for ${url} via ${session.proxy.label}`);
    return html;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 202 || err.status === 401)) {
      throw new BlockedError(`HTTP ${err.status} for ${url} via ${session.proxy.label}`);
    }
    throw err;
  }
}

export async function fetchDineoutListing(pool, opts, city, slug) {
  const url = `${SWIGGY}/dineout/${city}/${slug}`;
  try {
    const html = await withRotation(pool, opts, url, (session) => getHtml(session, url));
    return parseDineoutListing(html);
  } catch (err) {
    if (err instanceof GaveUpError || err instanceof BlockedError) return { blocked: true, restaurants: [] };
    throw err;
  }
}

export async function fetchDineoutRestaurant(pool, opts, url) {
  try {
    const html = await withRotation(pool, opts, url, (session) => getHtml(session, url));
    return parseDineoutRestaurant(html);
  } catch (err) {
    if (err instanceof GaveUpError || err instanceof BlockedError) return { offer: blockedOffer() };
    throw err;
  }
}
