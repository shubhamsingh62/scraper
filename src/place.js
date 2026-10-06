import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { resolvePlace, slugify } from './locations.js';
import { PoolExhaustedError, ProxyPool } from './proxyPool.js';
import { scrapeOptionsFromEnv } from './scrapeOptions.js';
import { log } from './utils.js';
import {
  BASE,
  LISTINGS,
  betweenListings,
  fetchRestaurantDetails,
  mergeRestaurant,
  offerText,
  restaurantPageUrl,
  scrapeListing,
  stripCity,
} from './zomato.js';

const USAGE = `Fetch every restaurant in a place from Zomato.

Usage: npm run place -- "<place>[, <city>]" [options]

  --city <name>       City, if it isn't in the place text (bangalore, mumbai, delhi, ...)
  --limit <n>         Stop after n restaurants (default: all)
  --max-pages <n>     Max listing pages per listing type (default: all)
  --listings <list>   Comma-separated: delivery,dineout (default: both)
  --nearby            Also keep restaurants outside the place that only deliver to it
  --no-details        Skip each restaurant's own page: much faster, but no must_try,
                      open_until or extra images
  --max-images <n>    Images per restaurant (default: 5)
  --output <file>     Default: output/<place>-<city>.json

Examples:
  npm run place -- "Koramangala, Bangalore"
  npm run place -- "Bandra West" --city mumbai --limit 30
  npm run place -- "Connaught Place, Delhi" --no-details`;

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    city: { type: 'string' },
    limit: { type: 'string' },
    'max-pages': { type: 'string' },
    listings: { type: 'string', default: 'delivery,dineout' },
    nearby: { type: 'boolean', default: false },
    details: { type: 'boolean', default: true },
    'max-images': { type: 'string', default: '5' },
    output: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const CHECKPOINT_EVERY = 25;

async function askForPlace() {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question('Place to scrape (e.g. "Koramangala, Bangalore"): ')).trim();
  } finally {
    rl.close();
  }
}

const positiveInt = (value, flag) => {
  if (value == null) return Infinity;
  const n = Number.parseInt(value, 10);
  if (!(n > 0)) throw new Error(`${flag} must be a positive number, got "${value}".`);
  return n;
};

/** Whole-word slug match, so "hsr" matches "HSR, Bangalore" but "btm" doesn't match "abtm". */
const inLocality = (locality, slug) => `-${slugify(locality)}-`.includes(`-${slug}-`);

function uniqueImages(urls, max) {
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    if (!url) continue;
    const key = url.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out.slice(0, max);
}

function toOutput(r, place, maxImages) {
  const d = r.details ?? {};
  return {
    name: r.restaurant_name,
    area: stripCity(r.locality) || place,
    cuisines: d.cuisines?.length ? d.cuisines : r.cuisines,
    cost_for_two: r.cost_for_two ?? d.cost_for_two ?? null,
    must_try: d.must_try ?? null,
    open_until: d.open_until ?? null,
    current_offer: offerText(r),
    image_urls: uniqueImages([r.image_url, ...(d.image_urls ?? []), d.thumb_url], maxImages),
  };
}

async function save(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

function estimateMinutes(requests, opts, poolSize) {
  const { minDelayMs, maxDelayMs, perProxyGapMs, breakEvery, breakMinMs, breakMaxMs } = opts.pacer;
  const perRequest = Math.max((minDelayMs + maxDelayMs) / 2, perProxyGapMs / poolSize) + 700;
  const breaks = breakEvery > 0 ? Math.floor(requests / breakEvery) * ((breakMinMs + breakMaxMs) / 2) : 0;
  return Math.ceil((requests * perRequest + breaks) / 60_000);
}

async function main() {
  if (args.help) return console.log(USAGE);

  const input = positionals.join(' ').trim() || (await askForPlace());
  if (!input) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const limit = positiveInt(args.limit, '--limit');
  const maxImages = positiveInt(args['max-images'], '--max-images');
  const listings = args.listings.split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of listings) {
    if (!LISTINGS[name]) throw new Error(`Unknown listing "${name}" (expected: ${Object.keys(LISTINGS).join(', ')})`);
  }

  const pool = ProxyPool.fromEnv();
  const opts = { ...scrapeOptionsFromEnv(pool), maxPages: positiveInt(args['max-pages'], '--max-pages') };

  const { place, city, locality } = await resolvePlace(pool, opts, input, args.city);
  const output = args.output ?? `output/${locality}-${city}.json`;
  const keep = (r) => args.nearby || inLocality(r.locality, locality);

  const merged = new Map();
  for (const [i, name] of listings.entries()) {
    if (i > 0) await betweenListings(opts);
    const url = BASE + LISTINGS[name].path(city, locality);
    log.info(`Scraping ${url}`);
    const shouldStop = (collected) => [...collected.values()].filter(keep).length >= limit;
    for (const r of await scrapeListing(pool, url, LISTINGS[name].context, { ...opts, shouldStop })) {
      merged.set(r.res_id, mergeRestaurant(merged.get(r.res_id), r));
    }
  }

  const restaurants = [...merged.values()].filter(keep).slice(0, limit);
  log.info(`${merged.size} restaurant(s) found, ${restaurants.length} located in ${place}${args.nearby ? ' or nearby' : ''}.`);
  const result = () => restaurants.map((r) => toOutput(r, place, maxImages));

  if (args.details && restaurants.length > 0) {
    log.info(
      `Opening ${restaurants.length} restaurant page(s) for must_try / open_until / images ` +
        `(about ${estimateMinutes(restaurants.length, opts, pool.size)}-${estimateMinutes(restaurants.length * 2, opts, pool.size)} min ` +
        `at current delays; --no-details skips this).`,
    );
    for (const [i, r] of restaurants.entries()) {
      const url = restaurantPageUrl(r.zomato_url);
      try {
        if (url) r.details = await fetchRestaurantDetails(pool, url, opts);
      } catch (err) {
        if (err instanceof PoolExhaustedError) {
          log.error(`${err.message} Stopping early; restaurants without details keep their listing data.`);
          break;
        }
        log.warn(`  details for "${r.restaurant_name}" unavailable: ${err.message}`);
      }
      log.info(`[${i + 1}/${restaurants.length}] ${r.restaurant_name}`);
      if ((i + 1) % CHECKPOINT_EVERY === 0) await save(output, result());
    }
  }

  const data = result();
  await save(output, data);
  console.table(pool.stats());
  log.info(
    `Saved ${data.length} restaurant(s) to ${output} ` +
      `(${data.filter((r) => r.current_offer).length} with an offer, ${data.filter((r) => r.must_try).length} with must_try).`,
  );
}

main().catch((err) => {
  log.error(err.message);
  process.exitCode = 1;
});
