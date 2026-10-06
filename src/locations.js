import { BASE, LISTINGS, listingExists, withRotation } from './zomato.js';
import { HttpError } from './session.js';
import { clean, log } from './utils.js';

// Zomato's URL slug where it differs from the everyday city name.
const CITY_SLUGS = {
  bengaluru: 'bangalore',
  delhi: 'ncr',
  'new-delhi': 'ncr',
  gurugram: 'ncr',
  gurgaon: 'ncr',
  noida: 'ncr',
  'greater-noida': 'ncr',
  ghaziabad: 'ncr',
  faridabad: 'ncr',
  bombay: 'mumbai',
  calcutta: 'kolkata',
  madras: 'chennai',
};

export const slugify = (text) =>
  clean(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const citySlug = (city) => CITY_SLUGS[slugify(city)] ?? slugify(city);

/** "HSR Layout" -> ["hsr-layout", "hsr"]; "Koramangala 5th Block" -> ["koramangala-5th-block", "koramangala-5th", "koramangala"] */
export function localityCandidates(name) {
  const words = slugify(name).split('-').filter(Boolean);
  const out = [];
  for (let n = words.length; n >= 1; n--) out.push(words.slice(0, n).join('-'));
  return out;
}

async function lookupCity(pool, opts, place) {
  const json = await withRotation(pool, opts, 'location search', (session) =>
    session.requestJson(`${BASE}/webroutes/location/search?q=${encodeURIComponent(place)}`),
  );
  const top = json?.locationSuggestions?.[0];
  const city = clean((top?.display_subtitle ?? top?.entity_subtitle ?? '').split(',')[0]);
  if (!city) throw new Error(`Couldn't work out which city "${place}" is in. Pass it as "${place}, <city>" or use --city.`);
  log.info(`Zomato location search: "${place}" -> ${clean(top.display_title)}, ${city}`);
  return city;
}

/**
 * Turns free text like "HSR Layout, Bengaluru" into Zomato slugs ({ city: 'bangalore', locality: 'hsr' }).
 * The city comes from the input, `cityOverride`, or Zomato's location search; the locality slug is
 * found by trying progressively shorter slugs until a listing page exists.
 */
export async function resolvePlace(pool, opts, input, cityOverride) {
  const [placePart, ...rest] = input.split(',').map(clean).filter(Boolean);
  if (!placePart) throw new Error('Place is empty.');

  const cityName = cityOverride || rest[0] || (await lookupCity(pool, opts, placePart));
  const city = citySlug(cityName);

  for (const locality of localityCandidates(placePart)) {
    const url = BASE + LISTINGS.delivery.path(city, locality);
    try {
      await listingExists(pool, url, opts);
      log.info(`Resolved "${input}" -> ${url}`);
      return { place: placePart, city, locality };
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
      log.info(`  ${url} doesn't exist, trying a shorter name`);
    }
  }
  throw new Error(
    `Zomato has no listing for "${placePart}" in ${city}. Check the spelling, or copy the slug from a Zomato URL ` +
      `like zomato.com/${city}/<slug>-restaurants and pass that instead.`,
  );
}
