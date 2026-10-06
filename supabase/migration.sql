-- Run once in Supabase Dashboard -> SQL Editor. Safe to re-run.

-- Columns written by the sync script.
alter table public.restaurants
  add column if not exists image_url text,
  add column if not exists offer_text text,
  add column if not exists offer_updated_at timestamptz;

-- Required for SYNC_MODE=upsert (on_conflict = name,area). Not needed for SYNC_MODE=update.
-- If this fails you already have duplicate (name, area) rows; list them with:
--   select name, area, count(*) from public.restaurants group by 1, 2 having count(*) > 1;
create unique index if not exists restaurants_name_area_key
  on public.restaurants (name, area);
