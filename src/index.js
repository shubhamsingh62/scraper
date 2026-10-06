import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pause } from './pacer.js';
import { ProxyPool } from './proxyPool.js';
import { scrapeOptionsFromEnv } from './scrapeOptions.js';
import { createSupabase, syncRestaurants } from './supabaseSync.js';
import { envInt, log, randomBetween } from './utils.js';
import { scrapeTargets } from './zomato.js';

const { values: args } = parseArgs({
  options: {
    input: { type: 'string' },
    targets: { type: 'string', default: 'config/targets.json' },
    output: { type: 'string', default: 'output/restaurants.json' },
    'dry-run': { type: 'boolean', default: false },
  },
});

async function loadRecords() {
  if (args.input) {
    const records = JSON.parse(await readFile(args.input, 'utf8'));
    if (!Array.isArray(records)) throw new Error(`${args.input} must contain a JSON array.`);
    log.info(`Loaded ${records.length} record(s) from ${args.input}`);
    return records;
  }

  const targets = JSON.parse(await readFile(args.targets, 'utf8'));
  const pool = ProxyPool.fromEnv();

  await pause(randomBetween(0, envInt('START_JITTER_MAX_MS', 0)), 'random start delay');

  const records = await scrapeTargets(targets, pool, scrapeOptionsFromEnv(pool));
  console.table(pool.stats());

  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, JSON.stringify(records, null, 2));
  log.info(`Wrote ${records.length} scraped record(s) to ${args.output}`);
  return records;
}

async function main() {
  const dryRun = args['dry-run'];
  if (!dryRun) createSupabase(); // fail fast on missing credentials before spending time scraping

  const records = await loadRecords();
  if (records.length === 0) {
    log.error('No restaurant records found; nothing to sync.');
    process.exitCode = 1;
    return;
  }

  const stats = await syncRestaurants(records, {
    mode: process.env.SYNC_MODE === 'update' ? 'update' : 'upsert',
    table: process.env.SUPABASE_TABLE || 'restaurants',
    dryRun,
  });
  if (stats.errors > 0) process.exitCode = 1;
}

main().catch((err) => {
  log.error(err.stack ?? err.message);
  process.exitCode = 1;
});
