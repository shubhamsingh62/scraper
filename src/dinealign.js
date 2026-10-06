import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { areasOverlap, bestMatch } from './match.js';
import { keepsExistingOffer } from './offerRead.js';
import { ProxyPool } from './proxyPool.js';
import { buildPayload, loadExistingRestaurants, openSupabase, upsertRestaurant } from './restaurantUpsert.js';
import { scrapeOptionsFromEnv } from './scrapeOptions.js';
import { fetchDineoutListing, fetchDineoutRestaurant } from './swiggyDineout.js';
import { envInt, log } from './utils.js';
import { fetchZomatoDiningListing, fetchZomatoDiningPage } from './zomatoDining.js';
import { stripCity } from './zomato.js';

const USAGE = `DineAlign: Zomato dining offers + Swiggy Dineout bill discounts -> Supabase.

Usage: npm run dinealign -- [options]

  --areas <file>    Area list (default config/hyderabad.json)
  --limit <n>       Process at most n restaurants (default: all)
  --max-pages <n>   Zomato dine-out pages per area (default: MAX_PAGES or 3)
  --dry-run         Scrape and print payloads, do not write to Supabase

Each request waits a random 10-15s unless MIN_DELAY_MS / MAX_DELAY_MS are set.
A saved zomato_url or swiggy_url is opened directly. Search runs only when that URL is empty.
A bot check keeps the offer already stored. null is written only when the page loaded and showed no dining discount.`;

const { values: args } = parseArgs({
  options: {
    areas: { type: 'string', default: 'config/hyderabad.json' },
    limit: { type: 'string' },
    'max-pages': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function positiveInt(value, flag, fallback) {
  if (value == null) return fallback;
  const n = Number.parseInt(value, 10);
  if (!(n > 0)) throw new Error(`${flag} must be a positive number, got "${value}".`);
  return n;
}

/** 10-15s between requests for this job, unless the operator set the delay env vars. */
function applyVisitDelay(opts) {
  if (process.env.MIN_DELAY_MS == null && process.env.MAX_DELAY_MS == null) {
    opts.pacer.minDelayMs = 10_000;
    opts.pacer.maxDelayMs = 15_000;
    opts.pacer.perProxyGapMs = Math.max(opts.pacer.perProxyGapMs, 10_000);
  }
}

function prefer(current, incoming) {
  if (incoming == null || incoming === '' || (Array.isArray(incoming) && incoming.length === 0)) return current;
  return incoming;
}

/** Keep the first value. Zomato is attached before Swiggy, so its dining rating stays. */
function fill(current, incoming) {
  const empty = current == null || current === '' || (Array.isArray(current) && current.length === 0);
  return empty ? prefer(null, incoming) : current;
}

function blankVenue(name, area) {
  return {
    name,
    area,
    cuisines: [],
    cost_for_two: null,
    rating: null,
    review_count: null,
    bar_status: null,
    vibe_tags: [],
    must_try: null,
    open_until: null,
    image_urls: [],
    zomato_url: null,
    swiggy_url: null,
    zomatoOffer: null,
    swiggyOffer: null,
    existing: null,
    refreshZomato: false,
    refreshSwiggy: false,
  };
}

function attachListing(venue, patch) {
  venue.cuisines = [...new Set([...(venue.cuisines ?? []), ...(patch.cuisines ?? [])].map((item) => item.trim()).filter(Boolean))];
  venue.cost_for_two = prefer(venue.cost_for_two, patch.cost_for_two);
  venue.rating = fill(venue.rating, patch.rating);
  venue.review_count = fill(venue.review_count, patch.review_count);
  venue.bar_status = fill(venue.bar_status, patch.bar_status);
  venue.vibe_tags = [...new Set([...(venue.vibe_tags ?? []), ...(patch.vibe_tags ?? [])].map((item) => item.trim()).filter(Boolean))];
  venue.must_try = fill(venue.must_try, patch.must_try);
  venue.open_until = prefer(venue.open_until, patch.open_until);
  venue.image_urls = [...new Set([...(venue.image_urls ?? []), ...(patch.image_urls ?? [])].filter(Boolean))].slice(0, 8);
  if (patch.zomato_url && !venue.refreshZomato) venue.zomato_url = patch.zomato_url;
  if (patch.swiggy_url && !venue.refreshSwiggy) venue.swiggy_url = patch.swiggy_url;
  if (patch.zomatoOffer && !venue.refreshZomato) venue.zomatoOffer = patch.zomatoOffer;
  if (patch.swiggyOffer && !venue.refreshSwiggy) venue.swiggyOffer = patch.swiggyOffer;
}

/**
 * One row per outlet. A database row with a cached URL is refreshed from that URL.
 * A row without a URL is filled from the area listing, and the resolved URL is saved.
 */
function mergeVenues(zomatoRows, swiggyRows, existingRows, area) {
  /** @type {Map<string, ReturnType<typeof blankVenue>>} */
  const venues = new Map();

  const add = (name, venueArea) => {
    const key = `${name}\u0000${venueArea}`;
    if (!venues.has(key)) venues.set(key, blankVenue(name, venueArea));
    return venues.get(key);
  };

  for (const row of zomatoRows) {
    const venue = add(row.name, area);
    attachListing(venue, { ...row, zomatoOffer: row.offer, swiggyOffer: null });
  }

  const asCandidates = () =>
    [...venues.values()].map((venue) => ({ name: venue.name, area: venue.area, areaName: venue.area, ref: venue }));

  for (const row of swiggyRows) {
    const hit = bestMatch({ name: row.name, area: row.area || area }, asCandidates());
    const venue = hit ? hit.candidate.ref : add(row.name, area);
    attachListing(venue, { ...row, swiggyOffer: row.offer, zomatoOffer: null });
  }

  for (const row of existingRows) {
    if (!areasOverlap(row.area, area)) continue;
    const hit = bestMatch({ name: row.name, area: row.area }, asCandidates());
    const venue = hit ? hit.candidate.ref : add(row.name, row.area);
    venue.existing = row;
    venue.name = row.name;
    venue.area = row.area;
    if (row.zomato_url) {
      venue.refreshZomato = true;
      venue.zomato_url = row.zomato_url;
    }
    if (row.swiggy_url) {
      venue.refreshSwiggy = true;
      venue.swiggy_url = row.swiggy_url;
    }
  }

  return [...venues.values()];
}

function warnIfBlocked(name, label, offer, existing) {
  if (!existing || !offer || !keepsExistingOffer(offer)) return;
  log.warn(`[BOT DETECTED] Retaining last known offer for ${name} (${label})`);
}

function applyZomatoPage(venue, page) {
  venue.cuisines = prefer(venue.cuisines, page.cuisines);
  venue.cost_for_two = prefer(venue.cost_for_two, page.cost_for_two);
  venue.rating = prefer(venue.rating, page.rating);
  venue.review_count = prefer(venue.review_count, page.review_count);
  venue.bar_status = prefer(venue.bar_status, page.bar_status);
  venue.vibe_tags = prefer(venue.vibe_tags, page.vibe_tags);
  venue.must_try = prefer(venue.must_try, page.must_try);
  venue.open_until = prefer(venue.open_until, page.open_until);
  venue.image_urls = prefer(venue.image_urls, page.image_urls);
}

async function refreshCachedPages(venue, pool, opts) {
  if (venue.zomato_url && !venue.refreshZomato) {
    log.info(`Opening Zomato page for "${venue.name}" to fill rating, bar, vibe, and must_try.`);
    applyZomatoPage(venue, await fetchZomatoDiningPage(pool, opts, venue.zomato_url));
  }

  if (venue.refreshZomato) {
    const fromListing = venue.zomatoOffer;
    log.info(`Opening cached Zomato URL for "${venue.name}" (skipping search).`);
    const page = await fetchZomatoDiningPage(pool, opts, venue.zomato_url);
    applyZomatoPage(venue, page);
    if (keepsExistingOffer(page.offer) && fromListing && !keepsExistingOffer(fromListing)) {
      venue.zomatoOffer = fromListing;
    } else {
      venue.zomatoOffer = page.offer;
      warnIfBlocked(venue.name, 'Zomato', page.offer, venue.existing);
    }
  }

  if (venue.refreshSwiggy) {
    const fromListing = venue.swiggyOffer;
    log.info(`Opening cached Swiggy Dineout URL for "${venue.name}" (skipping search).`);
    const page = await fetchDineoutRestaurant(pool, opts, venue.swiggy_url);
    if (keepsExistingOffer(page.offer) && fromListing && !keepsExistingOffer(fromListing)) {
      venue.swiggyOffer = fromListing;
    } else {
      venue.swiggyOffer = page.offer;
      warnIfBlocked(venue.name, 'Swiggy Dineout', page.offer, venue.existing);
    }
  }
}

async function main() {
  if (args.help) return console.log(USAGE);

  const targets = JSON.parse(await readFile(args.areas, 'utf8'));
  const limit = positiveInt(args.limit, '--limit', Infinity);
  const dryRun = args['dry-run'];
  const supabase = dryRun ? null : openSupabase();
  const existing = supabase ? await loadExistingRestaurants(supabase) : [];
  if (!dryRun) log.info(`Loaded ${existing.length} existing restaurant row(s).`);

  const pool = ProxyPool.fromEnv();
  const opts = scrapeOptionsFromEnv(pool);
  applyVisitDelay(opts);
  opts.maxPages = positiveInt(args['max-pages'], '--max-pages', envInt('MAX_PAGES', 3));
  log.info(`Waiting ${opts.pacer.minDelayMs}-${opts.pacer.maxDelayMs}ms before each request.`);

  const checkedAt = new Date().toISOString();
  /** @type {ReturnType<typeof buildPayload>[]} */
  const payloads = [];
  let processed = 0;

  for (const target of targets) {
    if (processed >= limit) break;
    const area = target.area;
    log.info(`Area ${area}: Zomato dine-out + Swiggy Dineout.`);

    let zomatoRows = [];
    let swiggyRows = [];
    try {
      zomatoRows = (await fetchZomatoDiningListing(pool, opts, target.city, target.locality))
        .filter((row) => areasOverlap(stripCity(row.area), area))
        .map((row) => ({ ...row, area }));
      log.info(`  Zomato dine-out: ${zomatoRows.length} in ${area}.`);
    } catch (err) {
      log.error(`  Zomato listing for ${area} failed: ${err.message}`);
    }

    try {
      const listing = await fetchDineoutListing(pool, opts, target.swiggyCity || target.city, target.swiggySlug || target.locality);
      if (listing.blocked) log.warn(`  [BOT DETECTED] Swiggy Dineout listing for ${area} was blocked. Cached offers stay as they are.`);
      swiggyRows = listing.restaurants.filter((row) => areasOverlap(row.area, area));
      log.info(`  Swiggy Dineout: ${swiggyRows.length} in ${area}.`);
    } catch (err) {
      log.error(`  Swiggy Dineout listing for ${area} failed: ${err.message}`);
    }

    const venues = mergeVenues(zomatoRows, swiggyRows, existing, area);
    const matchedBoth = venues.filter((venue) => venue.zomato_url && venue.swiggy_url);
    log.info(
      `  ${matchedBoth.length} outlet(s) matched on both platforms` +
        `${matchedBoth.length ? `: ${matchedBoth.slice(0, 5).map((venue) => venue.name).join(', ')}` : ''}.`,
    );
    const ordered = [...matchedBoth, ...venues.filter((venue) => !venue.zomato_url || !venue.swiggy_url)].slice(0, limit - processed);
    for (const venue of ordered) {
      processed++;
      try {
        await refreshCachedPages(venue, pool, opts);
        const payload = buildPayload({
          name: venue.name,
          area: venue.area,
          rating: venue.rating,
          reviewCount: venue.review_count,
          cuisines: venue.cuisines,
          costForTwo: venue.cost_for_two,
          barStatus: venue.bar_status,
          vibeTags: venue.vibe_tags,
          mustTry: venue.must_try,
          openUntil: venue.open_until,
          imageUrls: venue.image_urls,
          zomatoOffer: venue.zomatoOffer,
          swiggyOffer: venue.swiggyOffer,
          zomatoUrl: venue.zomato_url,
          swiggyUrl: venue.swiggy_url,
          checkedAt,
        });
        payloads.push(payload);
        if (supabase) await upsertRestaurant(supabase, payload);
      } catch (err) {
        log.error(`"${venue.name}" (${venue.area}) failed and the rest of the batch will continue: ${err.message}`);
      }
    }
  }

  await mkdir('output', { recursive: true });
  const file = 'output/dinealign.json';
  await writeFile(file, JSON.stringify(payloads, null, 2));
  console.table(pool.stats());
  log.info(
    `${dryRun ? 'Dry run' : 'Sync'} finished: ${payloads.length} payload(s) in ${file}. ` +
      `${payloads.filter((row) => row.current_offer).length} Zomato dining offers, ` +
      `${payloads.filter((row) => row.swiggy_offer).length} Swiggy Dineout offers.`,
  );
}

main().catch((err) => {
  log.error(err.stack ?? err.message);
  process.exitCode = 1;
});
