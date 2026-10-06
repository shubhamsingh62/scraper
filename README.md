# Zomato offers → Supabase sync

Scrapes restaurant names, images and live offers from Zomato listing pages through a rotating proxy pool, then upserts them into the Supabase `restaurants` table, matched on `name` + `area`. It runs daily on GitHub Actions.

```
src/
  index.js         CLI entry: scrape (or load JSON) → sync
  place.js         CLI: "place name" → every restaurant there as JSON (no DB)
  locations.js     place text → Zomato city/locality slugs
  zomato.js        listing crawler (page 1 HTML + infinite-scroll API pages) + restaurant page parser
  proxyPool.js     round-robin proxy pool with cooldown / ban on blocks
  session.js       one proxy + user agent + cookie jar per crawl session
  supabaseSync.js  JSON records → upsert / update on `restaurants`
config/targets.json        which city/localities to scrape
data/sample-restaurants.json  Apify-shaped sample input
supabase/migration.sql     columns + unique index needed for upsert
.github/workflows/daily-sync.yml
```

## 1. Database setup

Run `supabase/migration.sql` in **Supabase Dashboard → SQL Editor**. It adds `image_url`, `offer_text` and `offer_updated_at`, and creates a unique index on `(name, area)`. `upsert` needs that index to detect conflicts.

If your columns are named differently, edit the `COLUMNS` map at the top of `src/supabaseSync.js`.

If `restaurants` has other `NOT NULL` columns without defaults, inserting new restaurants will fail. In that case use `SYNC_MODE=update`, which only updates rows that already exist and never inserts.

## 2. Which Supabase key to use

Go to **Project Settings → API** and copy:

| Secret | Value |
| --- | --- |
| `SUPABASE_URL` | Project URL, e.g. `https://abcd1234.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | The **`service_role`** key (called the **secret** key, `sb_secret_…`, in the newer API keys UI) |

Use the service role key, not the `anon`/publishable key. It authenticates as the `service_role` Postgres role, which has `BYPASSRLS`, so the script can write to `restaurants` without any RLS policies. That also means anyone holding the key has full access to your database: keep it only in GitHub secrets or a local `.env`, never in frontend or mobile code, and never commit it.

## 3. Proxies and IP rotation

Set `PROXY_LIST` to your proxies, comma- or newline-separated. Any of these formats works:

```
http://user:pass@1.2.3.4:8000
1.2.3.4:8000
1.2.3.4:8000:user:pass
```

How the pool behaves:

- Each listing crawl gets a **session**: one proxy, one random real-browser user agent and its own cookie jar. Zomato's CSRF token and pagination cursor are tied to cookies, so a crawl doesn't switch IPs partway through.
- If a session gets HTTP 403/429/503, an HTML bot wall instead of data, or a connection error, its proxy goes into an **exponential cooldown**: 60s, 120s, 240s… for blocks, and a quarter of that for network errors. The crawl then retries on the **next proxy**, and results already collected are kept.
- After 4 consecutive failures, a proxy is **dropped for the rest of the run**. A success resets its counter.
- If every proxy is cooling down, the pool waits for the first one to recover, up to 10 minutes, and then stops with an error.
- Requests run one at a time and go through a pacer (`src/pacer.js`) before every fetch. Pacing matters as much as rotation for avoiding blocks.

### Delay options

All values are in milliseconds and can be set in `.env` or as GitHub Actions **Variables**.

| Variable | Default | What it does |
| --- | --- | --- |
| `FETCH_DELAY_SEC` | 0 | Wait at least this many **seconds** before every fetch (plus up to 3s of jitter). `0` leaves the ranges below in charge. Set `8` or `10` if IPs start getting blocked. |
| `MIN_DELAY_MS` / `MAX_DELAY_MS` | 2500 / 6000 | Random wait before **every** request |
| `PROXY_MIN_GAP_MS` | 8000 | The same IP is never reused sooner than this. With one proxy this is effectively the minimum delay; with many proxies, rotation hides it. |
| `BREAK_EVERY` | 25 | Take a long break after every N requests (`0` disables) |
| `BREAK_MIN_MS` / `BREAK_MAX_MS` | 30000 / 90000 | Length of that break |
| `LISTING_DELAY_MIN_MS` / `LISTING_DELAY_MAX_MS` | 10000 / 25000 | Pause between listings (one locality's delivery list, then its dine-out list, then the next locality) |
| `BLOCK_PAUSE_MS` | 20000 | Extra wait after a block before retrying on the next proxy |
| `START_JITTER_MAX_MS` | 0 locally, 300000 in Actions | Random delay before the run starts, so the job doesn't hit Zomato at the same second every day |

If you still see `cooling down` / `failed` in the logs, raise `MIN_DELAY_MS`, `MAX_DELAY_MS` and `PROXY_MIN_GAP_MS` first, then lower `MAX_PAGES`. At the defaults, a target with delivery and dine-out listings at 5 pages each takes about 2–3 minutes.

GitHub-hosted runners use Azure datacenter IPs, which bot protection blocks far more often than residential IPs. If you leave `PROXY_LIST` empty, everything goes through the runner's IP with no rotation. For reliable daily runs, use **rotating residential or ISP proxies** from a provider. Many providers give you a single "rotating" endpoint that changes IP per connection; that works as a one-entry `PROXY_LIST`. Set `ALLOW_DIRECT=true` if you also want the machine's own IP in the pool.

Only HTTP(S) proxies are supported. SOCKS proxies are not.

## 4. What to scrape

Edit `config/targets.json`:

```json
{ "city": "bangalore", "locality": "koramangala", "area": "Koramangala", "listings": ["delivery", "dineout"] }
```

- `city` and `locality` are the slugs from Zomato URLs (`zomato.com/bangalore/delivery-in-koramangala`).
- `area` is the exact value written to your table's `area` column, so it must match your existing rows for updates to land. Delivery listings include restaurants that deliver to the area but are located elsewhere, so by default only restaurants whose Zomato locality contains `area` are kept. Set `"strictArea": false` to keep everything. If you leave out `area`, Zomato's locality is used, e.g. `Koramangala 5th Block`.
- `delivery` listings provide delivery offers (`50% OFF`, `₹100 OFF`). `dineout` listings provide Zomato Gold dining offers. Each restaurant gets its delivery offer if it has one, otherwise its Gold offer. Restaurants with no offer get `offer_text = null`, which clears offers that have expired.
- `MAX_PAGES` (default 5) controls depth. Page 1 has about 9 restaurants and each later page about 12.

## 5. Running locally

```bash
npm install
cp .env.example .env        # fill in values
npm run scrape              # scrape only, writes output/restaurants.json, no DB writes
npm run sync                # scrape + write to Supabase
npm run sync:sample         # sync data/sample-restaurants.json (Apify-shaped input), no scraping
node src/index.js --input path/to/apify.json   # sync any JSON array of {restaurant_name, area, image_url, zomato_offer_text}
```

## 6. Fetch every restaurant in a place

`src/place.js` takes a place name and writes every restaurant there to a JSON file:

```bash
npm run place -- "Koramangala, Bangalore"
npm run place -- "HSR Layout"                    # city looked up via Zomato's location search
npm run place -- "Bandra West" --city mumbai --limit 30
npm run place -- "Connaught Place, Delhi" --no-details
npm run place                                    # asks for the place interactively
```

Output (`output/<place>-<city>.json`):

```json
[
  {
    "name": "Alienkind",
    "area": "HSR",
    "cuisines": ["Burger"],
    "cost_for_two": "₹300",
    "must_try": "Harissa Chicken Sando",
    "open_until": "12:00 AM",
    "current_offer": "50% OFF",
    "swiggy_offer": "Free delivery",
    "image_urls": ["https://b.zmtcdn.com/data/pictures/..._o2_featured_v2.jpg", "..."]
  }
]
```

Where each field comes from:

| Field | Source |
| --- | --- |
| `name`, `cuisines`, `cost_for_two` | Listing cards |
| `area` | The restaurant's Zomato locality without the city, e.g. `Koramangala 5th Block` |
| `current_offer` | The Zomato delivery offer, or the Zomato Gold dining offer if there's no delivery offer |
| `swiggy_offer` | The offer on the matching Swiggy outlet. `null` when Swiggy has no offer, or when no outlet matched |
| `must_try` | The first of the restaurant's "Popular Dishes". If it has none, the most-voted dish rated 4+ on its delivery menu. Otherwise its "Known for" text. |
| `open_until` | Today's closing time from the restaurant page (`Open 24 hours` / `Closed today` when applicable) |
| `image_urls` | The featured image plus photos from the restaurant page carousel (`--max-images`, default 5) |

How it works:

- **Finding the place:** the place is turned into Zomato's URL slug by trying progressively shorter names until a listing exists. For example, `HSR Layout` tries `hsr-layout`, then `hsr`. City aliases are built in (Bengaluru is `bangalore`; Delhi, Gurugram and Noida are `ncr`, etc.). If a place isn't found, copy the slug from its Zomato URL.
- **Collecting restaurants:** both the delivery and dine-out listings are crawled to the end, or until `--limit`. By default only restaurants located in the place are kept. `--nearby` also keeps ones that only deliver there.
- **Detail pages:** "Fetch all" means one or two extra page loads per restaurant for `must_try`, `open_until` and images, so a big area takes a long time. Koramangala lists 2,000+ restaurants, which is hours at the default delays from a single IP. The script prints an estimate before it starts and saves progress every 25 restaurants. Use `--limit` to test, `--no-details` for a fast listing-only run, and more proxies to go faster.
- **Rotation and delays:** it uses the same proxy pool and delay settings as the daily sync (`PROXY_LIST`, `MIN_DELAY_MS`, …). `MAX_PAGES` is ignored here; use `--max-pages` instead. `--delay 10` waits at least 10 seconds before every fetch, including the first one, which is the easiest way to keep a single IP from getting blocked.
- **Swiggy on the same object:** Zomato and Swiggy don't share restaurant IDs, and the same chain has many outlets. A Swiggy row is attached only when the names match (equal, or one contains the other) **and** the areas overlap, so "HSR" matches "HSR Layout" but "KFC" in HSR is not "KFC" in Koramangala. `--no-swiggy` skips this. Swiggy's menu endpoint (where the offer text lives) often answers with a bot check from a datacenter or bare IP; search still matches the outlet, and `swiggy_offer` stays `null` until a proxy gets past that check.

## 7. GitHub Actions

1. Push this repo to GitHub, including `package-lock.json`, which `npm ci` needs.
2. Go to **Settings → Secrets and variables → Actions → Secrets** and add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `PROXY_LIST`.
3. Optionally, add these under **Variables**: `SYNC_MODE` (`upsert`/`update`), `MAX_PAGES`, `ALLOW_DIRECT`, and any of the delay options above.
4. `.github/workflows/daily-sync.yml` runs on `cron: '30 4 * * *'`. GitHub cron is always in UTC, so this is 10:00 AM IST. Use `'0 10 * * *'` for 10:00 AM UTC. Scheduled runs can start several minutes late when GitHub is busy.
5. To test, go to **Actions → Daily Zomato offers sync → Run workflow**. The scraped JSON is attached to each run as the `scraped-restaurants` artifact.

The job fails (exit code 1) if nothing was scraped or if any Supabase write errored, so GitHub will email you when a run breaks.

## Caveats

- Zomato listing cards show only the headline offer (`50% OFF`). The "up to ₹100" cap appears only on each restaurant's own page, which this crawler does not visit.
- The crawler reads Zomato's embedded `__PRELOADED_STATE__` and its internal `/webroutes/search/home` endpoint. Neither is a public API, and either can change without notice. When that happens the script logs `Unexpected page structure` and exits non-zero.
- Zomato's terms of service restrict automated scraping. Keep the crawl small and slow, and check with them, or use an official partner feed, before relying on this commercially.
