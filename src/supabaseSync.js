import { createClient } from '@supabase/supabase-js';
import { chunk, clean, log } from './utils.js';

// Column names in your Supabase table. Change the right-hand side if your schema differs.
const COLUMNS = {
  name: 'name',
  area: 'area',
  imageUrl: 'image_url',
  offerText: 'offer_text',
  offerUpdatedAt: 'offer_updated_at',
};

const UPDATE_CONCURRENCY = 8;

export function createSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Maps one Apify/scraper record ({restaurant_name, area, image_url, zomato_offer_text}) to a table row. */
export function toRow(record, now) {
  const name = clean(record.restaurant_name);
  const area = clean(record.area);
  if (!name || !area) return null;

  const row = {
    [COLUMNS.name]: name,
    [COLUMNS.area]: area,
    [COLUMNS.offerText]: clean(record.zomato_offer_text) || null,
    [COLUMNS.offerUpdatedAt]: now,
  };
  // Leave the stored image alone when the scrape didn't find one.
  const image = clean(record.image_url);
  if (image) row[COLUMNS.imageUrl] = image;
  return row;
}

function prepareRows(records) {
  const now = new Date().toISOString();
  const byKey = new Map();
  let skipped = 0;
  for (const record of records) {
    const row = toRow(record, now);
    if (!row) {
      skipped++;
      continue;
    }
    // Postgres rejects an upsert batch that touches the same (name, area) twice.
    const key = `${row[COLUMNS.name]}\u0000${row[COLUMNS.area]}`;
    const prev = byKey.get(key);
    byKey.set(key, prev ? { ...row, ...prev, [COLUMNS.offerText]: prev[COLUMNS.offerText] ?? row[COLUMNS.offerText] } : row);
  }
  if (skipped) log.warn(`Skipped ${skipped} record(s) without restaurant_name/area.`);
  return [...byKey.values()];
}

/** Rows with and without image_url must go in separate requests, or PostgREST would null out missing columns. */
function groupByColumns(rows) {
  const groups = new Map();
  for (const row of rows) {
    const sig = Object.keys(row).sort().join(',');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(row);
  }
  return [...groups.values()];
}

async function upsertRows(supabase, table, rows, batchSize) {
  const stats = { written: 0, errors: 0 };
  for (const group of groupByColumns(rows)) {
    for (const batch of chunk(group, batchSize)) {
      const { error } = await supabase
        .from(table)
        .upsert(batch, { onConflict: `${COLUMNS.name},${COLUMNS.area}`, ignoreDuplicates: false });
      if (error) {
        stats.errors += batch.length;
        log.error(`Upsert of ${batch.length} row(s) failed: ${error.message}${error.hint ? ` (hint: ${error.hint})` : ''}`);
      } else {
        stats.written += batch.length;
      }
    }
  }
  return stats;
}

async function updateRows(supabase, table, rows) {
  const stats = { written: 0, unmatched: 0, errors: 0 };
  const unmatched = [];
  let next = 0;

  async function worker() {
    while (next < rows.length) {
      const row = rows[next++];
      const { [COLUMNS.name]: name, [COLUMNS.area]: area, ...fields } = row;
      const { error, count } = await supabase
        .from(table)
        .update(fields, { count: 'exact' })
        .eq(COLUMNS.name, name)
        .eq(COLUMNS.area, area);
      if (error) {
        stats.errors++;
        log.error(`Update failed for "${name}" / "${area}": ${error.message}`);
      } else if (!count) {
        stats.unmatched++;
        unmatched.push(`${name} (${area})`);
      } else {
        stats.written += count;
      }
    }
  }

  await Promise.all(Array.from({ length: UPDATE_CONCURRENCY }, worker));
  if (unmatched.length) log.info(`No existing row for: ${unmatched.slice(0, 20).join('; ')}${unmatched.length > 20 ? ' …' : ''}`);
  return stats;
}

/**
 * @param {Array<object>} records Apify-style records.
 * @param {{ mode?: 'upsert' | 'update', dryRun?: boolean, batchSize?: number, table?: string }} options
 *   upsert: insert new restaurants, update existing ones (needs a UNIQUE index on (name, area)).
 *   update: only touch rows that already exist; never inserts.
 */
export async function syncRestaurants(records, { mode = 'upsert', dryRun = false, batchSize = 500, table = 'restaurants' } = {}) {
  const rows = prepareRows(records);
  log.info(`Prepared ${rows.length} unique row(s) for "${table}" (mode: ${mode}).`);

  if (dryRun) {
    log.info('Dry run: nothing written. First rows:', JSON.stringify(rows.slice(0, 3), null, 2));
    return { written: 0, errors: 0 };
  }

  const supabase = createSupabase();
  const stats = mode === 'update' ? await updateRows(supabase, table, rows) : await upsertRows(supabase, table, rows, batchSize);
  log.info(`Supabase sync finished: ${JSON.stringify(stats)}`);
  return stats;
}
