import { keepsExistingOffer } from './offerRead.js';
import { createSupabase } from './supabaseSync.js';
import { clean, log } from './utils.js';

/**
 * Writable columns on public.restaurants.
 * id and created_at are left to the database.
 */
const COLUMNS = [
  'name',
  'area',
  'city',
  'rating',
  'review_count',
  'cuisines',
  'cost_for_two',
  'bar_status',
  'vibe_tags',
  'must_try',
  'image_urls',
  'open_until',
  'swiggy_url',
  'zomato_url',
  'current_offer',
  'swiggy_offer',
  'offers_last_checked_at',
];

const TABLE = process.env.SUPABASE_TABLE || 'restaurants';

export function openSupabase() {
  return createSupabase();
}

export async function loadExistingRestaurants(supabase) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('name, area, city, current_offer, swiggy_offer, zomato_url, swiggy_url');
  if (error) throw new Error(`Could not read ${TABLE}: ${error.message}`);
  return data ?? [];
}

function textList(values, limit) {
  const unique = [...new Set((values ?? []).map(clean).filter(Boolean))];
  return limit ? unique.slice(0, limit) : unique;
}

function ratingNumber(value) {
  const rating = Number(value);
  return Number.isFinite(rating) ? rating : null;
}

/**
 * Builds the upsert body for `restaurants`. A blocked or unknown offer is omitted
 * so PostgREST leaves the stored string in place. `null` is sent only for a page
 * that loaded and showed no dining discount. Empty detail fields are omitted too,
 * so a partial scrape does not wipe rating, must_try, bar_status, or vibe_tags.
 */
export function buildPayload({
  name,
  area,
  city,
  rating,
  reviewCount,
  cuisines,
  costForTwo,
  barStatus,
  vibeTags,
  mustTry,
  openUntil,
  imageUrls,
  zomatoOffer,
  swiggyOffer,
  zomatoUrl,
  swiggyUrl,
  checkedAt,
}) {
  const row = {
    name: clean(name),
    area: clean(area),
    city: clean(city) || 'Hyderabad',
    offers_last_checked_at: checkedAt,
  };

  const ratingValue = ratingNumber(rating);
  if (ratingValue != null) row.rating = ratingValue;
  if (clean(reviewCount)) row.review_count = clean(reviewCount);
  const cuisineList = textList(cuisines);
  if (cuisineList.length) row.cuisines = cuisineList;
  if (clean(costForTwo)) row.cost_for_two = clean(costForTwo);
  if (clean(barStatus)) row.bar_status = clean(barStatus);
  const vibes = textList(vibeTags);
  if (vibes.length) row.vibe_tags = vibes;
  if (clean(mustTry)) row.must_try = clean(mustTry);
  if (clean(openUntil)) row.open_until = clean(openUntil);
  const images = textList(imageUrls, 8);
  if (images.length) row.image_urls = images;
  if (zomatoUrl) row.zomato_url = zomatoUrl;
  if (swiggyUrl) row.swiggy_url = swiggyUrl;

  if (zomatoOffer && !keepsExistingOffer(zomatoOffer)) row.current_offer = zomatoOffer.value;
  if (swiggyOffer && !keepsExistingOffer(swiggyOffer)) row.swiggy_offer = swiggyOffer.value;

  for (const key of Object.keys(row)) {
    if (!COLUMNS.includes(key)) delete row[key];
  }
  return row;
}

export async function upsertRestaurant(supabase, payload) {
  const { error } = await supabase.from(TABLE).upsert(payload, {
    onConflict: 'name,area,city',
    ignoreDuplicates: false,
  });
  if (error) {
    throw new Error(
      `Upsert failed for "${payload.name}" / "${payload.area}": ${error.message}${error.hint ? ` (${error.hint})` : ''}`,
    );
  }
  log.info(`Upserted "${payload.name}" (${payload.area}, ${payload.city}) into ${TABLE}.`);
}
